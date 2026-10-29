# Email draft eval

Offline harness that replays real inbound emails through the Email reply drafter under seven configurations (today, sonnet-loose, opus-today, opus-loose, sonnet-loose-thread, today-thread, step) and grades each draft against the reply our team actually sent.

It calls the live Anthropic API (the Email app's org, key from `C:\Axle\secrets\.env`), so every run costs money. It reads live SAP, Shopify, MyParcel and M365 through the Email app's existing read-only tools. It works on a COPY of the Email database, never the live one (`C:\Axle\data\axle.db` is refused), sends no email and changes no production code.

Run from PowerShell on the box:

1. `Start-ScheduledTask -TaskName "Axle Backup"`, wait a minute, then `New-Item -ItemType Directory -Force C:\Admin\Projects\Axle\eval-runs; Copy-Item (Get-ChildItem C:\Admin\Projects\Axle\Backups\axle-*.db | Sort-Object LastWriteTime | Select-Object -Last 1).FullName C:\Admin\Projects\Axle\eval-runs\axle-copy.db`
2. `cd C:\Admin\Projects\Axle\box-code\eval; node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db --pick` builds and prints the cases (no model calls).
3. `node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db --dry` shows every case x config without API calls or live reads.
4. `node draft-eval.js --db C:\Admin\Projects\Axle\eval-runs\axle-copy.db` runs everything; narrow with `--config today,opus-loose`, `--cases 2691,2602`, `--repeat 2`, `--out <dir>`. Output goes to `C:\Admin\Projects\Axle\eval-runs\<timestamp>\` (cases.json, runs.jsonl, summary.md).
5. `node draft-eval.js --regrade C:\Admin\Projects\Axle\eval-runs\<timestamp>` re-runs only the grader and rewrites summary.md.

Files: `draft-eval.js` (the script), `case-picker.js` (case selection from the copy), `engine-loose.js` (GENERATED on every run from `..\engine.js` with the loose limits; never edit it).

Thread configs (`sonnet-loose-thread`, `today-thread`, since 15 Oct 2026): the drafter gets the real conversation from `..\conversation.js` (the builder ingest and the redraft use), replayed as of the send (`before: sent_at`): every stored customer message and every send before it, the staff input of that turn and the customer's earlier items. `today-thread` is production as it now runs; `today` is the same engine without the thread. To compare the follow-ups: `--config today,today-thread`.

Agent config (`step`, since 16 Oct 2026): `today-thread`'s input sent through the Workbench shared agent (`..\agent-client.js`, channel `axle-draft`) instead of straight to the Anthropic API. The channel profile picks model, effort and max_tokens, Workbench's knowledge pack goes in front of the prompt and the Email app's business knowledge travels as the cached extra knowledge block. Needs Workbench running and `AGENT_TOKEN` (plus `AGENT_URL` when Workbench is not on `http://127.0.0.1:8485`) in `C:\Axle\secrets\.env`. It only runs when named: `--config today-thread,step`. Cache reads are costed at 0.1x input, cache writes at 1.25x.

Supplier facts (AI parity Step E3, since 18 Oct 2026): the `prose` and `deep` configs ask Workbench for the `<supplier_facts>` block before drafting and verify the reply's codes before the gates, unless `AXLE_FACTS=off` is set in the environment. Compare a run with `$env:AXLE_FACTS = "off"` (before) against one without it (after); summary.md shows the facts timing, the EPC and Allmakes calls, verify problems and the fitment and availability flags per config.
