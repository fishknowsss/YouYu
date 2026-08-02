import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createUpdateInstallerLauncherScript,
  launchDownloadedUpdateInstaller,
  resolveDownloadedUpdateInstallerPath,
  resolveWindowsPowerShellPath,
  updateInstallerAcknowledgementTimeoutMs,
  updateInstallerLauncherPayloadEnvironment
} from '../../src/main/updateInstallerLauncher';

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
  return new EventEmitter() as unknown as ChildProcess;
}

describe('controlled Windows update installer launcher', () => {
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

  it('launches the UAC bridge with only the authenticated four-value handoff ABI', async () => {
    const child = createLauncher();
    let spawnCall:
      | {
          powershellPath: string;
          args: string[];
          options: { windowsHide: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv };
        }
      | undefined;
    const spawnLauncher = (
      powershellPath: string,
      args: string[],
      options: { windowsHide: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv }
    ) => {
      spawnCall = { powershellPath, args, options };
      return child;
    };
    const environment: NodeJS.ProcessEnv = {
      SystemRoot: String.raw`C:\Windows`,
      KEEP: 'preserved',
      YOUYU_UPDATE_HANDOFF_PATH: 'source-environment-must-not-be-relied-on'
    };

    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example User\AppData\Local\youyu-updater\pending\YouYu-1.7.2-x64.exe`,
      handoff,
      environment,
      spawnLauncher
    });

    expect(spawnCall).toBeDefined();
    const { powershellPath, args, options } = spawnCall as NonNullable<typeof spawnCall>;
    expect(powershellPath).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(options).toMatchObject({ windowsHide: true, stdio: 'ignore' });
    expect(environment[updateInstallerLauncherPayloadEnvironment]).toBeUndefined();
    expect(options.env.KEEP).toBe('preserved');

    const payload = JSON.parse(
      Buffer.from(String(options.env[updateInstallerLauncherPayloadEnvironment]), 'base64').toString('utf8')
    ) as {
      installerPath: string;
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
      acknowledgementTimeoutMs: number;
    };
    expect(payload).toEqual({
      installerPath: String.raw`C:\Users\Example User\AppData\Local\youyu-updater\pending\YouYu-1.7.2-x64.exe`,
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
      acknowledgementTimeoutMs: updateInstallerAcknowledgementTimeoutMs
    });
    expect(payload.arguments.join('\n')).not.toMatch(/https?:\/\//i);
    expect(payload.arguments).not.toContain('--youyu-unknown=reject');

    child.emit('exit', 0, null);
    await expect(launch).resolves.toBeUndefined();
  });

  it('keeps the app alive when UAC is canceled or the elevated installer fails to start', async () => {
    const child = createLauncher();
    const launch = launchDownloadedUpdateInstaller({
      installerPath: String.raw`C:\Users\Example\pending\YouYu-1.7.2-x64.exe`,
      handoff,
      environment: { SystemRoot: String.raw`C:\Windows` },
      spawnLauncher: () => child
    });

    child.emit('exit', 1223, null);
    await expect(launch).rejects.toThrow('elevated update installer launch failed (exit code 1223)');
  });

  it('generates a fixed UAC launcher that validates every payload member before Start-Process', () => {
    const script = createUpdateInstallerLauncherScript();

    expect(script).toContain('$arguments.Count -ne 11');
    expect(script).toContain("$arguments[5] -cne '--youyu-handoff-nonce'");
    expect(script).toContain('Start-Process -FilePath $installerPath -ArgumentList $argumentLine -Verb RunAs');
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
    expect(script).not.toContain('Invoke-Expression');
    expect(script).not.toMatch(/https?:\/\//i);
  });
});
