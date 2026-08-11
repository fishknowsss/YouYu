import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createWindowsPowerShellFixtureEnvironment } from '../helpers/windowsPowerShellEnvironment';
import {
  createUpdateInstallerBootstrapScript,
  createElevatedUpdateInstallerScript,
  createUpdateInstallerLauncherScript,
  createUpdateInstallerSupervisorTransport,
  launchDownloadedUpdateInstaller,
  resolveDownloadedUpdateInstallerPath,
  resolveWindowsPowerShellPath,
  sanitizeUpdateInstallerLauncherDiagnostic,
  signalUpdateInstallerCancellation,
  updateElevatedInstallerPayloadEnvironment,
  updateInstallerAcknowledgementTimeoutMs,
  updateInstallerBootstrapCleanupGraceMs,
  updateInstallerBootstrapPayloadEnvironment,
  updateInstallerBootstrapScriptEnvironment,
  updateInstallerExecutionTimeoutMs,
  updateInstallerLauncherPayloadEnvironment,
  updateInstallerSupervisorReadyMessage,
  updateInstallerSupervisorReadyTimeoutMs,
  updateInstallerSupervisorScriptEnvironment,
  updateInstallerSupervisorLoaderEnvironment,
  updateInstallerNodeCleanupMarginMs,
  updateInstallerPowerShellModuleAnalysisCacheEnvironment,
  updateInstallerPowerShellModulePathEnvironment
} from '../../src/main/updateInstallerLauncher';
import {
  resolveUpdateInstallerCancellationPath,
  updateInstallerHandoffLifetimeMs
} from '../../src/main/updateInstallHandoff';

const handoff = {
  path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-handoff-8fb748f0-540a-4f7a-9bd2-144020b83e9b.json`,
  nonce: '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
  targetUserSid: 'S-1-5-21-100-200-300-1001',
  targetSessionId: 7,
  targetProcessId: 4242,
  targetExecutablePath: String.raw`C:\Program Files\YouYu\YouYu.exe`,
  abandon: async () => undefined
};

function createLauncher(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { stdin: new PassThrough(), kill: vi.fn() });
  return child;
}

async function runWindowsPowerShellScript(script: string, environment: NodeJS.ProcessEnv) {
  const transport = createUpdateInstallerSupervisorTransport(script);
  const childEnvironment = createWindowsPowerShellFixtureEnvironment(environment);
  childEnvironment[updateInstallerSupervisorScriptEnvironment] = transport.environmentValue;
  const child = spawn(
    resolveWindowsPowerShellPath(environment.SystemRoot),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', transport.encodedLoaderCommand],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.kill()) reject(new Error('PowerShell compatibility probe timed out and could not be terminated'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error('PowerShell compatibility probe timed out'));
      else resolve(code);
    });
  });
  return { stdout, stderr, exitCode };
}

type WindowsPowerShellFixtureIdentity = {
  sid: string;
  sessionId: number;
  productVersion: string;
};

async function resolveWindowsPowerShellFixtureIdentity(): Promise<WindowsPowerShellFixtureIdentity> {
  const script = [
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId',
    "$productVersion = ([string] (Get-Item -LiteralPath ([IO.Path]::Combine($PSHOME, 'powershell.exe')) -Force).VersionInfo.ProductVersion).Trim()",
    '$version = [Version] $productVersion',
    "[pscustomobject]@{ sid = $identity.User.Value; sessionId = $sessionId; productVersion = ('{0}.{1}.{2}' -f $version.Major, $version.Minor, $version.Build) } | ConvertTo-Json -Compress"
  ].join('\n');
  const result = await runWindowsPowerShellScript(script, process.env);
  if (result.exitCode !== 0) throw new Error(`could not resolve Windows fixture identity: ${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as WindowsPowerShellFixtureIdentity;
}

type SupervisorScenario = {
  wrapperExitCode: number;
  consumeHandoff: boolean;
  resumeProxyAfterRelaunch: boolean;
};

async function runFullWindowsSupervisorScenario(scenario: SupervisorScenario) {
  const identity = await resolveWindowsPowerShellFixtureIdentity();
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'youyu-update-supervisor-'));
  const targetDirectory = join(fixtureRoot, 'installed');
  const targetExecutablePath = join(targetDirectory, 'YouYu.exe');
  const resourcesDirectory = join(targetDirectory, 'resources');
  const handoffPath = join(fixtureRoot, `youyu-update-handoff-${handoff.nonce}.json`);
  const acknowledgementPath = join(fixtureRoot, `youyu-update-handoff-${handoff.nonce}.ready.json`);
  const supervisorReadyPath = join(fixtureRoot, `youyu-update-supervisor-${handoff.nonce}.ready.json`);
  const cancellationPath = join(fixtureRoot, `youyu-update-cancel-${handoff.nonce}.json`);
  const capturePath = join(fixtureRoot, 'relaunch-arguments.txt');
  const installerPath = join(fixtureRoot, 'YouYu-1.7.7-x64.exe');
  await mkdir(resourcesDirectory, { recursive: true });
  await copyFile(resolveWindowsPowerShellPath(process.env.SystemRoot), targetExecutablePath);
  await writeFile(join(resourcesDirectory, 'update-elevated-installer.ps1'), '# fixture wrapper\n', 'utf8');
  await writeFile(handoffPath, '{}', 'utf8');

  const now = Date.now();
  const acknowledgement = {
    version: '1',
    nonce: handoff.nonce,
    handoffPath,
    targetUserSid: identity.sid,
    targetSessionId: String(identity.sessionId),
    targetProcessId: 4242,
    executablePath: targetExecutablePath,
    acknowledgedAtEpochMs: now,
    expiresAtEpochMs: now + 60_000
  };
  const payload = {
    installerPath,
    expectedVersion: identity.productVersion,
    arguments: [
      '--updated',
      '/S',
      '--force-run',
      '--youyu-handoff-path',
      handoffPath,
      '--youyu-handoff-nonce',
      handoff.nonce,
      '--youyu-target-user-sid',
      identity.sid,
      '--youyu-target-session-id',
      String(identity.sessionId)
    ],
    acknowledgement: {
      path: acknowledgementPath,
      handoffPath,
      nonce: handoff.nonce,
      targetUserSid: identity.sid,
      targetSessionId: String(identity.sessionId),
      targetProcessId: 4242,
      targetExecutablePath
    },
    supervisorReady: {
      path: supervisorReadyPath,
      nonce: handoff.nonce,
      targetUserSid: identity.sid
    },
    cancellation: {
      path: cancellationPath,
      nonce: handoff.nonce,
      targetUserSid: identity.sid
    },
    acknowledgementTimeoutMs: 5_000,
    installerTimeoutMs: 30_000,
    resumeProxyAfterRelaunch: scenario.resumeProxyAfterRelaunch
  };

  const fixturePrefix = [
    '$fixtureAcknowledgementPath = [string] $env:YOUYU_TEST_ACK_PATH',
    '$fixtureHandoffPath = [string] $env:YOUYU_TEST_HANDOFF_PATH',
    '$fixtureTargetPath = [string] $env:YOUYU_TEST_TARGET_PATH',
    '$fixtureCapturePath = [string] $env:YOUYU_TEST_CAPTURE_PATH',
    '$fixtureSid = [string] $env:YOUYU_TEST_SID',
    '$fixtureSessionId = [string] $env:YOUYU_TEST_SESSION_ID',
    '$fixtureVersion = [string] $env:YOUYU_TEST_VERSION',
    '$fixtureNonce = [string] $env:YOUYU_TEST_NONCE',
    '$fixtureWrapperExitCode = [Convert]::ToInt32($env:YOUYU_TEST_WRAPPER_EXIT_CODE, [Globalization.CultureInfo]::InvariantCulture)',
    "$fixtureConsumeHandoff = $env:YOUYU_TEST_CONSUME_HANDOFF -ceq '1'",
    'function Set-FixturePrivateAcl([string] $path, [string] $sidText) {',
    '  $sid = New-Object Security.Principal.SecurityIdentifier($sidText)',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetAccessRule($rule)',
    '  [IO.File]::SetAccessControl($path, $acl)',
    '}',
    '$initialAck = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YOUYU_TEST_ACK_PAYLOAD))',
    '[IO.File]::WriteAllText($fixtureAcknowledgementPath, $initialAck, (New-Object Text.UTF8Encoding($false)))',
    'Set-FixturePrivateAcl $fixtureAcknowledgementPath $fixtureSid',
    'function Start-FixtureProcess([string] $executablePath, [string] $scriptText) {',
    '  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))',
    '  $startInfo = New-Object Diagnostics.ProcessStartInfo',
    '  $startInfo.FileName = $executablePath',
    "  $startInfo.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encodedCommand",
    '  $startInfo.UseShellExecute = $false',
    '  $startInfo.CreateNoWindow = $true',
    '  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden',
    '  return [Diagnostics.Process]::Start($startInfo)',
    '}',
    'function Start-Process {',
    '  [CmdletBinding()]',
    '  param([string] $FilePath, [string] $ArgumentList, [string] $Verb, [string] $WindowStyle, [switch] $PassThru)',
    "  if ($Verb -ceq 'RunAs') {",
    "    $wrapperScript = 'Start-Sleep -Milliseconds 1200; if ([Environment]::GetEnvironmentVariable(''YOUYU_TEST_CONSUME_HANDOFF'') -ceq ''1'') { [IO.File]::Delete([Environment]::GetEnvironmentVariable(''YOUYU_TEST_HANDOFF_PATH'')) }; [IO.File]::Delete([Environment]::GetEnvironmentVariable(''YOUYU_TEST_CANCEL_PATH'')); exit ' + $fixtureWrapperExitCode",
    "    return Start-FixtureProcess ([IO.Path]::Combine($PSHOME, 'powershell.exe')) $wrapperScript",
    '  }',
    '  [IO.File]::WriteAllText($fixtureCapturePath, $ArgumentList, (New-Object Text.UTF8Encoding($false)))',
    "  $targetProcess = Start-FixtureProcess $fixtureTargetPath 'Start-Sleep -Seconds 2'",
    "  $ready = [pscustomobject]@{ version = '1'; nonce = $fixtureNonce; appVersion = $fixtureVersion; executablePath = $fixtureTargetPath; processId = [int] $targetProcess.Id; targetUserSid = $fixtureSid; targetSessionId = $fixtureSessionId; readyAtEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }",
    "  [IO.File]::WriteAllText($fixtureAcknowledgementPath.Replace('youyu-update-handoff-', 'youyu-update-relaunch-'), ($ready | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))",
    '  return $targetProcess',
    '}'
  ].join('\n');

  try {
    const result = await runWindowsPowerShellScript(`${fixturePrefix}\n${createUpdateInstallerLauncherScript()}`, {
      ...process.env,
      [updateInstallerLauncherPayloadEnvironment]: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      YOUYU_TEST_ACK_PATH: acknowledgementPath,
      YOUYU_TEST_HANDOFF_PATH: handoffPath,
      YOUYU_TEST_CANCEL_PATH: cancellationPath,
      YOUYU_TEST_TARGET_PATH: targetExecutablePath,
      YOUYU_TEST_CAPTURE_PATH: capturePath,
      YOUYU_TEST_SID: identity.sid,
      YOUYU_TEST_SESSION_ID: String(identity.sessionId),
      YOUYU_TEST_VERSION: identity.productVersion,
      YOUYU_TEST_NONCE: handoff.nonce,
      YOUYU_TEST_WRAPPER_EXIT_CODE: String(scenario.wrapperExitCode),
      YOUYU_TEST_CONSUME_HANDOFF: scenario.consumeHandoff ? '1' : '0',
      YOUYU_TEST_ACK_PAYLOAD: Buffer.from(JSON.stringify(acknowledgement), 'utf8').toString('base64')
    });
    const relaunchArguments = await readFile(capturePath, 'utf8').catch(() => '');
    const supervisorReady = JSON.parse(await readFile(supervisorReadyPath, 'utf8')) as {
      nonce: string;
      targetUserSid: string;
      supervisorProcessId: number;
    };
    return { ...result, relaunchArguments, supervisorReady };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

describe('controlled Windows update installer launcher', () => {
  it('keeps the handoff and process-supervision time budgets internally consistent', () => {
    expect(updateInstallerHandoffLifetimeMs).toBe(14 * 60 * 1000);
    expect(updateInstallerHandoffLifetimeMs).toBeLessThan(15 * 60 * 1000);
    expect(updateInstallerHandoffLifetimeMs).toBeGreaterThanOrEqual(
      updateInstallerSupervisorReadyTimeoutMs + updateInstallerExecutionTimeoutMs + 60_000
    );
    expect(updateInstallerBootstrapCleanupGraceMs + updateInstallerNodeCleanupMarginMs).toBeLessThan(
      updateInstallerSupervisorReadyTimeoutMs
    );
  });

  it('chooses only an absolute downloaded exe, never a blockmap or relative path', () => {
    expect(
      resolveDownloadedUpdateInstallerPath({
        downloadedPaths: ['update.blockmap', String.raw`C:\Users\Example\pending\YouYu-1.7.2-x64.exe`]
      })
    ).toBe(String.raw`C:\Users\Example\pending\YouYu-1.7.2-x64.exe`);
    expect(() => resolveDownloadedUpdateInstallerPath({ downloadedPaths: ['YouYu.exe', 'update.blockmap'] })).toThrow(
      'downloaded update installer path is unavailable'
    );
  });

  it('uses the canonical Windows PowerShell path instead of a PATH lookup', () => {
    expect(resolveWindowsPowerShellPath(String.raw`C:\Windows`)).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    );
    expect(() => resolveWindowsPowerShellPath('relative')).toThrow('Windows system root path is invalid');
  });

  it('launches a non-detached bootstrap with an environment-only authenticated handoff', async () => {
    const child = createLauncher();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, unref: vi.fn() });
    let spawnCall:
      | {
          powershellPath: string;
          args: string[];
          options: {
            windowsHide: boolean;
            detached: boolean;
            stdio: ['ignore', 'pipe', 'pipe'];
            env: NodeJS.ProcessEnv;
          };
        }
      | undefined;
    const spawnLauncher = (
      powershellPath: string,
      args: string[],
      options: {
        windowsHide: boolean;
        detached: boolean;
        stdio: ['ignore', 'pipe', 'pipe'];
        env: NodeJS.ProcessEnv;
      }
    ) => {
      spawnCall = { powershellPath, args, options };
      return child;
    };
    const environment: NodeJS.ProcessEnv = {
      SystemRoot: String.raw`C:\Windows`,
      KEEP: 'preserved',
      psmoduleanalysiscachepath: 'shared-cache-must-not-survive',
      psmodulepath: 'PowerShell-7-modules-must-not-survive',
      YOUYU_UPDATE_HANDOFF_PATH: 'source-environment-must-not-be-relied-on'
    };

    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example User\AppData\Local\youyu-updater\pending\YouYu-1.7.2-x64.exe`,
      expectedVersion: '1.7.2',
      resumeProxyAfterRelaunch: true,
      handoff,
      environment,
      spawnLauncher
    });

    expect(spawnCall).toBeDefined();
    const { powershellPath, args, options } = spawnCall as NonNullable<typeof spawnCall>;
    expect(powershellPath).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(args[3].length).toBeLessThan(24_000);
    expect(args.join(' ')).not.toContain(handoff.nonce);
    expect(args.join(' ')).not.toContain(handoff.targetUserSid);
    expect(args.join(' ')).not.toContain(handoff.path);
    expect(options).toMatchObject({ windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(String(options.env[updateInstallerBootstrapScriptEnvironment]).length).toBeGreaterThan(0);
    expect(String(options.env[updateInstallerSupervisorScriptEnvironment]).length).toBeLessThan(20_000);
    expect(String(options.env[updateInstallerSupervisorLoaderEnvironment])).not.toContain(handoff.nonce);
    expect(
      Object.keys(options.env).some(
        (key) => key.toLowerCase() === updateInstallerPowerShellModuleAnalysisCacheEnvironment.toLowerCase()
      )
    ).toBe(false);
    expect(
      Object.keys(options.env).some(
        (key) => key.toLowerCase() === updateInstallerPowerShellModulePathEnvironment.toLowerCase()
      )
    ).toBe(false);
    expect(environment[updateInstallerLauncherPayloadEnvironment]).toBeUndefined();
    expect(options.env.KEEP).toBe('preserved');

    const payload = JSON.parse(
      Buffer.from(String(options.env[updateInstallerLauncherPayloadEnvironment]), 'base64').toString('utf8')
    ) as {
      installerPath: string;
      expectedVersion: string;
      arguments: string[];
      acknowledgement: {
        path: string;
        handoffPath: string;
        nonce: string;
        targetUserSid: string;
        targetSessionId: string;
        targetProcessId: number;
        targetExecutablePath: string;
      };
      supervisorReady: { path: string; nonce: string; targetUserSid: string };
      cancellation: { path: string; nonce: string; targetUserSid: string };
      acknowledgementTimeoutMs: number;
      installerTimeoutMs: number;
      resumeProxyAfterRelaunch: boolean;
    };
    expect(payload).toEqual({
      installerPath: String.raw`C:\Users\Example User\AppData\Local\youyu-updater\pending\YouYu-1.7.2-x64.exe`,
      expectedVersion: '1.7.2',
      arguments: [
        '--updated',
        '/S',
        '--force-run',
        '--youyu-handoff-path',
        handoff.path,
        '--youyu-handoff-nonce',
        '8fb748f0-540a-4f7a-9bd2-144020b83e9b',
        '--youyu-target-user-sid',
        'S-1-5-21-100-200-300-1001',
        '--youyu-target-session-id',
        '7'
      ],
      acknowledgement: {
        path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-handoff-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`,
        handoffPath: handoff.path,
        nonce: handoff.nonce,
        targetUserSid: handoff.targetUserSid,
        targetSessionId: '7',
        targetProcessId: handoff.targetProcessId,
        targetExecutablePath: handoff.targetExecutablePath
      },
      supervisorReady: {
        path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-supervisor-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`,
        nonce: handoff.nonce,
        targetUserSid: handoff.targetUserSid
      },
      cancellation: {
        path: resolveUpdateInstallerCancellationPath(handoff),
        nonce: handoff.nonce,
        targetUserSid: handoff.targetUserSid
      },
      acknowledgementTimeoutMs: updateInstallerAcknowledgementTimeoutMs,
      installerTimeoutMs: updateInstallerExecutionTimeoutMs,
      resumeProxyAfterRelaunch: true
    });
    const bootstrapPayload = JSON.parse(
      Buffer.from(String(options.env[updateInstallerBootstrapPayloadEnvironment]), 'base64').toString('utf8')
    );
    expect(bootstrapPayload).toEqual({
      version: '1',
      readyPath: payload.supervisorReady.path,
      handoffPath: handoff.path,
      cancellationPath: payload.cancellation.path,
      nonce: handoff.nonce,
      targetUserSid: handoff.targetUserSid,
      timeoutMs:
        updateInstallerSupervisorReadyTimeoutMs -
        updateInstallerBootstrapCleanupGraceMs -
        updateInstallerNodeCleanupMarginMs,
      cleanupTimeoutMs: updateInstallerBootstrapCleanupGraceMs
    });
    expect(payload.arguments.join('\n')).not.toMatch(/https?:\/\//i);
    expect(payload.arguments).not.toContain('--youyu-unknown=reject');

    stdout.write(updateInstallerSupervisorReadyMessage + '\n');
    await expect(launch).resolves.toBeUndefined();
  });

  it('keeps the app alive when UAC is canceled or the elevated installer fails to start', async () => {
    const child = createLauncher();
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.2-x64.exe`,
      expectedVersion: '1.7.2',
      resumeProxyAfterRelaunch: false,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      spawnLauncher: () => child
    });

    child.emit('close', 1223, null);
    await expect(launch).rejects.toThrow(
      'update installer supervisor exited before authenticated readiness (exit code 1223)'
    );
  });

  it('keeps the app alive when the supervisor exits successfully without authenticated readiness', async () => {
    const child = createLauncher();
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.7-x64.exe`,
      expectedVersion: '1.7.7',
      resumeProxyAfterRelaunch: false,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      spawnLauncher: () => child
    });

    child.emit('close', 0, null);

    await expect(launch).rejects.toThrow(
      'update installer supervisor exited before authenticated readiness (exit code 0)'
    );
  });

  it('hands off after authenticated readiness while the detached supervisor keeps watching installation', async () => {
    const child = createLauncher();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const unref = vi.fn();
    Object.assign(child, { stdout, stderr, unref });
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.7-x64.exe`,
      expectedVersion: '1.7.7',
      resumeProxyAfterRelaunch: false,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      spawnLauncher: () => child
    });

    stdout.write(updateInstallerSupervisorReadyMessage + '\n');

    await expect(
      Promise.race([
        launch.then(() => 'ready'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100))
      ])
    ).resolves.toBe('ready');
    expect(unref).toHaveBeenCalledOnce();
  });

  it('bounds the whole pre-ready UAC wait and keeps the current app available', async () => {
    const child = createLauncher();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn();
    Object.assign(child, { stdout, stderr, kill });
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.7-x64.exe`,
      expectedVersion: '1.7.7',
      resumeProxyAfterRelaunch: true,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      supervisorReadyTimeoutMs: 10,
      spawnLauncher: () => child
    });

    await expect(launch).rejects.toThrow('update installer supervisor did not become ready in time');
    expect(kill).toHaveBeenCalledOnce();
  });

  it('returns a bounded sanitized launcher error instead of discarding PowerShell stderr', async () => {
    const child = createLauncher();
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.2-x64.exe`,
      expectedVersion: '1.7.2',
      resumeProxyAfterRelaunch: false,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      spawnLauncher: () => child
    });

    stderr.write(
      `YouYu update launcher: failed at C:\\Users\\Example\\secret\\update.exe for ${handoff.nonce} and ${handoff.targetUserSid}`
    );
    stderr.end();
    child.emit('close', 1, null);

    await expect(launch).rejects.toThrow(
      'update installer supervisor exited before authenticated readiness (exit code 1: YouYu update launcher: failed at <path><nonce> and <sid>)'
    );
  });

  it('generates a fixed UAC launcher that validates every payload member before Start-Process', () => {
    const script = createUpdateInstallerLauncherScript();
    const bootstrapScript = createUpdateInstallerBootstrapScript();
    const elevatedScript = createElevatedUpdateInstallerScript();
    const loaderScript = Buffer.from(
      createUpdateInstallerSupervisorTransport('exit 0').encodedLoaderCommand,
      'base64'
    ).toString('utf16le');

    expect(script).toContain('$arguments.Count -ne 11');
    expect(script).toContain('function Test-FullyQualifiedWindowsPath');
    expect(script).not.toContain('IsPathFullyQualified');
    expect(script).toContain("$arguments[5] -cne '--youyu-handoff-nonce'");
    expect(script).toContain("Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe'))");
    expect(elevatedScript).toContain(
      'Start-Process -FilePath $installerPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru'
    );
    expect(elevatedScript).not.toContain('Import-Module');
    expect(loaderScript).not.toContain('Import-Module');
    for (const powershellScript of [script, bootstrapScript, elevatedScript, loaderScript]) {
      expect(powershellScript).not.toContain('Get-Acl');
      expect(powershellScript).not.toContain('Set-Acl');
      expect(powershellScript).not.toContain('$acl.Access');
    }
    expect(script).toContain('[IO.File]::GetAccessControl');
    expect(script).toContain('[IO.File]::SetAccessControl');
    expect(elevatedScript).toContain("$taskkillArguments = '/PID ' + $rootProcessId + ' /T /F'");
    expect(elevatedScript.indexOf('$taskkill = Start-Process')).toBeLessThan(
      elevatedScript.indexOf('try { $trackedProcessIds = @(Get-ProcessTreeIds $rootProcessId)')
    );
    expect(elevatedScript).toContain('$installerBoundaryClosed = $true');
    expect(elevatedScript).toContain('$null -eq $installer -or $installerBoundaryClosed');
    expect(script).toContain('ConvertTo-WindowsCommandLineArgument');
    expect(script).toContain('[void] $started.WaitForExit(750)');
    expect(script).toContain(
      "if ($started.HasExited) { throw 'elevated update installer exited before the app handoff completed' }"
    );
    expect(script).toContain('function Test-AuthenticatedUpdateAcknowledgement');
    expect(script).toContain('$targetExecutablePath = [string] $acknowledgement.targetExecutablePath');
    expect(script).toContain('acknowledgement.executablePath)) -ine $expectedExecutablePath');
    expect(script).toContain(
      '$acknowledgementDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($acknowledgementTimeoutMs)'
    );
    expect(script).toContain('update acknowledgement payload does not match its handoff');
    expect(script).toContain('$acl.AreAccessRulesProtected');
    expect(script).toContain('$rules.Count -ne 1');
    expect(script).toContain('Remove-Item Env:YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD');
    expect(script).toContain('Write-AuthenticatedSupervisorReady');
    expect(script).toContain('supervisorProcessId = [int] $PID');
    expect(script).not.toContain(updateInstallerSupervisorReadyMessage);
    expect(bootstrapScript).toContain(updateInstallerSupervisorReadyMessage);
    expect(bootstrapScript).toContain("Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe'))");
    expect(bootstrapScript).toContain('Test-PrivateSupervisorReadyFile');
    expect(bootstrapScript).not.toContain('Invoke-Expression');
    expect(script).toContain('$started.WaitForExit($installerTimeoutMs + 30000)');
    expect(script).toContain('$started.ExitCode -ne 0');
    expect(script).toContain('update installer exited without consuming the authenticated handoff');
    expect(script).not.toContain(
      '(Test-Path -LiteralPath $handoffPath -PathType Leaf) -or (Test-Path -LiteralPath $acknowledgementPath'
    );
    expect(script).toContain('installed YouYu version');
    expect(script).toContain("Start-YouYuAfterUpdate $targetExecutablePath '--updated' $expectedVersionText");
    expect(script).toContain(
      "Start-YouYuAfterUpdate $targetExecutablePath '--update-install-failed' $recoveryVersionText"
    );
    expect(script).not.toContain('Invoke-Expression');
    expect(script).not.toMatch(/https?:\/\//i);
  });

  it('packages the exact reviewed elevated wrapper used by the generated supervisor', async () => {
    const packagedWrapper = (await readFile('build/update-elevated-installer.ps1', 'utf8'))
      .replace(/\r\n/g, '\n')
      .trimEnd();
    const builderConfig = await readFile('electron-builder.yml', 'utf8');

    expect(packagedWrapper).toBe(createElevatedUpdateInstallerScript());
    expect(builderConfig).toContain('from: build/update-elevated-installer.ps1');
    expect(builderConfig).toContain('to: update-elevated-installer.ps1');
  });

  it('runs every pre-launch validation under the bundled Windows PowerShell 5.1 runtime', async () => {
    if (process.platform !== 'win32') return;

    const script = createUpdateInstallerLauncherScript();
    const startIndex = script.indexOf('# YOUYU_UPDATE_SUPERVISOR_START');
    const outerCatchIndex = script.indexOf('# YOUYU_UPDATE_SUPERVISOR_OUTER_CATCH');
    expect(startIndex).toBeGreaterThan(0);
    expect(outerCatchIndex).toBeGreaterThan(startIndex);
    const probeScript = `function Test-Path { return $true }\nfunction Get-Item { [pscustomobject]@{ Attributes = 0; Length = 1024 } }\n${script.slice(0, startIndex)}[Console]::Out.WriteLine('validation-pass')\n${script.slice(outerCatchIndex)}`;
    const payload = Buffer.from(
      JSON.stringify({
        installerPath: String.raw`C:\Users\Example User\pending\YouYu-1.7.5-x64.exe`,
        expectedVersion: '1.7.5',
        arguments: [
          '--updated',
          '/S',
          '--force-run',
          '--youyu-handoff-path',
          handoff.path,
          '--youyu-handoff-nonce',
          handoff.nonce,
          '--youyu-target-user-sid',
          handoff.targetUserSid,
          '--youyu-target-session-id',
          String(handoff.targetSessionId)
        ],
        acknowledgement: {
          path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-handoff-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`,
          handoffPath: handoff.path,
          nonce: handoff.nonce,
          targetUserSid: handoff.targetUserSid,
          targetSessionId: String(handoff.targetSessionId),
          targetProcessId: handoff.targetProcessId,
          targetExecutablePath: handoff.targetExecutablePath
        },
        supervisorReady: {
          path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-supervisor-8fb748f0-540a-4f7a-9bd2-144020b83e9b.ready.json`,
          nonce: handoff.nonce,
          targetUserSid: handoff.targetUserSid
        },
        cancellation: {
          path: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-cancel-8fb748f0-540a-4f7a-9bd2-144020b83e9b.json`,
          nonce: handoff.nonce,
          targetUserSid: handoff.targetUserSid
        },
        acknowledgementTimeoutMs: updateInstallerAcknowledgementTimeoutMs,
        installerTimeoutMs: updateInstallerExecutionTimeoutMs,
        resumeProxyAfterRelaunch: false
      }),
      'utf8'
    ).toString('base64');
    const { stdout, stderr, exitCode } = await runWindowsPowerShellScript(probeScript, {
      ...process.env,
      PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`,
      [updateInstallerLauncherPayloadEnvironment]: payload
    });

    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toContain('YouYu update launcher:');
    expect(stdout.trim()).toBe('validation-pass');
  });

  it('runs the bounded elevated wrapper validation under Windows PowerShell 5.1', async () => {
    if (process.platform !== 'win32') return;

    const script = createElevatedUpdateInstallerScript();
    const startIndex = script.indexOf('$installer = Start-Process');
    const stateIndex = script.indexOf('$initialCancellationState =');
    expect(startIndex).toBeGreaterThan(0);
    expect(stateIndex).toBeGreaterThan(0);
    expect(startIndex).toBeGreaterThan(stateIndex);
    const probeScript = `${script.slice(0, stateIndex)}function Get-UpdateCancellationState { return 'armed' }\n${script.slice(stateIndex, startIndex)}[Console]::Out.WriteLine('wrapper-validation-pass')\n} catch { [Console]::Error.WriteLine(('YouYu elevated update wrapper: ' + $_.Exception.Message)); exit 125 }`;
    const elevatedPayload = Buffer.from(
      JSON.stringify({
        installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.7-x64.exe`,
        arguments: [
          '--updated',
          '/S',
          '--force-run',
          '--youyu-handoff-path',
          handoff.path,
          '--youyu-handoff-nonce',
          handoff.nonce,
          '--youyu-target-user-sid',
          handoff.targetUserSid,
          '--youyu-target-session-id',
          String(handoff.targetSessionId)
        ],
        installerTimeoutMs: updateInstallerExecutionTimeoutMs,
        cancellationPath: String.raw`C:\Users\Example User\AppData\Local\Temp\youyu-update-cancel-8fb748f0-540a-4f7a-9bd2-144020b83e9b.json`,
        cancellationNonce: handoff.nonce,
        targetUserSid: handoff.targetUserSid
      }),
      'utf8'
    ).toString('base64');
    const { stdout, stderr, exitCode } = await runWindowsPowerShellScript(probeScript, {
      ...process.env,
      [updateElevatedInstallerPayloadEnvironment]: elevatedPayload
    });

    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toContain('YouYu elevated update wrapper:');
    expect(stdout.trim()).toBe('wrapper-validation-pass');
  });

  it('uses the packaged Windows PowerShell 5.1 wrapper to cancel a real parent-child installer tree without survivors', async () => {
    if (process.platform !== 'win32') return;

    const identity = await resolveWindowsPowerShellFixtureIdentity();
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'youyu-update-tree-kill-'));
    const helperPath = join(fixtureRoot, 'installer-tree-fixture.exe');
    const parentPidPath = join(fixtureRoot, 'parent.pid');
    const childPidPath = join(fixtureRoot, 'child.pid');
    const handoffPath = join(fixtureRoot, `youyu-update-handoff-${handoff.nonce}.json`);
    const cancellationPath = join(fixtureRoot, `youyu-update-cancel-${handoff.nonce}.json`);
    let parentPid = 0;
    let childPid = 0;
    const isAlive = (processId: number) => {
      if (!Number.isSafeInteger(processId) || processId <= 0) return false;
      try {
        process.kill(processId, 0);
        return true;
      } catch {
        return false;
      }
    };
    const forceCloseTree = async (processId: number) => {
      if (!isAlive(processId)) return;
      const taskkill = spawn(join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe'), [
        '/PID',
        String(processId),
        '/T',
        '/F'
      ]);
      await new Promise<void>((resolve) => taskkill.once('close', () => resolve()));
    };

    try {
      const compileScript = [
        "$source = @'",
        'using System;',
        'using System.Diagnostics;',
        'using System.IO;',
        'using System.Reflection;',
        'using System.Threading;',
        'public static class InstallerTreeFixture {',
        '  public static int Main(string[] args) {',
        '    if (args.Length == 1 && args[0] == "child") {',
        '      File.WriteAllText(Environment.GetEnvironmentVariable("YOUYU_TEST_CHILD_PID_PATH"), Process.GetCurrentProcess().Id.ToString());',
        '      Thread.Sleep(60000);',
        '      return 0;',
        '    }',
        '    File.WriteAllText(Environment.GetEnvironmentVariable("YOUYU_TEST_PARENT_PID_PATH"), Process.GetCurrentProcess().Id.ToString());',
        '    ProcessStartInfo startInfo = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child");',
        '    startInfo.UseShellExecute = false;',
        '    startInfo.CreateNoWindow = true;',
        '    Process child = Process.Start(startInfo);',
        '    if (child == null) return 2;',
        '    child.WaitForExit();',
        '    return child.ExitCode;',
        '  }',
        '}',
        "'@",
        'Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $env:YOUYU_TEST_HELPER_PATH -OutputType ConsoleApplication'
      ].join('\n');
      const compileResult = await runWindowsPowerShellScript(compileScript, {
        ...process.env,
        YOUYU_TEST_HELPER_PATH: helperPath
      });
      expect(compileResult.exitCode, compileResult.stderr).toBe(0);

      const marker = JSON.stringify({
        version: 1,
        nonce: handoff.nonce,
        targetUserSid: identity.sid.toUpperCase(),
        state: 'armed',
        updatedAtEpochMs: Date.now()
      });
      const initializeMarkerScript = [
        '[IO.File]::WriteAllText($env:YOUYU_TEST_CANCEL_PATH, $env:YOUYU_TEST_CANCEL_PAYLOAD, (New-Object Text.UTF8Encoding($false)))',
        '$sid = New-Object Security.Principal.SecurityIdentifier($env:YOUYU_TEST_SID)',
        '$acl = New-Object Security.AccessControl.FileSecurity',
        '$acl.SetOwner($sid)',
        '$acl.SetAccessRuleProtection($true, $false)',
        '$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
        '$acl.SetAccessRule($rule)',
        '[IO.File]::SetAccessControl($env:YOUYU_TEST_CANCEL_PATH, $acl)'
      ].join('\n');
      const markerResult = await runWindowsPowerShellScript(initializeMarkerScript, {
        ...process.env,
        YOUYU_TEST_CANCEL_PATH: cancellationPath,
        YOUYU_TEST_CANCEL_PAYLOAD: marker,
        YOUYU_TEST_SID: identity.sid
      });
      expect(markerResult.exitCode, markerResult.stderr).toBe(0);

      const elevatedPayload = Buffer.from(
        JSON.stringify({
          installerPath: helperPath,
          arguments: [
            '--updated',
            '/S',
            '--force-run',
            '--youyu-handoff-path',
            handoffPath,
            '--youyu-handoff-nonce',
            handoff.nonce,
            '--youyu-target-user-sid',
            identity.sid,
            '--youyu-target-session-id',
            String(identity.sessionId)
          ],
          installerTimeoutMs: 30_000,
          cancellationPath,
          cancellationNonce: handoff.nonce,
          targetUserSid: identity.sid
        }),
        'utf8'
      ).toString('base64');
      const wrapper = spawn(
        resolveWindowsPowerShellPath(process.env.SystemRoot),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(process.cwd(), 'build', 'update-elevated-installer.ps1')
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: createWindowsPowerShellFixtureEnvironment({
            ...process.env,
            [updateElevatedInstallerPayloadEnvironment]: elevatedPayload,
            YOUYU_TEST_PARENT_PID_PATH: parentPidPath,
            YOUYU_TEST_CHILD_PID_PATH: childPidPath
          })
        }
      );
      let wrapperStderr = '';
      wrapper.stderr.setEncoding('utf8');
      wrapper.stderr.on('data', (chunk: string) => (wrapperStderr += chunk));
      const wrapperExit = new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          wrapper.kill();
          reject(new Error('real elevated wrapper cancellation timed out'));
        }, 15_000);
        wrapper.once('error', reject);
        wrapper.once('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });

      const pidDeadline = Date.now() + 5_000;
      while ((!parentPid || !childPid) && Date.now() < pidDeadline) {
        parentPid = Number.parseInt(await readFile(parentPidPath, 'utf8').catch(() => ''), 10) || 0;
        childPid = Number.parseInt(await readFile(childPidPath, 'utf8').catch(() => ''), 10) || 0;
        if (!parentPid || !childPid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(parentPid).toBeGreaterThan(0);
      expect(childPid).toBeGreaterThan(0);
      expect(isAlive(parentPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      expect(
        signalUpdateInstallerCancellation({
          path: handoffPath,
          nonce: handoff.nonce,
          targetUserSid: identity.sid
        })
      ).toBe(true);
      expect(await wrapperExit, wrapperStderr).toBe(126);
      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
      await expect(readFile(cancellationPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await forceCloseTree(parentPid);
      if (isAlive(childPid)) process.kill(childPid);
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 30_000);

  it('executes the full Windows PowerShell 5.1 supervisor through install, version check, and authenticated app readiness', async () => {
    if (process.platform !== 'win32') return;

    const result = await runFullWindowsSupervisorScenario({
      wrapperExitCode: 0,
      consumeHandoff: true,
      resumeProxyAfterRelaunch: true
    });

    expect(result.exitCode).toBe(0);
    expect(result.supervisorReady).toMatchObject({
      nonce: handoff.nonce
    });
    expect(result.supervisorReady.targetUserSid).toMatch(/^S-1-/i);
    expect(result.supervisorReady.supervisorProcessId).toBeGreaterThan(0);
    expect(result.stderr).not.toContain('YouYu update launcher:');
    expect(result.relaunchArguments).toContain('--updated');
    expect(result.relaunchArguments).toContain('--resume-proxy-after-relaunch');
    expect(result.relaunchArguments).toContain('--youyu-update-relaunch-path');
    expect(result.relaunchArguments).toContain('--youyu-update-relaunch-nonce');
  });

  it('preserves a stopped runtime intent across a complete successful Windows PowerShell 5.1 supervisor run', async () => {
    if (process.platform !== 'win32') return;

    const result = await runFullWindowsSupervisorScenario({
      wrapperExitCode: 0,
      consumeHandoff: true,
      resumeProxyAfterRelaunch: false
    });

    expect(result.exitCode).toBe(0);
    expect(result.supervisorReady.nonce).toBe(handoff.nonce);
    expect(result.relaunchArguments).toContain('--updated');
    expect(result.relaunchArguments).not.toContain('--resume-proxy-after-relaunch');
  });

  it('reopens the verified installed executable in safe failure mode after a non-zero installer exit', async () => {
    if (process.platform !== 'win32') return;

    const result = await runFullWindowsSupervisorScenario({
      wrapperExitCode: 7,
      consumeHandoff: true,
      resumeProxyAfterRelaunch: true
    });

    expect(result.exitCode).toBe(1);
    expect(result.supervisorReady.nonce).toBe(handoff.nonce);
    expect(result.stderr).toContain('elevated update installer failed with exit code 7');
    expect(result.relaunchArguments).toContain('--update-install-failed');
    expect(result.relaunchArguments).toContain('--resume-proxy-after-relaunch');
  });

  it('rejects an unconsumed handoff and safely reopens without changing a stopped runtime intent', async () => {
    if (process.platform !== 'win32') return;

    const result = await runFullWindowsSupervisorScenario({
      wrapperExitCode: 0,
      consumeHandoff: false,
      resumeProxyAfterRelaunch: false
    });

    expect(result.exitCode).toBe(1);
    expect(result.supervisorReady.nonce).toBe(handoff.nonce);
    expect(result.stderr).toContain('update installer exited without consuming the authenticated handoff');
    expect(result.relaunchArguments).toContain('--update-install-failed');
    expect(result.relaunchArguments).not.toContain('--resume-proxy-after-relaunch');
  });

  it('keeps the independent Windows PowerShell 5.1 supervisor alive after its short-lived Node parent exits', async () => {
    if (process.platform !== 'win32') return;

    const identity = await resolveWindowsPowerShellFixtureIdentity();
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'youyu-update-bootstrap-'));
    const sentinelPath = join(fixtureRoot, 'supervisor-finished.txt');
    const handoffPath = join(fixtureRoot, `youyu-update-handoff-${handoff.nonce}.json`);
    const readyPath = join(fixtureRoot, `youyu-update-supervisor-${handoff.nonce}.ready.json`);
    const cancellationPath = join(fixtureRoot, `youyu-update-cancel-${handoff.nonce}.json`);
    const powershellPath = resolveWindowsPowerShellPath(process.env.SystemRoot);
    const sentinelScript = [
      '$readyPath = [string] $env:YOUYU_TEST_SUPERVISOR_READY_PATH',
      '$sentinelPath = [string] $env:YOUYU_TEST_SENTINEL_PATH',
      '$handoffPath = [string] $env:YOUYU_TEST_HANDOFF_PATH',
      '$nonce = [string] $env:YOUYU_TEST_NONCE',
      '$targetUserSid = [string] $env:YOUYU_TEST_SID',
      '$stream = [IO.File]::Open($readyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
      '$stream.Dispose()',
      '$sid = New-Object Security.Principal.SecurityIdentifier($targetUserSid)',
      '$acl = New-Object Security.AccessControl.FileSecurity',
      '$acl.SetOwner($sid)',
      '$acl.SetAccessRuleProtection($true, $false)',
      '$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
      '$acl.SetAccessRule($rule)',
      '[IO.File]::SetAccessControl($readyPath, $acl)',
      '$readyAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
      "$ready = [pscustomobject]@{ version = '1'; nonce = $nonce; handoffPath = $handoffPath; targetUserSid = $targetUserSid; supervisorProcessId = [int] $PID; readyAtEpochMs = $readyAt; expiresAtEpochMs = $readyAt + 300000L }",
      '[IO.File]::WriteAllText($readyPath, ($ready | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))',
      'Start-Sleep -Milliseconds 1500',
      "[Console]::Out.WriteLine('post-parent-output')",
      "[Console]::Error.WriteLine('post-parent-error')",
      'Start-Sleep -Milliseconds 500',
      "[IO.File]::WriteAllText($sentinelPath, 'finished', (New-Object Text.UTF8Encoding($false)))"
    ].join('\n');
    const supervisorTransport = createUpdateInstallerSupervisorTransport(sentinelScript);
    const bootstrapEncodedCommand = Buffer.from(createUpdateInstallerBootstrapScript(), 'utf16le').toString('base64');
    const bootstrapPayload = Buffer.from(
      JSON.stringify({
        version: '1',
        readyPath,
        handoffPath,
        cancellationPath,
        nonce: handoff.nonce,
        targetUserSid: identity.sid,
        timeoutMs: 5_000,
        cleanupTimeoutMs: 2_000
      }),
      'utf8'
    ).toString('base64');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(${JSON.stringify(powershellPath)}, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ${JSON.stringify(bootstrapEncodedCommand)}], { detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });`,
      "let output = ''; let diagnostic = ''; let ready = false;",
      "child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });",
      "child.stderr.on('data', (chunk) => { diagnostic += chunk.toString(); });",
      "child.stdout.on('data', (chunk) => { output += chunk.toString(); if (!ready && output.split(/\\r?\\n/).includes('YOUYU_UPDATE_SUPERVISOR_READY')) { ready = true; console.log(child.pid); child.stdout.destroy(); child.stderr.destroy(); child.unref(); } });",
      "child.once('close', (code) => { if (!ready) { console.error('bootstrap exited before readiness: ' + code + ' ' + diagnostic); process.exitCode = 1; } });"
    ].join('\n');

    try {
      const parent = spawn(process.execPath, ['-e', parentScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: createWindowsPowerShellFixtureEnvironment({
          ...process.env,
          [updateInstallerBootstrapPayloadEnvironment]: bootstrapPayload,
          [updateInstallerSupervisorLoaderEnvironment]: supervisorTransport.encodedLoaderCommand,
          [updateInstallerSupervisorScriptEnvironment]: supervisorTransport.environmentValue,
          YOUYU_TEST_SUPERVISOR_READY_PATH: readyPath,
          YOUYU_TEST_SENTINEL_PATH: sentinelPath,
          YOUYU_TEST_HANDOFF_PATH: handoffPath,
          YOUYU_TEST_NONCE: handoff.nonce,
          YOUYU_TEST_SID: identity.sid
        })
      });
      let parentStdout = '';
      let parentStderr = '';
      parent.stdout.setEncoding('utf8');
      parent.stderr.setEncoding('utf8');
      parent.stdout.on('data', (chunk: string) => (parentStdout += chunk));
      parent.stderr.on('data', (chunk: string) => (parentStderr += chunk));
      const parentExitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          parent.kill();
          reject(new Error('short-lived Node parent did not exit'));
        }, 8_000);
        parent.once('error', reject);
        parent.once('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(parentExitCode, parentStderr).toBe(0);
      expect(parentStderr).toBe('');
      expect(parentStdout.trim()).toMatch(/^\d+$/);
      expect(await readFile(sentinelPath, 'utf8').catch(() => '')).toBe('');

      let sentinel = '';
      const deadline = Date.now() + 8_000;
      while (!sentinel && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        sentinel = await readFile(sentinelPath, 'utf8').catch(() => '');
      }
      expect(sentinel).toBe('finished');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('sanitizes paths, identities, URLs, control characters, and oversized diagnostics', () => {
    const diagnostic = sanitizeUpdateInstallerLauncherDiagnostic(
      `failure\nC:\\Users\\Example\\secret.exe ${handoff.nonce} ${handoff.targetUserSid} https://example.com/private ${'x'.repeat(600)}`
    );
    expect(diagnostic).not.toContain('Example');
    expect(diagnostic).not.toContain(handoff.nonce);
    expect(diagnostic).not.toContain(handoff.targetUserSid);
    expect(diagnostic).not.toContain('example.com');
    expect(diagnostic.length).toBeLessThanOrEqual(400);
  });
});
