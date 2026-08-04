> **SUPERSEDED — NOT being done (decision reversed 2026-06-21).** Brad chose to keep `C:\Axle` (the
> running app) separate from `C:\Admin\Projects\Axle` (source + docs) — the standard source-vs-deployment
> split. The folder move described below is **cancelled**. The self-locating path changes in `box-code`
> remain valid and backward-compatible (they resolve to `C:\Axle` exactly as before) and are staged,
> deploy-whenever. The UX fixes shipped separately and are live. Kept for the record only.

# Axle — Move the runtime into the project folder + roll out the UX fixes

**Goal:** eliminate `C:\Axle` entirely. Everything Axle lives under `C:\Admin\Projects\Axle`.
The UX fixes (menu clipping, mobile Back, action-bar redesign) ship in the same cutover, so this is
one operation, not two.

**What I already did (in `box-code`, version-controlled):** made the app **self-locating** — every
runtime path is now resolved relative to the app folder (`__dirname` / `$PSScriptRoot`) instead of
being hardcoded to `C:\Axle`. That means the same code works at the old `C:\Axle\app` *and* at the
new location, so the folder move "just works". Files changed: `server.js`, `ingest.js`, `send.js`,
`backfill-atts.js`, `db.js`, `backup-db.js`, `verify-backup.js`, `logrotate-tee.js`,
`sprocket-store.js`, `sprocket.js`, `sap-doc-pdf.js`, `run-server.ps1`, `run-backup.ps1`, new
`run-ingest.ps1`, `.gitignore`. Plus the UX fixes from the review doc (`views/ui.js`,
`assets/components.css`, `routes/item.js`).

**What you do on the box (this runbook):** copy `C:\Axle` into the project folder, promote the
updated source, neutralise the old path lines in `.env`, fix one line in the Crystal `render-doc.ps1`,
repoint three scheduled tasks, verify, then delete `C:\Axle`.

---

## Target layout

```
C:\Admin\Projects\Axle\            (git repo: source of record + docs)
  box-code\                        the source you edit (git-tracked)        ← unchanged
  Backups\                         DB backups (already here)                ← unchanged
  docs / design-reference / ...    (docs, unchanged)
  runtime\                         THE LIVE RUNTIME — gitignored            ← was C:\Axle
    app\        (promoted copy of box-code, with node_modules)              ← was C:\Axle\app
    data\axle.db                                                            ← was C:\Axle\data
    secrets\.env                                                            ← was C:\Axle\secrets
    logs\                                                                   ← was C:\Axle\logs
    sprocket\   (feature-requests.jsonl/.md, axle-help.md)                  ← was C:\Axle\sprocket
    render\     (render-doc.ps1, out\)                                      ← was C:\Axle\render
    layouts\    (Documents.rpt)                                             ← was C:\Axle\layouts
```

`runtime\` is gitignored (it holds secrets + the DB + logs — never committed).

> **Do this in a quiet window** (e.g. evening). The tool is briefly offline during the cutover
> (a few minutes). Nothing should write to the database while it's stopped, so there's no split-brain.

---

## Step 0 — Safety backup (so rollback is trivial)

Open **PowerShell as Administrator** on the box. Take a full, separate copy of `C:\Axle` (kept
outside the git repo, under `C:\Admin`). This is your rollback source.

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmmss
$safe = "C:\Admin\Axle-migration-backup-$ts"
robocopy C:\Axle $safe /E /COPYALL /R:1 /W:1 /NFL /NDL | Out-Null
Write-Host "Safety copy at $safe (exit $LASTEXITCODE; 0-7 = success)"
```

A fresh DB backup also already lands in `C:\Admin\Projects\Axle\Backups\` daily — confirm the newest
is recent:

```powershell
Get-ChildItem C:\Admin\Projects\Axle\Backups\axle-*.db | Sort LastWriteTime -Desc | Select -First 1
```

## Step 1 — Stop the three scheduled tasks

```powershell
Stop-ScheduledTask -TaskName "Axle Server"
Stop-ScheduledTask -TaskName "Axle Ingest"
Stop-ScheduledTask -TaskName "Axle Backup"
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force   # make sure node is down
Start-Sleep 3
```

## Step 2 — Copy C:\Axle into the project folder

Copy (don't move yet — we keep `C:\Axle` as the rollback source until you've verified). This includes
`node_modules`, so there's no `npm install` and the compiled `better-sqlite3` binding comes along.

```powershell
$rt = "C:\Admin\Projects\Axle\runtime"
robocopy C:\Axle $rt /E /COPYALL /R:1 /W:1 /NFL /NDL | Out-Null
Write-Host "Copied to $rt (exit $LASTEXITCODE; 0-7 = success)"
```

## Step 3 — Promote the updated source into runtime\app

This overlays the self-locating + UX-fixed source onto the copied app (leaving `node_modules` intact).

```powershell
$src = "C:\Admin\Projects\Axle\box-code"; $app = "C:\Admin\Projects\Axle\runtime\app"
robocopy $src $app /E /XD node_modules /R:1 /W:1 /NFL /NDL | Out-Null
# syntax-check the entrypoints (should print nothing):
node --check "$app\server.js"; node --check "$app\ingest.js"; node --check "$app\db.js"
Write-Host "Promoted. node --check exit: $LASTEXITCODE (0 = clean)"
```

## Step 4 — Neutralise the old path lines in .env

The app now self-locates `data`, `logs`, `sprocket` relative to the app folder, so any `.env` line
that pins those to `C:\Axle` must go (otherwise it would still point at the old, soon-deleted folder).
Show what's there:

```powershell
Select-String C:\Admin\Projects\Axle\runtime\secrets\.env -Pattern 'AXLE_DB|AXLE_SPROCKET_DIR|AXLE_LOG|AXLE_LOGS|AXLE_BACKUP_LOG|C:\\Axle'
```

Open `C:\Admin\Projects\Axle\runtime\secrets\.env` in Notepad and **comment out (put `#` in front of)
every line that sets a path under `C:\Axle`** — typically `AXLE_DB`, `AXLE_SPROCKET_DIR`, `AXLE_LOG`,
`AXLE_LOGS`, `AXLE_BACKUP_LOG`. **Keep** `AXLE_BACKUP_DIR` (it already points at
`C:\Admin\Projects\Axle\Backups`) and **keep every secret/URL** (`SQL_*`, `SHOPIFY_*`,
`MYPARCEL_API_KEY`, `AXLE_ACTION_*`, `AXLE_SPROCKET_NOTIFY*`, `AXLE_ALLOWED_ORIGIN`, `AXLE_BASE_URL`).
Save.

## Step 5 — Fix the Crystal renderer's layout path

The SAP-document PDF renderer (`render-doc.ps1`) lives only on the box and references the `.rpt`
layout by absolute path. Show it:

```powershell
Select-String C:\Admin\Projects\Axle\runtime\render\render-doc.ps1 -Pattern 'C:\\Axle'
```

Open `C:\Admin\Projects\Axle\runtime\render\render-doc.ps1` and change any
`C:\Axle\layouts\Documents.rpt` (and any other `C:\Axle\...`) to the new location
`C:\Admin\Projects\Axle\runtime\layouts\Documents.rpt`. Save.

## Step 6 — Repoint the three scheduled tasks (Task Scheduler GUI)

> The runbook notes `Set-ScheduledTask` fails for these (they store the `axle` account password), so
> edit them in the **Task Scheduler GUI** — it re-prompts for the password on save.

Open **Task Scheduler** → Task Scheduler Library. For each task, double-click → **Actions** tab →
Edit the action and set the script path; also set **"Start in"** to the app folder:

| Task          | Program/script           | Arguments                                                              | Start in                                  |
|---------------|--------------------------|-----------------------------------------------------------------------|-------------------------------------------|
| Axle Server   | `powershell.exe`         | `-NoProfile -ExecutionPolicy Bypass -File C:\Admin\Projects\Axle\runtime\app\run-server.ps1` | `C:\Admin\Projects\Axle\runtime\app` |
| Axle Ingest   | `powershell.exe`         | `-NoProfile -ExecutionPolicy Bypass -File C:\Admin\Projects\Axle\runtime\app\run-ingest.ps1` | `C:\Admin\Projects\Axle\runtime\app` |
| Axle Backup   | `powershell.exe`         | `-NoProfile -ExecutionPolicy Bypass -File C:\Admin\Projects\Axle\runtime\app\run-backup.ps1` | `C:\Admin\Projects\Axle\runtime\app` |

(Match your existing argument style — the only change is `C:\Axle\app` → `C:\Admin\Projects\Axle\runtime\app`.)
Save each (enter the `axle` password when prompted).

## Step 7 — Start and verify (before deleting anything)

```powershell
Start-ScheduledTask -TaskName "Axle Server"
Start-Sleep 8
Get-Content C:\Admin\Projects\Axle\runtime\logs\server.log -Tail 6   # expect a "starting server" line
```

Verify each subsystem — **do not delete `C:\Axle` until all pass:**

1. **Web + UX:** open the tool over Tailscale (`https://axle-box.tail58a804.ts.net`, hard-refresh
   Ctrl+F5). Queue loads. Open an item: the action bar reads `Send · Save · Save & redraft … Mark done
   · ⋯ More actions` on one line; open **More actions** → the menu shows fully, not clipped behind the
   list. Page source shows `components.css?v=polaris6`.
2. **Ingest/sync:** `Start-ScheduledTask -TaskName "Axle Ingest"`, then
   `Get-Content C:\Admin\Projects\Axle\runtime\logs\ingest.log -Tail 5` — a clean run, no env errors.
3. **Backup:** `node C:\Admin\Projects\Axle\runtime\app\backup-db.js` — a new `axle-*.db` appears in
   `Backups\` and `runtime\logs\backup.log` shows `OK`.
4. **Sprocket:** click the cog, ask "how do I send a reply?" — it answers (reads
   `runtime\sprocket\axle-help.md`); existing feature-requests still listed under Requests.
5. **SAP-doc PDF:** open an email item, attach a SAP document by number → it renders the PDF (this
   exercises `runtime\render\render-doc.ps1` + `runtime\layouts\Documents.rpt`).

## Step 8 — Delete C:\Axle

Once all five checks pass (give it a day of live use if you like — the safety copy from Step 0 is your
backstop):

```powershell
Remove-Item C:\Axle -Recurse -Force
Write-Host "C:\Axle removed. Everything now lives under C:\Admin\Projects\Axle."
```

After a few stable days, delete the safety copy too: `Remove-Item C:\Admin\Axle-migration-backup-* -Recurse -Force`.

Optionally commit the source changes: from `C:\Admin\Projects\Axle` →
`git add -A; git commit -m "Relocatable runtime (self-locating paths) + UX fixes; runtime under project folder"`.
(The `runtime\` folder is gitignored, so secrets/DB are never staged.)

---

## Rollback (if a check fails in Step 7)

`C:\Axle` is untouched until Step 8, so rollback is just repointing back:

```powershell
Stop-ScheduledTask -TaskName "Axle Server","Axle Ingest","Axle Backup"
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```
Then in Task Scheduler set the three tasks' `-File` / Start-in back to `C:\Axle\app`, and
`Start-ScheduledTask -TaskName "Axle Server"`. You're back on the original. (Delete the half-built
`runtime\` folder to retry: `Remove-Item C:\Admin\Projects\Axle\runtime -Recurse -Force`.)

---

## Loose ends (non-blocking)

These **dev/test/utility scripts** in `box-code` still hardcode `C:\Axle` and would break only if you
run them by hand after the move — they are **not used by the live tool**: `triage.js`,
`compose-test.js`, `discount-e2e.js`, `drafts2.js`, `resolve-test.js`, `send-test.js`,
`myparcel-test.js`, `wipe-slate.js`, `hardening/harness.js`, and the legacy `axle-pull.ps1`
(Taildrop puller, obsolete under box-local promote). The fix is the same one-line `.env` swap I made
in the live modules. **I can sweep all of these in a 2-minute follow-up — say the word.**

The project **documents** are already all inside `C:\Admin\Projects\Axle` (top level). If you'd like
the loose docs grouped into `docs/` and historical build-briefs into `docs/archive/`, I can do that
too — it's cosmetic and I left it out to avoid churn right before the migration.
