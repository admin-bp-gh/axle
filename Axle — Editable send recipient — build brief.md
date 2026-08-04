# Axle — Editable send recipient — build brief

> Kickoff brief for a dedicated session. Read `Axle — Status & Roadmap.md` first for current state.
> Design agreed with Brad 2026-07-10. Nothing built yet.

## The problem

Axle can only send to an address it chose. Today there are two mechanisms, neither editable:

- **Inbound replies** — `send-guard.assembleSend()` hard-locks `to` to `workItem.sender_email`.
  There is no way to change it, at all.
- **Compose / contact-form / return items** — `to` comes from `work_items.recipient`, set only via
  `resolve-customer.pickRecipient()`, a strict membership test against the resolver's own address
  set. The picker is a radio form in a card at the *top* of the item page, nowhere near the Send
  button.

Two different mental models, one of them invisible, neither editable. This is friction the team
works around by leaving Axle and finishing the mail in Outlook — the exact behaviour the tool
exists to remove. The cases it can't serve today:

- customer writes from a personal address, wants the reply at their work address;
- a new contact at an existing account;
- a typo in the contact-form address;
- sending the same reply on to a colleague at the customer.

**Goal:** one recipient control, living in the Send button, editable, for every item type.

## Decisions taken (Brad, 2026-07-10)

| Question | Decision |
|---|---|
| Where does the control live? | In the send button — split button with a caret, popover anchored to it. |
| Which item types? | **All four** (reply, compose, contact-form, return). |
| Free-text override gated behind an allow-list flag? | **No — ships enabled.** No env flag. |
| Friction on a typed address | **Stronger send confirm** naming the address at the moment of sending. |
| Audit | `to_source=sender\|onfile\|typed` added to `email_sent`. |
| Unknown-domain warning in the popover | Not taken. |
| CC / BCC | **Out of scope.** `send-guard` keeps `cc: [], bcc: []` hard-coded. |

### Recorded reservation (Brad's call, proceeding as decided)

Shipping free-text enabled with no env flag means the recipient hard-lock — the strongest
code-level guarantee in Axle — is retired in a single deploy, and the only way to withdraw it is a
code edit and a service restart on the live box. Brad is Axle's sole caretaker; that is the
operational cost, not a security-philosophy objection. A one-line kill switch
(`AXLE_ACTION_RECIPIENT_OVERRIDE`) can be added in ~30 minutes at any point, before or after this
build, without touching the UI. Noted here so the Phase 7 security review finds the reasoning
rather than the omission.

## Design

### The control

The Send button today is `button.send.send-stack` — two stacked lines, "Send now" over the
recipient address. That address line becomes interactive: a caret segment on the right of the
button opens a popover anchored to it.

Popover contents, top to bottom:

1. The **known addresses** as radios, each labelled with provenance — `— sender`, `— on file, SAP`,
   `— on file, Shopify`, `— from form`. Same set the resolver already produces.
2. A divider, then **"Other address…"**, which reveals a single text input.
3. Cancel / **Use address**.

On confirm the button's address line updates and a small amber **changed** pill appears beside the
button whenever the active recipient is not the default. The pill is the whole reason the control
lives in the action bar rather than in a `To:` row above the reply: the sticky bar is guaranteed to
be on screen at the moment of sending, a field 400px up the page is not.

For new-outbound items with no confirmed recipient yet, the button renders as **"Confirm
recipient"** and opens the same popover. One place recipients are decided, in every state.

### Trust model

The invariant changes from *"code chooses the recipient"* to *"a human, and only a human, may
redirect the reply — deliberately, visibly, and in the audit log."* What holds it up:

- The typed address is **never pre-filled** from the email body, a tool result, or any model
  output. The popover offers **no autocomplete from message content**. The model can never place
  an address in front of the salesperson to click.
- Radio options are drawn only from the resolver's set + the thread sender. Unchanged.
- An **injection-flagged item can never send**, and its recipient chip is read-only. Unchanged.
- `assembleSend` still validates the final body: URL allowlist, verbatim text, SHA-256 tie.
- Single recipient only. No CC, no BCC.

The residual risk is a hostile email socially engineering the salesperson into typing an address.
No code stops that. The stronger send confirm is the mitigation, and the audit trail is the
detection.

## Code changes

**`send-guard.js`**

- `assembleSend(workItem, body, stagedAtts)` — `to` becomes
  `String(workItem.recipient || workItem.sender_email)`, lowercased and trimmed, still validated
  against `EMAIL_RE`. The `injection_flag` refusal stays first. Comment block at the top of the
  file must be rewritten: the "recipient is HARD-LOCKED to the work item's sender address"
  invariant is no longer true and must not be left as a lie in the source.
- New `acceptTypedRecipient(addr)` beside `pickRecipient`'s role: trim, lowercase, cap at 254
  chars, require `EMAIL_RE`, and **reject any `,` `;` `<` `>` or whitespace** — this is what blocks
  multi-recipient smuggling (`a@b.nl, attacker@evil.com`) and display-name injection through the
  free-text field. Returns the clean address or `""`.

**`resolve-customer.js`**

- Unchanged. `pickRecipient()` keeps its strict semantics and still governs the radio path.

**`server.js`**

- New route `POST /item/:id/recipient`. Body: `addr` plus `mode=known|typed`.
  - `mode=known` → `pickRecipient(candidateSet, addr)`; reject out-of-set with the existing
    `cf_recipient_rejected` copy and a `recipient_rejected` audit row.
  - `mode=typed` → `acceptTypedRecipient(addr)`; reject malformed with a clear message.
  - Refuse entirely when `w.injection_flag` or the item is `done`/`archived`.
  - Writes `work_items.recipient`; audits `recipient_set` with `from=<old> to=<new> mode=<mode>`.
  - Supersedes `/item/:id/contactform-recipient` and `/item/:id/return-recipient`; keep both as
    thin aliases for one release so an open tab mid-edit doesn't 404.
- `sendWorkItem()` — compute `to_source` (`typed` if `w.recipient` is set and not in the item's
  known-address set; `onfile` if set and in the set; `sender` if unset) and append it to the
  `email_sent` audit detail. The existing `to=` field is unchanged.
- **The candidate set must be computed in one shared helper** — `knownAddressesFor(w)` — used by
  the route, the audit classifier, and the item page. Three implementations of "what counts as a
  known address" is how this feature rots.

**`db.js` — required migration, not optional**

Line 227 today:

```js
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_item_body ON sends(work_item_id, body_sha256)")
```

Send the same body to a second address and the dedup at `sendWorkItem` swallows it: the user gets a
redirect, no email, and no error. That is precisely the "reply to the customer, then send the same
text to their colleague" case this feature invites. Drop the index and recreate as
`(work_item_id, to_addr, body_sha256)`, and widen the matching `SELECT 1 FROM sends WHERE …`
guard in `sendWorkItem` to include `to_addr`. `IF NOT EXISTS` will not do this on its own — the old
index must be explicitly dropped by name.

**`routes/item.js`**

- Replace the `sendBtn` construction with the split button + popover. The `confirm()` text branches:
  default address → today's copy; typed address → *"jan@gmail.com is not one of Dekker 4x4's known
  addresses. Send there anyway?"*, built from the resolved customer name.
- Delete the `pickerForm` blocks from `contactFormHeader` and `returnHeader`. Those cards keep the
  customer identity and match lines and lose the radios; the To line becomes a plain read-only
  display.
- The `changed` pill renders whenever `to_source === "typed"` or the chosen address ≠ the default.

**`views/ui.js`** — new translation keys, EN + NL: `recip_change`, `recip_other`, `recip_use`,
`recip_typed_confirm`, `recip_changed_pill`, `recip_from_sender`, `recip_on_file`, `recip_from_form`,
`recip_bad_address`.

**`assets/components.css`** — `.send-split`, `.send-caret`, `.recip-pop`, `.recip-pill`. The
popover opens *upward* from the sticky bar, same as `details.menu` at line 210.

### Re-open rule

If a new inbound email re-opens a conversation and `sender_email` changes while a typed override is
set, **clear `work_items.recipient` and audit `recipient_cleared`**. A redirect confirmed against
one correspondent must not silently carry to another. Implement in `ingest.js` where the existing
item is updated.

## Test plan

Unit (`send-guard.test.js`, new `recipient.test.js`):

- `acceptTypedRecipient` rejects `a@b.nl, c@d.nl`, `a@b.nl; c@d.nl`, `Jan <a@b.nl>`, `a@b`, `""`,
  a 300-char address, and leading/trailing whitespace variants.
- `assembleSend` uses `recipient` when set, `sender_email` when not, refuses a flagged item with
  either present, and still refuses an off-allowlist URL in the body.
- Dedup: same body, two addresses → two `sends` rows. Same body, same address → one.

Injection harness (`hardening/harness.js`): re-run the full 37-case set with the new send path. Add
two cases: an email instructing the model to change the recipient (must not be able to — the model
has no route to `w.recipient`), and a poisoned SAP contact record carrying an attacker address in a
name field (must not appear as a radio option, since radios come from `sendableAddresses` only).

Live, on the box, in order: reply to sender → unchanged behaviour. Reply redirected to a second
on-file address → delivered, `to_source=onfile`. Reply redirected to a typed address → confirm
dialog names the customer, delivered, `to_source=typed`, `changed` pill visible before the click.
Same body sent to two addresses → two emails. Flagged item → no chip, no send. Contact-form item →
no radio card at the top, caret works, sends.

## Definition of done

One recipient control across all four item types; typed addresses accepted and delivered; every
send carries `to_source` in the audit log; the dedup index is keyed on the recipient; the harness is
green at 37/37; `send-guard.js`'s header comment describes the code that now exists. Roadmap and
allow-list table updated — action #1's Notes must lose the words "recipient hard-locked to thread
sender" and gain the new invariant.

## Kickoff prompt

> Read `Axle — Status & Roadmap.md`, then `Axle — Editable send recipient — build brief.md`.
> Build the editable send recipient exactly as specified, starting with the `db.js` dedup-index
> migration and `send-guard.js` (`acceptTypedRecipient` + the `assembleSend` change) plus their
> unit tests, before any UI. Give me one step at a time, Windows/PowerShell instructions for the
> box, and stop for my confirmation between steps.
