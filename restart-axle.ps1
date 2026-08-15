# restart-axle.ps1 — restart the Axle Server task, elevated, and prove it actually restarted.
#
# The runbook has pointed at this script since June. It did not exist until 2026-08-15, which was
# discovered mid-deploy with the server down — the worst possible moment to find out. It exists now.
#
# Why elevation is not optional: the "Axle Server" scheduled task runs as the low-privilege `axle`
# account, so from an ordinary shell both Stop-ScheduledTask and Start-ScheduledTask fail with
# "Access is denied" — the restart silently does nothing and you are left staring at old code.
# This self-elevates (one UAC prompt) so that cannot happen.
#
# Why it checks the PID: "the command ran without error" is not the same as "the server came back
# on new code". It records the PID listening on 8484 before and after and tells you plainly whether
# it changed, went missing, or stayed the same.
#
# Usage:  right-click -> Run with PowerShell   (or: C:\Admin\Projects\Axle\restart-axle.ps1)
#         -Wait 20   allow longer than the default 10s for the server to come back

param([int]$Wait = 10)

$ErrorActionPreference = "Stop"
$port = 8484
$log  = "C:\Admin\Projects\Axle\restart-axle.log"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated - relaunching as administrator (approve the UAC prompt)..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`"","-Wait",$Wait)
  Start-Sleep -Seconds 3      # keep this window up briefly so a failed relaunch is visible
  exit
}

function Say($msg, $colour = "Gray") {
  Write-Host $msg -ForegroundColor $colour
  "$(Get-Date -Format 'HH:mm:ss')  $msg" | Out-File $log -Append -Encoding utf8
}
function ListenerPid {
  (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
}

try {
  "=== restart-axle.ps1  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Append -Encoding utf8
  Say "Running as: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"

  $before = ListenerPid
  Say $(if ($before) { "Before: UP on $port, PID $before" } else { "Before: DOWN (nothing listening on $port)" })

  Say "Stopping Axle Server..."
  Stop-ScheduledTask -TaskName "Axle Server"
  Start-Sleep -Seconds 2
  Say "Starting Axle Server..."
  Start-ScheduledTask -TaskName "Axle Server"

  # Poll rather than sleep-and-hope: it is usually back in 2-3s, and polling means a slow start
  # reports honestly instead of failing a fixed deadline.
  $after = $null
  for ($i = 0; $i -lt $Wait; $i++) {
    Start-Sleep -Seconds 1
    $after = ListenerPid
    if ($after -and $after -ne $before) { break }
  }

  if (-not $after) {
    Say "DOWN - nothing is listening on $port after ${Wait}s." "Red"
    Say "Last 20 lines of the server log:" "Yellow"
    Get-Content C:\Axle\logs\server.log -Tail 20 | ForEach-Object { Say "  $_" }
    Say "Most likely a missing module or a syntax error in freshly deployed code." "Yellow"
    exit 1
  }
  if ($before -and $before -eq $after) {
    Say "WARNING: same PID ($after) - the task may not have restarted, so new code may NOT be loaded." "Yellow"
    exit 1
  }
  Say "OK - restarted. PID $before -> $after" "Green"
}
catch {
  Say "FAILED: $($_.Exception.Message)" "Red"
  Say $_.ScriptStackTrace
  exit 1
}
finally {
  Write-Host "`nLog: $log"
  Read-Host "`nPress Enter to close"
}
