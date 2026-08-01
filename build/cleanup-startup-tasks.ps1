param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Cleanup', 'Verify')]
  [string] $Action,

  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  # Test-only seam. Production cleanup rejects injected inventories.
  [string] $InventoryPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Normalize-UserSid([object] $Value) {
  if ($null -eq $Value) { throw 'Task principal SID is missing.' }
  $sid = ([string] $Value).Trim().ToUpperInvariant()
  if ($sid -notmatch '^S-1-\d+(?:-\d+){2,14}$') { throw 'Task principal SID is invalid.' }
  if (
    $sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20') -or
    $sid.StartsWith('S-1-5-80-') -or
    $sid.EndsWith('-500')
  ) {
    throw 'Task principal is not a standard-user SID.'
  }
  return $sid
}

function Normalize-ExecutablePath([object] $Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string] $Value)) {
    throw 'Task executable path is missing.'
  }
  $path = ([string] $Value).Trim()
  while ($path.Length -ge 2) {
    $first = $path.Substring(0, 1)
    $last = $path.Substring($path.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'") -or ($first -eq '`' -and $last -eq '`')) {
      $path = $path.Substring(1, $path.Length - 2).Trim()
      continue
    }
    break
  }
  if (-not [IO.Path]::IsPathRooted($path)) { throw 'Task executable path must be absolute.' }
  return [IO.Path]::GetFullPath($path)
}

function Read-TaskXml([string] $Source) {
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $stringReader = New-Object IO.StringReader($Source)
  $reader = $null
  try {
    $reader = [Xml.XmlReader]::Create($stringReader, $settings)
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    $document.Load($reader)
    return $document
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    $stringReader.Dispose()
  }
}

function Get-CandidateSid([string] $Name) {
  if ($Name -ieq 'YouYu') { return '' }
  if ($Name -notmatch '^YouYu-Startup-(S-1-\d+(?:-\d+){2,14})$') { return $null }
  return Normalize-UserSid $Matches[1]
}

function Test-OwnedStartupTask([object] $Entry, [string] $ExpectedExecutablePath) {
  $name = ([string] $Entry.Name).Trim()
  $candidateSid = Get-CandidateSid $name
  if ($null -eq $candidateSid) { return $false }

  try {
    if (([string] $Entry.Path) -ine "\$name") { throw 'Candidate task is not in the Task Scheduler root.' }
    $document = Read-TaskXml ([string] $Entry.Xml)
    $task = $document.SelectSingleNode("/*[local-name()='Task']")
    if ($null -eq $task) { throw 'Task XML root is invalid.' }

    $principals = @($task.SelectNodes("./*[local-name()='Principals']/*[local-name()='Principal']"))
    if ($principals.Count -ne 1) { throw 'Task must have exactly one principal.' }
    $userIds = @($principals[0].SelectNodes("./*[local-name()='UserId']"))
    $groupIds = @($principals[0].SelectNodes("./*[local-name()='GroupId']"))
    if ($userIds.Count -ne 1 -or $groupIds.Count -ne 0) { throw 'Task principal boundary is invalid.' }
    $principalSid = Normalize-UserSid $userIds[0].InnerText
    if ($candidateSid -and $principalSid -cne $candidateSid) { throw 'Task name and principal SID do not match.' }

    $triggers = @($task.SelectNodes("./*[local-name()='Triggers']/*"))
    if ($triggers.Count -ne 1 -or $triggers[0].LocalName -ne 'LogonTrigger') {
      throw 'Task must have exactly one logon trigger.'
    }

    $actions = @($task.SelectNodes("./*[local-name()='Actions']/*"))
    if ($actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') {
      throw 'Task must have exactly one executable action.'
    }
    $commands = @($actions[0].SelectNodes("./*[local-name()='Command']"))
    $arguments = @($actions[0].SelectNodes("./*[local-name()='Arguments']"))
    if ($commands.Count -ne 1 -or $arguments.Count -ne 1) { throw 'Task action is incomplete.' }
    $command = Normalize-ExecutablePath $commands[0].InnerText
    if ($command -ine $ExpectedExecutablePath) { throw 'Task command does not match this installation.' }
    if ($arguments[0].InnerText.Trim() -cne '--hidden') { throw 'Task arguments do not match YouYu startup.' }
    return $true
  } catch {
    [Console]::Error.WriteLine("Skipping startup task '$name': $($_.Exception.Message)")
    return $false
  }
}

function Read-InjectedInventory([string] $Path) {
  $decoded = Get-Content -LiteralPath ([IO.Path]::GetFullPath($Path)) -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $decoded) { return @() }
  return @($decoded | ForEach-Object {
      if ($null -eq $_ -or $_.PSObject.Properties.Name -notcontains 'name' -or $_.PSObject.Properties.Name -notcontains 'path' -or $_.PSObject.Properties.Name -notcontains 'xml') {
        throw 'Injected task inventory entry is incomplete.'
      }
      [pscustomobject]@{ Name = [string] $_.name; Path = [string] $_.path; Xml = [string] $_.xml }
    })
}

function Read-RootTasks([object] $Folder) {
  $collection = $Folder.GetTasks(1) # TASK_ENUM_HIDDEN
  $entries = @()
  for ($index = 1; $index -le [int] $collection.Count; $index += 1) {
    $task = $collection.Item($index)
    $entries += [pscustomobject]@{ Name = [string] $task.Name; Path = [string] $task.Path; Xml = [string] $task.Xml }
  }
  return $entries
}

try {
  $expectedPath = Normalize-ExecutablePath $ExecutablePath
  if ($Action -eq 'Cleanup' -and -not [string]::IsNullOrWhiteSpace($InventoryPath)) {
    throw 'Injected task inventories are allowed only in Verify mode.'
  }

  if ($Action -eq 'Verify') {
    if ([string]::IsNullOrWhiteSpace($InventoryPath)) { throw 'Verify mode requires an injected task inventory.' }
    $matches = @(Read-InjectedInventory $InventoryPath | Where-Object { Test-OwnedStartupTask $_ $expectedPath })
    [pscustomobject]@{ status = 'verified'; matches = @($matches | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress
    exit 0
  }

  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $candidates = @(Read-RootTasks $folder | Where-Object { Test-OwnedStartupTask $_ $expectedPath })
  $removed = @()
  $failures = @()
  foreach ($candidate in $candidates) {
    try {
      # Re-read and re-validate immediately before deletion to narrow the query/delete race.
      $current = $folder.GetTask("\$($candidate.Name)")
      $entry = [pscustomobject]@{ Name = [string] $current.Name; Path = [string] $current.Path; Xml = [string] $current.Xml }
      if (-not (Test-OwnedStartupTask $entry $expectedPath)) { continue }
      $folder.DeleteTask($candidate.Name, 0)
      $removed += $candidate.Name
    } catch {
      $failures += "$($candidate.Name): $($_.Exception.Message)"
    }
  }
  if ($failures.Count -gt 0) { throw "Startup task cleanup failed: $($failures -join '; ')" }
  [pscustomobject]@{ status = 'cleaned'; removed = $removed } | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
