import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import {
  createUpdateInstallerHandoffArguments,
  resolveUpdateInstallerHandoffAcknowledgementPath,
  type UpdateInstallerHandoffLease
} from './updateInstallHandoff';

export const updateInstallerLauncherPayloadEnvironment = 'YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD';
export const updateInstallerAcknowledgementTimeoutMs = 30_000;
export const updateInstallerAcknowledgementPollIntervalMs = 100;

type SpawnLauncher = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv }
) => ChildProcess;

type DownloadedInstallerPathSource = {
  downloadedPaths?: readonly unknown[];
  updaterInstallerPath?: unknown;
};

type UpdateInstallerLaunchOptions = {
  installerPath: string;
  handoff: UpdateInstallerHandoffLease;
  environment?: NodeJS.ProcessEnv;
  powershellPath?: string;
  spawnLauncher?: SpawnLauncher;
};

export function resolveDownloadedUpdateInstallerPath(source: DownloadedInstallerPathSource): string {
  const candidates = [...(source.downloadedPaths ?? []), source.updaterInstallerPath];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (!normalized || normalized.includes('\0') || !win32.isAbsolute(normalized)) continue;
    if (win32.extname(normalized).toLowerCase() !== '.exe') continue;
    return win32.normalize(normalized);
  }
  throw new Error('downloaded update installer path is unavailable');
}

export function resolveWindowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const root = (systemRoot ?? 'C:\\Windows').trim();
  if (!root || root.includes('\0') || !win32.isAbsolute(root)) {
    throw new Error('Windows system root path is invalid');
  }
  return win32.join(win32.normalize(root), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function createUpdateInstallerLauncherScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$payloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD))',
    '$payload = $payloadText | ConvertFrom-Json',
    "if ($null -eq $payload -or @($payload.PSObject.Properties.Name).Count -ne 4 -or $payload.PSObject.Properties.Name -notcontains 'installerPath' -or $payload.PSObject.Properties.Name -notcontains 'arguments' -or $payload.PSObject.Properties.Name -notcontains 'acknowledgement' -or $payload.PSObject.Properties.Name -notcontains 'acknowledgementTimeoutMs') { throw 'update installer launch payload is invalid' }",
    '$installerPath = [string] $payload.installerPath',
    "if ([string]::IsNullOrWhiteSpace($installerPath) -or $installerPath.IndexOf([char] 0) -ge 0 -or -not [IO.Path]::IsPathFullyQualified($installerPath) -or [IO.Path]::GetExtension($installerPath) -ine '.exe') { throw 'update installer path is invalid' }",
    '$installerPath = [IO.Path]::GetFullPath($installerPath)',
    '[string[]] $arguments = @($payload.arguments)',
    "if ($arguments.Count -ne 11) { throw 'update installer arguments are invalid' }",
    "if ($arguments[0] -cne '--updated' -or $arguments[1] -cne '/S' -or $arguments[2] -cne '--force-run') { throw 'update installer arguments are invalid' }",
    "if ($arguments[3] -cne '--youyu-handoff-path' -or $arguments[4].IndexOf([char] 0) -ge 0 -or $arguments[4].Length -eq 0 -or $arguments[5] -cne '--youyu-handoff-nonce' -or $arguments[6] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $arguments[7] -cne '--youyu-target-user-sid' -or $arguments[8] -notmatch '^S-1-\\d+(?:-\\d+){2,14}$' -or $arguments[9] -cne '--youyu-target-session-id' -or $arguments[10] -notmatch '^[1-9]\\d*$') { throw 'update installer handoff arguments are invalid' }",
    '$handoffPath = [IO.Path]::GetFullPath([string] $arguments[4])',
    '$acknowledgement = $payload.acknowledgement',
    "if ($null -eq $acknowledgement -or @($acknowledgement.PSObject.Properties.Name).Count -ne 7 -or $acknowledgement.PSObject.Properties.Name -notcontains 'path' -or $acknowledgement.PSObject.Properties.Name -notcontains 'handoffPath' -or $acknowledgement.PSObject.Properties.Name -notcontains 'nonce' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetUserSid' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetSessionId' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetProcessId' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetExecutablePath') { throw 'update acknowledgement payload is invalid' }",
    '$acknowledgementPath = [string] $acknowledgement.path',
    "if ([string]::IsNullOrWhiteSpace($acknowledgementPath) -or $acknowledgementPath.IndexOf([char] 0) -ge 0 -or -not [IO.Path]::IsPathFullyQualified($acknowledgementPath)) { throw 'update acknowledgement path is invalid' }",
    '$acknowledgementPath = [IO.Path]::GetFullPath($acknowledgementPath)',
    "$expectedAcknowledgementPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-handoff-' + $arguments[6] + '.ready.json'))",
    '$targetExecutablePath = [string] $acknowledgement.targetExecutablePath',
    "if ([string]::IsNullOrWhiteSpace($targetExecutablePath) -or $targetExecutablePath.IndexOf([char] 0) -ge 0 -or -not [IO.Path]::IsPathFullyQualified($targetExecutablePath) -or [IO.Path]::GetExtension($targetExecutablePath) -ine '.exe') { throw 'update acknowledgement executable path is invalid' }",
    '$targetExecutablePath = [IO.Path]::GetFullPath($targetExecutablePath)',
    "if ($acknowledgementPath -ine $expectedAcknowledgementPath -or ([IO.Path]::GetFullPath([string] $acknowledgement.handoffPath)) -ine $handoffPath -or ([string] $acknowledgement.nonce).ToLowerInvariant() -cne $arguments[6] -or ([string] $acknowledgement.targetUserSid).ToUpperInvariant() -cne $arguments[8].ToUpperInvariant() -or ([string] $acknowledgement.targetSessionId) -cne $arguments[10] -or ([string] $acknowledgement.targetProcessId) -notmatch '^[1-9]\\d*$') { throw 'update acknowledgement payload does not match its handoff' }",
    "if ([string] $payload.acknowledgementTimeoutMs -notmatch '^[1-9]\\d*$') { throw 'update acknowledgement timeout is invalid' }",
    '$acknowledgementTimeoutMs = [Convert]::ToInt64($payload.acknowledgementTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "if ($acknowledgementTimeoutMs -le 0 -or $acknowledgementTimeoutMs -gt 60000) { throw 'update acknowledgement timeout is invalid' }",
    'function ConvertTo-WindowsCommandLineArgument([string] $value, [bool] $forceQuote) {',
    '  if ($value.Length -eq 0) { return \'""\' }',
    "  if (-not $forceQuote -and $value -notmatch '[\\s\"]') { return $value }",
    "  $escaped = [Text.RegularExpressions.Regex]::Replace($value, '(\\\\*)\"', '$1$1\\\"')",
    "  $escaped = [Text.RegularExpressions.Regex]::Replace($escaped, '(\\\\*)$', '$1$1')",
    "  return '\"' + $escaped + '\"'",
    '}',
    'function Test-AuthenticatedUpdateAcknowledgement([string] $path, [string] $expectedHandoffPath, [string] $expectedNonce, [string] $expectedUserSid, [string] $expectedSessionId, [string] $expectedProcessId, [string] $expectedExecutablePath) {',
    '  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }',
    '  try {',
    '    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
    '    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 4096) { return $false }',
    '    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
    '    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '    if ($ownerSid -cne $expectedUserSid.ToUpperInvariant() -or -not $acl.AreAccessRulesProtected) { return $false }',
    '    $rules = @($acl.Access)',
    '    if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '    $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '    $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '    if ($ruleSid -cne $expectedUserSid.ToUpperInvariant() -or (([int64] $rules[0].FileSystemRights) -band $fullControl) -ne $fullControl) { return $false }',
    '    $acknowledgement = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json',
    "    $required = @('version', 'nonce', 'handoffPath', 'targetUserSid', 'targetSessionId', 'targetProcessId', 'executablePath', 'acknowledgedAtEpochMs', 'expiresAtEpochMs')",
    '    if ($null -eq $acknowledgement -or @($acknowledgement.PSObject.Properties.Name).Count -ne $required.Count) { return $false }',
    '    foreach ($property in $required) { if ($acknowledgement.PSObject.Properties.Name -notcontains $property) { return $false } }',
    "    if ([string] $acknowledgement.version -cne '1' -or ([string] $acknowledgement.nonce).ToLowerInvariant() -cne $expectedNonce -or ([IO.Path]::GetFullPath([string] $acknowledgement.handoffPath)) -ine $expectedHandoffPath -or ([string] $acknowledgement.targetUserSid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant() -or ([string] $acknowledgement.targetSessionId) -cne $expectedSessionId -or ([string] $acknowledgement.targetProcessId) -cne $expectedProcessId -or ([IO.Path]::GetFullPath([string] $acknowledgement.executablePath)) -ine $expectedExecutablePath) { return $false }",
    "    if ([string] $acknowledgement.targetProcessId -notmatch '^[1-9]\\d*$' -or [string]::IsNullOrWhiteSpace([string] $acknowledgement.executablePath) -or -not [IO.Path]::IsPathFullyQualified([string] $acknowledgement.executablePath) -or [string] $acknowledgement.acknowledgedAtEpochMs -notmatch '^\\d+$' -or [string] $acknowledgement.expiresAtEpochMs -notmatch '^\\d+$') { return $false }",
    '    $acknowledgedAt = [Convert]::ToInt64($acknowledgement.acknowledgedAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '    $expiresAt = [Convert]::ToInt64($acknowledgement.expiresAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '    if ($acknowledgedAt -le 0 -or $acknowledgedAt -gt ($now + 60000L) -or $expiresAt -lt $now -or $expiresAt -lt $acknowledgedAt -or ($expiresAt - $acknowledgedAt) -gt 900000L) { return $false }',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    "$argumentLine = [string]::Join(' ', @(for ($index = 0; $index -lt $arguments.Count; $index += 1) { ConvertTo-WindowsCommandLineArgument ([string] $arguments[$index]) (($index -ge 4) -and (($index % 2) -eq 0)) }))",
    '$started = Start-Process -FilePath $installerPath -ArgumentList $argumentLine -Verb RunAs -WindowStyle Hidden -PassThru',
    "if ($null -eq $started -or [int] $started.Id -le 0) { throw 'elevated update installer did not start' }",
    '[void] $started.WaitForExit(750)',
    "if ($started.HasExited) { throw 'elevated update installer exited before the app handoff completed' }",
    '$acknowledgementDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($acknowledgementTimeoutMs)',
    'while ($true) {',
    "  if ($started.HasExited) { throw 'elevated update installer exited before acknowledging the authenticated handoff' }",
    '  if (Test-AuthenticatedUpdateAcknowledgement $acknowledgementPath $handoffPath $arguments[6] $arguments[8] $arguments[10] ([string] $acknowledgement.targetProcessId) $targetExecutablePath) {',
    '    Start-Sleep -Milliseconds 150',
    "    if ($started.HasExited) { throw 'elevated update installer exited after acknowledging the authenticated handoff' }",
    '    break',
    '  }',
    "  if ([DateTimeOffset]::UtcNow -ge $acknowledgementDeadline) { throw 'elevated update installer did not acknowledge the authenticated handoff in time' }",
    `  Start-Sleep -Milliseconds ${updateInstallerAcknowledgementPollIntervalMs}`,
    '}'
  ].join('\n');
}

export async function launchDownloadedUpdateInstaller(options: UpdateInstallerLaunchOptions): Promise<void> {
  const installerPath = resolveDownloadedUpdateInstallerPath({ downloadedPaths: [options.installerPath] });
  const handoffArguments = createUpdateInstallerHandoffArguments(options.handoff);
  const acknowledgementPath = resolveUpdateInstallerHandoffAcknowledgementPath(options.handoff);
  const payload = Buffer.from(
    JSON.stringify({
      installerPath,
      arguments: ['--updated', '/S', '--force-run', ...handoffArguments],
      acknowledgement: {
        path: acknowledgementPath,
        handoffPath: handoffArguments[1],
        nonce: handoffArguments[3],
        targetUserSid: handoffArguments[5],
        targetSessionId: handoffArguments[7],
        targetProcessId: options.handoff.targetProcessId,
        targetExecutablePath: options.handoff.targetExecutablePath
      },
      acknowledgementTimeoutMs: updateInstallerAcknowledgementTimeoutMs
    }),
    'utf8'
  ).toString('base64');
  const environment = {
    ...(options.environment ?? process.env),
    [updateInstallerLauncherPayloadEnvironment]: payload
  };
  const powershellPath = options.powershellPath ?? resolveWindowsPowerShellPath(options.environment?.SystemRoot);
  const launcher = (options.spawnLauncher ?? spawn)(
    powershellPath,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(createUpdateInstallerLauncherScript(), 'utf16le').toString('base64')
    ],
    { windowsHide: true, stdio: 'ignore', env: environment }
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    launcher.once('error', (error) => finish(() => reject(error)));
    launcher.once('exit', (code, signal) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const detail = code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : 'unknown exit state';
      finish(() => reject(new Error(`elevated update installer launch failed (${detail})`)));
    });
  });
}
