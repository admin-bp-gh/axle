# Axle — Server runbook (the box)

How the Axle web server runs on the Gouda box, and the exact commands to operate it.
Box-local workflow (no Mac/Taildrop). All commands are PowerShell on the box.

## How it runs

- **Scheduled Task `Axle Server`** starts at boot, as the dedicated low-privilege **`axle`**
  account (runs whether or not anyone is logged in), and launches the watchdog wrapper
  `C:\Axle\app\run-server.ps1`.
- **`run-server.ps1`** is a keep-alive loop: it runs `node server.js`, and if node ever
  exits it logs the exit and relaunches it 5 seconds later. So a crash self-heals.
- **`server.js`** binds **127.0.0.1:8484** only. **Tailscale Serve** terminates HTTPS on the
  tailnet and injects the visitor identity; there is no public port. The team reaches Axle
  over Tailscale.
- Config/secrets come from **`C:\Axle\secrets\.env`** (loaded by dotenv). Data lives in
  **`C:\Axle\data\axle.db`** (SQLite, WAL — crash-safe; the server also self-repairs stuck
  items/sync locks on startup). Logs: **`C:\Axle\logs\server.log`**.
- A second task, **`Axle Ingest`**, runs the mailbox ingest on its own schedule.

### Resilience (hardened 2026-06-16)

- Boot-start as `axle`, whether-logged-on, Limited privilege.
- Watchdog loop auto-restarts node on crash.
- **No execution time limit** (`ExecutionTimeLimit = PT0S`) — was `PT72H`, which used to stop
  the server every 3 days.
- **Battery-proof** (`DisallowStartIfOnBatteries = False`, `StopIfGoingOnBatteries = False`) —
  a power blip carried by the laptop battery no longer stops Axle.

## Daily operations

**Is it up?**
```powershell
$c = Get-NetTCPConnection -LocalPort 8484 -State Listen -ErrorAction SilentlyContinue
if ($c) { "UP — PID $($c.OwningProcess)" } else { "DOWN" }
```

**Restart** (the one-liner — use after a deploy):
```powershell
Stop-ScheduledTask -TaskName "Axle Server"; Start-ScheduledTask -TaskName "Axle Server"
```
(There is no `Restart-ScheduledTask` cmdlet; stop-then-start is the equivalent. `Stop` kills
the wrapper + its node; `Start` relaunches from boot state.)

**Stop / Start individually:**
```powershell
Stop-ScheduledTask  -TaskName "Axle Server"
Start-ScheduledTask -TaskName "Axle Server"
```

**Watch the log (live):**
```powershell
Get-Content C:\Axle\logs\server.log -Tail 40 -Wait
```

**Check the task settings are still hardened:**
```powershell
(Get-ScheduledTask -TaskName "Axle Server").Settings |
  Select-Object ExecutionTimeLimit, DisallowStartIfOnBatteries, StopIfGoingOnBatteries
# expect: PT0S, False, False
```

> Editing this task in PowerShell (`Set-ScheduledTask`) fails with *"user name or password is
> incorrect"* because it runs under the stored `axle` password. Change its settings in the
> **Task Scheduler GUI** (it re-prompts for the password) — not via `Set-ScheduledTask`.

## Deploying changed app files (box-local)

1. Copy the changed file(s) from the repo into the puller's inbox:
   ```powershell
   Copy-Item C:\Admin\Projects\Axle\box-code\<path>\<file> C:\Axle\_incoming
   ```
2. Place + syntax-check them into the live tree (routes each by name; `node --check` on JS):
   ```powershell
   C:\Axle\axle-pull.ps1
   ```
   If any JS reports `FAIL`, **do not restart** — fix first.
3. Restart (the one-liner above).
4. Verify over Tailscale (hard-refresh). For a CSS/asset change, confirm the new
   `?v=` cache-buster in page source.

## Crash-recovery proof (run when quiet)

Kills node; the watchdog must bring it back within ~8s. Safe — the server self-repairs on
restart. ~5–8s blip, so pick a quiet moment.
```powershell
$before = (Get-NetTCPConnection -LocalPort 8484 -State Listen).OwningProcess
Stop-Process -Id $before -Force
Start-Sleep -Seconds 8
$after = (Get-NetTCPConnection -LocalPort 8484 -State Listen -ErrorAction SilentlyContinue).OwningProcess
"before PID $before / after PID $after  (different PID = recovered)"
Get-Content C:\Axle\logs\server.log -Tail 4
```

## Backups (DB) — added 2026-06-16

The SQLite DB is backed up by a **consistent online backup**, never a raw file copy
(`axle.db` is WAL and held open by the running server).

- **What runs:** scheduled task **`Axle Backup`** — daily **03:00**, as the low-privilege
  **`axle`** account (Limited, whether-logged-on, battery-proof, 1h time limit). It runs
  `C:\Axle\app\run-backup.ps1` → `node C:\Axle\app\backup-db.js`.
- **How:** `backup-db.js` opens the live DB read-only and uses better-sqlite3's `.backup()`
  (SQLite's online backup API) to copy it page-by-page into one standalone file, then runs
  `PRAGMA integrity_check` on the copy and prunes copies older than **7 days**.
- **Destination:** `C:\Admin\Projects\Axle\Backups\axle-YYYYMMDD-HHMMSS.db`. The folder is
  inside the repo but git-ignored (`Backups/`), so the `.db` copies are never committed. The
  `axle` account has Modify on this one folder only (`icacls … /grant "axle:(OI)(CI)M"`).
- **Log:** one line per run in `C:\Axle\logs\backup.log` (`OK …` or `FAIL …`).

**Run a backup on demand:**
```powershell
Start-ScheduledTask -TaskName "Axle Backup"     # exactly as the 03:00 run does
# or, interactively as yourself:
node C:\Axle\app\backup-db.js
```

**Verify a backup matches the live DB** (table set, row counts, integrity — newest by default):
```powershell
node C:\Axle\app\verify-backup.js
```
Counts may read `live +N` on busy tables — that's the live DB moving on after the snapshot,
and still passes. `backup +N`, a missing table, or `integrity_check ≠ ok` is a fail.

**Restore from a backup** (replaces the live DB — server stopped):
```powershell
Stop-ScheduledTask -TaskName "Axle Server"
Copy-Item C:\Admin\Projects\Axle\Backups\axle-YYYYMMDD-HHMMSS.db C:\Axle\data\axle.db -Force
# drop any stale WAL sidecars so SQLite opens the restored file cleanly:
Remove-Item C:\Axle\data\axle.db-wal, C:\Axle\data\axle.db-shm -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "Axle Server"
```
Each backup is a complete standalone database, so restoring is just copying it into place.

## Rebuild from scratch (high level)

1. Install Node (match the box version, currently v24) and Tailscale; join the tailnet.
2. Restore `C:\Axle\app` (or merge `main` + run `axle-pull.ps1`), `C:\Axle\secrets\.env`,
   and `C:\Axle\data\axle.db` (from the newest `Backups\axle-*.db` — see **Backups** above).
3. Recreate the `axle` local account; create the **Axle Server** and **Axle Ingest** scheduled
   tasks: run as `axle`, **At startup** trigger, Limited privilege, `ExecutionTimeLimit = PT0S`,
   both battery conditions off; action = `powershell -ExecutionPolicy Bypass -File
   C:\Axle\app\run-server.ps1`.
4. `tailscale serve --bg 8484`. Verify over Tailscale.

## Follow-ups (Phase 7)

- **DB backup** — done 2026-06-16 (see **Backups (DB)** above).
- **Log rotation**: `C:\Axle\logs\server.log` grows unbounded — add a simple rotation.
