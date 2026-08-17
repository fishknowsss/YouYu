import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { win32 } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resumeProxyAfterRelaunchArgument, updateInstallFailedRelaunchArgument } from './appRelaunch';
import {
  createWindowsPowerShellEnvironment,
  resolveWindowsPowerShellPath,
  windowsPowerShellModuleAnalysisCacheEnvironment,
  windowsPowerShellModulePathEnvironment
} from './platform/windowsPowerShell';
import {
  createUpdateInstallerHandoffArguments,
  resolveUpdateInstallerCancellationPath,
  resolveUpdateInstallerHandoffAcknowledgementPath,
  updateInstallerHandoffEnvironment,
  type UpdateInstallerHandoffLease
} from './updateInstallHandoff';
import {
  updateRelaunchAcknowledgementNonceArgument,
  updateRelaunchAcknowledgementPathArgument
} from './updateRelaunchAcknowledgement';

export const updateInstallerLauncherPayloadEnvironment = 'YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD';
export const updateInstallerBootstrapPayloadEnvironment = 'YOUYU_UPDATE_INSTALLER_BOOTSTRAP_PAYLOAD';
export const updateInstallerBootstrapScriptEnvironment = 'YOUYU_UPDATE_INSTALLER_BOOTSTRAP_SCRIPT';
export const updateInstallerSupervisorScriptEnvironment = 'YOUYU_UPDATE_INSTALLER_SUPERVISOR_SCRIPT';
export const updateInstallerSupervisorLoaderEnvironment = 'YOUYU_UPDATE_INSTALLER_SUPERVISOR_LOADER';
export const updateInstallerAcknowledgementTimeoutMs = 30_000;
export const updateInstallerAcknowledgementPollIntervalMs = 100;
export const updateInstallerSupervisorReadyMessage = 'YOUYU_UPDATE_SUPERVISOR_READY';
export const updateInstallerSupervisorReadyTimeoutMs = 140_000;
export const updateInstallerBootstrapCleanupGraceMs = 40_000;
export const updateInstallerNodeCleanupMarginMs = 10_000;
export const updateInstallerExecutionTimeoutMs = 10 * 60 * 1000;
export const updateElevatedInstallerPayloadEnvironment = 'YOUYU_UPDATE_ELEVATED_INSTALL_PAYLOAD';
export const updateInstallerPowerShellModuleAnalysisCacheEnvironment = windowsPowerShellModuleAnalysisCacheEnvironment;
export const updateInstallerPowerShellModulePathEnvironment = windowsPowerShellModulePathEnvironment;

type SpawnLauncher = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; detached: boolean; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }
) => ChildProcess;

type DownloadedInstallerPathSource = {
  downloadedPaths?: readonly unknown[];
  updaterInstallerPath?: unknown;
};

type UpdateInstallerLaunchOptions = {
  installerPath: string;
  expectedVersion: string;
  resumeProxyAfterRelaunch: boolean;
  handoff: UpdateInstallerHandoffLease;
  environment?: NodeJS.ProcessEnv;
  powershellPath?: string;
  spawnLauncher?: SpawnLauncher;
  supervisorReadyTimeoutMs?: number;
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

export { resolveWindowsPowerShellPath } from './platform/windowsPowerShell';

export function resolveUpdateInstallerSupervisorReadyPath(
  handoff: Pick<UpdateInstallerHandoffLease, 'path' | 'nonce'>
): string {
  const acknowledgementPath = resolveUpdateInstallerHandoffAcknowledgementPath(handoff);
  return win32.join(
    win32.dirname(acknowledgementPath),
    `youyu-update-supervisor-${handoff.nonce.trim().toLowerCase()}.ready.json`
  );
}

export function signalUpdateInstallerCancellation(
  handoff: Pick<UpdateInstallerHandoffLease, 'path' | 'nonce' | 'targetUserSid'>,
  now = Date.now()
): boolean {
  if (!Number.isSafeInteger(now) || now <= 0) return false;
  const cancellationPath = resolveUpdateInstallerCancellationPath(handoff);
  const nonce = handoff.nonce.trim().toLowerCase();
  const targetUserSid = handoff.targetUserSid.trim().toUpperCase();
  if (!/^S-1-\d+(?:-\d+){2,14}$/.test(targetUserSid)) return false;
  const contents = Buffer.from(
    JSON.stringify({
      version: 1,
      nonce,
      targetUserSid,
      state: 'cancelled',
      updatedAtEpochMs: now
    }) + '\n',
    'utf8'
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(cancellationPath, 'r+');
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, contents, 0, contents.length, 0);
    fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Cancellation is best-effort only after the authenticated marker was opened.
      }
    }
  }
}

export function createElevatedUpdateInstallerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$cancellationPath = $null',
    '$installer = $null',
    '$installerBoundaryClosed = $false',
    'try {',
    '  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '  $payloadText = $null',
    '  if ($args.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace([string] $args[0])) {',
    '    $payloadPath = [string] $args[0]',
    "    if ($payloadPath.IndexOf([char] 0) -ge 0 -or $payloadPath -notmatch '^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)') { throw 'elevated installer payload file is invalid' }",
    '    $payloadPath = [IO.Path]::GetFullPath($payloadPath)',
    '    $payloadItem = Get-Item -LiteralPath $payloadPath -Force -ErrorAction Stop',
    "    if ($payloadItem.PSIsContainer -or ($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $payloadItem.Length -le 0 -or $payloadItem.Length -gt 4096) { throw 'elevated installer payload file is invalid' }",
    '    $payloadText = [IO.File]::ReadAllText($payloadPath, (New-Object Text.UTF8Encoding($false)))',
    '    Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue',
    '  } else {',
    `    $payloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${updateElevatedInstallerPayloadEnvironment}))`,
    `    Remove-Item Env:${updateElevatedInstallerPayloadEnvironment} -ErrorAction SilentlyContinue`,
    '  }',
    '  $payload = $payloadText | ConvertFrom-Json',
    "  if ($null -eq $payload -or @($payload.PSObject.Properties.Name).Count -ne 6 -or $payload.PSObject.Properties.Name -notcontains 'installerPath' -or $payload.PSObject.Properties.Name -notcontains 'arguments' -or $payload.PSObject.Properties.Name -notcontains 'installerTimeoutMs' -or $payload.PSObject.Properties.Name -notcontains 'cancellationPath' -or $payload.PSObject.Properties.Name -notcontains 'cancellationNonce' -or $payload.PSObject.Properties.Name -notcontains 'targetUserSid') { throw 'elevated installer payload is invalid' }",
    '  function Test-FullyQualifiedWindowsPath([string] $value) {',
    '    if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOf([char] 0) -ge 0) { return $false }',
    "    if ($value -notmatch '^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)') { return $false }",
    '    try { [void] [IO.Path]::GetFullPath($value); return $true } catch { return $false }',
    '  }',
    '  function ConvertTo-WindowsCommandLineArgument([string] $value, [bool] $forceQuote) {',
    '    if ($value.Length -eq 0) { return \'""\' }',
    "    if (-not $forceQuote -and $value -notmatch '[\\s\"]') { return $value }",
    "    $escaped = [Text.RegularExpressions.Regex]::Replace($value, '(\\\\*)\"', '$1$1\\\"')",
    "    $escaped = [Text.RegularExpressions.Regex]::Replace($escaped, '(\\\\*)$', '$1$1')",
    "    return '\"' + $escaped + '\"'",
    '  }',
    '  function Test-PrivateUserFile([string] $path, [string] $expectedUserSid) {',
    '    try {',
    '      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
    '      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 4096) { return $false }',
    '      $acl = [IO.File]::GetAccessControl($path)',
    '      $expectedSid = $expectedUserSid.ToUpperInvariant()',
    '      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() -cne $expectedSid -or -not $acl.AreAccessRulesProtected) { return $false }',
    '      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '      if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '      $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '      $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '      return $ruleSid -ceq $expectedSid -and (([int64] $rules[0].FileSystemRights) -band $fullControl) -eq $fullControl',
    '    } catch {',
    '      return $false',
    '    }',
    '  }',
    '  function Get-UpdateCancellationState([string] $path, [string] $expectedNonce, [string] $expectedUserSid) {',
    "    if (-not (Test-PrivateUserFile $path $expectedUserSid)) { return 'invalid' }",
    '    try {',
    '      $control = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json',
    "      $required = @('version', 'nonce', 'targetUserSid', 'state', 'updatedAtEpochMs')",
    "      if ($null -eq $control -or @($control.PSObject.Properties.Name).Count -ne $required.Count) { return 'invalid' }",
    "      foreach ($property in $required) { if ($control.PSObject.Properties.Name -notcontains $property) { return 'invalid' } }",
    "      if ([string] $control.version -cne '1' -or ([string] $control.nonce).ToLowerInvariant() -cne $expectedNonce -or ([string] $control.targetUserSid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant()) { return 'invalid' }",
    "      if ([string] $control.updatedAtEpochMs -notmatch '^[1-9]\\d*$') { return 'invalid' }",
    '      $updatedAt = [Convert]::ToInt64($control.updatedAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "      if ($updatedAt -gt ($now + 60000L) -or ($now - $updatedAt) -gt 900000L) { return 'invalid' }",
    '      $state = [string] $control.state',
    "      if ($state -cne 'armed' -and $state -cne 'cancelled') { return 'invalid' }",
    '      return $state',
    '    } catch {',
    "      return 'invalid'",
    '    }',
    '  }',
    '  function Get-ProcessTreeIds([int] $rootProcessId) {',
    '    $inventory = @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 2 -ErrorAction Stop)',
    '    $known = @{}',
    '    $known[$rootProcessId] = $true',
    '    do {',
    '      $changed = $false',
    '      foreach ($entry in $inventory) {',
    '        $processIdValue = [int] $entry.ProcessId',
    '        $parentProcessIdValue = [int] $entry.ParentProcessId',
    '        if ($processIdValue -le 0 -or -not $known.ContainsKey($parentProcessIdValue) -or $known.ContainsKey($processIdValue)) { continue }',
    '        $known[$processIdValue] = $true',
    '        $changed = $true',
    '      }',
    '    } while ($changed)',
    '    return @($known.Keys | ForEach-Object { [int] $_ })',
    '  }',
    '  function Stop-InstallerProcessTree([Diagnostics.Process] $process) {',
    "    if ($null -eq $process -or [int] $process.Id -le 0) { throw 'installer process tree is unavailable' }",
    '    $rootProcessId = [int] $process.Id',
    '    $trackedProcessIds = @($rootProcessId)',
    '    $inventoryAvailable = $false',
    "    $taskkillPath = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'taskkill.exe')",
    "    if (-not (Test-FullyQualifiedWindowsPath $taskkillPath) -or -not (Test-Path -LiteralPath $taskkillPath -PathType Leaf)) { throw 'canonical taskkill is unavailable' }",
    '    $taskkillItem = Get-Item -LiteralPath $taskkillPath -Force -ErrorAction Stop',
    "    if ($taskkillItem.PSIsContainer -or ($taskkillItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'canonical taskkill is invalid' }",
    "    $taskkillArguments = '/PID ' + $rootProcessId + ' /T /F'",
    '    $taskkill = Start-Process -FilePath $taskkillPath -ArgumentList $taskkillArguments -WindowStyle Hidden -PassThru',
    "    if ($null -eq $taskkill -or [int] $taskkill.Id -le 0) { throw 'canonical taskkill did not start' }",
    '    try { $trackedProcessIds = @(Get-ProcessTreeIds $rootProcessId); $inventoryAvailable = $true } catch { }',
    '    $taskkillFinished = $taskkill.WaitForExit(15000)',
    '    if (-not $taskkillFinished) {',
    '      try { $taskkill.Kill() } catch { }',
    '      try { [void] $taskkill.WaitForExit(2000) } catch { }',
    '    }',
    '    $taskkillExitCode = if ($taskkillFinished) { [int] $taskkill.ExitCode } else { -1 }',
    '    $treeDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)',
    '    while ([DateTimeOffset]::UtcNow -lt $treeDeadline) {',
    '      $surviving = @($trackedProcessIds | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })',
    '      if ($surviving.Count -eq 0) {',
    '        if ($taskkillExitCode -eq 0 -or $inventoryAvailable) { return }',
    "        throw ('canonical taskkill failed with exit code ' + $taskkillExitCode + ' and process-tree inventory was unavailable')",
    '      }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    "    throw 'installer process tree did not close'",
    '  }',
    '  $installerPath = [string] $payload.installerPath',
    "  if (-not (Test-FullyQualifiedWindowsPath $installerPath) -or [IO.Path]::GetExtension($installerPath) -ine '.exe') { throw 'elevated installer path is invalid' }",
    '  $installerPath = [IO.Path]::GetFullPath($installerPath)',
    '  [string[]] $arguments = @($payload.arguments)',
    "  if ($arguments.Count -ne 11 -or $arguments[0] -cne '--updated' -or $arguments[1] -cne '/S' -or $arguments[2] -cne '--force-run') { throw 'elevated installer arguments are invalid' }",
    "  if ($arguments[3] -cne '--youyu-handoff-path' -or -not (Test-FullyQualifiedWindowsPath $arguments[4]) -or $arguments[5] -cne '--youyu-handoff-nonce' -or $arguments[6] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $arguments[7] -cne '--youyu-target-user-sid' -or $arguments[8] -notmatch '^S-1-\\d+(?:-\\d+){2,14}$' -or $arguments[9] -cne '--youyu-target-session-id' -or $arguments[10] -notmatch '^[1-9]\\d*$') { throw 'elevated installer handoff arguments are invalid' }",
    '  $cancellationPath = [string] $payload.cancellationPath',
    '  $cancellationNonce = ([string] $payload.cancellationNonce).ToLowerInvariant()',
    '  $targetUserSid = ([string] $payload.targetUserSid).ToUpperInvariant()',
    "  if (-not (Test-FullyQualifiedWindowsPath $cancellationPath) -or $cancellationNonce -cne $arguments[6] -or $targetUserSid -cne $arguments[8].ToUpperInvariant()) { throw 'elevated installer cancellation identity is invalid' }",
    '  $cancellationPath = [IO.Path]::GetFullPath($cancellationPath)',
    "  $expectedCancellationPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($arguments[4])), ('youyu-update-cancel-' + $arguments[6] + '.json'))",
    "  if ($cancellationPath -ine $expectedCancellationPath) { throw 'elevated installer cancellation path is invalid' }",
    '  $initialCancellationState = Get-UpdateCancellationState $cancellationPath $cancellationNonce $targetUserSid',
    "  if ($initialCancellationState -ceq 'cancelled') { exit 126 }",
    "  if ($initialCancellationState -cne 'armed') { throw 'elevated installer cancellation marker is invalid' }",
    "  if ([string] $payload.installerTimeoutMs -notmatch '^[1-9]\\d*$') { throw 'elevated installer timeout is invalid' }",
    '  $installerTimeoutMs = [Convert]::ToInt32($payload.installerTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "  if ($installerTimeoutMs -lt 30000 -or $installerTimeoutMs -gt 1800000) { throw 'elevated installer timeout is invalid' }",
    "  $argumentLine = [string]::Join(' ', @(for ($index = 0; $index -lt $arguments.Count; $index += 1) { ConvertTo-WindowsCommandLineArgument ([string] $arguments[$index]) (($index -ge 4) -and (($index % 2) -eq 0)) }))",
    '  $installer = Start-Process -FilePath $installerPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru',
    "  if ($null -eq $installer -or [int] $installer.Id -le 0) { throw 'elevated installer did not start' }",
    '  $installerDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($installerTimeoutMs)',
    '  while (-not $installer.HasExited) {',
    '    $cancellationState = Get-UpdateCancellationState $cancellationPath $cancellationNonce $targetUserSid',
    "    if ($cancellationState -cne 'armed') {",
    '      Stop-InstallerProcessTree $installer',
    '      $installerBoundaryClosed = $true',
    "      if ($cancellationState -ceq 'cancelled') { exit 126 }",
    "      throw 'elevated installer cancellation marker became invalid'",
    '    }',
    '    if ([DateTimeOffset]::UtcNow -ge $installerDeadline) {',
    '      Stop-InstallerProcessTree $installer',
    '      $installerBoundaryClosed = $true',
    '      exit 124',
    '    }',
    '    [void] $installer.WaitForExit(200)',
    '  }',
    '  $installerBoundaryClosed = $true',
    '  exit [int] $installer.ExitCode',
    '} catch {',
    "  [Console]::Error.WriteLine(('YouYu elevated update wrapper: ' + $_.Exception.Message))",
    '  exit 125',
    '} finally {',
    '  if (($null -eq $installer -or $installerBoundaryClosed) -and -not [string]::IsNullOrWhiteSpace($cancellationPath)) {',
    '    try {',
    '      $cancellationItem = Get-Item -LiteralPath $cancellationPath -Force -ErrorAction SilentlyContinue',
    '      if ($null -ne $cancellationItem -and -not $cancellationItem.PSIsContainer -and -not ($cancellationItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $cancellationPath -Force -ErrorAction SilentlyContinue }',
    '    } catch { }',
    '  }',
    '}'
  ].join('\n');
}

function createUpdateInstallerPowerShellTransport(
  script: string,
  scriptEnvironment: string
): {
  environmentValue: string;
  encodedLoaderCommand: string;
} {
  const scriptBytes = Buffer.from(script, 'utf8');
  if (scriptBytes.length <= 0 || scriptBytes.length > 100_000) {
    throw new Error('update installer supervisor script size is invalid');
  }
  const expectedSha256 = createHash('sha256').update(scriptBytes).digest('hex');
  const environmentValue = gzipSync(scriptBytes, { level: 9 }).toString('base64');
  const loaderScript = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$compressedStream = $null',
    '$gzipStream = $null',
    '$reader = $null',
    'try {',
    `  $compressedText = [string] $env:${scriptEnvironment}`,
    `  Remove-Item Env:${scriptEnvironment} -ErrorAction SilentlyContinue`,
    "  if ([string]::IsNullOrWhiteSpace($compressedText) -or $compressedText.Length -gt 131072) { throw 'update supervisor transport is invalid' }",
    '  $compressedBytes = [Convert]::FromBase64String($compressedText)',
    "  if ($compressedBytes.Length -le 0 -or $compressedBytes.Length -gt 65536) { throw 'update supervisor transport is invalid' }",
    '  $compressedStream = New-Object IO.MemoryStream(, $compressedBytes)',
    '  $gzipStream = New-Object IO.Compression.GZipStream($compressedStream, [IO.Compression.CompressionMode]::Decompress)',
    '  $reader = New-Object IO.StreamReader($gzipStream, [Text.Encoding]::UTF8, $true)',
    '  $builder = New-Object Text.StringBuilder',
    '  $buffer = New-Object char[] 4096',
    '  while (($read = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {',
    "    if (($builder.Length + $read) -gt 100000) { throw 'update supervisor script is too large' }",
    '    [void] $builder.Append($buffer, 0, $read)',
    '  }',
    '  $scriptText = $builder.ToString()',
    '  $sha256 = [Security.Cryptography.SHA256]::Create()',
    "  try { $actualSha256 = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($scriptText)))).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }",
    `  if ($actualSha256 -cne '${expectedSha256}') { throw 'update supervisor script integrity check failed' }`,
    '  & ([ScriptBlock]::Create($scriptText))',
    '} catch {',
    "  [Console]::Error.WriteLine(('YouYu update launcher: ' + $_.Exception.Message))",
    '  exit 1',
    '} finally {',
    '  if ($null -ne $reader) { $reader.Dispose() } else { if ($null -ne $gzipStream) { $gzipStream.Dispose() }; if ($null -ne $compressedStream) { $compressedStream.Dispose() } }',
    '}'
  ].join('\n');
  return {
    environmentValue,
    encodedLoaderCommand: Buffer.from(loaderScript, 'utf16le').toString('base64')
  };
}

export function createUpdateInstallerSupervisorTransport(script: string): {
  environmentValue: string;
  encodedLoaderCommand: string;
} {
  return createUpdateInstallerPowerShellTransport(script, updateInstallerSupervisorScriptEnvironment);
}

export function createUpdateInstallerBootstrapTransport(script = createUpdateInstallerBootstrapScript()): {
  environmentValue: string;
  encodedLoaderCommand: string;
} {
  return createUpdateInstallerPowerShellTransport(script, updateInstallerBootstrapScriptEnvironment);
}

export function createUpdateInstallerBootstrapScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$outer = $null',
    '$outerErrorPath = $null',
    '$readyPath = $null',
    '$readyPathValidated = $false',
    '$cancellationPath = $null',
    '$cancellationPathValidated = $false',
    '$cleanupTimeoutMs = 10000',
    'try {',
    '  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `  $bootstrapPayloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${updateInstallerBootstrapPayloadEnvironment}))`,
    '  $bootstrapPayload = $bootstrapPayloadText | ConvertFrom-Json',
    `  $outerLoaderCommand = [string] $env:${updateInstallerSupervisorLoaderEnvironment}`,
    `  Remove-Item Env:${updateInstallerBootstrapPayloadEnvironment} -ErrorAction SilentlyContinue`,
    `  Remove-Item Env:${updateInstallerSupervisorLoaderEnvironment} -ErrorAction SilentlyContinue`,
    "  if ($null -eq $bootstrapPayload -or @($bootstrapPayload.PSObject.Properties.Name).Count -ne 8 -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'version' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'readyPath' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'handoffPath' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'cancellationPath' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'nonce' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'targetUserSid' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'timeoutMs' -or $bootstrapPayload.PSObject.Properties.Name -notcontains 'cleanupTimeoutMs') { throw 'update bootstrap payload is invalid' }",
    "  if ([string] $bootstrapPayload.version -cne '1') { throw 'update bootstrap payload version is invalid' }",
    '  function Test-FullyQualifiedWindowsPath([string] $value) {',
    '    if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOf([char] 0) -ge 0) { return $false }',
    "    if ($value -notmatch '^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)') { return $false }",
    '    try { [void] [IO.Path]::GetFullPath($value); return $true } catch { return $false }',
    '  }',
    '  $handoffPath = [string] $bootstrapPayload.handoffPath',
    '  $readyPath = [string] $bootstrapPayload.readyPath',
    '  $cancellationPath = [string] $bootstrapPayload.cancellationPath',
    '  $nonce = ([string] $bootstrapPayload.nonce).ToLowerInvariant()',
    '  $targetUserSid = ([string] $bootstrapPayload.targetUserSid).ToUpperInvariant()',
    "  if (-not (Test-FullyQualifiedWindowsPath $handoffPath) -or -not (Test-FullyQualifiedWindowsPath $readyPath) -or -not (Test-FullyQualifiedWindowsPath $cancellationPath) -or $nonce -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $targetUserSid -notmatch '^S-1-\\d+(?:-\\d+){2,14}$') { throw 'update bootstrap identity is invalid' }",
    '  $handoffPath = [IO.Path]::GetFullPath($handoffPath)',
    '  $readyPath = [IO.Path]::GetFullPath($readyPath)',
    '  $cancellationPath = [IO.Path]::GetFullPath($cancellationPath)',
    "  $expectedReadyPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-supervisor-' + $nonce + '.ready.json'))",
    "  if ($readyPath -ine $expectedReadyPath) { throw 'update bootstrap ready path is invalid' }",
    '  $readyPathValidated = $true',
    "  $expectedCancellationPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-cancel-' + $nonce + '.json'))",
    "  if ($cancellationPath -ine $expectedCancellationPath) { throw 'update bootstrap cancellation path is invalid' }",
    '  $cancellationPathValidated = $true',
    "  if ([string] $bootstrapPayload.timeoutMs -notmatch '^[1-9]\\d*$') { throw 'update bootstrap timeout is invalid' }",
    '  $timeoutMs = [Convert]::ToInt32($bootstrapPayload.timeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "  if ($timeoutMs -le 0 -or $timeoutMs -gt 300000) { throw 'update bootstrap timeout is invalid' }",
    "  if ([string] $bootstrapPayload.cleanupTimeoutMs -notmatch '^[1-9]\\d*$') { throw 'update bootstrap cleanup timeout is invalid' }",
    '  $cleanupTimeoutMs = [Convert]::ToInt32($bootstrapPayload.cleanupTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "  if ($cleanupTimeoutMs -le 0 -or $cleanupTimeoutMs -gt 60000) { throw 'update bootstrap cleanup timeout is invalid' }",
    "  if ([string]::IsNullOrWhiteSpace($outerLoaderCommand) -or $outerLoaderCommand.Length -gt 24000 -or ($outerLoaderCommand.Length % 4) -ne 0 -or $outerLoaderCommand -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'update supervisor loader is invalid' }",
    "  try { [void] [Convert]::FromBase64String($outerLoaderCommand) } catch { throw 'update supervisor loader is invalid' }",
    '  function Test-PrivateSupervisorReadyFile([string] $path, [string] $expectedUserSid, [int] $expectedProcessId, [string] $expectedNonce, [string] $expectedHandoffPath, [int64] $notBeforeEpochMs) {',
    '    try {',
    '      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
    '      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 4096) { return $false }',
    '      $acl = [IO.File]::GetAccessControl($path)',
    '      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() -cne $expectedUserSid -or -not $acl.AreAccessRulesProtected) { return $false }',
    '      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '      if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '      $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '      $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '      if ($ruleSid -cne $expectedUserSid -or (([int64] $rules[0].FileSystemRights) -band $fullControl) -ne $fullControl) { return $false }',
    '      $ready = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json',
    "      $required = @('version', 'nonce', 'handoffPath', 'targetUserSid', 'supervisorProcessId', 'readyAtEpochMs', 'expiresAtEpochMs')",
    '      if ($null -eq $ready -or @($ready.PSObject.Properties.Name).Count -ne $required.Count) { return $false }',
    '      foreach ($property in $required) { if ($ready.PSObject.Properties.Name -notcontains $property) { return $false } }',
    "      if ([string] $ready.version -cne '1' -or ([string] $ready.nonce).ToLowerInvariant() -cne $expectedNonce -or ([string] $ready.targetUserSid).ToUpperInvariant() -cne $expectedUserSid -or ([IO.Path]::GetFullPath([string] $ready.handoffPath)) -ine $expectedHandoffPath -or ([string] $ready.supervisorProcessId) -cne ([string] $expectedProcessId)) { return $false }",
    "      if ([string] $ready.readyAtEpochMs -notmatch '^[1-9]\\d*$' -or [string] $ready.expiresAtEpochMs -notmatch '^[1-9]\\d*$') { return $false }",
    '      $readyAt = [Convert]::ToInt64($ready.readyAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '      $expiresAt = [Convert]::ToInt64($ready.expiresAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '      return $readyAt -ge ($notBeforeEpochMs - 2000L) -and $readyAt -le ($now + 60000L) -and $expiresAt -ge $now -and $expiresAt -ge $readyAt -and ($expiresAt - $readyAt) -le 300000L',
    '    } catch {',
    '      return $false',
    '    }',
    '  }',
    '  function Signal-UpdateCancellationMarker([string] $path, [string] $expectedNonce, [string] $expectedUserSid) {',
    '    try {',
    '      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
    '      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 4096) { return $false }',
    '      $acl = [IO.File]::GetAccessControl($path)',
    '      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() -cne $expectedUserSid -or -not $acl.AreAccessRulesProtected) { return $false }',
    '      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '      if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '      $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '      $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '      if ($ruleSid -cne $expectedUserSid -or (([int64] $rules[0].FileSystemRights) -band $fullControl) -ne $fullControl) { return $false }',
    '      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "      $control = [pscustomobject]@{ version = '1'; nonce = $expectedNonce; targetUserSid = $expectedUserSid; state = 'cancelled'; updatedAtEpochMs = $now }",
    '      [IO.File]::WriteAllText($path, (($control | ConvertTo-Json -Compress) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))',
    '      return $true',
    '    } catch {',
    '      return $false',
    '    }',
    '  }',
    '  function Read-OuterSupervisorError([string] $path) {',
    '    try {',
    "      if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }",
    "      $text = ((Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) + '' ).Trim()",
    '      if ($text.Length -gt 600) { $text = $text.Substring($text.Length - 600) }',
    '      return $text',
    '    } catch {',
    "      return '' ",
    '    }',
    '  }',
    "  $outerErrorPath = $readyPath + '.stderr.log'",
    '  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $outerErrorPath -Force -ErrorAction SilentlyContinue',
    '  $startedAtEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "  $outerArgumentLine = '-NoProfile -NonInteractive -EncodedCommand ' + $outerLoaderCommand",
    "  $outer = Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe')) -ArgumentList $outerArgumentLine -WindowStyle Hidden -RedirectStandardError $outerErrorPath -PassThru",
    "  if ($null -eq $outer -or [int] $outer.Id -le 0) { throw 'update supervisor did not start' }",
    '  [void] $outer.WaitForExit(250)',
    '  if ($outer.HasExited) {',
    '    $outerError = Read-OuterSupervisorError $outerErrorPath',
    "    if ([string]::IsNullOrWhiteSpace($outerError)) { throw 'update supervisor exited before bootstrap readiness' }",
    "    throw ('update supervisor exited before bootstrap readiness: ' + $outerError)",
    '  }',
    '  $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($timeoutMs)',
    '  while ([DateTimeOffset]::UtcNow -lt $deadline) {',
    '    if ($outer.HasExited) {',
    '      $outerError = Read-OuterSupervisorError $outerErrorPath',
    "      if ([string]::IsNullOrWhiteSpace($outerError)) { throw ('update supervisor exited before authenticated readiness with exit code ' + [int] $outer.ExitCode) }",
    "      throw ('update supervisor exited before authenticated readiness with exit code ' + [int] $outer.ExitCode + ': ' + $outerError)",
    '    }',
    '    if (Test-PrivateSupervisorReadyFile $readyPath $targetUserSid ([int] $outer.Id) $nonce $handoffPath $startedAtEpochMs) {',
    '      $outer.Refresh()',
    "      if ($outer.HasExited) { throw 'update supervisor exited during authenticated readiness' }",
    '      Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue',
    '      if (-not [string]::IsNullOrWhiteSpace($outerErrorPath)) { Remove-Item -LiteralPath $outerErrorPath -Force -ErrorAction SilentlyContinue }',
    `      [Console]::Out.WriteLine('${updateInstallerSupervisorReadyMessage}')`,
    '      [Console]::Out.Flush()',
    '      exit 0',
    '    }',
    `    Start-Sleep -Milliseconds ${updateInstallerAcknowledgementPollIntervalMs}`,
    '  }',
    "  throw 'update supervisor did not become ready in time'",
    '} catch {',
    '  if ($cancellationPathValidated -and $null -ne (Get-Command Signal-UpdateCancellationMarker -CommandType Function -ErrorAction SilentlyContinue)) { [void] (Signal-UpdateCancellationMarker $cancellationPath $nonce $targetUserSid) }',
    '  if ($null -ne $outer) {',
    '    try {',
    '      $cooperativeDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds([Math]::Max(1, $cleanupTimeoutMs - 10000))',
    '      while (-not $outer.HasExited -and [DateTimeOffset]::UtcNow -lt $cooperativeDeadline) { Start-Sleep -Milliseconds 100 }',
    '      if (-not $outer.HasExited) { $outer.Kill(); [void] $outer.WaitForExit([Math]::Min(10000, $cleanupTimeoutMs)) }',
    '    } catch { }',
    '  }',
    '  if ($readyPathValidated) { Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue }',
    '  if (-not [string]::IsNullOrWhiteSpace($outerErrorPath)) { Remove-Item -LiteralPath $outerErrorPath -Force -ErrorAction SilentlyContinue }',
    "  [Console]::Error.WriteLine(('YouYu update launcher: ' + $_.Exception.Message))",
    '  exit 1',
    '}'
  ].join('\n');
}

export function createUpdateInstallerLauncherScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$started = $null',
    '$cancellationPath = $null',
    '$cancellationPathValidated = $false',
    '$elevatedPayloadPath = $null',
    'try {',
    '  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$payloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD))',
    '$payload = $payloadText | ConvertFrom-Json',
    'Remove-Item Env:YOUYU_UPDATE_INSTALLER_LAUNCH_PAYLOAD -ErrorAction SilentlyContinue',
    `Remove-Item Env:${updateInstallerHandoffEnvironment.path} -ErrorAction SilentlyContinue`,
    `Remove-Item Env:${updateInstallerHandoffEnvironment.nonce} -ErrorAction SilentlyContinue`,
    `Remove-Item Env:${updateInstallerHandoffEnvironment.userSid} -ErrorAction SilentlyContinue`,
    `Remove-Item Env:${updateInstallerHandoffEnvironment.sessionId} -ErrorAction SilentlyContinue`,
    "if ($null -eq $payload -or @($payload.PSObject.Properties.Name).Count -ne 9 -or $payload.PSObject.Properties.Name -notcontains 'installerPath' -or $payload.PSObject.Properties.Name -notcontains 'expectedVersion' -or $payload.PSObject.Properties.Name -notcontains 'arguments' -or $payload.PSObject.Properties.Name -notcontains 'acknowledgement' -or $payload.PSObject.Properties.Name -notcontains 'supervisorReady' -or $payload.PSObject.Properties.Name -notcontains 'cancellation' -or $payload.PSObject.Properties.Name -notcontains 'acknowledgementTimeoutMs' -or $payload.PSObject.Properties.Name -notcontains 'installerTimeoutMs' -or $payload.PSObject.Properties.Name -notcontains 'resumeProxyAfterRelaunch') { throw 'update installer launch payload is invalid' }",
    'function Test-FullyQualifiedWindowsPath([string] $value) {',
    '  if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOf([char] 0) -ge 0) { return $false }',
    "  if ($value -notmatch '^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)') { return $false }",
    '  try {',
    '    [void] [IO.Path]::GetFullPath($value)',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    '$installerPath = [string] $payload.installerPath',
    "if (-not (Test-FullyQualifiedWindowsPath $installerPath) -or [IO.Path]::GetExtension($installerPath) -ine '.exe') { throw 'update installer path is invalid' }",
    '$installerPath = [IO.Path]::GetFullPath($installerPath)',
    '$expectedVersionText = ([string] $payload.expectedVersion).Trim()',
    "if ($expectedVersionText -notmatch '^\\d+\\.\\d+\\.\\d+$') { throw 'expected update version is invalid' }",
    '$expectedVersion = [Version] $expectedVersionText',
    '[string[]] $arguments = @($payload.arguments)',
    "if ($arguments.Count -ne 11) { throw 'update installer arguments are invalid' }",
    "if ($arguments[0] -cne '--updated' -or $arguments[1] -cne '/S' -or $arguments[2] -cne '--force-run') { throw 'update installer arguments are invalid' }",
    "if ($arguments[3] -cne '--youyu-handoff-path' -or $arguments[4].IndexOf([char] 0) -ge 0 -or $arguments[4].Length -eq 0 -or $arguments[5] -cne '--youyu-handoff-nonce' -or $arguments[6] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $arguments[7] -cne '--youyu-target-user-sid' -or $arguments[8] -notmatch '^S-1-\\d+(?:-\\d+){2,14}$' -or $arguments[9] -cne '--youyu-target-session-id' -or $arguments[10] -notmatch '^[1-9]\\d*$') { throw 'update installer handoff arguments are invalid' }",
    '$handoffPath = [IO.Path]::GetFullPath([string] $arguments[4])',
    '$acknowledgement = $payload.acknowledgement',
    "if ($null -eq $acknowledgement -or @($acknowledgement.PSObject.Properties.Name).Count -ne 7 -or $acknowledgement.PSObject.Properties.Name -notcontains 'path' -or $acknowledgement.PSObject.Properties.Name -notcontains 'handoffPath' -or $acknowledgement.PSObject.Properties.Name -notcontains 'nonce' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetUserSid' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetSessionId' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetProcessId' -or $acknowledgement.PSObject.Properties.Name -notcontains 'targetExecutablePath') { throw 'update acknowledgement payload is invalid' }",
    '$acknowledgementPath = [string] $acknowledgement.path',
    "if (-not (Test-FullyQualifiedWindowsPath $acknowledgementPath)) { throw 'update acknowledgement path is invalid' }",
    '$acknowledgementPath = [IO.Path]::GetFullPath($acknowledgementPath)',
    "$expectedAcknowledgementPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-handoff-' + $arguments[6] + '.ready.json'))",
    '$targetExecutablePath = [string] $acknowledgement.targetExecutablePath',
    "if (-not (Test-FullyQualifiedWindowsPath $targetExecutablePath) -or [IO.Path]::GetExtension($targetExecutablePath) -ine '.exe') { throw 'update acknowledgement executable path is invalid' }",
    '$targetExecutablePath = [IO.Path]::GetFullPath($targetExecutablePath)',
    "$elevatedInstallerWrapperPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($targetExecutablePath), 'resources', 'update-elevated-installer.ps1')",
    "if (-not (Test-FullyQualifiedWindowsPath $elevatedInstallerWrapperPath) -or -not (Test-Path -LiteralPath $elevatedInstallerWrapperPath -PathType Leaf)) { throw 'elevated update wrapper is unavailable' }",
    '$elevatedInstallerWrapperItem = Get-Item -LiteralPath $elevatedInstallerWrapperPath -Force -ErrorAction Stop',
    "if (($elevatedInstallerWrapperItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $elevatedInstallerWrapperItem.Length -le 0 -or $elevatedInstallerWrapperItem.Length -gt 65536) { throw 'elevated update wrapper file is invalid' }",
    "if ($acknowledgementPath -ine $expectedAcknowledgementPath -or ([IO.Path]::GetFullPath([string] $acknowledgement.handoffPath)) -ine $handoffPath -or ([string] $acknowledgement.nonce).ToLowerInvariant() -cne $arguments[6] -or ([string] $acknowledgement.targetUserSid).ToUpperInvariant() -cne $arguments[8].ToUpperInvariant() -or ([string] $acknowledgement.targetSessionId) -cne $arguments[10] -or ([string] $acknowledgement.targetProcessId) -notmatch '^[1-9]\\d*$') { throw 'update acknowledgement payload does not match its handoff' }",
    '$supervisorReady = $payload.supervisorReady',
    "if ($null -eq $supervisorReady -or @($supervisorReady.PSObject.Properties.Name).Count -ne 3 -or $supervisorReady.PSObject.Properties.Name -notcontains 'path' -or $supervisorReady.PSObject.Properties.Name -notcontains 'nonce' -or $supervisorReady.PSObject.Properties.Name -notcontains 'targetUserSid') { throw 'update supervisor ready payload is invalid' }",
    '$supervisorReadyPath = [string] $supervisorReady.path',
    "if (-not (Test-FullyQualifiedWindowsPath $supervisorReadyPath)) { throw 'update supervisor ready path is invalid' }",
    '$supervisorReadyPath = [IO.Path]::GetFullPath($supervisorReadyPath)',
    "$expectedSupervisorReadyPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-supervisor-' + $arguments[6] + '.ready.json'))",
    "if ($supervisorReadyPath -ine $expectedSupervisorReadyPath -or ([string] $supervisorReady.nonce).ToLowerInvariant() -cne $arguments[6] -or ([string] $supervisorReady.targetUserSid).ToUpperInvariant() -cne $arguments[8].ToUpperInvariant()) { throw 'update supervisor ready payload does not match its handoff' }",
    '$cancellation = $payload.cancellation',
    "if ($null -eq $cancellation -or @($cancellation.PSObject.Properties.Name).Count -ne 3 -or $cancellation.PSObject.Properties.Name -notcontains 'path' -or $cancellation.PSObject.Properties.Name -notcontains 'nonce' -or $cancellation.PSObject.Properties.Name -notcontains 'targetUserSid') { throw 'update cancellation payload is invalid' }",
    '$cancellationPath = [string] $cancellation.path',
    "if (-not (Test-FullyQualifiedWindowsPath $cancellationPath)) { throw 'update cancellation path is invalid' }",
    '$cancellationPath = [IO.Path]::GetFullPath($cancellationPath)',
    "$expectedCancellationPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-cancel-' + $arguments[6] + '.json'))",
    "if ($cancellationPath -ine $expectedCancellationPath -or ([string] $cancellation.nonce).ToLowerInvariant() -cne $arguments[6] -or ([string] $cancellation.targetUserSid).ToUpperInvariant() -cne $arguments[8].ToUpperInvariant()) { throw 'update cancellation payload does not match its handoff' }",
    '$cancellationPathValidated = $true',
    "if ([string] $payload.acknowledgementTimeoutMs -notmatch '^[1-9]\\d*$') { throw 'update acknowledgement timeout is invalid' }",
    '$acknowledgementTimeoutMs = [Convert]::ToInt64($payload.acknowledgementTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "if ($acknowledgementTimeoutMs -le 0 -or $acknowledgementTimeoutMs -gt 60000) { throw 'update acknowledgement timeout is invalid' }",
    "if ([string] $payload.installerTimeoutMs -notmatch '^[1-9]\\d*$') { throw 'update installer timeout is invalid' }",
    '$installerTimeoutMs = [Convert]::ToInt32($payload.installerTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)',
    "if ($installerTimeoutMs -lt 30000 -or $installerTimeoutMs -gt 1800000) { throw 'update installer timeout is invalid' }",
    "if ($payload.resumeProxyAfterRelaunch -isnot [bool]) { throw 'update relaunch runtime intent is invalid' }",
    '$resumeProxyAfterRelaunch = [bool] $payload.resumeProxyAfterRelaunch',
    "$relaunchAcknowledgementPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-relaunch-' + $arguments[6] + '.ready.json'))",
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
    '    $acl = [IO.File]::GetAccessControl($path)',
    '    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '    if ($ownerSid -cne $expectedUserSid.ToUpperInvariant() -or -not $acl.AreAccessRulesProtected) { return $false }',
    '    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '    if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '    $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '    $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '    if ($ruleSid -cne $expectedUserSid.ToUpperInvariant() -or (([int64] $rules[0].FileSystemRights) -band $fullControl) -ne $fullControl) { return $false }',
    '    $acknowledgement = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json',
    "    $required = @('version', 'nonce', 'handoffPath', 'targetUserSid', 'targetSessionId', 'targetProcessId', 'executablePath', 'acknowledgedAtEpochMs', 'expiresAtEpochMs')",
    '    if ($null -eq $acknowledgement -or @($acknowledgement.PSObject.Properties.Name).Count -ne $required.Count) { return $false }',
    '    foreach ($property in $required) { if ($acknowledgement.PSObject.Properties.Name -notcontains $property) { return $false } }',
    "    if ([string] $acknowledgement.version -cne '1' -or ([string] $acknowledgement.nonce).ToLowerInvariant() -cne $expectedNonce -or ([IO.Path]::GetFullPath([string] $acknowledgement.handoffPath)) -ine $expectedHandoffPath -or ([string] $acknowledgement.targetUserSid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant() -or ([string] $acknowledgement.targetSessionId) -cne $expectedSessionId -or ([string] $acknowledgement.targetProcessId) -cne $expectedProcessId -or ([IO.Path]::GetFullPath([string] $acknowledgement.executablePath)) -ine $expectedExecutablePath) { return $false }",
    "    if ([string] $acknowledgement.targetProcessId -notmatch '^[1-9]\\d*$' -or -not (Test-FullyQualifiedWindowsPath ([string] $acknowledgement.executablePath)) -or [string] $acknowledgement.acknowledgedAtEpochMs -notmatch '^\\d+$' -or [string] $acknowledgement.expiresAtEpochMs -notmatch '^\\d+$') { return $false }",
    '    $acknowledgedAt = [Convert]::ToInt64($acknowledgement.acknowledgedAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '    $expiresAt = [Convert]::ToInt64($acknowledgement.expiresAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '    if ($acknowledgedAt -le 0 -or $acknowledgedAt -gt ($now + 60000L) -or $expiresAt -lt $now -or $expiresAt -lt $acknowledgedAt -or ($expiresAt - $acknowledgedAt) -gt 900000L) { return $false }',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    'function Test-PrivateUserFile([string] $path, [string] $expectedUserSid, [bool] $allowEmpty) {',
    '  try {',
    '    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop',
    '    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4096 -or (-not $allowEmpty -and $item.Length -le 0)) { return $false }',
    '    $acl = [IO.File]::GetAccessControl($path)',
    '    $expectedSid = $expectedUserSid.ToUpperInvariant()',
    '    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() -cne $expectedSid -or -not $acl.AreAccessRulesProtected) { return $false }',
    '    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '    if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }',
    '    $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()',
    '    $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl',
    '    return $ruleSid -ceq $expectedSid -and (([int64] $rules[0].FileSystemRights) -band $fullControl) -eq $fullControl',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    'function Initialize-AuthenticatedUpdateCancellation([string] $path, [string] $nonce, [string] $expectedUserSid) {',
    '  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
    '  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    '  $stream.Dispose()',
    '  $sid = New-Object Security.Principal.SecurityIdentifier($expectedUserSid)',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetAccessRule($rule)',
    '  [IO.File]::SetAccessControl($path, $acl)',
    '  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "  $control = [pscustomobject]@{ version = '1'; nonce = $nonce; targetUserSid = $expectedUserSid; state = 'armed'; updatedAtEpochMs = $now }",
    '  [IO.File]::WriteAllText($path, (($control | ConvertTo-Json -Compress) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))',
    "  if (-not (Test-PrivateUserFile $path $expectedUserSid $false)) { throw 'update cancellation marker permissions are invalid' }",
    '}',
    'function Write-AuthenticatedElevatedInstallerPayload([string] $path, [string] $payloadJson, [string] $expectedUserSid) {',
    '  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
    '  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    '  $stream.Dispose()',
    '  $sid = New-Object Security.Principal.SecurityIdentifier($expectedUserSid)',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetAccessRule($rule)',
    '  [IO.File]::SetAccessControl($path, $acl)',
    '  [IO.File]::WriteAllText($path, ($payloadJson + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))',
    "  if (-not (Test-PrivateUserFile $path $expectedUserSid $false)) { throw 'elevated installer payload permissions are invalid' }",
    '}',
    'function Signal-AuthenticatedUpdateCancellation([string] $path, [string] $nonce, [string] $expectedUserSid) {',
    '  if (-not (Test-PrivateUserFile $path $expectedUserSid $false)) { return $false }',
    '  try {',
    '    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "    $control = [pscustomobject]@{ version = '1'; nonce = $nonce; targetUserSid = $expectedUserSid; state = 'cancelled'; updatedAtEpochMs = $now }",
    '    [IO.File]::WriteAllText($path, (($control | ConvertTo-Json -Compress) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    'function Remove-AuthenticatedUpdateCancellation([string] $path) {',
    '  try {',
    '    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
    '    if ($null -ne $item -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }',
    '  } catch { }',
    '}',
    'function Write-AuthenticatedSupervisorReady([string] $path, [string] $handoffPathValue, [string] $nonce, [string] $expectedUserSid) {',
    '  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
    '  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    '  $stream.Dispose()',
    '  $sid = New-Object Security.Principal.SecurityIdentifier($expectedUserSid)',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetAccessRule($rule)',
    '  [IO.File]::SetAccessControl($path, $acl)',
    '  $readyAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "  $ready = [pscustomobject]@{ version = '1'; nonce = $nonce; handoffPath = $handoffPathValue; targetUserSid = $expectedUserSid; supervisorProcessId = [int] $PID; readyAtEpochMs = $readyAt; expiresAtEpochMs = $readyAt + 300000L }",
    '  [IO.File]::WriteAllText($path, ($ready | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))',
    "  if (-not (Test-PrivateUserFile $path $expectedUserSid $false)) { throw 'update supervisor ready permissions are invalid' }",
    '}',
    'function Initialize-UpdateRelaunchChallenge([string] $path, [string] $expectedUserSid) {',
    '  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
    '  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    '  $stream.Dispose()',
    '  $sid = New-Object Security.Principal.SecurityIdentifier($expectedUserSid)',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetAccessRule($rule)',
    '  [IO.File]::SetAccessControl($path, $acl)',
    "  if (-not (Test-PrivateUserFile $path $expectedUserSid $true)) { throw 'update relaunch challenge permissions are invalid' }",
    '}',
    'function Test-AuthenticatedUpdateRelaunchAcknowledgement([string] $path, [string] $expectedNonce, [string] $expectedVersion, [string] $expectedExecutablePath, [string] $expectedUserSid, [string] $expectedSessionId, [int64] $notBeforeEpochMs) {',
    '  if (-not (Test-PrivateUserFile $path $expectedUserSid $false)) { return $false }',
    '  try {',
    '    $ready = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json',
    "    $required = @('version', 'nonce', 'appVersion', 'executablePath', 'processId', 'targetUserSid', 'targetSessionId', 'readyAtEpochMs')",
    '    if ($null -eq $ready -or @($ready.PSObject.Properties.Name).Count -ne $required.Count) { return $false }',
    '    foreach ($property in $required) { if ($ready.PSObject.Properties.Name -notcontains $property) { return $false } }',
    "    if ([string] $ready.version -cne '1' -or ([string] $ready.nonce).ToLowerInvariant() -cne $expectedNonce -or ([string] $ready.appVersion) -cne $expectedVersion -or ([string] $ready.targetUserSid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant() -or ([string] $ready.targetSessionId) -cne $expectedSessionId -or -not (Test-FullyQualifiedWindowsPath ([string] $ready.executablePath)) -or ([IO.Path]::GetFullPath([string] $ready.executablePath)) -ine $expectedExecutablePath) { return $false }",
    "    if ([string] $ready.processId -notmatch '^[1-9]\\d*$' -or [string] $ready.readyAtEpochMs -notmatch '^[1-9]\\d*$') { return $false }",
    '    $readyAt = [Convert]::ToInt64($ready.readyAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)',
    '    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '    if ($readyAt -lt ($notBeforeEpochMs - 2000L) -or $readyAt -gt ($now + 60000L)) { return $false }',
    '    $readyProcessId = [Convert]::ToInt32($ready.processId, [Globalization.CultureInfo]::InvariantCulture)',
    "    $process = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $readyProcessId) -ErrorAction Stop | Select-Object -First 1)[0]",
    '    if ($null -eq $process -or ([string] $process.SessionId) -cne $expectedSessionId -or -not (Test-FullyQualifiedWindowsPath ([string] $process.ExecutablePath)) -or ([IO.Path]::GetFullPath([string] $process.ExecutablePath)) -ine $expectedExecutablePath) { return $false }',
    '    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop',
    '    if ($null -eq $owner -or [int] $owner.ReturnValue -ne 0 -or ([string] $owner.Sid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant()) { return $false }',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    'function Test-TargetUserProcess([string] $path, [string] $expectedUserSid, [string] $expectedSessionId) {',
    '  try {',
    '    foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {',
    '      if ($null -eq $process -or ([string] $process.SessionId) -cne $expectedSessionId -or [string]::IsNullOrWhiteSpace([string] $process.ExecutablePath)) { continue }',
    '      if (-not (Test-FullyQualifiedWindowsPath ([string] $process.ExecutablePath)) -or ([IO.Path]::GetFullPath([string] $process.ExecutablePath)) -ine $path) { continue }',
    '      try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop } catch { continue }',
    '      if ($null -ne $owner -and [int] $owner.ReturnValue -eq 0 -and ([string] $owner.Sid).ToUpperInvariant() -ceq $expectedUserSid.ToUpperInvariant()) { return $true }',
    '    }',
    '    return $false',
    '  } catch {',
    '    return $false',
    '  }',
    '}',
    'function Start-YouYuAfterUpdate([string] $path, [string] $argument, [string] $readyVersion, [bool] $resumeProxy) {',
    '  $lastStartError = $null',
    '  for ($attempt = 0; $attempt -lt 3; $attempt += 1) {',
    '    try {',
    '      Initialize-UpdateRelaunchChallenge $relaunchAcknowledgementPath $arguments[8]',
    '      $challengeCreatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '      [string[]] $relaunchArguments = @($argument)',
    `      if ($resumeProxy) { $relaunchArguments += '${resumeProxyAfterRelaunchArgument}' }`,
    `      $relaunchArguments += '${updateRelaunchAcknowledgementPathArgument}'`,
    '      $relaunchArguments += $relaunchAcknowledgementPath',
    `      $relaunchArguments += '${updateRelaunchAcknowledgementNonceArgument}'`,
    '      $relaunchArguments += $arguments[6]',
    "      $relaunchArgumentLine = [string]::Join(' ', @($relaunchArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string] $_) $false }))",
    '      [void] (Start-Process -FilePath $path -ArgumentList $relaunchArgumentLine -WindowStyle Hidden -PassThru)',
    '      $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)',
    '      while ([DateTimeOffset]::UtcNow -lt $readyDeadline) {',
    '        if (Test-AuthenticatedUpdateRelaunchAcknowledgement $relaunchAcknowledgementPath $arguments[6] $readyVersion $path $arguments[8] $arguments[10] $challengeCreatedAt) {',
    '          Remove-Item -LiteralPath $relaunchAcknowledgementPath -Force -ErrorAction SilentlyContinue',
    '          return',
    '        }',
    '        Start-Sleep -Milliseconds 100',
    '      }',
    "      $lastStartError = 'YouYu did not confirm that its main window was ready'",
    '    } catch {',
    '      $lastStartError = $_',
    '    } finally {',
    '      Remove-Item -LiteralPath $relaunchAcknowledgementPath -Force -ErrorAction SilentlyContinue',
    '    }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  if ($null -ne $lastStartError) { throw $lastStartError }',
    "  throw 'YouYu could not be reopened after update'",
    '}',
    'function Start-LegacyYouYuRecovery([string] $path, [bool] $resumeProxy) {',
    `  [string[]] $legacyArguments = @('${updateInstallFailedRelaunchArgument}')`,
    `  if ($resumeProxy) { $legacyArguments += '${resumeProxyAfterRelaunchArgument}' }`,
    "  $legacyArgumentLine = [string]::Join(' ', @($legacyArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string] $_) $false }))",
    '  [void] (Start-Process -FilePath $path -ArgumentList $legacyArgumentLine -WindowStyle Hidden -PassThru)',
    '  $legacyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)',
    '  while ([DateTimeOffset]::UtcNow -lt $legacyDeadline) {',
    '    if (Test-TargetUserProcess $path $arguments[8] $arguments[10]) {',
    '      Start-Sleep -Milliseconds 1500',
    '      if (Test-TargetUserProcess $path $arguments[8] $arguments[10]) { return }',
    '    }',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    "  throw 'the previous YouYu version could not be reopened after update failure'",
    '}',
    'function Get-YouYuProductVersion([string] $path) {',
    "  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'YouYu executable is missing' }",
    '  $versionText = ([string] (Get-Item -LiteralPath $path -Force -ErrorAction Stop).VersionInfo.ProductVersion).Trim()',
    '  $version = [Version] $versionText',
    "  return ('{0}.{1}.{2}' -f $version.Major, $version.Minor, $version.Build)",
    '}',
    '$handoffAcknowledged = $false',
    '$installerBoundaryClosed = $false',
    '# YOUYU_UPDATE_SUPERVISOR_START',
    'Initialize-AuthenticatedUpdateCancellation $cancellationPath $arguments[6] $arguments[8]',
    '$elevatedPayloadJson = [pscustomobject]@{ installerPath = $installerPath; arguments = @($arguments); installerTimeoutMs = $installerTimeoutMs; cancellationPath = $cancellationPath; cancellationNonce = $arguments[6]; targetUserSid = $arguments[8] } | ConvertTo-Json -Compress',
    "$elevatedPayloadPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($handoffPath), ('youyu-update-elevated-' + $arguments[6] + '.json'))",
    'Write-AuthenticatedElevatedInstallerPayload $elevatedPayloadPath $elevatedPayloadJson $arguments[8]',
    "$elevatedWrapperArgumentLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (ConvertTo-WindowsCommandLineArgument $elevatedInstallerWrapperPath $true) + ' ' + (ConvertTo-WindowsCommandLineArgument $elevatedPayloadPath $true)",
    "try { $started = Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe')) -ArgumentList $elevatedWrapperArgumentLine -Verb RunAs -WindowStyle Hidden -PassThru } finally { }",
    "if ($null -eq $started -or [int] $started.Id -le 0) { throw 'elevated update installer did not start' }",
    '[void] $started.WaitForExit(750)',
    "if ($started.HasExited) { throw 'elevated update installer exited before the app handoff completed' }",
    '$acknowledgementDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($acknowledgementTimeoutMs)',
    'while ($true) {',
    "  if ($started.HasExited) { throw 'elevated update installer exited before acknowledging the authenticated handoff' }",
    '  if (Test-AuthenticatedUpdateAcknowledgement $acknowledgementPath $handoffPath $arguments[6] $arguments[8] $arguments[10] ([string] $acknowledgement.targetProcessId) $targetExecutablePath) {',
    '    Start-Sleep -Milliseconds 150',
    "    if ($started.HasExited) { throw 'elevated update installer exited after acknowledging the authenticated handoff' }",
    '    $handoffAcknowledged = $true',
    '    Write-AuthenticatedSupervisorReady $supervisorReadyPath $handoffPath $arguments[6] $arguments[8]',
    '    break',
    '  }',
    "  if ([DateTimeOffset]::UtcNow -ge $acknowledgementDeadline) { throw 'elevated update installer did not acknowledge the authenticated handoff in time' }",
    `  Start-Sleep -Milliseconds ${updateInstallerAcknowledgementPollIntervalMs}`,
    '}',
    "if (-not $started.WaitForExit($installerTimeoutMs + 30000)) { throw 'elevated update wrapper did not close after its bounded installer supervision' }",
    "if (Test-Path -LiteralPath $cancellationPath) { throw 'elevated update wrapper did not confirm that the installer process tree closed' }",
    '$installerBoundaryClosed = $true',
    "if ([int] $started.ExitCode -ne 0) { throw ('elevated update installer failed with exit code ' + [int] $started.ExitCode) }",
    "if (Test-Path -LiteralPath $handoffPath -PathType Leaf) { throw 'update installer exited without consuming the authenticated handoff' }",
    'Remove-Item -LiteralPath $acknowledgementPath -Force -ErrorAction SilentlyContinue',
    '$installedVersionText = Get-YouYuProductVersion $targetExecutablePath',
    "if ($installedVersionText -cne $expectedVersionText) { throw ('installed YouYu version ' + $installedVersionText + ' does not match expected ' + $expectedVersionText) }",
    "Start-YouYuAfterUpdate $targetExecutablePath '--updated' $expectedVersionText $resumeProxyAfterRelaunch",
    'exit 0',
    '# YOUYU_UPDATE_SUPERVISOR_OUTER_CATCH',
    '} catch {',
    '  $launchErrorMessage = $_.Exception.Message',
    '  if (-not [string]::IsNullOrWhiteSpace($elevatedPayloadPath)) { Remove-Item -LiteralPath $elevatedPayloadPath -Force -ErrorAction SilentlyContinue }',
    '  if ($cancellationPathValidated -and $null -ne (Get-Command Signal-AuthenticatedUpdateCancellation -CommandType Function -ErrorAction SilentlyContinue)) { [void] (Signal-AuthenticatedUpdateCancellation $cancellationPath $arguments[6] $arguments[8]) }',
    '  if ($null -ne $started) {',
    '    try {',
    '      if (-not $started.HasExited) { [void] $started.WaitForExit(30000) }',
    '      if ($started.HasExited -and -not (Test-Path -LiteralPath $cancellationPath)) { $installerBoundaryClosed = $true }',
    '    } catch { }',
    '  }',
    '  if ($cancellationPathValidated -and $installerBoundaryClosed -and $null -ne (Get-Command Remove-AuthenticatedUpdateCancellation -CommandType Function -ErrorAction SilentlyContinue)) { Remove-AuthenticatedUpdateCancellation $cancellationPath }',
    '  if ($handoffAcknowledged -and $installerBoundaryClosed) {',
    '    Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $acknowledgementPath -Force -ErrorAction SilentlyContinue',
    '    try {',
    '      $recoveryVersionText = Get-YouYuProductVersion $targetExecutablePath',
    `      if ($recoveryVersionText -ceq $expectedVersionText) { Start-YouYuAfterUpdate $targetExecutablePath '${updateInstallFailedRelaunchArgument}' $recoveryVersionText $resumeProxyAfterRelaunch } else { Start-LegacyYouYuRecovery $targetExecutablePath $resumeProxyAfterRelaunch }`,
    '    } catch { }',
    '  }',
    "  [Console]::Error.WriteLine(('YouYu update launcher: ' + $launchErrorMessage))",
    '  exit 1',
    '}'
  ].join('\n');
}

export function sanitizeUpdateInstallerLauncherDiagnostic(value: string): string {
  const marker = 'YouYu update launcher:';
  const markerIndex = value.lastIndexOf(marker);
  const relevant = markerIndex >= 0 ? value.slice(markerIndex) : value;
  const withoutControlCharacters = Array.from(relevant, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('');
  return withoutControlCharacters
    .replace(/#<\s*CLIXML/gi, ' ')
    .replace(/<Objs\b[\s\S]*?(?:<\/Objs>|$)/gi, ' ')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<nonce>')
    .replace(/S-1-\d+(?:-\d+){2,14}/gi, '<sid>')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export async function launchDownloadedUpdateInstaller(options: UpdateInstallerLaunchOptions): Promise<void> {
  const installerPath = resolveDownloadedUpdateInstallerPath({ downloadedPaths: [options.installerPath] });
  const expectedVersion = options.expectedVersion.trim();
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error('expected update version is invalid');
  const supervisorReadyTimeoutMs = options.supervisorReadyTimeoutMs ?? updateInstallerSupervisorReadyTimeoutMs;
  if (
    !Number.isSafeInteger(supervisorReadyTimeoutMs) ||
    supervisorReadyTimeoutMs <= 0 ||
    supervisorReadyTimeoutMs > 300_000
  ) {
    throw new Error('update installer supervisor readiness timeout is invalid');
  }
  const handoffArguments = createUpdateInstallerHandoffArguments(options.handoff);
  const acknowledgementPath = resolveUpdateInstallerHandoffAcknowledgementPath(options.handoff);
  const supervisorReadyPath = resolveUpdateInstallerSupervisorReadyPath(options.handoff);
  const cancellationPath = resolveUpdateInstallerCancellationPath(options.handoff);
  const nodeCleanupMarginMs = Math.min(
    updateInstallerNodeCleanupMarginMs,
    Math.max(1, Math.floor(supervisorReadyTimeoutMs / 5))
  );
  const bootstrapCleanupGraceMs = Math.min(
    updateInstallerBootstrapCleanupGraceMs,
    Math.max(1, Math.floor((supervisorReadyTimeoutMs - nodeCleanupMarginMs) / 3))
  );
  const bootstrapTimeoutMs = Math.max(1, supervisorReadyTimeoutMs - nodeCleanupMarginMs - bootstrapCleanupGraceMs);
  const payload = Buffer.from(
    JSON.stringify({
      installerPath,
      expectedVersion,
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
      supervisorReady: {
        path: supervisorReadyPath,
        nonce: handoffArguments[3],
        targetUserSid: handoffArguments[5]
      },
      cancellation: {
        path: cancellationPath,
        nonce: handoffArguments[3],
        targetUserSid: handoffArguments[5]
      },
      acknowledgementTimeoutMs: updateInstallerAcknowledgementTimeoutMs,
      installerTimeoutMs: updateInstallerExecutionTimeoutMs,
      resumeProxyAfterRelaunch: options.resumeProxyAfterRelaunch
    }),
    'utf8'
  ).toString('base64');
  const environment = createWindowsPowerShellEnvironment(options.environment ?? process.env);
  environment[updateInstallerLauncherPayloadEnvironment] = payload;
  const supervisorTransport = createUpdateInstallerSupervisorTransport(createUpdateInstallerLauncherScript());
  environment[updateInstallerSupervisorScriptEnvironment] = supervisorTransport.environmentValue;
  environment[updateInstallerSupervisorLoaderEnvironment] = supervisorTransport.encodedLoaderCommand;
  environment[updateInstallerBootstrapPayloadEnvironment] = Buffer.from(
    JSON.stringify({
      version: '1',
      readyPath: supervisorReadyPath,
      handoffPath: handoffArguments[1],
      cancellationPath,
      nonce: handoffArguments[3],
      targetUserSid: handoffArguments[5],
      timeoutMs: bootstrapTimeoutMs,
      cleanupTimeoutMs: bootstrapCleanupGraceMs
    }),
    'utf8'
  ).toString('base64');
  const powershellPath = options.powershellPath ?? resolveWindowsPowerShellPath(options.environment?.SystemRoot);
  const bootstrapTransport = createUpdateInstallerBootstrapTransport();
  environment[updateInstallerBootstrapScriptEnvironment] = bootstrapTransport.environmentValue;
  const launcher = (options.spawnLauncher ?? spawn)(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', bootstrapTransport.encodedLoaderCommand],
    { windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment }
  );
  let launcherOutput = '';
  let launcherDiagnostic = '';
  launcher.stderr?.setEncoding('utf8');
  launcher.stderr?.on('data', (chunk: string | Buffer) => {
    if (launcherDiagnostic.length >= 4096) return;
    launcherDiagnostic += chunk.toString().slice(0, 4096 - launcherDiagnostic.length);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let readinessTimer: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(readinessTimer);
      callback();
    };
    readinessTimer = setTimeout(() => {
      signalUpdateInstallerCancellation(options.handoff);
      try {
        launcher.kill();
      } catch {
        // The deferred handoff cleanup will recover the still-running app.
      }
      finish(() => reject(new Error('update installer supervisor did not become ready in time')));
    }, supervisorReadyTimeoutMs);
    readinessTimer.unref();
    const finishReady = () => {
      if (!launcherOutput.split(/\r?\n/).includes(updateInstallerSupervisorReadyMessage)) return;
      if (typeof launcher.unref === 'function') launcher.unref();
      launcher.stdout?.destroy();
      launcher.stderr?.destroy();
      finish(resolve);
    };
    launcher.stdout?.setEncoding('utf8');
    launcher.stdout?.on('data', (chunk: string | Buffer) => {
      if (launcherOutput.length < 4096) {
        launcherOutput += chunk.toString().slice(0, 4096 - launcherOutput.length);
      }
      finishReady();
    });
    launcher.once('error', (error) => {
      signalUpdateInstallerCancellation(options.handoff);
      finish(() => reject(error));
    });
    launcher.once('close', (code, signal) => {
      finishReady();
      if (settled) return;
      const exitDetail = code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : 'unknown exit state';
      const diagnostic = sanitizeUpdateInstallerLauncherDiagnostic(launcherDiagnostic);
      const detail = diagnostic ? `${exitDetail}: ${diagnostic}` : exitDetail;
      signalUpdateInstallerCancellation(options.handoff);
      finish(() =>
        reject(new Error('update installer supervisor exited before authenticated readiness (' + detail + ')'))
      );
    });
  });
}
