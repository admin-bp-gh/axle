# run-backup.ps1 - invoked by the "Axle Backup" scheduled task (runs as the `axle` account).
# Tiny on purpose: all backup logic lives in backup-db.js. This just runs the script with
# node (resolved on PATH, same as run-server.ps1) and records a wrapper-level failure if
# node itself can't start. backup-db.js does its own per-run OK/FAIL logging otherwise.
$ErrorActionPreference = "Stop"
$app = "C:\Axle\app"
$log = "C:\Axle\logs\backup.log"
try {
  & node "$app\backup-db.js"
  exit $LASTEXITCODE
} catch {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  WRAPPER-FAIL could not start node: $($_.Exception.Message)" |
    Out-File -FilePath $log -Append -Encoding utf8
  exit 1
}
