# Email app: runtime folder

This app was called Axle until 29 Oct 2026. The repo, folders, routes, the `axle` account, task names and other machine identifiers keep the old name; the name map and the full keep list are in the Workbench repo's `docs/NAMES.md`.

This folder now holds only what runs or supports the running app: `box-code\` (the Email app source repo, `admin-bp-gh/axle`), `deploy.ps1` and `restart-axle.ps1`.
Also here: `Backups\` (daily SQLite copies, git-ignored), `harness\`, `render\`, `_sap-doc-pdf-run\` and the `deploy.log` / `restart-axle.log` files.
All documentation (status, roadmap, runbook, build briefs, design, archive) now lives in `C:\Admin\Projects\Workbench\docs\axle\`.
That folder belongs to the Workbench repo (`admin-bp-gh/workbench`); start at its `README.md`.
Runtime is `C:\Axle` (app, data, secrets, logs); the deploy and server runbook is the Email section of `C:\Admin\Projects\Workbench\deploy\README-DEPLOY.md`.
