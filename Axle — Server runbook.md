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

## Rebuild from scratch (high level — Phase 7 will detail backups)

1. Install Node (match the box version, currently v24) and Tailscale; join the tailnet.
2. Restore `C:\Axle\app` (or merge `main` + run `axle-pull.ps1`), `C:\Axle\secrets\.env`,
   and `C:\Axle\data\axle.db`.
3. Recreate the `axle` local account; create the **Axle Server** and **Axle Ingest** scheduled
   tasks: run as `axle`, **At startup** trigger, Limited privilege, `ExecutionTimeLimit = PT0S`,
   both battery conditions off; action = `powershell -ExecutionPolicy Bypass -File
   C:\Axle\app\run-server.ps1`.
4. `tailscale serve --bg 8484`. Verify over Tailscale.

## Follow-ups (Phase 7 — not yet done)

- **DB backup**: schedule a periodic copy of `C:\Axle\data\axle.db` (with the running server,
  use SQLite `.backup`/`VACUUM INTO`, not a raw file copy) to a safe location.
- **Log rotation**: `C:\Axle\logs\server.log` grows unbounded — add a simple rotation.
