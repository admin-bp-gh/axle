# Axle draft eval

Offline harness that replays real inbound emails through Axle's reply drafter under five configurations (today, sonnet-loose, opus-today, opus-loose, sonnet-loose-thread) and grades each draft against the reply our team actually sent.

It calls the live Anthropic API (Axle's org, key from `C:\Axle\secrets\.env`), so every run costs money. It reads live SAP, Shopify, MyParcel and M365 through Axle's existing read-only tools. It works on a COPY of the Axle database, never the live one (`C:\Axle\data\axle.db` is refused), sends no email and changes no production code.

Run from PowerShell on the box:

1. `Start-ScheduledTask -TaskName "Axle Backup"`, wait a minute, then `New-Item -ItemType Directory -Force C:\Admin\Projects\Axle\eval-runs; Copy-Item (Get-ChildItem C:\Admin\Projects\Axle\Backups\axle-*.db | Sort-Object LastWriteTime | Select-Object -Last 1).FullName C:\Admin\Projects\Axle\eval-runs\axle-copy.db`
2. `cd C:\Admin\Projects\Axle\box-code\eval; node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db --pick` builds and prints the cases (no model calls).
3. `node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db --dry` shows every case x config without API calls or live reads.
4. `node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db` runs everything; narrow with `--config today,opus-loose`, `--cases 2691,2602`, `--repeat 2`, `--out <dir>`. Output goes to `C:\Admin\Projects\Axle\eval-runs\<timestamp>\` (cases.json, runs.jsonl, summary.md).
5. `node draft-eval.js --regrade C:\Admin\Projects\Axle\eval-runs\<timestamp>` re-runs only the grader and rewrites summary.md.

Files: `draft-eval.js` (the script), `case-picker.js` (case selection from the copy), `engine-loose.js` (GENERATED on every run from `..\engine.js` with the loose limits; never edit it).
