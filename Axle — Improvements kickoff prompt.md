# Kickoff prompt — implement the Axle improvements

_Paste the block below into a new chat in the Axle project._

---

We're starting implementation of the Axle improvements from the adoption analysis. Before
anything, read these two files in the project folder so you have full context:

- `Axle — Improvement Task List — 2026-06-26.md` — the prioritised plan (P1–P4). This is the source of truth.
- `adoption-dashboard.html` + its generator `box-code/adoption-report.js` — how we measure adoption.

Headline findings driving this work: Jack uses Axle heavily but rewrites ~half of every draft (median
match 0.77), mostly because Axle proposes the wrong part number or is too soft on returns. Drachten
(Rob/Huub) opens 76% of items but sends almost nothing through Axle. The root cause of the accuracy
gap is weak retrieval: the engine is connected to SAP/Shopify/MyParcel and `business-knowledge.md`,
but part lookup is the model improvising `OITM` keyword SQL, tool results are capped (50 rows /
4000 chars so the right part falls off), and the IMDx sweep data (`U_Tag_Model`, `U_Alternatives`,
`U_FAQ`, `UserText`, `U_M_*`) is never handed to it as a structured part lookup.

**Goal this session: P1 — make drafts accurate by leveraging our own data.** Work the P1 tasks in order:
1. A structured "part dossier" read tool (everything we know about one part: ItemName, U_Quality,
   customer-facing code via the COALESCE rule, OnHand/OnOrder, PriceList-1, U_Tag_Model,
   U_Alternatives, U_FAQ, UserText, Shopify handle).
2. A fitment / part-finder tool (model+year+engine or VIN + description → ranked candidates from
   U_M_*/U_Tag_Model/U_Alternatives, not raw LIKE).
3. Fix the result-limit truncation that drops the right answer.
4. Enforce the confidence gate so Axle never asserts an unconfirmed part — interim draft + question instead.

**How to work, per the project's operating principles:**
- One concrete, completable step at a time. Explain what and why in a sentence, give me copy-paste-ready
  code/commands, then wait for me to confirm before the next step.
- Start by proposing the design for task #1 (the SQL, the tool definition, where it slots into
  `agent-tools.js` / `engine.js`) and confirm the approach with me before writing code.
- Everything here is read-only — keep it that way. Draft-before-send and the action allow-list are
  unchanged; we are not touching the send path.
- Least privilege: the new tools run under the existing `axle_read` account. No new permissions.
- The box runs `better-sqlite3` and SQL Server, which don't run in your sandbox, so develop carefully
  and give me exact steps to run/test on the box. Use the existing tests (`compose-suggest.test.js`,
  the harness) and add coverage for the new tools.
- Reference files: `box-code/agent-tools.js`, `engine.js`, `connectors.js`, `business-knowledge.md`,
  `db.js`. The SAP schema/field conventions are in the `sap-sql` skill if you need them.
- Update `Axle — Status & Roadmap.md` as we complete each task.

Start now by restating where things stand and proposing the design for P1 task #1.
