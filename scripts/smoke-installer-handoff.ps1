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
$workRoot = [IO.Path]::Combine($temporaryRoot, "youyu-installer-handoff-smoke-$([Guid]::NewGuid().ToString('N'))")
$installDirectory = [IO.Path]::Combine($workRoot, 'installed')
$fixtureSource = [IO.Path]::Combine($workRoot, 'handoff-smoke.nsi')
$fixtureExecutable = [IO.Path]::Combine($workRoot, 'handoff-smoke.exe')
$legacySourceFixture = [IO.Path]::Combine($workRoot, 'legacy-source.nsi')
$legacySourceExecutable = [IO.Path]::Combine($workRoot, 'legacy-source.exe')
$dummyExecutable = [IO.Path]::Combine($installDirectory, 'YouYu.exe')
$markerPath = [IO.Path]::Combine($installDirectory, 'installed.marker')
$nonce = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
$handoffPath = [IO.Path]::Combine($workRoot, "youyu-update-handoff-$nonce.json")
$environmentNames = @(
  'NSISDIR',
  'YOUYU_UPDATE_HANDOFF_PATH',
  'YOUYU_UPDATE_HANDOFF_NONCE',
  'YOUYU_UPDATE_TARGET_USER_SID',
  'YOUYU_UPDATE_TARGET_SESSION_ID'
)
$previousEnvironment = @{}
$virtualTargetProcess = $null

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

try {
  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $identity.User.Value.ToUpperInvariant()
  $currentSessionId = [int] (Get-Process -Id $PID -ErrorAction Stop).SessionId
  Assert-StandardIdentity $currentSid $currentSessionId

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $handoff = [ordered]@{
    version = 1
    nonce = $nonce
    targetUserSid = $currentSid
    targetSessionId = $currentSessionId
    targetProcessId = $PID
    executablePath = $dummyExecutable
    createdAtEpochMs = $now
    expiresAtEpochMs = $now + 300000L
  }
  [IO.File]::WriteAllText(
    $handoffPath,
    (($handoff | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

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
!include "StdUtils.nsh"
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
!define VERSION "1.6.9"
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

  # Complete authenticated handoff: the new-client path must stay authenticated
  # and the post-write hook must atomically consume the lease.
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
  $tombstones = @(Get-ChildItem -LiteralPath $workRoot -File -Filter '*.consumed-*' -ErrorAction SilentlyContinue)
  if ($tombstones.Count -ne 0) { throw 'Consumed handoff tombstones were not cleaned.' }

  # Fully absent handoff from v1.6.8: the one-time bridge may proceed only while
  # the exact protected target is stopped.
  foreach ($name in $environmentNames | Where-Object { $_ -ne 'NSISDIR' }) {
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
      authenticated = $authenticatedProcess.ExitCode
      legacy = $legacyProcess.ExitCode
      runningTarget = $runningTargetProcess.ExitCode
      partialHandoff = $partialHandoffProcess.ExitCode
      fresh = $freshProcess.ExitCode
    }
    productionInclude = $productionInclude
    flow = @('customInit:WaitForExit', 'customCheckAppRunning:WaitForExit', 'customInstall:Consume')
    handoffConsumedAfterMarker = $true
    legacyBridgeOneTimeTarget = '1.6.9'
  } | ConvertTo-Json -Depth 4
} finally {
  if ($null -ne $virtualTargetProcess -and -not $virtualTargetProcess.HasExited) {
    Stop-Process -Id $virtualTargetProcess.Id -Force -ErrorAction SilentlyContinue
    $virtualTargetProcess.WaitForExit()
  }
  foreach ($name in $environmentNames) {
    if ($previousEnvironment.ContainsKey($name)) {
      [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
  }
  $resolvedWorkRoot = [IO.Path]::GetFullPath($workRoot)
  $expectedPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar
  if (
    $resolvedWorkRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($resolvedWorkRoot).StartsWith('youyu-installer-handoff-smoke-', [StringComparison]::Ordinal)
  ) {
    Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
