# Axle: Mobile Plan, September 2026

Date: 25 Sep 2026

## 1. Purpose, sources and binding decisions

This plan takes Axle from "a desktop tool that collapses to one column" to a phone tool that Brad and the reps can use one-handed on an iPhone for the whole daily loop (triage, answer, edit, confirm the recipient, send, close, compose, forward), without changing a single safety path and without moving the desktop by one pixel at 1440. It closes or explicitly defers all 59 findings in the gap register, orders the work lowest risk first in six gated phases (0, 1A, 1B, 2, 3, 4), names every route or partial contract change for Brad's explicit OK, and ends in one deploy, a runbook verification, a live proof on a compose draft Brad names, and a handover test script. Everything is built on the locked stack (Express, template literals, HTMX 2.0.10, no bundler) and the existing design system in `tokens.css` and `components.css`.

Sources:

- Gap register: [Mobile Gap Register, 24 Sep 2026](Axle%20%E2%80%94%20Mobile%20Gap%20Register%20%E2%80%94%202026-09.md) (M-01 to M-59, evidence with file:line).
- Signed-off phone mock: [design-reference/axle-m1-mobile.html](design-reference/axle-m1-mobile.html) (app bar, sheet, chip row, recipient line, bottom bar, folds, skeleton, error, compose, context sheet, customer page).
- Previous responsive pass: [design-reference/retheme-log.md](design-reference/retheme-log.md) (the `:has()` list-to-detail flow, headless Chromium walk against the stubbed real server).
- Deploy: [DEPLOY.md](DEPLOY.md), [deploy.ps1](deploy.ps1), and the [Server runbook](Axle%20%E2%80%94%20Server%20runbook.md) (verification steps 5 and 6).

Binding decisions (Brad, 24 Sep 2026), condensed:

1. First-class on the phone: triage, answer questions, edit reply, confirm recipient, send, close, compose, forward, return and claim handling. Admin pages (Blocked, Audit, Sprocket requests) get a horizontal-scroll wrapper and a "Best on desktop" note only. Sprocket is hidden entirely on the phone.
2. Navigation: list, then conversation (full screen, back bar), then the context pane as a full-height bottom sheet opened from a "Customer & docs" button in the collapsed brief. The customer modal becomes a full-screen page pushed from the context sheet.
3. Item bottom bar: row 1 recipient line (full address, never truncated, tap opens the recipient sheet; amber "Confirm recipient: no recipient yet" when unconfirmed, Send disabled); row 2 Send (keeps its confirm step via the unchanged `data-confirm` mechanism) plus a "..." overflow sheet (Save & redraft, Mark done, Resolved by phone, Archive, Block sender, forward/return/claim where they apply). Save leaves the bar; autosave replaces it.
4. Liveness: HTMX polling stays, with visible states (skeleton on card tap, error screen with Retry, Drafting banner with skeleton reply); the poll pauses while the list is hidden, scrolled or touched and never swaps a touched list. SSE stays parked.
5. Reply editor: inline, auto-growing, 16px, no inner scroll; the bottom bar tracks the visual viewport when the keyboard is up.
6. Draft safety: client-side autosave to localStorage per item (reply, subject, feedback), debounced and on `pagehide`, restored with an "Unsaved edits restored" note, cleared after a successful Save, Save & redraft or Send. No server route.
7. Queue: one sticky control row (segmented tabs with counts, search icon revealing a 16px field), Filters sheet (mailbox, sort, Mine/All, Sync now), New email as a bottom-right button, tabs swap only the list fragment, Done and All paginated 50 per page with Load more (a `page` parameter on `/queue`, a route-contract change in the route phase), empty state with Clear search.
8. Compose stays a modal: full screen on the phone, 16px inputs, sticky Cancel / Draft / Send now row, 44px close, markup moved out of the polled `#queuepane`.
9. Header: 48px app bar plus a menu sheet (Inbox, Blocked, Audit, Requests, EN/NL, user). Item app bar is back chevron plus title. Chips in a horizontally scrolling 44px chip row; Language and Owner open sheets.
10. Item order is state-driven: Needs answer = open questions, reply, customer email folded to 12 lines, older messages folded; Ready = reply, questions collapsed, email. Contact-form items show the parsed customer block above the folded raw mail.
11. Device floor iOS 16+; keep `:has()` and add a server-set class so the detail screen does not depend on `:has()` alone.
12. One deploy at the end of all phases. Each phase is committed, not deployed. Live proof after that deploy on a compose draft to admin@budget-parts.nl that Brad names then; every send ends at Draft; no real customer item is touched. Phase gate = Brad's screenshot review plus the harness walk; the real-iPhone check is batched at the end unless Brad asks earlier.
13. Hard limits: no file deletions, no new dependencies, no SQLite schema change, no `.env` or secrets, no change to send-guard.js, send.js, `pickRecipient` in resolve-customer.js, route-level send refusals, the injection interlock, allow-list env checks, audit calls, rules.js. Presentation, layout and transport only. Every route or partial contract change is named and gated. No new features, no refactors, no reopening the locked UI-rework decisions.
14. Responsive strategy: media queries and shared primitives in `components.css`, one phone breakpoint, no duplicated mobile templates unless argued.
15. Every asset change bumps `ASSET_V` in `views/ui.js` (currently "polaris14", ui.js:703); new files need `-IncludeNew`; plain ASCII file names.
16. Writing rules: no em or en dashes, British English, dates as 25 Sep 2026.

Subagents: per the mobile kickoff model rules, every build subagent is launched with an explicit `model` of `sonnet` or `opus` (named per phase below); never without a model and never on fable.

## 2. Scope

### 2.1 In scope

- Every screen reachable from the phone: queue (all tabs, filters, search, empty), item in every state (new, needs answer, ready, drafting, done, archived, injection-flagged, contact form, return notification, compose item, carrier-claim items with staged documents), the recipient, language, owner and overflow menus, the context pane, the customer detail, compose, the block page, error and loading states.
- Admin pages (Blocked, Audit, Sprocket requests): contained horizontal scroll plus a "Best on desktop" note, nothing more.
- Transport changes limited to: queue pagination and fragment tabs, compose markup relocation, detail-shaped error fragments, a server-set detail class, client-side poll pause rules, an in-app Back that does not reload.
- New UI strings in `STRINGS` (EN and NL, parity kept, ui.js:19-396).

Finding about decision 1: "return" and "claim handling" need no extra phone action. Return-notification items are handled through the recipient line (the same `recipPop`, item.js:562-582); carrier claims stage their documents during ingest or Save & redraft (shared.js:351) and show up as ordinary staged attachments and SAP documents. "Forward" is the owner handover (the Owner chip options that carry a `data-confirm`, item.js:386-401), which Phase 2 mirrors into the overflow sheet.

### 2.2 Out of scope

- The desktop layout above 1100px (it must stay pixel-equivalent; see 4.2), including the desktop density observations in register section 6.
- Any change to the send path, recipient validation, allow-list gates, audit call text, injection interlock, rules, or the SQLite schema.
- New routes, new endpoints, SSE, service workers, PWA or "add to home screen" behaviour.
- Autosave on desktop widths (see open question Q2; one-line widening later if wanted).
- Tablet-specific layouts between 601 and 1100px (they get the phone layout; see 3.0).

### 2.3 Named deferrals

| # | Deferral | Why deferred | Register IDs left open |
|---|---|---|---|
| D1 | SSE research step stream | SSE is parked (decision 4); the "step stream" is not a shipped feature (register section 5) | none |
| D2 | Server-side autosave (draft sync across devices) | Decision 6: local only, no server route. A phone draft stays on that phone until Send, Save or Save & redraft | none (M-56, M-57 close locally) |
| D3 | Admin stacked cards and audit pagination | Decision 1: admin gets the wrapper and note only | M-47 (audit 500 rows, no pagination), M-48 (36x17 row links; the audit inputs are lifted to 16px/44px incidentally by Phase 0) |
| D4 | Sprocket on the phone | Decision 1: hidden entirely, no FAB, no panel | M-49 (panel not a sheet), M-50 (Return always sends, transcript not kept) |
| D5 | NL wording sweep beyond parity checks | Phase 4 checks key parity and fit only | none |
| D6 | Queue count/delta endpoint for polling | Decision 4 keeps HTMX polling; pagination plus pause rules remove the cost that M-12 describes | none (M-12 closes in Phase 3) |
| D7 | Compose autosave (instruction, subject) | Decision 6 covers item fields; the relocation in Phase 3 removes the poll wipe that made it urgent | none (M-59 closes in Phase 3) |
| D8 | Archived tab pagination | Decision 7 names Done and All; Archived holds 78 today | none |
| D9 | History-aware sheets (iOS edge-swipe closes a sheet) | Needs `pushState` per sheet, which collides with htmx's `historyCacheSize: 0` reload on popstate (ui.js:719); see 3.6 | none; residual noted under M-17 |
| D10 | Desktop density fixes (register section 6) | Desktop is out of scope | not register IDs |

## 3. Build approach and phases

### 3.0 Responsive strategy: one breakpoint at 1100px

Axle keeps its single existing breakpoint, `@media (max-width: 1100px)` (components.css:430), as the one phone breakpoint, and adds no 600px tier. The single-column list-to-detail flow already starts at 1100px, and every register defect lives anywhere inside that flow: the three-row action bar, the recipient popover climbing over the bar and the `vh` heights are the same at 700px as at 393px. A 600px tier would create a third layout (601 to 1100px) that keeps every one of those defects and doubles the verification matrix, while the phone primitives themselves (full-width sheets, a full-width bottom bar, a 48px app bar, 16px inputs) are width-agnostic and read correctly on a tablet or a narrow desktop window. The one cost is that a desktop window narrower than 1101px loses Sprocket and gets touch-sized controls; that is accepted and noted. The Sprocket-only 600px query (components.css:499-502) becomes unreachable once Sprocket is hidden at 1100px and is left in place (no deletions). JavaScript uses one media test, defined once in the `page()` script as `window.__axPhone = matchMedia("(max-width: 1100px)")`, so CSS and JS agree on what "phone" means.

No duplicated mobile templates. Every phone surface is the existing partial restyled inside the 1100px block, plus a small number of phone-only fragments that are hidden above 1100px by one utility pair (`.m-only` hidden on desktop, `.m-hide` hidden on the phone, both defined in Phase 1A). Each fragment is rendered by the same function, from the same variables, as the control it mirrors, so there is no second source of truth: the app-menu links (ui.js:722-723), the Filters sheet extras (Mine/All links, a sort select that drives `#qsort`, a Sync form posting the same `/sync`), the recipient-line text inside the existing recipient `summary`, the overflow mirror rows (Save & redraft, Mark done, Save, owner handover rows carrying the same `data-confirm`), back bars, the "Customer & docs" link, the "Show full message" toggle, a disabled Send placeholder, and skeletons. The one partial that was a candidate for a full phone copy is the action bar (item.js:612-621); it is adapted in place with CSS grid and `display: contents` on the `.send-split` span (3.5), so no copy is needed.

Two CSS rules of thumb for the builders: a selector list containing `:has()` is dropped whole by a browser that does not support `:has()`, so every `:has()` rule and its `body.ax-detail` twin (Phase 3) live in separate rule blocks; and every new fixed or sticky element carries its `env(safe-area-inset-*)` padding from birth.

### 3.1 Shared primitives (built once, reused by every phase)

| Primitive | Where | Built in | Notes |
|---|---|---|---|
| Phone tokens `--tap` 44px, `--gap-tap` 8px, `--fs-input` 16px, `--scrim`, `--bar-h` 48px, `--kb` 0px | tokens.css `:root` (8-58) | P0 | No desktop effect: nothing above 1100px reads them |
| `.m-only` / `.m-hide` | components.css | P1A | The only mechanism for phone-only markup |
| Sheet | components.css phone block, applied to every open `details.menu > .menu-list` and `details.chipmenu > .chipmenu-list` | P1A | Fixed, full width, anchored to `bottom: var(--kb)`, `max-height: calc(100dvh - var(--bar-h) - env(safe-area-inset-top))`, internal scroll, grab handle, safe-area bottom padding. The scrim is the open `summary::before` (fixed, inset 0), so a tap on the scrim is a native summary toggle: closing never depends on JS or on iOS dispatching the document click (register section 5, fourth bullet). A delegated `[data-close]` handler closes the nearest `details` for visible Close / Cancel rows |
| App bar | components.css + ui.js header | P1A | 48px, brand plus menu button on list and admin screens; back chevron plus title on the item screen |
| Chip row | components.css | P1B | One line, horizontal scroll, 44px hit areas, 8px gaps, caret always visible |
| Fold row | components.css | P1B | Every `details > summary` on item and context screens at 44px with a chevron |
| Bottom bar | components.css | P2 | Fixed, two rows, `bottom: var(--kb)`, safe-area padding |
| `--kb` tracker | ui.js `page()` script | P2 | `visualViewport` resize and scroll -> `--kb = innerHeight - (vv.height + vv.offsetTop)` |
| Skeleton `.sk` | components.css | P4 | Generalises the existing `.qskel` shimmer (components.css:412-414) |

Stacking contexts matter for the sheet: `.queue-head` (z-index 10, components.css:329) and `.actionbar` (z-index 30, components.css:198) are sticky and positioned, so a sheet opened inside them can never rise above their own context. The fix is `.queue-head:has(details[open])`, `.actionbar:has(details[open])` and `header:has(details[open])` raising that container's z-index above the app bar while a sheet is open; without `:has()` the only loss is an undimmed app bar.

### 3.2 Why the phase split differs from the brief

- Phase 1 is split into 1A (shell chrome, the sheet primitive, queue chrome, admin and block pages) and 1B (item brief, order, folds, context sheet, customer page). Together they close 22 findings across two unrelated surfaces; two gates give Brad two reviewable screenshot sets.
- The sheet primitive converts every `details` menu in 1A, including the Language and Owner chip menus, the recipient popover and More actions. The conversion is one CSS rule set plus the positioner guard; converting only the filter menu would leave the JS positioner placing the other three at phone width, which is M-09 itself. So M-34 and M-35 close in 1A, and the Language and Owner sheets exist from 1A (M-21 closes in 1B with the chip row).
- M-33 moves to Phase 2: after 1A its only remaining defect is placement above the keyboard, which needs the `--kb` tracker.
- M-15 (search empty state) lands in 1A because the queue search script (inbox.js:461-477) is edited there anyway.
- The in-app Back (M-17, M-18, M-20) sits in Phase 3 because it touches history and htmx swaps.

### 3.3 Phase 0: tokens, safe areas, dvh, 16px inputs, Sprocket off the phone

**Goal.** Remove the platform-level defects with CSS, before any layout moves: no focus zoom, no controls in the home-indicator zone, no `vh` surprises, no Sprocket FAB over the action bar or compose.

**Register IDs closed (5).** M-03, M-04, M-05, M-06, M-38.

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/assets/tokens.css | `:root` (8-58) | Add the phone tokens from 3.1 |
| box-code/assets/components.css | `.cusdialog` (178), `.empty-state` (325), `.sprocket-panel` (471-472, 501) | `vh` line kept first as fallback, `dvh` line after it (desktop browsers resolve both identically) |
| box-code/assets/components.css | phone block (430-459) | 16px and 44px min-height for every text-like `input` (including no `type`, `type=email`), `select`, `textarea`, `.instr-editor`; `::file-selector-button` 44px; `env(safe-area-inset-*)` on `header` (18), `.m-back` (447), `.queue-head` (329), `.actionbar` bottom offset (198), `.modal` padding (263); `.sprocket { display: none }` |
| box-code/views/ui.js | 714 | `viewport-fit=cover` added to the viewport meta |
| box-code/views/ui.js | 703 | `ASSET_V = "polaris15"` |

**Approach.** All rules live inside the 1100px block. The 16px rule uses `input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden])`, which also catches the attach-by-number input that has no `type` (item.js:520): M-38 closes without adding `type="text"`, which would have pulled the desktop `input[type=text]` padding (components.css:88) onto that field at 1440. `.instr-editor` is included because iOS zooms contenteditable fields too. Safe areas use `max(<current padding>, env(...))` so the value is unchanged when the inset is 0. The positioner's `100vh` clamp in JS (ui.js:749) is not edited here: from Phase 1A the positioner does not run at phone width (M-09), which retires that part of M-05. The 9px phantom scroll (M-05) is traced with the headless walk (compare `scrollHeight` to the lowest visible box) and fixed here if it is CSS; if it is not, the cause is recorded in the phase report.

**Contract changes.** None.

**Subagent model.** sonnet.

**ASSET_V / -IncludeNew.** `polaris15`. No new files.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393, 375, 430 | On `/`, `/item/<needs-answer>`, `/item/<contact-form>`, `/item/<ready>`, compose open, `/audit`, `/blocks`: the list of visible `input` (text-like), `select`, `textarea`, `[contenteditable]` with computed font-size below 16px is empty |
| 393, 375 | Attach-by-number input: font-size 16px, height at least 44px |
| 393, 375 | `#sprocket` computed `display: none`; no fixed element intersects `.actionbar` or `.modal-foot` |
| 393, 375 | `meta[name=viewport]` content contains `viewport-fit=cover`; the rules for header, `.m-back`, `.queue-head`, `.actionbar`, `.modal` contain `env(safe-area-inset-` (static check; emulation reports 0) |
| 393 | `.cusdialog` computed max-height equals 86% of `innerHeight`; no `vh` left in the four rules above except the fallback lines |
| 393 | Queue: `documentElement.scrollHeight` minus the bottom of the lowest visible box is no more than `main`'s bottom padding (the 9px surplus is gone or its cause is recorded) |
| 393, 375 | `documentElement.scrollWidth` equals the viewport width on every page walked |
| 1440, 1101 | Pixel and layout diff against the pre-Phase-0 baseline is empty (4.2) |

**Test proof.** Proof kit K1 to K7 (4.4). Specific: the font-size audit and the safe-area static grep above, saved to `design-reference/mobile-audit/phase-0/`.

**Rollback.** `git revert` of the Phase 0 commit; CSS, one meta attribute and `ASSET_V` only; no data involved.

### 3.4 Phase 1A: shell chrome, sheet primitive, queue chrome, admin and block pages

**Goal.** A 48px app bar with a menu sheet on every page, every menu as a bottom sheet, the queue chrome collapsed from 338px to about 158px (app bar plus sticky block), and admin and block pages that never scroll sideways.

**Register IDs closed (12).** M-01, M-02, M-08, M-09, M-10, M-13, M-14, M-15, M-34, M-35, M-45, M-46.

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/views/ui.js | `page()` header (722-723) | Phone-only `details.menu.appmenu` with a menu `summary` (44x44) and a sheet: Inbox, Blocked, Audit and Requests (admin, with the existing `hbadge`), EN/NL as two 44px segments linking to the same `/setlang`, "Signed in as". Existing desktop links wrapped in nothing new; they are hidden on the phone by CSS |
| box-code/views/ui.js | `page()` script: positioner (741-776), splitter (844-866) | Both return early when `window.__axPhone.matches`; on a media change the positioner clears its inline styles (`clear()`, 763-767). New delegated `[data-close]` handler |
| box-code/views/ui.js | `page()` signature (710) | Optional `opts.desktopNote` renders a phone-only "Best on desktop" banner at the top of `main` |
| box-code/views/ui.js | `chipMenu()` (561-566) | Phone-only sheet heading (the existing `title` text, so M-32's chip tooltip becomes visible) and a phone-only Cancel row (`type=button`, so the chip form never submits from it) |
| box-code/views/ui.js | `STRINGS` en/nl | New keys: menu, close, cancel, filters, sort, sync (label in sheet), signed_in_as, no_matches (with `{q}`), clear_search, best_on_desktop, search_open |
| box-code/views/ui.js | 703 | `ASSET_V = "polaris16"` |
| box-code/routes/inbox.js | `paneHtml` (430-459) | Phone-only search toggle button as the last child of `.qtabs`; phone-only rows inside the existing filter `.menu-list` (438): Mine/All links (same `scopeLink`), a sort select mirroring the four `#qsort` options, a Sync form posting `/sync` with the same disabled state; class hooks on the rows; phone-only `.qempty-search` row container |
| box-code/routes/inbox.js | search/sort script (461-502) | Toggle opens the search row and focuses `#q`; zero matches shows "No matches for 'x'" plus a 44px Clear search button (phone-only by CSS); the mirror select sets `#qsort` and dispatches `change` |
| box-code/routes/item.js | `recipPop` (562-582), `closeMenu` (605-609) | Phone-only sheet heading ("Send to", "More actions") and Cancel row. No change to forms, fields, values or routes |
| box-code/routes/admin.js | block page (46-58) | Phone-only `.m-back` bar linking `/item/:id`; the old back paragraph gets `.m-hide`; the Cancel link gets a class styled as a 44px secondary button on the phone only |
| box-code/routes/admin.js | `/blocks` table (129), `/audit` table (184) | Wrapped in `div.hscroll` (no desktop rules, so pixel-neutral at 1440); `desktopNote: true` |
| box-code/routes/sprocket.js | `/sprocket/requests` (119) | `desktopNote: true` (no table on this page, note only) |
| box-code/assets/components.css | phone block and new phone rules | `.m-only`/`.m-hide`; app bar (header sticky, 48px, links and `.who` hidden, `.appmenu` shown); sheet primitive and scrim; `:has(details[open])` z-index lifts; queue chrome (below); FAB; queue cards per the M1 mock (12px radius, 8px gaps); `.hscroll` (overflow-x auto) and the desktop note banner |

**Approach.** The sheet primitive is described in 3.1. The queue head keeps its markup order and becomes a CSS grid on the phone: the first `.qbar` (compose, Mine/All, spacer, filter) gets `display: contents` so its children join the grid; the compose button becomes `position: fixed` bottom-right (56px tall, 16px from the right, `16px + env(safe-area-inset-bottom)` from the bottom, so it leaves the grid flow); Mine/All and the spacer are hidden (they live in the Filters sheet); the filter `details` sits at the end of the live row as the "Filters" button. The result follows the M1 mock: one sticky control row (four tabs, each with label and count on two lines, plus the 44x44 search icon) and a slim live line (dot, "Live · updated hh:mm", Filters). The search row (`#q`, `#qsort`, `#qcount`) is hidden until the search icon opens it; `#qsort` and `#qcount` stay hidden on the phone (sort is in the Filters sheet, the count is replaced by the empty state). The live line's own Sync button is hidden on the phone (Sync is in the sheet). The list gets bottom padding of `56px + 32px + env(safe-area-inset-bottom)` so the last card clears the New email button. The admin wrapper only contains the table's overflow; stacked cards stay deferred (D3). Tabs stay plain links in this phase; they become fragment swaps in Phase 3.

**Contract changes.** None. Markup additions only; every form keeps its action, method, field names and values; tabs, filters and the queue fragment keep their URLs.

**Subagent model.** opus for the sheet primitive, the positioner and splitter guard, and the queue chrome grid; sonnet for admin and block pages, strings and card styling.

**ASSET_V / -IncludeNew.** `polaris16`. No new files.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393, 375 | App bar: `header` height 48px (plus inset), one row; menu button 44x44; nav links and `.who` have zero-size boxes |
| 393, 375 | Menu sheet: rows at least 44px tall and `viewport - 32px` wide; EN and NL each at least 44x44 with at least 8px between them; user line visible; scrim covers the viewport; a tap on the scrim closes it; the Close row closes it |
| 393 | Queue sticky block (tab row plus live line) at most 112px; first card top at most 172px from the page top (was 338px) |
| 375 | Each tab at least 44x44; gaps between tabs, search icon and Filters at least 8px |
| 393, 375 | Search icon opens a 16px field at least 44px tall and focuses it; "zzqqxx" shows "No matches for 'zzqqxx'" and a Clear search button at least 44px; Clear restores every card |
| 393, 375 | Filters sheet holds Mailbox, Mine/All, Sort (four options), Sync now; every row at least 44px; choosing a sort reorders the list exactly as `#qsort` does at 1440 |
| 393, 375 | New email button: fixed, 56px tall, right edge 16px from the viewport edge; scrolled to the bottom, it does not intersect the last card |
| 393, 375 | Every open `details` list (app menu, Filters, Language, Owner, recipient, More actions): left 0, right = viewport width, bottom = `innerHeight`; `list.style.position` is empty (the JS positioner did not run) |
| 393, 375 | Recipient sheet: each radio row at least 44px, radio at least 20px, the Other-address field 16px and at least 44px, sheet width = viewport (no 320px min-width) |
| 393, 375 | More actions sheet: visible Cancel row at least 44px that closes it |
| 393, 375 | `/blocks`, `/audit`: `documentElement.scrollWidth` = viewport width; the table scrolls inside `.hscroll`; "Best on desktop" visible; `/sprocket/requests` shows the note |
| 393, 375 | Block page: sticky back bar at least 44px at the top linking `/item/:id`; Cancel at least 44px tall; primary and Cancel at least 8px apart |
| 1440, 1101 | Pixel and layout diff empty; the desktop DOM diff shows only elements that compute to `display: none` and new class tokens (4.2) |

**Test proof.** Proof kit K1 to K7. Specific: the tap audit (4.4) on `/`, the Filters sheet, the menu sheet, `/blocks`, `/audit`, the block page; screenshots of every sheet open at 393 and 375 into `design-reference/mobile-audit/phase-1a/`.

**Rollback.** `git revert` of the Phase 1A commit. The positioner guard reverts with it, so desktop behaviour is untouched either way.

### 3.5 Phase 1B: item brief, state-driven order, folds, context sheet, customer page

**Goal.** The conversation screen: a collapsed brief, the task the state calls for on the first screen, the customer email folded, and the context one tap away as a full-height sheet with the customer detail as a pushed page.

**Register IDs closed (10).** M-19, M-21, M-22, M-23, M-24, M-25, M-36, M-37, M-39, M-44.

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/views/ui.js | `workPanes()` (896-900) | Optional `opts.title`; the phone back bar becomes a 44x44 back link plus a two-line-clamped title (the bar is phone-only markup already). Phone-only "Back to email" bar as the first child of `.pane-context`, emitted only when `opts.back` is set |
| box-code/views/ui.js | `renderTimeline()` (612-635) | Phone-only "Show full message" toggle after the newest message's `pre.mail` |
| box-code/views/ui.js | `page()` script | Delegated handlers: fold toggle (adds `.open` on the message, swaps the label to "Show less"); context sheet open and close (`body.ax-ctx`), closed again on every `#workpane` swap; the toggle is hidden when the clamped `pre` does not overflow |
| box-code/views/ui.js | `STRINGS`, 703 | Keys: customer_docs, show_full, show_less, back_to_email, back_to_ctx. `ASSET_V = "polaris17"` |
| box-code/routes/item.js | `center` (727-741) | Phone-only "Customer & docs" link (`href="#ctx"`, `data-ctx-open`) after the chips row; the header-plus-email block wrapped in `div.m-mail` (a wrapper with no padding or border, so child margins still collapse through it at 1440) |
| box-code/routes/item.js | `#mq` script (742-790) | On a hit, also add `.open` to the clamped message |
| box-code/routes/item.js | `customerCard()` (167-193) | Phone-only "Back to Customer & docs" label inside the existing close button |
| box-code/routes/item.js | 968 | Pass `title: "#" + id + " " + subject` to `workPanes` |
| box-code/assets/components.css | phone rules | Header hidden on the detail screen (`body:has(#workpane .has-item) > header`), back bar as item app bar, `h2` hidden, chip row, flex order, fold clamp and fade, fold rows, attachment chips, context sheet, SAP document rows, customer grid, full-screen `.cusdialog` |

**Approach.** Order without new templates: on the phone `.pane-inner` becomes a flex column with `gap: 12px` and `.box` margins reset; the brief (from line, caller line, busy banner, "Customer & docs") keeps order 0, `#workform` gets order 1, `div.m-mail` order 2, the superseded draft order 3 and the action bar order 9. The work form already orders its own children by state (item.js:490-496): questions open first when `needsAnswers`, then reply and attachments; otherwise reply, attachments, then questions collapsed. That is decision 10 exactly, with the email moved after the form on the phone only. Contact-form and return items keep their parsed customer box directly above the email inside `div.m-mail`. The newest message's `pre.mail` is clamped to 12 lines (`max-height: calc(12 * 1.5em)`, fade mask); the older-messages fold (ui.js:631) and the legal-footer fold stay closed. Every `details > summary` on the item and context screens becomes a 44px full-width row with a chevron. Inbound attachments (`a.att`, ui.js:537-538) become 44px chips with 8px gaps, CSS only. The chip row is `flex-wrap: nowrap; overflow-x: auto` with 44px cells and the caret at full opacity.

The context sheet is `.pane-context` itself: hidden on the phone until `body.ax-ctx`, then `position: fixed; inset: 0` with its own scroll and the phone-only back bar. The link uses `href="#ctx"` so it also works without JS through `.pane-context:target`; with JS the handler calls `preventDefault()` and toggles the class, because a hash entry followed by Back would land on an htmx history entry and trigger a full reload (htmx 2.0.10 restores `{htmx: true}` states and misses the cache, ui.js:719). Inside, SAP document rows stack (Attach full width, wrapping, at least 44px; Preview a 44px button), the customer grid drops to two columns, and the attach-by-number form is already 16px from Phase 0. "View full customer" keeps its existing `showModal()` and `/item/:id/customer-modal` fetch (item.js:184-186, 1326-1339); on the phone `.cusdialog` fills the viewport (`inset: 0; width: 100vw; height: 100dvh; max-height: none; border-radius: 0`) with a sticky back bar built from the existing close form, so it reads as a page pushed over the sheet and returns to it on Back. It stays a `<dialog>` in the DOM; no card floats over the sheet, which is what decision 2 and the register's "no dialog on a sheet" rule protect against.

**Contract changes.** None. `workPanes()` gains an optional `title` used only by phone-only markup; the fragment shape (`.pane-center.has-item`, `.pane-context`) is unchanged; no route changes.

**Subagent model.** sonnet for the CSS, folds, chip row and customer page; opus for the context-sheet toggle (it must reset across `#workpane` swaps and must not create history entries).

**ASSET_V / -IncludeNew.** `polaris17`. No new files.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393, 375 | Item screen: global `header` not displayed; item app bar 48px (plus inset) with a 44x44 back link and a title of at most two lines |
| 393, 375 | Chip row: one line, height at most 52px, scrolls horizontally inside itself while `documentElement.scrollWidth` = viewport; every interactive chip at least 44px tall, at least 8px apart; caret opacity 1 |
| 393 | "Customer & docs" at least 44px, its top within the first 400px |
| 393 | Needs-answer fixture: top-to-bottom order is questions, reply, attachments, customer email; the questions card top at most 320px (was 1,472px); the reply card starts directly after the questions card |
| 393 | Ready fixture: reply card top at most 320px; questions collapsed below attachments; email after |
| 393, 375 | Long newest message: `pre.mail` height at most 12 line-heights; "Show full message" at least 44px; tap expands to the full `scrollHeight`; tap again collapses. Contact-form fixture: parsed customer box bottom is directly above the email card |
| 393, 375 | Every `summary` on the item and context screens at least 44px tall and full width |
| 393, 375 | Inbound attachment links each at least 44px tall with at least 8px between them |
| 393, 375 | Context sheet: rect (0, 0, viewport width, `innerHeight`); "Back to email" at least 44px; closing restores the conversation's `scrollY` within 2px; SAP Attach and Preview at least 44px and at least 8px apart; no `.cusval` wider than its tile |
| 393, 375 | Customer page: dialog rect equals the viewport; back bar at least 44px; Back returns to the open context sheet |
| 1440, 1101 | Pixel and layout diff empty; DOM diff limited to `display: none` elements, the `div.m-mail` wrapper and class tokens |

**Test proof.** Proof kit K1 to K7. Specific: order assertions on the needs-answer, ready, contact-form and compose fixtures; tap audit on the item screen, the context sheet and the customer page; screenshots into `design-reference/mobile-audit/phase-1b/`.

**Rollback.** `git revert` of the Phase 1B commit. No data involved.

### 3.6 Phase 2: reply editor, bottom bar, recipient line, overflow, autosave, keyboard

**Goal.** The thumb-zone bar and a reply that is never lost: two rows at most, the full recipient always visible before Send, every close action one sheet away, a 16px auto-growing editor, and local autosave that survives the recipient, language, owner and attach redirects.

**Register IDs closed (11).** M-26, M-27, M-28, M-29, M-30, M-31, M-32, M-33, M-56, M-57, M-58.

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/routes/item.js | `recipPop` summary (563-564) | Phone-only span inside the existing `summary.send-caret`: "To: <full address>" plus the source label (`srcLabel`, 547-548) and a "changed" tag when `redirected` (584); in the no-recipient branch the span reads "Confirm recipient: no recipient yet" (existing keys `recip_confirm_btn`, `recip_none_yet`) |
| box-code/routes/item.js | `sendBtn` needs-recipient branch (596-597) | Phone-only disabled Send placeholder (`type=button disabled`, no form, no route) |
| box-code/routes/item.js | `closeMenu` (605-609) | Label text wrapped in a span (hidden on the phone, so the summary shows "..." with an `aria-label`); phone-only mirror rows at the top: Save & redraft (`form="workform" name="action" value="redraft"`, secondary line = `redraft_hint`), Mark done (same form as 604, secondary line = `done_tip`), owner handover rows for each option with a forward target (same `/item/:id/owner` post and the same `data-confirm` from `ownerOption`, 386-394), Save (Q2) |
| box-code/routes/item.js | `actionBar` (612-621) | Class hooks only (`.actionbar.closed` for the reopen branch) |
| box-code/views/ui.js | `page()` script | Autosave singleton, auto-grow for `#replybox` and `textarea.ans` (phone only), the `--kb` tracker, the "Draft kept" marker on queue cards |
| box-code/views/ui.js | `STRINGS`, 703 | Keys: restored, restore_offer (with `{t}`), restore, discard, draft_kept, to_label, save_now. `ASSET_V = "polaris18"` |
| box-code/assets/components.css | phone rules | Bar grid, recipient line (normal and amber), Send full width, overflow two-line rows, editor, `--kb`, `.pane-inner` bottom reserve |

**Approach: the bar.** On the phone `.actionbar` becomes `position: fixed; left: 0; right: 0; bottom: var(--kb)` with `padding-bottom: calc(8px + env(safe-area-inset-bottom))` and a two-column grid (`minmax(0, 1fr) 44px`, gap 8px). `.send-split` gets `display: contents`, so its children join the grid: `details.recip-pop` spans row 1 (its summary styled as the full-width recipient line, text wrapping with `overflow-wrap: anywhere`, never truncated), the Send button or the disabled placeholder takes row 2 column 1 with the truncated `.send-to` span hidden, and the More actions `details` takes row 2 column 2 as a 44x44 "...". Direct-child Save, Save & redraft, the Mark done form, the spacer and `.recip-pill` are hidden (their functions are in the overflow sheet or the recipient line). Injection-flagged and send-not-enabled notes take row 1. The existing `.send-caret` rules use `!important` (components.css:223-228), so the phone overrides must too. `.pane-inner` reserves `bottom bar height + env(safe-area-inset-bottom) + 16px` so the last card clears the bar. The confirm step is untouched: the Send button keeps `data-confirm` and the capture handler at ui.js:880-886 is not edited (Q3 covers the mock's confirm sheet).

**Approach: editor and keyboard.** On the phone `#replybox` drops its 240px minimum and inner scroll (`resize: none; overflow: hidden`) and grows to its content on `input`, on restore and on load (height auto, then `scrollHeight`); `textarea.ans` does the same. `field-sizing: content` is not used because iOS Safari does not support it. The `--kb` tracker listens to `visualViewport` `resize` and `scroll` and sets `--kb` on `:root`; the bar and any open sheet sit at `bottom: var(--kb)`, so with the keyboard up the bar and the recipient sheet (M-33) sit directly above it.

**Approach: autosave.** Phone only (Q2). Key `axle.draft.<id>`, where `<id>` comes from `#workform`'s action (`/item/<id>/work`), so no template change is needed. The value holds reply, subject (whichever of `cf_subject`, `return_subject`, `compose_subject` is present, item.js:455-458), feedback, the server values at the moment editing started (`base`) and a timestamp. Writes are debounced (600ms) and flushed on `pagehide` and on `visibilitychange` to hidden; storage errors are swallowed. Restore runs on load and after every `#workpane` swap: if the stored `base` equals what the server rendered, the stored values are put back and an "Unsaved edits restored" note appears in the reply card; if the server text changed since (a redraft or another person's save), nothing is overwritten and the note offers Restore or Discard instead, so stale local text can never silently replace a newer draft. Clearing: a submit of `#workform` (Save, Save & redraft, Send) records a pending-clear marker in `sessionStorage`; on the next render of that same item the key is removed when the server text equals what was posted, or when the item is no longer editable (sent, done, drafting). A refused or failed send lands on a plain page without `#workform`, so nothing is cleared, and the draft comes back on the item. Side actions (recipient, language, owner, attach-doc) do not post the reply; after their redirect the stored text is restored because `base` still matches (M-57). Keys older than 14 days are pruned on load. Back keeps the draft, and each queue card with a stored draft gets a phone-only "Draft kept" tag after every queue render and swap (M-58).

**Contract changes.** None. No route, field name, form action or value changes; mirror rows post existing forms with identical attributes.

**Subagent model.** opus (reply editor, autosave, keyboard tracking, bar grid); sonnet for strings and the tap audit.

**ASSET_V / -IncludeNew.** `polaris18`. No new files.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393, 375 | Bar: fixed at the bottom, at most two rows; height at most 120px with a single-line address (was 174px); row 1 grows when an address wraps and its text is never clipped (`scrollWidth <= clientWidth`) |
| 393, 375 | Reading area between the item app bar and the bar at least 684px at 393 (was 503px) and at least 644px at 375 (was 473px) |
| 393, 375 | Recipient line and Send at least 8px apart; "..." is 44x44 and at least 8px from Send |
| 393, 375 | Contact-form fixture with no recipient: amber line reading "Confirm recipient: no recipient yet"; Send has `disabled`; tapping the line opens the recipient sheet |
| 393, 375 | Ready fixture: the line shows the complete address and its source; the Send tap raises the native confirm dialog with the same text as `data-confirm` at 1440; dismissing it sends no request |
| 393, 375 | Overflow sheet: Save & redraft, Mark done, Resolved by phone, Archive, Block sender (not on compose items), handover rows where a target exists, Save; each row at least 44px and shows its secondary line on screen |
| 393, 375 | `#replybox` and `textarea.ans`: font-size 16px, `resize: none`; after typing 40 lines `scrollHeight - clientHeight` at most 2 (no inner scroll) |
| 393 | Autosave: type, wait 1s: `localStorage["axle.draft.<id>"]` holds the text; reload: text back and "Unsaved edits restored" visible |
| 393 | Type, then confirm a recipient: after the redirect the typed text is back (M-57); same for a Language change on an inbound item, an Owner relabel and Attach PDF |
| 393 | Change the server draft in the fixture DB after typing, then reload: the server text shows and the Restore / Discard offer appears |
| 393 | Save & redraft and a stubbed Send: key removed after landing; a stubbed send refusal: key kept |
| 393 | Back after typing: the card for that item shows "Draft kept" |
| 393 | `--kb` handler, fed stubbed `visualViewport` values in the harness, sets `--kb` to `innerHeight - (height + offsetTop)`; the bar's bottom follows it |
| 1440, 1101 | Pixel and layout diff empty; the bar, Save, the tooltips and the native confirm are unchanged; no `axle.draft.*` key is written at 1440 |

**Test proof.** Proof kit K1 to K7. Specific: the autosave scenarios above scripted in the harness; the K7 safety grep shows no added or removed lines containing `data-confirm` handler code, `formaction`, `canSend`, `needsRecipient`, `injection_flag`, `ACTION_` or `audit(` (the new spans sit on new lines inside the template). Screenshots into `design-reference/mobile-audit/phase-2/`.

**Rollback.** `git revert` of the Phase 2 commit. Keys already written stay in a phone's localStorage and are never read by the reverted code; they are harmless and can be left.

### 3.7 Phase 3: route and partial contract changes

**Goal.** Make the queue light on 4G and the transport honest on the phone: paginated Done and All, fragment tabs, compose out of the polled pane and full screen, a visible detail-shaped error with Retry, a server-set detail class, an in-app Back that does not reload, and poll pause rules.

**Register IDs closed (14).** M-07, M-11, M-12, M-16, M-17, M-18, M-20, M-40, M-41, M-42, M-43, M-51, M-54, M-59.

**Contract changes (each needs Brad's explicit OK at this gate).**

| # | Route or partial | Change |
|---|---|---|
| C1 | `GET /queue` | New integer parameter `page` (default 1). For `show=done` and `show=all`: page 1 returns the full pane as today with the first 50 cards and a "Load more (50 of N)" control; `page>=2` returns only the next 50 card rows, the next Load more control (or none) and the summary-translation fill script (inbox.js:505-527), with no queue head and no other scripts. `data-rank` continues across pages (offset plus index). The query gains `LIMIT 50 OFFSET (page-1)*50` for those two tabs only (inbox.js:92-95). The `view_inbox` audit call keeps its exact text (inbox.js:96); `items=` keeps meaning "matching items", taken from the tab counts the route already computes (inbox.js:115-121), so the audit line does not change meaning. `show=open` and `show=archived` are unchanged. `GET /` renders page 1 and takes no new parameter |
| C2 | Status tabs in the queue fragment (inbox.js:132, 441) | Each `a.qtab` keeps its `href` (no-JS fallback) and gains `hx-get="/queue?mailbox=..&show=..&scope=.."`, `hx-target="#queuepane"`, `hx-swap="innerHTML"`, `hx-push-url="/?mailbox=..&show=..&scope=.."`. After the swap an open item's work pane is reset to the same empty state `GET /` renders (Q5) |
| C3 | Compose markup (inbox.js:158-428, 557) | The modal and its script leave `buildQueuePane`, so `/queue` no longer returns them. They render once per full page, outside `#queuepane`, from `GET /` (inbox.js:564-571) and the non-HX branch of `GET /item/:id` (item.js:987), through one builder registered by inbox.js on `app.locals` and read by item.js (no new `require`, no server.js edit). `#composeBtn` becomes a delegated document click because the button itself is re-rendered by every queue swap. `/compose` and `/compose/resolve`, the form fields and the `mode` values are unchanged |
| C4 | HX error fragments: error middleware (server.js:553), HX 404 (item.js:231) | Both pass `{ back }` to `workPanes`, so the fragment carries `.has-item` and a back bar; the message gains a Retry control only when `req.method` is GET. The client handler (ui.js:782-791) writes the same detail-shaped error for `sendError` and `timeout` (no response body) and for `responseError`, with Retry only for GET requests. No other server.js line changes |
| C5 | Detail class | `page()` gains `opts.bodyClass`; the non-HX `GET /item/:id` sets `ax-detail`; the HX item fragment's trailing script (item.js:980-982) adds it; in-app Back, tab swaps and error screens set or clear it client-side. Every `:has()` phone rule gets a `body.ax-detail` twin in a separate rule block |

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/routes/inbox.js | 72-155, 158-428, 430-459, 529-556, 557, 564-579 | C1, C2, C3; poll pause rules; `openM()` no autofocus on the phone (232); delegated `#composeBtn` (234) |
| box-code/routes/item.js | 231, 980-982, 987 | C3, C4, C5 |
| box-code/views/ui.js | `page()` (710-724), script (777-812), `workPanes()` back link (898), `shell()` (903-906), `STRINGS`, 703 | C4, C5; in-app Back replacing the inline `history.back()`; list scroll save and restore; scroll to top after a card swap; tab-swap work-pane reset. Keys: load_more (with `{n}`), retry, load_failed_title, updates_waiting, searching_loaded (with `{n}`). `ASSET_V = "polaris19"` |
| box-code/server.js | 545-555 only | C4 |
| box-code/assets/components.css | 263-295 and phone rules | Compose full screen; `body.ax-detail` twins; Load more; error screen; "Updates waiting" chip |

**Approach: queue.** Pagination (C1) and fragment tabs (C2) together cut the Done tab from 1,532 cards and 4.67 MB to 50 cards per request, and a tab switch from a full document load to one fragment request. Search and sort stay client-side over the loaded cards (Q4); on a paginated tab the empty state says it searched the N loaded cards and offers Load more. The search script recounts `total` and re-applies the sort after each Load more swap.

**Approach: poll (M-12, M-54).** The singleton (inbox.js:540-553) skips a tick when: `document.hidden` (any width); the list holds more than page 1 (any width, so a Load more list is never collapsed); or, on the phone only, `#queuepane` is not displayed, `scrollY > 0`, or a `touchstart` hit the list in the last 10 seconds. A skip for the phone reasons shows a 44px "Updates waiting, tap to refresh" chip in the live line; tapping it runs the same `htmx.ajax` call and scrolls to the top. Desktop at 1440 with a visible, unpaged list polls exactly as today (8s during sync, 15s while drafting).

**Approach: compose (M-40 to M-43, M-59).** With C3 the queue poll can no longer touch the modal. On the phone `.modal` loses its padding, `.modal-card` fills the viewport (no radius, `min-height: 100dvh`), `.modal-head` is sticky at the top with a 44x44 close, and `.modal-foot` is sticky at the bottom (`position: sticky; bottom: 0` inside the scrolling `.modal`) with Cancel, Draft and Send now at 44px, 8px apart, plus safe-area padding. Scenario chips get 8px gaps. The file input is already a 44px `::file-selector-button` from Phase 0. The Send now confirm (inbox.js:417) is unchanged.

**Approach: navigation (M-07, M-17, M-18, M-20).** The back link keeps `href="/"` (so without JS it always stays in Axle, M-20) and loses its inline `history.back()` (ui.js:898). With JS, a delegated handler on the phone resets `#workpane` to the empty state, removes `ax-detail`, restores the list's saved `scrollY`, sets the document title, and pushes the saved list URL with state `{htmx: true}`. It never calls `history.back()`, so there is no reload and no URL that disagrees with the screen; a later popstate onto any of these entries is an htmx cache miss and reloads that URL, which is correct content. The iOS edge-swipe Back still reloads the list (residual, D9). On a card tap the handler saves `scrollY` and the list URL; after the swap it scrolls to the top on the phone only, so desktop scrolling is untouched and the card markup (inbox.js:150) is not edited.

**Subagent model.** opus for all of it (pagination, htmx swaps, history, poll, compose relocation); sonnet for the compose full-screen CSS and strings.

**ASSET_V / -IncludeNew.** `polaris19`. No new files; C3 uses `app.locals`, so deploy.ps1's dependency check (deploy.ps1:147-184) sees no new relative `require`.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393 | Harness DB seeded with 120 extra done items: `/?show=done` renders 50 cards; response under 250 KB; "Load more (50 of N)" at least 44px; a tap appends 50 without replacing the first 50; after the last page the control is gone. All tab the same; Open and Archived unchanged |
| 393 | A tab tap issues one XHR to `/queue?...`; a marker set on `window` before the tap survives (no document load); the URL becomes `/?...&show=X`; Back then shows content matching the URL |
| 393, 375 | `#composeModal` is not inside `#queuepane` and appears exactly once in `/` and in a deep-linked `/item/:id`; the `/queue` response contains no `composeModal` |
| 393 | Compose open with text typed while a sync-driven poll fires (sync lock set in the harness): the modal stays open with its text (M-59) |
| 393, 375 | Compose: `.modal-card` rect equals the viewport; close 44x44; the Cancel / Draft / Send now row visible at the bottom without scrolling, each at least 44px and at least 8px apart; chips at least 44px tall with at least 8px gaps; after opening, `document.activeElement` is not `#who` |
| 393, 375 | Forced 500 on `GET /item/:id` (harness stub): the detail screen shows (workpane displayed, back bar, Retry at least 44px); Retry re-issues the GET; a forced network failure gives the same screen; a failed POST never offers Retry |
| 393 | After a card tap `body` has `ax-detail`; after Back it does not; with the `:has()` rules removed through CSSOM in the harness, an opened item still displays |
| 393 | Back: no document load (window marker survives), list visible, `scrollY` restored within 2px, URL equals the saved list URL; deep link then Back shows the list at `/`; a card tapped from `scrollY` 2,000 opens at `scrollY` 0 |
| 393 | Sync lock set: with an item open, no `/queue` request in 30s; list scrolled or touched: no swap and the "Updates waiting" chip appears, tapping it refreshes; `document.hidden`: no requests; after Load more: no swap at any width |
| 1440, 1101 | Pixel and layout diff empty for every baseline page; a tab switch ends on the same visible state as before (empty work pane, new tab), without a document load; with the sync lock set the queue still refreshes every 8s |

**Test proof.** Proof kit K1 to K7. Specific: K4 equivalence battery must be identical for every route except the `GET /` and `GET /queue` bodies and the HX error bodies; the harness exercises C1 to C5 as above; screenshots into `design-reference/mobile-audit/phase-3/`.

**Rollback.** `git revert` of the Phase 3 commit restores every route and fragment exactly (no DB, no data, no config). Because C3 moves markup between routes, revert Phase 3 as a whole, never file by file.

### 3.8 Phase 4: hardening

**Goal.** Make every wait visible without layout shift, finish focus and ESC handling, check NL fit, absorb any device findings that are available before the deploy, and draft the handover script.

**Register IDs closed (3).** M-52, M-53, M-55. Also (not register IDs): ESC and focus management, NL parity, real-device fixes, handover script.

**Files touched.**

| File | Region | Change |
|---|---|---|
| box-code/views/ui.js | card-tap singleton (798-812), `page()` script, `STRINGS`, 703 | Phone skeleton detail screen on card tap; busy-poll scroll preservation; ESC and focus handling. `ASSET_V = "polaris20"` |
| box-code/routes/item.js | busy box (792), `actionBar` busy branch (612), customer dialog loading (189), upload row (858) | Phone-only skeleton reply in the reply slot; phone-only disabled bar placeholder while drafting (same height as the ready bar); skeleton blocks in the customer page and upload row |
| box-code/views/ui.js | translation placeholder (626) | Phone-only skeleton lines instead of the spinner |
| box-code/assets/components.css | new `.sk` primitive, phone rules | Skeletons sized to the final content |
| project root, not box-code | new document | Handover test script (see 4.7) |

**Approach.** On a phone card tap the singleton writes a skeleton detail screen into `#workpane` in the same frame (app bar with a title bar, chip placeholders, two skeleton boxes, a disabled bar), carrying `.has-item` and `ax-detail`, so the phone switches to the detail at once; the response replaces it, and a failure lands on the Phase 3 error screen. Desktop keeps today's overlay and spinner (798-812). While drafting, the banner stays, the reply slot shows skeleton lines and a disabled bar placeholder of the ready bar's height sits at the bottom; the 10s busy poll (item.js:978) still swaps the whole pane (transport unchanged) and the singleton restores `scrollY` after each busy-poll swap. ESC closes the topmost open sheet, the context sheet or the customer page; opening a sheet moves focus to its heading or Close row, and closing returns focus to the trigger. These apply at every width because they change no pixels. NL: switch the harness user to NL and rerun every phase's acceptance at 375.

Real-device fixes: the box-code tree cannot be run next to the live service for a phone preview, because `server.js` hard-codes port 8484 (server.js:36, the live listener) and expects `..\secrets\.env` and `..\data\axle.db`, neither of which exists beside the repo. So unless Brad asks for an earlier device session, device findings arrive after the single deploy and become a follow-up fix with its own deploy (4.6, step 9).

**Contract changes.** None.

**Subagent model.** opus for the card-tap skeleton, busy-poll scroll and focus handling; sonnet for skeleton CSS, NL checks and the handover script draft.

**ASSET_V / -IncludeNew.** `polaris20` (the value that ships). No new box-code files; the handover script lives in the project root and is never deployed.

**Acceptance.**

| Width | Pass condition (observable) |
|---|---|
| 393, 375 | Harness delays `GET /item/:id` by 3s: the skeleton detail is visible within one frame of the tap and for the full 3s; the bar's rect is identical in the skeleton and the loaded screen |
| 393 | Customer page loading, pending translation and upload show skeleton blocks, not spinners, at the final content's size |
| 393 | Item set to `investigating` in the harness DB after boot: banner plus skeleton reply in the reply slot plus a disabled bar the same height as the ready bar; across a busy-poll swap `scrollY` changes by at most 2px; when the harness flips it to ready with a draft, the reply appears in the slot and every element above the slot keeps its position |
| 393, 1440 | ESC closes the topmost open sheet, context sheet or customer page; on open `document.activeElement` is inside the sheet; on close it is the trigger |
| 375 (NL) | EN and NL `STRINGS` key counts equal; no horizontal page scroll; no button in the bar or any sheet has `scrollWidth > clientWidth`; tab counts visible (labels may ellipsise) |
| 1440, 1101 | Pixel and layout diff empty |

**Test proof.** Proof kit K1 to K7. Screenshots into `design-reference/mobile-audit/phase-4/`.

**Rollback.** `git revert` of the Phase 4 commit.

## 4. Cross-phase rules

### 4.1 Branch, pull, commit

- Build on a branch, `axle/mobile`, the same way the Polaris retheme was built (retheme-log.md, "Ship it"). Reason: deploy.ps1 ships everything under box-code that differs from the live tree (deploy.ps1:100-124), so committing unfinished phases to `main` would let any deploy from `main` in the meantime (Vera's or a hotfix) push half the mobile work live unreviewed. Push the branch after each phase as a backup. If Brad prefers `main`, then nobody deploys until the final run.
- `git pull` (and rebase the branch on `main`) before each phase; if other work touched ui.js, inbox.js, item.js or components.css, rerun that phase's proof.
- One commit per phase, files staged by name (DEPLOY.md rule 2). Message, plain ASCII:
  `Mobile P1A: shell chrome, sheets, queue chrome [M-01 M-02 M-08 M-09 M-10 M-13 M-14 M-15 M-34 M-35 M-45 M-46]`
- A hotfix to live during the build is made on `main`, deployed, and merged into `axle/mobile`.

### 4.2 Desktop stays pixel-equivalent

Before Phase 0, capture the desktop baseline on the harness (same Chromium build, same fixtures) at 1440 x 900 and 1101 x 900 for: `/` (Open and Done), `/item/` for the needs-answer, ready, contact-form, compose, done and injection-flagged fixtures, compose open, More actions open, the recipient popover open, the Language chip open, the customer dialog open, `/blocks`, `/audit`, the block page, `/sprocket/requests`. The existing live capture `design-reference/mobile-audit/1440-desktop-baseline-queue-item.jpg` is real data and cannot be diffed against fixtures; it is the eye reference for the post-deploy check. After every phase:

- Pixel diff: zero changed pixels on every baseline page (a region mask only for the "Live · updated" time if the harness clock moves).
- Layout diff: for every element with a box at 1440, `getBoundingClientRect`, computed `font-size`, `color`, `background-color` and `display` identical to the baseline.
- DOM diff of the desktop render: the only allowed differences are elements that compute to `display: none` at 1440, added class tokens, the `div.m-mail` wrapper (1B), `hx-*` and `data-*` attributes on existing elements (Phase 3), the relocated `#composeModal` (Phase 3, `display: none` until opened) and the `ax-detail` body class (Phase 3). Anything else fails the phase.

### 4.3 Safety-path checklist (every phase, before the commit is accepted)

1. `git diff --stat HEAD~1 -- box-code/send-guard.js box-code/send.js box-code/resolve-customer.js box-code/rules.js box-code/engine.js box-code/forward-guard.js box-code/recipient-set.js box-code/db.js` prints nothing.
2. `git diff HEAD~1 -- box-code/server.js` prints nothing, except in Phase 3, where every hunk lies inside the error middleware (server.js:545-555); nothing in 155-535 (compose, `setRecipient`, send routes).
3. `git diff -U0 HEAD~1 -- box-code | grep -E '^[-+].*(audit\(|ACTION_|injection_flag|acceptTypedRecipient|pickKnown|assembleSend|assembleNewOutboundSend|formaction|data-confirm=)'` prints nothing, except added lines in Phase 2 that copy an existing `data-confirm="${esc(...confirm)}"` onto a mirror row; each such line is listed in the phase report for Brad.
4. The `data-confirm` capture handler (ui.js:868-886) is byte-identical to the pre-Phase-0 file (hash the block).
5. `grep -c "audit(" ` per file in box-code/routes and server.js unchanged.
6. No new file under box-code (`git diff --stat --diff-filter=A HEAD~1 -- box-code` prints nothing); no `package.json` or `package-lock.json` change.

### 4.4 Proof kit (every phase)

- **K1 Syntax.** `node --check` on every touched `.js` (ui.js, inbox.js, item.js, admin.js, sprocket.js, server.js as applicable); brace balance on components.css and tokens.css (the retheme method).
- **K2 Unit suites.** Run every `*.test.js` in box-code (27 files on 25 Sep 2026) with `node` from box-code on the box. Note: `deploy.ps1 -WhatIf` does not run any suite (it returns at deploy.ps1:185, before step 3), and a real deploy runs only the 14 listed at deploy.ps1:72-75. Capture which suites are green before Phase 0; a phase may not turn any of them red. `rules.test.js` loads `views/ui.js` (rules.test.js:11), so it also guards ui.js.
- **K3 Deploy preview.** After the phase commit is pushed, `deploy.ps1 -WhatIf` (elevated; it changes nothing): expected "diff" lines only for the files the phase touched, zero "NEW", dependency check green (deploy.ps1:147-184). On the branch its git pre-flight (deploy.ps1:94-97) compares against `origin/main`; if it refuses because `main` moved, rebase first.
- **K4 Equivalence battery.** The Step-0 battery (harness/step0, 120 responses over three env phases) with `AXLE_PRE` = an export of the pre-phase commit and `AXLE_MIRROR` = the phase tree: transport fields (status, redirect targets, headers) and final DB dumps byte-identical; HTML bodies may differ. First task of Phase 0: confirm the stub kit still boots the current box-code (the harness dates from June and mocks moved since); stale stubs are fixed inside `harness/`, which deploy never sees.
- **K5 Headless walk.** A repo-only `harness/harness-mobile.js` (outside box-code, never deployed, not a project dependency) boots the real routes on the Step-0 stub kit with a temp fixture DB, seeds what the phase needs (120 done items, an investigating item, the sync lock, a forced 500), and drives Chromium installed in the sandbox scratch folder with touch and DPR 3 at 393 x 852, 375 x 812 and 430 x 932, plus 1440 x 900 and 1101 x 900. It runs the phase acceptance assertions, the tap audit (every visible `a`, `button`, `summary`, `input`, `select`, `label[for]` at least 44 x 44 and at least 8px from any neighbour in the same row; text links inside `pre.mail` and translation boxes exempt; violations on screens scheduled for a later phase listed, not failed) and the overflow audit (`scrollWidth` equals the viewport on every screen). Output PNG and JSON go to `design-reference/mobile-audit/phase-<n>/`. If Chromium cannot be installed in the sandbox, the walk falls back to structure assertions on the rendered HTML and Brad's review moves to after the deploy for that phase; the phase report says so.
- **K6 Desktop equivalence.** 4.2.
- **K7 Safety checklist.** 4.3.
- **Gate.** Brad reviews the 393, 375 and 1440 screenshots and the K5 report; that review is the phase gate (decision 12). The real-iPhone check is batched after the deploy unless Brad asks earlier.

### 4.5 Roadmap entry per phase

Each phase prepends a dated entry to the [Status and Roadmap](Axle%20%E2%80%94%20Status%20%26%20Roadmap.md) in the house form: what happened, why, the fix, files, deploy notes. Deploy notes read "committed on axle/mobile, not deployed; ships with the single final deploy". The entry names the register IDs closed, the `ASSET_V` value and, for Phase 3, the contract changes C1 to C5 with Brad's OK. The plan itself gets its announcing entry when Brad approves this plan. The closing entry follows the live proof.

### 4.6 The single final deploy, in order

1. Brad approves Phase 4. Merge: `git checkout main && git pull --ff-only && git merge --no-ff axle/mobile`, push.
2. `.\deploy.ps1 -WhatIf`: expected diffs ui.js, inbox.js, item.js, admin.js, sprocket.js, server.js, components.css, tokens.css; zero NEW; dependency check green. Stop if anything else appears.
3. Brad says go. `.\deploy.ps1` (elevated): places the files, `node --check`s them, runs the 14 suites against the live tree, restarts, compares PIDs, stamps `VERSION.txt`.
4. Runbook verification: listener on 8484 (`Get-NetTCPConnection -LocalPort 8484 -State Listen`), PID changed (deploy output "before PID / after PID"), `C:\Axle\app\VERSION.txt` shows the merge commit, `C:\Axle\logs\server.log` shows a clean boot.
5. Over Tailscale, hard refresh; page source shows `?v=polaris20` on tokens.css, components.css and htmx.min.js.
6. Drive the real UI at 1440 on a real item, read-only (open, open each menu, close it; no chip, recipient, attach, status or send action), and compare by eye with `1440-desktop-baseline-queue-item.jpg`.
7. Brad on his iPhone: the batched device checks (register section 5): safe areas and toolbar, keyboard with the bar and the recipient sheet, focus zoom, outside-tap and scrim close, rotation, tab switch, background and resume, a forced tab discard (open many tabs), autosave restore, back gesture, `:has()` and `ax-detail`.
8. Live proof (4.7).
9. Findings from steps 6 to 8 become a follow-up fix on a new branch with its own deploy, only on Brad's OK; a blocking regression triggers the rollback in 4.8.
10. Handover script and the closing roadmap entry.

### 4.7 Live proof and handover

- Only on a compose draft to admin@budget-parts.nl that Brad names at the time; no real customer item is changed. On the iPhone: New email, full-screen compose, fill it, press Draft (never Send now); open the new item and watch Drafting with the skeleton; edit the reply, switch apps and come back, reload, see "Unsaved edits restored"; confirm the recipient and see the text survive; open the Language and Owner sheets and close them without choosing; open the overflow sheet and close it; tap Send, read the full address in the native confirm and press Cancel. Nothing is sent. Closing or archiving the test item only if Brad says so. Screenshots into `design-reference/mobile-audit/final-live/`.
- Handover test script: ordered by screen, one task per row, what to tap and what "correct" looks like per register ID, runnable by Rob or Huub without training, English (Dutch copy on request). DEPLOY.md rule 6 asks new files to avoid em-dash names, so the suggested name is `Axle - Mobile Handover Test Script - 2026-09.md` (the kickoff spelled it with em dashes); it lives in the project root and is never deployed.

### 4.8 Rollback

- Before the deploy, rollback is git only: `git revert` the phase commit on `axle/mobile`; to drop several phases, revert newest first. A middle-phase revert conflicts on the `ASSET_V` line; resolve it with the next unused value. Nothing is live, so nobody is affected.
- After the deploy: `git revert -m 1 <merge commit>` on `main`, set `ASSET_V` to `polaris21` (never reuse a value that shipped), commit, push, `deploy.ps1 -WhatIf`, then the real run, then the runbook checks. No schema, data or config was changed, so a code revert is a complete rollback; leftover `axle.draft.*` keys on phones are ignored by the old code.

## 5. Open questions for Brad: all resolved 25 Sep 2026

Brad's answers, 25 Sep 2026: Q1 the mock as signed off (control row plus slim live line). Q2 autosave on the phone layout only, Save kept as an overflow row. Q3 native confirm only; the mock's confirm sheet is dropped. Q4 client-side search over the loaded cards with the on-screen note; no `q` parameter. Q5 the desktop tab switch resets the work pane. Branch `axle/mobile` confirmed. The questions are kept below for the record.


1. **Phase 1A: queue sticky chrome.** The plan follows the M1 mock: one control row (four tabs plus the search icon) and a slim live line carrying "Live · updated" and the Filters button, about 109px together. Decision 7 says "one sticky row". Confirm the mock reading, or put Filters into the control row as a third icon (tabs shrink from about 67px to 54px at 375 and NL labels such as "Gearchiveerd" ellipsise) with the live dot moving elsewhere.
2. **Phase 2: autosave width and Save.** Default: autosave on the phone layout only (at most 1100px), and Save kept as a row in the overflow sheet so an explicit server save stays reachable ("nothing is silently dropped" in the mobile bar). Confirm both, or say all widths and/or no Save row.
3. **Phase 2: send confirm.** Default: the native `confirm()` from the unchanged `data-confirm` handler (ui.js:880-886), which on iOS is a system alert showing the full recipient. The mock's confirm sheet can only be added in front of it (sheet, then native alert: two steps), because replacing the native dialog would edit a handler on the untouchable list. Native only, or sheet plus native?
4. **Phase 3: search and sort on Done and All.** Default: client-side over the loaded pages, with an on-screen "searched the N loaded" note and Load more. The alternative is a server-side `q` parameter on `GET /queue`, a sixth contract change that would also let cards stop carrying the email text in `data-search`.
5. **Phase 3: tab switch at 1440 with an item open.** Default: reset the work pane to the empty state, which is where today's full navigation ends. The alternative keeps the item open while the queue switches, with the address bar showing the queue URL until the next reload.

## 6. Appendix: register map

| ID | Phase | Pattern |
|---|---|---|
| M-01 | 1A | 48px app bar (brand, menu); nav, language and user in a menu sheet |
| M-02 | 1A | Menu sheet with 44px rows; EN/NL as two 44px segments |
| M-03 | 0 | Sprocket hidden at 1100px and below; nothing covers the bar or compose |
| M-04 | 0 | `viewport-fit=cover` plus `env(safe-area-inset-*)` on every fixed or sticky element (new ones from birth) |
| M-05 | 0 | `dvh` with `vh` fallback; positioner clamp retired on the phone by M-09; phantom scroll traced |
| M-06 | 0 | 16px on every text-like input, select, textarea and contenteditable at 1100px and below |
| M-07 | 3 | Server-set `ax-detail` body class (C5) twinning every `:has()` rule |
| M-08 | 1A | Sheets placed by CSS; close via the summary scrim, no JS needed |
| M-09 | 1A | Positioner and splitter return early under `window.__axPhone` |
| M-10 | 1A | Sticky control row plus live line; Filters sheet; New email bottom-right |
| M-11 | 3 | `page` parameter, 50 per page, Load more (C1) |
| M-12 | 3 | Pagination plus poll pause rules (hidden, backgrounded, paged) |
| M-13 | 1A | Tabs at least 44px with 8px gaps |
| M-14 | 1A | Filters sheet with 44px rows and a Close row |
| M-15 | 1A | "No matches for 'x'" with a 44px Clear search |
| M-16 | 3 | Tabs swap `#queuepane` through `hx-get` with `hx-push-url` (C2) |
| M-17 | 3 | In-app Back: no reload, scroll restored (edge-swipe residual, D9) |
| M-18 | 3 | Scroll to top after a card swap, phone only |
| M-19 | 1B | Header hidden on the item; back bar carries a two-line title |
| M-20 | 3 | Back never calls `history.back()`; `href="/"` fallback |
| M-21 | 1B | Chip row with 44px cells and a visible caret; Language and Owner sheets (from 1A) |
| M-22 | 1B | State-driven order through flex order; email after the work form |
| M-23 | 1B | Newest message clamped to 12 lines with "Show full message"; parsed contact-form box above it |
| M-24 | 1B | Every summary a 44px full-width fold row with a chevron |
| M-25 | 1B | Inbound attachments as 44px chips, 8px gaps |
| M-26 | 2 | Feedback textarea 16px, auto-growing, no resize |
| M-27 | 2 | Inline 16px auto-growing reply editor, no inner scroll |
| M-28 | 2 | Fixed two-row bar: recipient line, then Send and "..." |
| M-29 | 2 | Full recipient on its own row, wrapping, never truncated |
| M-30 | 2 | Recipient line separate from Send by at least 8px |
| M-31 | 2 | The whole line is the tap target; amber when unconfirmed; Send disabled |
| M-32 | 2 | Tooltip text shown as secondary lines in the overflow rows and sheet headings |
| M-33 | 2 | Recipient sheet above the keyboard through `--kb`; Other address inline |
| M-34 | 1A | Recipient sheet with 44px radio rows and a 16px email field |
| M-35 | 1A | More actions as a sheet with a visible Cancel row |
| M-36 | 1B | "Customer & docs" opens `.pane-context` as a full-height sheet with a back bar |
| M-37 | 1B | SAP documents as stacked rows, 44px Attach and Preview |
| M-38 | 0 | Caught by the 16px and 44px phone rule without adding `type` |
| M-39 | 1B | Customer tiles in two columns |
| M-40 | 3 | Compose full screen on the phone (modal kept) |
| M-41 | 3 | Sticky Cancel / Draft / Send now row with safe-area padding |
| M-42 | 3 | 44x44 close, 8px chip gaps, 44px file button (from Phase 0) |
| M-43 | 3 | No autofocus on `#who` on the phone |
| M-44 | 1B | Customer dialog presented as a full-screen page with a back bar |
| M-45 | 1A | Block page: sticky back bar, 44px Cancel |
| M-46 | 1A | Table inside a contained horizontal scroll plus "Best on desktop" |
| M-47 | D3 | Deferred: audit pagination |
| M-48 | D3 | Deferred: row links (inputs lifted by Phase 0) |
| M-49 | D4 | Deferred: Sprocket hidden on the phone |
| M-50 | D4 | Deferred: Sprocket hidden on the phone |
| M-51 | 3 | Detail-shaped error with back bar and Retry for GET (C4) |
| M-52 | 4 | Skeleton detail screen on card tap |
| M-53 | 4 | Skeletons for the customer page, translations and uploads |
| M-54 | 3 | Never swap a hidden, scrolled or touched list; "Updates waiting" chip |
| M-55 | 4 | Banner plus skeleton reply, same-height bar placeholder, scroll kept across busy polls |
| M-56 | 2 | Local autosave per item, restore with a note, base check |
| M-57 | 2 | Autosave restored after the recipient, language, owner and attach redirects |
| M-58 | 2 | Back keeps the draft; "Draft kept" on the card |
| M-59 | 3 | Compose markup out of `#queuepane` (C3) |

Counts: Phase 0: 5, Phase 1A: 12, Phase 1B: 10, Phase 2: 11, Phase 3: 14, Phase 4: 3, deferred: 4. Total 59.
