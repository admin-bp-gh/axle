# Axle: runtime folder

This folder now holds only what runs or supports the running app: `box-code\` (the Axle source repo, `admin-bp-gh/axle`), `deploy.ps1` and `restart-axle.ps1`.
Also here: `Backups\` (daily SQLite copies, git-ignored), `harness\`, `render\`, `_sap-doc-pdf-run\` and the `deploy.log` / `restart-axle.log` files.
All documentation (status, roadmap, runbook, build briefs, design, archive) now lives in `C:\Admin\Projects\Workbench\docs\axle\`.
That folder belongs to the Workbench repo (`admin-bp-gh/workbench`); start at its `README.md`.
Runtime is `C:\Axle` (app, data, secrets, logs); the deploy and server runbook is the Axle section of `C:\Admin\Projects\Workbench\deploy\README-DEPLOY.md`.
