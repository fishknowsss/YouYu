$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$statePath = Join-Path $env:APPDATA 'YouYu\system-proxy-ownership.json'

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)] [object] $InputObject,
    [Parameter(Mandatory = $true)] [string] $Name
  )

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) {
    throw "Invalid YouYu proxy ownership state: missing $Name"
  }
  return $property.Value
}

function Get-CurrentProxySettings {
  $settings = Get-ItemProperty -Path $registryPath
  $enabledProperty = $settings.PSObject.Properties['ProxyEnable']
  $serverProperty = $settings.PSObject.Properties['ProxyServer']
  $overrideProperty = $settings.PSObject.Properties['ProxyOverride']
  return [pscustomobject]@{
    Raw = $settings
    enabled = ($null -ne $enabledProperty -and [int] $enabledProperty.Value -eq 1)
    server = if ($null -eq $serverProperty) { '' } else { [string] $serverProperty.Value }
    override = if ($null -eq $overrideProperty) { '' } else { [string] $overrideProperty.Value }
  }
}

function Test-LoopbackProxyServer {
  param([string] $Server)
  return $Server -match '(^|=)(127\.0\.0\.1|localhost):\d+($|;)'
}

if (-not (Test-Path -LiteralPath $statePath)) {
  $currentWithoutState = Get-CurrentProxySettings
  if ($currentWithoutState.enabled -and (Test-LoopbackProxyServer $currentWithoutState.server)) {
    throw 'Cannot safely force-close YouYu while a loopback system proxy is enabled and ownership state is missing.'
  }
  exit 0
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$version = Get-RequiredProperty $state 'version'
if ($version -notin @(1, 2)) {
  throw "Unsupported YouYu proxy ownership state version: $version"
}

$previous = Get-RequiredProperty $state 'previous'
$applied = Get-RequiredProperty $state 'applied'
$fields = if ($version -eq 1) {
  [pscustomobject]@{ enabled = $true; server = $true; override = $true }
} else {
  Get-RequiredProperty $state 'appliedFields'
}

foreach ($field in @('enabled', 'server', 'override')) {
  $managed = Get-RequiredProperty $fields $field
  $previousValue = Get-RequiredProperty $previous $field
  $appliedValue = Get-RequiredProperty $applied $field
  if ($managed -isnot [bool]) {
    throw "Invalid YouYu proxy ownership flag: $field"
  }
  if ($field -eq 'enabled') {
    if ($previousValue -isnot [bool] -or $appliedValue -isnot [bool]) {
      throw 'Invalid YouYu proxy ownership enabled values.'
    }
  } elseif ($previousValue -isnot [string] -or $appliedValue -isnot [string]) {
    throw "Invalid YouYu proxy ownership string values: $field"
  }
}

$current = Get-CurrentProxySettings
$serverWasReplaced = $fields.server -and
  $current.server -ne $applied.server -and
  $current.server -ne $previous.server
if ($serverWasReplaced) {
  Remove-Item -LiteralPath $statePath -Force
  exit 0
}

foreach ($field in @('server', 'override', 'enabled')) {
  if (-not $fields.$field) { continue }
  $currentValue = $current.$field
  $appliedValue = $applied.$field
  if ($currentValue -ne $appliedValue) { continue }

  $previousValue = $previous.$field
  switch ($field) {
    'server' {
      if ([string]::IsNullOrEmpty($previousValue)) {
        if ($null -ne $current.Raw.PSObject.Properties['ProxyServer']) {
          Remove-ItemProperty -Path $registryPath -Name ProxyServer
        }
      } else {
        Set-ItemProperty -Path $registryPath -Name ProxyServer -Value ([string] $previousValue)
      }
    }
    'override' {
      if ([string]::IsNullOrEmpty($previousValue)) {
        if ($null -ne $current.Raw.PSObject.Properties['ProxyOverride']) {
          Remove-ItemProperty -Path $registryPath -Name ProxyOverride
        }
      } else {
        Set-ItemProperty -Path $registryPath -Name ProxyOverride -Value ([string] $previousValue)
      }
    }
    'enabled' {
      Set-ItemProperty -Path $registryPath -Name ProxyEnable -Type DWord -Value ([int] [bool] $previousValue)
    }
  }
}

$source = @'
using System;
using System.Runtime.InteropServices;
namespace YouYu {
  public static class WinInet {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr internet, int option, IntPtr buffer, int bufferLength);
  }
}
'@
Add-Type -TypeDefinition $source
$settingsChanged = [YouYu.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
$settingsRefreshed = [YouYu.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
if (-not $settingsChanged -or -not $settingsRefreshed) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "Failed to refresh WinINet proxy settings: $errorCode"
}

Remove-Item -LiteralPath $statePath -Force
exit 0
