# run-server.ps1 - keeps the Axle web server alive. Paths derive from this script's own folder
# ($PSScriptRoot = the app folder, i.e. the C:\Axle\app junction), so the runtime can live anywhere -
# the logs sit in the sibling ..\logs. The server's stdout+stderr are piped through logrotate-tee.js,
# which appends to ..\logs\server.log and rotates it by size (threshold + how many rotated files to
# keep are set in logrotate-tee.js, default 100 MB, keep 10).
#
# Deploy handover: switch-release.ps1 points app\ at the new release and drops ..\data\deploy\handover.
# This supervisor then starts the NEW release next to the old one; server.js loads everything and
# writes ..\data\deploy\ready while the old one keeps serving. Only then is the old process tree
# stopped, and the new one takes the port within a fraction of a second. The outcome goes to
# ..\data\deploy\handover-result for the deploy to read.
$app  = $PSScriptRoot
$base = Split-Path $app -Parent
$logs = Join-Path $base "logs"
$log  = Join-Path $logs "server.log"
$dep  = Join-Path $base "data\deploy"
New-Item -ItemType Directory -Force $logs, $dep | Out-Null

function Say($m) { Add-Content $log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $m" }
function Start-Node {
  Say "starting server"
  Start-Process -FilePath "cmd.exe" -NoNewWindow -PassThru `
    -ArgumentList "/c node --no-deprecation `"$app\server.js`" 2>&1 | node `"$app\logrotate-tee.js`""
}
function Stop-Tree($p) { taskkill /PID $p.Id /T /F 2>&1 | Out-Null }

$cur = Start-Node
while ($true) {
  if (Test-Path "$dep\handover") {
    Remove-Item "$dep\handover", "$dep\ready", "$dep\handover-result" -Force -ErrorAction SilentlyContinue
    Say "handover: starting the new release next to the running one"
    $new = Start-Node
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path "$dep\ready") -and -not $new.HasExited -and $sw.Elapsed.TotalSeconds -lt 120) { Start-Sleep -Milliseconds 200 }
    if (Test-Path "$dep\ready") {
      Stop-Tree $cur
      $cur = $new
      Say ("handover: new release loaded in {0:N0} s, old one stopped" -f $sw.Elapsed.TotalSeconds)
      Set-Content "$dep\handover-result" "ok"
    } else {
      Stop-Tree $new
      Say "handover FAILED: the new release did not load (see the lines above); the old one keeps running"
      Set-Content "$dep\handover-result" "failed: the new release did not load within 120 s, see C:\Axle\logs\server.log"
    }
  }
  if ($cur.HasExited) {
    Say "server exited - restarting in 1s"
    Start-Sleep -Seconds 1
    $cur = Start-Node
  }
  Start-Sleep -Milliseconds 500
}
