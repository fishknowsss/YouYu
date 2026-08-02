param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('WaitForExit', 'Verify', 'AcknowledgeAndWait', 'Consume')]
  [string] $Action,

  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  [string] $HandoffPath = '',
  [string] $HandoffNonce = '',
  [string] $ExpectedUserSid = '',
  [string] $ExpectedSessionId = '',
  [ValidateRange(1, 300)]
  [int] $TimeoutSeconds = 45,
  [switch] $RequireHandoff,
  [switch] $AllowLegacyUpdateBridge,
  [string] $InstallerVersion = '',

  # Test/QA-only seams. Production WaitForExit, AcknowledgeAndWait, and Consume reject all four.
  [string] $ProcessInventoryPath = '',
  [string] $LegacyVersionInfoPath = '',
  [switch] $SkipFileOwnerCheck,
  [long] $CurrentTimeEpochMs = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$handoffLifetimeLimitMs = 900000L
$implicitHandoffDiscoveryLifetimeMs = 300000L
$legacyBridgeTargetVersion = '1.7.0'
$legacyBridgeMaximumSourceVersion = [Version]::new(1, 6, 8, 0)
$legacyBridgeActive = $false

function Normalize-UserSid([object] $Value) {
  if ($null -eq $Value) { throw 'Windows user SID is missing.' }
  $sid = ([string] $Value).Trim().ToUpperInvariant()
  if ($sid -notmatch '^S-1-\d+(?:-\d+){2,14}$') { throw 'Windows user SID is invalid.' }
  if (
    $sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20') -or
    $sid.StartsWith('S-1-5-80-') -or
    $sid.EndsWith('-500')
  ) {
    throw 'Windows user SID is not a standard-user boundary.'
  }
  return $sid
}

function ConvertTo-RequiredInt64([object] $Value, [string] $Name) {
  if ($null -eq $Value -or ([string] $Value) -notmatch '^\d+$') { throw "$Name is invalid." }
  try {
    return [Convert]::ToInt64($Value, [Globalization.CultureInfo]::InvariantCulture)
  } catch {
    throw "$Name is invalid."
  }
}

function Get-RequiredProperty([object] $Value, [string] $Name) {
  if ($null -eq $Value -or $Value.PSObject.Properties.Name -notcontains $Name) {
    throw "Handoff record property '$Name' is missing."
  }
  return $Value.$Name
}

function Normalize-ExecutablePath([object] $Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string] $Value)) {
    throw 'Executable path is missing.'
  }
  return [IO.Path]::GetFullPath(([string] $Value).Trim())
}

function Get-LegacyVersionInfo([IO.FileInfo] $Executable) {
  if (-not [string]::IsNullOrWhiteSpace($LegacyVersionInfoPath)) {
    $rawVersionInfo = Get-Content -LiteralPath ([IO.Path]::GetFullPath($LegacyVersionInfoPath)) -Raw -Encoding UTF8
    return $rawVersionInfo | ConvertFrom-Json
  }
  return $Executable.VersionInfo
}

function Assert-LegacyUpdateBridgeEligibility([string] $ExpectedExecutablePath) {
  if (-not $AllowLegacyUpdateBridge) {
    throw 'An authenticated update handoff is required.'
  }
  if ($InstallerVersion.Trim() -cne $legacyBridgeTargetVersion) {
    throw 'The legacy update bridge is not available for this installer version.'
  }
  if (-not (Test-Path -LiteralPath $ExpectedExecutablePath -PathType Leaf)) {
    throw 'The legacy update bridge requires an existing YouYu executable at the installation target.'
  }

  $executable = Get-Item -LiteralPath $ExpectedExecutablePath -Force
  if ($executable.PSIsContainer -or ($executable.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The legacy update bridge requires a regular, non-reparse YouYu executable.'
  }

  $versionInfo = Get-LegacyVersionInfo $executable
  $productName = ([string] (Get-RequiredProperty $versionInfo 'ProductName')).Trim()
  $companyName = ([string] (Get-RequiredProperty $versionInfo 'CompanyName')).Trim()
  if ($productName -cne 'YouYu' -or $companyName -cne '118 Studio') {
    throw 'The legacy update bridge rejected the installed executable identity.'
  }

  $versionComponents = @(
    ConvertTo-RequiredInt64 (Get-RequiredProperty $versionInfo 'FileMajorPart') 'Installed file major version'
    ConvertTo-RequiredInt64 (Get-RequiredProperty $versionInfo 'FileMinorPart') 'Installed file minor version'
    ConvertTo-RequiredInt64 (Get-RequiredProperty $versionInfo 'FileBuildPart') 'Installed file build version'
    ConvertTo-RequiredInt64 (Get-RequiredProperty $versionInfo 'FilePrivatePart') 'Installed file private version'
  )
  if (@($versionComponents | Where-Object { $_ -gt [int]::MaxValue }).Count -gt 0) {
    throw 'The installed YouYu file version is invalid.'
  }
  $installedVersion = [Version]::new(
    [int] $versionComponents[0],
    [int] $versionComponents[1],
    [int] $versionComponents[2],
    [int] $versionComponents[3]
  )
  if ($installedVersion -gt $legacyBridgeMaximumSourceVersion) {
    throw 'The installed YouYu version requires an authenticated update handoff.'
  }

  $script:legacyBridgeActive = $true
}

function Get-CurrentInstallerBoundaryIdentity {
  $installerProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
  if ($null -eq $installerProcess) { throw 'Cannot resolve the installer process identity.' }
  $owner = Invoke-CimMethod -InputObject $installerProcess -MethodName GetOwnerSid -ErrorAction Stop
  if ([int] $owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
    throw 'Cannot resolve the installer process owner SID.'
  }
  $sessionId = ConvertTo-RequiredInt64 $installerProcess.SessionId 'Installer Windows session'
  if ($sessionId -le 0 -or $sessionId -gt [int]::MaxValue) {
    throw 'Installer Windows session is invalid.'
  }
  return [pscustomobject]@{
    UserSid = Normalize-UserSid $owner.Sid
    SessionId = [int] $sessionId
  }
}

function Find-ImplicitUpdateHandoff([string] $ExpectedExecutablePath) {
  # Electron-updater 6.x launches a per-machine NSIS installer across UAC without
  # guaranteeing custom environment propagation. This compatibility lookup is
  # deliberately scoped to the elevated installer's own SID/session LocalAppData\Temp.
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) { return $null }
  $tempDirectory = [IO.Path]::GetFullPath([IO.Path]::Combine($localAppData, 'Temp'))
  if (-not (Test-Path -LiteralPath $tempDirectory -PathType Container)) { return $null }
  $tempItem = Get-Item -LiteralPath $tempDirectory -Force
  if ($tempItem.PSIsContainer -eq $false -or ($tempItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return $null
  }

  # No structurally plausible candidate can yield an implicit handoff. Delay
  # resolving the installer's SID/session until one exists so
  # the separately guarded no-handoff legacy path is not rejected by an
  # irrelevant identity lookup. Once a candidate exists, its owner, record SID,
  # and session are still all checked against this exact installer boundary.
  $now = if ($CurrentTimeEpochMs -gt 0) { $CurrentTimeEpochMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $candidateItems = @(
    foreach ($item in @(Get-ChildItem -LiteralPath $tempDirectory -Force -File -Filter 'youyu-update-handoff-*.json' -ErrorAction SilentlyContinue)) {
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
      if ($item.Length -le 0 -or $item.Length -gt 8192) { continue }
      $nameMatch = [Text.RegularExpressions.Regex]::Match(
        $item.Name,
        '^youyu-update-handoff-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      if (-not $nameMatch.Success) { continue }
      try {
        # This is an untrusted prefilter only. The selected record is read again
        # after its installer boundary and file owner have both been verified.
        $prefilterRecord = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((ConvertTo-RequiredInt64 (Get-RequiredProperty $prefilterRecord 'version') 'Handoff version') -ne 1) { continue }
        $candidateNonce = $nameMatch.Groups[1].Value.ToLowerInvariant()
        if (([string] (Get-RequiredProperty $prefilterRecord 'nonce')).Trim().ToLowerInvariant() -cne $candidateNonce) { continue }
        $prefilterExecutablePath = Normalize-ExecutablePath (Get-RequiredProperty $prefilterRecord 'executablePath')
        if ($prefilterExecutablePath -ine $ExpectedExecutablePath) { continue }
        $createdAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $prefilterRecord 'createdAtEpochMs') 'Handoff creation time'
        $expiresAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $prefilterRecord 'expiresAtEpochMs') 'Handoff expiration time'
        if ($expiresAt -le $createdAt -or ($expiresAt - $createdAt) -gt $handoffLifetimeLimitMs) { continue }
        if ($createdAt -lt ($now - $implicitHandoffDiscoveryLifetimeMs) -or $createdAt -gt ($now + 60000L) -or $expiresAt -lt $now) {
          continue
        }
      } catch {
        continue
      }
      [pscustomobject]@{
        Item = $item
        Nonce = $candidateNonce
      }
    }
  )
  if ($candidateItems.Count -eq 0) { return $null }

  $identity = Get-CurrentInstallerBoundaryIdentity
  $candidates = @()
  foreach ($candidate in $candidateItems) {
    $item = $candidate.Item
    $candidateNonce = $candidate.Nonce
    try {
      $acl = Get-Acl -LiteralPath $item.FullName
      $ownerSid = Normalize-UserSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($ownerSid -ine $identity.UserSid) { continue }

      $record = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ((ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'version') 'Handoff version') -ne 1) { continue }
      if (([string] (Get-RequiredProperty $record 'nonce')).Trim().ToLowerInvariant() -cne $candidateNonce) { continue }
      $recordSid = Normalize-UserSid (Get-RequiredProperty $record 'targetUserSid')
      if ($recordSid -ine $identity.UserSid) { continue }
      $recordSession = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'targetSessionId') 'Handoff Windows session'
      if ($recordSession -ne $identity.SessionId) { continue }
      $recordProcessId = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'targetProcessId') 'Handoff process id'
      if ($recordProcessId -le 0 -or $recordProcessId -gt [int]::MaxValue) { continue }
      $recordExecutablePath = Normalize-ExecutablePath (Get-RequiredProperty $record 'executablePath')
      if ($recordExecutablePath -ine $ExpectedExecutablePath) { continue }
      $createdAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'createdAtEpochMs') 'Handoff creation time'
      $expiresAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'expiresAtEpochMs') 'Handoff expiration time'
      if ($expiresAt -le $createdAt -or ($expiresAt - $createdAt) -gt $handoffLifetimeLimitMs) { continue }
      if ($createdAt -lt ($now - $implicitHandoffDiscoveryLifetimeMs) -or $createdAt -gt ($now + 60000L) -or $expiresAt -lt $now) {
        continue
      }
      $candidates += [pscustomobject]@{
        HandoffPath = [IO.Path]::GetFullPath($item.FullName)
        HandoffNonce = $candidateNonce
        ExpectedUserSid = $identity.UserSid
        ExpectedSessionId = [string] $identity.SessionId
        CreatedAtEpochMs = $createdAt
      }
    } catch {
      # Untrusted or stale files in the caller's temp directory are ignored.
    }
  }

  $orderedCandidates = @($candidates | Sort-Object -Property @{ Expression = 'CreatedAtEpochMs'; Descending = $true }, @{ Expression = 'HandoffPath'; Descending = $false })
  if ($orderedCandidates.Count -eq 0) { return $null }
  return $orderedCandidates[0]
}

function Get-HandoffBoundary([string] $ExpectedExecutablePath) {
  if ([string]::IsNullOrWhiteSpace($script:HandoffPath)) {
    $script:HandoffPath = [Environment]::GetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_PATH')
  }
  if ([string]::IsNullOrWhiteSpace($script:HandoffNonce)) {
    $script:HandoffNonce = [Environment]::GetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_NONCE')
  }
  if ([string]::IsNullOrWhiteSpace($script:ExpectedUserSid)) {
    $script:ExpectedUserSid = [Environment]::GetEnvironmentVariable('YOUYU_UPDATE_TARGET_USER_SID')
  }
  if ([string]::IsNullOrWhiteSpace($script:ExpectedSessionId)) {
    $script:ExpectedSessionId = [Environment]::GetEnvironmentVariable('YOUYU_UPDATE_TARGET_SESSION_ID')
  }

  $provided = @(
      -not [string]::IsNullOrWhiteSpace($script:HandoffPath),
      -not [string]::IsNullOrWhiteSpace($script:HandoffNonce),
      -not [string]::IsNullOrWhiteSpace($script:ExpectedUserSid),
      -not [string]::IsNullOrWhiteSpace($script:ExpectedSessionId)
    )
  $providedCount = @($provided | Where-Object { $_ }).Count
  if ($providedCount -eq 0 -and $RequireHandoff) {
    $implicitHandoff = Find-ImplicitUpdateHandoff $ExpectedExecutablePath
    if ($null -ne $implicitHandoff) {
      $script:HandoffPath = $implicitHandoff.HandoffPath
      $script:HandoffNonce = $implicitHandoff.HandoffNonce
      $script:ExpectedUserSid = $implicitHandoff.ExpectedUserSid
      $script:ExpectedSessionId = $implicitHandoff.ExpectedSessionId
      $provided = @(
        -not [string]::IsNullOrWhiteSpace($script:HandoffPath),
        -not [string]::IsNullOrWhiteSpace($script:HandoffNonce),
        -not [string]::IsNullOrWhiteSpace($script:ExpectedUserSid),
        -not [string]::IsNullOrWhiteSpace($script:ExpectedSessionId)
      )
      $providedCount = @($provided | Where-Object { $_ }).Count
    }
  }
  if ($providedCount -eq 0) {
    if ($RequireHandoff) {
      Assert-LegacyUpdateBridgeEligibility $ExpectedExecutablePath
    }
    return $null
  }
  if ($providedCount -ne 4) { throw 'Update handoff environment is incomplete.' }

  $nonce = $script:HandoffNonce.Trim().ToLowerInvariant()
  if ($nonce -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Update handoff nonce is invalid.'
  }
  $expectedSid = Normalize-UserSid $script:ExpectedUserSid
  $expectedSession = ConvertTo-RequiredInt64 $script:ExpectedSessionId 'Expected Windows session'
  if ($expectedSession -le 0 -or $expectedSession -gt [int]::MaxValue) {
    throw 'Expected Windows session is invalid.'
  }

  $fullHandoffPath = [IO.Path]::GetFullPath($script:HandoffPath)
  $expectedLeafName = "youyu-update-handoff-$nonce.json"
  if ([IO.Path]::GetFileName($fullHandoffPath) -ine $expectedLeafName) {
    throw 'Update handoff path does not match its nonce.'
  }
  if (-not (Test-Path -LiteralPath $fullHandoffPath -PathType Leaf)) {
    throw 'Update handoff is no longer available.'
  }
  $item = Get-Item -LiteralPath $fullHandoffPath -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Update handoff must be a regular file.'
  }
  if ($item.Length -le 0 -or $item.Length -gt 8192) { throw 'Update handoff file size is invalid.' }

  if (-not $SkipFileOwnerCheck) {
    $acl = Get-Acl -LiteralPath $fullHandoffPath
    $ownerSid = Normalize-UserSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ine $expectedSid) { throw 'Update handoff file belongs to a different user SID.' }
  }

  $record = Get-Content -LiteralPath $fullHandoffPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ((ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'version') 'Handoff version') -ne 1) {
    throw 'Update handoff version is unsupported.'
  }
  if (([string] (Get-RequiredProperty $record 'nonce')).Trim().ToLowerInvariant() -cne $nonce) {
    throw 'Update handoff nonce does not match.'
  }
  $recordSid = Normalize-UserSid (Get-RequiredProperty $record 'targetUserSid')
  if ($recordSid -ine $expectedSid) { throw 'Update handoff targets a different user SID.' }
  $recordSession = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'targetSessionId') 'Handoff Windows session'
  if ($recordSession -ne $expectedSession) { throw 'Update handoff targets a different Windows session.' }
  $recordProcessId = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'targetProcessId') 'Handoff process id'
  if ($recordProcessId -le 0 -or $recordProcessId -gt [int]::MaxValue) { throw 'Handoff process id is invalid.' }
  $recordExecutablePath = Normalize-ExecutablePath (Get-RequiredProperty $record 'executablePath')
  if ($recordExecutablePath -ine $ExpectedExecutablePath) {
    throw 'Update handoff executable path does not match the installation target.'
  }

  $createdAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'createdAtEpochMs') 'Handoff creation time'
  $expiresAt = ConvertTo-RequiredInt64 (Get-RequiredProperty $record 'expiresAtEpochMs') 'Handoff expiration time'
  $now = if ($CurrentTimeEpochMs -gt 0) { $CurrentTimeEpochMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($expiresAt -le $createdAt -or ($expiresAt - $createdAt) -gt $handoffLifetimeLimitMs) {
    throw 'Update handoff lifetime is invalid.'
  }
  if ($createdAt -gt ($now + 60000L) -or $expiresAt -lt $now) { throw 'Update handoff has expired.' }

  return [pscustomobject]@{
    Path = $fullHandoffPath
    Nonce = $nonce
    UserSid = $expectedSid
    SessionId = [int] $expectedSession
    ProcessId = [int] $recordProcessId
    ExecutablePath = $recordExecutablePath
    CreatedAtEpochMs = $createdAt
    ExpiresAtEpochMs = $expiresAt
  }
}

function Get-UpdateHandoffAcknowledgementPath([object] $Boundary) {
  if ($null -eq $Boundary) { throw 'Cannot resolve an acknowledgement without an authenticated handoff.' }
  $directory = [IO.Path]::GetDirectoryName($Boundary.Path)
  if ([string]::IsNullOrWhiteSpace($directory)) { throw 'Update handoff directory is invalid.' }
  return [IO.Path]::Combine(
    [IO.Path]::GetFullPath($directory),
    ('youyu-update-handoff-' + $Boundary.Nonce + '.ready.json')
  )
}

function Assert-CanonicalAcknowledgementDirectory([string] $Directory) {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'LocalAppData is unavailable for the update acknowledgement.'
  }
  $canonicalDirectory = [IO.Path]::GetFullPath([IO.Path]::Combine($localAppData, 'Temp'))
  if ([IO.Path]::GetFullPath($Directory) -ine $canonicalDirectory) {
    throw 'Update acknowledgement must stay in the current user LocalAppData Temp directory.'
  }
  $directoryItem = Get-Item -LiteralPath $canonicalDirectory -Force -ErrorAction Stop
  if ($directoryItem.PSIsContainer -eq $false -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Update acknowledgement directory is not a regular directory.'
  }
}

function Set-PrivateUpdateAcknowledgementAcl([string] $Path, [string] $UserSid) {
  $sid = [Security.Principal.SecurityIdentifier]::new($UserSid)
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]::None,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $security.SetAccessRule($rule)
  [IO.File]::SetAccessControl($Path, $security)
}

function Assert-PrivateUpdateAcknowledgementAcl([string] $Path, [string] $UserSid) {
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $ownerSid = Normalize-UserSid $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ine $UserSid) { throw 'Update acknowledgement belongs to a different user SID.' }
  if (-not $acl.AreAccessRulesProtected) { throw 'Update acknowledgement ACL is not protected.' }
  $rules = @($acl.Access)
  if ($rules.Count -ne 1) { throw 'Update acknowledgement ACL is not user-only.' }
  $rule = $rules[0]
  if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'Update acknowledgement ACL is not user-only.'
  }
  $ruleSid = Normalize-UserSid $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($ruleSid -ine $UserSid) { throw 'Update acknowledgement ACL is not user-only.' }
  $fullControl = [int64] [Security.AccessControl.FileSystemRights]::FullControl
  if ((([int64] $rule.FileSystemRights) -band $fullControl) -ne $fullControl) {
    throw 'Update acknowledgement ACL does not grant the target user full control.'
  }
}

function Write-AuthenticatedUpdateAcknowledgement([object] $Boundary) {
  if ($null -eq $Boundary) { throw 'Cannot acknowledge an unauthenticated update handoff.' }
  $acknowledgementPath = Get-UpdateHandoffAcknowledgementPath $Boundary
  $directory = [IO.Path]::GetDirectoryName($acknowledgementPath)
  Assert-CanonicalAcknowledgementDirectory $directory
  if (Test-Path -LiteralPath $acknowledgementPath) {
    throw 'Update acknowledgement already exists.'
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($Boundary.ExpiresAtEpochMs -lt $now) { throw 'Update handoff has expired before acknowledgement.' }
  $acknowledgement = [ordered]@{
    version = 1
    nonce = $Boundary.Nonce
    handoffPath = $Boundary.Path
    targetUserSid = $Boundary.UserSid
    targetSessionId = $Boundary.SessionId
    targetProcessId = $Boundary.ProcessId
    executablePath = $Boundary.ExecutablePath
    acknowledgedAtEpochMs = $now
    expiresAtEpochMs = $Boundary.ExpiresAtEpochMs
  }
  $stagingPath = [IO.Path]::Combine(
    $directory,
    ('.youyu-update-handoff-' + $Boundary.Nonce + '.ready-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  )
  try {
    [IO.File]::WriteAllText(
      $stagingPath,
      (($acknowledgement | ConvertTo-Json -Compress) + [Environment]::NewLine),
      [Text.UTF8Encoding]::new($false)
    )
    Set-PrivateUpdateAcknowledgementAcl $stagingPath $Boundary.UserSid
    Assert-PrivateUpdateAcknowledgementAcl $stagingPath $Boundary.UserSid
    [IO.File]::Move($stagingPath, $acknowledgementPath)
  } finally {
    if (Test-Path -LiteralPath $stagingPath) {
      Remove-Item -LiteralPath $stagingPath -Force -ErrorAction SilentlyContinue
    }
  }
  return $acknowledgementPath
}

function Remove-AuthenticatedUpdateAcknowledgement([object] $Boundary) {
  if ($null -eq $Boundary) { return }
  $acknowledgementPath = Get-UpdateHandoffAcknowledgementPath $Boundary
  if (-not (Test-Path -LiteralPath $acknowledgementPath -PathType Leaf)) { return }
  $item = Get-Item -LiteralPath $acknowledgementPath -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Update acknowledgement must be a regular file.'
  }
  Remove-Item -LiteralPath $acknowledgementPath -Force -ErrorAction Stop
}

function Get-InstalledProcesses([string] $ExpectedExecutablePath) {
  if (-not [string]::IsNullOrWhiteSpace($ProcessInventoryPath)) {
    $rawInventory = Get-Content -LiteralPath ([IO.Path]::GetFullPath($ProcessInventoryPath)) -Raw -Encoding UTF8
    $decodedInventory = $rawInventory | ConvertFrom-Json
    $inventory = if ($null -eq $decodedInventory) { @() } else { @($decodedInventory) }
    return @($inventory | ForEach-Object {
        [pscustomobject]@{
          ProcessId = [int] (ConvertTo-RequiredInt64 (Get-RequiredProperty $_ 'processId') 'Process id')
          ExecutablePath = Normalize-ExecutablePath (Get-RequiredProperty $_ 'executablePath')
          OwnerSid = Normalize-UserSid (Get-RequiredProperty $_ 'ownerSid')
          SessionId = [int] (ConvertTo-RequiredInt64 (Get-RequiredProperty $_ 'sessionId') 'Process session')
        }
      } | Where-Object { $_.ExecutablePath -ieq $ExpectedExecutablePath })
  }

  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'YouYu.exe'" -ErrorAction Stop | ForEach-Object {
      if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { return }
      $processPath = Normalize-ExecutablePath $_.ExecutablePath
      if ($processPath -ine $ExpectedExecutablePath) { return }
      $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
      if ([int] $owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
        throw "Cannot resolve owner SID for YouYu process $($_.ProcessId)."
      }
      [pscustomobject]@{
        ProcessId = [int] $_.ProcessId
        ExecutablePath = $processPath
        OwnerSid = Normalize-UserSid $owner.Sid
        SessionId = [int] $_.SessionId
      }
    })
}

function Assert-ProcessBoundary([object[]] $Processes, [object] $Boundary) {
  if ($Processes.Count -eq 0) { return }
  if ($null -eq $Boundary) {
    throw 'A running YouYu process exists without an authenticated user handoff.'
  }
  foreach ($process in $Processes) {
    if ($process.OwnerSid -ine $Boundary.UserSid) {
      throw "YouYu process $($process.ProcessId) belongs to a different user SID."
    }
    if ([int] $process.SessionId -ne [int] $Boundary.SessionId) {
      throw "YouYu process $($process.ProcessId) belongs to a different Windows session."
    }
  }
}

function Assert-AcknowledgementSourceProcess([object[]] $Processes, [object] $Boundary) {
  if ($null -eq $Boundary -or $Processes.Count -eq 0) { return }
  $sourceProcesses = @($Processes | Where-Object { [int] $_.ProcessId -eq [int] $Boundary.ProcessId })
  if ($sourceProcesses.Count -eq 0) {
    throw 'The authenticated update source process is no longer present for acknowledgement.'
  }
}

function Wait-ForAuthenticatedProcessExit([string] $ExpectedExecutablePath, [object] $Boundary) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    $processes = @(Get-InstalledProcesses $ExpectedExecutablePath)
    Assert-ProcessBoundary $processes $Boundary
    if ($processes.Count -eq 0) { return }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for the authenticated YouYu process to exit.'
    }
    Start-Sleep -Milliseconds 250
  }
}

function Invoke-AtomicHandoffConsume([object] $Boundary) {
  if ($null -eq $Boundary) { return }

  $directory = [IO.Path]::GetDirectoryName($Boundary.Path)
  $leafName = [IO.Path]::GetFileName($Boundary.Path)
  $claimedPath = [IO.Path]::Combine(
    $directory,
    ".$leafName.consumed-$([Guid]::NewGuid().ToString('N'))"
  )

  try {
    # Same-directory File.Move is the consume boundary: only one process can claim
    # the validated lease, and the original handoff path disappears atomically.
    [IO.File]::Move($Boundary.Path, $claimedPath)
  } catch {
    throw 'Update handoff could not be atomically consumed.'
  }

  try {
    Remove-Item -LiteralPath $claimedPath -Force -ErrorAction Stop
  } catch {
    # The lease has already been consumed. Avoid reporting a completed install as
    # failed solely because antivirus briefly retained the private tombstone.
    [Console]::Error.WriteLine('Consumed update handoff cleanup was deferred.')
  }
  try {
    Remove-AuthenticatedUpdateAcknowledgement $Boundary
  } catch {
    # The handoff itself is already gone, so an acknowledgement cannot be reused
    # to authorize another install. Leave a diagnostic instead of reporting a
    # completed install as failed solely because antivirus retained the sidecar.
    [Console]::Error.WriteLine('Consumed update acknowledgement cleanup was deferred.')
  }
}

try {
  if ($Action -ne 'Verify' -and (
      -not [string]::IsNullOrWhiteSpace($ProcessInventoryPath) -or
      -not [string]::IsNullOrWhiteSpace($LegacyVersionInfoPath) -or
      $SkipFileOwnerCheck -or
      $CurrentTimeEpochMs -gt 0
    )) {
    throw 'Injected boundary inputs are allowed only in the read-only Verify action.'
  }
  if ($AllowLegacyUpdateBridge -and -not $RequireHandoff) {
    throw 'The legacy update bridge is valid only when an authenticated handoff is otherwise required.'
  }
  if ($AllowLegacyUpdateBridge -and $Action -eq 'Consume') {
    throw 'The legacy update bridge cannot consume an authenticated handoff.'
  }
  if (-not $AllowLegacyUpdateBridge -and -not [string]::IsNullOrWhiteSpace($InstallerVersion)) {
    throw 'Installer version is accepted only for the legacy update bridge.'
  }

  $expectedPath = Normalize-ExecutablePath $ExecutablePath
  $boundary = Get-HandoffBoundary $expectedPath

  if ($Action -eq 'Verify') {
    $processes = @(Get-InstalledProcesses $expectedPath)
    Assert-ProcessBoundary $processes $boundary
    [pscustomobject]@{
      status = 'verified'
      handoffPresent = $null -ne $boundary
      boundaryMode = if ($legacyBridgeActive) { 'legacy' } elseif ($null -ne $boundary) { 'authenticated' } else { 'standard' }
      matchingProcessCount = $processes.Count
    } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'AcknowledgeAndWait') {
    $processes = @(Get-InstalledProcesses $expectedPath)
    Assert-ProcessBoundary $processes $boundary
    Assert-AcknowledgementSourceProcess $processes $boundary
    $acknowledgementPath = if ($null -eq $boundary) { $null } else { Write-AuthenticatedUpdateAcknowledgement $boundary }
    Wait-ForAuthenticatedProcessExit $expectedPath $boundary
    if ($legacyBridgeActive) { exit 10 }
    [pscustomobject]@{
      status = 'acknowledged-and-waited'
      handoffPresent = $null -ne $boundary
      acknowledgementPath = $acknowledgementPath
    } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'Consume') {
    $processes = @(Get-InstalledProcesses $expectedPath)
    Assert-ProcessBoundary $processes $boundary
    if ($processes.Count -gt 0) {
      throw 'Cannot consume the update handoff while YouYu is running.'
    }
    Invoke-AtomicHandoffConsume $boundary
    [pscustomobject]@{
      status = 'consumed'
      handoffPresent = $null -ne $boundary
    } | ConvertTo-Json -Compress
    exit 0
  }

  Wait-ForAuthenticatedProcessExit $expectedPath $boundary

  if ($legacyBridgeActive) { exit 10 }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
