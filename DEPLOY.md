# Axle: source control and deploy

GitHub (`admin-bp-gh/axle`, branch `main`) is the master copy. The box clone is
`C:\Admin\Projects\Axle`; the running app is `C:\Axle\app`, which `deploy.ps1` updates from
`box-code\`. Brad works on the box, Vera on her Mac (see `docs/Mac-Setup-for-Vera.md` in the
Workbench repo). Both commit to `main`.

Rules

1. `git pull` before you start. Commit before you stop.
2. One commit per feature or fix, titled clearly. Stage files by name.
3. Deploy only what is committed and pushed: `git pull --ff-only` then `.\deploy.ps1`
   (`-NoPause` over SSH, `-WhatIf` to preview, `-IncludeNew` for files the box does not have
   yet). Its pre-flight refuses a dirty or out-of-date checkout; `$env:AXLE_SKIP_GIT_GUARD=1`
   is the emergency bypass.
4. `C:\Axle\app\VERSION.txt` says what is live.
5. `box-code\.env` and the SQLite database are never committed.
6. File names: plain ASCII, no dashes other than `-`. The em-dash names in this folder broke a
   scripted commit once; new files avoid them.
