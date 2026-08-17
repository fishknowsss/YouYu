$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cancellationPath = $null
$installer = $null
$installerBoundaryClosed = $false
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $payloadText = $null
  if ($args.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace([string] $args[0])) {
    $payloadPath = [string] $args[0]
    if ($payloadPath.IndexOf([char] 0) -ge 0 -or $payloadPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { throw 'elevated installer payload file is invalid' }
    $payloadPath = [IO.Path]::GetFullPath($payloadPath)
    $payloadItem = Get-Item -LiteralPath $payloadPath -Force -ErrorAction Stop
    if ($payloadItem.PSIsContainer -or ($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $payloadItem.Length -le 0 -or $payloadItem.Length -gt 4096) { throw 'elevated installer payload file is invalid' }
    $payloadText = [IO.File]::ReadAllText($payloadPath, (New-Object Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
  } else {
    $payloadText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YOUYU_UPDATE_ELEVATED_INSTALL_PAYLOAD))
    Remove-Item Env:YOUYU_UPDATE_ELEVATED_INSTALL_PAYLOAD -ErrorAction SilentlyContinue
  }
  $payload = $payloadText | ConvertFrom-Json
  if ($null -eq $payload -or @($payload.PSObject.Properties.Name).Count -ne 6 -or $payload.PSObject.Properties.Name -notcontains 'installerPath' -or $payload.PSObject.Properties.Name -notcontains 'arguments' -or $payload.PSObject.Properties.Name -notcontains 'installerTimeoutMs' -or $payload.PSObject.Properties.Name -notcontains 'cancellationPath' -or $payload.PSObject.Properties.Name -notcontains 'cancellationNonce' -or $payload.PSObject.Properties.Name -notcontains 'targetUserSid') { throw 'elevated installer payload is invalid' }
  function Test-FullyQualifiedWindowsPath([string] $value) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOf([char] 0) -ge 0) { return $false }
    if ($value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { return $false }
    try { [void] [IO.Path]::GetFullPath($value); return $true } catch { return $false }
  }
  function ConvertTo-WindowsCommandLineArgument([string] $value, [bool] $forceQuote) {
    if ($value.Length -eq 0) { return '""' }
    if (-not $forceQuote -and $value -notmatch '[\s"]') { return $value }
    $escaped = [Text.RegularExpressions.Regex]::Replace($value, '(\\*)"', '$1$1\"')
    $escaped = [Text.RegularExpressions.Regex]::Replace($escaped, '(\\*)$', '$1$1')
    return '"' + $escaped + '"'
  }
  function Test-PrivateUserFile([string] $path, [string] $expectedUserSid) {
    try {
      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 4096) { return $false }
      $acl = [IO.File]::GetAccessControl($path)
      $expectedSid = $expectedUserSid.ToUpperInvariant()
      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant() -cne $expectedSid -or -not $acl.AreAccessRulesProtected) { return $false }
      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
      $ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()
      $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl
      return $ruleSid -ceq $expectedSid -and (([int64] $rules[0].FileSystemRights) -band $fullControl) -eq $fullControl
    } catch {
      return $false
    }
  }
  function Get-UpdateCancellationState([string] $path, [string] $expectedNonce, [string] $expectedUserSid) {
    if (-not (Test-PrivateUserFile $path $expectedUserSid)) { return 'invalid' }
    try {
      $control = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
      $required = @('version', 'nonce', 'targetUserSid', 'state', 'updatedAtEpochMs')
      if ($null -eq $control -or @($control.PSObject.Properties.Name).Count -ne $required.Count) { return 'invalid' }
      foreach ($property in $required) { if ($control.PSObject.Properties.Name -notcontains $property) { return 'invalid' } }
      if ([string] $control.version -cne '1' -or ([string] $control.nonce).ToLowerInvariant() -cne $expectedNonce -or ([string] $control.targetUserSid).ToUpperInvariant() -cne $expectedUserSid.ToUpperInvariant()) { return 'invalid' }
      if ([string] $control.updatedAtEpochMs -notmatch '^[1-9]\d*$') { return 'invalid' }
      $updatedAt = [Convert]::ToInt64($control.updatedAtEpochMs, [Globalization.CultureInfo]::InvariantCulture)
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($updatedAt -gt ($now + 60000L) -or ($now - $updatedAt) -gt 900000L) { return 'invalid' }
      $state = [string] $control.state
      if ($state -cne 'armed' -and $state -cne 'cancelled') { return 'invalid' }
      return $state
    } catch {
      return 'invalid'
    }
  }
  function Get-ProcessTreeIds([int] $rootProcessId) {
    $inventory = @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 2 -ErrorAction Stop)
    $known = @{}
    $known[$rootProcessId] = $true
    do {
      $changed = $false
      foreach ($entry in $inventory) {
        $processIdValue = [int] $entry.ProcessId
        $parentProcessIdValue = [int] $entry.ParentProcessId
        if ($processIdValue -le 0 -or -not $known.ContainsKey($parentProcessIdValue) -or $known.ContainsKey($processIdValue)) { continue }
        $known[$processIdValue] = $true
        $changed = $true
      }
    } while ($changed)
    return @($known.Keys | ForEach-Object { [int] $_ })
  }
  function Stop-InstallerProcessTree([Diagnostics.Process] $process) {
    if ($null -eq $process -or [int] $process.Id -le 0) { throw 'installer process tree is unavailable' }
    $rootProcessId = [int] $process.Id
    $trackedProcessIds = @($rootProcessId)
    $inventoryAvailable = $false
    $taskkillPath = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'taskkill.exe')
    if (-not (Test-FullyQualifiedWindowsPath $taskkillPath) -or -not (Test-Path -LiteralPath $taskkillPath -PathType Leaf)) { throw 'canonical taskkill is unavailable' }
    $taskkillItem = Get-Item -LiteralPath $taskkillPath -Force -ErrorAction Stop
    if ($taskkillItem.PSIsContainer -or ($taskkillItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'canonical taskkill is invalid' }
    $taskkillArguments = '/PID ' + $rootProcessId + ' /T /F'
    $taskkill = Start-Process -FilePath $taskkillPath -ArgumentList $taskkillArguments -WindowStyle Hidden -PassThru
    if ($null -eq $taskkill -or [int] $taskkill.Id -le 0) { throw 'canonical taskkill did not start' }
    try { $trackedProcessIds = @(Get-ProcessTreeIds $rootProcessId); $inventoryAvailable = $true } catch { }
    $taskkillFinished = $taskkill.WaitForExit(15000)
    if (-not $taskkillFinished) {
      try { $taskkill.Kill() } catch { }
      try { [void] $taskkill.WaitForExit(2000) } catch { }
    }
    $taskkillExitCode = if ($taskkillFinished) { [int] $taskkill.ExitCode } else { -1 }
    $treeDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)
    while ([DateTimeOffset]::UtcNow -lt $treeDeadline) {
      $surviving = @($trackedProcessIds | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
      if ($surviving.Count -eq 0) {
        if ($taskkillExitCode -eq 0 -or $inventoryAvailable) { return }
        throw ('canonical taskkill failed with exit code ' + $taskkillExitCode + ' and process-tree inventory was unavailable')
      }
      Start-Sleep -Milliseconds 100
    }
    throw 'installer process tree did not close'
  }
  $installerPath = [string] $payload.installerPath
  if (-not (Test-FullyQualifiedWindowsPath $installerPath) -or [IO.Path]::GetExtension($installerPath) -ine '.exe') { throw 'elevated installer path is invalid' }
  $installerPath = [IO.Path]::GetFullPath($installerPath)
  [string[]] $arguments = @($payload.arguments)
  if ($arguments.Count -ne 11 -or $arguments[0] -cne '--updated' -or $arguments[1] -cne '/S' -or $arguments[2] -cne '--force-run') { throw 'elevated installer arguments are invalid' }
  if ($arguments[3] -cne '--youyu-handoff-path' -or -not (Test-FullyQualifiedWindowsPath $arguments[4]) -or $arguments[5] -cne '--youyu-handoff-nonce' -or $arguments[6] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $arguments[7] -cne '--youyu-target-user-sid' -or $arguments[8] -notmatch '^S-1-\d+(?:-\d+){2,14}$' -or $arguments[9] -cne '--youyu-target-session-id' -or $arguments[10] -notmatch '^[1-9]\d*$') { throw 'elevated installer handoff arguments are invalid' }
  $cancellationPath = [string] $payload.cancellationPath
  $cancellationNonce = ([string] $payload.cancellationNonce).ToLowerInvariant()
  $targetUserSid = ([string] $payload.targetUserSid).ToUpperInvariant()
  if (-not (Test-FullyQualifiedWindowsPath $cancellationPath) -or $cancellationNonce -cne $arguments[6] -or $targetUserSid -cne $arguments[8].ToUpperInvariant()) { throw 'elevated installer cancellation identity is invalid' }
  $cancellationPath = [IO.Path]::GetFullPath($cancellationPath)
  $expectedCancellationPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($arguments[4])), ('youyu-update-cancel-' + $arguments[6] + '.json'))
  if ($cancellationPath -ine $expectedCancellationPath) { throw 'elevated installer cancellation path is invalid' }
  $initialCancellationState = Get-UpdateCancellationState $cancellationPath $cancellationNonce $targetUserSid
  if ($initialCancellationState -ceq 'cancelled') { exit 126 }
  if ($initialCancellationState -cne 'armed') { throw 'elevated installer cancellation marker is invalid' }
  if ([string] $payload.installerTimeoutMs -notmatch '^[1-9]\d*$') { throw 'elevated installer timeout is invalid' }
  $installerTimeoutMs = [Convert]::ToInt32($payload.installerTimeoutMs, [Globalization.CultureInfo]::InvariantCulture)
  if ($installerTimeoutMs -lt 30000 -or $installerTimeoutMs -gt 1800000) { throw 'elevated installer timeout is invalid' }
  $argumentLine = [string]::Join(' ', @(for ($index = 0; $index -lt $arguments.Count; $index += 1) { ConvertTo-WindowsCommandLineArgument ([string] $arguments[$index]) (($index -ge 4) -and (($index % 2) -eq 0)) }))
  $installer = Start-Process -FilePath $installerPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
  if ($null -eq $installer -or [int] $installer.Id -le 0) { throw 'elevated installer did not start' }
  $installerDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($installerTimeoutMs)
  while (-not $installer.HasExited) {
    $cancellationState = Get-UpdateCancellationState $cancellationPath $cancellationNonce $targetUserSid
    if ($cancellationState -cne 'armed') {
      Stop-InstallerProcessTree $installer
      $installerBoundaryClosed = $true
      if ($cancellationState -ceq 'cancelled') { exit 126 }
      throw 'elevated installer cancellation marker became invalid'
    }
    if ([DateTimeOffset]::UtcNow -ge $installerDeadline) {
      Stop-InstallerProcessTree $installer
      $installerBoundaryClosed = $true
      exit 124
    }
    [void] $installer.WaitForExit(200)
  }
  $installerBoundaryClosed = $true
  exit [int] $installer.ExitCode
} catch {
  [Console]::Error.WriteLine(('YouYu elevated update wrapper: ' + $_.Exception.Message))
  exit 125
} finally {
  if (($null -eq $installer -or $installerBoundaryClosed) -and -not [string]::IsNullOrWhiteSpace($cancellationPath)) {
    try {
      $cancellationItem = Get-Item -LiteralPath $cancellationPath -Force -ErrorAction SilentlyContinue
      if ($null -ne $cancellationItem -and -not $cancellationItem.PSIsContainer -and -not ($cancellationItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $cancellationPath -Force -ErrorAction SilentlyContinue }
    } catch { }
  }
}
