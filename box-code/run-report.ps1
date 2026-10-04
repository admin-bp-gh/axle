# run-report.ps1 - invoked by the "Axle Report" scheduled task (runs daily as the `axle` account).
# Regenerates the adoption dashboard from the live DB into ..\data\adoption-dashboard.html, which
# server.js serves to admins at /adoption. Same shape as run-backup.ps1: node does the work, this
# only records a wrapper-level failure in ..\logs\report.log.
$ErrorActionPreference = "Stop"
$app = $PSScriptRoot
$root = Split-Path $app -Parent
$log = Join-Path $root "logs\report.log"
$out = Join-Path $root "data\adoption-dashboard.html"
try {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $result = & node "$app\adoption-report.js" $out 2>&1
  "$ts  $result" | Out-File -FilePath $log -Append -Encoding utf8
  exit $LASTEXITCODE
} catch {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  WRAPPER-FAIL could not start node: $($_.Exception.Message)" |
    Out-File -FilePath $log -Append -Encoding utf8
  exit 1
}
