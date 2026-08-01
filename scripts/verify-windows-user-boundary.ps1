<#
.SYNOPSIS
Collects read-only evidence for YouYu's Windows SID/session installation boundary.

.DESCRIPTION
Run this once from each standard Windows account that participates in the two-account
acceptance check. Pass the same installed executable path each time and retain the JSON
outputs. The script only queries identity, processes, and the SID-bound startup task; it
does not start YouYu, change proxy settings, or create/delete tasks.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts\verify-windows-user-boundary.ps1 -ExecutablePath "C:\Program Files\YouYu\YouYu.exe"
#>
param(
  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  [string] $TargetUserSid = '',
  [int] $TargetSessionId = -1
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

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

function Read-XmlElement([string] $Xml, [string] $Name) {
  $match = [regex]::Match($Xml, "<(?:[\w.-]+:)?$Name\b[^>]*>([\s\S]*?)</(?:[\w.-]+:)?$Name>", 'IgnoreCase')
  if (-not $match.Success) { return $null }
  return [Net.WebUtility]::HtmlDecode($match.Groups[1].Value.Trim())
}

$failures = [Collections.Generic.List[string]]::new()
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$executorSid = $identity.User.Value.ToUpperInvariant()
$executorSessionId = [int] (Get-Process -Id $PID -ErrorAction Stop).SessionId
$executorElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$targetSid = if ([string]::IsNullOrWhiteSpace($TargetUserSid)) {
  Normalize-UserSid $executorSid
} else {
  Normalize-UserSid $TargetUserSid
}
$targetSession = if ($TargetSessionId -lt 0) { $executorSessionId } else { $TargetSessionId }
if ($targetSession -le 0) { throw 'Target Windows session must be an interactive session greater than zero.' }
$expectedPath = [IO.Path]::GetFullPath($ExecutablePath)
$taskName = "YouYu-Startup-$targetSid"

$processEvidence = @()
$candidates = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'YouYu.exe'" -ErrorAction Stop)
foreach ($candidate in $candidates) {
  if ([string]::IsNullOrWhiteSpace($candidate.ExecutablePath)) {
    $failures.Add("Cannot read executable path for YouYu process $($candidate.ProcessId); rerun the audit elevated with explicit target SID/session.")
    continue
  }
  $candidatePath = [IO.Path]::GetFullPath($candidate.ExecutablePath)
  if ($candidatePath -ine $expectedPath) { continue }
  $ownerResult = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop
  if ([int] $ownerResult.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($ownerResult.Sid)) {
    $failures.Add("Cannot resolve owner SID for YouYu process $($candidate.ProcessId).")
    continue
  }
  $ownerSid = $ownerResult.Sid.ToUpperInvariant()
  $sessionId = [int] $candidate.SessionId
  $sameBoundary = $ownerSid -ieq $targetSid -and $sessionId -eq $targetSession
  if (-not $sameBoundary) {
    $failures.Add("YouYu process $($candidate.ProcessId) crosses the target SID/session boundary.")
  }
  $processEvidence += [pscustomobject]@{
    processId = [int] $candidate.ProcessId
    executablePath = $candidatePath
    ownerSid = $ownerSid
    sessionId = $sessionId
    matchesTargetBoundary = $sameBoundary
  }
}

$queryArgs = @('/Query', '/TN', $taskName, '/XML')
$taskOutput = @(& "$env:SystemRoot\System32\schtasks.exe" @queryArgs 2>$null)
$taskQueryExitCode = $LASTEXITCODE
$taskEvidence = [ordered]@{
  name = $taskName
  exists = $taskQueryExitCode -eq 0
  principalSid = $null
  executablePath = $null
  arguments = $null
  matchesTargetBoundary = $false
}
if ($taskQueryExitCode -eq 0) {
  $taskXml = $taskOutput -join [Environment]::NewLine
  $taskPrincipalSid = Read-XmlElement $taskXml 'UserId'
  $taskExecutablePath = Read-XmlElement $taskXml 'Command'
  $taskArguments = Read-XmlElement $taskXml 'Arguments'
  $taskEvidence.principalSid = $taskPrincipalSid
  $taskEvidence.executablePath = $taskExecutablePath
  $taskEvidence.arguments = $taskArguments
  $taskEvidence.matchesTargetBoundary =
    $null -ne $taskPrincipalSid -and
    $taskPrincipalSid.Trim() -ieq $targetSid -and
    $null -ne $taskExecutablePath -and
    [IO.Path]::GetFullPath($taskExecutablePath) -ieq $expectedPath -and
    $null -ne $taskArguments -and
    $taskArguments.Trim() -ceq '--hidden'
  if (-not $taskEvidence.matchesTargetBoundary) {
    $failures.Add("Startup task '$taskName' does not match its target SID and executable.")
  }
}

$report = [ordered]@{
  schemaVersion = 1
  readOnly = $true
  capturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  status = if ($failures.Count -eq 0) { 'pass' } else { 'fail' }
  executor = [ordered]@{
    userSid = $executorSid
    sessionId = $executorSessionId
    elevated = $executorElevated
  }
  target = [ordered]@{
    userSid = $targetSid
    sessionId = $targetSession
    executablePath = $expectedPath
  }
  processes = $processEvidence
  startupTask = $taskEvidence
  failures = @($failures)
}
$report | ConvertTo-Json -Depth 6
if ($failures.Count -gt 0) { exit 2 }
exit 0
