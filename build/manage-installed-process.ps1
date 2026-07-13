param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Exists', 'CloseWindow', 'Force')]
  [string] $Action,

  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

try {
  $expectedPath = [IO.Path]::GetFullPath($ExecutablePath)
  $matches = @(Get-Process -Name 'YouYu' -ErrorAction SilentlyContinue | Where-Object {
      $null -ne $_.Path -and [IO.Path]::GetFullPath($_.Path) -ieq $expectedPath
    })

  switch ($Action) {
    'Exists' {
      if ($matches.Count -gt 0) { exit 0 }
      exit 1
    }
    'CloseWindow' {
      foreach ($process in $matches) {
        if ($process.MainWindowHandle -ne 0) {
          [void] $process.CloseMainWindow()
        }
      }
      exit 0
    }
    'Force' {
      $matches | Stop-Process -Force
      exit 0
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
