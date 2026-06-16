# Axle — Polaris retheme & hardening log

Branch `axle/polaris-retheme`. One entry per pass: defects found (with severity),
fixes applied, build/test result. `main` stays deployable throughout.

## Scope & ground truth (read first)

The kickoff brief describes the app as "React + Tailwind + shadcn/ui (Radix)". That
describes the **reference mock** (`design-reference/AxlePolaris.jsx`), not this repo.
The real Axle frontend is **Express + server-rendered HTML (template literals in
`views/ui.js` + `routes/*.js`), HTMX 2.x + SSE, no build step**, themed by a CSS
custom-property design system: `assets/tokens.css` (the token layer) +
`assets/components.css` (the primitives & chrome). React/Vite/Tailwind/shadcn were
explicitly rejected in the locked UI-rework decisions.

So the token-first instruction maps **onto `tokens.css`**, not a `tailwind.config`. This
is the cleaner expression of the same idea: change the token values, retheme the shared
primitive classes, and the look cascades. All component logic, routes, HTMX wiring,
approval-gate logging, streaming, and SAP/Shopify calls are untouched — this is
presentation + responsive + bug hardening only.

### Test rig (how "run the build / test in Chrome" is honoured here)

No bundler ⇒ "build" = `node --check` on every touched JS file + a boot smoke test that
fetches the real routes. The box runs at the Gouda office reachable only over Tailscale,
and this work happens in an isolated sandbox that can't reach Brad's Chrome — so the
browser testing is done with **headless Chromium driven in-sandbox** (Puppeteer) against
the **real Express server** booted with the existing Step-0 harness stubs
(`better-sqlite3`→`node:sqlite`, network/model modules stubbed) and the deterministic
fixture DB (9 work items across every state). Same rigour the brief asks for: two
viewports, full flow exercise, console capture, before/after screenshots — just not
Brad's physical browser. Nothing about the app changed to enable this; the stubs and
fixtures are the project's own harness.

## Token mapping (current → Polaris)

| token | was (stone/green) | now (Polaris) | note |
|---|---|---|---|
| `--bg` | `#f5f5f4` | `#f1f1f1` | app background |
| `--surface` | `#ffffff` | `#ffffff` | cards/rows |
| `--surface-2` | `#fafaf9` | `#fafafa` | subtle fills |
| `--ink` | `#1c1917` | `#303030` | primary text = brand |
| `--ink-2` | `#57534e` | `#616161` | secondary text |
| `--muted` | `#78716c` | `#616161` | muted text |
| `--faint` | `#a8a29e` | `#8a8a8a` | disabled |
| `--border` | `#e7e5e4` | `#e3e3e3` | hairlines |
| `--border-2` | `#d6d3d1` | `#d4d4d4` | control borders (kept slightly stronger for affordance) |
| `--border-sub` | — | `#ebebeb` | new: subtle inner dividers |
| `--brand` | (was `--ink`) | `#303030` | new: primary buttons near-black |
| `--brand-hover` | — | `#1a1a1a` | new |
| `--accent` | `#166534` | `#008060` | accent ONLY (brand mark + success); never a primary button |
| `--accent-strong` | `#14532d` | `#006e52` | accent hover |
| `--accent-soft` | `#dcfce7` | `#e3f9ec` | success fill / selected card |
| success badge | `#dcfce7`/`#166534` | `#e3f9ec`/`#0c5132` | |
| attention badge | `#fef3c7`/`#92400e` | `#ffeaba`/`#5a4200` | |
| info badge | `#dbeafe`/`#1e40af` | `#e1eeff`/`#00405e` | |
| neutral badge | `#e7e5e4`/`#44403c` | `#ededed`/`#616161` | |
| `--r-ctl` | `6px` | `8px` | controls |
| `--r-card` | `10px` | `12px` | cards |
| `--r-chip` | `999px` | `8px` | Polaris badges are 8px rounded rects, not pills |
| `--fs-base` | `14px` | `13px` (20px line) | Polaris body density (also improves NL fit) |
| focus ring | green `#86efac` | `#005bd3` | Polaris focus indicator — high contrast on white & near-black |

Biggest visible shifts: **dark header → white header** with a green brand mark; **Send
button green → near-black brand** (green demoted to accent/success only, per spec); body
13px.

---

## Pass log

### Pass 1 — token-first retheme applied

**Changed:** `tokens.css` rewritten to the Polaris token set; `components.css` 21 primitive/chrome edits (white header + green brand mark, primary & **Send** → near-black `--brand`, Polaris badge tones, selection/hover green→grey/brand, subtle card shadow, off-palette hexes replaced, focus ring → Polaris blue `#005bd3`); `ui.js` asset version → `polaris1`. No HTML/logic/route/contract changes.

**Build/test:** `node --check views/ui.js` ✓. CSS brace balance ✓ (tokens 1/1, components 267/267). Boot smoke ✓ — stubbed server serves `/`, `/item/:id`, `/queue`, `/blocks`, `/audit`. Headless-Chromium render at 1440×900 + 390×844 + 360: **all scenes clean — 0 console errors/warnings, 0 horizontal overflow.**

**Defects found:**
- **P2-1 (responsive):** mobile was stacked panes — queue capped at 45vh above the detail, context dumped at the bottom — not the required single-column list→detail with a back affordance.
- **P2-2 (a11y):** mobile tap targets below 44px (queue tabs 32, seg 26, mini buttons 22, sort select 28, header links 16).
- Non-defect (test env only): emoji glyphs (📎 attachment, voicemail icon) render as tofu in the sandbox Chromium (no emoji font); they render normally on the team's browsers.

### Pass 2 — mobile list→detail + accessibility floor

**Changed:** `views/ui.js` `workPanes()` gains an optional sticky mobile **Back** bar + a `.has-item` marker; `routes/item.js` passes the Back label; `components.css` mobile `@media (max-width:1100px)` rewritten to a **pure-CSS `:has()` single-column list→detail** flow (queue is the list; tapping an item shows the detail full-screen with a sticky Back bar; works with htmx swaps and without JS); touch targets raised to **≥44px**; the in-detail `.backrow` link hidden on mobile (the sticky bar replaces it); header links → 44px.

**Build/test:** `node --check` ui.js + item.js ✓. Braces 280/280 ✓. Render: desktop 1440 still 3-pane (unchanged); mobile 390/360 now list→detail; deep-link `/item/:id` and htmx card-tap both resolve to full-screen detail; **0 console errors, 0 horizontal overflow** at every viewport. Tap-target re-probe: seg/tab/mini/select/compose/sync/header-links all **44px**. Keyboard focus ring = Polaris blue `#005bd3`, visible.

**Defects fixed:** P2-1 ✓ (list→detail), P2-2 ✓ (44px), P3 duplicate Back link on mobile ✓ (hidden). No new P1/P2.
