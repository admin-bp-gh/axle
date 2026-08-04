# Axle help — what Axle does and how to use it

This file is Sprocket's only source of truth. Sprocket answers staff questions ("how do I do X
in Axle?") **using nothing but the capabilities written below.** If something is not described
here, Sprocket does not know about it and will say so rather than guess — so keep this file
accurate and current. Brad maintains it.

How to write an entry (Sprocket reads the structure, so keep to it):

- Start each capability with a `## Heading`.
- The first line under the heading is `Key: <allow-list-key>` — the action-allow-list key that
  governs it, or `none` for things that are always available (reading, viewing, editing a draft).
  Sprocket cross-checks this key against the **live** allow-list: if the key is switched off, it
  tells the user the capability isn't enabled yet and offers to log a request — it never describes
  an off capability as if it works.
- Then `What it does:` (one or two plain sentences) and `How to use it:` (short numbered steps).
- Write for a salesperson, not an engineer. No SAP/Shopify internals unless the user needs them.

Allow-list keys currently referenced here: `send_reply`, `mark_read`, `attach_doc`,
`compose_send`, `contactform_send`. (The live on/off state is supplied to Sprocket separately at
answer time — do not hard-code on/off in this file.)

---

## The inbox and what the queue is telling you
Key: none

What it does: The inbox is your prioritised work queue. Each card is one customer conversation
Axle has already read and researched. The coloured state chip tells you what it needs from you:
"New", "Drafting…" (Axle is still working), "Needs your answer", "Ready to send", "Done" or
"Archived". By default the queue sorts so whatever needs you next is at the top.

How to use it:
1. Open Axle. The left pane is the queue; the middle and right panes are the item you're working.
2. Use Mine / All to switch between your own items and everyone's.
3. Use the status tabs (Open / Done / Archived / All) and the search box to find anything.
4. Use the Sort control if you'd rather see newest, oldest or highest-priority first.
5. Click any card to open the conversation, the draft and the brief.

## Reading the conversation and "What Axle checked"
Key: none

What it does: When you open an item you see the customer's email (newest message first, older
messages folded beneath), and on the right the "What Axle checked" brief plus any SAP documents
Axle found — so you can see the facts behind the draft without opening SAP yourself.

How to use it:
1. Click an item.
2. Read the newest message at the top; click "Earlier in this conversation" to expand the history.
3. Read the right-hand brief to see what Axle looked up (stock, orders, customer, tracking).

## Reading a foreign-language email in your own language
Key: none

What it does: If a customer wrote in a language other than your interface language, Axle shows a
translation so you can read it. Your interface language is separate (EN/NL toggle, top right).

How to use it:
1. Open the item.
2. Click "Show translation" under the customer's message.
3. To change which language Axle thinks the customer wrote in, use the customer-language control
   on the item (this fixes the translation; it does not re-send anything).

## Answering Axle's questions and redrafting
Key: none

What it does: When Axle needs something from you before it can finish a reply — a physical check,
a colleague's confirmation, a decision — it lists its questions and holds the draft. You answer in
one box and ask Axle to redraft.

How to use it:
1. Open an item marked "Needs your answer".
2. Read the numbered questions (a "Please check" marker means a physical check).
3. Type your answers and anything else Axle should know in the one answer box.
4. Click "Save & redraft" — Axle rewrites the reply with your input in the background.

## Editing the reply before it goes out
Key: none

What it does: The "Reply to send" box is the exact text the customer will receive. You can change
it however you like before sending; "Reset to AI draft" puts Axle's original wording back.

How to use it:
1. Open a "Ready to send" item.
2. Edit the reply text directly.
3. (Optional) Use "Show translation" to check your edited reply in the customer's language.

## Sending the approved reply
Key: send_reply

What it does: Sends your reply to the customer, in the original email thread, exactly as shown in
the "Reply to send" box. Axle then marks the item Done and marks the original email read. Axle
re-checks the final text first: a flagged/scam item can never be sent, the recipient is locked to
the original sender, and only approved links are allowed.

How to use it:
1. Open a "Ready to send" item and check the reply text.
2. Click the green "Send reply to …" button.
3. Confirm. The customer receives it and the item closes as "Done · replied".

## Attaching pictures or files to a reply
Key: none

What it does: You can attach pictures or files (max 3 MB each) to go out with the reply.

How to use it:
1. In the item, use "Add a file", or drag-and-drop, or paste a screenshot (Ctrl+V) into the box.
2. The files are listed by the reply and sent when you send the reply.

## Attaching a SAP document (order, invoice, quotation, delivery, credit note) as a PDF
Key: attach_doc

What it does: Attaches the standard SAP/Boyum print PDF of a referenced document, exactly as if you
printed it in SAP and attached it by hand. It only renders the PDF and stages it — nothing is sent
until you send the reply, and a document belonging to a different customer needs an explicit confirm.

How to use it:
1. In the item, open the "SAP documents" card and "Attach by number".
2. Pick the type and type the document number.
3. The PDF is staged with the reply; send the reply to send it.

## Suggested documents (Axle proposes the right PDF for you)
Key: attach_doc

What it does: When a customer's email refers to one of their orders or invoices, Axle finds the
document in SAP and offers it as a one-click attachment, so you don't have to look the number up.
It only ever suggests documents that belong to this customer.

How to use it:
1. Open an item that mentions an order/invoice.
2. In the "Suggested documents" card, click "Attach" on the one you want.
3. Send the reply to send it.

## Composing a brand-new email to a customer
Key: compose_send

What it does: Lets you start a new (non-reply) email. You pick the customer, tell Axle in plain
language what to say, and Axle researches the facts and drafts it. Sending new emails is governed
separately from replies.

How to use it:
1. Click "New email".
2. Find the customer (code, email, order #, invoice # or name) and confirm the recipient.
3. Tell Axle what the email should say, pick the language, and "Draft this email".
4. Review the draft. (Whether you can send it depends on the compose-send allow-list key.)

## Replying to a webshop contact-form message
Key: contactform_send

What it does: Contact-form messages arrive from Shopify's mailer, so the customer's real address is
in the body, not the sender. Axle parses the form, matches the customer in SAP, and proposes the
address to reply to. You confirm the recipient before anything can be sent.

How to use it:
1. Open the contact-form item (it carries a "Contact form" chip).
2. Check the parsed customer and confirm the address to reply to.
3. Review the draft and subject. (Whether you can send depends on the contact-form allow-list key.)

## Setting the customer's language or reassigning an item
Key: none

What it does: You can correct the language Axle detected for a customer, and reassign an item to a
different owner/queue.

How to use it:
1. Open the item.
2. Use the language chip to set the customer's language (re-drafts the reply).
3. Use the owner chip to reassign it.

## Marking an item Done, by phone, or archiving it
Key: none

What it does: Closes an item with a reason. "Mark done" = handled; "Resolved by phone" = you called
the customer; "Archive" = no action needed (FYI/noise). Sending a reply marks it Done automatically.

How to use it:
1. Open the item.
2. Use the action bar: "Mark done", "Resolved by phone", or "Archive".
3. A closed item can be reopened from the same bar.

## Handling an email in Outlook instead of Axle
Key: outlook_close

What it does: If you deal with an email straight in Outlook rather than in Axle, you don't have to
come back and press Done. At the next sync Axle checks each open item's email and closes it if you
have marked it read, filed it out of the Inbox, or deleted it. It shows on the Done tab as
"handled in Outlook".

Axle only ever works from the Inbox (and, for info@, the Shopify Contact Form folder). Anything you
move somewhere else is yours to handle in Outlook, and Axle lets it go.

Two things worth knowing. Reading counts as handling, so simply opening an email in the Outlook
reading pane will close it — if that closes something you're still working on, reopen it from the
Done tab and it comes straight back. And an item Axle has flagged for a careful check is treated
more cautiously: reading it is not enough to close it, so it stays on your list until you either
file or delete the email in Outlook, or press Done in Axle.

How to use it:
1. Handle the email in Outlook as you normally would — read it, file it, or delete it.
2. Nothing else — it drops off the Open list at the next sync (or press "Sync now").
3. To bring one back, open the Done tab, open the item, and press Reopen.

## Stopping unwanted emails from a sender (block)
Key: none

What it does: Hides future emails from one sender address so they no longer appear in Axle. The mail
still arrives in the shared Outlook mailbox; this only affects Axle, and any teammate can undo it.

Only the exact address can be blocked — never a whole domain. Blocking a domain like gmail.com would
hide every customer using it, which is exactly what happened once before anyone noticed.

How to use it:
1. Open an item from the unwanted sender.
2. Use "Block sender" and confirm — the address is shown before you commit.
3. Manage or undo blocks on the "Blocked" page.

## Switching Axle's language (English / Dutch)
Key: none

What it does: Switches Axle's own interface wording between English and Dutch. This is separate from
the customer's language — it only changes what you see.

How to use it:
1. Use the EN / NL toggle at the top right.

## Getting the newest emails now (Sync)
Key: none

What it does: Axle checks for new mail automatically on a schedule. "Sync now" fetches immediately
instead of waiting.

How to use it:
1. Click "Sync now" in the inbox. New emails appear shortly, each already drafted.
