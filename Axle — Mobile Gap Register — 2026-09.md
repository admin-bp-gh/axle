# Axle: Mobile Gap Register, September 2026

Date: 24 Sep 2026

## 1. Header

**Method.** The live Axle app was walked over Tailscale in Brad's admin session on 24 Sep 2026, read-only. Chrome on Windows would not shrink below its minimum window width, so the phone viewports were emulated with a same-origin iframe inside the live app origin at 393x852 (primary), 375x812 (floor) and 430x932 (ceiling), with 1440x900 as the desktop baseline. Media queries and the `:has()` list-to-detail switch evaluate against the iframe viewport, so layout, wrapping and stacking are faithful. The emulation does NOT reproduce iOS Safari specifics: the bottom toolbar, home indicator and safe areas, the on-screen keyboard, focus zoom, overlay scrollbars, rubber-band scrolling, tab discard or background/resume. Windows scrollbars take 15px inside the frame (scrollWidth 378 at 393), an emulation artefact and not a finding. All numbers are CSS px from getBoundingClientRect on the live DOM. No send, approve, close, block, mark-read, sync or any other write was performed; only GET navigations and client-side menu and modal toggles. Screenshots are in `design-reference/mobile-audit/`. File:line references were checked against `box-code` on 24 Sep 2026.

**Codebase facts that frame this register.**

- One layout breakpoint: `@media (max-width: 1100px)` (components.css:430-459). The only other media query is a Sprocket-only `max-width: 600px` rule (components.css:499-502). Everything from a 1099px tablet down to a 375px phone gets the same single-column layout.
- The phone flow is a pure-CSS list-to-detail switch: `#workpane{display:none}` plus `.shell:has(#workpane .has-item)` (components.css:442-444), keyed off the `has-item` class that `workPanes()` adds when `opts.back` is set (ui.js:896-899, item.js:968). The context pane is not its own screen; it stacks under the centre pane (components.css:436-438).
- No SSE. `assets/sse.min.js` is vendored but never loaded. Liveness is HTMX and JS polling: the queue self-refresh singleton (inbox.js:530-556), the 10s busy-item poller (item.js:978) and background fetches for translations.
- `ASSET_V = "polaris14"` (ui.js:703). Any assets change in the redesign needs a bump.
- The roadmap's newest dated entry is 15 Aug 2026, while repo commits run to 17 Sep 2026, so roughly five weeks of work are unrecorded [uncertain what those commits changed]. The Polaris retheme track (which built the mobile list-to-detail) is not cross-referenced in the roadmap.
- No `env(safe-area-inset-*)`, `dvh`, `viewport-fit`, `visualViewport`, `beforeunload`, `pagehide` or `visibilitychange` anywhere in box-code (grep, 24 Sep).

**Input contradictions resolved in this register.**

1. walk-notes says there is no click-outside close for chip, overflow, filter and recipient popovers. ui.js:727-732 closes any open `details.chipmenu` or `details.menu` on an outside click. Outside-tap close is treated as present; whether iOS Safari dispatches that click from a tap on non-interactive content is listed in section 5.
2. walk-notes (line 79) and inventory B say a browser without `:has()` shows the panes stacked. The CSS hides `#workpane` unconditionally below 1100px and only the `:has()` rule shows it, so without `:has()` an opened item never appears (M-07).
3. walk-notes and inventory B say the body uses 100vh on the phone. `body.appshell{height:100vh}` (components.css:309) is overridden to `height:auto` below 1100px (components.css:431); the viewport units that do apply on a phone are listed in M-05.
4. Inventory B says the Other-address email input is unstyled at the browser default size. components.css:251-252 styles it at 12px, which matches the walk's 12px.
5. Inventory B says chip-menu and overflow-menu buttons miss the 44px rule. The bare `button` selector in components.css:454 covers them, which matches the walk's 44px menu items.
6. Inventory B says the attach-by-number input matches `input[type=text]`. It has no `type` attribute (item.js:520), so neither the 13px rule nor the 44px rule applies, the same as the audit filter inputs the walk measured at 21px tall (M-38).
7. walk-notes describes two `div.msg.quoted` blocks on item 2211 as "laid out below". ui.js:631-632 places them inside the collapsed "Earlier in this conversation" fold; they only take space when opened (the +2048px figure). Quoted history is folded by default.
8. walk-notes flags the Other-address field for having no inputmode. `type="email"` (item.js:577) already brings up the email keyboard; only its 12px size fails.

## 2. Top ten blockers

Chosen by impact on the tasks Brad and the reps do on an iPhone: read, answer, reply, confirm the recipient, send, close.

1. **M-57**: Confirming a recipient, changing a chip or attaching an SAP doc reloads the item and drops any unsaved reply text.
2. **M-56**: There is no autosave or restore of the reply anywhere. A discarded tab or an accidental back loses the draft.
3. **M-22**: On a "Needs your answer" item the blocking question is 1.5 screens down and the reply is 2 screens down, below an 825px email wall.
4. **M-36**: Customer, SAP documents and "What Axle checked" are only reachable by scrolling past everything, 2,650 to 2,850px down.
5. **M-03**: The Sprocket FAB sits on top of the action bar's Mark done / More actions row and on the compose modal's Send now button.
6. **M-11**: The Done and All tabs render every item in one page (Done: 1,532 cards, 4.67 MB, 132,282px), which stalls the renderer.
7. **M-28**: The sticky action bar is three rows (174px) at 393 and 375, so only 503px or 473px of reading space is left.
8. **M-06**: Every input and textarea is 12 to 13px, so iOS zooms the page on each focus, including the reply box.
9. **M-33**: Opening "Other address…" grows the recipient popover over the action bar, putting the email field on top of the Confirm recipient button.
10. **M-31**: The "Confirm recipient" label is inert. Only the 29px caret beside it opens the recipient popover.

## 3. The register

Severity scale: blocks the task / hurts / cosmetic. The State column gives the screen or item state where the defect shows. Evidence cites screenshots in `design-reference/mobile-audit/` and file:line in `box-code`.

### 3.1 Shell and chrome (header, FAB, safe areas, dvh)

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-01 | All shell pages, 393/375 | The header wraps into two rows (nav row, then EN/NL plus user row) and is 121px tall on every screen, a seventh of the viewport before any content. | B1, B9 | hurts | 393-queue-open.jpg, 393-item-2222-top.jpg; header 121px (walk); components.css:18, 457-458; ui.js:722-723 | One-row compact app bar (brand, screen title, menu button); nav, language and user move into a menu sheet. |
| M-02 | All pages | Header targets are under 44px wide and crowded: Inbox 40x44, Audit 39x44, EN 23x44 and NL 23x44 with 5px between them. | B3 | hurts | 393-queue-open.jpg; walk measurements; components.css:24, 458 | Menu sheet with 44px full-width rows for Inbox, Blocked, Audit, Requests, and a two-option segmented EN/NL. |
| M-03 | Queue, item, compose | The Sprocket FAB (fixed, z-index 60, 52x52 at T786 B838 L312 R364, 14px from the bottom) covers the action bar's third row (785-829, Mark done / More actions) and compose's Send now. Its panel also stacks above the compose modal (z-index 50), so two overlays can be open at once. | B4, B6, B1 | blocks the task | 393-item-2222-top.jpg, 393-compose-modal-bottom-fab-over-send.jpg; components.css:263, 464, 499-500; ui.js:648-659 | Hide on phone with handoff: remove the FAB from the item and compose screens and offer Sprocket from the app-bar menu; never show it over a sheet. |
| M-04 | All screens on a notched iPhone | No safe-area handling anywhere, and the viewport meta has no `viewport-fit=cover`. The sticky `.actionbar` (bottom 10px), `.m-back` and `.queue-head` (top 0), the FAB (bottom 14px) and the compose overlay are placed without insets and can sit in the home-indicator or toolbar zone [uncertain on device]. | B1, B4 | hurts | components.css:198, 263, 329, 447, 464, 500; ui.js:714; grep for env( returns nothing | Safe-area padding: `viewport-fit=cover` plus `env(safe-area-inset-*)` on the sticky bars, sheets and any fixed control. |
| M-05 | Customer modal, Sprocket, popovers, empty item pane | Heights use `vh`, which ignores the iOS toolbar: `.cusdialog` max-height 86vh, the Sprocket panel min(75vh, 560px), the popover clamp calc(100vh - 16px) against `window.innerHeight`, and `.empty-state` 60vh. The queue also shows a 9px phantom scroll (scrollHeight 861 at 852) [cause uncertain]. | B1 | cosmetic | walk (queue at 393); components.css:178, 325, 501; ui.js:749, 752 | dvh: move viewport-relative heights to `dvh`, and clamp popovers against `visualViewport`. |
| M-06 | Every form on the phone | All text inputs are below 16px, so iOS zooms on focus. Measured: queue search `#q` 13px, sort `#qsort` 12px, `#mq` 13px, reply textarea 13px, feedback 13px, compose `#who` and `#csubject` 13px, `#clang` and `#cmailbox` 13px, compose file input 12px, Other-address email 12px, Sprocket textarea 13px, audit filters 13.3px. | B3 | hurts | walk measurements; tokens.css:45 (`--fs-base` 13px, `--fs-sm` 12px); components.css:87-92, 95, 252, 271, 334, 492 | 16px inputs: set 16px on input, select and textarea inside the phone media query. |
| M-07 | Any browser without `:has()` (iOS Safari before 15.4) | The whole phone flow depends on one `:has()` rule. Without it `#workpane` stays `display:none`, so tapping a card or opening an item deep link shows only the list and the item never appears. The CSS comment claims it works without JS, which is true, but it does not work without `:has()` [uncertain which iOS versions the reps run]. | B2, B10 | blocks the task | components.css:425-429, 442-444; ui.js:896-899 | Reuse the existing list-to-detail pattern, but also set a class on `.shell` or `body` from the server (item routes) so the detail view does not depend on `:has()` alone. |
| M-08 | JS disabled or failed | The no-JS fallback for popovers is CSS `position:absolute` with fixed min-widths (chip menu 200px left-anchored, overflow menu 290px, recipient popover 320px). Without the JS positioner these can run past the viewport edge [uncertain: no-JS was not walked]. | B5 | cosmetic | components.css:65, 210, 239, 354; ui.js:733-740 | Bottom sheet on phone (fixed, full width) in CSS, so placement never depends on the JS positioner. |
| M-09 | Every page load on the phone | Desktop-only JS runs unguarded on the phone. The splitter IIFE reads localStorage `axleQueueW` and sets `--queue-w` on every load, which is harmless because the grid is neutralised. The popover positioner re-places the open menu on every captured scroll event while the body scrolls. | B1 | cosmetic | ui.js:773-775, 844-866; components.css:433-434 | Guard with `matchMedia('(max-width:1100px)')`; on the phone, menus become sheets that do not track scroll. |

### 3.2 Queue

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-10 | Queue, any tab, 393 and 375 | The sticky `.queue-head` has four rows (New email, Mine/All and Filter; tabs; search, sort and count; Live and Sync) and is 217px tall (T121 B338). With the header, 338px (40%) is chrome before the first card: about 514px of list is visible at 393x852 and 474px at 375x812. | B1, B9 | hurts | 393-queue-open.jpg, 375-floor-queue-and-item-2222-reply.jpg; components.css:329-335; inbox.js:432-458 | Collapse the toolbar to one sticky row (segmented tabs plus a search icon). Filter, sort, Mine/All and Sync go into a bottom sheet; New email becomes a bottom-right primary button that respects the safe area. |
| M-11 | Done and All tabs | No pagination or windowing. Done renders 1,532 cards in one page: scrollHeight 132,282px, 4,672,417 bytes of HTML, 4.9s on the office LAN, and the renderer stalled on capture. All has 1,616 cards. The query has no LIMIT, and each card embeds the full email text in `data-search` for client-side search. | B8 | blocks the task | walk (Done tab); inbox.js:92-95, 134-137, 149-155 | Paginate (for example 50 per page with "Load more"), and move search to the server so cards stop carrying the email body. |
| M-12 | Queue with sync running or any item drafting | The queue auto-refresh re-fetches the whole current tab every 8s (sync) or 15s (drafting). It keeps running while an item is open and the queue is `display:none`, and while the tab is backgrounded. On the Done tab each tick is the 4.67 MB fragment. Code-only. | B8 | hurts | inbox.js:539-553; components.css:443 | Paginate, and poll a small count or delta endpoint instead; pause when the list is hidden or `document.hidden`. |
| M-13 | Queue toolbar | The status tabs are 44px tall but only 2px apart. The "All" segment is 37x44 and touches "Mine" with no gap. | B3 | hurts | 393-queue-open.jpg; components.css:336-341, 454-456 | Full-width segmented tabs, each at least 44px wide, with 8px spacing between separate controls. |
| M-14 | Filter menu open | Filter menu items `a.mitem` are 170x32 (links are outside the 44px rule). The menu itself stays in the viewport (L205 R385 T179 B313). | B3 | hurts | 393-queue-filter-menu.jpg; components.css:357, 454-455; inbox.js:131, 437-438 | Bottom sheet with 44px rows and a visible close. |
| M-15 | Search with no matches | The list goes blank and the only feedback is "0 of 6" in small text next to the sort control. There is no empty-state message and no clear action. | B7 | cosmetic | 393-queue-search-empty.jpg; inbox.js:465-473 | Empty-state row ("No matches for …") with a 44px Clear search button. |
| M-16 | Switching Open / Done / Archived / All | Tabs and mailbox filters are plain links, so each switch is a full page load that re-downloads the header, the Sprocket widget and the whole list over 4G. | B8 | hurts | walk (tabs have no hx attributes); inbox.js:131-133, 441 | Segmented tabs that swap only `#queuepane` (hx-get with hx-push-url), paginated. |
| M-17 | Back from item to list | The back bar calls `history.back()`. With `historyCacheSize:0` and `refreshOnHistoryMiss:true`, htmx does a full reload of `/` after a card tap, so the list is re-fetched each time. The search filter survives through sessionStorage, but list scroll position is lost [uncertain]. | B8, B9 | hurts | ui.js:719, 898; inbox.js:150, 473-477 | Reuse the list-to-detail pattern client-side: Back removes the detail view and restores the list's scroll position without a reload. |
| M-18 | Tapping a card far down the list | The card swap uses `hx-swap="innerHTML"` with no `show:` or `scroll:` modifier while the body is the scroller, so the item can open at the list's scroll offset rather than at its top [uncertain: not walked from a scrolled list]. | B2 | hurts | inbox.js:150; components.css:431 | Swap with `show:window:top`, and restore the list offset on Back (see M-17). |

### 3.3 Item view (brief and chips, thread, questions, reply editor, action bar and send gate, recipient popover, menus)

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-19 | Any item, 393 | Brief: top chrome is the header (121) plus the sticky back bar (44), 165px in total. The title and chips block then runs from 185 to 415 (230px) before any content. | B1, B9 | hurts | 393-item-2222-top.jpg; components.css:447-449; item.js:728-734 | Collapsed brief: on the item screen the back bar carries the title (one line) and the header hides; chips become a single horizontal chip row. |
| M-20 | Item opened from a link in another app or tab | Brief: the back bar calls `history.back()` whenever `history.length > 1`, so a deep link opened in a tab with earlier history goes back to that page, not to the inbox [uncertain in practice]. | B2 | hurts | ui.js:898 | The back bar goes to the list (the in-app route), and uses history only when the previous entry is the Axle queue. |
| M-21 | Any item | Brief: the Language and Owner chip menus are the controls, but their summaries are 108x24 and 148x24, 6px apart in the chips row. The "this is a control" cue is a dashed border shown only on hover; on touch only a 9px caret at 70% opacity remains. The menu items themselves are 190x44 and stay in the viewport. | B3, B5 | hurts | 393-item-2222-language-chip-menu.jpg; components.css:38, 55, 61-64; ui.js:564 | Chip row with a 44px hit area per chip, 8px gaps and an always-visible caret; options open in a bottom sheet. |
| M-22 | Needs your answer (2222, contact form) | Order: the customer email card renders first at full height (825px, the form mail as one tall pre block). "Questions for you (1 open)" starts at 1,472px and "Reply to send" at 1,722px of a 2,718px page, so the blocking question is 1.5 screens down and the reply 2 screens down. The answer-first ordering in the work form sits below the email card. | B9, B4 | blocks the task | 393-item-2222-email-wall-bar.jpg, 393-item-2222-questions-reply.jpg; item.js:435-441, 490-496, 737-741, 793 | Segmented tabs on the item screen (Question / Email / Reply) opening on the task the state calls for; alternatively a collapsed brief plus the email folded (M-23). |
| M-23 | Long mails (2211, 2222) | Thread: the newest customer message is never shortened. It is 1,325px on 2211 (long signature; the footer fold only catches legal-disclaimer lines) and 825px on 2222. On contact-form items the raw form mail repeats what the parsed customer card already shows. | B8, B9 | hurts | 393-item-2211-reply-send-bar.jpg, 393-item-2222-email-wall-bar.jpg; ui.js:571, 580-586, 622-627; item.js:737-741 | Fold: show the first ~12 lines with "Show full message"; on contact-form items fold the raw form mail under the parsed card. |
| M-24 | Any item with folds | Thread: fold summaries are 18px tall (`details.fold`, `.fold.older`, `.fold.prevdraft`), "What Axle checked" is 20px, and the Questions fold summary is a bare `<summary>`. | B3, B5 | hurts | walk measurements; components.css:124, 138-140; item.js:441, 480-481, 967; ui.js:625, 631 | Fold rows at least 44px tall, full width, with a visible chevron. |
| M-25 | Items with inbound attachments (2220) | Thread: inbound attachments render as inline text links (276x17) in a single paragraph and open in a new tab, instead of as chips. | B3, B8 | hurts | walk (2220); ui.js:533-539; components.css:142-143 | Chip row: one 44px chip per file with type and size, wrapping. |
| M-26 | Questions card open | Questions: the feedback textarea is 48px tall at 13px with `resize` in both axes; a horizontal resize could push the page wider than the viewport [uncertain on iOS]. | B3, B2 | cosmetic | walk measurements; components.css:92; item.js:426 | Auto-growing textarea, `resize: vertical` or none, 16px. |
| M-27 | Editable reply (2211, 2222) | Reply editor: `#replybox` is 13px with a fixed 240px minimum height, `rows=2` and its own scrollbar inside the page scroll (scroll within scroll). It sits in the page flow two screens up from the sticky Send, and the reading area between the bars is only 503px at 393 and 473px at 375. | B3, B4 | hurts | 393-item-2222-questions-reply.jpg, 375-floor-queue-and-item-2222-reply.jpg; components.css:90-91; item.js:464-471 | Sticky reply bar: a compact 16px auto-growing composer docked above the action bar, expanding to a full-screen editor page with a visible back. |
| M-28 | Any open item, 393 and 375 | Action bar: the sticky `.actionbar` wraps to three rows ([Send or Confirm recipient ▾][Save] / [Save & redraft][Mark done] / [More actions]), 174px tall (T668 B842). At 430 it drops to two rows (122px). | B4, B1 | hurts | 393-item-2222-top.jpg, 393-item-2211-reply-send-bar.jpg; components.css:198-199; item.js:614-621 | Two-row bar at most: Send split button and Save on one row; Save & redraft, Mark done and the rest in an overflow sheet; safe-area padding. |
| M-29 | Ready to send (2220, voicemail) | Send gate: the recipient under "Send now" is truncated ("voicemail@hip...", button 156x44, two lines at 11 to 12px). The full address is only in the `title` tooltip, which never shows on touch, and in the confirm dialog. | B4 | hurts | walk (2220), 393-item-2211-reply-send-bar.jpg; components.css:109-111; item.js:592 | Sticky reply bar with a full-width recipient line above the buttons (wraps, never truncated), with Send on its own. |
| M-30 | Ready to send / Confirm recipient | Send gate: the recipient caret `summary.send-caret` is 29x44 and flush against Send (margin-left -1px, 0px gap), so a slightly-off tap hits Send (with its confirm) instead of "change recipient". | B3 | hurts | walk measurements; components.css:221-226 | Recipient line as its own 44px row above the bar (tap to change), separate from Send by at least 8px. |
| M-31 | Contact form / compose / return with no recipient (2222) | Send gate: the 157x44 "Confirm recipient / no recipient yet" block looks like the primary button but is a non-interactive span (`cursor:default`). Only the 29px caret beside it opens the recipient popover. | B3, B4 | hurts | 393-item-2222-top.jpg; components.css:231-234; item.js:596-597 | Make the whole recipient line the tap target that opens the recipient bottom sheet; keep Send disabled until confirmed. |
| M-32 | Any open item | Action bar: some information exists only in `title` tooltips, which never show on touch. The Save & redraft explanation was moved into a tooltip on purpose, as were the Mark done tip, the chip menu titles, the Filter and Sort labels and the Preview-doc title. | B5, B10 | hurts | item.js:592, 604, 610-611, 617; ui.js:564; inbox.js:437, 444; item.js:106 | Put the text on screen: one secondary line in the overflow sheet rows (as More actions already does) and a visible label on icon-only controls. |
| M-33 | Recipient popover, Other address expanded (2222) | Recipient popover: the popover opens at L65 R385 T521 B675, already 7px over the bar (T668). Expanding "Other address…" grows it to B727, so the email field and its Use address button sit on top of the Confirm recipient button. The positioner does not re-place on the nested fold's toggle, because it only listens for `details.menu` and `details.chipmenu`. | B5, B6 | hurts | 393-item-2222-recipient-popover.jpg, 393-item-2222-recipient-other-address-overlaps-bar.jpg; ui.js:768-772; item.js:573-580 | Recipient bottom sheet (full width, above the keyboard) with known addresses and Other address inline; no popover inside a popover. |
| M-34 | Recipient popover open | Recipient popover: the radios are 13x13, the `.cfopt` label rows are about 30px (5px padding), the "Other address…" summary is 302x22, and the list has a fixed `min-width:320px`. | B3 | hurts | 393-item-2222-recipient-popover.jpg; components.css:239-252 | Bottom sheet with 44px radio rows (the whole row is the target) and a 16px email field. |
| M-35 | More actions open | Menus: More actions opens upward as a fixed popover (L8 R378 T486 B662) that covers the bar's upper rows. Items are 50, 50 and 66px tall. It closes on a second tap of the summary or an outside tap, but there is no visible close. | B5 | cosmetic | 393-item-2222-more-actions-menu.jpg; ui.js:727-732, 754; item.js:605-609 | Bottom sheet with a visible Cancel row, same items and descriptions. |

### 3.4 Context pane

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-36 | Any item | The context pane (customer card, SAP documents, attach by number, "What Axle checked") stacks below everything: at 2,847px of 3,752 on 2211 (905px tall) and 2,648px on 2222. There is no tap-to-open from the conversation, and the sticky action bar has left the screen by the time it is reached. | B2 | blocks the task | 393-item-2211-context-pane-at-bottom.jpg; components.css:436-438; ui.js:896-899; item.js:964-968 | Context sheet: a "Customer and docs" button in the collapsed brief opens the context as a full-height bottom sheet or full-screen page with a visible back, one tap from the conversation. |
| M-37 | SAP documents with suggestions (2211) | Suggested-document Attach buttons carry the full document line (type, number, customer, amount, date) and wrap to two lines. The Preview link beside them is a 12px link with 3px padding, about 25px tall [height uncertain, not measured]. | B3 | hurts | 393-item-2211-context-pane-at-bottom.jpg; item.js:104-120; components.css:159-165 | Stacked list: each document as a row (type and number, then customer, amount and date as a secondary line), with a 44px Attach and a 44px Preview. |
| M-38 | SAP documents, attach by number | The document-number input has no `type` attribute, so it matches neither the 13px `input[type=text]` rule nor the 44px phone rule. It renders at the browser default size, like the audit inputs measured at 21px tall [uncertain: not measured on the item page]. `inputmode="numeric"` is present. | B3 | hurts | item.js:520; components.css:88, 454-455; walk (audit inputs 21px) | Add `type="text"` so it picks up the 16px and 44px phone rules, and keep `inputmode="numeric"`. |
| M-39 | Customer card (2211) | The customer card's fixed three-column grid squeezes the tiles, so labels and values wrap (for example "Sales - Standard"). | B1 | cosmetic | 393-item-2211-context-pane-at-bottom.jpg; components.css:170-173 | Stacked list of label/value rows, or two columns on the phone. |

### 3.5 Compose

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-40 | + New email open | Compose is a centred card (330x928 at 24,24) in a fixed overlay that scrolls internally, taller than the 852px viewport, with 24px side margins. It is not a sheet or a page, and there is no back. | B6 | hurts | 393-compose-modal-top.jpg; components.css:263-264; inbox.js:173-174 | Full-screen page with a visible back (Cancel) in a top bar, its own URL, and the queue kept underneath. |
| M-41 | + New email, bottom of form | Cancel, Draft and Send now sit at the bottom of the 928px card (y=768 only after scrolling the modal) and are not sticky. Send now is also under the FAB (M-03). | B4 | hurts | 393-compose-modal-bottom-fab-over-send.jpg; components.css:289-290; inbox.js:215-220 | Sticky reply bar at the bottom of the compose page (Draft, Send now) with safe-area padding; Cancel in the top bar. |
| M-42 | + New email | Small or crowded targets: the close `.modal-x` is 28x44; the quick-start chips are 44px tall but only 6px apart; the file input is 12px text and 20px tall. | B3 | cosmetic | 393-compose-modal-top.jpg; components.css:89, 267, 275-276 | 44x44 close in the top bar, a chip row with 8px gaps, and a 44px "Add files" button in place of the bare file input. |
| M-43 | + New email opened | `openM()` focuses `#who` straight away, so on iOS the keyboard opens and the 13px field zooms before the rep has seen the form [uncertain on device]. | B3, B9 | cosmetic | inbox.js:232 | No autofocus on the phone; let the rep tap the first field. |

### 3.6 Customer modal

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-44 | View full customer (2211) | The native `<dialog>` is a centred card (346x551 at 16,150, max-height 86vh, internal scroll) with a 23x44 close. The tables fit (300px). Once the context pane becomes a sheet (M-36), this dialog would open on top of that sheet, which the bar forbids. | B6, B3 | hurts | 393-item-2211-customer-modal.jpg; components.css:178-183; item.js:184-191 | Full-screen page pushed from the context sheet, with a visible back and a 44x44 close; no dialog on top of a sheet. |

### 3.7 Block page

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-45 | /item/2211/block | The page fits (scrollWidth 393) and the primary button is 189x44, but the "#2211" back link is 51x17 and Cancel is 38x17. It is a standalone page with no sticky back bar. | B3, B2 | hurts | 393-block-page.jpg; admin.js:47, 53-56 | Reuse the `.m-back` sticky back bar, and make Cancel a 44px secondary button next to the primary. |

### 3.8 Admin pages

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-46 | /blocks, /audit | Horizontal page scroll: the /blocks table is 650px wide (scrollWidth 666, 63 rows) and the /audit table is 717px wide (scrollWidth 733). Plain `<table>` with no wrapper or responsive treatment. | B2 | hurts | 393-audit-horizontal-scroll.jpg; walk (/blocks, no screenshot); admin.js:129, 184; components.css:28-30 | Stacked list: one card per block or audit row (sender and when / action and item, detail below), with the Unblock button at 44px. |
| M-47 | /audit | 500 rows in one page, 39,891px tall, with no pagination. | B8 | hurts | 393-audit-horizontal-scroll.jpg; admin.js:169 | Paginate (50 per page) with the existing filters. |
| M-48 | /audit, /blocks | Small targets: the audit filter inputs are 21px tall at 13.3px (no `type`, inline widths 18em and 6em), and the item links in both tables are 36x17. `inputmode="numeric"` on the item number is correct. | B3 | hurts | 393-audit-horizontal-scroll.jpg; admin.js:121, 174-177, 180 | 16px inputs at 44px with `type` set; the whole list row is the link. |

### 3.9 Sprocket

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-49 | Sprocket panel open, 393 | The panel is an absolutely positioned card (361x560 at 18,214) with the FAB still visible below it, not a sheet. The close is 22x20, send is 38x38 and the textarea is 13px and 38px tall; `min-height:0` opts both buttons out of the 44px rule. | B6, B3 | hurts | 393-sprocket-panel.jpg; components.css:471-473, 482, 492-496, 501 | Full-height bottom sheet with a 44x44 close, 44x44 send and a 16px auto-growing input; FAB hidden while open. |
| M-50 | Sprocket in use | Return always sends (Enter without Shift), and a phone keyboard has no Shift+Return, so a multi-line question cannot be typed. The transcript is held only in the page, so any full page load (including Back to the list, M-17) wipes it. | B3, B9 | cosmetic | ui.js:676, 680-686 | Return inserts a new line on touch devices, with an explicit send button; keep the transcript in sessionStorage. |

### 3.10 Liveness and loading

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-51 | Card tap or item poll fails | A failed item load is invisible on the phone. The htmx error handler and the server's pane-shaped 500 both write into `#workpane` without the `has-item` marker, so `#workpane` stays `display:none`. The card spinner clears and nothing happens. Code-only. | B7 | hurts | ui.js:782-791; server.js:552-553; components.css:442-444 | Error state rendered as a detail screen (with a back bar and Retry), reusing the list-to-detail pattern. |
| M-52 | Tapping a queue card on 4G | The dimmed work-pane overlay and centred spinner cannot show on the phone because `#workpane` is hidden until the item arrives. The only feedback is a 12px spinner in place of the card's timestamp, for up to the 60s htmx timeout. Code-only. | B7 | hurts | components.css:395-401, 442; ui.js:719, 798-808 | Switch to the detail screen immediately with a skeleton of the brief, thread and bar, then swap in the content without a layout shift. |
| M-53 | Customer modal, translations, uploads, busy banner | Loading states are spinners, not skeletons: "Loading…" in the customer dialog, "Translating…", "Uploading…", the drafting banner spinner and the button lock spinner. Only the deep-link lazy queue has skeleton rows. | B7 | cosmetic | item.js:189, 735, 858; ui.js:626; components.css:392, 405-406, 411-414, 420 | Skeleton blocks sized to the final content (customer tiles, translation lines, attachment row). |
| M-54 | Queue on screen while sync or drafting runs | The poll replaces `#queuepane` innerHTML every 8 or 15s whenever focus is not in the pane. On the phone that is the visible list under the thumb, so cards can jump mid-scroll and the chrome re-renders [uncertain: no sync ran during the walk]. | B7 | hurts | inbox.js:540-553 | Poll counts only and show a "N updated, tap to refresh" chip; never swap the list while it is scrolled or touched. |
| M-55 | Item in Drafting (investigating) | The busy poller swaps the whole `#workpane` every 10s. On the phone the body is the scroller, so each swap can reset or jump the reading position, and the final swap into the ready state inserts the reply, questions and action bar with no reserved space [uncertain: no item was in this state during the walk]. | B7 | hurts | item.js:735, 792, 978-982; components.css:431 | Keep the brief and thread fixed and update only a small status region (banner plus skeleton reply); swap the reply in place without shifting the thread. |

### 3.11 Draft persistence

| ID | State | What breaks | Bar rule | Severity | Evidence | Proposed pattern |
|---|---|---|---|---|---|---|
| M-56 | Editing a reply | No autosave or restore. The reply, feedback and subject exist only in the form until Save, Save & redraft, Send or an attachment upload. There is no localStorage or sessionStorage use for them and no `beforeunload`, `pagehide` or `visibilitychange` handler anywhere, so an iOS tab discard, a reload or a crash loses the text [device scenarios uncertain]. Code-only. | B9 | blocks the task | item.js:464-471, 490-496; grep across box-code | Autosave the draft locally per item (debounced, plus on `pagehide`), restore it on load with an "Unsaved draft restored" note, and clear it on a successful Save or Send. |
| M-57 | Editing a reply, then any side action | Side actions post their own forms and reload the item, dropping unsaved reply edits: Use address in the recipient popover (redirect after the update), the Language and Owner chip menus, and suggested or by-number Attach PDF. On contact-form items the natural order is write, then Confirm recipient, which is exactly the path that loses the text. Code-only. | B9 | blocks the task | item.js:111-120, 511-522, 567-579; ui.js:561-566; server.js:359-361 | Autosave draft (M-56) restored after the redirect; presentation-only, with no change to the recipient or attach routes. |
| M-58 | Editing a reply, tapping Back | The back bar leaves via `history.back()` with no unsaved-changes prompt, and the list then reloads (M-17). | B9 | hurts | ui.js:898 | Back keeps the autosaved draft (M-56) and shows a "Draft kept" note on the card. |
| M-59 | Compose open while sync or drafting runs | The compose modal's markup lives inside `#queuepane`. The queue poll replaces that pane whenever focus is not inside it (for example after the keyboard is dismissed, or after tapping a chip, since iOS does not focus buttons on tap), which wipes the half-written compose and closes the modal [uncertain: trigger not reproduced]. | B9 | blocks the task | inbox.js:172-173, 540-552, 557 | Move compose out of the polled pane into its own full-screen page (M-40), with local autosave of the instruction and subject. |

## 4. Findings that are code-only

These are certain from the code but were not visible in the walk. Each has a register row.

| Code-only finding | Register row | Evidence |
|---|---|---|
| No `env(safe-area-inset-*)` and no `viewport-fit=cover` anywhere | M-04 | components.css (whole file); ui.js:714 |
| Viewport units: `100vh` applies to the body on desktop only (overridden below 1100px). On the phone, 86vh, 75vh, 60vh and the positioner's 100vh / `innerHeight` clamp apply; no `dvh` | M-05 | components.css:178, 309, 325, 431, 501; ui.js:749, 752 |
| Where the `:has()` dependency sits: without it the item never shows below 1100px (not "stacked panes") | M-07 | components.css:442-444 |
| No-JS popover fallback: absolute lists with 200, 290 and 320px min-widths | M-08 | components.css:65, 210, 239 |
| Unguarded resize JS on the phone: splitter IIFE, localStorage `axleQueueW`, scroll-driven popover re-placement | M-09 | ui.js:773-775, 844-866 |
| No img max-width: not a live risk in the current scope. Email bodies render as escaped text in `pre.mail`, and inline images become a text marker, so no `<img>` reaches the item page | none | ui.js:615-618, 624; components.css:132 |
| Queue query has no LIMIT, and each card embeds the email text in `data-search` | M-11 | inbox.js:92-95, 134-137 |
| Queue poll runs while the list is hidden or the tab is backgrounded | M-12 | inbox.js:539-553 |
| Back to list is a full reload (history cache size 0) | M-17 | ui.js:719, 898 |
| Deep-link Back can leave Axle | M-20 | ui.js:898 |
| "Confirm recipient" label is a non-interactive span | M-31 | item.js:597; components.css:231-234 |
| Nested Other-address fold is not re-placed by the positioner | M-33 | ui.js:768-772 |
| Document-number input has no `type`, so it misses both the 13px and 44px rules | M-38 | item.js:520; components.css:88, 455 |
| Sprocket Return always sends; transcript lives only in the page | M-50 | ui.js:676, 680-686 |
| Failed item load invisible on the phone | M-51 | ui.js:782-791; server.js:553 |
| Card-tap loading overlay hidden on the phone | M-52 | components.css:400-401, 442 |
| No autosave, no `beforeunload`, `pagehide` or `visibilitychange` | M-56 | grep across box-code |
| Side-action forms discard unsaved reply edits | M-57 | item.js:567-579; server.js:359-361 |
| Compose markup inside the polled queue pane | M-59 | inbox.js:540-557 |

## 5. Could not determine without a real device

- The iOS Safari bottom toolbar and home indicator against the sticky action bar, the back bar, the queue toolbar and the FAB (no safe-area handling in the code, M-04).
- Keyboard behaviour: whether the sticky action bar stays above the keyboard or gets pushed when the reply textarea has focus, and whether the fixed recipient popover (clamped against `innerHeight`, not `visualViewport`) leaves the Other-address field under the keyboard (M-33).
- iOS focus zoom on the 12 to 13px fields and how far the layout shifts (by rule iOS zooms below 16px, M-06).
- Whether iOS Safari fires the document-level outside-click handler when the user taps non-interactive content, which is what closes chip, filter, overflow and recipient menus (ui.js:727-732).
- Draft survival across rotation, tab switch, iOS tab discard and background/resume. The code has no autosave (M-56); rotation alone keeps the textarea in the DOM, but was not exercised.
- Whether the queue poll actually wipes an open compose on a phone (M-59), and whether it jumps a scrolled list (M-54). No sync or drafting ran during the walk.
- The staleness banner, the Drafting (investigating) banner and the busy-poll swap (M-55): no item was in those states. The "research step stream" the bar expects is not a shipped feature (no SSE; the roadmap parked SSE liveness at UI rework Step 4), so there is nothing on desktop or the phone to assess [uncertain what Brad means by it].
- The return, claim and forward flows (owner-chip confirm dialogs) and the contact-form recipient picker beyond item 2222: no open item was in those states.
- NL language fit of the action bar, chips and the Send / Confirm recipient labels (strings are about 20% longer). Not switched, because it changes Brad's live UI language.
- Preview-doc and inbound attachment links on the phone (`target="_blank"`: whether PDFs open in-tab or in a new tab, and the way back).
- Which iOS versions the reps run, given the `:has()` dependency (M-07; supported from iOS Safari 15.4).
- Whether Back to the list restores the list scroll position after the full reload (M-17), and whether an item opened from a scrolled list starts at its top (M-18).
- The cause of the 9px phantom scroll on the queue at 852 (M-05).

## 6. Out of scope for this register

**Safety paths untouched.** Every proposed pattern is presentation-only. None of the following is to be changed by the mobile work, and the recipient and attach routes keep their current behaviour:

- send-guard.js
- send.js
- resolve-customer.js
- engine.js send and recipient logic
- Identity and CSRF middleware
- ACTION_* allow-list checks and the AXLE_ACTION_* environment gates
- The send confirmation step (`data-confirm` read as data, ui.js:868-886) and the recipient route `setRecipient` (server.js:318-364), including the typed-address screen

**Desktop density observations (not mobile findings).**

- At 1440 the desktop controls are all below 44px (header links 26, segments 28 to 30, queue tabs 32, search 29, sort 30, Sync 25, back link 16, chip summaries 24). This is a desktop density choice; the phone media query lifts most of it.
- The JS splitter floor (MIN 220px, ui.js:845) disagrees with the CSS clamp floor (290px, components.css:312).
- There is no ESC handler for chip, filter, overflow or recipient menus. The custom overlays have no focus trap, and compose declares `aria-modal` without enforcing it (inventory B section 7).
- Dismissal is inconsistent between modals: compose refuses a backdrop click on purpose (inbox.js:237-238), while the customer dialog closes on one (item.js:190).
- No `-webkit-overflow-scrolling`. This does not matter on current iOS.
- The action bar is hidden entirely while an item is drafting (item.js:612), the same as on desktop.
- The 15px Windows scrollbar inside the emulation frame is an artefact of the method, not a finding.
