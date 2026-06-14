# Axle — Contact-form reply (actioning contact-form messages) — build brief

> Kickoff brief for a dedicated session. Paste the "Kickoff prompt" below into a new chat in the
> Axle project. Read `Axle — Status & Roadmap.md` (session 7) first for current state.

## The problem

Webshop contact-form messages now ingest into Axle (session 7): they live in info@'s
**"Shopify Contact Form"** folder, arrive **from `mailer@shopify.com`**, route via the
`shopify_form` rule to Jack, and get a drafted reply. But they are **draft-only** — the Send
button is hidden and `/item/:id/send` refuses them with a 403 (`isContactFormItem`), because the
send-guard hard-locks the reply recipient to the thread sender, which here is Shopify's mailer,
**not the customer**. The real customer's details sit *inside the body*.

Body shape (EN and NL templates), label-delimited:

```
Country Code:  NL
Name:          Hoekstra 4in1 Garage, (Wijtse)
Email:         info@hoekstra4in1.nl
Phone:         0612637887
Message:       <the customer's actual question>
```

(NL variant: `Landcode / Name / E-mail / Phone / Message`. Some messages reference an order, e.g.
`Order #S17562`.)

**Goal:** let the team actually action these — send the approved reply to the real customer —
without ever letting untrusted email content set the recipient.

## The hard constraint (non-negotiable, same invariant as Compose)

The email body is **untrusted data**. The recipient must **never** be set by the model or by
untrusted content directly. The Compose work already established the safe pattern and the code to
reuse:
- `resolve-customer.js` — deterministic SAP/Shopify resolver + `pickRecipient(validAddrs, pickAddr)`
  recipient gate (returns a recipient only from the resolver's own set; rejects anything outside it).
- Recipient is **code-held**, shown verbatim, **human-confirmed**, SHA-tied; the model never sees it
  in a way it can change.
- Injection defences D1/D2/D3 in `engine.js` still apply.

So: the structured **form field** may be *parsed deterministically* to produce a **candidate**
address, but it is treated as a candidate only — enriched/confirmed via the trusted side where a
record exists, **shown to the salesperson, and explicitly confirmed by the human** before any send.
The human is the trust anchor (exactly as Compose). The free-text Message is data, never instruction.

## Proposed approach (phased, draft-before-send, gated)

1. **Deterministic body parser** — extract `{countryCode, name, email, phone, message, orderRef?}`
   from both the EN and NL Shopify templates by strict label matching (not LLM). Robust to missing
   fields (e.g. no phone). Unit-tested against real samples. Never interprets body as instructions.
2. **Recipient resolution + confirmation** — feed the parsed email (and any `#Sxxxxx` order, which
   resolves through SAP on the trusted side via `ORDR.NumAtCard`) into `resolve-customer.js` to
   enrich: known customer? order history? language by country map. Present the candidate **To**
   verbatim; require explicit human confirmation; validate via `pickRecipient`; code-hold + SHA-tie.
   For a brand-new prospect with no SAP/Shopify record, the form-typed address is the candidate —
   still human-confirmed, never auto-sent.
3. **Drafting** — engine already drafts from the body; ensure it greets the parsed **Name** and
   treats the parsed **Message** as the customer's question. Store the parsed customer
   (name/email/country) on the work item for the draft + send to use.
4. **Send** — this is a **new outbound** to the confirmed customer address, **not** an in-thread
   reply (the Shopify-mailer thread is irrelevant). Reuse `send.js` (fresh message,
   `originalMessageId=null`) + send-guard guarantees (single To, no CC/BCC, URL allowlist, verbatim
   body, one-send-per-body, full audit). Mark the original `mailer@shopify.com` email read.
5. **UI** — replace the contact-form "draft-only" note with the Compose-style confirmed-To header
   (resolved customer + confirmed To) and a Send button, only after the new allow-list action is on.

## Decisions to confirm at kickoff

1. **Allow-list: new action #4 ("send reply to contact-form customer — resolved/confirmed
   recipient"), or fold into Compose's action #3?** (Lean: a distinct #4, enabled deliberately, so
   contact-form send is governed separately from cold Compose.)
2. **Existing customer: reply to the form-typed address or the SAP/Shopify address?** (Lean: reply
   to the address they used in the form; show the matched customer + any other addresses for context.)
3. **Subject** for the new email — model-proposed + human-editable (as Compose §10.1 settled)?
4. **Order-referencing messages** — resolve `#Sxxxxx` through SAP for full context in the draft.
5. Keep parsed **phone/country** on the item for callback/voicemail context?

## Constraints / working method (unchanged)

One concrete step at a time, Brad confirms each; explain-before-act; draft-before-send; least
privilege; **draft-only until Brad enables the new action at a gate**. Box is Windows-only
(PowerShell/GUI); build in `C:\Admin\Projects\Axle\box-code` on the box and promote locally to
`C:\Axle\app` via `axle-pull.ps1` (all files here pre-exist except any brand-new module, which needs
one manual placement); restart
Axle Server after `server.js`/`db.js` changes; validate in the sandbox (node --check + harnesses)
before deploy. Update the roadmap + memory each session.

## Key files to reuse

`resolve-customer.js` (resolver + `pickRecipient`), `compose.js` (compose-mode engine + confirmed-To
pattern), `scenarios.js`, `send.js` / `send-guard.js`, `server.js` (`isContactFormItem`, the compose
detail/confirm UI + route-level guards), `rules.js` (`shopify_form`, per-mailbox `folders`),
`connectors.js` (`getMessages` multi-folder), `engine.js` (D1/D2/D3, agentic draft), `db.js`.

---

## Kickoff prompt (paste into a new Axle chat)

Build the **contact-form reply** capability for Axle — let the team actually action webshop
contact-form messages, not just draft them. Read `Axle — Status & Roadmap.md` (session 7) and
`Axle — Contact-form reply — build brief.md` first, then restate where we stand and propose the
plan before writing code.

Today these messages ingest into info@'s "Shopify Contact Form" folder (from `mailer@shopify.com`)
and get a draft, but they're draft-only: the customer's real address is in the body, so in-thread
Send is blocked at the route. I want to be able to review and send the reply to the actual customer.

Hard rule: the email body is untrusted — the recipient must never be set by the model or by raw
content. Reuse the Compose trust pattern (`resolve-customer.js` + `pickRecipient`, recipient
code-held / human-confirmed / SHA-tied, D1/D2/D3 defences). Parse the structured form field
deterministically to a *candidate* address, enrich/confirm via SAP/Shopify where a record exists,
show it to me verbatim, and require my confirmation before any send. Sending is a new outbound (not
in-thread) and must sit behind a **new allow-list action**, OFF until I enable it at a gate —
draft-only until then.

Start by confirming the five decisions in the brief (esp. new action #4 vs Compose's #3, and
form-typed vs SAP address for known customers), then give me step 1.
