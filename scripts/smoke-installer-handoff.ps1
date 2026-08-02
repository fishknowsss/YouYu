<#
.SYNOPSIS
Compiles and runs an isolated NSIS fixture for the authenticated update handoff.

.DESCRIPTION
The fixture includes the production build/installer.nsh and executes the silent
customInit -> customCheckAppRunning -> customInstall flow against a dummy install
directory under the current user's temporary directory. It does not write installer
registry keys, shortcuts, startup tasks, or proxy settings.
#>
param(
  [string] $MakeNsisPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw 'The NSIS handoff smoke requires a LocalAppData directory.'
}
$canonicalHandoffDirectory = [IO.Path]::GetFullPath([IO.Path]::Combine($localAppData, 'Temp')).TrimEnd('\')
$workRoot = [IO.Path]::Combine($temporaryRoot, "youyu-installer-handoff-smoke --youyu-quoted value-$([Guid]::NewGuid().ToString('N'))")
$installDirectory = [IO.Path]::Combine($workRoot, 'installed')
$fixtureSource = [IO.Path]::Combine($workRoot, 'handoff-smoke.nsi')
$fixtureExecutable = [IO.Path]::Combine($workRoot, 'handoff-smoke.exe')
$legacySourceFixture = [IO.Path]::Combine($workRoot, 'legacy-source.nsi')
$legacySourceExecutable = [IO.Path]::Combine($workRoot, 'legacy-source.exe')
$dummyExecutable = [IO.Path]::Combine($installDirectory, 'YouYu.exe')
$markerPath = [IO.Path]::Combine($installDirectory, 'installed.marker')
$nonce = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
$handoffPath = [IO.Path]::Combine($canonicalHandoffDirectory, "youyu-update-handoff-$nonce.json")
$handoffAcknowledgementPath = [IO.Path]::Combine($canonicalHandoffDirectory, "youyu-update-handoff-$nonce.ready.json")
$implicitNonce = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
$implicitHandoffPath = [IO.Path]::Combine($canonicalHandoffDirectory, "youyu-update-handoff-$implicitNonce.json")
$implicitAcknowledgementPath = [IO.Path]::Combine($canonicalHandoffDirectory, "youyu-update-handoff-$implicitNonce.ready.json")
$environmentNames = @(
  'NSISDIR',
  'YOUYU_UPDATE_HANDOFF_PATH',
  'YOUYU_UPDATE_HANDOFF_NONCE',
  'YOUYU_UPDATE_TARGET_USER_SID',
  'YOUYU_UPDATE_TARGET_SESSION_ID',
  'TEMP',
  'TMP'
)
$handoffEnvironmentNames = @(
  'YOUYU_UPDATE_HANDOFF_PATH',
  'YOUYU_UPDATE_HANDOFF_NONCE',
  'YOUYU_UPDATE_TARGET_USER_SID',
  'YOUYU_UPDATE_TARGET_SESSION_ID'
)
$previousEnvironment = @{}
$virtualTargetProcess = $null
$explicitSourceProcess = $null

function Resolve-FirstFile([string] $Root, [string] $Filter, [string] $PreferredPathFragment = '') {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
  $matches = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Filter -ErrorAction SilentlyContinue)
  if (-not [string]::IsNullOrWhiteSpace($PreferredPathFragment)) {
    $preferred = @($matches | Where-Object { $_.FullName -like "*$PreferredPathFragment*" })
    if ($preferred.Count -gt 0) { return $preferred[0].FullName }
  }
  if ($matches.Count -eq 0) { return $null }
  return $matches[0].FullName
}

function Assert-StandardIdentity([string] $Sid, [int] $SessionId) {
  $normalizedSid = $Sid.Trim().ToUpperInvariant()
  if (
    $normalizedSid -notmatch '^S-1-\d+(?:-\d+){2,14}$' -or
    $normalizedSid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20') -or
    $normalizedSid.StartsWith('S-1-5-80-') -or
    $normalizedSid.EndsWith('-500')
  ) {
    throw 'The NSIS handoff smoke requires a standard Windows user identity.'
  }
  if ($SessionId -le 0) { throw 'The NSIS handoff smoke requires an interactive Windows session.' }
}

function Write-Handoff(
  [string] $Path,
  [string] $Nonce,
  [string] $Sid,
  [int] $SessionId,
  [string] $ExecutablePath,
  [int] $TargetProcessId = $PID
) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $handoff = [ordered]@{
    version = 1
    nonce = $Nonce
    targetUserSid = $Sid
    targetSessionId = $SessionId
    targetProcessId = $TargetProcessId
    executablePath = $ExecutablePath
    createdAtEpochMs = $now
    expiresAtEpochMs = $now + 300000L
  }
  [IO.File]::WriteAllText(
    $Path,
    (($handoff | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

function Quote-NsisArgument([string] $Value) {
  if ($Value.Contains('"')) { throw 'The NSIS handoff smoke cannot quote a value containing a double quote.' }
  return '"' + $Value + '"'
}

try {
  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $identity.User.Value.ToUpperInvariant()
  $currentSessionId = [int] (Get-Process -Id $PID -ErrorAction Stop).SessionId
  Assert-StandardIdentity $currentSid $currentSessionId

  Write-Handoff $handoffPath $nonce $currentSid $currentSessionId $dummyExecutable

  $cacheRoot = [IO.Path]::Combine($env:LOCALAPPDATA, 'electron-builder', 'Cache')
  $compiler = if ([string]::IsNullOrWhiteSpace($MakeNsisPath)) {
    Resolve-FirstFile $cacheRoot 'makensis.exe' '\Bin\'
  } else {
    [IO.Path]::GetFullPath($MakeNsisPath)
  }
  if ($null -eq $compiler -or -not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'electron-builder makensis.exe is unavailable; populate its NSIS cache first.'
  }
  $compilerDirectory = Split-Path -Parent $compiler
  $nsisRoot = if ((Split-Path -Leaf $compilerDirectory) -ieq 'Bin') {
    Split-Path -Parent $compilerDirectory
  } else {
    $compilerDirectory
  }
  if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($nsisRoot, 'Include')) -PathType Container)) {
    throw 'The resolved makensis.exe does not belong to a complete NSIS bundle.'
  }

  $plugin = Resolve-FirstFile $cacheRoot 'StdUtils.dll' '\x86-unicode\'
  if ($null -eq $plugin) { throw 'electron-builder StdUtils.dll is unavailable.' }
  $pluginDirectory = Split-Path -Parent $plugin
  $templateIncludeDirectory = [IO.Path]::Combine(
    $repositoryRoot,
    'node_modules',
    'app-builder-lib',
    'templates',
    'nsis',
    'include'
  )
  $productionInclude = [IO.Path]::Combine($repositoryRoot, 'build', 'installer.nsh')
  $buildResources = [IO.Path]::Combine($repositoryRoot, 'build')

  $fixtureTemplate = @'
Unicode true
!pragma warning disable 6010
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
Name "YouYu handoff smoke"
OutFile "@@OUT_FILE@@"
InstallDir "@@INSTALL_DIR@@"
  !addincludedir "@@TEMPLATE_INCLUDE@@"
  !addplugindir /x86-unicode "@@PLUGIN_DIR@@"
  !include "FileFunc.nsh"
  !include "StdUtils.nsh"
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
!define VERSION "1.7.0"
!define BUILD_RESOURCES_DIR "@@BUILD_RESOURCES@@"
!include "@@PRODUCTION_INCLUDE@@"
!insertmacro customHeader

Function .onInit
  !insertmacro customInit
FunctionEnd

Section "handoff smoke"
  !insertmacro customCheckAppRunning
  FileOpen $0 "$INSTDIR\installed.marker" w
  FileWrite $0 "installed"
  FileWrite $0 ":$YouYuLegacyUpdateBridge"
  FileClose $0
  !insertmacro customInstall
SectionEnd
'@
  $fixture = $fixtureTemplate.
    Replace('@@OUT_FILE@@', $fixtureExecutable).
    Replace('@@INSTALL_DIR@@', $installDirectory).
    Replace('@@TEMPLATE_INCLUDE@@', $templateIncludeDirectory).
    Replace('@@PLUGIN_DIR@@', $pluginDirectory).
    Replace('@@BUILD_RESOURCES@@', $buildResources).
    Replace('@@PRODUCTION_INCLUDE@@', $productionInclude)
  [IO.File]::WriteAllText($fixtureSource, $fixture, [Text.UTF8Encoding]::new($false))

  foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  [Environment]::SetEnvironmentVariable('NSISDIR', $nsisRoot, 'Process')

  $legacySourceTemplate = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "YouYu legacy source fixture"
OutFile "@@OUT_FILE@@"
VIProductVersion "1.6.8.0"
VIAddVersionKey /LANG=1033 "ProductName" "YouYu"
VIAddVersionKey /LANG=1033 "CompanyName" "118 Studio"
VIAddVersionKey /LANG=1033 "FileDescription" "YouYu"
VIAddVersionKey /LANG=1033 "FileVersion" "1.6.8"
VIAddVersionKey /LANG=1033 "ProductVersion" "1.6.8.0"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright 2026 118 Studio"
Section
  Sleep 60000
SectionEnd
'@
  $legacySource = $legacySourceTemplate.Replace('@@OUT_FILE@@', $legacySourceExecutable)
  [IO.File]::WriteAllText($legacySourceFixture, $legacySource, [Text.UTF8Encoding]::new($false))

  & $compiler '-WX' '-INPUTCHARSET' 'UTF8' $legacySourceFixture
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $legacySourceExecutable -PathType Leaf)) {
    throw "makensis failed to build the legacy source fixture with exit code $LASTEXITCODE."
  }
  Copy-Item -LiteralPath $legacySourceExecutable -Destination $dummyExecutable -Force

  & $compiler '-WX' '-INPUTCHARSET' 'UTF8' $fixtureSource
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureExecutable -PathType Leaf)) {
    throw "makensis failed with exit code $LASTEXITCODE."
  }

  # Explicit CLI bridge: a per-machine installer loses custom source-process
  # environment variables across UAC, so customInit must reconstruct only the
  # four strict handoff values from its own command line before validation.
  foreach ($name in $handoffEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  # The source process remains alive until the sidecar appears. This proves the
  # installer publishes its authenticated acknowledgement before it waits for
  # the app to exit, and that the app would only quit after the same boundary
  # has been checked.
  $explicitSourceProcess = Start-Process -FilePath $dummyExecutable -ArgumentList '/S' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 250
  if ($explicitSourceProcess.HasExited) { throw 'The explicit source process exited before the acknowledgement handshake.' }
  Write-Handoff $handoffPath $nonce $currentSid $currentSessionId $dummyExecutable $explicitSourceProcess.Id
  $explicitCliProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @(
    '/S',
    '--updated',
    '--youyu-handoff-path',
    (Quote-NsisArgument $handoffPath),
    '--youyu-handoff-nonce',
    (Quote-NsisArgument $nonce),
    '--youyu-target-user-sid',
    (Quote-NsisArgument $currentSid),
    '--youyu-target-session-id',
    (Quote-NsisArgument ([string] $currentSessionId)),
    (Quote-NsisArgument ([IO.Path]::Combine($workRoot, 'ordinary --youyu-quoted argument')))
  ) -PassThru -WindowStyle Hidden
  $acknowledgementDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $handoffAcknowledgementPath -PathType Leaf)) {
    if ($explicitCliProcess.HasExited) {
      throw "Explicit-CLI NSIS handoff exited before acknowledging with $($explicitCliProcess.ExitCode)."
    }
    if ([DateTimeOffset]::UtcNow -ge $acknowledgementDeadline) {
      throw 'Explicit-CLI NSIS handoff did not acknowledge the authenticated boundary in time.'
    }
    Start-Sleep -Milliseconds 100
  }
  $acknowledgement = Get-Content -LiteralPath $handoffAcknowledgementPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    $acknowledgement.nonce -cne $nonce -or
    $acknowledgement.handoffPath -ine $handoffPath -or
    $acknowledgement.targetUserSid -ine $currentSid -or
    [int] $acknowledgement.targetSessionId -ne $currentSessionId
  ) {
    throw 'The explicit CLI acknowledgement did not bind the expected handoff identity.'
  }
  if ($explicitSourceProcess.HasExited) {
    throw 'The source process exited before the installer acknowledgement was observed.'
  }
  Stop-Process -Id $explicitSourceProcess.Id -Force -ErrorAction Stop
  $explicitSourceProcess.WaitForExit()
  $explicitSourceProcess = $null
  $explicitCliProcess.WaitForExit()
  if ($explicitCliProcess.ExitCode -ne 0) {
    throw "Explicit-CLI NSIS handoff smoke exited with $($explicitCliProcess.ExitCode)."
  }
  if ((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -cne 'installed:0') {
    throw 'The explicit CLI bridge did not produce an authenticated install marker.'
  }
  if (Test-Path -LiteralPath $handoffPath) {
    throw 'The explicit CLI bridge did not consume its handoff.'
  }
  if (Test-Path -LiteralPath $handoffAcknowledgementPath) {
    throw 'The explicit CLI bridge did not consume its acknowledgement.'
  }

  # Unknown YouYu bridge options must fail closed, even when every known option
  # is present. This prevents a caller from silently extending the bridge ABI.
  Write-Handoff $handoffPath $nonce $currentSid $currentSessionId $dummyExecutable
  Remove-Item -LiteralPath $markerPath -Force
  $unknownCliProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @(
    '/S',
    '--updated',
    '--youyu-handoff-path',
    (Quote-NsisArgument $handoffPath),
    '--youyu-handoff-nonce',
    (Quote-NsisArgument $nonce),
    '--youyu-target-user-sid',
    (Quote-NsisArgument $currentSid),
    '--youyu-target-session-id',
    (Quote-NsisArgument ([string] $currentSessionId)),
    '--youyu-unknown=reject'
  ) -Wait -PassThru -WindowStyle Hidden
  if ($unknownCliProcess.ExitCode -eq 0) {
    throw 'The NSIS handoff parser accepted an unknown YouYu bridge argument.'
  }
  if (Test-Path -LiteralPath $markerPath) {
    throw 'The installer wrote files after rejecting an unknown YouYu bridge argument.'
  }
  Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue

  # Complete inherited-environment handoff remains supported for same-token
  # launches, and the post-write hook still atomically consumes the lease.
  Write-Handoff $handoffPath $nonce $currentSid $currentSessionId $dummyExecutable
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_PATH', $handoffPath, 'Process')
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_NONCE', $nonce, 'Process')
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_TARGET_USER_SID', $currentSid, 'Process')
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_TARGET_SESSION_ID', [string] $currentSessionId, 'Process')

  $authenticatedProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @('/S', '--updated') -Wait -PassThru -WindowStyle Hidden
  if ($authenticatedProcess.ExitCode -ne 0) {
    throw "Authenticated NSIS handoff smoke exited with $($authenticatedProcess.ExitCode)."
  }
  if ((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -cne 'installed:0') {
    throw 'The isolated install marker was not written before handoff consumption.'
  }
  if (Test-Path -LiteralPath $handoffPath) {
    throw 'The handoff remained after the successful customInstall hook.'
  }
  if (Test-Path -LiteralPath $handoffAcknowledgementPath) {
    throw 'The inherited-environment bridge did not consume its acknowledgement.'
  }
  $tombstones = @(Get-ChildItem -LiteralPath $workRoot -File -Filter '*.consumed-*' -ErrorAction SilentlyContinue)
  if ($tombstones.Count -ne 0) { throw 'Consumed handoff tombstones were not cleaned.' }

  # 1.7.0 compatibility: electron-updater can elevate a per-machine installer
  # without preserving the source process environment and cannot add the new
  # CLI bridge. The new installer must recover exactly one fresh handoff from
  # the current user/session LocalAppData\Temp and consume it after writing.
  foreach ($name in $handoffEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  $misdirectedTempDirectory = [IO.Path]::Combine($workRoot, 'misdirected-temp')
  New-Item -ItemType Directory -Path $misdirectedTempDirectory -Force | Out-Null
  # The compatibility lookup must not accidentally follow TEMP/TMP: old 1.7.0
  # writes the handoff in LocalAppData\Temp, while UAC may launch with altered
  # process environment variables.
  [Environment]::SetEnvironmentVariable('TEMP', $misdirectedTempDirectory, 'Process')
  [Environment]::SetEnvironmentVariable('TMP', $misdirectedTempDirectory, 'Process')
  Write-Handoff $implicitHandoffPath $implicitNonce $currentSid $currentSessionId $dummyExecutable
  Remove-Item -LiteralPath $markerPath -Force
  $implicitFallbackProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @('/S', '--updated') -Wait -PassThru -WindowStyle Hidden
  if ($implicitFallbackProcess.ExitCode -ne 0) {
    throw "Implicit fallback NSIS handoff smoke exited with $($implicitFallbackProcess.ExitCode)."
  }
  if ((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -cne 'installed:0') {
    throw 'The no-environment/no-CLI fallback did not use an authenticated handoff.'
  }
  if (Test-Path -LiteralPath $implicitHandoffPath) {
    throw 'The no-environment/no-CLI fallback did not consume its handoff.'
  }
  if (Test-Path -LiteralPath $implicitAcknowledgementPath) {
    throw 'The no-environment/no-CLI fallback did not consume its acknowledgement.'
  }
  foreach ($name in @('TEMP', 'TMP')) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }

  # Fully absent handoff from v1.6.8: the one-time bridge may proceed only while
  # the exact protected target is stopped.
  foreach ($name in $handoffEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  Remove-Item -LiteralPath $markerPath -Force
  $legacyProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @('/S', '--updated') -Wait -PassThru -WindowStyle Hidden
  if ($legacyProcess.ExitCode -ne 0) {
    throw "Legacy bridge NSIS smoke exited with $($legacyProcess.ExitCode)."
  }
  if ((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -cne 'installed:1') {
    throw 'The eligible legacy updater launch did not use the isolated bridge.'
  }

  # A virtual exact-path process must make the bridge fail closed. The harness
  # owns this temporary sleeper and terminates only that PID after the assertion.
  Remove-Item -LiteralPath $markerPath -Force
  $virtualTargetProcess = Start-Process -FilePath $dummyExecutable -ArgumentList '/S' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 250
  if ($virtualTargetProcess.HasExited) { throw 'The virtual YouYu process exited before the boundary check.' }
  $runningTargetProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @('/S', '--updated') -Wait -PassThru -WindowStyle Hidden
  if ($runningTargetProcess.ExitCode -eq 0) {
    throw 'The legacy bridge accepted a running exact-path YouYu process.'
  }
  if (Test-Path -LiteralPath $markerPath) {
    throw 'The installer wrote files after the running-target boundary failed.'
  }
  Stop-Process -Id $virtualTargetProcess.Id -Force -ErrorAction Stop
  $virtualTargetProcess.WaitForExit()
  $virtualTargetProcess = $null

  # Any partial handoff environment must fail instead of falling back to legacy.
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_PATH', $handoffPath, 'Process')
  Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
  $partialHandoffProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList @('/S', '--updated') -Wait -PassThru -WindowStyle Hidden
  if ($partialHandoffProcess.ExitCode -eq 0) {
    throw 'The legacy bridge accepted an incomplete handoff environment.'
  }
  if (Test-Path -LiteralPath $markerPath) {
    throw 'The installer wrote files after the partial-handoff boundary failed.'
  }
  [Environment]::SetEnvironmentVariable('YOUYU_UPDATE_HANDOFF_PATH', $null, 'Process')

  # A normal silent fresh install has no --updated flag and never enters the
  # bridge, even though it shares the same production hooks.
  Remove-Item -LiteralPath $dummyExecutable -Force
  $freshProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  if ($freshProcess.ExitCode -ne 0) {
    throw "Fresh-install NSIS smoke exited with $($freshProcess.ExitCode)."
  }
  if ((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -cne 'installed:0') {
    throw 'A normal silent fresh install was misclassified as a legacy update.'
  }

  [pscustomobject]@{
    status = 'pass'
    isolated = $true
    installerExitCodes = [ordered]@{
      explicitCli = $explicitCliProcess.ExitCode
      unknownCli = $unknownCliProcess.ExitCode
      authenticated = $authenticatedProcess.ExitCode
      implicitFallback = $implicitFallbackProcess.ExitCode
      legacy = $legacyProcess.ExitCode
      runningTarget = $runningTargetProcess.ExitCode
      partialHandoff = $partialHandoffProcess.ExitCode
      fresh = $freshProcess.ExitCode
    }
    productionInclude = $productionInclude
    canonicalHandoffDirectory = $canonicalHandoffDirectory
    acknowledgementObservedBeforeSourceExit = $true
    flow = @('customInit:CLI bridge -> AcknowledgeAndWait', 'customCheckAppRunning:skip duplicate wait', 'customInstall:Consume')
    handoffConsumedAfterMarker = $true
    legacyBridgeOneTimeTarget = '1.7.0'
  } | ConvertTo-Json -Depth 4
} finally {
  if ($null -ne $explicitSourceProcess -and -not $explicitSourceProcess.HasExited) {
    Stop-Process -Id $explicitSourceProcess.Id -Force -ErrorAction SilentlyContinue
    $explicitSourceProcess.WaitForExit()
  }
  if ($null -ne $virtualTargetProcess -and -not $virtualTargetProcess.HasExited) {
    Stop-Process -Id $virtualTargetProcess.Id -Force -ErrorAction SilentlyContinue
    $virtualTargetProcess.WaitForExit()
  }
  foreach ($name in $environmentNames) {
    if ($previousEnvironment.ContainsKey($name)) {
      [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
  }
  foreach ($path in @(
      $handoffPath,
      $handoffAcknowledgementPath,
      $implicitHandoffPath,
      $implicitAcknowledgementPath
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  $resolvedWorkRoot = [IO.Path]::GetFullPath($workRoot)
  $expectedPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar
  if (
    $resolvedWorkRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($resolvedWorkRoot).StartsWith('youyu-installer-handoff-smoke --youyu-quoted value-', [StringComparison]::Ordinal)
  ) {
    Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
