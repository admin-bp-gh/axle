# rollback.ps1 - hand Axle back to the release before the live one (same handover as a deploy).
# No copying, no tests: the previous release folder is still on disk (deploy.ps1 keeps the last 5).
# Self-elevates: the server runs as the low-privilege axle account.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList @("-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`"")
  exit
}
$ErrorActionPreference = "Stop"
$live = @((Get-Item "C:\Axle\app" -Force).Target)[0]
$prev = Get-ChildItem "C:\Axle" -Directory -Filter "app-*" | Where-Object { $_.FullName -ne $live } |
  Sort-Object CreationTime -Descending | Select-Object -First 1
if (-not $prev) { throw "No earlier release folder to roll back to." }
Write-Host "Rolling back: $(Split-Path $live -Leaf) -> $($prev.Name)"
& "$PSScriptRoot\switch-release.ps1" -Release $prev.FullName
