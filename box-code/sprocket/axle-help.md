# Email help: what the Email app does and how to use it

This file is the AI Helper's only source of truth. The AI Helper answers staff questions ("how do I do X
in Email?") **using nothing but the capabilities written below.** If something is not described
here, the AI Helper does not know about it and will say so rather than guess, so keep this file
accurate and current. Brad maintains it.

How to write an entry (the AI Helper reads the structure, so keep to it):

- Start each capability with a `## Heading`.
- The first line under the heading is `Key: <allow-list-key>` — the action-allow-list key that
  governs it, or `none` for things that are always available (reading, viewing, editing a draft).
  The AI Helper cross-checks this key against the **live** allow-list: if the key is switched off, it
  tells the user the capability isn't enabled yet and offers to log a request — it never describes
  an off capability as if it works.
- Then `What it does:` (one or two plain sentences) and `How to use it:` (short numbered steps).
- Write for a salesperson, not an engineer. No SAP/Shopify internals unless the user needs them.

Allow-list keys currently referenced here: `send_reply`, `mark_read`, `attach_doc`,
`compose_send`, `contactform_send`. (The live on/off state is supplied to the AI Helper separately at
answer time — do not hard-code on/off in this file.)

---

## The inbox and what the queue is telling you
Key: none

What it does: The inbox is your prioritised work queue. Each card is one customer conversation
the Email assistant has already read and researched. The coloured state chip tells you what it needs from you:
"New", "Drafting…" (the Email assistant is still working), "Needs your answer", "Ready to send", "Done" or
"Archived". By default the queue sorts so whatever needs you next is at the top.

How to use it:
1. Open Email. The left pane is the queue; the middle and right panes are the item you're working.
2. Use Mine / All to switch between your own items and everyone's.
3. Use the status tabs (Open / Done / Archived / All) and the search box to find anything.
4. Use the Sort control if you'd rather see newest, oldest or highest-priority first.
5. Click any card to open the conversation, the draft and the brief.

## Reading the conversation and "What the Email assistant checked"
Key: none

What it does: When you open an item you see the customer's email (newest message first, older
messages folded beneath), and on the right the "What the Email assistant checked" brief plus any SAP documents
the Email assistant found, so you can see the facts behind the draft without opening SAP yourself.

How to use it:
1. Click an item.
2. Read the newest message at the top; click "Earlier in this conversation" to expand the history.
3. Read the right-hand brief to see what the Email assistant looked up (stock, orders, customer, tracking).

## Reading a foreign-language email in your own language
Key: none

What it does: If a customer wrote in a language other than your interface language, the Email app shows a
translation so you can read it. Your interface language is separate (EN/NL toggle, top right).

How to use it:
1. Open the item.
2. Click "Show translation" under the customer's message.
3. To change which language the Email app thinks the customer wrote in, use the customer-language control
   on the item (this fixes the translation; it does not re-send anything).

## Answering the Email assistant's questions and redrafting
Key: none

What it does: When the Email assistant needs something from you before it can finish a reply (a physical check,
a colleague's confirmation, a decision), it lists its questions and holds the draft. You answer in
one box and ask the Email assistant to redraft.

How to use it:
1. Open an item marked "Needs your answer".
2. Read the numbered questions (a "Please check" marker means a physical check).
3. Type your answers and anything else the Email assistant should know in the one answer box.
4. Click "Save & redraft": the Email assistant rewrites the reply with your input in the background.

## Dig deeper on a draft
Key: none

What it does: The Email assistant writes the reply again, more thoroughly and with a stronger model: it decodes the VIN
and checks every part it names in JLR EPC, and looks at trusted catalogue sites when SAP and EPC leave
the fitment open. The new draft replaces the current one, like Redraft. When it changes something, a
note starting "Dig deeper:" under Notes from the Email assistant says what changed. The Email assistant may suggest it quietly under
the answer box, for example when the fitment is not confirmed. It never runs by itself.

How to use it:
1. Open an item with a draft.
2. (Optional) Type what the Email assistant should look at in the answer box.
3. Click "Dig deeper" next to Redraft, or press Ctrl+Shift+Enter (Cmd+Shift+Enter on a Mac).
4. It takes a minute or two; you can work on other emails meanwhile.

## Editing the reply before it goes out
Key: none

What it does: The "Reply to send" box is the exact text the customer will receive. You can change
it however you like before sending; "Reset to AI draft" puts the Email assistant's original wording back.

How to use it:
1. Open a "Ready to send" item.
2. Edit the reply text directly.
3. (Optional) Use "Show translation" to check your edited reply in the customer's language.

## Sending the approved reply
Key: send_reply

What it does: Sends your reply to the customer, in the original email thread, exactly as shown in
the "Reply to send" box. The Email app then marks the item Done and marks the original email read. The Email app
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

## Suggested documents (the Email assistant proposes the right PDF for you)
Key: attach_doc

What it does: When a customer's email refers to one of their orders or invoices, the Email assistant finds the
document in SAP and offers it as a one-click attachment, so you don't have to look the number up.
It only ever suggests documents that belong to this customer.

How to use it:
1. Open an item that mentions an order/invoice.
2. In the "Suggested documents" card, click "Attach" on the one you want.
3. Send the reply to send it.

## Carrier claims (MyParcel asking about a lost or missing parcel)
Key: claim_autoattach

What it does: When MyParcel writes about a parcel that has gone missing and asks for our invoices,
the Email assistant works out which shipment they mean from the barcode in their email, finds the order and the
sales invoice for it, and attaches two documents to the draft for you: the sales invoice, and a
purchase-value statement listing every part in that parcel with what it cost us. It also writes the
reply, including the contents list and the box description MyParcel always asks for.

Why a statement and not our supplier's invoice: a supplier invoice covers a whole delivery of parts
that were not in this parcel, so we never send one. The statement covers exactly this parcel.

How to use it:
1. Open the item. Both PDFs are already under Attachments.
2. Check them, remove either one if you don't want it, and edit the reply as usual.
3. Send the reply to send them.

Good to know: The Email assistant can only ever attach documents belonging to the order that the barcode itself
points to, so it cannot pull in another customer's paperwork. If the barcode is not one of our own
shipments it attaches nothing and asks you to check it. Photos of the parcel or the product are
still yours to add.

## Composing a brand-new email to a customer
Key: compose_send

What it does: Lets you start a new (non-reply) email. You pick the customer, tell the Email assistant in plain
language what to say, and the Email assistant researches the facts and drafts it. Sending new emails is governed
separately from replies.

How to use it:
1. Click "New email".
2. Find the customer (code, email, order #, invoice # or name) and confirm the recipient.
3. Tell the Email assistant what the email should say, pick the language, and "Draft this email".
4. Review the draft. (Whether you can send it depends on the compose-send allow-list key.)

## Replying to a webshop contact-form message
Key: contactform_send

What it does: Contact-form messages arrive from Shopify's mailer, so the customer's real address is
in the body, not the sender. The Email app parses the form, matches the customer in SAP, and proposes the
address to reply to. You confirm the recipient before anything can be sent.

How to use it:
1. Open the contact-form item (it carries a "Contact form" chip).
2. Check the parsed customer and confirm the address to reply to.
3. Review the draft and subject. (Whether you can send depends on the contact-form allow-list key.)

## Setting the customer's language or reassigning an item
Key: none

What it does: You can correct the language the Email app detected for a customer, and reassign an item to a
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

## Handling an email in Outlook instead of the Email app
Key: outlook_close

What it does: If you deal with an email straight in Outlook rather than in the Email app, you don't have to
come back and press Done. At the next sync the Email app checks each open item's email and closes it if you
have marked it read, filed it out of the Inbox, or deleted it. It shows on the Done tab as
"handled in Outlook".

The Email app only ever works from the Inbox (and, for info@, the Shopify Contact Form folder). Anything you
move somewhere else is yours to handle in Outlook, and the Email app lets it go.

This also works the other way round. If you mark an email unread again in Outlook (the usual way
of saying "actually, this still needs doing"), the Email app puts the item back on your Open list at the
next sync, exactly as it was. That only applies to items the Email app closed for you: something you closed
yourself in the Email app, or closed by sending a reply, stays closed, because that was your decision. The
email has to be unread and still in the Inbox (or the Shopify Contact Form folder); if you filed or
deleted it, it stays closed. Items closed more than a month ago are settled and do not come back.

The Email app looks at the whole conversation, not just the newest email. While any message in a thread is
still unread in the Inbox, the item stays on your Open list — so if a customer's first email is
unread but you have read their follow-up, the item is still waiting for you. That is deliberate:
unread mail always wins over any reason the Email app might have had to close it.

Two more things worth knowing. Reading counts as handling, so opening the last unread email of a
conversation in the reading pane will close its item — if that closes something you are still
working on, mark it unread again, or reopen it from the Done tab. And an item the Email assistant has flagged for
a careful check is treated more cautiously: reading it is not enough to close it, so it stays on
your list until you either file or delete the email in Outlook, or press Done in the Email app.

How to use it:
1. Handle the email in Outlook as you normally would — read it, file it, or delete it.
2. Nothing else — it drops off the Open list at the next sync (or press "Sync now").
3. To bring one back, mark the email unread in Outlook, or open the Done tab and press Reopen.

## Stopping unwanted emails from a sender (block)
Key: none

What it does: Hides future emails from one sender address so they no longer appear in the Email app. The mail
still arrives in the shared Outlook mailbox; this only affects the Email app, and any teammate can undo it.

Only the exact address can be blocked — never a whole domain. Blocking a domain like gmail.com would
hide every customer using it, which is exactly what happened once before anyone noticed.

How to use it:
1. Open an item from the unwanted sender.
2. Use "Block sender" and confirm — the address is shown before you commit.
3. Manage or undo blocks on the "Blocked" page.

## Switching the Email app's language (English / Dutch)
Key: none

What it does: Switches the Email app's own interface wording between English and Dutch. This is separate from
the customer's language — it only changes what you see.

How to use it:
1. Use the EN / NL toggle at the top right.

## Getting the newest emails now (Sync)
Key: none

What it does: The Email app checks for new mail automatically on a schedule. "Sync now" fetches immediately
instead of waiting.

How to use it:
1. Click "Sync now" in the inbox. New emails appear shortly, each already drafted.
