# run-server.ps1 - keeps the Axle web server alive. The server's stdout+stderr are piped
# through logrotate-tee.js, which appends to C:\Axle\logs\server.log and rotates it by size
# (the tee owns the file handle, so rotation is a clean close->rename->reopen). Threshold and
# how many rotated files to keep are set in logrotate-tee.js (default 100 MB, keep 10).
while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content C:\Axle\logs\server.log "[$ts] starting server"
  & cmd /c "node --no-deprecation C:\Axle\app\server.js 2>&1 | node C:\Axle\app\logrotate-tee.js"
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content C:\Axle\logs\server.log "[$ts] server exited - restarting in 5s"
  Start-Sleep -Seconds 5
}
