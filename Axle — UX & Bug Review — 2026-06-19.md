# Axle — UX & Bug Review — 19 June 2026

A fresh, whole-tool pass: full code audit of every screen + a live read-only walk-through
in Chrome over Tailscale (nothing sent, saved or committed). This is the register of
everything found, what I've already fixed, and a proposal for the bigger "cleaner / more
intuitive" changes for you to sign off.

**Method.** Read every render path (`views/ui.js`, `routes/{inbox,item,admin,shared,sprocket}.js`,
`assets/{components,tokens}.css`); drove the live tool as Brad (read-only); reproduced and
**fixed-and-verified** your reported bug against the real app DOM.

---

## TL;DR

- **Your "More actions" bug is fixed** — and it was the visible symptom of a whole *family*
  of the same root cause (any pop-up menu that opens near a pane edge gets clipped behind the
  neighbouring pane). One root-cause fix clears the action menu, the queue Filter menu, the
  editable chips, and the Sprocket-cog overlap together. Verified live: the menu now renders
  in full, clear of the list pane and fully on-screen.
- **Two more clear bugs squashed**: the mobile **Back** button was throwing away your queue
  filters/scroll on every use; the empty context pane left a stray border seam.
- All three are in **`box-code` only** — **not yet promoted to the live tool.** They're
  presentation-only; no safety path (`send-guard`, send, recipient gate, allow-list, audit)
  is touched. Promote steps are at the bottom.
- **~25 further issues** found and listed below by severity, split into *quick squashes* and
  *needs-your-call*.
- A **UX redesign proposal** (action bar, chips, queue, accessibility, consistency) follows
  for sign-off — this is the "world-class" pass, done deliberately rather than in one risky sweep.

---

## 1. Fixed now (in `box-code`, awaiting your promote)

### 1.1 — Pop-up menus clipped behind panes  *(your reported bug + its whole family)*  **[P1]**

**What you saw.** Open an item, and when the action bar wraps (a long recipient address +
Save + Save & redraft + the hint fill the first row), the "··· More actions" button is
stranded alone on the left of the next row. Its menu opens up-and-left and the left half —
the bold labels *Mark done / Resolved by phone / Archive / Block sender* — disappears behind
the email-list pane. Unusable.

**Root cause (the important bit).** The three panes (`.pane-queue`, `.pane-center`,
`.pane-context`) each use `overflow-y: auto`. Per the CSS spec, setting *one* overflow axis to
`auto` forces the *other* axis to compute to `auto` too — so each pane silently **clips
horizontally as well**. Any absolutely-positioned pop-up (`.menu-list`, `.chipmenu-list`) that
extends past its pane's edge is cut off, and the neighbouring pane shows through. The
action-bar menu is `right: 0` (opens leftward), so when its button is on the left it spills
straight past the pane edge. The **queue Filter menu**, the **editable chips** (Language /
Owner) near the right edge, and the **Sprocket cog** sitting on top of the bar are all the
same class of problem.

**Fix.** A small, self-contained positioner in `page()` (`views/ui.js`): when any `<details>`
menu opens, its list is switched to `position: fixed` (which **escapes the panes' overflow** —
no ancestor has a transform, so fixed anchors to the viewport), anchored to its button,
**flipped** above/below for room, and **clamped** into the viewport so it can never be clipped
or run off-screen. `z-index` lifts it over the Sprocket cog. No markup changes; the menus still
work without JS (this only relocates an already-open list). One fix, whole family solved.

**Verified live.** Injected the exact positioner into the real running app and re-opened the
menu: it now renders at x 378–718 (the list pane ends at 345) — `clearOfQueue: true`,
`onScreen: true` — every label fully readable. Before/after captured.

*Files:* `views/ui.js` (positioner in `page()`), `assets/components.css` (empty-pane seam, §1.3),
`ASSET_V` → `polaris6`.

### 1.2 — Mobile **Back** discards your queue state  **[P1, mobile]**

On a phone the queue collapses to a list→detail flow; the sticky **Back** bar was a hard link
to `/`, so tapping it did a full reload of the *unfiltered* inbox — losing your mailbox /
status-tab / search / sort and your scroll position every time. Changed to history-aware
(`history.back()`), so Back returns to the exact filtered list you came from. Without JS it
still falls back to `/` (no regression).

*File:* `views/ui.js` (`workPanes`).

### 1.3 — Stray border seam on the empty context pane  **[P3, cosmetic]**

On the empty inbox the right context pane was empty but still drew its 1px left border and grey
fill — a thin seam down the middle of the empty state. `.pane-context:empty` now also clears
border + background.

*File:* `assets/components.css`.

### 1.4 — Action-bar redesign (proposal A, approved)  **[UX]**

The bar now reads in two clusters: **left** works the reply — `Send` · `Save` · `Save & redraft`
(the long "runs in the background" note is now the redraft button's *tooltip*, so the bar no
longer wraps on it) — and **right** closes the item — **`Mark done`** (promoted from the overflow
to a visible button, since it's the everyday close) · `⋯ More actions` (now just the rarer closes:
Resolved by phone, Archive, Block sender). Same `/status` route, same behaviour — no route or
safety change; only the layout and the visibility of *Mark done* changed. Removing the inline hint
also removes the main thing that *triggered* the wrap, so the bar stays on one line in normal use
(and the positioner still catches any residual wrap).

*File:* `routes/item.js` (action bar).

> **Status:** verified — positioner syntax node-checked in isolation, all four edits confirmed
> intact on disk (balanced template literals), the clipping fix proven against the live DOM.
> Nothing promoted yet; the live tool is unchanged until you run the promote steps in §4.

---

## 2. Full bug register (everything else found)

Severity: **P1** = breaks/blocks a real task · **P2** = real but has a workaround · **P3** =
polish. Tag: **[quick]** = low-risk squash I can do on your nod · **[call]** = needs a design
decision (folded into the proposal in §3).

### Stacking / overflow / layout
- **P2 [quick]** — `details` chip menus (Language/Owner) can clip at the right pane edge in
  narrow windows — *now covered by the §1.1 positioner; verify and close out.*
- **P2 [call]** — The **Sprocket cog** (fixed, bottom-right, `z-60`) overlaps the right end of
  the action bar and, at ≤600px, can fully cover the More-actions button. Positioner lifts the
  *menu* above it, but the *button* is still under the cog. Proposal: nudge the cog up when an
  item's action bar is visible.
- **P3 [quick]** — Action-bar `redraft` hint ("…runs in the background") is long, especially in
  Dutch (~20% longer), and is what tips the bar into wrapping. Move it to the button's tooltip.

### Responsive / mobile (≤1100px)
- **P2 [call]** — The whole mobile list↔detail flow depends on CSS `:has()`. On a browser
  without `:has()` support `#workpane` is permanently hidden and there's no detail view at all.
  Add a JS-class fallback (or fall back to the desktop layout).
- **P2 [quick]** — On mobile the Sprocket cog sits over the action bar's right end (see above).
- **P3 [quick]** — Compose modal has no sticky footer; on a short phone screen the primary
  "Draft this email" button is below the fold with no cue.

### Accessibility
- **P1 [call]** — **Compose modal** and **Sprocket panel** are `role="dialog"` but have **no
  focus trap**, don't make the background `inert`, and **don't restore focus** to their opener
  on close. Keyboard/screen-reader users can tab out into the page behind. (Esc + labelled close
  are already there — good.)
- **P2 [quick]** — `<details>` chip/action menus have no **Esc-to-close** and no
  `aria-expanded`; they announce as a disclosure triangle, not a menu.
- **P3 [quick]** — Search inputs (`#q`, `#mq`) and several icon-only buttons need `aria-label`s;
  the chip caret/▾ glyphs need `aria-hidden`. Strings already exist.
- **P3 [quick]** — Add a skip-link and a `<nav>` landmark in the header (one-line win, every page).

### Internationalisation (EN/NL)
- **P1 [call]** — The **`/audit` page is entirely hard-coded English** (search box, headers,
  notes, the "(any action)" option). A Dutch admin gets an English page. *Low real-world impact
  today (you use English), but it's a genuine parity gap.* Route through `t()` + add NL keys.
- **P2 [quick]** — Error/empty microcopy is scattered English outside the dictionary:
  "No such attachment…", "Admins only.", "Could not fetch attachment…", "(error)" on a failed
  translation. Localise via `t()`.
- **P2 [quick]** — Compose modal `aria-label="Close"` and Sprocket `aria-label="Sprocket"` are
  hard-coded English.
- **P3 [quick]** — The in-email match-count string is string-substituted into inline JS (unlike
  the compose modal, which JSON-encodes). Safe today, fragile if a translation ever contains a
  quote. JSON-encode it.

### htmx / interaction
- **P1 [call]** — The **busy self-poller** re-GETs `/item/:id` and **swaps the whole work pane
  every 10s** while an item is investigating. It re-runs every inline script, resets the in-email
  search highlights, collapses opened quoted history, and scrolls to top. Poll a tiny *status*
  endpoint and only swap when the state actually changes.
- **P2 [call]** — Clicking another queue card swaps the work pane and **silently discards typed
  but unsaved reply/feedback** — no "unsaved changes" guard.
- **P2 [quick]** — The queue self-poll skips while *focus* is in the queue, but **not while a
  Filter menu is merely open** — a poll tick closes the menu mid-use. Also skip when
  `#queuepane details[open]` exists.
- **P3 [call]** — Save / redraft / attach POST and **302 to a full page reload** of the shell
  (re-fetches the lazy queue), rather than swapping the fragment like the card-click flow —
  inconsistent and janky.
- **Observed live, unconfirmed** — opening a chip menu while another menu is open appeared to
  take two clicks (first closes the open one). Worth confirming; minor.

### Dead-ends / missing states
- **P2 [quick]** — `/audit` with zero matches shows an empty table with only a header row — no
  "no results" state.
- **P2 [quick]** — A failed reply-translation shows a literal untranslated "(error)" with no retry.
- **P3 [call]** — `+ New email` (compose) and the `confirm()` on Send are JS-only; without JS the
  compose button is silently dead and Send skips its confirm (server guard still applies).

### Consistency / latent
- **P2 [quick]** — Two escaping implementations (server `esc` vs the compose modal's `esc2`); the
  compose resolve box builds `innerHTML` from SAP JSON (escaped for `&<>"`, not `'`). Safe today
  given quoting, but a latent XSS-shape if quoting ever changes — prefer `textContent`.
- **P3 [call]** — Mixed button anatomies in one bar (full-width `<b>`+`<span>` menu items vs plain
  Save/Send); no distinct *destructive* styling — Remove/Archive/Block look like neutral actions.

---

## 3. UX redesign proposal — "cleaner & more intuitive"  *(needs your sign-off)*

These are deliberate improvements, sequenced so each is small, reviewable and reversible. Nothing
here touches the safety paths. My recommended order:

### A. Action bar — the biggest single win
The bar is where the clipping bug lived and where the most important action (Mark done) is hidden
behind an overflow click. Proposal:
- **Promote "Mark done" to a visible button** in the bar — it's the normal way an item closes.
- Keep only the rarer closes (Resolved by phone, Archive, Block sender) in a tidy overflow.
- **Demote the redraft hint to a tooltip**, so the bar stops wrapping (and the clip trigger
  largely disappears even before the positioner catches it).
- Result: `Send` (primary) · `Save` · `Save & redraft` · `Mark done` · ⋯ — a calm, single-row bar
  that reads left-to-right by importance.

### B. Chips row — make "editable" obvious
Status/priority/intent chips look identical to the *editable* Language and Owner chips. Give the
editable ones a persistent affordance (a caret or pencil that's always visible, not only on
hover) and group read-only vs editable, so people know what they can click.

### C. Queue — keyboard-first triage
For a tool used all day: **↑/↓ to move between cards, Enter to open**, so triage doesn't need the
mouse. Replace the clip-prone **Filter** dropdown (only All / Info / Drachten) with an inline
segmented control — fewer pop-ups, one fewer thing to clip.

### D. Edit safety
Warn (or auto-save) when navigating away from an item with **unsaved reply/feedback**, and have
Save/redraft/attach return the work-pane *fragment* instead of reloading the whole shell.

### E. Accessibility pass (do it once, properly)
Focus traps + focus-restore for the compose modal and Sprocket panel; Esc + `aria-expanded` on
menus; `aria-label`s on search inputs and icon buttons; a skip-link and `<nav>` landmark. Bundled
so it's consistent rather than piecemeal.

### F. Consistency & i18n tidy
Distinct destructive styling (Remove/Archive/Block); route every stray English string and the
whole `/audit` page through `t()` with NL keys; localise error/empty microcopy; add real empty
states.

**Suggested phasing:** A (action bar) → B (chips) → C (queue keyboard + filter) → D (edit safety)
→ E (a11y) → F (consistency/i18n). Each is its own small, verifiable change behind your review.

---

## 4. Promote to the live tool

Three changed files are in `C:\Admin\Projects\Axle\box-code`, **not** yet in the live runtime
`C:\Axle\app`: `views\ui.js`, `assets\components.css`, `routes\item.js`. This must run **on the
box** (the live runtime isn't reachable from the assistant's sandbox, and the restart is a Windows
operation). Paste this one block into **PowerShell on the box** — it backs up the current live
files, copies the new ones, syntax-checks, and only restarts if the checks pass:

```powershell
$src = "C:\Admin\Projects\Axle\box-code"; $app = "C:\Axle\app"
$bak = "C:\Axle\app_backup\$(Get-Date -Format yyyyMMdd-HHmmss)"
$files = @("views\ui.js","assets\components.css","routes\item.js")
New-Item -ItemType Directory -Force $bak | Out-Null
foreach ($f in $files) {                                   # back up current live versions
  New-Item -ItemType Directory -Force (Split-Path "$bak\$f") | Out-Null
  Copy-Item "$app\$f" "$bak\$f" -Force
}
foreach ($f in $files) { Copy-Item "$src\$f" "$app\$f" -Force }   # promote
$ok = $true
foreach ($j in @("views\ui.js","routes\item.js")) {        # syntax-check the JS
  & node --check "$app\$j"; if ($LASTEXITCODE) { Write-Host "FAIL $j — NOT restarting" -ForegroundColor Red; $ok = $false }
}
if ($ok) {
  Stop-ScheduledTask -TaskName "Axle Server"; Start-ScheduledTask -TaskName "Axle Server"
  Write-Host "Promoted + restarted. Hard-refresh the tool (Ctrl+F5). Backup: $bak" -ForegroundColor Green
}
```

The cache-buster bumped `polaris5` → `polaris6`, so the team's browsers refetch CSS/JS
automatically — no manual cache clearing. **No** DB migration, new dependency, allow-list, or env
change.

**Verify after restart:** open item 253 — the action bar reads `Send · Save · Save & redraft …
Mark done · ⋯ More actions` on one line; open **More actions** and the menu shows fully on-screen,
clear of the list pane. On a phone: open an item, filter the queue, open it, press **Back** — you
land back on the *filtered* list.

**Rollback if needed:** copy the three files back from the `app_backup\<timestamp>` folder into
`C:\Axle\app` and restart the task.
