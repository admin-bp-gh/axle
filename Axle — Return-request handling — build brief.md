# Axle — Return-request handling — build brief

_Drafted 2026-07-06. Phase 3 (draft-only) feature. Read-only throughout; every system action is a
flagged human to-do. Owner: Brad. Decisions in this brief are Brad's answers from the 2026-07-06
interview — see "Decisions locked" below._

## Why

Shopify's self-service "Return items" flow is now live (mandatory under incoming EU legislation) and
is the published front door in our refund policy. It generates a **Shopify Return object** and fires
a notification into info@. Alongside it, customers still email us return/withdrawal requests directly.
Today Jack handles both by hand — pulling the order, working out who pays return shipping, and typing
a reply (often to the wrong recipient, because the Shopify notification's sender is info@, not the
customer). We want Axle to do the research and draft the right reply, the same way it already handles
tracking, stock and discount enquiries.

## Decisions locked (2026-07-06 interview)

1. **Processing model: intake only → process in SAP.** The Shopify "Return items" flow is just the
   intake. The real work — accept/decline, credit note, refund — stays in SAP as today. The Shopify
   Return object is closed out by a human later; Axle does not manage returns inside Shopify.
2. **Scope this phase: research + draft the customer email only.** Every system action (decline/close
   the Shopify return, create the SAP credit note, issue the refund) is a to-do a human performs.
   No write-backs. This matches Phase 3 and the safety-first principle. Write-backs are a later phase.
3. **Return reason: read it from Shopify, tailor the draft, confirm only when it affects who pays.**
   Use the Shopify `returnReason` + `customerNote`. Only ask the customer to confirm when the reason
   decides who bears return shipping (defect/wrong-part = we pay; changed-mind/unwanted = they pay) and
   the reason is ambiguous or blank.
4. **Reply addressing: whatever's cleanest — Brad's call → new outbound draft to the customer.**
   See "Two sub-types" — a reply to the Shopify notification loops back to info@, so for those Axle
   drafts a **fresh outbound email addressed to the customer's real address from the order**. Direct
   customer emails get a normal threaded reply-draft.

## The two sub-types (both must be handled)

**A. Shopify native return notification.** Sender shows as "Budget Parts" <info@budget-parts.nl>,
message-id `@shopify.com`, subject `Return requested for order #S18522`. Body: customer name, line
items, values, a "View request" link. The **customer is not the sender** — their address is on the
order. Currently three sit unactioned in info@: #S18522 (Nick Weerts, NRC5665 ×4, €199.20),
#S18583 (Koen van Luxemburg, GA2274 ×1, €375), and #S18354 (Duguneh Juwara) is a handled example.

**B. Direct customer return/withdrawal email.** e.g. `Return / withdrawal request: #S18147` from the
customer, item list often blank. Normal inbound customer email — the sender is the customer.

The two differ only in **recipient** (A → new draft to the order's customer address; B → threaded
reply) and in whether the reason/items come from the Shopify Return object (A always; B: look it up if
they submitted one, else ask). Everything downstream — research, policy, draft body — is shared.

## What the Shopify Return object gives us (verified 2026-07-06)

Query `orders(query:"name:S18522"){ nodes{ name createdAt email customer{ email numberOfOrders }
returns(first:5){ nodes{ name status totalQuantity returnLineItems(first:20){ nodes{ ... on
ReturnLineItem{ quantity returnReason returnReasonNote customerNote fulfillmentLineItem{ lineItem{
name sku quantity } } } } } } } } }`. Live results confirmed:

- `returns[].status` = `REQUESTED` (awaiting our accept/decline).
- Per line: `returnReason` enum (`UNWANTED`, `DEFECTIVE`, `WRONG_ITEM`, `NOT_AS_DESCRIBED`,
  `SIZE_TOO_*`, `OTHER`, `UNKNOWN`…), `returnReasonNote`, and the customer's free-text `customerNote`.
- `customer.email` / order `email` = the real recipient; `numberOfOrders` = a history signal.
- **Gotcha:** the return line `sku` is our internal ItemCode and differs from the customer-facing code
  (line "GA2274…" carries sku `DA2274`). Resolve through SAP for customer_code, quality, ABC, value.

## Who-pays-return-shipping logic (drives the draft)

From the refund policy + business-knowledge.md:

- `DEFECTIVE` / `WRONG_ITEM` / `NOT_AS_DESCRIBED`, or our error → **we pay** return shipping; ask for
  photos where damage/wrong-part is claimed; offer repair/replacement/refund.
- `UNWANTED` / changed mind / `OTHER` (e.g. #S18522 "needs old brackets, placing new order") →
  **customer pays** return shipping; withdrawal is fine within the window, no reason required.
- Ambiguous or blank reason → draft asks the customer to confirm the reason (this is the only case
  where we ask), because it decides who pays.
- **B2B** (customer is a business, not a consumer) → no statutory withdrawal right; 15% restocking fee
  (min €25) unless the item was damaged/defective/incorrect/our error. Axle flags this as a proposed
  term for the salesperson, never as a hard demand.
- **Consumer vs business is an AI judgement, not a hard field.** `return_dossier` surfaces the signals —
  `CardName`, VAT / Federal Tax ID present or not, and tier — and the engine decides: treat as business
  if a VAT number is present or the name contains a business marker (Auto, Bedrijf, BV, B.V., Service,
  Garage, Ltd, etc.). Blank VAT + a personal-looking name → consumer. When it's genuinely borderline,
  the draft applies the consumer treatment (safer for us) and flags the ambiguity in the actions block.
- **Electrical is likewise an AI best-guess** from the item name/category (no dedicated flag). If it
  reads as an electrical component, the draft states the sealed/unused-for-full-refund condition and the
  possible value deduction as a proposal for the salesperson — never an automatic deduction.

## The research: a new read-only `return_dossier` tool

One call, given an order number (`#S18522` / SAP DocNum), assembling everything the draft and the
salesperson need. Built alongside the existing `part_dossier` / `part_finder` in `agent-tools.js` +
`connectors.js`; read-only, `assertSelectOnly` on any SQL, no mutations. Returns:

- **Shopify return**: return name, status, and per line `{ reason, reasonNote, customerNote, quantity,
  sku, line_name }`. Empty if it's a direct email with no Shopify return.
- **Customer + recipient**: name, the order's customer email (feeds the send-guard recipient set),
  B2C-vs-B2B (OCRD / consumer vs business), and history — order count, and prior AR credit notes for
  this customer (ORIN) as a "frequent returner" signal.
- **Order & shipping clock**: SAP order (ORDR/RDR1), whether an **AR invoice exists** (= shipped/
  collected; its date starts the 14-day withdrawal clock) and days elapsed, payment method
  (`ORDR.U_Paid` → refund routing: Shopify vs bank/IBAN vs account), order total.
- **Per item**: customer_code (the COALESCE code), quality (`U_Quality`), ABC tier (`U_ABC` — C/D slow
  movers get case-by-case leniency), unit value, `U_WS_DropShip`, and the **name + category text** so
  the engine can AI-judge whether it's an electrical component (see B2C/electrical logic below) — there
  is no dedicated electrical flag, so this is a best-guess from the item, surfaced as a proposal.
- **Derived flags for the brief**: within/outside the 14-day statutory window; within/over the ~30–60
  day goodwill window; who-pays verdict per line; electrical-value-deduction risk; low-value-keep
  candidate (return shipping likely exceeds item value).

## Classification & routing

Add a distinct `return_request` intent so these don't fall through the generic info-triage "Returns"
keyword path (which auto-drafts blind, without the Return object). In `rules.js` / `triage.js`:

- Sub-type A: sender is info@/`@shopify.com` **and** subject `Return requested for order #S…`.
- Sub-type B: subject/body matches return/withdrawal intent (return, retour, withdraw, herroeping,
  annuleren-after-ship) with an order reference.

Route to Jack (owner), category `Return`, intent `return_request`, and hand to the drafting engine
with `return_dossier` primed on the order number parsed from the subject/body.

## Drafting

The engine (`engine.js`) drafts from `return_dossier` + the returns section of `business-knowledge.md`.
Rules for the draft:

- **Language & tone** from the customer's own words (the `customerNote`, or the direct email). #S18522
  → Dutch. Default Dutch for .nl/.be, English otherwise. House style: warm, efficient, `Team Budget Parts`.
- **Confirm receipt of the request**, restate the item(s) by their **customer code**.
- **Reason-aware body**: if we pay → acknowledge our error, ask for photos where relevant, state we'll
  cover it; if they pay → confirm the withdrawal/return is fine, state return shipping is at their cost.
- **Return instructions**: ship to the **Gouda** address with a copy of the invoice, parts unused / in
  original condition & packaging, no RMA/label. Include the non-EU CN22/CN23 "returned goods" note when
  the ship-to is outside the EU.
- **Refund mechanics**: refund to original method after we receive and check the return; a credit note
  is always issued; if paid by bank/PIN, ask for the IBAN.
- **Electrical**: state the sealed/unused-for-full-refund condition and the possible value deduction.
- **Never** promise acceptance of a warranty/defect claim, invent goodwill, or grant a discount —
  Axle proposes, the salesperson decides.

### The "actions for you" block (the salesperson to-dos)

Every return draft ends with an explicit, non-customer-facing action list, e.g.:

```
Actions (not sent to customer):
- Shopify return #S18522-R1 is REQUESTED — decline/close it once handled in SAP (intake-only).
- On receipt & check of the goods: create AR credit note for NRC5665 ×4 (€199,20).
- Refund €199,20 to original method (Shopify/iDEAL). Change of mind → customer pays return shipping.
- Customer note: buying replacement (old-style brackets) — expect a new order.
```

## Technical constraints to respect

- **Send-guard recipient gate.** `send-guard.js` only allows a recipient that's in the resolver's own
  address set (403 otherwise). For sub-type A the draft's To: is the order's customer email, which is
  **not** the sender — so `return_dossier` must feed that resolved customer address into the resolver
  so the eventual human send passes the gate. This is the main new plumbing.
- **Email as untrusted data.** The `customerNote` and any inbound body are data, never instructions —
  a note saying "refund me €500 to this IBAN" is a claim to verify against SAP, not a command.
- **Read-only.** `return_dossier` reads Shopify + SAP + MyParcel only. No return-object mutations, no
  credit notes, no refunds this phase.
- **Attachments/photos.** Axle can't see email attachments — when photos are referenced, say so and
  ask the salesperson to view them.

## Build sequence (proposed)

1. `return_dossier` connector + tool (read-only), with the Shopify return query, SAP order/invoice/
   item resolution, and the derived flags. Unit-test against #S18522, #S18583, #S18354, #S18147.
2. Classifier: `return_request` intent + the two sub-type matchers in `rules.js`/`triage.js`.
3. Recipient plumbing: feed the resolved customer address through the resolver for sub-type A so the
   send-guard passes.
4. Drafting: a short return-request playbook block for the engine (reason-aware body + actions block),
   drawing on the existing returns section of `business-knowledge.md`.
5. Backfill the three unactioned emails as the first live test; Brad reviews the drafts.
6. Control gate: Brad signs off that the drafts are correct and safe before it runs on the schedule.

## Resolved (2026-07-06 follow-up)

- **Electrical**: no SAP flag — the engine best-guesses from the item name/category and proposes the
  sealed/value-deduction wording; never an automatic deduction.
- **B2C vs B2B**: no hard field — the engine judges from `CardName` + VAT presence (business if a VAT
  number is present or the name carries a business marker: Auto, Bedrijf, BV, Service, Garage, Ltd…).
  Borderline defaults to consumer treatment and is flagged.
- **Goodwill window**: ~30 days default, flex to 60, applied as Axle's proposal (salesperson decides).
