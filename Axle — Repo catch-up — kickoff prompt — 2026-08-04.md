# Axle — repo catch-up — kickoff prompt (2026-08-04)

Paste the section below into a fresh session.

---

## Mission

Get seven weeks of working, deployed Axle code committed into git in a small number of coherent
commits, without breaking the running server and without committing anything that shouldn't be in
the repo. Produce a sequenced plan that Brad executes in PowerShell; you do the analysis.

## Context

Axle is the email agent for Budget Parts B.V. / RoverParts.eu, serving the `info@` and `drachten@`
shared mailboxes.

- **Repo (source of truth for git):** `C:\Admin\Projects\Axle` — branch `main`, remote
  `https://github.com/admin-bp-gh/axle.git`. App source lives in `box-code/`.
- **Box (what actually runs):** `C:\Axle` — app at `C:\Axle\app`, secrets at
  `C:\Axle\secrets\.env`, DB at `C:\Axle\data\axle.db`, logs at `C:\Axle\logs`.
- **Deploy path:** copy changed files into `C:\Axle\_incoming`, run `C:\Axle\axle-pull.ps1`
  (routes by filename, `node --check`s JS), then restart:
  `Stop-ScheduledTask -TaskName "Axle Server"; Start-ScheduledTask -TaskName "Axle Server"`.
  See `Axle — Server runbook.md`, which supersedes the 2026-06-19 migration doc.

## State as of 2026-08-04 (verified, not assumed)

- Last substantive commit before today: `ddcf05d`, **16 June 2026**.
- Today's commit `83f12ed` landed the MyParcel two-branch change (`connectors.js`,
  `agent-tools.js`) and is pushed. Those two files are in sync repo↔box. **Everything below
  excludes them.**
- **27 modified tracked files**, ~4,500 insertions. Largest: `routes/item.js` (~2,200 lines),
  `views/ui.js` (~1,500), `assets/components.css` (~890), `Status & Roadmap.md` (~680).
- **~47 untracked files**, clustering into recognisable features:
  - **sprocket** — `box-code/sprocket.js`, `sprocket-store.js`, `sprocket-notify.js`,
    `routes/sprocket.js`, `box-code/sprocket/axle-help.md`, `harness/harness-sprocket*.js`,
    `sprocket-build-prompt.md`
  - **outlook-close** — `box-code/outlook-close.js`, `harness/harness-outlook-close.js`
  - **dossiers / finder** — `customer-summary.js`, `return-note.js`, `recipient-set.js`,
    `shared-domains.js`, plus `*.test.js` for part-dossier, part-finder, return-dossier,
    recipient, recipient-set, sends-index, compose-suggest, fitment-gate, cap-tool-result
  - **adoption reporting** — `box-code/adoption-report.js`, `adoption-dashboard.html`
  - **docs / briefs** — six `Axle — *.md` build briefs, `axle-discount-awareness-prompt.md`,
    `info-triage-SKILL-updated.md`
  - **probably NOT for the repo** — `_sap-doc-pdf-run/` (a packaging run artefact, includes a
    built `.skill` bundle). Decide: `.gitignore` it, or commit deliberately.

### The one genuinely tricky bit — 8 files where repo ≠ box

These differ between `C:\Admin\Projects\Axle\box-code` and `C:\Axle\app`:

`backfill-atts.js`, `backup-db.js`, `hardening/cases.js`, `logrotate-tee.js`, `run-backup.ps1`,
`run-server.ps1`, `sap-doc-pdf.js`, `send.js`, `verify-backup.js`

Spot-checked cause: the **repo is ahead**, holding the June migration's self-locating path
refactor, e.g.

```js
// box (running):
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
// repo (committed-pending):
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
```

Under the current layout both resolve to the same place (`C:\Axle\app\..` = `C:\Axle`), so the repo
version is portable **and** compatible. But that was spot-checked on four files, not all nine —
**verify each one before concluding the repo is authoritative.** If any file has the box ahead
(a hotfix applied live and never back-ported), committing the repo version would enshrine the wrong
code and a later `axle-pull.ps1` would regress production.

## Hard constraints

1. **Never run git write commands against this repo from the sandbox/bash tool.** The mount can
   create `.git/index.lock` but cannot remove it (`Operation not permitted`), which leaves the repo
   wedged — this happened on 2026-08-04 and had to be cleared manually with
   `Remove-Item C:\Admin\Projects\Axle\.git\index.lock`. Read-only inspection (`git diff`,
   `git log`, `git ls-files`) is fine; `git status` is **not** — it takes the index lock.
   Brad runs every `add` / `commit` / `push` himself in PowerShell.
2. **Don't restart or redeploy Axle as part of this.** This is a git-hygiene job. The running
   server already has the code. Deploying the 8 drifted files is a **separate, later** decision.
3. **Scan for secrets before proposing any file for commit.** Real values, not variable names:
   40-hex API keys, `shpat_` tokens, passwords, connection strings. `.gitignore` currently covers
   `node_modules/`, `.env`, `.env.*`, `*.log`, `dist/`, `.DS_Store`, `Backups/`. A scan on
   2026-08-04 found no secret *values* in untracked files — re-verify, don't take it on trust.
4. **Line endings: leave them until last.** There is no `.gitattributes`, so `core.autocrlf` is
   deciding and `git add` warns "LF will be replaced by CRLF". Adding `* text=auto eol=lf` triggers
   a repo-wide renormalisation. Do the content commits first, then renormalisation as its own
   dedicated commit (`git add --renormalize .`) so it never mixes with real changes.

## Deliverable

A numbered commit plan, each entry with: the exact `git add` paths, a proposed message in the
existing style (short subject, body explaining why — see `git log`), and one line on what it
contains. Group by feature, not by file type. Flag anything you're unsure whether to commit rather
than deciding silently.

Then hand Brad the PowerShell to run, in order, and tell him what `git log --stat` should show
after each.

## Suggested opening moves

1. `git log --oneline -15` and read the message style.
2. `git diff --stat HEAD` for the tracked set; `git ls-files --others --exclude-standard` for the rest.
3. Diff each of the 9 drifted files repo↔box and settle the direction of drift per file.
4. Secret-scan every candidate file.
5. Propose the grouping to Brad *before* writing the command list.
