# Axle — Server runbook (the box)

How the Axle web server runs on the Gouda box, and the exact commands to operate it.
Box-local workflow (no Mac/Taildrop). All commands are PowerShell on the box.

## How it runs

- **Scheduled Task `Axle Server`** starts at boot, as the dedicated low-privilege **`axle`**
  account (runs whether or not anyone is logged in), and launches the watchdog wrapper
  `C:\Axle\app\run-server.ps1`.
- **`run-server.ps1`** is a keep-alive loop: it runs `node server.js`, and if node ever
  exits it logs the exit and relaunches it 5 seconds later. So a crash self-heals. The
  server's output is piped through `logrotate-tee.js`, which rotates `server.log` by size
  (see **Log rotation**).
- **`server.js`** binds **127.0.0.1:8484** only. **Tailscale Serve** terminates HTTPS on the
  tailnet and injects the visitor identity; there is no public port. The team reaches Axle
  over Tailscale.
- Config/secrets come from **`C:\Axle\secrets\.env`** (loaded by dotenv). Data lives in
  **`C:\Axle\data\axle.db`** (SQLite, WAL — crash-safe; the server also self-repairs stuck
  items/sync locks on startup). Logs: **`C:\Axle\logs\server.log`** (rotated by size — see
  **Log rotation**).
- A second task, **`Axle Ingest`**, runs the mailbox ingest (and the Outlook->Axle close pass) on
  its own schedule — see **Ingest schedule**. Its output is rotated too (see **Log rotation**).

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

## Source of truth — the repo, never the box

**`C:\Admin\Projects\Axle` is the only source of truth.** It is the git repo (`main`,
remote `github.com/admin-bp-gh/axle`); app source lives in `box-code\`. `C:\Axle\app` is a
*deployment target* — files arrive there only via `axle-pull.ps1`, and nothing is ever
edited there directly.

**`C:\Axle\app` is not a git repository.** Until 2026-08-05 it contained one — an abandoned
local repo on branch `master`, no remote, last commit 11 June 2026, whose working tree had
since drifted ~4,300 lines from its own HEAD. A `git checkout` or `git reset --hard` run in
that folder would have reverted the **running application** to its June state. It has been
renamed to `.git-retired-20260611` so git no longer recognises the folder, and its 51
commits (the pre-import history, which exists nowhere else) are archived at
`Backups\axle-app-prehistory-20260611.bundle` — restore with
`git clone <bundle> <dir>` if ever needed.

On a rebuild: clone the repo, deploy from it, and do **not** re-initialise git under
`C:\Axle\app`.

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

## Ingest schedule — changed 2026-07-27

`Axle Ingest` runs `C:\Axle\app\run-ingest.ps1` (→ `node ingest.js all`, then the Outlook→Axle
close pass). It was a single trigger repeating **every 15 minutes** indefinitely. It now has
**three** triggers so Axle tracks the mailbox closely during the working day and stays cheap
overnight:

| Trigger | When | Every |
|---|---|---|
| Weekly, Mon–Fri, 08:00, for 10h | office hours | **2 min** |
| Daily, 18:00, for 14h | every night 18:00–08:00 | 10 min |
| Weekly, Sat–Sun, 08:00, for 10h | weekend days | 10 min |

**Why this is safe.** Drafting cost is per-EMAIL, not per-run — the same mail is drafted either
way, just sooner — and a quiet run is only a couple of Graph list calls plus one batched read. Graph
throttling is nowhere near (hundreds of calls/hour against thousands per 10 min).

**Runs overlap, and that is fine.** A quiet run takes about **80 seconds** (SAP pool init, Graph
token, sequential folder fetches) — so at a 2-minute trigger a quiet run just fits, and a run that
does real drafting will exceed it. `acquireSync` makes the next trigger **skip** rather than queue,
logging "Another sync is already in progress". Busy periods therefore self-regulate to back-to-back
runs. A skipped run in the log is normal, not a fault. (The lock also self-clears if a run dies:
`acquireSync` steals a lock older than 10 minutes.)

**Editing the triggers.** `Set-ScheduledTask` fails on these tasks ("user name or password is
incorrect") because they run under the stored `axle` password. Either use the Task Scheduler GUI, or
re-register while REUSING the existing objects so the hardening survives:

```powershell
$t = Get-ScheduledTask -TaskName "Axle Ingest"
$cred = Get-Credential -UserName $t.Principal.UserId -Message "Password for the axle account"
Register-ScheduledTask -TaskName "Axle Ingest" -Force `
  -Action $t.Actions -Settings $t.Settings -Trigger @($week,$night,$wknd) `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited
```
(Weekly/Daily triggers don't accept `-RepetitionInterval` directly; build the repetition from a
throwaway `-Once` trigger and assign `.Repetition`.)

## Log rotation (server.log + ingest.log)

### ingest.log — added 2026-07-27

`C:\Axle\logs\ingest.log` was **never rotated** and had grown unbounded to 13.5 MB since 7 June.
The box's `run-ingest.ps1` had also DRIFTED from the repo copy: it ran
`cmd /c "node ingest.js all >> ingest.log 2>&1"`. That `>>` redirect is exactly the problem
`logrotate-tee.js` was written for — it holds the log open for the whole run, so the file cannot be
renamed or truncated even by hand. Fixing this was a prerequisite for the 2-minute cadence (~10x the
runs: ~400/day).

`run-ingest.ps1` now pipes through the same tee as the server, with a smaller budget:
`AXLE_LOG=…\ingest.log`, `AXLE_LOG_MAX_BYTES=20MB`, `AXLE_LOG_KEEP=5` → a **~100 MB ceiling**.
The repo copy is now the authoritative one. At ~30–40 lines per run that is roughly 2–3 months of
history; the log is something to grep, not read. (If it ever needs trimming, make a no-change run
log one line instead of a full `console.table`.)

The existing 13.5 MB file was archived by hand as `ingest.log.1` when this went in.

### server.log — added 2026-06-16

`C:\Axle\logs\server.log` is rotated by size so it can't grow unbounded.

- **What runs:** the watchdog pipes the server's stdout+stderr through
  `C:\Axle\app\logrotate-tee.js` (`node … server.js 2>&1 | node logrotate-tee.js`). The tee
  appends to `server.log` and, on reaching the threshold, rotates: `server.log.10` is dropped,
  each `server.log.N` shifts to `.N+1`, `server.log` becomes `server.log.1`, and a fresh
  `server.log` is opened.
- **Why a tee** (not a rename/truncate of the live log): the log is held open for the
  server's whole run, and Windows won't rename or truncate a file held open like that
  (`The process cannot access the file because it is being used by another process`). The tee
  is itself the writer, so it owns the handle and rotates with a clean close→rename→reopen.
- **Settings:** threshold **100 MB**, keep **10** files (`server.log.1` … `.10`) — worst-case
  log footprint ≈ 1.1 GB. Both are constants near the top of `logrotate-tee.js` (overridable
  for testing via `AXLE_LOG_MAX_BYTES` / `AXLE_LOG_KEEP`). The server keeps logging across a
  rotation; nothing is lost.

**Inspect rotated logs** (`.1` is the most recent rotation; the highest number is the oldest):
```powershell
Get-ChildItem C:\Axle\logs\server.log* | Select-Object Name, Length, LastWriteTime
Get-Content  C:\Axle\logs\server.log.1 -Tail 40    # previous segment
```

**Change the threshold or keep-count:** edit the `MAX` / `KEEP` defaults in
`box-code\logrotate-tee.js`, deploy (`_incoming` + `axle-pull.ps1`), then restart the server —
it takes effect on the next server start.

## Rebuild from scratch (high level)

1. Install Node (match the box version, currently v24) and Tailscale; join the tailnet.
2. Restore `C:\Axle\app` (or merge `main` + run `axle-pull.ps1`), `C:\Axle\secrets\.env`,
   and `C:\Axle\data\axle.db` (from the newest `Backups\axle-*.db` — see **Backups** above).
3. Recreate the `axle` local account; create the **Axle Server** and **Axle Ingest** scheduled
   tasks: run as `axle`, **At startup** trigger, Limited privilege, `ExecutionTimeLimit = PT0S`,
   both battery conditions off; action = `powershell -ExecutionPolicy Bypass -File
   C:\Axle\app\run-server.ps1`. Recreate the **Axle Backup** task too (daily 03:00, as `axle`,
   Limited; action = `… -File C:\Axle\app\run-backup.ps1`) and grant `axle` Modify on the
   backup folder (`icacls "C:\Admin\Projects\Axle\Backups" /grant "axle:(OI)(CI)M"`).
4. `tailscale serve --bg 8484`. Verify over Tailscale.

## Follow-ups (Phase 7)

- **DB backup** — done 2026-06-16 (see **Backups (DB)** above).
- **Log rotation** — `server.log` done 2026-06-16; `ingest.log` done 2026-07-27 (see **Log
  rotation** above).
