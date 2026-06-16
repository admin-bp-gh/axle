# run-server.ps1 - keeps the Axle web server alive; output to C:\Axle\logs\server.log
while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content C:\Axle\logs\server.log "[$ts] starting server"
  & cmd /c "node --no-deprecation C:\Axle\app\server.js >> C:\Axle\logs\server.log 2>&1"
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content C:\Axle\logs\server.log "[$ts] server exited - restarting in 5s"
  Start-Sleep -Seconds 5
}
