# run-server.ps1 - keeps the Axle web server alive. Paths derive from this script's own folder
# ($PSScriptRoot = the app folder), so the runtime can live anywhere - the logs sit in the sibling
# ..\logs. The server's stdout+stderr are piped through logrotate-tee.js, which appends to
# ..\logs\server.log and rotates it by size (threshold + how many rotated files to keep are set in
# logrotate-tee.js, default 100 MB, keep 10).
$app  = $PSScriptRoot
$logs = Join-Path (Split-Path $app -Parent) "logs"
$log  = Join-Path $logs "server.log"
New-Item -ItemType Directory -Force $logs | Out-Null
while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content $log "[$ts] starting server"
  & cmd /c "node --no-deprecation $app\server.js 2>&1 | node $app\logrotate-tee.js"
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content $log "[$ts] server exited - restarting in 5s"
  Start-Sleep -Seconds 5
}
