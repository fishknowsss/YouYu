import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join, win32 } from 'node:path';
import {
  normalizeWindowsUserSid,
  resolveCurrentWindowsUserIdentity,
  type WindowsUserIdentity
} from './windowsUserIdentity';
import {
  encodeCompressedPowerShellCommand,
  windowsJobCreationPowerShell,
  windowsJobNativeTypePowerShell
} from './windowsJobProcess';

export { encodeCompressedPowerShellCommand } from './windowsJobProcess';

export const ELEVATED_PIPE_PROTOCOL_VERSION = 1;
export const ELEVATED_PIPE_CONTROL_MAX_BYTES = 64 * 1024;
export const ELEVATED_PIPE_CONFIG_MAX_BYTES = 12 * 1024 * 1024;
export const ELEVATED_PIPE_START_MAX_BYTES = 18 * 1024 * 1024;

const challengeByteLength = 32;
const defaultAuthorizationTimeoutMs = 60_000;
const defaultHandshakeTimeoutMs = 10_000;
const defaultStartTimeoutMs = 30_000;

export type ManagedElevatedProcess = {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  kill: () => unknown;
  killed: boolean;
};

export type ElevatedPipeBinding = {
  operationId: string;
  targetUserSid: string;
  targetSessionId: number;
  parentPid: number;
  parentExecutablePath: string;
  binaryPath: string;
};

type ElevatedPipeClientState =
  'awaiting-server-challenge' | 'awaiting-server-authentication' | 'awaiting-ready' | 'running' | 'exited' | 'failed';

type ElevatedPipeMessage = Record<string, unknown>;

type ElevatedProcessOptions = {
  parentPid?: number;
  parentExecutablePath?: string;
  pollIntervalMs?: number;
  mihomoConfig?: string;
  signal?: AbortSignal;
  authorizationTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  startTimeoutMs?: number;
  resolveUserIdentity?: (processId: number) => Promise<WindowsUserIdentity>;
  spawnLauncher?: typeof spawn;
  createPipeConnection?: (pipePath: string) => Socket;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], scope: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${scope} protocol properties are invalid`);
  }
}

function assertChallenge(value: unknown, scope: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${scope} protocol challenge is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== challengeByteLength || decoded.toString('base64url') !== value) {
    throw new Error(`${scope} protocol challenge is invalid`);
  }
}

function assertBinding(value: unknown, expected: ElevatedPipeBinding): asserts value is ElevatedPipeBinding {
  if (!isRecord(value)) throw new Error('elevated protocol binding is invalid');
  assertExactKeys(
    value,
    ['operationId', 'targetUserSid', 'targetSessionId', 'parentPid', 'parentExecutablePath', 'binaryPath'],
    'elevated binding'
  );
  for (const key of [
    'operationId',
    'targetUserSid',
    'targetSessionId',
    'parentPid',
    'parentExecutablePath',
    'binaryPath'
  ] as const) {
    if (value[key] !== expected[key]) throw new Error(`elevated protocol binding mismatch: ${key}`);
  }
}

function assertEnvelope(
  value: unknown,
  input: {
    expectedKind: string;
    binding: ElevatedPipeBinding;
    keys: string[];
    clientChallenge?: string;
    serverChallenge?: string;
  }
): asserts value is ElevatedPipeMessage {
  if (!isRecord(value)) throw new Error('elevated protocol message is invalid');
  assertExactKeys(value, input.keys, `elevated ${input.expectedKind}`);
  if (value.version !== ELEVATED_PIPE_PROTOCOL_VERSION) throw new Error('elevated protocol version mismatch');
  if (value.kind !== input.expectedKind) throw new Error(`elevated protocol kind mismatch: ${input.expectedKind}`);
  assertBinding(value.binding, input.binding);
  if (input.clientChallenge !== undefined && value.clientChallenge !== input.clientChallenge) {
    throw new Error('elevated protocol client proof mismatch');
  }
  if (input.serverChallenge !== undefined && value.serverChallenge !== input.serverChallenge) {
    throw new Error('elevated protocol server proof mismatch');
  }
}

function authenticatedEnvelope(
  kind: string,
  binding: ElevatedPipeBinding,
  clientChallenge: string,
  serverChallenge: string
): ElevatedPipeMessage {
  return {
    version: ELEVATED_PIPE_PROTOCOL_VERSION,
    kind,
    binding,
    clientChallenge,
    serverChallenge
  };
}

function validateBinding(binding: ElevatedPipeBinding): ElevatedPipeBinding {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.operationId)) {
    throw new Error('invalid elevated operation id');
  }
  const normalizedSid = normalizeWindowsUserSid(binding.targetUserSid);
  if (normalizedSid !== binding.targetUserSid) throw new Error('invalid elevated target user SID');
  if (!Number.isSafeInteger(binding.targetSessionId) || binding.targetSessionId <= 0) {
    throw new Error('invalid elevated target session');
  }
  if (!Number.isSafeInteger(binding.parentPid) || binding.parentPid <= 0) {
    throw new Error('invalid elevated parent process id');
  }
  for (const [scope, value] of [
    ['parent executable', binding.parentExecutablePath],
    ['target binary', binding.binaryPath]
  ] as const) {
    if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 32_768) {
      throw new Error(`invalid elevated ${scope} path`);
    }
  }
  return binding;
}

export function createElevatedPipeChallenge(randomBytesSource: (size: number) => Buffer = randomBytes): string {
  const bytes = randomBytesSource(challengeByteLength);
  if (!Buffer.isBuffer(bytes) || bytes.length !== challengeByteLength) {
    throw new Error('elevated protocol entropy source returned an invalid challenge');
  }
  return bytes.toString('base64url');
}

export class ElevatedPipeFrameDecoder {
  private buffered = Buffer.alloc(0);
  private decodedFrames = 0;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly maxFrames = 8
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new Error('invalid elevated frame byte limit');
    }
    if (!Number.isSafeInteger(maxFrames) || maxFrames <= 0) {
      throw new Error('invalid elevated frame count limit');
    }
  }

  push(chunk: Buffer): unknown[] {
    if (!Buffer.isBuffer(chunk)) throw new Error('invalid elevated pipe data');
    const remainingFrames = this.maxFrames - this.decodedFrames;
    if (remainingFrames <= 0 && chunk.length > 0) throw new Error('unexpected elevated protocol frame');
    const transportLimit = Math.max(0, remainingFrames) * (this.maxFrameBytes + 4);
    if (this.buffered.length + chunk.length > transportLimit) {
      throw new Error('elevated protocol transport exceeds byte limit');
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      if (this.decodedFrames >= this.maxFrames) throw new Error('unexpected elevated protocol frame');
      const length = this.buffered.readUInt32LE(0);
      if (length <= 0 || length > this.maxFrameBytes) {
        throw new Error('elevated protocol frame exceeds byte limit');
      }
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        throw new Error('invalid elevated protocol JSON frame', { cause: error });
      }
      this.decodedFrames += 1;
      messages.push(parsed);
      if (this.decodedFrames >= this.maxFrames && this.buffered.length > 0) {
        throw new Error('unexpected elevated protocol trailing bytes');
      }
    }
    return messages;
  }
}

export function encodeElevatedPipeFrame(value: unknown, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length <= 0 || payload.length > maxFrameBytes) {
    throw new Error('elevated protocol frame exceeds byte limit');
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

export function createElevatedPipeClientProtocol(input: {
  binding: ElevatedPipeBinding;
  clientChallenge: string;
  canceled: boolean | (() => boolean);
  mihomoConfig?: string;
}) {
  const binding = validateBinding(input.binding);
  assertChallenge(input.clientChallenge, 'client');
  if (
    typeof input.mihomoConfig === 'string' &&
    Buffer.byteLength(input.mihomoConfig, 'utf8') > ELEVATED_PIPE_CONFIG_MAX_BYTES
  ) {
    throw new Error('mihomo config exceeds elevated protocol byte limit');
  }
  let state: ElevatedPipeClientState = 'awaiting-server-challenge';
  let serverChallenge: string | undefined;
  const isCanceled = typeof input.canceled === 'function' ? input.canceled : () => input.canceled;

  const fail = (error: unknown): never => {
    state = 'failed';
    throw asError(error, 'elevated protocol failure');
  };

  return {
    get state(): ElevatedPipeClientState {
      return state;
    },
    receive(value: unknown): ElevatedPipeMessage | { code: number } | undefined {
      try {
        if (state === 'awaiting-server-challenge') {
          assertEnvelope(value, {
            expectedKind: 'server-challenge',
            binding,
            keys: ['version', 'kind', 'binding', 'serverChallenge']
          });
          assertChallenge(value.serverChallenge, 'server');
          if (value.serverChallenge === input.clientChallenge) {
            throw new Error('elevated protocol challenges must be independent');
          }
          serverChallenge = value.serverChallenge;
          state = 'awaiting-server-authentication';
          return authenticatedEnvelope('client-authenticate', binding, input.clientChallenge, serverChallenge);
        }

        if (state === 'awaiting-server-authentication') {
          if (!isRecord(value) || !['server-authenticated', 'error'].includes(String(value.kind))) {
            throw new Error(`unexpected elevated protocol message in state ${state}`);
          }
          if (isRecord(value) && value.kind === 'error') {
            assertEnvelope(value, {
              expectedKind: 'error',
              binding,
              keys: ['version', 'kind', 'binding', 'clientChallenge', 'serverChallenge', 'message'],
              clientChallenge: input.clientChallenge,
              serverChallenge
            });
            if (typeof value.message !== 'string') throw new Error('elevated protocol error is invalid');
            throw new Error(Buffer.from(value.message, 'base64').toString('utf8') || '管理员操作失败');
          }
          assertEnvelope(value, {
            expectedKind: 'server-authenticated',
            binding,
            keys: ['version', 'kind', 'binding', 'clientChallenge', 'serverChallenge'],
            clientChallenge: input.clientChallenge,
            serverChallenge
          });
          const request = authenticatedEnvelope('start', binding, input.clientChallenge, serverChallenge as string);
          request.canceled = isCanceled();
          if (typeof input.mihomoConfig === 'string') {
            request.config = Buffer.from(input.mihomoConfig, 'utf8').toString('base64');
          }
          state = 'awaiting-ready';
          return request;
        }

        if (state === 'awaiting-ready' || state === 'running') {
          if (isRecord(value) && value.kind === 'error') {
            assertEnvelope(value, {
              expectedKind: 'error',
              binding,
              keys: ['version', 'kind', 'binding', 'clientChallenge', 'serverChallenge', 'message'],
              clientChallenge: input.clientChallenge,
              serverChallenge
            });
            if (typeof value.message !== 'string') throw new Error('elevated protocol error is invalid');
            throw new Error(Buffer.from(value.message, 'base64').toString('utf8') || '管理员操作失败');
          }
          if (isRecord(value) && value.kind === 'exit') {
            assertEnvelope(value, {
              expectedKind: 'exit',
              binding,
              keys: ['version', 'kind', 'binding', 'clientChallenge', 'serverChallenge', 'code'],
              clientChallenge: input.clientChallenge,
              serverChallenge
            });
            if (!Number.isSafeInteger(value.code)) throw new Error('elevated protocol exit code is invalid');
            state = 'exited';
            return { code: Number(value.code) };
          }
          if (state !== 'awaiting-ready') throw new Error(`unexpected elevated protocol message in state ${state}`);
          assertEnvelope(value, {
            expectedKind: 'ready',
            binding,
            keys: ['version', 'kind', 'binding', 'clientChallenge', 'serverChallenge', 'pid'],
            clientChallenge: input.clientChallenge,
            serverChallenge
          });
          if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
            throw new Error('elevated protocol process id is invalid');
          }
          state = 'running';
          return undefined;
        }

        throw new Error(`unexpected elevated protocol message in state ${state}`);
      } catch (error) {
        return fail(error);
      }
    },
    createStopMessage(): ElevatedPipeMessage {
      if (!serverChallenge || (state !== 'awaiting-ready' && state !== 'running')) {
        return fail(new Error(`cannot stop elevated process in state ${state}`));
      }
      return authenticatedEnvelope('stop', binding, input.clientChallenge, serverChallenge);
    }
  };
}

export function buildElevatedProcessScript(input: {
  binaryPath: string;
  args: string[];
  pipeName: string;
  binding: ElevatedPipeBinding;
  clientChallenge: string;
  pollIntervalMs: number;
  receivesMihomoConfig: boolean;
}): string {
  const binding = validateBinding(input.binding);
  assertChallenge(input.clientChallenge, 'client');
  if (!/^[A-Za-z0-9-]{1,180}$/.test(input.pipeName)) throw new Error('invalid elevated pipe name');
  const pollIntervalMs = Math.max(100, Math.floor(input.pollIntervalMs));
  const encodedArgs = encodeUtf8(JSON.stringify(input.args));
  const encodedBinding = encodeUtf8(JSON.stringify(binding));
  return [
    "$ErrorActionPreference = 'Stop'",
    '$process = $null',
    '$pipe = $null',
    '$secureWorkDir = $null',
    '$jobHandle = [IntPtr]::Zero',
    '$stopCancellation = $null',
    '$authenticated = $false',
    ...windowsJobNativeTypePowerShell(),
    '$decode = { param([string]$value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }',
    `$binary = & $decode '${encodeUtf8(input.binaryPath)}'`,
    `[string[]] $arguments = ConvertFrom-Json (& $decode '${encodedArgs}')`,
    `$expectedBinding = ConvertFrom-Json (& $decode '${encodedBinding}')`,
    `$clientChallenge = & $decode '${encodeUtf8(input.clientChallenge)}'`,
    `function Assert-ExactProperties($value, [string[]] $expected, [string] $scope) {`,
    "  if ($null -eq $value) { throw ($scope + ' protocol value is missing') }",
    '  [string[]] $actual = @($value.PSObject.Properties.Name | Sort-Object)',
    '  [string[]] $sortedExpected = @($expected | Sort-Object)',
    "  if (($actual.Count -ne $sortedExpected.Count) -or ([string]::Join('|', $actual) -cne [string]::Join('|', $sortedExpected))) {",
    "    throw ($scope + ' protocol properties are invalid')",
    '  }',
    '}',
    'function Assert-ProtocolBinding($actual) {',
    "  Assert-ExactProperties $actual @('operationId', 'targetUserSid', 'targetSessionId', 'parentPid', 'parentExecutablePath', 'binaryPath') 'binding'",
    "  foreach ($name in @('operationId', 'targetUserSid', 'targetSessionId', 'parentPid', 'parentExecutablePath', 'binaryPath')) {",
    "    if ($actual.$name -cne $expectedBinding.$name) { throw ('protocol binding mismatch: ' + $name) }",
    '  }',
    '}',
    'function Assert-AuthenticatedMessage($message, [string] $kind, [string[]] $properties) {',
    "  Assert-ExactProperties $message $properties ('message ' + $kind)",
    `  if ([int] $message.version -ne ${ELEVATED_PIPE_PROTOCOL_VERSION}) { throw 'protocol version mismatch' }`,
    "  if ([string] $message.kind -cne $kind) { throw 'protocol state mismatch' }",
    '  Assert-ProtocolBinding $message.binding',
    "  if ([string] $message.clientChallenge -cne $clientChallenge) { throw 'client challenge mismatch' }",
    "  if ([string] $message.serverChallenge -cne $serverChallenge) { throw 'server challenge mismatch' }",
    '}',
    'function Write-Frame($stream, $message, [int] $maxBytes) {',
    '  $json = $message | ConvertTo-Json -Depth 8 -Compress',
    '  [byte[]] $payload = [Text.UTF8Encoding]::new($false, $true).GetBytes($json)',
    "  if (($payload.Length -le 0) -or ($payload.Length -gt $maxBytes)) { throw 'named-pipe frame exceeds byte limit' }",
    '  [byte[]] $header = [BitConverter]::GetBytes([int] $payload.Length)',
    '  $stream.Write($header, 0, $header.Length)',
    '  $stream.Write($payload, 0, $payload.Length)',
    '  $stream.Flush()',
    '}',
    'function Read-FrameWithTimeout($stream, [int] $maxBytes, [int] $timeoutMilliseconds) {',
    '  $json = [YouYu.WindowsJobNative]::ReadFrameWithTimeout($stream, $maxBytes, $timeoutMilliseconds)',
    '  return ($json | ConvertFrom-Json)',
    '}',
    'function New-ServerChallenge {',
    '  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()',
    '  try {',
    '    do {',
    `      [byte[]] $bytes = [byte[]]::new(${challengeByteLength})`,
    '      $rng.GetBytes($bytes)',
    "      $candidate = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')",
    '    } while ($candidate -ceq $clientChallenge)',
    '    return $candidate',
    '  } finally {',
    '    $rng.Dispose()',
    '  }',
    '}',
    'function Normalize-BoundPath([string] $value) {',
    "  return [IO.Path]::GetFullPath($value).TrimEnd('\\')",
    '}',
    'function Assert-ParentIdentity {',
    `  $parent = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${binding.parentPid}' -ErrorAction Stop`,
    "  if ($null -eq $parent) { throw 'bound parent process is unavailable' }",
    "  if ([int] $parent.SessionId -ne [int] $expectedBinding.targetSessionId) { throw 'bound parent session mismatch' }",
    "  if ((Normalize-BoundPath ([string] $parent.ExecutablePath)) -ine (Normalize-BoundPath ([string] $expectedBinding.parentExecutablePath))) { throw 'bound parent executable mismatch' }",
    '  $owner = Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -ErrorAction Stop',
    "  if (($owner.ReturnValue -ne 0) -or ([string] $owner.Sid -ine [string] $expectedBinding.targetUserSid)) { throw 'bound parent owner mismatch' }",
    "  if ((Normalize-BoundPath $binary) -ine (Normalize-BoundPath ([string] $expectedBinding.binaryPath))) { throw 'bound target binary mismatch' }",
    "  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'bound target binary is unavailable' }",
    '}',
    'try {',
    '  $pipeSecurity = [IO.Pipes.PipeSecurity]::new()',
    '  $pipeSecurity.SetAccessRuleProtection($true, $false)',
    '  $allow = [Security.AccessControl.AccessControlType]::Allow',
    `  $targetSid = [Security.Principal.SecurityIdentifier]::new('${binding.targetUserSid}')`,
    "  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
    "  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
    '  foreach ($sid in @($targetSid, $administratorsSid, $systemSid)) {',
    '    $rule = [IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, $allow)',
    '    $pipeSecurity.AddAccessRule($rule)',
    '  }',
    '  $pipeSecurity.SetOwner($administratorsSid)',
    '  $pipe = [IO.Pipes.NamedPipeServerStream]::new(',
    `    '${input.pipeName}',`,
    '    [IO.Pipes.PipeDirection]::InOut,',
    '    1,',
    '    [IO.Pipes.PipeTransmissionMode]::Byte,',
    '    [IO.Pipes.PipeOptions]::Asynchronous,',
    `    ${ELEVATED_PIPE_CONTROL_MAX_BYTES},`,
    `    ${ELEVATED_PIPE_CONTROL_MAX_BYTES},`,
    '    $pipeSecurity',
    '  )',
    '  $connectionTask = $pipe.WaitForConnectionAsync()',
    `  if (-not $connectionTask.Wait(${defaultAuthorizationTimeoutMs})) { throw 'named-pipe connection timed out' }`,
    '  $connectionTask.GetAwaiter().GetResult()',
    '  $serverChallenge = New-ServerChallenge',
    '  Write-Frame $pipe ([ordered]@{',
    `    version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "    kind = 'server-challenge'",
    '    binding = $expectedBinding',
    '    serverChallenge = $serverChallenge',
    `  }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    `  $authentication = Read-FrameWithTimeout $pipe ${ELEVATED_PIPE_CONTROL_MAX_BYTES} ${defaultHandshakeTimeoutMs}`,
    "  Assert-AuthenticatedMessage $authentication 'client-authenticate' @('version', 'kind', 'binding', 'clientChallenge', 'serverChallenge')",
    '  Assert-ParentIdentity',
    '  $authenticated = $true',
    '  Write-Frame $pipe ([ordered]@{',
    `    version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "    kind = 'server-authenticated'",
    '    binding = $expectedBinding',
    '    clientChallenge = $clientChallenge',
    '    serverChallenge = $serverChallenge',
    `  }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    `  $request = Read-FrameWithTimeout $pipe ${ELEVATED_PIPE_START_MAX_BYTES} ${defaultStartTimeoutMs}`,
    "  $startProperties = @('version', 'kind', 'binding', 'clientChallenge', 'serverChallenge', 'canceled')",
    "  if ($request.PSObject.Properties.Name -contains 'config') { $startProperties += 'config' }",
    "  Assert-AuthenticatedMessage $request 'start' $startProperties",
    '  if ([bool] $request.canceled) {',
    '    Write-Frame $pipe ([ordered]@{',
    `      version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "      kind = 'exit'",
    '      binding = $expectedBinding',
    '      clientChallenge = $clientChallenge',
    '      serverChallenge = $serverChallenge',
    '      code = 0',
    `    }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    '    return',
    '  }',
    ...(input.receivesMihomoConfig
      ? [
          "  if (($request.PSObject.Properties.Name -notcontains 'config') -or -not ($request.config -is [string])) { throw 'missing mihomo config' }",
          '  [byte[]] $configBytes = [Convert]::FromBase64String([string] $request.config)',
          `  if (($configBytes.Length -le 0) -or ($configBytes.Length -gt ${ELEVATED_PIPE_CONFIG_MAX_BYTES})) { throw 'mihomo config exceeds byte limit' }`,
          "  $baseDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'YouYu'",
          "  if ((Test-Path -LiteralPath $baseDir) -and ((Get-Item -LiteralPath $baseDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe ProgramData path' }",
          '  [IO.Directory]::CreateDirectory($baseDir) | Out-Null',
          '  $acl = [Security.AccessControl.DirectorySecurity]::new()',
          '  $acl.SetAccessRuleProtection($true, $false)',
          '  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
          '  $propagation = [Security.AccessControl.PropagationFlags]::None',
          '  $fileAllow = [Security.AccessControl.AccessControlType]::Allow',
          '  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $fileAllow))',
          '  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $fileAllow))',
          '  [IO.Directory]::SetAccessControl($baseDir, $acl)',
          `  $secureWorkDir = Join-Path $baseDir 'runtime-${binding.operationId}'`,
          "  if (Test-Path -LiteralPath $secureWorkDir) { throw 'secure runtime path already exists' }",
          '  [IO.Directory]::CreateDirectory($secureWorkDir) | Out-Null',
          '  [IO.Directory]::SetAccessControl($secureWorkDir, $acl)',
          "  $configPath = Join-Path $secureWorkDir 'config.yaml'",
          '  [IO.File]::WriteAllBytes($configPath, $configBytes)',
          "  $arguments = @('-d', $secureWorkDir, '-f', $configPath)"
        ]
      : ["  if ($request.PSObject.Properties.Name -contains 'config') { throw 'unexpected elevated config payload' }"]),
    ...windowsJobCreationPowerShell('  '),
    '  $nativeArguments = @($arguments | ForEach-Object { [YouYu.WindowsJobNative]::QuoteArgument([string] $_) })',
    "  $process = [YouYu.WindowsJobNative]::StartProcessSuspendedAndAssignToJobObject($jobHandle, $binary, ($nativeArguments -join ' '), $false)",
    '  Write-Frame $pipe ([ordered]@{',
    `    version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "    kind = 'ready'",
    '    binding = $expectedBinding',
    '    clientChallenge = $clientChallenge',
    '    serverChallenge = $serverChallenge',
    '    pid = $process.Id',
    `  }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    '  $stopCancellation = [Threading.CancellationTokenSource]::new()',
    `  $stopReadTask = [YouYu.WindowsJobNative]::ReadFrameAsync($pipe, ${ELEVATED_PIPE_CONTROL_MAX_BYTES}, $stopCancellation.Token)`,
    '  while (-not $process.HasExited) {',
    '    $stopRequested = $false',
    '    if ($stopReadTask.IsCompleted) {',
    '      $stopJson = $stopReadTask.GetAwaiter().GetResult()',
    '      $stopMessage = $stopJson | ConvertFrom-Json',
    "      Assert-AuthenticatedMessage $stopMessage 'stop' @('version', 'kind', 'binding', 'clientChallenge', 'serverChallenge')",
    '      $stopRequested = $true',
    '    }',
    `    $parentExited = -not (Get-Process -Id ${binding.parentPid} -ErrorAction SilentlyContinue)`,
    '    if ($parentExited -or $stopRequested) {',
    '      try { $process.Kill() } catch { }',
    '      break',
    '    }',
    `    Start-Sleep -Milliseconds ${pollIntervalMs}`,
    '    $process.Refresh()',
    '  }',
    '  $process.WaitForExit()',
    '  Write-Frame $pipe ([ordered]@{',
    `    version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "    kind = 'exit'",
    '    binding = $expectedBinding',
    '    clientChallenge = $clientChallenge',
    '    serverChallenge = $serverChallenge',
    '    code = $process.ExitCode',
    `  }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    '} catch {',
    '  if ($authenticated -and $pipe -and $pipe.IsConnected) {',
    '    try {',
    '      $encodedError = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))',
    '      Write-Frame $pipe ([ordered]@{',
    `        version = ${ELEVATED_PIPE_PROTOCOL_VERSION}`,
    "        kind = 'error'",
    '        binding = $expectedBinding',
    '        clientChallenge = $clientChallenge',
    '        serverChallenge = $serverChallenge',
    '        message = $encodedError',
    `      }) ${ELEVATED_PIPE_CONTROL_MAX_BYTES}`,
    '    } catch { }',
    '  }',
    '  throw',
    '} finally {',
    '  if ($stopCancellation) { $stopCancellation.Cancel(); $stopCancellation.Dispose() }',
    '  if ($process -and -not $process.HasExited) { try { $process.Kill() } catch { } }',
    '  if ($process) { $process.Dispose() }',
    '  if ($jobHandle -ne [IntPtr]::Zero) { [YouYu.WindowsJobNative]::CloseHandle($jobHandle) | Out-Null }',
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
  const emitter = new EventEmitter() as EventEmitter & ManagedElevatedProcess;
  let socket: Socket | undefined;
  let launcher: ChildProcess | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let stageTimer: NodeJS.Timeout | undefined;
  let authorizationTimer: NodeJS.Timeout | undefined;
  let launcherErrorListener: ((error: Error) => void) | undefined;
  let launcherExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let abortListener: (() => void) | undefined;
  let transportClosed = false;
  let settled = false;
  let killed = false;
  let connected = false;
  let protocol: ReturnType<typeof createElevatedPipeClientProtocol> | undefined;

  const closeTransport = () => {
    if (transportClosed) return;
    transportClosed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (stageTimer) {
      clearTimeout(stageTimer);
      stageTimer = undefined;
    }
    if (authorizationTimer) {
      clearTimeout(authorizationTimer);
      authorizationTimer = undefined;
    }

    const activeSocket = socket;
    socket = undefined;
    if (activeSocket && !activeSocket.destroyed) activeSocket.destroy();

    const activeLauncher = launcher;
    launcher = undefined;
    if (activeLauncher && launcherErrorListener) {
      activeLauncher.removeListener('error', launcherErrorListener);
    }
    if (activeLauncher && launcherExitListener) {
      activeLauncher.removeListener('exit', launcherExitListener);
    }
    launcherErrorListener = undefined;
    launcherExitListener = undefined;
    if (activeLauncher && activeLauncher.exitCode === null && !activeLauncher.killed) {
      try {
        activeLauncher.kill();
      } catch {
        // The launcher may have exited between the state check and termination request.
      }
    }

    if (abortListener) {
      options.signal?.removeEventListener('abort', abortListener);
      abortListener = undefined;
    }
  };
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    closeTransport();
    emitter.emit('exit', code, null);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    closeTransport();
    emitter.emit('error', asError(error, '管理员操作失败'));
  };
  const armStageTimeout = (milliseconds: number, message: string) => {
    if (stageTimer) clearTimeout(stageTimer);
    stageTimer = setTimeout(() => fail(new Error(message)), milliseconds);
    stageTimer.unref();
  };
  const sendMessage = (message: ElevatedPipeMessage) => {
    if (!socket || socket.destroyed) throw new Error('管理员操作连接不可用');
    const maxBytes = message.kind === 'start' ? ELEVATED_PIPE_START_MAX_BYTES : ELEVATED_PIPE_CONTROL_MAX_BYTES;
    socket.write(encodeElevatedPipeFrame(message, maxBytes));
  };

  Object.defineProperty(emitter, 'killed', { get: () => killed });
  emitter.kill = () => {
    if (settled || killed) return false;
    killed = true;
    if (!protocol || !['awaiting-ready', 'running'].includes(protocol.state)) {
      finish(0);
      return true;
    }
    try {
      sendMessage(protocol.createStopMessage());
    } catch (error) {
      fail(error);
    }
    return true;
  };

  const abort = () => {
    emitter.kill();
  };
  abortListener = abort;
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) queueMicrotask(abort);

  void (async () => {
    try {
      const parentPid = options.parentPid ?? process.pid;
      if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('invalid elevated parent process id');
      const identity = options.resolveUserIdentity
        ? await options.resolveUserIdentity(parentPid)
        : await resolveCurrentWindowsUserIdentity({ processId: parentPid });
      if (settled) return;
      if (killed) {
        finish(0);
        return;
      }
      const operationId = randomUUID();
      const pipeName = `youyu-elevated-${process.pid}-${operationId}`;
      const pipePath = `\\\\.\\pipe\\${pipeName}`;
      const binding = validateBinding({
        operationId,
        targetUserSid: identity.userSid.trim().toUpperCase(),
        targetSessionId: identity.sessionId,
        parentPid,
        parentExecutablePath: win32.resolve(options.parentExecutablePath ?? process.execPath),
        binaryPath: win32.resolve(binaryPath)
      });
      const clientChallenge = createElevatedPipeChallenge();
      protocol = createElevatedPipeClientProtocol({
        binding,
        clientChallenge,
        canceled: () => killed,
        mihomoConfig: options.mihomoConfig
      });
      const script = buildElevatedProcessScript({
        binaryPath: binding.binaryPath,
        args,
        pipeName,
        binding,
        clientChallenge,
        pollIntervalMs: options.pollIntervalMs ?? 250,
        receivesMihomoConfig: typeof options.mihomoConfig === 'string'
      });
      const powershellPath = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const innerEncoded = encodeCompressedPowerShellCommand(script);
      if (innerEncoded.length > 28_000) throw new Error('elevated helper exceeds the Windows command-line limit');
      const outerCommand = [
        '& {',
        'param([string] $innerEncoded)',
        "$ErrorActionPreference = 'Stop'",
        "$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $innerEncoded)",
        `$elevated = Start-Process -FilePath '${powershellPath.replaceAll("'", "''")}' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -PassThru -Wait`,
        'exit $elevated.ExitCode',
        '}'
      ].join(' ');
      const authorizationTimeoutMs = Math.max(1_000, options.authorizationTimeoutMs ?? defaultAuthorizationTimeoutMs);
      authorizationTimer = setTimeout(() => fail(new Error('等待管理员授权超时')), authorizationTimeoutMs);
      authorizationTimer.unref();

      launcher = (options.spawnLauncher ?? spawn)(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-Command', outerCommand, innerEncoded],
        { windowsHide: true, stdio: 'ignore' }
      );
      launcherErrorListener = fail;
      launcherExitListener = (code) => {
        if (!connected && !settled) {
          fail(new Error(code === 0 ? '管理员操作未建立安全连接' : '需要管理员权限才能继续'));
        }
      };
      launcher.once('error', launcherErrorListener);
      launcher.once('exit', launcherExitListener);

      const connect = () => {
        if (settled || connected) return;
        const candidate = (options.createPipeConnection ?? createConnection)(pipePath);
        socket = candidate;
        candidate.once('connect', () => {
          if (settled || connected) {
            if (socket === candidate) socket = undefined;
            if (!candidate.destroyed) candidate.destroy();
            return;
          }
          connected = true;
          socket = candidate;
          if (authorizationTimer) {
            clearTimeout(authorizationTimer);
            authorizationTimer = undefined;
          }
          const decoder = new ElevatedPipeFrameDecoder(ELEVATED_PIPE_CONTROL_MAX_BYTES, 4);
          armStageTimeout(
            Math.max(1_000, options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs),
            '管理员安全握手超时'
          );
          candidate.on('data', (chunk: Buffer) => {
            try {
              for (const message of decoder.push(chunk)) {
                const result = protocol?.receive(message);
                if (!result) {
                  if (protocol?.state === 'running') {
                    if (stageTimer) {
                      clearTimeout(stageTimer);
                      stageTimer = undefined;
                    }
                  }
                  continue;
                }
                if ('kind' in result) {
                  sendMessage(result);
                  if (result.kind === 'client-authenticate') {
                    armStageTimeout(
                      Math.max(1_000, options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs),
                      '管理员双向认证超时'
                    );
                  } else if (result.kind === 'start') {
                    armStageTimeout(
                      Math.max(1_000, options.startTimeoutMs ?? defaultStartTimeoutMs),
                      '管理员进程启动超时'
                    );
                  }
                } else {
                  if (typeof result.code !== 'number') throw new Error('管理员操作退出码无效');
                  finish(result.code);
                }
              }
            } catch (error) {
              fail(error);
            }
          });
          candidate.once('error', fail);
          candidate.once('close', () => {
            if (!settled) fail(new Error('管理员操作安全连接已关闭'));
          });
        });
        candidate.once('error', (error: NodeJS.ErrnoException) => {
          if (settled || connected) return;
          candidate.destroy();
          if (socket === candidate) socket = undefined;
          if (!['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(error.code ?? '')) {
            fail(error);
            return;
          }
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            connect();
          }, 100);
          retryTimer.unref();
        });
      };
      connect();
    } catch (error) {
      fail(error);
    }
  })();

  return emitter;
}

export async function runWindowsElevatedProcess(
  binaryPath: string,
  args: string[],
  options: Omit<ElevatedProcessOptions, 'mihomoConfig'> = {}
): Promise<void> {
  options.signal?.throwIfAborted();
  const elevated = spawnWindowsElevatedProcess(binaryPath, args, options);
  await new Promise<void>((resolve, reject) => {
    elevated.once('error', reject);
    elevated.once('exit', (code) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`管理员操作失败: ${code ?? 'unknown'}`));
    });
  });
}
