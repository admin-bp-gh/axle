# Axle — UI rework — build brief

> Kickoff prompt for a dedicated chat. Paste-ready. Written 2026-06-10 after a full UX review
> (project docs read end-to-end; live tool walked via Chrome over Tailscale as admin).
> Decisions below were made by Brad on 2026-06-10 — do not relitigate them.

---

## The task

Rework the Axle web UI into a modern, simple, fast single-screen workspace, without touching any
safety-critical code path. The tool must be intuitive enough that a new salesperson needs no
explanation, and every wait must visibly show that work is happening — nothing may ever look hung.

Start by reading `Axle — Status & Roadmap.md` top to bottom as always. Then work this brief
one step at a time, with a control gate after each step.

## Locked decisions (Brad, 2026-06-10)

1. **App-shell rework, not a SPA.** Keep Express + server-rendered HTML. Extract views from
   server.js, add a small design system, use htmx partial swaps + SSE for liveness. No build
   step, no bundler, no new runtime on the box. No React/Vite.
2. **Three-pane workspace.** One screen: work-queue list (left), conversation + reply (centre),
   customer/context panel (right). Deep links `/item/:id` keep working.
3. **SSE + step streaming.** New items and status changes appear live without reload. While Axle
   researches/drafts, the user sees real progress steps ("Checking SAP order 226108…",
   "Looking up MyParcel…") derived from the engine's tool-call log — real progress, never a
   fake spinner, never a dead page.
4. **Simplicity over density.** Optimise for the less-technical salesperson (Rob/Huub/Brendan,
   not just Jack). Progressive disclosure: few visible controls by default, advanced actions
   behind menus. Desktop-first; don't break on smaller windows. No keyboard-shortcut system
   in this round (don't preclude it later).

## Hard constraints (non-negotiable)

- **Do not modify the safety paths:** `send-guard.js`, `send.js`, the recipient gates in
  `resolve-customer.js` (`pickRecipient`), route-level send refusals, the injection
  interlock, allow-list env checks, and the audit calls. The UI rework is presentation +
  transport only. If a step seems to need a safety-path change, stop and ask Brad.
- **Server-side rendering stays authoritative.** All HTML is still built server-side with the
  existing `esc()` discipline. htmx swaps fragments the server rendered; client JS stays minimal.
- **EN/NL i18n parity** for every new or changed string (`STRINGS` dict, parity-tested).
- **CSRF:** `AXLE_ALLOWED_ORIGIN` middleware is about to be enabled. All htmx POSTs are
  same-origin so they pass, but verify the Origin header behaviour in the harness; SSE is GET.
- **Vendor all assets locally** (htmx, its sse extension, any SVG icons). The box serves a
  Tailscale-only network — no CDN references.
- **Jack is live in the tool.** Deploy in small, reversible increments, outside his busy
  moments, server restart windows kept short. Mirror discipline as always: build in
  `box-code/`, Taildrop + `axle-pull.ps1`, new filenames placed manually once, restart,
  verify live via Chrome over Tailscale.
- Existing functionality must all survive: search, sort, filters, translations, attachments
  (incl. paste-snippets + inline [image:N]), SAP-doc attach + suggestions, compose, contact-form
  flow, block-sender, resolution reasons, owner reassign, language re-tag, audit search.

## UX findings to fix (from the 2026-06-10 review)

### Inbox
- **F1. Table is admin-shaped, not work-shaped.** 10 columns (#, Status, Prio, Box, From,
  Subject, Intent, Owner, Open, Updated); half are filter dimensions, not decisions. Replace
  with a queue list: one card-row per item — sender + subject, the one-line summary, a single
  action-state chip, time, and small badges (📎, priority only when high). Intent/Box/Owner
  become filters, not columns.
- **F2. Status vocabulary is system-centric.** "Awaiting input" describes Axle's state, not the
  user's job. Rename to action labels: **Needs your answer** (amber), **Ready to send** (green),
  **Drafting…** (animated), **New**, **Done**, **Archived**. The queue default-sorts by
  "what needs me next": flagged → needs-answer → ready → new → rest.
- **F3. Sync affordance is confusing** ("ʘ Syncing… / Last synced: never" while idle). With SSE
  the inbox is simply live; replace with a quiet "Live · updated 11:35" indicator + the manual
  Sync button kept for force-refresh.
- **F4. Toolbar overload.** Three labelled segmented controls + search. Collapse to: Mine/All
  toggle, status tabs with counts, search. Mailbox filter moves into a small filter menu
  (sales users rarely need it; admin sees it).

### Item view
- **F5. Duplicate fields.** Language chip *and* "Customer's language [Set]"; Owner chip *and*
  "Assign to [Reassign]". Merge: the chip IS the control — click it, get the dropdown, change
  audited as today. One visual element per fact. (Brad's explicit example.)
- **F6. Three copies of the reply.** "AI draft (reference)" + its translation + the editable
  "Reply to send". Collapse to ONE editable reply card seeded from the AI draft, with
  "Reset to AI draft" (restores reference) and a "Show translation" toggle (reuses
  translate-reply). Edited state shown with a subtle "edited" badge as now.
- **F7. Raw email wall.** Confidentiality footers, quoted history, and "Inline-Bild" tokens
  dominate; the full English translation then repeats the whole wall again. Render a
  **conversation timeline**: newest customer message as an open card, older messages and our
  replies collapsed beneath, footers/quotes folded (the session-10 classify() folding logic
  shows the way; render-side folding is enough — do not change classify). Translation becomes a
  per-message toggle, not a second full block.
- **F8. State-driven section order.** Questions sit at the very bottom even when they are the
  blocking thing. When the item **needs answers**: questions card first (with feedback field),
  then reply. When **ready**: reply first, questions collapsed. Send is never 3 screens down.
- **F9. Sticky action bar.** One persistent bottom bar in the centre pane: primary
  **Send to {recipient}** (confirm-click as today), Save, Save & redraft; the close actions
  (Done / By phone / Archive / Block sender) in an overflow "⋯" menu with their current
  tooltips as visible descriptions. Route behaviour unchanged.
- **F10. The brief is hidden.** "What Axle checked" is raw markdown in a collapsed footer.
  Move to the **right context pane**, rendered properly: customer card (name, CardCode,
  country, tier, frozen/unpaid flags — from data the item already holds), referenced/suggested
  SAP docs with the existing one-click Attach, MyParcel shipments, then the investigation log.
  Read-only, reuses existing lookups; no new SAP queries from the UI without Brad's OK.
- **F11. Attach SAP document placement.** Today a mid-page form between draft and reply. Move
  into the context pane (suggested docs + manual attach together); staged attachments stay
  visible by the reply card.

### Liveness
- **F12. Meta-refresh reload** loses scroll position and flickers; investigating banner is
  generic; drafting takes 30–60s with no sign of life. Replace with SSE: a single `/events`
  endpoint (in-process EventEmitter), htmx sse extension or native EventSource. Emit:
  item-created, item-updated (status), draft-step (tool-call descriptions from the agentic
  loop), sync-state. The engine already records tool calls per draft — emit them as they
  happen with human-readable labels. Every async action gets an immediate optimistic
  indicator (button → spinner-in-place) plus the streamed steps.

### Look & feel
- **F13. Design system.** One `tokens.css` (spacing on an 8px grid, type ramp, neutral palette
  + one accent + status hues, radii, borders) and one `components.css` (buttons, chips,
  cards, inputs, tabs, menus, toasts). System font stack. Light theme, calm contrast, no heavy
  shadows. Replace the current default-browser-form look everywhere. Dutch/English strings
  must both fit (NL runs ~20% longer).

## Architecture of the rework

- **Step 0 refactor first:** split `server.js` (2,394 lines) into `routes/*.js` +
  `views/*.js` (plain template-literal functions sharing `esc()` and `layout()`), zero
  behaviour change — harness-verified (real routes, node:sqlite, compare rendered output
  before/after). This makes every later step small and reviewable.
- **htmx 2.x + sse extension, vendored** (`/assets/htmx.min.js`, ~14 KB). Progressive
  enhancement: every form still works as a plain POST if JS fails; htmx upgrades them to
  partial swaps so scroll/state survive.
- **Three-pane shell** is one page; the left list and centre/right panes are server-rendered
  fragments htmx swaps on selection. `/item/:id` deep-links into the shell (and renders
  standalone for old links).
- **No new dependencies** beyond the vendored htmx file. No Tailwind, no icon font (inline
  a handful of Lucide SVGs).

## Suggested step plan (gates between each, one step per session-chunk)

1. **Step 0 — extraction refactor.** Pixel/byte-identical pages, all harnesses green. Gate:
   Brad sees identical tool, commits.
2. **Step 1 — design system + item-page restructure** (F5–F9, F11, F13) on the existing
   page-per-item flow. Gate: Brad + Jack review on live items.
3. **Step 2 — three-pane shell + new queue list** (F1–F4). Gate: a full working day in it.
4. **Step 3 — context pane** (F10). Gate: accuracy check of the customer card on real items.
5. **Step 4 — SSE liveness + step streaming** (F12), retiring meta-refresh. Gate: drafting,
   redraft, compose and sync all visibly alive; nothing ever looks hung.
6. **Step 5 — polish round:** NL parity sweep, empty/error/loading states for every panel,
   accessibility pass (focus order, contrast, hit targets), Jack/Rob feedback fixes.
   Gate: rollout sign-off; roadmap updated.

Each step: build in the mirror, sandbox harness on real routes, `node --check`, deploy via
Taildrop + axle-pull, restart, live-verify via Chrome over Tailscale, update the roadmap file,
re-run the injection harness if anything near the engine/send path was touched (it shouldn't be).

## Verification standards

- Keep the harness pattern (`outputs/harness-*.js`: real server routes, stubbed externals,
  node:sqlite from the live `db.js` schema). Add a fragment-render harness for views.
- Screenshot-verify each step in Chrome over Tailscale at 1280 and 1680 widths.
- The four send flows (reply, compose, contact-form, with-attachments) must each be proven
  unchanged after every deploy that touches their pages — draft-only items used for proof,
  real sends only with Brad's explicit go.

## What NOT to do

- No relitigating the stack, layout, or liveness decisions above.
- No changes to engine prompts, business-knowledge.md, classify(), or anything that alters
  draft content — this round is purely how the tool looks, flows, and feels.
- No new allow-list actions; no new write capability of any kind.
