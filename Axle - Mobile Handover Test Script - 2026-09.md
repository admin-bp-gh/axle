# Axle Mobile: Handover Test Script

Date: 26 Sep 2026

## Before you start

Axle is the tool we use to read and answer customer emails. This is the new phone version of it, built to work on your own iPhone with one thumb.

How to open it: on your iPhone, open Safari, and go to the usual Axle address over Tailscale. If Tailscale is not connected, ask Brad.

This is a check, not real work. You are looking at real customer items, but you are not answering them. Follow two rules all the way through:

1. Never press Send now. If a step asks you to reach the Send button, stop there. Do not press it.
2. Do every step on the test item the admin names below, not on any other item, unless a step says otherwise.

Test item: #______ (filled in by Brad)

Go through the sections in order. For each row, do the tap, look at the result, and tick the OK column if it matches. If it does not match, leave it blank and read "If something is wrong" at the end.

## 1. Inbox list

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 1 | Open Axle. Look at the top of the screen. | One thin bar at the top with the Axle name and a menu button. No second row underneath it. | M-01 | |
| 2 | Look below the top bar. | One row of tabs (Open, Needs answer, Ready, and so on), then a thin line showing "Live" and a Filters button. Together this takes up less than a third of the screen. | M-10 | |
| 3 | Look at the gaps between the tabs. | Each tab is easy to tap on its own. They do not touch each other. | M-13 | |
| 4 | Look at the bottom right of the screen. | A round "New email" button sits above the bottom edge, not touching the very edge of the screen. | M-04 | |
| 5 | Scroll down the list, then look at the whole screen. | Nothing floating covers the list, the tabs, or the New email button. There is no extra round button anywhere on the screen. | M-03 | |
| 6 | Tap the Needs answer tab, then the Ready tab. | Only the list changes. The screen does not go blank or flash white in between. | M-16 | |

## 2. Filters and menus

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 7 | Tap the menu button in the top bar. | A panel slides up from the bottom with a list: Inbox, Blocked, Audit, Requests, then EN and NL, then your name. | M-01, M-02 | |
| 8 | In that panel, tap the grey area above the panel. | The panel closes. You are still on the same screen. | (sheets close by tapping the grey area or Cancel) | |
| 9 | Open the menu again, tap Blocked. | The Blocked page opens. It has a note saying it works best on a desktop, and the table scrolls sideways inside its own box, not the whole page. | M-46 | |
| 10 | Go back to Inbox. Tap Filters. | A panel slides up with Mailbox, Mine/All, Sort, and a Sync now button. Every row is easy to tap. | M-14 | |
| 11 | Scroll the list down a little way first, then tap Filters again. | The Filters panel still opens cleanly at the bottom. It does not appear in the wrong place or half off-screen. | M-09 | |
| 12 | In the Filters panel, tap Cancel. | The panel closes without changing anything. | M-08 | |
| 13 | Open an item (see section 6), then tap the Language chip near the top. | A panel slides up showing EN and NL as two clear options. | M-21 | |

## 3. Search

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 14 | On the Inbox list, tap the search (magnifying glass) icon. | A search box opens and the keyboard appears straight away. The text in the box is a normal reading size, not tiny. | M-06 | |
| 15 | Type a search that will not match anything, such as "zzqqxx". | The list clears and shows a message like "No matches for 'zzqqxx'", with a clear "Clear search" button. | M-15 | |
| 16 | Tap "Clear search". | The full list comes back. | M-05 | |

## 4. Done tab and Load more

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 17 | Tap the Done tab. | The list appears quickly (a couple of seconds, not a long freeze), showing the newest 50 items. | M-11 | |
| 18 | Scroll to the bottom of the Done list. | A button reading "Load more (50 of N)" sits below the last card. | M-11 | |
| 19 | Tap "Load more (50 of N)". | 50 more items are added below the first 50. The first 50 stay exactly where they were. | M-11 | |

## 5. New email (compose)

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 20 | Tap the round "New email" button. | The compose screen fills the whole screen. There is a Cancel option at the top or bottom, and nothing from the list is visible behind it. | M-40 | |
| 21 | Look at the fields without tapping anything yet. | No field has the keyboard already open and no field is already zoomed in. | M-43 | |
| 22 | Tap the "To" field and type a few letters. | The keyboard opens and the text you type is a normal reading size, not tiny. | M-06 | |
| 23 | Look at the bottom of the compose screen. | Cancel, Draft, and Send now sit in a row at the very bottom, each big enough to tap easily, with space above the home area. | M-41 | |
| 24 | Look at the small round chips near the top (subject shortcuts, if shown) and the "Add files" control. | The chips have a clear gap between each one. The file button is a proper button, not a thin default control. | M-42 | |
| 25 | Type something in the message box, then, without saving, switch to another app and come back to Axle. | The compose screen is still open with your text still in it. Nothing was cleared. | M-59 | |
| 26 | Tap Draft (not Send now). | The compose screen closes and a new item appears in the list marked as a draft. | (Send now only when enabled) | |

## 6. Email detail (open an item)

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 27 | On the test item, tap the card in the list. | The screen changes fully to that email. It does not stay stuck on the list. | M-07 | |
| 28 | Look at the top of the item screen. | One thin bar with a back arrow and the item title (up to two lines). The old wide header from the list screen is gone. | M-19 | |
| 29 | Look at the row of chips under the title (mailbox, language, owner, and so on). | The chips sit on one line that you can scroll sideways. Each chip is easy to tap and has a small arrow showing it opens something. | M-21 | |
| 30 | If the test item needs an answer, look at the order from the top of the screen down. | The customer's email comes first (under the chips and "Customer & docs"). The open question sits directly below the email, and the reply box comes after the question. | M-22 | |
| 31 | Scroll down to the customer's email text. | If the message is long, it is cut short with a "Show full message" link. | M-23 | |
| 32 | Tap "Show full message". | The rest of the message appears. Tapping again (or "Show less") folds it back. | M-23 | |
| 33 | Look at any fold row, such as "Earlier in this conversation" or "What Axle checked". | Each fold row is a full-width bar with an arrow, easy to tap. | M-24 | |
| 34 | If the item has an attached file from the customer, look at how it is shown. | Each attachment is a clear box (a "chip") with its file name, not a small plain text link. | M-25 | |

## 7. Reply and the bottom bar

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 35 | Look at the bar fixed to the bottom of the item screen. | It has at most two rows: the recipient line on top, then Send and a "..." button below it. It is not three or four rows deep. | M-28 | |
| 36 | Look at the recipient line in that bar. | The full email address is shown and readable, not cut off with "...". | M-29 | |
| 37 | Look at the gap between the recipient line and the Send button. | There is a clear gap between them; they do not touch. | M-30 | |
| 38 | If the test item has no confirmed recipient yet, look at the recipient line. | It shows in amber: "Confirm recipient: no recipient yet", and Send looks greyed out (disabled). | M-31 | |
| 39 | Tap the reply box and type a short test sentence (do not save yet). | The keyboard opens, the text is a normal reading size, and the box grows taller as you type instead of scrolling inside itself. | M-27 | |
| 40 | If the item has an open question, tap the feedback box under it and type a short note. | Same as above: normal size text, box grows as needed. | M-26 | |
| 41 | With text still typed in, wait a couple of seconds, then reload the page. | Your typed text is still there, with a small note such as "Unsaved edits restored". | M-56 | |
| 42 | With text typed in, tap the recipient line, confirm a recipient (see section 8), and watch what happens after. | Your typed reply text is still there after the recipient screen closes. It was not wiped. | M-57 | |
| 43 | With text typed in, tap the "..." button, then Cancel to close it without choosing anything. | Your typed text is still there. | M-32 | |
| 44 | Tap the back arrow without saving your typed text. | You return to the list. The card for that item now shows a small "Draft kept" tag. | M-58 | |
| 45 | Open the item again. | Your typed text comes back in the reply box. | M-56 | |
| 46 | With a recipient confirmed and Send enabled, tap Send. **Do not confirm it.** | Your iPhone shows its own alert with the full email address written out in full. | M-30 | |
| 47 | On that alert, tap Cancel. | The alert closes. Nothing is sent. You are back on the item screen exactly as before. | (Send confirm is the phone's own alert; press Cancel) | |

## 8. Recipient sheet

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 48 | Tap the recipient line to open the recipient screen. | A panel slides up from the bottom showing the known addresses as a list, each one a full-width row easy to tap. | M-34 | |
| 49 | Tap "Other address" (or similar) if shown. | An email field appears inside the same panel, above the keyboard, not hidden behind it or overlapping the bottom bar. | M-33 | |
| 50 | Tap into that email field. | The text is a normal reading size and the field is easy to tap. | M-06 | |
| 51 | Tap the grey area above the panel, or its Cancel row. | The panel closes without changing the recipient. | M-31 | |

## 9. More actions sheet

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 52 | Tap the "..." button in the bottom bar. | A panel slides up listing actions such as Save & redraft, Mark done, Resolved by phone, Archive, Block sender. Each row is easy to tap and shows a short line explaining what it does. | M-35, M-32 | |
| 53 | Look for a Cancel row at the top or bottom of that panel. | A clear Cancel (or Close) row is visible; you do not have to guess how to close it. | M-35 | |
| 54 | Tap Cancel to close it without choosing anything. | The panel closes. Nothing on the item changed. | (sheets close by tapping the grey area or Cancel) | |
| 55 | Open the "..." panel again and tap Block sender (only if the admin tells you this is safe to try on the test item). | A block page opens with a sticky bar at the top linking back to the item, and a clear Cancel button next to the primary action. | M-45 | |
| 56 | On the block page, tap Cancel. | You return to the item. Nothing was blocked. | M-45 | |

## 10. Customer & docs sheet and customer page

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 57 | On the item screen, near the top, tap "Customer & docs". | A panel rises to fill nearly the whole screen, with a "Back to email" bar at the top. | M-36 | |
| 58 | Look at any SAP documents listed inside it. | Each document is its own row (type, number, customer, amount, date), with a clear Attach button and a clear Preview button, both easy to tap. | M-37 | |
| 59 | Tap into the "attach by number" field. | The text is a normal reading size and the field is tall enough to tap easily. | M-38 | |
| 60 | Scroll to the customer details block inside this panel. | The customer's details are laid out in two columns that fit the screen, not squeezed into three narrow columns. | M-39 | |
| 61 | Tap "View full customer" (or similar). | A new full-screen page opens showing the customer record, with its own back bar at the top. | M-44 | |
| 62 | While that customer page is loading, look closely at the screen for a moment. | If it takes a moment to load, you see grey placeholder blocks shaped like the final content, not a spinning wheel. | M-53 | |
| 63 | Tap Back on the customer page. | You return to the "Customer & docs" panel, not all the way back to the email. | M-44 | |
| 64 | Tap "Back to email". | You return to the item screen, at the same scroll position as before. | M-36 | |

## 11. Back and navigation

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 65 | From the Inbox list, scroll down partway, then open an item, then tap Back. | You return to the list at the same scroll position, not back at the very top. | M-17 | |
| 66 | From the list, tap an item near the bottom of a long scroll. | The item screen opens at its own top (its title and first question), not partway down. | M-18 | |
| 67 | Tap Back several times in a row. | Each time, you land on the Inbox list. You are never taken out of Axle altogether. | M-20 | |
| 68 | Type a short note in a reply, tap Back without saving, then reopen the same item. | The note is still there, and the list card showed "Draft kept" in between. | M-58 | |

## 12. Errors and loading

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 69 | Tap a card in the list and watch the screen the instant you tap. | The screen switches to the item straight away, showing grey placeholder shapes for the title, chips, and message, rather than staying on the list with a tiny spinner. | M-52 | |
| 70 | If your connection drops for a moment while an item is open (for example, walking out of wifi range), watch what happens if you refresh. | If you ever see this: a screen saying "Couldn't load this email" with a clear Retry button, not a blank white screen. | M-51 | |
| 71 | On that screen, tap Retry (only if you saw it in step 70). | The email loads normally. | M-51 | |

## 13. Sync running (updates chip)

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 72 | If Brad tells you a sync is running while you are scrolled partway down the list, watch the thin "Live" line. | A small chip appears saying "Updates waiting, tap to refresh". The list itself does not jump or reorder under your thumb while you are scrolled or touching it. | M-12, M-54 | |
| 73 | Tap that "Updates waiting, tap to refresh" chip. | The list refreshes and scrolls back to the top. | M-54 | |
| 74 | If Brad puts the test item into a "Drafting" state, open it and watch the screen. | A banner shows the item is being worked on, with a grey placeholder reply shape underneath. The title, chips, and message above it do not move or jump. | M-55 | |

## 14. Language NL

| Step | What to tap | What "correct" looks like | Register ID | OK? |
|---|---|---|---|---|
| 75 | Open the menu and tap NL. | The app switches to Dutch. Menus, buttons, and the bottom bar all show Dutch text. | (the app language switch is EN / NL in the menu sheet) | |
| 76 | Look at the tabs, the bottom bar, and any open panel in Dutch. | Dutch labels fit their buttons and rows. Nothing runs off the edge of the screen or forces the page to scroll sideways. | M-06 | |
| 77 | Open the menu again and switch back to EN. | The app returns to English everywhere, including the item you had open. | (the app language switch is EN / NL in the menu sheet) | |

## If something is wrong

For any row you cannot tick:

1. Write down the step number and what you actually saw (a screenshot is even better than a description).
2. Take a screenshot on your iPhone (side button + volume up).
3. Send the step number, what you saw, and the screenshot to Brad.

You do not need to work out why it went wrong. Just capture it.

## Never do this

- Never press Send now. Every send check in this script stops at the phone's confirm alert, and you press Cancel there.
- Never press Mark done or Archive on a real customer item. Only use these on the test item the admin named, and only if a step explicitly asks you to.
- Never change the recipient on a real customer item. If a step opens the recipient sheet, close it with Cancel or by tapping the grey area, without picking a different address.
