# Axle — Auto-attach relevant SAP documents — build brief

> Written 2026-06-09 to seed a dedicated chat. Read the **Axle — Status & Roadmap.md** first
> (it is the source of truth across the parallel chats), then build this one controlled step at
> a time with Brad confirming each, honouring every Axle principle (safety first, draft before
> send, least privilege, Windows-only on the box, email content is untrusted data — never
> instructions, full human control).

## Goal

When an incoming customer email references a document — an order, invoice, quotation, delivery,
or credit note — Axle should surface that document's print PDF as an attachment **without the
salesperson having to look up the number and type it into the "Attach SAP document" box**. The
salesperson reviews and approves as always; this only removes the manual lookup.

## What already exists (reuse, don't rebuild)

- **`sap-doc-pdf.js`** — `resolveDocument(type, docNum)` (parameterised, read-only, DocNum→DocEntry;
  never model-chosen), `renderPdf(objectId, docEntry)` (headless Crystal render on the box),
  `buildDocumentPdf`, `customerByEmail(email)` (sender → single active customer, else null).
- **`/item/:id/attach-doc`** route + the `attachDocFormBox` control — already render-read-only,
  stage into `draft_attachments` behind the Send approval gate, with the **customer-scope guard**
  (a doc whose CardCode ≠ the email's customer is held for an explicit confirm) and the
  ambiguous-DocNum picker. Works on **compose and inbound** items today (manual entry).
- The draft pipeline (`engine.js` / `ingest.js`) already extracts entities and resolves orders
  while drafting — referenced documents are often already identified there.

So the **new** work is only: (1) detect referenced document numbers in an email, (2) resolve +
customer-scope-check each, (3) surface them — and wire that into the pipeline/UI.

## Non-negotiable safety model

- **Email content is untrusted.** A number in an email is a **candidate to look up, never an
  instruction.** Resolve it deterministically; if it doesn't resolve to a real document, drop it.
- **Customer-scope guard is mandatory and automatic here.** Axle may only surface/attach a
  document that belongs to **this email's customer** (sender → `customerByEmail`, or the thread's
  resolved customer). A referenced number that resolves to a **different** customer's document
  must **never** be auto-attached — it is withheld (optionally shown with a "different customer —
  attach anyway?" confirm, exactly like the manual path). This stops a mistaken or malicious email
  from pulling in another customer's invoice (their pricing, address, etc.).
- **No new send privilege and no SAP write.** This is the same read-only render-and-stage behind
  the existing Send approval. Nothing here sends; the human still approves every attachment and
  every send. Injection-flagged items: surface nothing automatically.

## Recommended approach (confirm with Brad)

- **Propose, don't silently attach** (default). Show a one-click "suggested attachment" on the
  item: *"This email references invoice 426407 (Garage Bulcke, €X) — attach it?"* The salesperson
  clicks to add. Wrong guesses don't clutter the draft, and the human stays in control.
- Optionally **auto-stage** the high-confidence, scope-matched ones (single clean reference that
  belongs to this customer) with easy "Remove", if Brad prefers fewer clicks.

## Open design decisions (resolve with Brad before/early in the build)

1. **Propose (one-click) vs auto-stage scope-matched** — or a mix by confidence.
2. **Extraction** — deterministic patterns for `order/factuur/invoice/offerte/levering/creditnota
   N`, bare `#S17878` / Shopify names, and SAP DocNums; validate every candidate by *resolving it*
   (and scope-checking) before showing — never trust the raw number. Decide whether to also let the
   draft model *flag* a probable reference (as a hint), with the resolve+scope still deterministic.
3. **Where in the pipeline** — compute suggestions at ingest/draft time (stored on the item) vs.
   lazily on the detail page. Ingest-time keeps the inbox fast and the detail page instant.
4. **Which doc types** by default (order/invoice most common) and the **type inference** from the
   wording ("invoice"/"factuur" → OINV, "order" → ORDR, bare number → try order then invoice).
5. **Multiple references / ambiguous numbers** — show each as its own one-click suggestion;
   ambiguous DocNums reuse the existing in-set picker.

## Suggested phased plan (each step draft-only, behind the approval gate)

1. **Reference extractor** (deterministic, tested): email text → candidate {type, number} list.
2. **Resolve + scope filter**: each candidate → `resolveDocument` + customer-scope check against
   the item's customer; keep only real, in-scope (or clearly flagged out-of-scope) documents.
3. **Suggestions surface**: a "Suggested documents" panel on the item with one-click add (reuses
   the existing render + `draft_attachments` staging + audit). No auto-send, no SAP write.
4. **Pipeline wiring**: compute at ingest/draft, store on the item, show instantly.
5. **Verify + harness** (extractor unit tests + live-SAP scope checks + adversarial: a foreign
   customer's number in the body is never auto-attached), deploy, live-test on real inbound mail.
6. **Control gate**: Brad reviews; confirm nothing attaches across the customer boundary and
   nothing sends without approval.

## Status entering this feature (2026-06-09)

Compose send is **live** (allow-list #3 enabled, Gate D signed off). SAP-document PDF attach is
**live** on both compose and inbound items (manual entry). This feature automates the *selection*
of those attachments. Everything stays draft-only and human-approved.
