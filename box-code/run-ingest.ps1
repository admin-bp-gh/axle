# run-ingest.ps1 - one watermark ingest pass over info@ + drachten@ (every email new since the last
# sync), followed by the Outlook->Axle reconciliation. Invoked by the "Axle Ingest" scheduled task.
# Paths derive from $PSScriptRoot (the app folder), so the runtime can live anywhere; the log sits
# in the sibling ..\logs. ingest.js loads its own .env relative to itself.
#
# REPO/BOX DRIFT, resolved 2026-07-27: the copy running on the box was NOT this file. It ran
# `cmd /c "node ingest.js all >> ingest.log 2>&1"` and wrote start/end markers - which is why
# ingest.log had real content while this version only logged wrapper failures. This file now
# matches what the box actually needs, with the logging fixed.
#
# Logging. The old `>>` redirect had two problems: the log never rotated (unbounded, 13.5 MB since
# June), and the redirect holds the file open for the whole run, so it COULDN'T be rotated even by
# hand - Windows won't rename or truncate a file held open like that. That is precisely why
# logrotate-tee.js exists for server.log, so ingest.log now goes through the same tee: the tee owns
# the handle and rotates with a clean close -> rename -> reopen. Fixing this was a prerequisite for
# raising the schedule to a 2-minute weekday cadence (~10x the previous number of runs).
#
# 20 MB x 5 rotated files = a ~100 MB ceiling (server.log's default is 100 MB x 10; ingest is
# chattier per run but far less valuable to keep long).
#
# NOTE the two Add-Content marker lines are safe alongside the tee: the tee process lives only for
# the duration of the node run, so nothing else holds the file open when they are written. This is
# the same arrangement run-server.ps1 uses, and the `cmd /c "... | node logrotate-tee.js"` form
# (piping inside cmd rather than in PowerShell) is copied from it deliberately - it is the proven
# idiom on this box and sidesteps PowerShell's object-pipeline encoding.
$app  = $PSScriptRoot
$logs = Join-Path (Split-Path $app -Parent) "logs"
$log  = Join-Path $logs "ingest.log"
New-Item -ItemType Directory -Force $logs | Out-Null

# Consumed by logrotate-tee.js (child processes inherit these).
$env:AXLE_LOG           = $log
$env:AXLE_LOG_MAX_BYTES = 20MB
$env:AXLE_LOG_KEEP      = 5

$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $log "[$ts] ingest run start (info@ + drachten@, since last sync)"
& cmd /c "node --no-deprecation $app\ingest.js all 2>&1 | node $app\logrotate-tee.js"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $log "[$ts] ingest run end"
