# switch-release.ps1 - put a built Axle release folder live. Called by deploy.ps1 and rollback.ps1
# (both elevated: the server runs as the low-privilege axle account).
#
# C:\Axle\app is a junction to the live release; releases sit next to it (C:\Axle\app-<commit>-<stamp>)
# so the server's __dirname\.. is still C:\Axle (data\, secrets\, logs\, sprocket\).
#
# Normal switch (handover): repoint the junction and ask the running supervisor (run-server.ps1) to
# start the new release next to the old one. The old one serves until the new one has loaded; the
# gap without a server is well under a second.
# Full restart, only when run-server.ps1 itself changed (the running supervisor is the old code) or
# on the first switch away from the old in-place C:\Axle\app folder: stop the task, switch, start.
# -NoRestart: repoint the junction only (asset or test-only changes); the running server keeps its code.
param([Parameter(Mandatory = $true)][string]$Release, [switch]$NoRestart)
$ErrorActionPreference = "Stop"
$link = "C:\Axle\app"; $dep = "C:\Axle\data\deploy"; $port = 8484
if (-not (Test-Path "$Release\server.js")) { throw "$Release is not an Axle release (no server.js)." }

function Set-Link($target) {
  if (Test-Path $link) { cmd /c rmdir "$link" }   # removes the junction only, never the release behind it
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}
function Listener { (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

$cur  = Get-Item $link -Force -ErrorAction SilentlyContinue
$live = if ($cur -and $cur.LinkType -eq "Junction") { @($cur.Target)[0] } else { $null }
if ($NoRestart) {
  if (-not $live) { throw "-NoRestart needs app\ to be a junction already; run one normal deploy first." }
  Set-Link $Release
  "files switched to $(Split-Path $Release -Leaf); server left running on its loaded code."
  return
}
$sameSupervisor = $live -and ((Get-FileHash "$live\run-server.ps1").Hash -eq (Get-FileHash "$Release\run-server.ps1").Hash)
$before = Listener
$sw = [Diagnostics.Stopwatch]::StartNew()

if ($sameSupervisor) {
  New-Item -ItemType Directory -Force $dep | Out-Null
  Remove-Item "$dep\handover-result" -Force -ErrorAction SilentlyContinue
  Set-Link $Release
  Set-Content "$dep\handover" $Release
  "new release loading next to the live one (users are not affected while it loads)..."
  while (-not (Test-Path "$dep\handover-result") -and $sw.Elapsed.TotalSeconds -lt 140) { Start-Sleep -Milliseconds 250 }
  $result = if (Test-Path "$dep\handover-result") { (Get-Content "$dep\handover-result" -Raw).Trim() } else { "no answer from the supervisor within 140 s" }
  if ($result -ne "ok") {
    Set-Link $live
    throw "Handover failed ($result). app\ points back at $(Split-Path $live -Leaf), which is still serving."
  }
} else {
  "full restart: run-server.ps1 changed or this is the first switch (later deploys hand over without a restart)"
  Stop-ScheduledTask -TaskName "Axle Server"
  Start-Sleep -Seconds 2
  $l = Listener; if ($l) { Stop-Process -Id $l -Force -ErrorAction SilentlyContinue }
  if ($cur -and -not $live) {
    # Another Axle task (ingest, report, backup) may briefly hold a file in app\; give it a minute.
    $renamed = $false
    foreach ($i in 1..30) {
      try { Rename-Item $link "app-legacy-$(Get-Date -Format 'yyyyMMdd-HHmmss')"; $renamed = $true; break } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $renamed) {
      Start-ScheduledTask -TaskName "Axle Server"   # back up on the old folder rather than left down
      throw "Could not rename C:\Axle\app (something still has it open: an Axle task, a window or a terminal inside it). Axle restarted on the old folder; re-run the deploy."
    }
  }
  Set-Link $Release
  Start-ScheduledTask -TaskName "Axle Server"
}

$after = $null
foreach ($i in 1..240) { $after = Listener; if ($after -and $after -ne $before) { break }; Start-Sleep -Milliseconds 250 }
if (-not $after -or $after -eq $before) { throw "Axle is not listening on a new process after the switch - check C:\Axle\logs\server.log. To go back: C:\Admin\Projects\Axle\rollback.ps1" }
("live on {0} after {1:N1} s (PID {2} -> {3})" -f (Split-Path $Release -Leaf), $sw.Elapsed.TotalSeconds, $before, $after)
if ($sameSupervisor) { "(most of that was the new release loading next to the old one; the switch itself is under a second)" }
