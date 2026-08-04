# Axle — Improvement Task List

_Prepared 26 June 2026, from the adoption analysis (DB window 10–25 June: 332 work items,
161 sends, 6,089 audit events) and a read of the live engine code._

## The two problems the data shows

1. **Draft accuracy / data leverage.** Jack sends through Axle heavily (141 sends) but rewrites
   ~half of every draft (median text match 0.77; only 33% sent verbatim). The heavy rewrites are
   dominated by Axle proposing the **wrong part number** or **conceding too much on returns**.
2. **Drachten non-adoption.** Rob/Huub open 76% of their items but send only 12% through Axle, and
   have sent **nothing** through it since 19 June. They use Axle to read, then reply in Outlook.

## On your core concern — "is Axle actually using our data?"

Partly. The engine **is** wired to the data: it has read-only SAP SQL, Shopify GraphQL, MyParcel and
mailbox-search tools, plus `business-knowledge.md` (which already holds a solid returns policy and
fitment rules). The intent is right. The execution is weak in three specific ways:

- Part lookup is the model **improvising T-SQL `LIKE` searches over `OITM` descriptions**. LR parts
  have terse, cryptic, supplier-coded descriptions and brand variants sharing a BaseCode, so keyword
  search misses or returns the wrong variant.
- Tool results are capped at **50 rows and truncated to 4,000 characters** (`agent-tools.js`,
  `engine.js`). On a broad search the correct part literally falls off the list before the model sees it.
- The richest disambiguation data — the `U_Tag_Model` fitment notes, `U_Alternatives`, `U_FAQ` and
  `UserText` long descriptions that the **IMDx sweeps have been building** — is not surfaced as a
  structured "everything we know about this part" lookup. The model has to know to query each field
  separately, and usually doesn't. So it falls back on its own generic guess and drafts it confidently.

Net: the fix is **better retrieval and steering, not more connections.** We're sitting on the
intelligence (the sweep data); Axle just isn't reaching for it reliably.

---

## P1 — Make drafts accurate by leveraging our own data _(highest value)_

**1. Add a structured "part dossier" tool.**
Given an ItemCode / customer code / BaseCode, return one assembled object: ItemName, U_Quality,
customer-facing code, OnHand/OnOrder, PriceList-1 price, `U_Tag_Model` fitment notes,
`U_Alternatives`, `U_FAQ`, `UserText`, and the Shopify handle. Stop making the model stitch six
queries it gets wrong. This puts the entire sweep investment directly under the draft.
_Why: directly attacks the #1 cause of Jack's heavy rewrites._

**2. Add a fitment / part-finder tool.**
Given model + year + engine (or VIN) and a free-text description, return **ranked** candidate parts
using `U_M_*` model flags + `U_Tag_Model` + `U_Alternatives` — not a raw `LIKE`. Add a simple VIN →
model/year decode so Axle stops guessing the vehicle. Feed the candidates to the draft with the
fitment evidence attached.

**3. Fix the result limits that drop the right answer.**
Return compact, structured rows (only the columns that matter) and raise the 50-row / 4,000-char
caps, or paginate. Today a correct part can be silently truncated away before the model ever sees it.

**4. Enforce the confidence gate in the output contract.**
`business-knowledge.md` already says "assert a part only when SAP fitment data and a catalogue agree."
Make the engine **enforce** it: when fitment isn't confirmed, the draft must not state a part — it
produces an interim reply plus a confirmation question. Tighten the "PROPOSE, DON'T PUNT" instruction
so it never overrides this. _Why: stops the confident-wrong drafts (e.g. the invented brake advice,
the wrong windscreen BTR9641-vs-MXC5648) that force a full rewrite._

## P2 — Fix the tone that gets rewritten most _(returns & length)_

**5. Sharpen returns/warranty drafting.**
`return_complaint` is the most-edited intent (61% moderate/heavy). Drafts concede return shipping,
customs and warranty too readily. Encode a firmer default that applies the policy (customer pays
return shipping unless we erred; goodwill/coulance is explicit, never the default) and add few-shot
examples taken from Jack's actual sent replies.

**6. Teach Axle the house style from real sends.**
Jack shortens 43% of the drafts he edits — Axle over-explains. Build a few-shot set from the 161
real "AI draft → what was actually sent" pairs so Axle writes the way the team writes: short, direct,
no padding. This is a labelled training set we already own.

## P3 — Get Drachten (Rob/Huub) actually sending through Axle

**7. Watch Rob work for one session.**
They open 76% of items then leave for Outlook — the breakdown is at the send step, not awareness.
Sit with Rob, find exactly where and why he bails, and instrument that drop-off. Treat re-onboarding
Drachten as a named task with a deadline, not a hope.

**8. Build the missing "Forward to colleague/Brad" action.**
"Forward to Brad" appears twice in Drachten's own feedback — a concrete workflow gap that pushes them
back to Outlook. Add it as a first-class, logged action.

**9. Make the send path faster than Outlook.**
Keyboard-first approve-and-send, fewer clicks, instant draft. If Axle isn't faster than just typing
the reply, a busy salesperson won't switch. Time the two flows head-to-head.

## P4 — Close the measurement & self-improvement loop

**10. Auto-refresh the adoption dashboard.**
Schedule `adoption-report.js` on the box against the live DB (e.g. daily 06:00) so the dashboard is
always current. _(Generator already written; see below.)_

**11. Weekly "most-edited drafts" digest.**
Auto-surface the week's heaviest rewrites grouped by intent, so engine/knowledge tuning stays
data-driven instead of guesswork. We already store every AI draft and the exact sent text.

**12. Recalibrate or hide the confidence badge.**
"High confidence" drafts are sent verbatim only 37% of the time — barely above "medium" (28%). The
badge currently carries almost no signal and quietly erodes trust. Either recalibrate it against
actual edit rates or hide it until it predicts something.

---

## Suggested sequence

P1 first — accuracy is the lever that makes every other improvement worth more, and it's the direct
answer to "use our data." P2 alongside it (cheap, high-frequency wins). P3 in parallel as a people
task, owned and time-boxed. P4 is light plumbing that keeps us honest as we tune.

## Dashboard — how it runs

`box-code/adoption-report.js` reads the live Axle DB and writes a self-contained
`adoption-dashboard.html` (no server, no connectors — just open it). To run on the box against live data:

```powershell
cd C:\Axle\box-code
node adoption-report.js C:\Admin\Projects\Axle\adoption-dashboard.html
```

The HTML in the project folder right now was built from the 26 June backup snapshot. Run the command
above once on the box to confirm it works against the live DB, then schedule it daily (task #10).
