import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

export type ManagedElevatedProcess = {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  kill: () => unknown;
  killed: boolean;
};

type ElevatedProcessOptions = {
  parentPid?: number;
  pollIntervalMs?: number;
  mihomoConfig?: string;
  signal?: AbortSignal;
};

function encodePowerShell(source: string): string {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function buildElevatedProcessScript(input: {
  binaryPath: string;
  args: string[];
  pipeName: string;
  operationId: string;
  parentPid: number;
  pollIntervalMs: number;
  receivesMihomoConfig: boolean;
}): string {
  const encodedArgs = encodeUtf8(JSON.stringify(input.args));
  return [
    "$ErrorActionPreference = 'Stop'",
    '$process = $null',
    '$writer = $null',
    '$secureWorkDir = $null',
    `$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', '${input.pipeName}', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)`,
    'try {',
    '  $pipe.Connect(15000)',
    '  $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)',
    '  $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)',
    '  $writer.AutoFlush = $true',
    '  $decode = { param([string]$value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }',
    `  $binary = & $decode '${encodeUtf8(input.binaryPath)}'`,
    `  $arguments = @(ConvertFrom-Json (& $decode '${encodedArgs}'))`,
    '  $request = ConvertFrom-Json $reader.ReadLine()',
    "  if ($request.canceled) { $writer.WriteLine('EXIT:0'); return }",
    ...(input.receivesMihomoConfig
      ? [
          "  if (-not $request.config) { throw 'missing mihomo config' }",
          "  $baseDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'YouYu'",
          "  if ((Test-Path -LiteralPath $baseDir) -and ((Get-Item -LiteralPath $baseDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe ProgramData path' }",
          '  [IO.Directory]::CreateDirectory($baseDir) | Out-Null',
          '  $acl = [Security.AccessControl.DirectorySecurity]::new()',
          '  $acl.SetAccessRuleProtection($true, $false)',
          '  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
          '  $propagation = [Security.AccessControl.PropagationFlags]::None',
          '  $allow = [Security.AccessControl.AccessControlType]::Allow',
          "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $allow))",
          "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $allow))",
          '  [IO.Directory]::SetAccessControl($baseDir, $acl)',
          `  $secureWorkDir = Join-Path $baseDir 'runtime-${input.operationId}'`,
          "  if (Test-Path -LiteralPath $secureWorkDir) { throw 'secure runtime path already exists' }",
          '  [IO.Directory]::CreateDirectory($secureWorkDir) | Out-Null',
          '  [IO.Directory]::SetAccessControl($secureWorkDir, $acl)',
          "  $configPath = Join-Path $secureWorkDir 'config.yaml'",
          '  [IO.File]::WriteAllBytes($configPath, [Convert]::FromBase64String([string]$request.config))',
          "  $arguments = @('-d', $secureWorkDir, '-f', $configPath)"
        ]
      : []),
    '  $quotedArguments = @($arguments | ForEach-Object {',
    '    $text = [string]$_',
    "    if ($text -notmatch '[\\s\"]') { $text } else { '\"' + $text.Replace('\\', '\\\\').Replace('\"', '\\\"') + '\"' }",
    '  })',
    '  $readTask = $reader.ReadLineAsync()',
    "  if ($readTask.IsCompleted -and (($readTask.Result -eq 'STOP') -or ($null -eq $readTask.Result))) { $writer.WriteLine('EXIT:0'); return }",
    "  $process = Start-Process -FilePath $binary -ArgumentList ($quotedArguments -join ' ') -WindowStyle Hidden -PassThru",
    "  $writer.WriteLine('READY:' + $process.Id)",
    '  while (-not $process.HasExited) {',
    `    $parentExited = -not (Get-Process -Id ${input.parentPid} -ErrorAction SilentlyContinue)`,
    "    $stopRequested = $readTask.IsCompleted -and (($readTask.Result -eq 'STOP') -or ($null -eq $readTask.Result))",
    '    if ($parentExited -or $stopRequested) {',
    '      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue',
    '      break',
    '    }',
    `    Start-Sleep -Milliseconds ${input.pollIntervalMs}`,
    '    $process.Refresh()',
    '  }',
    '  $process.WaitForExit()',
    "  $writer.WriteLine('EXIT:' + $process.ExitCode)",
    '} catch {',
    "  if ($writer) { $writer.WriteLine('ERROR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))) }",
    '  throw',
    '} finally {',
    '  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }',
    '  if ($writer) { $writer.Dispose() }',
    '  if ($pipe) { $pipe.Dispose() }',
    '  if ($secureWorkDir -and (Test-Path -LiteralPath $secureWorkDir)) { Remove-Item -LiteralPath $secureWorkDir -Recurse -Force -ErrorAction SilentlyContinue }',
    '}'
  ].join('\r\n');
}

export function spawnWindowsElevatedMihomo(
  binaryPath: string,
  args: string[],
  options: Omit<ElevatedProcessOptions, 'mihomoConfig'> = {}
): ManagedElevatedProcess {
  const configIndex = args.indexOf('-f');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath) throw new Error('missing mihomo config path');
  const mihomoConfig = readFileSync(configPath, 'utf8');
  return spawnWindowsElevatedProcess(binaryPath, args, { ...options, mihomoConfig });
}

export function spawnWindowsElevatedProcess(
  binaryPath: string,
  args: string[],
  options: ElevatedProcessOptions = {}
): ManagedElevatedProcess {
  const operationId = randomUUID();
  const pipeName = `youyu-elevated-${process.pid}-${operationId}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 250);
  const script = buildElevatedProcessScript({
    binaryPath,
    args,
    pipeName,
    operationId,
    parentPid: options.parentPid ?? process.pid,
    pollIntervalMs,
    receivesMihomoConfig: typeof options.mihomoConfig === 'string'
  });
  const powershellPath = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const innerEncoded = encodePowerShell(script);
  const outerScript = [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${innerEncoded}')`,
    `Start-Process -FilePath '${powershellPath.replaceAll("'", "''")}' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments | Out-Null`
  ].join('\r\n');

  const emitter = new EventEmitter() as EventEmitter & ManagedElevatedProcess;
  const server = createServer();
  let socket: Socket | undefined;
  let settled = false;
  let killed = false;
  let connected = false;
  let received = '';
  const timeout = setTimeout(() => fail(new Error('等待管理员授权超时')), 60_000);
  timeout.unref();

  const closeTransport = () => {
    clearTimeout(timeout);
    socket?.destroy();
    try {
      server.close();
    } catch {
      // The server may fail before it begins listening.
    }
  };
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    closeTransport();
    emitter.emit('exit', code, null);
  };
  function fail(error: Error) {
    if (settled) return;
    settled = true;
    closeTransport();
    emitter.emit('error', error);
  }
  const sendInitialRequest = (nextSocket: Socket) => {
    nextSocket.write(
      `${JSON.stringify({
        canceled: killed,
        config:
          typeof options.mihomoConfig === 'string'
            ? Buffer.from(options.mihomoConfig, 'utf8').toString('base64')
            : undefined
      })}\n`
    );
    if (killed) nextSocket.write('STOP\n');
  };
  const handleLine = (line: string) => {
    if (line.startsWith('READY:')) return;
    if (line.startsWith('EXIT:')) {
      finish(Number(line.slice('EXIT:'.length)));
      return;
    }
    if (line.startsWith('ERROR:')) {
      const encoded = line.slice('ERROR:'.length);
      const message = Buffer.from(encoded, 'base64').toString('utf8') || '管理员操作失败';
      fail(new Error(message));
    }
  };

  server.on('connection', (nextSocket) => {
    if (connected) {
      nextSocket.destroy();
      return;
    }
    connected = true;
    socket = nextSocket;
    sendInitialRequest(nextSocket);
    nextSocket.setEncoding('utf8');
    nextSocket.on('data', (chunk) => {
      received += chunk;
      const lines = received.split(/\r?\n/);
      received = lines.pop() ?? '';
      lines.filter(Boolean).forEach(handleLine);
    });
    nextSocket.once('error', (error) => fail(error));
    nextSocket.once('close', () => {
      if (!settled) fail(new Error('管理员操作连接已关闭'));
    });
  });
  server.once('error', fail);
  server.listen(pipePath, () => {
    const launcher = spawn(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(outerScript)],
      { windowsHide: true, stdio: 'ignore' }
    );
    launcher.once('error', fail);
    launcher.once('exit', (code) => {
      if (!connected && code && code !== 0) fail(new Error('需要管理员权限才能继续'));
    });
  });

  Object.defineProperty(emitter, 'killed', { get: () => killed });
  emitter.kill = () => {
    if (settled || killed) return false;
    killed = true;
    if (connected) socket?.write('STOP\n');
    return true;
  };
  return emitter;
}

export async function runWindowsElevatedProcess(
  binaryPath: string,
  args: string[],
  options: Omit<ElevatedProcessOptions, 'mihomoConfig'> = {}
): Promise<void> {
  options.signal?.throwIfAborted();
  const elevated = spawnWindowsElevatedProcess(binaryPath, args, options);
  const abort = () => elevated.kill();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      elevated.once('error', reject);
      elevated.once('exit', (code) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (code === 0) resolve();
        else reject(new Error(`管理员操作失败: ${code ?? 'unknown'}`));
      });
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
