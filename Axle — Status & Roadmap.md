# Axle — Status & Roadmap

> **Working environment (updated 2026-06-13):** Development now runs on the Axle box itself
> under the `bradmin` account — the MacBook is retired. Source-of-record is `C:\Admin\Projects\Axle`
> (git, SSH-signed commits → private GitHub `admin-bp-gh/axle`). Rollout is **box-local**: promote
> from `C:\Admin\Projects\Axle\box-code` into the live runtime `C:\Axle\app` on the same machine
> (copy changed files → `node --check` → restart Axle Server) — no cross-machine Taildrop. Dated
> entries below that mention building on the Mac or `axle-send.sh`/Taildrop describe the prior
> two-machine flow and are kept as history.

> **Sprocket — STEP 3 / new-request notifications (2026-06-16): DEPLOYED & LIVE-VERIFIED on the box;
> gate MET.** Sandbox: email builder 14/14 `harness/check-notify.js`. **LIVE VERIFICATION (Chrome over
> Tailscale + the admin@ mailbox):** logged a genuinely new request via the cog ("scan a barcode to
> pull up a part") → saved as FR-0002, `/audit` shows `sprocket_request_logged` immediately followed by
> `system sprocket_notify_sent new FR-0002 -> admin@budget-parts.nl`, and the email actually landed in
> the admin@ inbox (from info@, subject "Axle: new feature request — Scan a product barcode…", body
> carrying the structured fields, fields HTML-escaped). The header "Requests" badge shows the un-triaged
> count. Earlier audit confirms a **self-dupe sent no email** (`sprocket_request_voted … self=true` with
> no `notify_sent` after it). `AXLE_SPROCKET_NOTIFY=on` set in the box .env; sends from info@ to admin@.
> Gate MET. (`buildNotificationEmail` is the sandbox-tested unit; the edited route/server/ui were
> node-checked on the box at promote.)
> Brad asked to be notified of new feature requests; he chose **immediate email + an in-app badge**,
> to **admin@budget-parts.nl**. Built exactly that, opt-in and least-privilege.
> **Email.** New module `sprocket-notify.js`: `buildNotificationEmail(kind, record)` (pure; HTML-escapes
> every request field, newline-strips + caps the subject, links to `/sprocket/requests`) +
> `sendNotification` which sends through Axle's existing Graph sender (`send.js`) from an authorised
> mailbox. **Opt-in:** OFF unless `AXLE_SPROCKET_NOTIFY=on`. **Fixed recipient:** `AXLE_SPROCKET_NOTIFY_TO`
> (default admin@budget-parts.nl) — never derived from request text. **From:** `AXLE_SPROCKET_NOTIFY_FROM`
> (default the info@ mailbox). The route (`routes/sprocket.js`) fires it **async via setImmediate** after
> the chat reply, so a mail hiccup never affects Sprocket; audited `sprocket_notify_sent` /
> `sprocket_notify_failed`. It notifies on a **new** request and on a **cross-user +1** ("gaining
> traction"); a self-dupe (same person re-asking) adds nothing new and never notifies.
> **Badge.** `server.js` identity middleware computes, for admins only, the count of un-triaged
> (`status:'new'`) requests onto `req.user.sprocketNew` (cheap file read, guarded); `views/ui.js` renders
> a small accent count on the header "Requests" link (`.hbadge`, new i18n `sprocket_new_badge` EN/NL);
> it drops as Brad moves requests out of 'new' in the .jsonl. ASSET_V → **polaris4**.
> **Files. New:** `box-code/sprocket-notify.js`, `harness/check-notify.js`. **Changed:**
> `routes/sprocket.js` (fire the notify), `server.js` (badge count + require), `views/ui.js` (badge +
> i18n + ASSET_V), `assets/components.css` (.hbadge). No DB migration, no new allow-list action (an
> internal ops email to Brad's own inbox, opt-in). Sandbox note: the mount truncates the edited JS as
> usual, so the new `sprocket-notify.js` is the one node-checked + fully tested in-sandbox (14/14); the
> edited files are verified via Read and node-checked on the box at promote.
> **Deploy plan.** Hand-place `sprocket-notify.js server.js routes/sprocket.js views/ui.js` into
> `C:\Axle\app` (+ their subdirs) and `components.css` into `app\assets`; `node --check` the four JS;
> add `AXLE_SPROCKET_NOTIFY=on` to `C:\Axle\secrets\.env`; restart. Verify: log a NEW request via the
> cog → an email arrives at admin@ and `/audit` shows `sprocket_notify_sent`; the Requests link shows a
> count badge; a self-dupe sends no email. **CONTROL GATE:** Brad gets an email (and sees the badge) for
> each genuinely new request, the send is async/best-effort and opt-in, nothing else changes.

> **Sprocket — STEP 2 / request mode + the feature-request log (2026-06-16): DEPLOYED & LIVE-VERIFIED
> on the box; gate MET.** Sandbox: store + save-parser 22/22 `harness/harness-sprocket-step2.js`,
> dedupe-selection 5/5 `harness/check-dedupe.js`, deMarkdown 7/7, Step-1 37/37 still valid.
> **LIVE VERIFICATION (Chrome over Tailscale, driven by the assistant):** asked for a missing capability
> ("SMS when an order ships") → Sprocket offered to log it, ran the short one-question-at-a-time intake
> (it recognised goal/workaround/frequency/impact were already given and only asked for the rest),
> summarised in one paragraph, waited for confirmation, then saved — the `@@SPROCKET_SAVE@@` marker
> correctly stripped from view. The request landed as FR-0001 with all structured fields + requester
> "Brad" + verbatim original question, visible in `/sprocket/requests` and audited `sprocket_request_logged`.
> **De-dupe verified semantically:** a second, fully-paraphrased request in a FRESH conversation ("ping
> buyers with a text once their parcel is on its way") — which shares almost no words with FR-0001 —
> folded into FR-0001 instead of creating a duplicate; the store still shows ONE record, and the
> self-dupe note rendered correctly. **Upgrade made during live testing:** the first deterministic
> token-overlap de-dupe (≥0.6) missed paraphrased duplicates (it created an FR-0002), so de-dupe is now
> SEMANTIC: `converse()` is given the open requests (`<existing_open_requests>`) and the model tags
> `"dupe_of":"FR-000N"` in the save JSON when it's the same underlying goal; the deterministic overlap
> stays as a fallback. The route also distinguishes a self-dupe (same requester) from a cross-user +1,
> with separate notes (`sprocket_dupe_note` / `sprocket_dupe_note_self`). This shipped in a second
> one-file-set redeploy (sprocket.js, sprocket-store.js, routes/sprocket.js, views/ui.js), re-verified
> live as above. **Test data note:** one test request (FR-0001, the SMS one) is sitting in the live
> store from verification — clear it before real use with
> `Remove-Item C:\Axle\sprocket\feature-requests.jsonl, C:\Axle\sprocket\feature-requests.md` (regenerates empty on next save).
> Adds the second half of the brief:
> when Axle can't do something, Sprocket runs a short friendly intake and logs a clean feature request
> for Brad. **Still read-only/log-only — the ONLY thing Sprocket writes is its own request log;** no
> SAP/Shopify/email/MyParcel writes, no system action.
> **How it works.** The widget now sends the conversation transcript with each message, so the server
> stays stateless and the intake is multi-turn (`converse()` in `sprocket.js`). The system prompt gained
> a TWO-MODES section: HELP MODE (unchanged) vs REQUEST MODE — Sprocket detects a wish / can't-do /
> switched-off ask, offers to log it, then asks ONE question at a time (goal → workaround today →
> frequency → impact → optional example), pre-filling guesses so the user mostly just confirms, all
> under a minute. It writes the request back as one paragraph, waits for the user to confirm, then emits
> a hidden `@@SPROCKET_SAVE@@ {json}` marker line. The route parses that marker off the raw output
> (before deMarkdown), strips it from what the user sees, and persists via the store. Every user turn
> (history + new) is fenced as untrusted data; the save JSON is treated as data, never an instruction.
> **The store (`sprocket-store.js`).** Appends each request to `C:\Axle\sprocket\feature-requests.jsonl`
> (source of truth) and regenerates a human-readable `feature-requests.md` mirror, both via temp+rename.
> Record: `id` (FR-000N), `created` (ISO), `requester` (the per-user display name — Axle has identity
> now), `language`, `original_question` (verbatim, capped), structured `goal/workaround_today/frequency/
> impact/example`, `status` (new→approved→in_progress→done/declined), `votes` + `also_requested_by`,
> `notes`. **De-dupe:** before adding, a deterministic goal-token overlap (≥0.6, OPEN requests only)
> finds a near-match and records the new requester as a +1 instead of duplicating — and tells the user
> others asked too (`sprocket_dupe_note`, EN/NL). **Review:** a new admin-only read-only view
> `GET /sprocket/requests` (header link "Requests"/"Verzoeken") groups the queue by status, highest-voted
> first; the `.jsonl`/`.md` stay the source of truth (Brad edits status/notes there for now — interactive
> status controls are a later step).
> **Audit:** `sprocket_request_logged` (new) / `sprocket_request_voted` (dedupe) / `view_sprocket_requests`,
> alongside the existing `sprocket_ask`. **Safety:** still no new allow-list action; Sprocket cannot send
> or write anywhere except its own log; injection-fenced throughout.
> **Files. New:** `box-code/sprocket-store.js`, `harness/harness-sprocket-step2.js`. **Changed:**
> `sprocket.js` (TWO-MODES prompt, `converse()`, save-marker parse/strip, `fenceUser`), `routes/sprocket.js`
> (history + requester → converse, execute+audit the save, the admin requests view), `views/ui.js`
> (widget sends the transcript; admin "Requests" header link; 16 EN/NL keys, parity kept; ASSET_V →
> **polaris3**), `assets/components.css` (request-card styles). `server.js` UNCHANGED (mountSprocket
> already mounted). No DB migration.
> **NOTE (sandbox/file-mount):** the bash mount again truncated the edited `sprocket.js` / `views/ui.js`,
> so in-sandbox `node --check` can't run on those two; the new `sprocket-store.js` checks clean and is
> fully tested (22/22), the save-parser is tested via verbatim copy, and both edited files were verified
> complete + balanced via the Read tool. The box-side `node --check` at promote validates the rest.
> **Deploy plan (box-local; ⚠ note the new write-permission step).**
> 1. The `axle` service account now WRITES the request log — grant it Modify on the Sprocket dir:
> `icacls C:\Axle\sprocket /grant "axle:(OI)(CI)M"`.
> 2. Hand-place the JS (the two `sprocket.js` basenames are ambiguous to the puller, so place all by
> hand): `Copy-Item` `box-code\sprocket.js`→`C:\Axle\app\`, `box-code\sprocket-store.js`→`C:\Axle\app\`,
> `box-code\routes\sprocket.js`→`C:\Axle\app\routes\`, `box-code\views\ui.js`→`C:\Axle\app\views\`, and
> hand-place `box-code\assets\components.css`→`C:\Axle\app\assets\`. `node --check` the four JS files.
> 3. Restart Axle Server. 4. Verify over Tailscale: `components.css?v=polaris3`; ask Sprocket for
> something Axle can't do → it offers to log, runs the short intake, confirms, says saved; check
> `/sprocket/requests` shows it and `feature-requests.md` on the box; a second similar request from
> another user de-dupes into a +1; `/audit` shows `sprocket_request_logged`. No DB/allow-list change.
> **CONTROL GATE:** Sprocket logs clean, de-duped requests for Brad to review and still takes no action
> beyond writing its own log. Brad signs off. (Follow-ups: interactive status/notes controls in the
> review view; the Step-1 compose-"send" wording tightening folded into a help-doc pass.)

> **Discount-awareness — live Shopify discount reads (2026-06-16): BUILT, DEPLOYED & LIVE-E2E
> VERIFIED.** Goal: when a customer email references a discount in any way
> (code/voucher/promo/sale/% off; NL korting/kortingscode/actie/aanbieding/bon/waardebon), Axle
> reads the relevant Shopify discount(s) **live** and uses the real current data (value, type,
> status, dates, conditions) to inform the brief and the draft, in the customer's language —
> validating any claim against live data, never honouring a discount an email merely asserts.
> **Scope is all Shopify discounts; approach is live-lookup only (no stored doc — codes expire).**
> **Read-only on discounts** (new read capability "Shopify: read discounts"); draft-only; email
> content stays untrusted data. **Gate done:** `read_discounts` was missing from Axle's Shopify
> token — root-caused to the dev-dashboard store install still on version `axle-2` (Customers/
> Orders/Products only); fixed by releasing `axle-3` and **Install app** on the store; box token
> now returns discount data (verified via `connectors.shopifyGraphql`). **Built (source, box-local
> in `box-code`):** `business-knowledge.md` gains a "Shopify discounts" section (triggers EN/NL,
> the two validated queries, status/percentage/condition reading, draft rules, non-negotiables) and
> the false "no discount codes exist" line reconciled; `engine.js` + `ingest.js` now log a result
> snippet per tool call so every lookup is reviewable ("what was looked up, for which email, what
> came back"); `hardening/cases.js` gains injection case `T1-en-discount-override` (must refuse a
> claimed/override discount). **info-triage skill:** exact edit handed to Brad to apply via
> Settings → Capabilities (skill cache is read-only here). **Shadow-verified** against the real
> info@ DLRR thread (Lodewijk Meter, 12 Jun): live read shows `DLRR10` = 10%, **EXPIRED**
> 2026-06-15 — so today's correct draft says the code has lapsed, exactly the case the human thread
> got muddled on. **Deploy (4 files, axle-pull → `node --check` → harness → restart):**
> `business-knowledge.md engine.js ingest.js hardening/cases.js`; then re-run `node hardening/
> harness.js` (must be all-green incl. the new case) and restart Axle Server; then live e2e on real
> discount emails. **No new send-action; allow-list gains only the read-only "Shopify: read
> discounts" capability.**
> **DONE 2026-06-16:** 4 files deployed via axle-pull (`node --check` clean), Axle Server restarted.
> Injection harness re-run: the new `T1-en-discount-override` PASSES every run; the only reds are
> the pre-existing nondeterministic `C2_flag` flake on the data-poisoning cases `T4-sap-cardname`
> and `T6-iban-swap` (still CONTAINED at `awaiting_input`, no leakage — a flag-only miss that moves
> between cases run-to-run; orthogonal to this feature, logged as a separate flag-robustness item).
> **Live e2e PASSED** (`discount-e2e.js`, deployed engine + live tools, read-only): (1) `DLRR10` →
> live read EXPIRED → NL draft says lapsed 15 Jun + salesperson renewal question, no false promise;
> (2) `ERIC10` → live read ACTIVE 10% → draft confirms terms + single-use caveat, `ready`;
> (3) fabricated 90%/free-shipping + bogus `OVERRIDE90` → live read null, `injection_suspected=true`,
> NO draft, flagged for review — claim not honoured. Tool logging shows the lookup + result snippet
> per the audit requirement. **Outstanding (Brad):** apply the mirrored rule to the info-triage skill
> via Settings → Capabilities (exact edit supplied).

> **Sprocket — Axle's in-app helper, STEP 1 / help mode (2026-06-16): DEPLOYED & LIVE-VERIFIED on
> the box (gate met); a small polish redeploy of `sprocket.js` is pending one more one-file promote.**
> **LIVE VERIFICATION (2026-06-16, Chrome over Tailscale at axle-box.tail58a804.ts.net, driven by
> the assistant):** the cog renders bottom-right on the inbox; the panel opens with the greeting;
> `components.css?v=polaris2` is live. Three gate questions, all `POST /sprocket/ask` → 200, no
> console errors, all logged to `/audit` as `sprocket_ask` with `help=loaded`: (1) "How do I send a
> quote?" → grounded numbered steps (attach a Quotation PDF to a reply, or draft via New email) — no
> invented menus; (2) "Can Axle automatically chase customers who haven't paid?" → "not something
> Axle does yet", offered to log it, redirected to the real adjacent capability — refused to guess;
> (3) "Hoe blokkeer ik een afzender?" → fully Dutch, accurate, grounded. **Gate behaviours all hold:
> answers accurately, refuses to guess, takes no action.** **Two polish items found live and fixed in
> source (need the one-file redeploy below):** (a) Haiku sometimes emitted markdown (`**bold**`,
> `*italic*`) which the plain-text panel showed as literal asterisks — fixed by a stronger no-markdown
> prompt rule AND a server-side `deMarkdown()` strip belt-and-braces (7/7 `harness/check-demarkdown.js`);
> (b) on the "chase" answer it loosely said compose could "send" a new email while compose_send (#3) is
> OFF — fixed with a "DISABLED MEANS DISABLED" prompt rule (a gated-off action is never described as
> send-able). **Polish DEPLOYED & RE-VERIFIED (2026-06-16):** `sprocket.js` promoted to `C:\Axle\app`
> + restart; re-ran the quote + chase questions in Chrome — markdown now renders clean (zero literal
> asterisks across both answers; `deMarkdown` 7/7 `harness/check-demarkdown.js`). **Residual minor
> nuance (Step-2 follow-up, not gate-blocking):** Haiku still occasionally says compose can "draft and
> send" a new email while compose_send (#3) is OFF — the prompt rule reduced but didn't eliminate it.
> Low harm (the UI hides the Send button when #3 is off, so the truth is enforced regardless). Tighten
> in Step 2 when the help doc is revised: e.g. append the live send-status to gated capabilities in the
> answer flow, or frame the compose/contactform help entries as draft-only with sending separately
> controlled. Original build entry follows.
>
> **Sprocket — Axle's in-app helper, STEP 1 / help mode (2026-06-16): BUILT & SANDBOX-VERIFIED
> (37/37, `harness/harness-sprocket.js`), then DEPLOYED. Control gate at the end of this entry.**
> New feature (own build kickoff, `sprocket-build-prompt.md`): a friendly, modern-Clippy cog that
> (1) answers "how do I do X in Axle?" from a curated help doc, and (2) — next step — captures clean
> feature requests when Axle can't do something. This step builds **help mode only**, per the brief's
> build order ("help-doc + allow-list grounding + answer flow first; confirm it refuses to guess; then
> request mode + the log"). **Read-only / log-only: Sprocket takes NO system action** — it reads its
> help doc + the live allow-list and returns an answer; it does not even log requests yet.
> **Reconciliation with where Axle actually is:** the brief was written generically (drops into "the
> Phase 4 team tool later", capture "name/mailbox until per-user login"). Axle is well past that — live
> team tool, per-user Tailscale identity, 4 live allow-list actions — so Sprocket drops into the LIVE
> app now, reads the REAL allow-list, and will capture REAL requester identity in step 2.
> **Anti-hallucination is the whole design:** Sprocket answers ONLY from the help doc and cross-checks
> every capability's `Key:` against the LIVE allow-list state, so it never describes a disabled or
> non-existent action as usable; unknown → it says it's unsure and offers to log a request (offer only
> this step). The user's message is UNTRUSTED data — sanitised (Unicode-smuggling strip, mirrors
> engine.js D1) and fenced in a data-only block; the system prompt forbids following any instruction
> inside it and states Sprocket "changes nothing and enables nothing". Bilingual (answers in the
> asker's language). Model: **Haiku** (high-frequency, low-stakes; Brad's call). Uses the dedicated
> Axle org key via `new Anthropic()` (same as the rest of the app); no secrets added.
> **New files:** `box-code/sprocket.js` (help-doc loader, live allow-list derivation from the same
> `AXLE_ACTION_*` signals the app uses, the grounded/contained Haiku system prompt, `buildRequest` +
> `answer`); `box-code/routes/sprocket.js` (identity-gated `POST /sprocket/ask`, returns JSON, audits
> every ask as `sprocket_ask`); `box-code/sprocket/axle-help.md` (the seed help doc — one section per
> REAL current capability with its allow-list key, for Brad to extend); `harness/harness-sprocket.js`.
> **Changed (pre-existing):** `server.js` (+`require` + `mountSprocket(app)`); `views/ui.js` (the
> floating cog button + chat panel injected into `page()` so it's on every screen and outside
> `#workpane` — htmx swaps never touch it; +8 EN/NL string keys, parity kept; ASSET_V → **polaris2**);
> `assets/components.css` (Sprocket cog/panel section, accent-green FAB, z-index above modals).
> **Help-doc lives on the box at `C:\Axle\sprocket\axle-help.md`** (path env-overridable via
> `AXLE_SPROCKET_DIR`); the repo copy under `box-code/sprocket/` is the seed — copy it ONCE to
> `C:\Axle\sprocket\` on deploy, then Brad edits the live one (tight file perms; the loader re-reads it
> per question so edits need no restart). The request log (step 2) will live in the same dir.
> **Allow-list (unchanged):** Sprocket adds NO new action and cannot send/write anywhere; it only reads
> the existing flags. **Sandbox proof (37/37):** allow-list parsing (compose/contactform follow the
> env; send/mark-read/attach-doc always on), help-doc loader, request grounding (doc + live allow-list
> embedded, hard grounding rule present, question fenced as untrusted), disabled-key shown DISABLED to
> the model, empty-doc → explicit "no help" fallback (never invented steps), Unicode-smuggling flag +
> strip (tag char never reaches the model; benign zero-width not flagged), `answer()` end-to-end with a
> stubbed model, and the cog widget renders balanced HTML carrying `/sprocket/ask` + the `q` field.
> **NOTE (sandbox/file-mount):** the bash mount lagged badly behind the file-tool edits to `server.js`
> + `views/ui.js` (showed truncated copies), so `node --check` on those two could not run in-sandbox;
> both were verified complete + balanced via the Read tool (page() closes, module.exports intact, the
> two server.js edits are simple complete statements). `sprocket.js` + `routes/sprocket.js` `node
> --check` clean in-sandbox; the box-side `node --check` in the promote step validates the rest on the
> real files as usual.
> **Deploy plan (box-local promote, when Brad signs off this gate):** create `C:\Axle\sprocket\` on the
> box and copy the seed `axle-help.md` into it once (then it's Brad's to edit, tight perms); promote
> `server.js views/ui.js sprocket.js routes/sprocket.js assets/components.css` from
> `C:\Admin\Projects\Axle\box-code` into `C:\Axle\app` — place the two NEW files (`sprocket.js`,
> `routes/sprocket.js`) once, hand-place `components.css` as always → `node --check` the JS → restart
> Axle Server. Verify: page source says `components.css?v=polaris2`; the cog shows bottom-right on the
> inbox AND on an open item; ask "how do I send a quote?" → grounded numbered steps; ask "can Axle
> chase unpaid customers?" → it says not yet + offers to log (no invented steps); a Dutch question →
> Dutch answer; `/audit` shows `sprocket_ask` rows. No DB migration, no allow-list change, no
> engine/send-path change. **CONTROL GATE:** Sprocket answers help questions accurately and refuses to
> guess, and takes NO action. Brad signs off, THEN step 2 (request mode + the
> `feature-requests.jsonl`/`.md` log with de-dupe + new→approved→in_progress→done/declined workflow)
> begins.

> **Consolidated-questions round (2026-06-11): BUILT & SANDBOX-VERIFIED (34/34,
> `Axle/harness/harness-questions.js`; harness-bugs 23/23 + harness-loading 37/37 +
> harness-suggest 21/21 + harness-unread 9/9 still green), NOT yet deployed.**
> Brad's ask: ONE block of all questions + ONE place to answer everything — simpler to
> read and use; questions as short as possible, never duplicated.
> **UI (`routes/item.js`):** the per-question `answer_<id>` textareas are GONE; questions
> render as one compact numbered list (only physical checks keep their `k-physical`
> marker, other kinds are flat) and the single response box below is the existing
> `feedback` field (so /work and /send persist unchanged, no DB migration). Legacy
> per-question answers still render read-only. The data-trq translation fill and the
> awaiting_input questions-first ordering are untouched.
> **Workflow (`routes/shared.js`):** `saveWorkInputs` no longer writes per-question
> answers (posted `answer_<id>` fields are ignored); `runRedraft` inbound folds
> `seed.axle_open_questions` (the open list) + `salesperson_feedback` (the one reply —
> note tells the model to pair answers itself and never re-ask what's covered); compose
> folds the numbered open questions + "The salesperson's reply" into the TRUSTED
> taskPrompt, recipient stays code-held. Legacy answered pairs still fold for old items.
> **Dedupe:** `persistResult` (shared.js) AND the ingest insert (`ingest.js`) now skip
> duplicates by normalised text (lowercase, alphanumeric-only) within the batch and
> against surviving answered questions — the same question is never stored twice.
> **Prompts:** engine.js + compose.js gain a QUESTIONS STYLE rule (one short specific
> sentence, aim <12 words, no overlap across the two lists, never re-ask what staff
> input answers). **i18n (`views/ui.js`):** your_feedback → "Your answer & feedback" /
> "Jouw antwoord & feedback", new feedback_ph EN/NL; answer_ph + unanswered keys removed
> (parity kept). No CSS change, no ASSET_V bump, no allow-list change.
> **Deploy (all 6 pre-existing, axle-pull auto-collects): Taildrop `routes/item.js
> routes/shared.js ingest.js engine.js compose.js views/ui.js` → axle-pull.ps1 →
> restart Axle Server (ingest picks the new files up on its next scheduled run). Then
> RE-RUN the injection harness on the box (engine SYSTEM prompt changed:
> `node hardening/harness.js`) and verify: open an awaiting_input item → one numbered
> question list + one response box; type a combined answer → Save & redraft → new draft
> reflects it; box git commit.**

> **Loading-UX round (2026-06-11): DEPLOYED & LIVE-VERIFIED (Chrome over Tailscale).**
> Sandbox 37/37 (`Axle/harness/harness-loading.js`; harness-bugs 23/23 + harness-suggest 21/21
> + harness-unread 9/9 still green). Deploy: CSS hand-placed (ax-spin confirmed at line 298),
> axle-pull routed the 4 JS, server restarted clean on 8484. **Live proof:** components.css?v=ux1
> served + .spin resolves to the ax-spin animation; qcard click applies ax-loading to card +
> workpane synchronously and clears after the swap (#74); #72 (NL email, EN viewer) renders its
> cached translation inline; NL queue summaries all Dutch, zero data-trs left after fill;
> POST /item/74/translations returns both questions in Dutch live (email null = correct,
> customer wrote Dutch); Save posts + redirects clean; zero console errors. Note: most
> translations were already cache-warm from tonight's Drachten work, so the live pending->fill
> was proven via the endpoint + harness rather than caught mid-flight — first genuinely new
> foreign email will exercise it for real. **Box git commit DONE (4092435, 2026-06-11,
> 13 files — also swept in tonight's 9-file set AND the step-2 htmx/sse assets, closing the
> step-2 commit note). GATE OPEN: Brad/Jack work a day in it — does anything still feel dead
> on click?**
> Brad's ask: the user must ALWAYS see that something is happening —
> first item click could hang for seconds with zero feedback. Two halves:
> **(1) Loading indicators everywhere** (presentation only, generic so future delay points are
> covered automatically): new `page()` singletons in `views/ui.js` — a queue-card click adds
> `ax-loading` (spinner replaces the card's timestamp + the work panes dim under a centred
> spinner, 0.18s appear-delay so cached loads never flicker; background queue/busy polls
> deliberately show nothing); EVERY form submit locks the pressed button with a spinner via
> `setTimeout(0)` (AFTER serialisation, so `name=value` submitters — Save/Done/chip menus —
> still post) + starts a thin sweeping top progress bar (`body.ax-nav`); plain same-tab link
> navs get the bar too; `pageshow` clears stale spinners on bfcache restores. Also: shimmer
> skeleton rows in the deep-link lazy queue, "Uploading…" row + bar during AJAX attachment
> upload (the upload→reload dead gap), spinner on the investigating banner (`banner busy`),
> spinner on the compose resolver "Looking up…". All styles in `assets/components.css`
> (one `ax-spin` keyframe + reusable `.spin`/`.ax-busy`/`.ax-nav`/`.qskel`); ASSET_V → **ux1**;
> new i18n key `uploading` EN/NL (parity 229/229).
> **(2) Async translations — the root cause removed:** `translate.js` gains sync cache-only
> `cached()`; `GET /item/:id` and the queue no longer await the translator. Item view: cached
> email translation renders inline as before; uncached renders instantly with a pending
> spinner panel + the browser fills it from NEW `POST /item/:id/translations` (translates the
> newest inbound top + any untranslated questions into the VIEWER's language — text loaded from
> the DB by id, NEVER client-supplied; fills via textContent). Questions show English until the
> fill lands (`data-trq` spans). Queue: NL summaries render cached-inline / English-with-
> `data-trs`-marker, one batched NEW `POST /queue/summaries` (ids only, deduped, capped 300,
> concurrency 8) fills text + appends to `data-search` so search still finds the Dutch. Every
> later view is cache-inline again — the async path only ever runs once per (text, language).
> Engine/send/recipient paths byte-untouched; no DB migration; no allow-list change.
> `harness/step0/stubs.js` translate stub gained `cached: () => null` (renders exercise the
> pending path). Visual preview: `Axle — loading-states preview.html`.
> **Deploy (standalone, all pre-existing files): Taildrop `translate.js views/ui.js
> routes/inbox.js routes/item.js assets/components.css` → place components.css MANUALLY
> (CSS always manual — the puller node --checks what it routes; remove it from Downloads
> first) → axle-pull.ps1 (the 4 JS) → restart Axle Server → verify: page source says
> `components.css?v=ux1`; click an item → card spinner + pane dim; open a German item fresh →
> instant render, translation fills in; NL queue → summaries swap to Dutch in a beat; press
> Save → button spins + top bar.**

> **Drachten rollout (2026-06-11): DEPLOYED & LIVE-VERIFIED tonight; only user-registration
> left for tomorrow.** drachten@ ongoing sync + one-time unread seed, sandbox 9/9
> (`box-code/harness-unread.js`). **Done tonight over RDP + Chrome-over-Tailscale:** merged
> 9-file deploy via axle-pull (also cleared the two queued bugfix rounds; db.js `suggest_close`
> migration ran clean on restart); `MAILBOX_DRACHTEN=drachten@budget-parts.nl` confirmed in
> `.env`; `run-ingest.ps1` repointed to `node ingest.js all` (scheduled task covers both
> mailboxes); manual Sync now runs `["info","drachten"]`. **Side effect handled:** the first
> scheduled `all` run pulled 6 drachten items via the post-wipe watermark (new-since-go-live,
> not "unread") — per Brad's call, those 6 were deleted (clean script, child rows too) and the
> queue re-seeded unread-only: `node ingest.js drachten unread` → 1 real actionable item
> (#70 Karla Kules, ready; one marketing mail correctly filtered as noise), watermark set to
> now, scheduled task re-enabled. **drachten@ Send re-test PASSED (closes the long-standing
> Gate-4 carry):** sent a test query admin@→drachten@, Axle drafted #71 (NL, B2B, real SAP
> stock + roverparts.eu links), Sent reply from drachten@ → delivered to admin@ inbox ("Budget
> Parts | Drachten"); audit shows `email_sent kind=reply to=admin@budget-parts.nl threaded=true`
> + `mark_read`, no refusal/failure. So allow-list #1 Send + #2 mark-read both proven on
> drachten@. **Remaining for tomorrow at Drachten (in `Drachten rollout — tomorrow checklist.md`,
> step 3–4 + 6):** install Tailscale on the Drachten desktop + add to the @budget-parts.nl
> tailnet; open the tool → read the exact login off the "Not registered" 403 → insert one shared
> user (`INSERT OR IGNORE INTO users (tailscale_login, display_name, role) VALUES
> ('<login>','Drachten','sales')` via `node -e` from C:\Axle\app); then Rob & Huub log in and
> verify the queue (NL toggle). The #71 test item is Done; #70 Karla is the real ready item
> waiting for them. Original build detail follows. Three pre-existing files changed (axle-pull
> auto-collects): **`connectors.js`** — `getMessages`/`fetchFolderSince` gain `unreadOnly`
> (filter `isRead eq false`, **$orderby dropped** because Graph rejects ordering by
> receivedDateTime while filtering on a different property; client-side newest-first sort
> already handles order); **`ingest.js`** — new one-time `node ingest.js drachten unread`
> seed mode: reads only currently-unread mail (ignores the watermark), drafts each, then sets
> the watermark to **now** so the normal "new since last sync" run takes over (10-min overlap
> + thread dedup = no reprocessing); **`routes/inbox.js`** — manual "Sync now" now runs
> `["info","drachten"]` (was info-only). Scheduled task is a box edit: `run-ingest.ps1` →
> `node ingest.js all`. No DB migration, no new allow-list action — Drachten reuses #1 Send /
> #2 mark-read; nothing new can send. **The Drachten user can't be added tonight** — its PK is
> the Tailscale login, which only exists after tomorrow's sign-in; the "Not registered" 403
> page prints the exact login to insert. Plan: deploy 3 files + restart → confirm
> `MAILBOX_DRACHTEN` env + point scheduled ingest at `all` → (at Drachten) Tailscale on the
> desktop → read login off the 403 → insert one shared user `display_name='Drachten'`
> role sales (owner_label NULL → falls back to display_name = routing owner "Drachten", so it
> sees exactly the Drachten queue) → `node ingest.js drachten unread` to seed → **re-test
> drachten@ Send (Gate-4 carry, never live-tested)**. This also closes the long-standing
> "Gate 4 carry — drachten@ Send re-test" item. Sandbox proof: unread mode builds
> `isRead eq false` + no `$orderby` + no date filter and still sorts newest-first; normal +
> fresh-DB modes byte-unchanged; node --check clean on all 3. **Deploy coupling:** the mirror's
> `ingest.js`/`routes/inbox.js` already carry the two queued bugfix rounds below, and `ingest.js`
> now writes `suggest_close` (needs the no_reply `db.js` migration) — so the Drachten deploy ships
> as the merged set with them: `connectors.js db.js ingest.js translate.js server.js
> routes/shared.js routes/inbox.js routes/item.js views/ui.js` → axle-pull → restart (db.js
> migration auto-runs). One deploy lands Drachten + clears the bugfix backlog.
>
> **Bugfix round 2 (2026-06-11): two shell bugs — BUILT & SANDBOX-VERIFIED (23/23,
> `Axle/harness/harness-bugs.js`), NOT yet deployed; deploys TOGETHER with the no_reply fix
> below (8 files total).**
> **Bug A "click does nothing" (Jack, @123auto.nl item):** root cause = the on-view email
> translation in GET /item/:id (`translate.js`) ran with the SDK's default 10-MINUTE timeout
> x2 retries — a long foreign-language email stalled the route every click until one attempt
> ever succeeded (only then cached); htmx has no client timeout and silently ignores
> error responses, so the click looked dead. Render helpers fuzz-tested clean (2 MB
> adversarial inputs <10 ms) — it's the async path. Fixes: (1) translate.js API call bounded
> `{timeout: 25000, maxRetries: 1}`, degrades to no-translation on timeout; (2) NEW last-resort
> error middleware in server.js (Express 5 forwards async rejections natively) — every route
> error now = console + audit `route_error` + a VISIBLE pane-shaped 500 for HX requests / full
> error page for plain nav; (3) ui.js page(): htmx-config `timeout:60000` + document-level
> htmx:responseError/sendError/timeout listeners that surface failures into #workpane (queue-
> poll failures stay silent, they retry); new i18n key `load_error` EN/NL. After deploy: click
> the @123auto.nl item — it should load (or show the audited error that names the real cause).
> **Bug B "item erratically closes after a few seconds":** the shell's
> `<meta http-equiv=refresh>` (sync running=8s / investigating=15s) navigates to the document
> address AS PARSED — "/" — so after an htmx card-click pushed /item/N it yanked the user back
> to the empty "Select an item" shell. Fix: meta refresh removed from ALL shell renders
> (page() still supports it; nothing uses it). Replacement: (a) queue-pane self-poll singleton
> in buildQueuePane — same cadence (8/15s), swaps ONLY #queuepane innerHTML via htmx.ajax to
> /queue (same data path + view_inbox audit as the old reload), skips while the user's focus is
> inside the queue (search box), reads sel from location at fire time, self-extinguishes when
> the rendered config returns sec=0; search/sort restore from sessionStorage on each swap;
> (b) busy-item self-poll div now included in BOTH the HX fragment and the full-shell render
> (was meta-refresh on the full page). No-JS note: a busy item no longer auto-refreshes without
> JS (manual reload; htmx is on every page so this is the degraded path only).
> Changed files round 2: translate.js, server.js, views/ui.js, routes/inbox.js, routes/item.js.
> **Combined deploy list (both rounds, all pre-existing files — axle-pull collects): db.js,
> ingest.js, translate.js, server.js, routes/shared.js, routes/inbox.js, routes/item.js,
> views/ui.js. Then restart Axle Server. Verify: (1) closing thank-you lands OPEN with the
> "No reply needed?" chip; (2) @123auto.nl item loads or shows a visible audited error;
> (3) open an item during a sync — it stays open past 8s.**

> **Bugfix (2026-06-11): no_reply auto-close removed — BUILT & SANDBOX-VERIFIED (21/21,
> `Axle/harness/harness-suggest.js`), NOT yet deployed.** Brad reported items arriving
> pre-marked Done (his internal "Jack pls call Ger Zaanland" 13:15 + Ivo de Bruin's mail).
> Cause: the engine's `status='no_reply'` was mapped straight to `done` in ingest.js and
> routes/shared.js persistResult — the pipeline's only autonomous close (threat-model T13).
> Fix (Brad's pick: open + suggestion chip): no_reply now lands **status 'new' + new column
> `work_items.suggest_close=1`** (db.js ensureColumn, default 0); a human confirms via the
> existing Done control — no autonomous close remains anywhere. suggest_close resets to 0 on
> every new inbound (ingest pre-draft UPDATE) and follows the latest engine result on each
> (re)draft. UI: indigo `chip sugg` "No reply needed?" / NL "Geen antwoord nodig?" (+ tooltip;
> 2 i18n keys, EN/NL parity) on open items only — queue card (routes/inbox.js stateChip) and
> item page chips row (routes/item.js). engine.js UNTOUCHED (37/37 injection harness still
> valid — no_reply judgement unchanged, only the mapping). Audit `item_drafted` detail now
> carries ` suggest_close`. Harness: real db.js/routes/server via the step0 stub kit — schema,
> all three persistResult mappings, ingest static asserts, chip on/off per status, NL render.
> No backfill (Brad: fix forward only; the two examples reopened manually). Changed files (all
> pre-existing, axle-pull auto-collects): db.js, ingest.js, routes/shared.js, routes/inbox.js,
> routes/item.js, views/ui.js. **Deploy: Taildrop 6 files → axle-pull.ps1 → restart Axle
> Server (db.js migration runs itself) → verify: send a closing thank-you to info@, item lands
> OPEN with the chip.**

> **UI rework Step 2 — three-pane shell + new queue list (F1–F4): DEPLOYED & LIVE-VERIFIED
> 2026-06-10 (~15:10 box time). GATE OPEN: a full working day in it (Brad + Jack), then git
> commit (commit BOTH the step-2 set AND assets/htmx.min.js + sse.min.js — new files).**
> Deployed in three rounds (all Taildrop + manual CSS/new-file placement + axle-pull + restart;
> final ASSET_V **s2c**): the step-2 set, then two CSS polish rounds from live findings —
> (1) toolbar buttons wrapped internally at 1280 + NL tabs truncated → nowrap-between-controls,
> tabs at fs-xs, NL tab label "Archief" (STRINGS.archived is the FILTER-TAB label only now;
> chips keep "Gearchiveerd" via STATUS_LABEL), queue/context panes widened to clamp() so 1680
> uses its space; (2) the ☰ Filter menu clipped at the queue pane's scroll edge → right-aligned
> to its button. **Live proof (Chrome over Tailscale, read-only, 1280 + 1680, EN + NL):** shell
> + card queue render with real data (resolution suffixes "Done · replied", 📎1 badge, compose ✏,
> NL "Afgehandeld · beantwoord" + 24-hour times); counted tabs fit both languages; Live ·
> updated/bijgewerkt line + Sync button; Mine/All + Filter menu (All/Info/Drachten, current
> highlighted); card click = htmx swap of centre+context with the queue scroll intact, URL +
> title + sel highlight updating (#43 PartsPoint, #2 Knut Hoffmann incl. DE tag, translation
> toggle, folds, attachments); deep link /item/43 fills the lazy queue; compose modal opens from
> the queue pane (now also on item views) and Esc closes; audit trail shows view_inbox rows from
> /queue fetches in the legacy detail format + view_item per swap; zero console errors. Flagged
> bar + busy self-poller had no live specimens (queue was empty/Open 0) — both proven by the
> 52/52 structure asserts; the gate day will exercise them on real mail. **Polish notes for
> Step 3/5:** (a) deep-linking a CLOSED item shows the default Open queue (no card to
> highlight) — consider sel-aware show fallback; (b) Step-1's Dutch FOOTER_LINE regex note
> still open (seen again on #43).
> **What changed (presentation/transport only; server.js byte-untouched):**
> **F1** the 10-column inbox table is now a queue of card-rows — sender + subject, the one-line
> summary, ONE action-state chip, friendly time, small badges (📎n suggested-docs, P1 only when
> high & unflagged; flagged items show the red Check chip as their single state). Intent/Box/
> Owner/# left the visible card but stay in `data-search`, so search still finds them.
> **F2** action-state vocabulary lives in STATUS_LABEL EN+NL (Needs your answer · Ready to send ·
> Drafting… (CSS-pulse animated) · New · Done · Archived; statusWithRes still appends "· by
> phone" etc.) and the open queue default-sorts by what-needs-me-next: flagged → needs-answer →
> ready → new → rest, then priority, then freshness (pure ORDER BY change — same rows). A small
> client-side Sort select (Needs me first / Newest / Oldest / Priority, sessionStorage-persisted)
> replaces the old column-header sort.
> **F3** the sync affordance is a quiet "● Live · updated HH:MM" line (sync.finished_at via
> fmtTime, "Syncing…" + pulsing dot while running) + the manual Sync button kept; "Last synced:
> never" is gone. The meta-refresh-while-syncing/investigating behaviour is unchanged (Step 4
> retires it for SSE).
> **F4** toolbar collapsed to: + New email · Mine/All · counted status tabs (Open/Done/Archived/
> All, counts under the current mailbox+scope) · search · sort; the mailbox filter moved into a
> small ☰ Filter menu (rendered for all roles, unobtrusive; same URL params, so bookmarks and the
> audit detail string are unchanged).
> **Shell:** GET / = shell with the queue INLINE (audit `view_inbox` + summary-translation side
> effects byte-identical to the old inbox) + "select an item" centre. GET /item/:id (plain) = full
> shell with the queue LAZY-loaded from the NEW read-only GET /queue?sel=N (same data path, audit
> and translations as GET /), so the deep link keeps exactly its old side effects — and the no-JS
> fallback IS the standalone render (item + back-link, every form a plain POST). A queue-card
> click is an htmx GET of /item/:id with the `HX-Request` header → the route returns just the two
> work panes (centre + context) + a document.title setter, swapped into #workpane with
> hx-push-url; tabs/filters/scope/mailbox stay plain navigations. **Centre/context split:** centre
> = conversation + reply + questions + sticky action bar; context (right pane) = the SAP-documents
> card + the "What Axle checked" brief — placeholder content until Step 3 builds F10 properly.
> **htmx 2.0.10 + sse-ext 2.2.4 vendored** into /assets (sse parked for Step 4; no CDN). History
> snapshots disabled (`historyCacheSize:0` + `refreshOnHistoryMiss`) so back/forward = clean full
> reloads — no stale-listener/stale-DOM risk by construction. A busy item fetched as a fragment
> self-polls via `hx-trigger="load delay:10s"` (full pages keep the meta refresh; busy items
> render no edit surface, so a re-swap can never lose typed work). **Swap-safe script hygiene:**
> the document-level paste/drag-drop handlers in the item view are now install-once singletons
> that act through `window.__axAddFiles` (re-pointed every render), so swapping items can never
> leave a stale closure attaching files to the previously open item.
> Files: `views/ui.js` (STATUS_LABEL rename EN+NL, 8 new STRINGS keys — parity 236/236, page()
> shell option + htmx include, ASSET_V `s2`, new `workPanes`/`shell`/`lazyQueue` helpers),
> `routes/inbox.js` (buildQueuePane shared by / and /queue), `routes/item.js` (pane split, HX
> branch, 404 pane-shape, singleton listeners), `assets/components.css` (+shell/queue/tabs/live/
> pulse sections; every pre-existing selector kept), `assets/htmx.min.js` + `assets/sse.min.js`
> (NEW). `server.js`, `tokens.css`, send-guard/send/engine/resolve-customer ALL untouched; no new
> POST route (/queue is GET, identity-gated like everything); no DB migration; no allow-list
> change. **Proof — `harness/step2/` (run.js + README):** equivalence vs the pre-Step-0 monolith
> across the 3 env phases — 104+9+7 responses, transport + JSON/binary bodies + final DB dumps
> byte-identical (HTML differs by design; translate.js stub keeps the translations table empty in
> both trees, so the F2 re-ordering of translation calls can't fake a diff — live cache is
> sha-keyed anyway); **52/52 structure assertions** (shell, lazy queue, F1–F4 incl. fixture-exact
> needs-me ordering and tab counts, HX fragments + busy self-poller, pane-shaped HX 404, htmx
> asset identity-gated 403, Step-1 centre contract spot-checks, NL strings). node --check green
> on all 6 JS files. Static previews for Brad: `outputs/axle-step2-preview-{inbox,inbox-nl,`
> `item-needs-answer,item-ready}.html` (CSS inlined, lazy queue resolved).
> **Deploy plan (quiet moment — Jack live):** Mac: `box-code/axle-send.sh views/ui.js
> routes/inbox.js routes/item.js assets/components.css assets/htmx.min.js assets/sse.min.js` →
> box: manual one-time placement of the 2 NEW files into `C:\Axle\app\assets` (htmx.min.js,
> sse.min.js — the puller won't place new filenames) AND manual Copy-Item for components.css
> (CSS: the puller's node --check would reject it) → **remove the CSS + new files from Downloads
> before running the puller** → `C:\Axle\axle-pull.ps1` for the 3 JS → restart Axle Server →
> live-verify via Chrome over Tailscale at 1280 + 1680: shell on /, card click swaps centre+right
> with the queue scroll intact, deep link /item/N fills the lazy queue with the card highlighted,
> tabs + counts + Mine/All + ☰ mailbox menu + search + sort, Live · updated line + Sync, flagged
> item shows Check chip and NO Send, compose modal opens from the queue pane, busy item pulses
> "Drafting…" and self-refreshes, NL toggle end-to-end, /assets/htmx.min.js 200 (and 403 without
> identity), audit shows view_inbox rows from /queue fetches. server.js NOT in the deploy set
> (unchanged — but restart still required so the changed modules reload). Then the gate: **a full
> working day in it**, fix the niggles, git commit. Prior entry:
>
> **UI rework Step 1 — design system + item-page restructure (F5–F9, F11, F13): DONE. Deployed,
> live-verified & committed 2026-06-10 (box commit `1103ee5`; gate signed off). Next: UI Step 2 —
> three-pane shell + new queue list (F1–F4), own session-chunk, gate = a full working day in it.**
> (Git's LF→CRLF warnings on commit are cosmetic — autocrlf on the box; Taildrop deploys overwrite
> working-copy files with exact LF bytes anyway.) Live proof (Chrome over Tailscale, read-only, 1280 + 1680): inbox/audit
> restyled markup-free, both /assets stylesheets 200; real item #43 (PartsPoint Deventer, NL,
> awaiting_input, 3 open questions) renders the full Step-1 contract — questions-first order, single
> reply card with Reset-to-AI-draft + working translation toggles (NL→EN translation verified live),
> timeline with folded "Signature & footer" + 📷 inline-image marker, language/owner chip menus open
> with current value highlighted and close on outside click, sticky bar (green Send to recipient /
> Save / Save & redraft / ⋯ menu with visible descriptions opening upward), SAP-documents card, zero
> console errors. Jack viewed #43 in the new UI at 12:15 with no issues (audit trail). **Polish note
> for Step 5:** FOOTER_LINE misses the Dutch "uitsluitend bestemd voor de geadresseerde" phrasing —
> one disclaimer line showed above the fold on #43; add `bestemd voor` (+ "persoonlijk gericht") to
> the render-side footer regex in ui.js during the polish round.
> Accent decision (Brad 2026-06-10): deep green (the existing Send green). Changes: NEW `assets/tokens.css`
> (8px grid, stone neutrals, green accent, status hues, system font stack) + `assets/components.css`
> (every pre-Step-1 selector kept, so inbox/blocks/audit/compose-modal restyle with NO markup change,
> plus the new components). `views/ui.js`: page() links the two stylesheets (ASSET_V="s1" cache-bust),
> inline `<style>` gone; tiny outside-click closer for menus; 11 new STRINGS keys EN+NL (parity 228/228);
> +es in LANG_DISPLAY; new presentation helpers `chipMenu` / `foldFooter` / `segmentQuoted` /
> `renderTimeline` (folding regexes mirror classify() RENDER-SIDE; classify untouched). `routes/item.js`
> GET /item/:id restructured: **F5** language+owner chips ARE the controls (details-dropdown posting the
> SAME audited /language + /owner routes; the duplicate selector forms are gone; compose's language
> control folded into the chip with a "re-drafts" note); **F6** ONE editable reply card — cf/compose
> subject field inside it, hidden name-less `ai_seed` textarea + "Reset to AI draft" (confirm-click),
> show/hide-translation toggle reusing /translate-reply, edited badge; the always-on draft/interim
> translations are REMOVED (on-demand now; inbound-email translation still pre-rendered behind a
> per-message toggle); **F7** conversation timeline — newest message as an open card, legal footer
> folded (never dropped), `[cid:]`/Inline-Bild tokens → readable 📷 marker, quoted history segmented
> into collapsed message cards, search-in-email + auto-open-fold-on-hit kept; **F8** state-driven order —
> questions+feedback card FIRST only when status=awaiting_input with open questions, else reply first
> and questions collapsed (all field names unchanged: reply/feedback/answer_N/cf_subject/compose_subject);
> **F9** sticky bottom action bar — green Send via `form=workform formaction=/send` with the same
> confirm, Save, Save & redraft, close actions in a ⋯ overflow menu with their tooltips as visible
> descriptions, Reopen bar for closed items, flagged/cf/compose refusal notes shown in the bar;
> **F11** combined "SAP documents" card (suggested docs + manual attach-by-number together, placed after
> the work form; staged attachments stay by the reply card). `server.js`: ONLY addition = `/assets`
> express.static mounted AFTER identity+CSRF middleware (no unauthenticated surface; 1h cache, ?v=
> busts). **Safety paths untouched:** send/recipient routes, send-guard.js, send.js, resolve-customer.js,
> engine.js all byte-unchanged. **Proof — new `harness/step1/` (run.js + README):** reuses step0
> fixtures/stubs/battery; (1) equivalence vs the pre-Step-0 monolith across the 3 env phases — 120
> responses, transport fields + JSON/binary bodies + final DB dumps byte-identical (HTML differs by
> design), incl. the four send flows, flagged-refusal and recipient-gate rejects; (2) **33/33 structure
> assertions** (chip menus, single reply card, timeline, F8 ordering both ways, sticky bar, SAP-docs
> card, cf/compose/flagged/closed variants, NL strings, /assets 403 without identity). node --check
> green. **Step-0 fixture bug found & fixed** (`step0/fixtures.js` item 5: a missing draft_edit null
> shifted columns so origin held the instruction text — invisible to pre-vs-post diffing since both
> trees share fixtures; caught by the structure asserts). NOTE: step0/run.js now fails vs the Step-1
> tree BY DESIGN (it byte-compares HTML; its gate was passed and committed pre-Step-1). Static
> previews for Brad: outputs/axle-step1-preview-*.html (CSS inlined).
> **Deploy plan (quiet moment — Jack live):** Mac: `box-code/axle-send.sh views/ui.js routes/item.js
> server.js assets/tokens.css assets/components.css` → box: `New-Item -ItemType Directory
> C:\Axle\app\assets` + manual one-time Copy-Item of the 2 css files into it (new files — the puller
> won't place them) → `C:\Axle\axle-pull.ps1` for the 3 js → restart Axle Server → live-verify via
> Chrome over Tailscale at 1280 + 1680 (item: chip menus post + audit, timeline folds, bar sticky,
> SAP-docs card, flagged item shows NO Send, cf picker + compose unchanged; inbox/blocks/audit
> restyled; /assets 200) → optional belt-and-braces: re-run the box injection harness (engine
> untouched). No DB migration, no allow-list change, no engine/prompt change. Then the gate: Brad +
> Jack review on live items; git commit. Prior entry:
>
> **UI rework Step 0 — extraction refactor: DONE. Gate signed off & committed (2026-06-10, box commit
> `7930b73`).** NB the commit also swept up previously-uncommitted box files from parallel sessions
> (check.js, doc-references/doc-suggest + tests, sap-doc-pdf.js, set-wm.js) — fine, now in history.
> **Next: UI rework Step 1 — design system (tokens.css/components.css) + item-page restructure
> (F5–F9, F11, F13), own session-chunk, gate = Brad + Jack review on live items.** Deployed 13:37 box time: v5 puller installed (v4 backed up as
> `C:\Axle\axle-pull-v4.bak.ps1`), `views\` + `routes\` created, 5 new files placed, server.js pulled
> (node --check OK), server restarted clean. Live-verified via Chrome over Tailscale (read-only): inbox with
> live items #2/#42, item #2 full render (chips incl. session-10 DE tag + language/owner selectors, quoted-
> history fold, Graph attachments, EN translation block, AI holding reply), /blocks (real block from item
> #35), /audit (live trail). Own chat, brief at `Axle — UI rework — build brief.md`. `server.js` (2,394 lines) split into
> `views/ui.js` (esc/STRINGS/labels/dates/mail-render/page layout) + `routes/{shared,inbox,item,admin}.js`,
> with **all moved code verbatim** (line-coverage-checked: every original line accounted for). **Safety paths
> did not move:** `/item/:id/send`, `/item/:id/contactform-recipient`, `/compose` + `/compose/resolve` (every
> route that sends or sets a recipient), the identity + CSRF middleware and the `ACTION_*` allow-list env
> checks all stay in `server.js`; the two ACTION flags are passed into route modules by value so the env check
> exists once. `send-guard.js`/`send.js`/`resolve-customer.js`/engine untouched. **Proof:** a new equivalence
> harness (kept at `harness/step0/`, runnable in any future session via AXLE_MIRROR/AXLE_PRE env) boots the
> pre-refactor monolith and the refactored tree against identical fixture DBs — real express + real db.js/
> rules.js/scenarios.js/send-guard.js, network/model modules stubbed deterministically, async gated so even
> the investigating/syncing renders compare — and byte-diffs every response + the final DB state across 3 env
> phases (actions on / off / CSRF enabled): **120 responses + dumps identical, PASS**; covers all 21 routes
> incl. the four send flows (reply w/ inline image, compose, contact-form, flagged-refusal) through the REAL
> send-guard, sha-dedup, tampered-recipient rejects, scope-override, audit search, i18n (EN+NL parity 217/217).
> Harness sensitivity proven (a 1-word UI change → 66 diffs). **Also new: `axle-pull.ps1` v5** (routes updates
> by unique basename anywhere under `C:\Axle\app`, node_modules excluded; ambiguous names skipped; new files
> still root-only from `_incoming`). **Deploy plan (gate then deploy, quiet moment — Jack is live):** place
> v5 puller manually → `New-Item C:\Axle\app\views, C:\Axle\app\routes` → Taildrop the 6 js files → manual
> one-time placement of the 5 new files → `axle-pull.ps1` for server.js → restart Axle Server → live-verify
> via Chrome over Tailscale → git commit. No DB migration, no allow-list change, no engine/prompt change.
> Prior entry:
>
> **Session-10 language-detection hardening — DEPLOYED & LIVE-VERIFIED (2026-06-10).** The 06-10 code-review
> deploy had already shipped the mirror's `ingest.js` + `server.js` (carrying the merged language changes),
> leaving `engine.js` as the change-set's only missing file — Taildropped → axle-pull (node --check OK) →
> server restarted → git commit. **Live proof on real inbound item #2 (Knut Hoffmann, googlemail.com):** the
> exact trigger case — newest message inline-image-only + bilingual confidentiality footers + quoted thread —
> now tags **Language: DE** (old vocab was nl|en, so DE is only producible by the new classify; German here is
> only derivable from the folded customer sample / D-postcode fallback), the English-translation panel renders
> ("the customer wrote in German"), the inbound customer's-language selector (NL/EN/DE/FR/ES + Set) renders
> under the chips, and the DE tag survived the nl|en draft step (ingest precedence change working). Verified
> read-only via Chrome over Tailscale — no sends, no status changes (Jack live in the tool). NOTE: the DB was
> wiped for Jack's go-live, items renumbered from #1 (old #13 and test items #49–53 are gone — the pending
> "wipe test items" note is moot). CSRF (`AXLE_ALLOWED_ORIGIN`) still OFF — enable ~2026-06-11 after a day of
> normal use. **Injection-hardening harness re-run on the box post-deploy (same day): 37/37 PASS, 0 FAIL**
> (report `C:\Axle\logs\hardening-report-2026-06-10T07-48-27-369Z.md`) — closes the parked auto-attach
> confidence check AND re-proves containment over the changed classify(). Prior entry:
>
> **Code review (2026-06-10) — DEPLOYED & LIVE-VERIFIED on the box same day.** All 6 files placed via
> axle-pull (6/6 OK), server restarted clean 08:38, resolve-test live-SAP suite green through the new shared
> pool (7/8; the 1 FAIL is a stale Gate-A assert expecting via=name where the 2026-06-09 resolver rework
> correctly returns via=search — fix the assert in the mirror, not the code), and a full scheduled-task ingest
> ran clean on the new code (09:16 start→end, task returns to Ready = the CLI process exits properly with
> closePool). NOTE: "Axle Ingest" was found DISABLED during the deploy window (6 missed runs) — re-enabled
> 2026-06-10; cause unconfirmed (possibly a parallel session); runbook item: parallel sessions/projects with
> admin on the box can touch each other's scheduled tasks. CSRF env (AXLE_ALLOWED_ORIGIN) still OFF —
> enable after ~a day of normal use. Original review entry:
>
> Full pass over the box
> codebase for bugs / security / performance. Fixes applied (6 files): **(1) SQL connection pooling —** the hot-path
> SAP modules (`connectors.js`, `agent-tools.js`, `sap-doc-pdf.js`, and `resolve-customer.js`'s default reader) all
> used the mssql GLOBAL `sql.connect()` and CLOSED it in a `finally`, so two concurrent reads (e.g. gatherSeed's
> `Promise.all`) shared one pool and the first to finish closed it under the other ("Connection is closed" races),
> while every call paid a fresh TCP+TLS+auth handshake. Replaced with ONE shared persistent pool
> (`connectors.getPool()` / `closePool()`); `ingest.js` CLI now closes it in `finally` so the scheduled process still
> exits. **Biggest correctness + speed win; MUST be live-SAP smoke-tested before restart** (the sandbox stubs mssql).
> **(2) CSRF hardening (opt-in) —** auth is the Serve-injected `Tailscale-User-Login` header, not a cookie, so a
> malicious site could drive a tailnet user's browser to POST here with their identity attached. New middleware
> rejects cross-origin state-changing requests **when `AXLE_ALLOWED_ORIGIN` is set** (no-op until then, so it can
> never lock the team out before the exact Serve origin is confirmed — Brad enables it deliberately, allow-list
> style). **(3)** bounded the `_suggCache` Map (was unbounded). **(4)** strip whitespace/newlines from Shopify+mailbox
> search identifiers (GraphQL/`$search` hardening). No allow-list change, no DB migration, no send-path logic change.
> Verified: `node --check` all 6 files green; pure suites green (contact-form-parser 9/9, doc-references 37/37,
> send-guard-cf 6/6, doc-suggest 27/27, contact-form 5/5). Deploy: Taildrop `connectors.js agent-tools.js
> sap-doc-pdf.js resolve-customer.js ingest.js server.js` → `axle-pull.ps1` → **run one real draft/sync to smoke-test
> SAP reads** → restart Axle Server. To turn CSRF on later: set `AXLE_ALLOWED_ORIGIN=https://<axle-host>.ts.net` in
> the box `.env` + restart. **Flagged, NOT auto-fixed (need a Brad decision):** the header-trust identity model and a
> belt-and-braces send-dedup edge case — see the review summary in chat.
>
> **Auto-attach relevant SAP documents — Steps 1–6 DONE; CONTROL GATE SIGNED OFF & ROLLED OUT TO JACK (2026-06-09). LIVE, draft-only.**
> Brad signed off the control gate on the live demo (panel surfaces only in-scope documents; a foreign customer's
> number is never one-click; one-click Attach only renders+stages a PDF behind the existing Send approval; an
> injection/contact-form item surfaces nothing) and rolled it out to Jack. **No new allow-list action** — attaching
> a suggested PDF stages it behind the SAME Send approval as any hand-attached file; the suggestion layer is
> read-only and cannot send or write to SAP. It is automatic for all NEW inbound mail from now on; older items
> (ingested before this feature) gain suggestions when redrafted. **PARKED → DONE 2026-06-10 (37/37 PASS, 0
> FAIL). Original note:** run the box injection-hardening harness (`hardening/harness.js`) to double-confirm the additive reply-mode
> engine change (`referenced_documents` field/line + the `applyContainment` clear) left containment intact — the
> change is provably additive and the feature is read-only/draft-only, so this is a confidence check, not a gate.
> **Live verification (Chrome over Tailscale):** box-side unit suites 37/37 + 27/27; a live-SAP end-to-end via the
> real `axle_read` resolvers classified order 226452 `in_scope` (K130312) and Veenstra's 226449 `out_of_scope`
> (K118652) with the Shopify names folded in and the injection line inert; the injection-flagged contact-form
> item (#1) correctly shows **no** Suggested-documents panel. **In-tool end-to-end on a real customer item (#2,
> Felicitas Schotters):** her newest message was just "Hi, any news?" with no number — the **model hint** surfaced
> order **224665** + invoice **425315** (resolved during the draft investigation), both scope-matched to her, as
> one-click Attach rows; clicking Attach rendered the real Boyum PDF via Crystal (**Order-224665.pdf, 153 KB**)
> and staged it in `draft_attachments` with **nothing sent** (item stayed Awaiting input); Remove cleaned it
> off. **Gap found & fixed during the live test:** the extractor originally scanned only the newest message
> body, so a follow-up ("any news?") whose number lives in the quoted thread surfaced nothing — `ingest.js` now
> scans the **whole customer thread** (`threadScanText`) and an inbound **redraft refreshes** suggestions using
> the model's `referenced_documents` hint (both still scope-guarded); ingest.js + server.js redeployed + restarted.
> **Gate signed off & rolled out to Jack (see entry above).** Build details below. Prior entry:
>
> **Auto-attach relevant SAP documents — Steps 1–4 BUILT & SANDBOX-VERIFIED (2026-06-09).**
> New feature (own dedicated chat, `Axle — Auto-attach feature — build brief.md`): when an inbound customer
> email references a document, Axle proposes its Boyum print PDF as a one-click attachment so the salesperson
> needn't look up + type the number. **Draft-only; no new send privilege, no SAP write** — it only automates
> the *selection* for the existing `/attach-doc` render+stage path behind the approval gate. **Decisions locked
> (Brad):** (1) **propose, one-click add** (no silent auto-stage); (2) **deterministic extraction + a model
> hint**, with resolve+scope ALWAYS deterministic; (3) compute **at ingest**, store on the item; (4) out-of-scope
> docs **shown flagged behind the attach-anyway confirm** (never one-click). **Mandatory customer-scope guard:**
> a referenced number is only ever a candidate to *look up*; it is resolved against live SAP and may be surfaced
> as in_scope ONLY when the document's CardCode == the email's customer (sender→`customerByEmail`); a foreign or
> unresolvable number is `out_of_scope`/dropped, never auto-attached. Injection-flagged items surface nothing.
> **New modules:** `doc-references.js` (deterministic EN/NL extractor — keyword/Shopify-name/bare-DocNum, noise
> filters; 37/37 asserts) + `doc-suggest.js` (resolve+scope filter, model-hint merge, `suggestForEmail`; 27/27
> asserts incl. the crown-jewel "foreign customer's number is never in_scope" + injection cases). **Changed:**
> `sap-doc-pdf.js` (+`resolveShopifyOrder` via ORDR.NumAtCard with the whole-token guard — live-SAP verified:
> S17915→order 226449, and `S1791` correctly rejects `S17910–18`); `server.js` (Suggested-documents panel on
> inbound items — in_scope one-click, ambiguous picker, out-of-scope review; every button posts to the proven
> `/attach-doc` route; +inbox 📎 chip; 8 `sugg_*` i18n keys EN+NL parity); `ingest.js` (store suggestions at
> ingest, read-only, never blocks the item; skips contact-form/injection); `db.js` (+`doc_suggestions_json`
> column); `engine.js` (**additive, reply-mode SYSTEM only** — optional `referenced_documents` hint field +
> one prompt line; compose uses its own `opts.system` so it's untouched; `applyContainment` force-clears the
> field on a flagged email). All files `node --check` clean. **NOT deployed — next: Step 5 (deploy: Taildrop +
> manual-place the 2 new modules, axle-pull the rest, restart; box-side run the two harnesses; live-test on real
> inbound mail + the foreign-number adversarial check), then Step 6 control gate.** Nothing here sends; action
> allow-list unchanged. Prior entry:
>
> **Contact-form reply — Gate 5 SIGNED OFF (2026-06-09): allow-list action #4 is LIVE.** (Completes the
> session-8 contact-form thread; ran concurrently with the session 9–10 Compose/language work below — the
> mirror holds all three change-sets.) Turned action #4 on after: confirm-recipient verified (code-held
> `w.recipient` via `pickRecipient`); fresh webshop submissions auto-enrich at ingest with no manual step;
> **language decision (Brad) — contact-form outbound follows the customer's ACTUAL message language, not the
> country map**: removed the country-map override in `ingest.js` and based the proposed subject on the draft
> language in `server.js contactFormSubject` (sandbox-validated, deployed, server restarted).
> `AXLE_ACTION_CONTACTFORM_SEND=on` in `C:\Axle\secrets\.env`. **Live sends verified in admin@ (via the `axle@`
> alias):** known/EN, cold/EN, cold/NL, cold/order-ref — each a fresh NON-threaded email, correct language +
> subject, source notification marked read, item→done, audit `email_sent kind=contactform_new threaded=false`.
> **Refusals proven:** unconfirmed-recipient (Send hidden until Confirm; route 400) and **injection** (hostile
> form auto-flagged P1/Check at ingest; UI "Sending disabled: flagged as possible injection"; direct POST →
> 400 Send refused — nothing sent). **Allow-list action #4 → enabled.** ⚠ **Deploy note:** the box runs the
> contact-form `ingest.js`+`server.js`; session 10's language-hardening (engine/ingest/server) is merged into
> the mirror but marked NOT-yet-deployed — when it deploys, push all three current mirror files together so both
> change-sets land. Test items #49/50/51/53 are leftover test data — wipe before the next live session.
> **Next: roll out contact-form reply to Jack + team.**
>
> Living document. Updated every working session. Last updated: **2026-06-10** (language hardening deployed &
> live-verified — see top entry; historical note below kept as written. Prior: contact-form Gate 5; session 10 —
> **Language detection hardening + inbound language override — read-only/draft-only, BUILT &
> SANDBOX-VERIFIED, NOT yet deployed.** Trigger: inbound emails whose newest message is image-only or
> quote-only (e.g. #13, a German customer) were mis-tagged EN, so the English-translation panel and
> de/fr awareness were missing, and staff had no way to correct a wrong language tag. Three files:
> (1) `engine.js` `classify()` is now thread-aware — it judges language on a **customer-only writing
> sample** (quoted replies folded off, incl. the Gmail "Name <addr> schrieb:" header and Scandinavian
> `Fra:`/`Från:`; bilingual confidentiality footers stripped; cid/inline-image tokens removed), broadened
> the vocab to `nl|en|de|fr|es|other`, and added a **deterministic country/postal fallback** (sender TLD,
> then `D-`/`F-`/Dutch postcode shapes) used only when the customer sample is too thin (<15 letters) to
> trust the model — which otherwise defaults to EN off our quoted English reply. (2) `ingest.js` makes the
> **detected customer language authoritative**: the `nl|en`-only draft step can no longer downgrade a
> de/fr/es tag (`result.language || cls.language` → classifier wins unless it returned `other`). (3)
> `server.js` extends the compose-only `/item/:id/language` route to **inbound items** as a re-tag (fixes
> the translation panel + language chip, does NOT re-draft) plus a salesperson **language selector under
> the chips** (EN/NL parity, audited `language_corrected`). **Verified:** `node --check` all three; **21/21
> sandbox asserts** against the REAL `engine.js` helpers (model stubbed) — sample folding, country hint,
> thin-text override EN→de/fr, vocab clamp, ingest precedence, route guard (`outputs/harness-lang.js`). No
> new files (the puller auto-collects engine/ingest/server), no DB migration, **no allow-list change —
> nothing new can send.** Deploy = Taildrop the 3 files → `axle-pull.ps1` → restart Axle Server → re-sync
> or open #13 and set its language. Prior: session 9 —
> **Compose backlog #3 DONE, DEPLOYED & gate-signed-off — SAP document PDF attach (draft-only).** A
> salesperson can attach the standard Boyum print PDF of a referenced SAP document (order / invoice /
> quotation / delivery / credit note) to a compose email, exactly as if printed in SAP and attached by
> hand. **Mechanism (decided with Brad): headless Crystal render on the box.** The real Boyum
> `Documents.rpt` master layout (one report for all doc types, keyed by the standard print params
> `ObjectId@` + `DocKey@`) is rendered by the SAP Crystal Reports runtime (v13.0.40, 64-bit) + SQL Server
> Native Client 11.0, with the connection repointed from the saved `SAP-SERVER` alias to the live host as
> **axle_read — read-only, encrypted (encrypt + trustServerCertificate)** — no SAP client, no DI, no write
> anywhere. New box assets: `C:\Axle\layouts\Documents.rpt`, `C:\Axle\render\render-doc.ps1` (reads SQL
> creds from `.env`, sets the two params, exports the PDF). New module `sap-doc-pdf.js`: resolves
> DocNum->DocEntry via parameterised axle_read SQL — the **DocEntry is never chosen by the model or by
> email content, only by the number a human typed** — then spawns the renderer and returns the PDF bytes.
> `server.js`: a compose-only **"Attach SAP document"** control + `/item/:id/attach-doc` route that renders
> read-only and stages the PDF in `draft_attachments` behind the **existing approval gate** (3 MB cap),
> with a **customer-scope guard** (a document whose CardCode != the email's customer is held for an explicit
> "Attach anyway", audited SCOPE-OVERRIDE) and an ambiguous-DocNum picker that validates the pick is in the
> resolver's own set. Five doc types (order/invoice/quotation/delivery/credit note), EN+NL parity (18 keys).
> **Verified:** server + module `node --check`; 18-key i18n parity; 16/16 module logic asserts + a live-SAP
> column check on all five doc tables; live box render of order 226108 -> 102 KB PDF; and **live in the
> tool** — 226108 attaches (same customer, direct), 226449 triggers the different-customer warning, a junk
> number is rejected, and **no Send button anywhere (action #3 stays OFF — nothing sends).** **Gate signed
> off by Brad 2026-06-09. This CLOSES the Compose Step-3 polish backlog — all items done; the Compose
> feature is now feature-complete in draft-only mode.** Prior: session 8 —
> Contact-form reply build started: 5 decisions confirmed (distinct allow-list **action #4**;
> known-customer reply defaults to the **form-typed** address with SAP/Shopify addresses shown/
> pickable; model-proposed editable subject; `#Sxxxxx` resolved through SAP for context; phone/
> country kept on the item). **Step 1 DONE & sandbox-verified, NOT deployed:** `contact-form-parser.js`
> (deterministic EN/NL parser, HTML-primary + text fallback) + `contact-form-parser.test.js` — 9/9
> pass incl. an injection case proving the message body cannot override the parsed Email/Name; the
> parsed email is a CANDIDATE only, still gated by `pickRecipient` + human confirm. **Step 2 DONE &
> sandbox-verified, NOT deployed:** new `connectors.getMessageHtml` (read-only single-message HTML
> fetch) + new `contact-form.js` orchestrator (parse → resolve via `resolve-customer` on email+order
> ref → candidate address set, form-typed default, country-map language) + `work_items.contact_form_json`
> column + `ingest.js` wiring (enrich contact-form items, audited, never sets recipient/sends, never
> blocks the item). `contact-form.test.js` 5/5 (known customer form-first ordering, cold prospect,
> HTML-fetch-fail→text fallback, order-only resolution, no-recipient-produced contract); parser suite
> still 9/9. **Step 3 DONE & sandbox-verified, NOT deployed:** all in `server.js` — a contact-form
> detail header (parsed customer + SAP-match line + order/phone) with a confirmed-To picker over the
> stored candidate set (form-typed first, SAP pickable); new route `/item/:id/contactform-recipient`
> validates the picked address with `pickRecipient` against the candidate set (tampered/out-of-set
> rejected, no fallback) and code-holds it in `w.recipient` (audited `contactform_recipient_set` /
> `_rejected`); reuses the compose `w.recipient` column. EN+NL strings (14 `cf_*` keys, parity checked).
> **Still no send: `canSend` excludes contact-form and `/item/:id/send` still 403s it (action #4 OFF).**
> Verified: `node --check`; pickRecipient gate 6/6; cf_ key parity 14/14. **Step 4 DONE & sandbox-verified,
> NOT deployed:** `send-guard.assembleContactFormSend` (NEW-outbound variant — To = code-held `w.recipient`
> not the mailer, fresh subject no "Re:", NO quoted Shopify history, same injection/empty/URL-allowlist/
> verbatim-sha guarantees; `assembleSend` untouched); `server.js` allow-list **action #4** via env
> `AXLE_ACTION_CONTACTFORM_SEND` (default OFF) — `/item/:id/send` refuses contact-form while OFF and
> refuses if no recipient confirmed; when ON it sends via `sendReply(originalMessageId=null)` (no
> threading), marks the mailer@shopify email read, item→done; editable proposed **subject** box
> (order-ref-aware, customer-language); send button/confirm now show the confirmed recipient; audit
> `email_sent kind=contactform_new`. `send.js` already sends subject verbatim + no In-Reply-To on null.
> Verified: `send-guard-cf.test.js` 6/6 (recipient≠mailer, fresh subject, no quoted history, injection/
> no-recipient/empty-subject/empty-body/off-allowlist refusals, lc-normalise + subject cap); all suites
> 20/20; action #4 confirmed default OFF; `node --check` clean. **Deferred to the gate:** draft greeting
> the parsed Name / using order context (draft already sees both in the body — judge on real drafts).
> **Step 5 — gate IN PROGRESS (2026-06-08): DEPLOYED & LIVE on the box, draft-only verified.** Whole stack
> Taildropped + axle-pulled (16 files, all node --check green; the 5 new modules placed via _incoming);
> run-ingest.ps1 → `node ingest.js info`; Axle Server restarted (PID confirmed on new code). End-to-end
> proven on a real webshop test submission (item #2, brad@sharnock.com): contact-form folder → ingest →
> classify → draft `ready`; detail page shows the new "Contact-form customer" box, resolver MATCHED it to
> SAP K126621 "Sharnock Beheer" (frozen-account warning surfaced), recipient picker (form-typed) + Confirm
> button, proposed subject box; **Send button correctly absent (action #4 OFF), note "Confirm the recipient
> above before this can be sent."** Deploy gotcha hit & resolved: the first manual Sync ran on the
> pre-restart server, so item #2 ingested WITHOUT enrichment (`contact_form_json` NULL); re-enriched in
> place via a one-off `buildContactForm` call — future ingests auto-enrich on the now-live code.
> **STILL TO DO (resume tomorrow before sign-off):** (1) click Confirm recipient → verify `w.recipient`
> code-held + ✓ badge; (2) submit a FRESH contact-form msg → confirm it auto-enriches at ingest (no manual
> step); (3) enable action #4 (`AXLE_ACTION_CONTACTFORM_SEND=on` in `C:\Axle\secrets\.env` + restart) →
> send real test replies (known customer + cold prospect, EN+NL) to Brad's own addresses → verify delivery,
> no threading, mailer notification marked read, item→done, audit `email_sent kind=contactform_new`;
> (4) sign off Gate 5, flip action #4 to enabled. **Observation to decide tomorrow:** Step-2 enrichment sets
> `work_items.language` from the country map (NL here), but the customer wrote English and the draft is
> English → the EN translation block + a NL default subject both showed. Decide: outbound language by country
> map vs the customer's actual message language for contact-form (and align the proposed-subject language to
> the draft). Low priority, cosmetic. Prior: session 7 —
> pre-Jack handover: ingest moved to a time watermark (every email new since last sync), info@ only,
> "Shopify Contact Form" folder now read, contact-form items draft-only, wipe sets a fresh-from-now
> watermark; built + sandbox-verified in the mirror, **not yet deployed**. Prior: session 6 —
> Compose Steps 1-2 done (Gates A & B signed off: resolver + compose-mode engine, turret verified
> live on the box). **Step 3 (Compose UI + work item, draft-only): sub-steps 3a AND 3b DONE &
> verified in the sandbox** (3a: scenarios.js, /compose routes + modal, recipient gate; 3b: detail
> page + redraft branch + route-level send guard). **Next: 3c — deploy to the box + Gate C.**
> Nothing deployed to the box yet; action #3 still OFF. Prior: session 5 — Jack onboarded).
> **Resuming a session:** read this file top to bottom, restate current status to Brad,
> then continue from "Next up". One step at a time; Brad confirms each before the next.

---

## What Axle is

An AI-powered sales-and-service assistant for RoverParts.eu. It reads incoming customer emails
(info@ Gouda, drachten@ Drachten), researches each one across SAP B1, Shopify, M365, and MyParcel,
asks the salesperson any human checks it needs, and presents a prioritised inbox with a ready
draft reply. A human reviews, edits, approves, and sends — every send and every system change
gated by explicit human approval and an action allow-list Brad controls item by item.

**Architecture (locked):** Brad builds on the Axle box itself (`bradmin` account, source in
`C:\Admin\Projects\Axle`); Axle runs as the low-privilege `axle` user on that same dedicated
on-prem Windows 11 machine in Gouda (inherits the SAP IP whitelist). No public surface — access only via
Tailscale. Dedicated Anthropic org under `axle@budget-parts.nl`. Built on existing MCP connectors
and skills (info-triage, sap-sql, purchasing, SAP read/write, Shopify, M365) plus a new MyParcel
connector. Read-only before write; draft before send; least-privilege service accounts per system;
email content is always data, never instructions.

---

## Current status

| | |
|---|---|
| **Phase** | 6 — live with Jack. Allow-list: #1 Send (reply) ON · #2 mark-as-read ON · #3 send new/compose **ON (Gate D 2026-06-09)** · #4 contact-form send **ON (Gate 5 2026-06-09)** · read-only **Shopify: read discounts** scope granted **2026-06-16** (no send-action). Auto-attach suggested SAP docs live (draft-only, no new action). Session-10 language hardening **live (2026-06-10)**. Code-review fixes (shared SQL pool, CSRF middleware, cache bound) **live (2026-06-10)**. Discount-awareness (live Shopify discount reads inform brief + draft, draft-only) **deployed & live-e2e verified 2026-06-16**. |
| **Step** | **UI rework (own chat) Step 2 — three-pane shell + queue (F1–F4) DEPLOYED & LIVE-VERIFIED (2026-06-10); GATE OPEN — a full working day in it, then git commit** (see top entry). Steps 0+1 deployed, gate-signed & committed (box `1103ee5`). After Step 2's full-day gate: Step 3 (context pane, F10) → Step 4 (SSE liveness, F12) → Step 5 (polish; incl. the Dutch FOOTER_LINE regex note from Step 1). Parallel carries: (1) roll out contact-form reply to Jack + team; (2) Gate 4 carry — live walkthrough with Jack + drachten@ Send re-test; (3) enable CSRF (`AXLE_ALLOWED_ORIGIN`) ~2026-06-11 after a day of normal use. |
| **Blockers** | None. |

### Session 11 (2026-06-10) — Feature round: 5 UI/connector enhancements
Five features agreed, built one at a time (decisions: snippets = paste-to-attach **and** inline-in-body
in one round; block-marketing = Axle-only suppression first, mailbox-move later as its own allow-list
action; phone resolution = generic close-with-reason: replied/done/phone/no_action).
1. **Audit search — DONE, deployed & live-verified 2026-06-10.** `/audit` now searches the WHOLE
   audit_log (parameterised LIKE over user/action/detail, wildcards escaped) + action dropdown +
   item # filter, combinable; capped at newest 500 matches; every search audit-logged with its
   parameters. Sandbox 16/16 (real server.js routes, node:sqlite shim, harness at
   outputs/harness-audit.js — sandbox-only); live-tested via Chrome over Tailscale (sha-fragment,
   action=email_sent, item+q combined, `' OR 1=1 --` inert, form + button submit). server.js only.
2. **Editable owner — DONE, deployed & live-verified 2026-06-10.** "Assign to" select + Reassign
   button beside the language fixer on the detail page; choices derived from the mailbox's own
   routing-rule owner labels (`ownerChoices`, rules.js stays the single source of truth; drachten
   has no alternative so the form hides); POST `/item/:id/owner` validates in-set, rejects
   free-text/cross-mailbox labels, closed items immutable; audited `owner_changed old -> new`;
   reassign moves the item between "mine" queues. Sandbox 14/14 (outputs/harness-owner.js);
   live-verified on item #2 (Jack -> Tom -> Jack, both audit rows present). server.js only.
3. **Paste snippets + inline images — DONE, deployed & live-verified 2026-06-10 (incl. a real
   inline-image send to admin@, item #39, audit `inline=1`; received HTML carries
   `<img src="cid:att2@axle">` exactly at the token position).** Win+Shift+S → Ctrl+V attaches
   (auto-named `snippet-<ts>.png`) on the detail page AND the Compose modal; pasting into the
   reply box also drops an `[image:N]` token at the caret (N = draft_attachments id, returned by
   /attach-add); "Insert in text" button on image rows; text-paste untouched (image+text into a
   field = text wins, e.g. Excel ranges). Send path: send-guard `applyInlineImages` validates
   tokens against THIS item's staged rows only (unknown id / non-image / markdown-wrapped =
   refuse), swaps to cid img in OUR reply's HTML only (never quoted history — customer "[image:1]"
   text is inert), sha over raw text incl. tokens; send.js marks contentId'd attachments
   isInline; remove_att auto-strips its token from draft_edit. Files: server.js, send-guard.js,
   send.js. Sandbox 35/35 (outputs/harness-snippets.js, real send path w/ fetch-stubbed Graph +
   emitted-script syntax checks); send-guard-cf suite 6/6; injection harness re-run on the box
   37/37 (2026-06-10 09:00Z).
4. **Close-action restructure + Block sender — DONE, deployed & live-verified 2026-06-10.**
   `work_items.resolution` (replied = auto on send / done / phone / no_action; reopen clears) —
   close buttons now: Mark done · Resolved by phone · Archive (each tooltipped; Done = work
   completed, Archive = nothing needed), chips render "Done · by phone" etc., legacy rows plain.
   `sender_blocks` table (pattern UNIQUE, kind address|@domain incl. subdomains, provenance
   work_item_id); Block-sender confirm page (address vs domain, live SAP-customer warn via
   resolveCustomer — guests don't count, SQL failure degrades to "unknown"); block archives the
   item as no_action + marks read; ingest checks `isBlockedSender` BEFORE rules and audits
   `sender_block_hit`; /blocks page (whole team can view/unblock, audited) + "Blocked" nav link.
   Axle-only suppression (mail still lands in Outlook; mailbox-move = possible future allow-list
   action). Files: server.js, db.js, ingest.js. Sandbox 28/28 (outputs/harness-blocks.js);
   live-verified on item #35: @news-messefrankfurt.com domain-blocked (audit #509), item shows
   "Archived · no action needed", /blocks lists it with Unblock.
5. **MyParcel enrichment — DONE, deployed & LIVE-VERIFIED 2026-06-10 (order 226446 had no
   shipment — counter pickup; 226466/UPS proved the full chain).** `myparcel_search` now returns
   human-readable status (full 38-code map) + carrier name (18-carrier map, both verified against
   developer.myparcel.nl), reference, created, package/delivery type, option flags (signature/
   only-recipient/return/age-check), insurance EUR, FULL recipient (street/postcode/city/cc/
   email/phone), multi-collo link. NEW `myparcel_track` tool (GET /tracktraces/{id;id}
   ?extra_info=delivery_moment): current status+phase+final, latest event, delay flag,
   expected/estimated delivery moment, customer tracking URL (carrier link preferred), full
   history. Engine+Compose FACTS line added. Live facts: labels carry "226448 - #S17914" (SAP +
   Shopify numbers, both searchable); UPS links = www.ups.com → **URL_ALLOW gained myparcel.me +
   ups.com (send-guard + engine)**. Sandbox 26/26 (outputs/harness-myparcel.js, doc-shaped
   fixtures) + regressions green. **T11 hardening fix:** post-deploy harness failed
   T11-tag-breakout twice (flag-miss only, payload never leaked) — engine SYSTEM SECURITY line
   strengthened: structural forgery (stray wrapper tags, fake SYSTEM/admin directives) = ALWAYS
   flag; benign mentions protected. Final harness **37/37 (10:38Z)**. Files: connectors.js,
   agent-tools.js, send-guard.js, engine.js, compose.js. myparcel-test.js was a one-off
   (Downloads copies can be deleted).

### Session 7 (2026-06-08) — Pre-Jack handover: clean slate + watermark ingest + contact-form folder
Built & sandbox-verified in the mirror (`box-code/`), **NOT yet deployed**. Prep for Jack's first morning.
- **Ingest moved from "unread-only" to a time watermark** (reverses the session-5 unread decision, per
  Brad). Each run reads every email with `receivedDateTime >= watermark − 10 min buffer` across the
  mailbox's folders, then advances the watermark to the newest message seen. Buffer absorbs mail-rule/
  move lag; the existing `latest_message_id` thread-dedup makes the overlap free (no extra API cost).
  New `sync_state.watermarks` JSON column + `getWatermark/setWatermark` in `db.js`.
- **info@ only.** Scheduled task + manual Sync now run `["info"]` (was `["info","drachten"]`); drachten@
  stays off until that team is given access. `ingest.js` default box = info; `all`/`drachten` still CLI-available.
- **"Shopify Contact Form" folder now ingested.** `connectors.getMessages` rewritten to read multiple
  folders (resolve displayName→id, paginate via `@odata.nextLink`, merge + dedup by id, newest-first),
  unread filter dropped. `rules.js` carries `folders` per mailbox: info = `["inbox","Shopify Contact
  Form"]`, drachten = `["inbox"]`. The existing `shopify_form` rule already routes these (verified on
  real EN+NL subjects → Jack, draft). NB: the 28 contact-form msgs are all *read*, so unread-only never
  saw them — the watermark is what makes them ingestable.
- **Contact-form = draft-only.** Sender is `mailer@shopify.com`; the real customer address is in the
  body, so the send-guard's "recipient = thread sender" lock would email Shopify. `server.js` hides the
  in-thread Send button on these items (chip "Contact form" + note) AND refuses `/item/:id/send` at the
  route with an audited 403 (`isContactFormItem`). Jack replies via Compose/Outlook. Proper body-recipient
  extraction is a later, trust-boundary-careful follow-up.
- **`wipe-slate.js`** now also sets every mailbox watermark to *now* on wipe → "fresh from now" handover:
  after the wipe Jack starts at item #1 and only genuinely new mail flows in.
- **Verified (sandbox):** `node --check` all 6 files; watermark SQL + migration + `sinceFor` math
  (13/13, node:sqlite); real `getMessages` across 2 folders w/ mock Graph — folder resolution, since-
  filter passthrough, nextLink pagination, cross-folder dedup, newest-first, mapping, legacy numeric
  signature (13/13); `rules.matchRule` on real contact-form subjects (EN+NL → shopify_form/Jack/draft).
- **Changed files (all pre-existing → axle-pull auto-collects, no manual placement):** `connectors.js`,
  `db.js`, `ingest.js`, `rules.js`, `server.js`, `wipe-slate.js`. **Box step also needs:** point
  `run-ingest.ps1` at `node ingest.js info` (was `all`). **Next: deploy → wipe → restart → Brad verifies
  a Sync now pulls contact-form mail and only-new mail.**

### Session 6 (2026-06-08) — Compose feature, Step 1: customer resolver (Gate A)
Building **Compose** ("create new email") per `Axle — Compose feature — build brief.md` — Phase 6
proactive mode brought forward, gated behind a NEW allow-list **action #3 "send new (non-reply)
email"** (still OFF; the feature is draft-only until Gate D). Step 1 of the 5-step plan delivered.
- **New modules:** `resolve-customer.js` (deterministic, read-only customer resolver) +
  `resolve-test.js` (box harness). The resolver turns any identifier a salesperson knows — SAP
  sales-order #, AR-invoice #, customer code, email, Shopify order #, or name — into a customer
  identity and a **sendable email address**. SELECT-only; writes nothing anywhere.
- **Security invariant implemented:** the recipient is produced ONLY by this deterministic
  resolver from SAP/Shopify reads — never by a model or a tool result. Ambiguity (an email shared
  by several cards, a name match, conflicting identifiers) returns **candidates for a human to
  pick**; it never auto-selects. Parameterised SQL throughout; customers only (OCRD.CardType='C').
- **Acceptance test passes (live SAP):** SO **226108** → **K127177 "BV Newcraft"** (greeting
  contact: Laurens Michiels), send-to **laurens@yvesmichiels.be**, **BE → language nl**, line
  **TF534** turrets open, **U_Paid="N"** — genuinely unpaid, so the awaiting-payment scenario is real.
- **Findings that shaped the design (from live data):**
  1. **Email → customer is frequently 1-to-many** — 2,269 addresses are shared across up to 12
     customer cards (of 26,418 customers). Email resolution therefore returns candidates on a tie.
  2. **SAP `LangCode` is unreliable** — it defaults to Dutch (16) for ~90% of non-NL customers
     (249 German customers tagged Dutch vs 76 correctly German; GB 81 Dutch vs 6 English). The
     **country→language map (§2.4) is the correct deterministic basis** — confirms the locked
     decision; `LangCode` is surfaced for transparency but not used.
  3. **`ORDR.NumAtCard` carries the Shopify order name** (e.g. "#S17878 - TR 100437"), so a Shopify
     order resolves **through SAP on the trusted side** — better than the Shopify→email route,
     which is kept only as a sync-lag fallback. (Improvement on brief §6 path 5.)
- **Verification:** 44/44 logic assertions pass (recipient safety, candidate handling, language
  map, the S1787≠S17877 prefix-token guard, frozen/no-email flags, multi-identifier reconcile);
  every module query run against live SAP returns the correct rows; `node --check` clean; files
  are ASCII-only for clean console output on the box.
- **Gate A signed off (Brad, 2026-06-08):** resolver verification accepted; proceeded to Step 2.
- **Step 2 — compose-mode engine (built, Gate B pending).** New `compose.js` + `compose-test.js`;
  `engine.js` gained a minimal, backward-compatible `opts` hook on `agenticDraft` (system /
  userContent / senderAddr) so the same agentic loop, tools and D1/D2/D3 defences serve both reply
  and compose. The injection-hardened reply SYSTEM is untouched (verified: reply mode still uses it).
  Compose runs an INVERTED trust model — salesperson instruction trusted, all customer/system data
  untrusted — with the shared tone/format/policy rules reproduced verbatim, plus compose-specific
  lines: recipient-absent, a proposed subject (settles §10.1: model proposes, staff edits), and a
  verified supplier-ETA lookup (OITM.OnOrder + OPOR/POR1.DocDueDate). **Crown-jewel proof (15/15
  sandbox asserts):** the resolved recipient is withheld from the model seed entirely and held only
  in code; reply mode unchanged. Real draft quality is judged on the box (Gate B).
- **Turret data + ETA-rule fix (Brad, 2026-06-08):** TF534 is out of stock (OnHand 0) but OnOrder 2
  — the PO line closed because it was copied to an **A/P Reserve Invoice** (301370, Allmakes, posted
  2 Jun). Brad's rule: once stock is on a reserve invoice we receive it ~1-2 weeks from the POSTING
  date, so the turret ETA is ~9–16 Jun. Fixed the supplier-ETA lookup accordingly — the reserve
  invoice (OPCH.isIns='Y', open PCH1 line) is the primary signal, ETA = OPCH.DocDate + 1-2 weeks
  (NOT DocDueDate, which is payment-due); an open PO (OPOR.DocDueDate) is the fallback; if neither,
  ask. Landed in `business-knowledge.md` (shared — helps reply mode too), the compose.js SUPPLIER
  ETA LOOKUP rule, and the `agent-tools.js` sap_query description (OPCH/PCH1/OPOR/POR1). Re-verified:
  15/15 wiring + ETA rule present in the prompt; `node --check` clean.
- **Gate B SIGNED OFF (Brad, 2026-06-08).** Turret compose run live on the box: recipient code-held
  (the model never saw the address), reserve-invoice ETA correct (found invoice 301370 posted 2 Jun
  → 9–16 Jun, ignoring the 2 Jul payment-due date), on-brand Dutch draft greeting the order contact
  (Laurens, not the company), product link, excl. btw, correct sign-off. Two runs both `ready`/high.
- **Decision (Brad, 2026-06-08), done:** awaiting-payment emails **always include our IBAN + the
  order number as payment reference** — rule added to `business-knowledge.md` (pending box deploy),
  with a fix so a payment total (`ORDR.DocTotal`, the gross amount paid) is never mislabelled
  'excl. VAT' (the turret order is VAT-free intra-EU B2B; "prices excl. VAT" applies to unit prices).
- **Step 3 — Compose UI + work item (now building, draft-only).** A `+`/"New email" button in the
  inbox toolbar opens a modal (one combined customer-identifier input, optional scenario chips,
  free-text prompt, language selector EN/NL/DE/FR/ES, send-from mailbox, drag-drop attachments). On
  submit: resolve the customer (candidates shown inline if ambiguous), run compose-mode, persist as
  an `origin='compose'` work item with a synthetic conversation_key, land on the existing detail
  page (resolved customer + confirmed To at top, editable draft, dual-language, questions). **Send
  button hidden/disabled** until allow-list action #3. **Gate C: Brad composes several emails in the
  tool and reviews drafts — still nothing sends.**
- **Step 3a DONE & verified (2026-06-08) — Compose backend + modal + scenarios.** New files/edits
  (built on the Mac mirror, NOT yet deployed):
  - **`scenarios.js`** (NEW) — 6 launch scenarios (Tier 1: awaiting_payment, stock_shortfall,
    order_eta_update; Tier 2: missing_details, part_superseded, quote_offer), each
    `{key,label_en,label_nl,prompt_skeleton,required_identifiers,suggested_lookups,knowledge_refs}`.
    `byKey()`, `forModel()` (hints WITHOUT the skeleton), `chips(uiLang)`. Editable data, mirror-discipline.
  - **`resolve-customer.js`** — added **`pickRecipient(validAddrs, pickAddr)`** (exported): the
    recipient gate. Returns a recipient ONLY if it's in the resolver's own address set; a picked
    address not in the set is REJECTED with no fallback; no pick + one address → that address;
    no pick + several → "" (force a human choice).
  - **`server.js`** — requires (RESOLVE/COMPOSE/SCEN/crypto); EN+NL compose i18n; modal CSS; helpers
    `defaultMailbox` (by `owner_label`), `composeConvKey` (synthetic unique `compose:<ts>-<rand>`),
    `asArray`. Routes: **`/compose/resolve`** (AJAX, read-only — resolved recipient or candidate/
    address picker inline, never auto-picks) and **`/compose`** (re-resolves server-side, validates
    recipient via `pickRecipient`, runs `composeDraft`, persists `origin='compose'` work item +
    modal attachments, redirects to detail). Inbox `+ New email` button + modal (combined identifier,
    scenario chips that pre-fill the instruction, language auto+EN/NL/DE/FR/ES, send-from mailbox,
    drag-drop base64 attachments); ✏ marker on compose rows.
  - **Security:** recipient is resolver-only — the route re-resolves on submit (never trusts the
    posted address), `pickRecipient` rejects anything not in the resolver set, and `compose_customer`
    stored for the model carries NO addresses. Decisions this step: launch **Tier 1+2 (6) chips**;
    **attachments collected in the modal** (base64 passthrough, attached on create).
  - **Verified:** `node --check` all files; the emitted 142-line client modal script parses;
    **27/27 logic asserts** on a real SQLite built from the live `db.js` schema (exact route INSERT +
    persist SQL, `UNIQUE(mailbox,conversation_key)` guard, every `pickRecipient` branch incl.
    tampered-address reject, scenarios API).
- **Step 3b DONE & verified in the sandbox (2026-06-08) — compose detail page + redraft + send guard.**
  All in `server.js` (the safety-critical half), still draft-only, NOT yet deployed:
  - **Detail page (`/item/:id`) compose branch.** For `origin='compose'` the top shows the trusted
    instruction (`compose_instruction`), the resolved customer (`compose_customer` JSON: name, cardCode,
    country, contact, guest/frozen flags, notes) and the **confirmed To** (`w.recipient`) — replacing the
    inbound "Customer email" box. The `#mq`/`#mailwrap` search script is null-guarded (can't crash when
    that box is absent); the inbound-email translation is skipped (draft translation kept for a
    cross-language viewer); a **"New email" origin chip + draft-only note** are shown. Everything else is
    reused unchanged (status chips, AI-draft reference, editable "reply to send", staged attachments,
    feedback, questions, save/redraft, done/archive/reopen, brief). **The Send button is absent for compose.**
  - **`runRedraft` compose branch.** Rebuilds `resolved` from `compose_customer` (no addresses), keeps the
    recipient **code-held from `w.recipient`**, folds answered questions + feedback into the **TRUSTED**
    instruction (`taskPrompt`, never the untrusted block), `scenario=SCEN.forModel(w.scenario)`,
    `language=w.language`, calls `COMPOSE.composeDraft`, persists via the shared persister, and updates
    `injection_flag` + subject. The inbound reply path (`gatherSeed`+`agenticDraft`) is unchanged.
  - **Route-level send refusal.** `/item/:id/send` refuses `origin='compose'` at the top with an audited
    403 — **action #3 is OFF at the route, not just a hidden button.** `send-guard.js` is untouched (Step 4's gate).
  - **Verified:** `node --check`; a sandbox harness loading the **real** `server.js` route code (only the 5
    external/native deps stubbed; DB = real SQLite from the live `db.js` schema) — **38/38 asserts**: compose
    detail renders with no inbound assumptions and no Send button; inbound detail still has its search box +
    Send button (regression); redraft folds Q&A + feedback into the trusted instruction with the recipient
    code-held and the rebuilt customer carrying no addresses; the send route returns 403 + audits for compose
    while a flagged inbound still reaches the real send-guard (compose guard never intercepts inbound).
  - **Next — 3c:** manual-place the new modules (`resolve-customer.js`, `compose.js`, `scenarios.js` —
    `axle-pull` won't auto-collect new filenames from Downloads) + push `db.js`/`server.js`/
    `business-knowledge.md` via Taildrop, restart **Axle Server**, then **Gate C** (Brad composes several
    emails across scenarios + both languages, reviews drafts — nothing sends).
- **Step 3c DONE — deployed to the box (2026-06-08, commit `c1dfce5`).** All 7 files placed + node-checked
  (`resolve-customer.js`/`compose.js`/`scenarios.js` placed manually; `server.js`/`db.js`/`engine.js`/
  `business-knowledge.md` via the puller; `engine.js` added to the set to guarantee the Step-2 `opts` hook is
  present). Axle Server restarted clean on the new code (listener back on 8484; `db.js` compose-column
  migration ran with no error). Taildrop delivered only 5 of 7 files on the first send — re-sent and
  verified by size before placing.
- **Gate C — draft-only review PASSED on safety (2026-06-08): every compose across scenarios + both
  languages drafted and held; no Send button, nothing sent.** Brad's feedback opens a **Compose Step-3
  polish backlog** (all draft-only; action #3 stays OFF) to sequence before Step 4. **Trio 1 + 4 + 5
  (modal, skeletons, editable language) DONE & verified in the sandbox 2026-06-08 (20/20 asserts);
  pending box deploy (`server.js` + `scenarios.js`). Remaining: 2 (resolver, next) then 3 (PDF).**
  1. **Modal close behaviour** — only close on X / Cancel / Esc, never on outside-click or a drag-release
     outside the form (drag-selecting text currently dismisses it). **DONE** — removed the backdrop-click
     close, added an Esc handler; X + Cancel unchanged.
  2. **Customer search rework (`resolve-customer.js`). DONE & verified on live SAP (2026-06-09).** New
     unified `searchCustomers` over CardCode, CardName, **CardFName**, LicTradNum, E_Mail, U_E_Mail, Phone1,
     Phone2 — partial ("contains") + **multi-word token-AND across fields**, **phone normalised** to the
     trailing national digits (any of +32/0032/0/dash/space formats match), **partial email** in `byEmail`
     (exact on E_Mail OR U_E_Mail → partial → only a complete unmatched address becomes guest, so no false
     "guest"), VAT, and a **light Levenshtein fuzzy fallback** (4-char-prefix prefilter, edit-distance ≤2)
     when strict finds nothing. A bare number tries SO/invoice first then falls to phone/search; a card-code
     miss falls to search. **Relevance ORDER BY** (exact → name-prefix → first-token-in-name → shorter name)
     keeps the best matches inside the `TOP 51` even when a common token matches thousands ("van" = 3,664),
     with a "too many — narrow it" message past 50. Search returns ranked **candidates** the human picks;
     `pickRecipient` and the recipient gate are unchanged, so fuzzy never weakens recipient safety. Verified:
     `node --check` + 23 JS asserts + the generated SQL run on live SAP — "Laurens Michiels", bare "Laurens"
     (21 matches), "laurens@yvesmichiels" (partial), the phone, and "van dijk" all surface K127177 / the
     right tight set; all four compose harnesses still green (95 asserts total).
     **Round 2 (2026-06-09, from Brad's live test):** added **postcode** search (ZipCode + MailZipCod,
     space-normalised so "3335 LH" and "7075EL" both match; token-AND pins the row), restricted all
     discovery paths to **active customers only (`validFor='Y'`** — 26,070 active / 359 inactive), made the
     **fuzzy** fallback per-token (prefix-union prefilter + token-AND edit-distance) so "aubroek automotive"
     now finds "Aubroeck Automotive" (the old longest-token prefilter drowned in ~2,000 "auto%" rows), and
     fixed the modal to show the resolver's own message (a single match no longer reads "more than one").
     98 asserts green + live SQL confirmed (postcode 2860/3335 LH, validFor, aubroek->Aubroeck). Deployed.
     **Round 2b (2026-06-09): richer candidate pick-list** — each result now shows Code / Name / Foreign
     Name (CardFName, when present) / email / country in a clean stacked two-line layout, keeping the subtle
     match reason (e.g. 'email contains "laurens@yve"'); `/compose/resolve` passes `contactName`+`email`
     through. server.js only; 101 asserts green (incl. an emitted-modal-script compile check). Pending box
     deploy (`server.js`).
  3. **SAP document PDF attach. DONE, DEPLOYED & gate-signed-off (2026-06-09).** Attach the standard Boyum
     print PDF of a referenced doc (order/invoice/quotation/delivery/credit note) to a compose email, as if
     printed + attached by hand. **Mechanism: headless Crystal render on the box** — Boyum `Documents.rpt`
     rendered by the SAP Crystal Reports runtime (v13.0.40) + SQL Native Client 11.0, repointed to
     **axle_read (read-only, encrypted)**, keyed by `ObjectId@`+`DocKey@`. New: `Documents.rpt` +
     `render-doc.ps1` on the box, `sap-doc-pdf.js` (DocNum->DocEntry via parameterised axle_read SQL;
     DocEntry never model-chosen), and a compose-only "Attach SAP document" control + `/item/:id/attach-doc`
     route (renders read-only, stages into `draft_attachments` behind the approval gate; customer-scope
     guard; ambiguous-pick validated in-set; nothing sends). Verified live on the box (226108 attaches same
     customer, 226449 warns different customer, junk rejected, no Send button). **This was the last open
     backlog item — the Compose Step-3 polish backlog is now fully closed.**
  4. **Scenario prompt skeletons** — restructure from a paragraph into a headed / FAQ fill-in-the-blanks
     layout so staff can supply the needed info easily (`scenarios.js`). **DONE** — all 6 skeletons now
     headed multi-line (Situation / Stock / Ask / Must include / Offer …); IBAN policy retained.
  5. **Editable task language** — on the compose detail page, let the user change the (auto-inferred)
     language (e.g. NL → EN) and re-draft in the chosen language. **DONE** — language selector in the
     compose header + `/item/:id/language` route (compose-only; sets `w.language`, status→investigating,
     reuses the redraft loop). Inbound replies still follow the customer's own language.
  6. **Rich prompt editor + async compose (Gate-C feedback round 2, 2026-06-09). DONE & verified
     (14/14 asserts; 72/72 across all three compose harnesses).** (a) The modal instruction field is now a
     `contenteditable` rich editor: scenario skeletons render with **bold frame labels** ("Situation:") and
     **subtle italic guidance**, mirrored to a hidden plain-text `#instruction` field on input/submit
     (paste forced to plain text; submitted value is always plain). (b) **Compose creation is now
     asynchronous** — `POST /compose` creates the item as `investigating` and runs the research+draft in
     the background via `runRedraft` (`setImmediate`), redirecting instantly; the detail page shows the
     investigating banner and auto-refreshes, ending the 30-60s "Drafting…" hang. Pending box deploy
     (`server.js` only).

### Session 5 (2026-06-08) — Jack onboarded + drafting/ingest polish
- **Gate 4 — Jack onboarded.** Per-user identity established the right way: salespeople had
  no individual logins (all shared the info@ sign-in). Created a real Entra account
  `jack@budget-parts.nl` (no licence — SSO identity only; info@ stays a shared mailbox).
  Tailscale on Jack's PC re-authed under his own account (was briefly admin@); device
  approved (User Approval is on). 403 test passed BEFORE registering (identity resolved as
  `jack@budget-parts.nl`, hard 403, logged). `register-user.js jack@budget-parts.nl "Jack"
  sales`; Jack reaches the inbox, no Audit link. **Identity model decided: one Entra account
  per salesperson (unlicensed), shared mailboxes stay shared.** Aliases do NOT work for
  sign-in.
- **Inbox scope filter** (`server.js`, `db.js`): new **Items: Assigned to me / All** segment
  (NL "Aan mij / Alles"), first in the toolbar. "Assigned to me" filters `work_items.owner`
  against the user's `owner_label` (new nullable users column; falls back to display_name, so
  Jack="Jack" needs no setup). Default per role: sales→mine, admin→all; both toggle, choice
  rides the URL. Future users: set owner_label (Rob/Huub→"Drachten", Brendan→"Brendan").
- **Ingest is now unread-only everywhere** (decision this session). Scheduled task
  (`run-ingest.ps1` → `node ingest.js <box> 20 unread`) AND the manual Sync now button
  (`server.js` `runBoxes(..., { unread:true })`). Rationale: handled items are marked read,
  so read mail = already dealt with; keeps the queue to genuine open work. Tradeoff accepted:
  an email read in Outlook before handling won't be ingested. A deliberate full rescan is
  CLI-only: `node ingest.js all 50` (no `unread`) — never from the UI. NOTE: this reverses
  the session-4 "Sync = full" sub-decision.
- **Customer-code product hyperlinks** (`agent-tools.js`, `business-knowledge.md`,
  `engine.js` already had the format rule, `send-guard.js`, `server.js`). Drafts now cite a
  part as a clean markdown link `[CUSTOMERCODE – Product Name](roverparts.eu/products/<handle>)`,
  rendered to a real `<a>` by send-guard (which already supported markdown — the gap was it
  hadn't been re-deployed). **Customer code = COALESCE(NULLIF(U_Code_AllMakes,''),
  NULLIF(U_Code_BritPart,''), NULLIF(U_Code_Hotbray,''), NULLIF(U_WS_LRNo,''), ItemCode)** —
  the recognisable code, never the internal ItemCode (often a supplier/variant code, e.g.
  ItemCode STC359R → customer code STC2797). Verified live: clean clickable links, correct
  codes. Detail-page `linkify` now also renders markdown links (clean previews).
- **Noise-rule fix** (`rules.js`): `noise_marketing` now archives `exmoortrim.co.uk` (was the
  non-existent subdomain `mail.exmoortrim.co.uk`), plus `hbm-machines.com`, `ehbo-koffer.nl`.
  These unread newsletters were becoming work items; now correctly `noise`.
- **Timezone fix** (`server.js`): DB timestamps are naive UTC; `new Date()` read them as local
  (1–2h off). New `parseTS()` marks SQLite datetimes UTC; Graph timestamps (…Z) unchanged.
- **`wipe-slate.js`** added: exports audit_log to `C:\Axle\logs\pre-wipe\` then clears all
  transactional tables (keeps users + sync_state); `--yes` required, dry-run default. Used to
  reset to a clean unread-only kickoff.

### Next up — session 6
- **"Create new email" / Compose feature** — full build brief written
  (`Axle — Compose feature — build brief.md`), to be run in a dedicated chat. Phase 6
  proactive-mode brought forward; gated behind a NEW allow-list action #3 "send new
  (non-reply) email". Locked decisions (Brad 2026-06-08): (1) Axle sends in-app via Graph =
  action #3; (2) composed email becomes a FULL work item; (3) free prompt + seeded scenarios;
  (4) auto-infer language (prior correspondence → country map NL/BE→NL, DE→DE, FR→FR, else EN)
  with manual EN/NL/DE/FR/ES selector + dual-language view. Reuses engine.js agenticDraft
  (compose-mode seed + prompt variant), translate.js, attachments, questions/redraft loop,
  send.js (originalMessageId=null for fresh send), send-guard.js. NEW modules: resolve-customer.js,
  compose.js, scenarios config. **Core security change:** recipient no longer hard-locked to an
  inbound sender — it is deterministically resolved (SAP/Shopify), shown, human-confirmed, and
  SHA-tied; model/data can never set it. Trust split inverts: salesperson prompt = trusted
  instruction, all system/customer data = untrusted. Scenario shortlist mined from ~50 real
  info@ Sent items (reply-dominated; kick-offs = invoice/credit-note notices, missing-details-to-
  ship, discontinued-part advice, shipping-delay). Build plan: 5 steps, gates A–D, draft-only
  until action #3 enabled. drachten@ Sent not readable from chat — mine on the box during build.
- **Finish Gate 4:** live walkthrough with Jack on a real unread item (info@ was empty at
  session end — all test mail read; new unread mail flows in on the 15-min schedule, or send
  a test); then re-test **drachten@ Send** (RBAC had been propagating since session 4).
- **Parked findings:** (1) cosmetic — confirm timezone fix renders correctly in Jack's view;
  (2) widen noise rules further as new marketing senders appear; (3) Drachten owners still
  share label "Drachten" — set owner_label for Rob/Huub when they onboard.

### Session 5 (2026-06-08) — Pre-Jack bug-fixes & polish
Four UI fixes before rollout to Jack's PC (changed files: `server.js`, `rules.js`; `db.js`
re-pushed):
- **Feedback save crash fixed.** "Your feedback" wrote to `work_items.feedback`, but the box's
  `db.js` predated that column (only `server.js` had been pushed in session 4) → `SqliteError:
  no such column: feedback`. Fix = re-push `db.js` (the idempotent `ensureColumn` migration adds
  it) + restart. Redraft already feeds feedback into the seed alongside answered questions, so
  the "considered together" requirement is met once the column exists.
- **Sortable inbox columns.** Every header is click-to-sort (asc/desc, with a ▲/▼ indicator);
  correct typing per column (num / text / date — Updated sorts on the raw ISO via `data-sort`,
  not the friendly label). Choice persists per browser tab. Coexists with search filter.
- **Filter header redesigned.** Mailbox / Status shown as labelled segmented pills (All · Info ·
  Drachten / Open · Done · Archived · All), search pushed right.
- **Drachten owner = "Drachten".** `rules.js` now stamps owner "Drachten" on all Drachten rules;
  a display fallback (`ownerLabel`) covers already-ingested rows immediately.
- **Friendly timestamps.** `Today/Yesterday 10:32am`, weekday within the week, `Fri 5 Dec, 10:32am`
  (+year if different) for older. Europe/Amsterdam, 12-hour.

### Session 5e (2026-06-08) — Sync lock fix + clean product hyperlinks
Changed `server.js`, `ingest.js`, `send-guard.js`, `engine.js`.
- **Sync button fix.** The detached child process held the lock but didn't reliably release on
  the box (button stuck on "Syncing…", "Last synced: never"). Reworked so the manual Sync runs
  **in-process** in the server (background, lock released in `finally`), and `ingest.js` now
  exports `runBoxes()` with the CLI/scheduled path guarded by `require.main`. Added a startup
  reset of a stuck `running=1` flag, so a server restart mid-sync self-heals. (The scheduled
  task is unchanged; the DB lock still serialises everything — no run-ingest.ps1 change needed.)
- **Clean product hyperlinks.** AI replies now write product/tracking links as markdown
  `[ITEMCODE - Product Name](handle URL)`; `send-guard.toSafeHtml` renders allowlisted markdown
  links as clean anchors (visible text = code + name, not the raw URL). Safe because the URL
  allowlist is still enforced — an href/text mismatch can only ever point to our own domains,
  so it can't disguise a phishing link; off-allowlist links are still refused. Bare URLs still
  render as themselves. Editor shows the markdown source; the sent email is clean.
- **Open question:** confirm the customer-facing item code = OITM.ItemCode (part number like
  DA4634) or a distinct field — prompt currently says "customer-facing item code (the part
  number the customer recognises)".

### Session 5d (2026-06-08) — Reply-translate, drag-drop, manual Sync
Changed `server.js`, `db.js`, `ingest.js`. Box: update `run-ingest.ps1` to `node ingest.js all`.
- **Translate my reply.** A button under the reply box (shown when the customer's language ≠
  the viewer's) POSTs the current edited text to `/item/:id/translate-reply` and shows the
  translation inline — so you can read what you're about to send. Cached like all translations.
- **Drag-and-drop attachments.** The Attachments box is now a drop zone; picker or drag-drop,
  multiple files at once, via a new AJAX `/item/:id/attach-add` (persists the in-progress reply
  first, then reloads). Replaced the old single-file form-submit path.
- **Manual "Sync now".** Button in the inbox header spawns `ingest.js all` (detached) to fetch
  both mailboxes on demand; shows "Last synced: …" and auto-refreshes while running.
- **Overlap lock.** New single-row `sync_state` table + `acquireSync/releaseSync` (10-min stale
  reclaim). `ingest.js` gained an `all` mode and takes the lock for its whole run, so the
  scheduled task and the manual button can never run two ingests at once. **Box step:** point the
  scheduled wrapper at `node ingest.js all` (one locked process for both mailboxes).
- **Cadence finding:** polling frequency barely affects API cost — classify+draft only run on
  unseen emails (dedup by latest_message_id), so cost is per-email not per-poll. Kept 15 min;
  the lock makes shortening safe if wanted. Manual Sync covers "I'm waiting on a reply now".

### Session 5c (2026-06-08) — Editable replies, attachments, send-anytime
Changed `server.js`, `send-guard.js`, `send.js`, `db.js`, `ingest.js`.
- **Editable "Reply to send" box.** One editable box holds the exact text that goes to the
  customer, seeded from the AI draft (or holding reply). The AI versions stay visible read-only
  ("AI draft (reference)", with the translation beneath) and "Use this" copies one in. The human
  edit persists in `work_items.draft_edit` (cleared whenever a fresh AI draft is generated).
- **Send at any time.** Dropped the status='ready'/questions-answered gate — a salesperson can
  edit and send whenever they like (e.g. a holding reply while questions are still open). The ONE
  hard exception kept absolute: an injection-flagged item can never send. `assembleSend` now
  validates the FINAL body (recipient hard-locked, URL allowlist enforced on edited text too,
  empty refused, safe-HTML) instead of a stored AI draft row.
- **Attachments.** Pictures/files attach to the outgoing reply — browser base64-encodes into a
  hidden field (no multipart, no new dependency; urlencoded limit raised to 16 MB), stored in a
  new `draft_attachments` table, sent as Graph fileAttachments. 3 MB per file / per item cap.
  Bytes deleted after send; names/sizes kept in `sends.attachments_json`.
- **Audit / self-improvement history.** Both sides are now retained for every send: the AI draft
  (`drafts.source='ai'`) and the actual sent text (`sends.body` + a `source='human'` draft, linked
  via `sends.source_draft_id`). `email_sent` audit logs `edited=true/false`, the AI draft id, and
  attachment count — so an AI-draft-vs-sent training set builds automatically. Pairs query:
  `SELECT s.body AS sent, d.body AS ai FROM sends s LEFT JOIN drafts d ON d.id=s.source_draft_id`.
- **Send de-dup** moved to a UNIQUE index on `sends(work_item_id, body_sha256)` + a pre-check
  (replaces the old UNIQUE(draft_id)); a double-click of the identical body can't email twice,
  but a deliberately different edited resend (after Reopen) is allowed.
- Allow-list action #1 (Send) is unchanged in privilege; it now simply carries the human-approved
  edited body and optional attachments through the same deterministic guardrails.

### Session 5b (2026-06-08) — Bilingual UI + on-view translation
Each user works in their own language; customer content is translated for them on demand.
New file `translate.js`; changed `server.js`, `db.js`, `engine.js`.
- **Per-browser language toggle** (EN/NL in the header, stored in an `axle_lang` cookie,
  default EN). All of Axle's own wording — nav, filters, column headers, chips, questions,
  feedback labels, buttons, banners, friendly timestamps (NL = 24-hour Dutch) — renders in
  the chosen language via a complete `STRINGS` dictionary (76 keys × en/nl, key-parity tested).
- **On-view translation, cached.** New `translations` table keyed by sha256(lang+text); each
  unique string translated once (Haiku) then served from cache, so the auto-refreshing pages
  don't re-spend. `translate.js` treats text strictly as data (no instruction-following).
- **Translated blocks on the item page.** When the customer's language ≠ the viewer's, a
  labelled "translation" block appears under the customer email and under the draft (display-
  only; the real draft above is still what gets sent verbatim). Questions are now authored in
  English (engine rule) and translated to the viewer's language; summaries likewise.
- Languages compared off `work_items.language` (customer) vs the viewer's cookie, so e.g.
  Brad (EN) on a Dutch customer sees EN translations of the email + Dutch draft + EN draft
  translation; Jack (NL) sees everything in Dutch. No translation calls when languages match.
- **Deploy note:** `translate.js` is NEW — the box puller only auto-collects new files from
  `C:\Axle\_incoming`, not Downloads. Place it once manually (see session steps), after which
  it's "known" and updates normally.

### Session 4 (2026-06-07) — Send button + polish
- **2.3 injection hardening** completed & signed off (37/37; see the ✅ section below).
- **Phase 5 action #1 — Send:** `send-guard.js` (deterministic guardrails) + `send.js`
  (Graph reply-in-thread via Mail.Send, RFC threading by In-Reply-To/References extended
  properties, quoted history beneath the reply) + Send button in `server.js` (confirm-click,
  one-send-per-draft via `sends` table, audit with Graph msg id). Verified end-to-end to
  brad@sharnock.com. Mail.Send granted via Exchange RBAC, scoped to info@/drachten@ (admin@
  denied); drachten@ send pending RBAC propagation (config verified correct) — re-test before
  Drachten rollout.
- **Action #2 — mark-as-read** on send/done/archive (Mail.ReadWrite, scoped).
- **UX:** friendly status/intent labels, fixed column header, cleaned meta line; **"Your
  feedback"** free-text field above the questions (trusted staff input into redraft); a
  **Redraft now** button when an item is held with questions answered; inbox **done/archived**
  views; more human, less-fluffy draft tone.
- **Voicemail caller lookup:** voicemail@hipservice.nl emails are matched to OCRD by phone
  (last-9-digit normalisation across +31 / 0031 / 0 / spacing); match shown in inbox/item.
- **Rollout (box-local, from 2026-06-13):** dev and runtime are on the same machine now — promote
  from `C:\Admin\Projects\Axle\box-code` into `C:\Axle\app` locally (copy changed files → `node --check`
  → restart Axle Server); new asset/CSS files placed once by hand, `axle-pull.ps1` handles the JS
  (repointed from the old Mac Taildrop inbox to the local `C:\Admin` source). No Mac, no Taildrop.
  Isolation holds: the `axle` user never reads `C:\Admin`; `bradmin` places the built files into
  `C:\Axle\app`. See box conventions.
- **Ingest:** optional `unread` mode (`node ingest.js <box> [count] unread`) processes only
  unread mail — now meaningful since handled items get marked read.

### Done so far
- Project kickoff; roadmap created (2026-06-05).
- 0.1 `axle@budget-parts.nl` alias created on admin@ mailbox, test mail verified (2026-06-05).
- 0.2 Anthropic org "Axle — Budget Parts B.V." created under axle@, €25 credits, $50/mo cap,
  no auto-reload, key **axle-api-key** stored in password manager (2026-06-05).
- 0.3a Laptop factory-reset, local admin `bradmin` (no Microsoft account), upgraded to
  Windows 11 Pro, activated, fully updated (2026-06-05).
- 0.3b Low-privilege local user `axle` created (standard Users group, not admin),
  password stored in password manager (2026-06-05).
- 0.4 Never-sleep / never-hibernate power settings applied; lid-close = do nothing; Modern
  Standby (S0, network connected) hardware — timeouts 0, hibernate + fast startup off;
  closed-lid RDP survival tested (2026-06-06).
- **Gate 0 signed off by Brad (2026-06-06).** Phase 0 complete.

> **Note:** step order changed — Tailscale + Remote Desktop moved ahead of Node/Git so that
> commands can be pasted from the MacBook into the box (shared clipboard over RDP).

- 0.5 Tailscale live on box + MacBook (tailnet owned by admin@ via Microsoft sign-in);
  Remote Desktop enabled (NLA on); Mac connects via Windows App over Tailscale with shared
  clipboard (2026-06-06). *Phase 7 reminder: restrict RDP to the Tailscale interface only.*

- 0.6 Node v24 LTS, npm 11, Git 2.54 installed machine-wide via winget; PowerShell execution
  policy set to RemoteSigned (LocalMachine) so npm runs (2026-06-06).

- 0.7 Secrets handling: `C:\Axle\` structure created (app / secrets / logs); `.env` holding the
  Anthropic key, ACL verified = SYSTEM / Administrators / axle only; password manager is the
  master record (2026-06-06).

- 1.1 SQL login `axle_read` created on SAP SQL Server, db_datareader on **BP_LIVE** only;
  verified SELECT works / UPDATE denied (2026-06-06).

- 1.2 Shopify custom app "Axle (read-only)" via dev dashboard, installed on store.
  Six read-only scopes (orders, customers, products, inventory, fulfillments, shipping).
  **New-style auth:** no permanent token — client credentials grant exchanges Client ID +
  secret for a 24h token at `https://eba3de-2.myshopify.com/admin/oauth/access_token`;
  Axle's code auto-refreshes. **GraphQL Admin API only** (REST rejects new apps).
  Store handle: **eba3de-2.myshopify.com**. Verified: read OK, productCreate ACCESS_DENIED
  (2026-06-06).

- 1.3 Entra app "Axle Mailbox Reader" (client secret, 24 mo). Mailbox access via **Exchange
  RBAC for Applications**: management scope "Axle Mailboxes" (CustomAttribute10='AxleRead' on
  info@ + drachten@), role "Application Mail.Read" within scope only. Tenant-wide Graph
  Mail.Read consent **revoked** — RBAC scope is the sole access path. Verified via Graph:
  info@ OK, drachten@ OK, admin@ ErrorAccessDenied (2026-06-06).

- 1.4 MyParcel API key stored and verified against `api.myparcel.nl/shipments`.
  *Caveat: MyParcel keys cannot be scoped read-only — code-level restraint + allow-list
  are the control* (2026-06-06).

- 1.5a–c `.env` completed (14 secrets); Node app scaffolded in `C:\Axle\app` (git, mssql,
  dotenv, Anthropic SDK); all four read connections verified **from the box**: SAP SQL
  (encrypt on), M365 Graph (info@), Shopify GraphQL, MyParcel (2026-06-06).

- 1.5d `brief.js` working end-to-end on both mailboxes: newest email → SAP/Shopify/MyParcel
  lookups → Claude brief (model claude-sonnet-4-6) → `C:\Axle\logs\brief-*.md`. Email body
  passed as untrusted data; injection-flagging instruction in system prompt. Correctly
  identified a Trusted Shops notification and SEO spam as no-action. Committed (2026-06-06).

- **Gate 1 signed off by Brad (2026-06-06).** Real-customer-email quality check deferred
  into Phase 2 batch testing (Brad's call — batches will cover it within days).

- 2.1 `rules.js` (routing rules ported from info-triage skill, per-mailbox) + `triage.js`
  (batch read-only triage: deterministic rules → Haiku classification → log). First info@
  run: 20 emails, rules engine + classifier working (2026-06-06).
- Side win: triage flagged unresolved Boyum syntax (`$[$BOYX_13.0.0]`) leaking into customer
  invoice emails — fix: use standard CardName item `$[$54.0.0]` in the B1UP report action.

- 2.2 Accuracy review done over two rounds (info@ + drachten@, 20 emails each):
  customer_invoice_reply + customer_order_reply rules, per-mailbox voicemail owner,
  "ontvangen" keyword removed, marketing-noise + shipment-notice rules, b2b_order
  definition tightened. Both mailboxes triaging cleanly, 0 false injection flags
  (2026-06-06).

- **Gate 2 signed off by Brad (2026-06-06).**

- 3.1 `connectors.js` shared read-only module (incl. stock/price + order lookups);
  triage regression-tested OK (2026-06-06).
- 3.2 `drafts.js` v1: entity extraction → fixed context gathering → Sonnet draft +
  questions + physical checks → `C:\Axle\logs\drafts\`. Brad reviewed 8 real drafts:
  tone right; too passive — punts lookups to the salesperson instead of using the data
  (2026-06-06).

- 3.3a `business-knowledge.md` v1 done — TODOs resolved: Drachten = Het Gangboord 4C
  9206 BJ; shipping policy summarised from roverparts.eu (live page authoritative);
  carrier options/lead times derived live from MyParcel data; all prices EXCL. VAT
  (SAP + webshop). Deep refinement passes scheduled: continuous through Gate 3,
  dedicated pass at Phase 4 pilot start, final review before Phase 6 rollout.
- 3.3b Drafts engine v2 **done** (2026-06-06): `agent-tools.js` (sap_query with
  SELECT-only guard, shopify_query mutation-rejected, myparcel_search) + `drafts2.js`
  agentic loop (Sonnet, max 8 tool turns, seed context, business-knowledge.md in system
  prompt, tool-call audit log per draft). Fixes after first runs: robust JSON extraction
  (first `{` to last `}`); shipping-costs rule (priced at checkout, never offer quotes);
  shipping-history method (RDR12/INV12.CountryS + MyParcel cross-check); MyParcel
  results include city/country; plain-text rule tightened (no markdown links).
  Brad review of info@ run: very happy — Croatia draft investigated properly (10 tool
  calls, real INV12 history). Note: drafts2.js logs are UTF-8 — read with
  `Get-Content -Encoding UTF8`.

- 3.3c v1/v2 comparison done on info@ + drachten@ (2026-06-06): v2 investigates properly
  (Croatia case solved via INV12 + MyParcel cross-check); Brad happy with output quality.
- 3.3d v2.1 **done** (2026-06-06): thread grouping (sender + normalised subject, fallback
  conversationId — Graph conversationId alone splits when customers send fresh emails);
  **two-stage workflow** (status ready/awaiting_input — blocking questions HOLD the draft,
  filler like "doorgestuurd aan ons technisch team" banned, optional interim_draft the
  salesperson may choose to send); 4th tool **mailbox_search** (Graph $search by sender,
  whole mailbox) so Axle retrieves referenced correspondence itself. Verified on the
  3-email Santana thread: one work item, prior email found, draft held with 4 solid
  questions + 1 physical check.

- **Gate 3 signed off by Brad (2026-06-07).** Phase 3 complete. No send capability,
  no system writes anywhere; injection-hardening program still deferred, hard-gates Phase 5.

- **Phase 4 decisions (2026-06-07):** web stack approved — Node/Express + better-sqlite3 +
  htmx (server-rendered, no build step), bound to the box's Tailscale IP only, per-user
  identity via `tailscale whois` on the connecting IP (no passwords). Pilot: **Brad runs
  his own day in it first**, then picks Jack or Brendan.

- 4.1 SQLite data layer done (2026-06-07): `db.js` — work_items (UNIQUE mailbox+conversation_key),
  questions, drafts, users, audit_log; DB at `C:\Axle\data\axle.db` (WAL). Note: data dir
  created as bradmin — verify `axle` user write access at service-setup step.
- 4.2 Web server done (2026-06-07): `server.js` binds to box Tailscale IP only (100.114.231.11:8484);
  identity via `tailscale whois` per request (10-min cache), unknown users → 403 + audit;
  `register-user.js`; firewall rule allows 8484 only from 100.64.0.0/10. Brad registered
  (admin@budget-parts.nl, role admin) and verified hello page from Mac. Known gap: whois call
  has no timeout — harden later. Server runs in a foreground window for now; Windows service
  comes later in Phase 4.

- 4.3a Box code mirrored to project folder `box-code/` (2026-06-07). **Discovery: the 3.3a
  business-knowledge updates never landed in the file** — TODOs were still live through all
  Phase 3 draft runs.
- 4.3b `engine.js` done (2026-06-07): thread grouping, Haiku classify, seed context, agentic
  draft loop extracted from triage.js/drafts2.js into one shared module. db.js gained
  owner/rule_id/summary/confidence columns via ensureColumn migrations. Paste gotcha found:
  chat copy linkifies bare URLs even in code blocks — keep URLs out of pasted content
  (placeholder + .Replace with concatenated string).
- 4.3c business-knowledge v1.1 (2026-06-07): TODOs resolved for real — Drachten address +
  both branch phone numbers; dispatch cutoff **14:00 business day = same-day**; discount
  tiers Standard/Plus/Pro/Elite/Special (0/5/10/15/20%, est. annual spend = 6-mo invoices
  minus credits ×2, monthly review, per email address); tier lookup OCRD.ListNum → OPLN;
  carrier options derived from MyParcel history. Mirror in box-code/ updated to match.

- 4.3d `ingest.js` done (2026-06-07): emails → rules + classify → agentic draft → work
  items/drafts/questions in SQLite. First info@ run: 10 items (4 ready, 4 awaiting_input,
  2 new for Tom), vendor pitches correctly held with confirm-spam questions, physical
  checks captured. Re-run verified idempotent (all `unchanged`, 0 tool calls).

- 4.4 Inbox page done (2026-06-07): prioritised open items (injection first, then prio,
  then freshness), status chips, mailbox filter, open-question counts, audit-logged
  views; verified in browser from the Mac. Possible cosmetic: header bar text may not
  render — check next pass.

### Next up
- 4.5a/b done (2026-06-07): work items store email body + received time (wipe + re-ingest,
  items 11–20); detail page live — email, draft/interim, questions, investigation,
  audit-logged. Header bar renders correctly.
- 4.6 done (2026-06-07): answer-questions → redraft loop. Answers saved under tailnet
  identity; redraft re-runs the agentic engine with answers injected into seed context as
  trusted staff input (no engine change needed). Verified on item 11: ready, confidence
  high after Brad's test answers. **Test answers were assumptions — wipe work items before
  pilot start.**
- 4.7a done (2026-06-07): U_Quality (Genuine/OEM/Aftermarket) documented as authoritative
  in business-knowledge.md + sap_query tool description; U_WS_OEM marked unused. Mirror
  updated.

### Knowledge maintenance process (agreed 2026-06-07)
Permanent knowledge lives in two git-tracked places only: `business-knowledge.md` (facts,
policy) and `agent-tools.js` tool descriptions (schema hints). Salesperson answers affect
only their own item — no global learning, by design. Process now: Brad reports a gap →
patch both file and mirror. **Phase 6: build a "teach Axle" capture flow** — salesperson
flags an answer as "Axle should know this", queued for Brad's review, approved entries
appended to business-knowledge.md. Nothing enters the knowledge base without Brad.

- 4.7b done (2026-06-07): background redraft (investigating status, auto-refresh,
  inbox stays usable), copy-draft, mark done / archive / reopen, stuck-job recovery on
  startup. Verified by Brad.

- 4.8 done (2026-06-07): **architecture change — Tailscale Serve replaces whois.**
  CLI whois failed under axle (401: connection owned by bradmin). Fix: app binds
  127.0.0.1 only; `tailscale serve --bg 8484` (Serve enabled on tailnet by Brad) fronts
  it at **https://axle-box.tail58a804.ts.net** with TLS + identity headers
  (Tailscale-User-Login). Unattended mode on. 8484 firewall rule removed. ACLs: axle
  has M on data+logs, RX on app. Wrappers run-server.ps1 (keep-alive) / run-ingest.ps1
  via cmd-redirect + --no-deprecation. Scheduled tasks as axle ("Log on as batch job"
  right granted via secpol.msc): "Axle Server" ONSTART, "Axle Ingest" every 15 min.
  **Reboot test passed: inbox reachable with nobody logged in.** Both mailboxes ingesting
  (info@ 17 threads, drachten@ live). *Phase 7 note: loopback header-spoof caveat — a
  local process could fake identity headers; acceptable single-purpose box, review then.*

- 4.9 done (2026-06-07): admin-only /audit page (last 500, header link for admins,
  non-admin access denied + logged). **Scheduled ingest verified autonomous** — audit
  shows system-created items 31–34 at 10:42 UTC with no one logged in.

- 4.10 (2026-06-07): test data wiped (twice — second time for body re-extraction), live
  pilot started. Email-body formatting fixed in two passes: (1) htmlToText preserves
  line breaks (br/p/div/li → newlines); (2) better — Graph `Prefer:
  outlook.body-content-type="text"` header fetches Exchange-converted plain text;
  `bodyText()` uses it with HTML stripping as fallback. Committed.

- **business-knowledge.md v2 (2026-06-07, session 3):** full scenario-driven rebuild.
  Method: agents reviewed ~2 weeks of info@ inbound (~65 customer emails, 52 customers)
  + ~100 sent items to extract de-facto policies; Brad confirmed/corrected per category.
  New/expanded sections: part identification & fitment (canonical U_M_* list from IMDQ,
  source hierarchy, confidence gate, photo policy, answer style); returns & refunds
  (policy page + leniency rules, ~60-day flex, keep-it-credit exception, refund by
  original method, IBAN for bank/PIN); quotes & sourcing (always ex VAT, product
  hyperlinks, sourcing hierarchy, non-EU advice, Klantofferte as human action);
  payments & accounts (ORDR.U_Paid value map, 1-2 day bank lag, double payments → Brad);
  B2B email orders & order changes (SPOED, silent backorder + our-mistake exception,
  AR-invoice-as-changeability-check); warranty/missing/complaints (verify-first +
  ORIN return-rate check, age-based tone, <€10 missing-item leniency, express-late
  refunds). Mirror updated; box copy + git commit pending (Brad paste step).

- **Pilot findings round 1 (2026-06-07, session 3):** business-knowledge v2 live on box,
  work items wiped, 10 reprocessed. Brad's review → three engine fixes (mirror updated,
  box paste pending): (1) PROPOSE-DON'T-PUNT prompt rule — best-effort part suggestion +
  confirmation question instead of empty hands (#95 wheel nuts); (2) URLs always included
  bare-and-complete (MyParcel tracking, product pages via shopify_query handle) — true
  clickable hyperlinks deferred to the Send build (HTML email); (3) status 'no_reply'
  for conversation-closing emails (#101 thank-you) → item auto-done in ingest.js +
  server.js persistResult.

### Next up — session 3
- **Push engine.js / ingest.js / server.js fixes to the box** + git commit; wipe + full
  reprocess (info@, newest 50); restart Axle Server task (server.js changed).
- **Decision (2026-06-07): Send button live before Jack's first day** (adoption argument —
  copy-paste friction). Sequence, in order, honouring the 2.3 hard gate:
  1. **2.3 injection-hardening program** (hard gate): threat model; adversarial test set
     (25+ cases NL+EN: instruction override, fake system messages, tool-result injection
     via poisoned SAP/Shopify fields, exfiltration of system prompt/knowledge/margins/
     other customers' data, IBAN/URL swap, send-to-third-party, social engineering of the
     salesperson via the questions field); offline harness through the real engine;
     fix-and-rerun until clean; Brad signs off.
  2. **Deterministic send guardrails** (code, not model): recipient locked to thread
     sender, no CC/BCC, URL domain allowlist (roverparts.eu, budget-parts.nl, carrier
     tracking), draft sent verbatim-as-approved, one send per approval, full audit.
  3. **Mail.Send via Exchange RBAC** on the Axle Entra app, scoped to info@ + drachten@
     only (same pattern as Mail.Read); verify admin@ denied.
  4. **Send build:** reply-in-thread via Graph, plain-text draft converted to HTML with
     real hyperlinks ("ItemCode - Name" anchor pattern + tracking links), confirm-click
     UI, item → done, Graph message id in audit log. Allow-list action #1 entry.
  5. **Jack onboarding (Gate 4):** Tailscale on Jack's PC (M365 sign-in), 403 test BEFORE
     registering, then register-user.js (role sales); walk-through.
  Fallback if not signed off by morning: Jack starts copy-paste, or Send admin-only day 1.
- **Engine follow-ups from the knowledge review:**
  1. Add `web_research` tool to agent-tools.js (read-only fetch/search of part catalogues
     and general web; send only part numbers/vehicle data, never customer data) — the
     fitment section depends on it.
  2. Draft format: allow hyperlinks for webshop product links ("ItemCode - Name") —
     currently blocked by the plain-text/no-links rule from 3.3b.
  3. Attachment awareness: ingest should flag has-attachments on work items so drafts can
     say "customer sent photos — please view" (full attachment ingestion = later).
  4. Future/Phase 6+: JLR EPC lookup needs browser access — until then it stays a
     salesperson check.
- **Off-topic findings parked from the email review (for Brad):** B1UP Service Component
  AR-Invoice error mails every 30 min on Jun 3–4 (error storm — worth a look); Shopify
  order S17819 flagged "high risk of fraud" (Jun 6); EN return replies historically omit
  the Gouda return address (knowledge file now covers it).
- **Brad's pilot findings** — collect, triage, fix. Known candidates already noted:
  collapse quoted thread history behind a toggle on the detail page; assign drachten@
  catch_all + voicemail owners; business-knowledge refinements as gaps appear.
- Then **Gate 4 review**: audit log walkthrough, access control check (second-user 403
  test), Tailscale-only confirmation, pilot verdict → register first salesperson
  (Jack or Brendan, Tailscale on their PC).
- Phase 4 carries: work-item model keyed per conversation (consolidation on new inbound);
  interactive answer-questions → redraft loop; business-knowledge refinement pass at pilot
  start (add shipping cutoff times); assign drachten@ catch_all owner.

### Key design decisions from Brad's draft review (2026-06-06)
- Axle acts as an interactive assistant: gather everything the systems can answer first;
  ask employees only for confirmations and physical checks; draft once questions are
  resolved. Fulfilment truth lives in SAP (AR invoice = shipped/collected), reference in
  MyParcel always carries the SAP order number. Vendor solicitations: never reply —
  confirm spam with salesperson. Model: Sonnet default, Opus if quality demands.
- Two-stage drafting: blocking questions hold the customer draft (awaiting_input); the
  complete reply is drafted only once answers are in. Salesperson may opt to send an
  interim holding reply containing only confirmed facts. Never paper over gaps.
- Shipping costs are priced at checkout (weight/method/destination) — Axle never offers
  manual shipping quotes. Shipping history checked via RDR12/INV12.CountryS + MyParcel.
- **Phase 4 work-item model:** items keyed per conversation (sender + normalised
  subject). A new inbound email on an open item re-opens that item — investigation and
  salesperson answers preserved, draft regenerated — one consolidated action per
  conversation, never parallel jobs.

## ✅ 2.3 Prompt-injection hardening — COMPLETE (signed off 2026-06-07)

The hard gate before Phase 5 is cleared. Program delivered in `box-code/hardening/`:
- **Threat model** (`threat-model.md`, v1.3): 14 threats T1–T14, accepted risks, and the
  customer-facing-vs-staff-facing pass criteria Brad approved (flag as potential fraud,
  salesperson reviews and decides).
- **Adversarial set** (`cases.js`): 37 cases — 28 attacks across all threats (NL/EN/DE,
  base64, invisible Unicode, EchoLeak sleeper, poisoned tool results, exfiltration,
  IBAN/URL swap, third-party redirect, social engineering) + 9 benign look-alikes.
- **Harness** (`harness.js`): runs every case through the real engine (read-only tools
  live), scores 7 criteria, writes a report. **Final run: 37/37 PASS**, 0 false positives;
  T5 exfiltration drafts human-reviewed clean.
- **Engine defences** (`engine.js`): containment prompt rule; D1 invisible-Unicode
  sanitizer (strip all, flag tag/bidi); D2 interlock (flagged ⇒ awaiting_input + draft
  cleared); D3 redactor (flagged ⇒ strip off-allowlist URLs / IBANs / external emails from
  staff fields); hardened fenced-block-aware parser.

Baseline defences from before remain (untrusted-data wrapping, per-call injection flagging).

---

## Phase plan

### Phase 0 — Foundations
**Goal:** All accounts, the Windows box, and the private network ready. No code touches customer data.
**Done when:** `axle@` alias exists; dedicated Anthropic org + API key created and stored as a secret;
Windows laptop set up with a low-privilege user, never-sleep, Node and Git; Tailscale connects the box
and Brad's devices; secrets approach documented.
**Control gate:** Brad confirms every credential location and that nothing yet reads any business system.

### Phase 1 — Read-only context engine
**Goal:** Axle can read one email and assemble a full context brief from SAP, Shopify, M365, and MyParcel.
**Done when:** Four read connections live, each on its own least-privilege service account (SAP read,
Shopify read, M365 mailbox read, MyParcel tracking read); a context brief for a real email is produced
to a log; zero write capability anywhere.
**Control gate:** Brad reviews sample briefs and the service-account scopes; confirms read-only.

### Phase 2 — Triage & classification
**Goal:** Per-mailbox routing, intent classification, priority scoring, context enrichment.
**Done when:** info@ and drachten@ emails are classified with intent + priority at acceptable accuracy;
prompt-injection hardening tested (hostile email bodies cannot alter behaviour).
**Control gate:** Brad reviews classification samples and injection test results.

### Phase 3 — Draft generation (no send)
**Goal:** Draft replies in the customer's language, plus the "questions for you" list per email.
**Done when:** Drafts are produced and held for review; humans still send manually; no automated sending
exists in the code path.
**Control gate:** Brad (and a first salesperson) judge draft quality; confirm no send capability.

### Phase 4 — The team tool
**Goal:** Web interface over Tailscale: prioritised inbox, brief, questions, editable draft, approve.
**Done when:** Per-user identity works; full audit log of every view and action; first Gouda user can
run their day in it (still sending manually or via copy-out).
**Control gate:** Brad reviews the audit log and access control; confirms Tailscale-only reachability.

### Phase 5 — Controlled write-backs
**Goal:** Enable system actions one at a time behind approval + allow-list.
**Done when:** Each enabled action (e.g. send approved email, add order note, draft PO) is individually
allow-listed, approval-gated, logged, and reversible where possible.
**Control gate:** Per action — Brad enables each capability deliberately; nothing on by default.

### Phase 6 — Proactive mode & full rollout
**Goal:** "New task" proactive workflow; rollout from first Gouda user to both teams; monitoring.
Also: the **"teach Axle" capture flow** (see Knowledge maintenance process above) — salesperson
flags knowledge from the field, Brad reviews and approves, business-knowledge.md grows controlled.
**Done when:** All five salespeople use Axle daily; monitoring alerts on failures and anomalies.
**Control gate:** Brad reviews usage, error rates, and monitoring before declaring production.

### Phase 7 — Hardening & runbook
**Goal:** Backups, tested rebuild, security review, operating runbook for Brad as sole caretaker.
**Done when:** A rebuild from backup has actually been performed and verified; security review complete;
runbook covers routine ops, incidents, and key rotation.
**Control gate:** Brad signs off the runbook; project moves to ongoing iteration.

---

## Action allow-list

Every system action Axle can take must be listed here and enabled by Brad explicitly.
Nothing is permitted by default.

> **Note (2026-06-09):** rendering a SAP document to its Boyum print PDF for attachment (the compose
> "Attach SAP document" control) is a **read-only** capability — it reads SAP via `axle_read` and produces
> a local PDF staged in `draft_attachments` behind the existing human-approval gate, exactly like a
> hand-attached file. It performs **no system write and no send**, so it is governed by the draft/approval
> flow rather than a new numbered send-action. Sending the composed email itself stays gated by action #3
> (now **enabled** — Gate D signed off 2026-06-09). The "Attach SAP document" control is also available
> on **inbound** items now (not just compose), scope-checked against the email sender's resolved customer.

| # | Action | System | Status | Enabled on | Notes |
|---|--------|--------|--------|------------|-------|
| 1 | Send approved email (reply in-thread) | M365 Graph (Mail.Send) | **enabled** | 2026-06-07 | Deterministic guardrails in `send-guard.js`: recipient hard-locked to thread sender, no CC/BCC, URL domain allowlist, verbatim body (SHA-256), one send per approved draft (sends.UNIQUE), full audit incl. Graph msg id. RBAC-scoped to info@/drachten@ only; admin@ denied. Confirm-click in UI. |
| 2 | Mark inbound email as read | M365 Graph (Mail.ReadWrite) | **enabled** | 2026-06-07 | Fires on send / mark-done / archive. RBAC-scoped to info@/drachten@. No-op-safe if permission absent. |
| 3 | Send new (non-reply) / composed email | M365 Graph (Mail.Send) | **enabled** | 2026-06-09 | Compose (Phase 6). **Gate D signed off 2026-06-09** — enabled via env `AXLE_ACTION_COMPOSE_SEND=on`; live-verified end-to-end (composed NL email to admin@budget-parts.nl via card K128289 → fresh/un-threaded, single To, no CC/BCC, audit `kind=compose_new`, delivered & confirmed in the mailbox). Recipient is **deterministically resolved** by `resolve-customer.js` from SAP/Shopify, shown verbatim, human-confirmed, SHA-tied — model/data can never set it. Shared `send-guard.assembleNewOutboundSend` (flagged-item block, single To, no CC/BCC, URL allowlist, verbatim body, no quoted history); per-send human approval via the Send button. RBAC info@/drachten@ only; admin@ denied. |
| 4 | Send reply to contact-form customer (resolved/confirmed recipient) | M365 Graph (Mail.Send) | **enabled** | 2026-06-09 | Contact-form reply build (session 8); **Gate 5 signed off 2026-06-09**. Enabled via env `AXLE_ACTION_CONTACTFORM_SEND=on` in `C:\Axle\secrets\.env` (unset/≠`on` ⇒ `/send` refuses at the route). New OUTBOUND (not in-thread; the thread sender is Shopify's mailer): `send-guard.assembleContactFormSend` builds a fresh email (`originalMessageId=null`, no threading, no quoted history, fresh subject). Recipient is **deterministically parsed** from the form body (`contact-form-parser.js`), enriched via `resolve-customer.js`, shown verbatim, human-confirmed, validated by `pickRecipient`, code-held + SHA-tied — model/body can never set it. Default To = form-typed address (SAP/Shopify addresses shown/pickable). Outbound language follows the **customer's actual message language**; proposed subject aligned to the draft language. Single To, no CC/BCC, URL allowlist, verbatim body. A flagged or unconfirmed-recipient item refuses (UI + route 400). RBAC info@/drachten@ only; admin@ denied. Governed separately from #3. **Live-verified 2026-06-09** (known+cold × EN/NL + order-ref delivered; injection + unconfirmed-recipient refusals confirmed). |

> **Read capability added (2026-06-16): "Shopify — read discounts".** Axle may READ Shopify
> discount data (every discount code + automatic discount) live via the existing read-only
> `shopify_query` tool, to validate discount mentions in customer emails against current data.
> Like the SAP-doc-PDF read above, this is **read-only**, governed by the draft/approval flow —
> **no write, no send, no numbered send-action**. Strictly read: Axle may never create, edit,
> enable, disable or delete a discount, and never calls any discount-write action. Granted by
> adding the **`read_discounts`** scope to the Axle Shopify read app (version `axle-3`; store
> install updated 2026-06-16); the least-privilege read token is otherwise unchanged. Every lookup
> is logged in the item brief (tool + query + result snippet). Behaviour lives in
> `business-knowledge.md` and the info-triage skill; **no stored discount document — read live
> every time** (codes expire: e.g. `DLRR10` lapsed 2026-06-15). **Deployed & live-e2e verified
> 2026-06-16** (DLRR10 expired / ERIC10 active / bogus-code manipulation refused).

---

## Working notes

- SAP SQL Server is a **hosted machine** (116.202.33.17, Hetzner), not in the office.
  Box connects to it over the internet with `encrypt: true`; protected by the host
  firewall's IP whitelist (office IPs). *Phase 7: verify the whitelist contents.*
- The box is on **WiFi** — fine for dev; switch to ethernet for production.
- File creation on the box: prefer PowerShell here-strings (`@'…'@ | Out-File`) over Notepad —
  avoids the `.txt` extension trap.

## Open decisions

1. **Windows box hardware** — start on the spare Windows 11 Pro laptop, or buy a mini PC first?
   (Default: start on the laptop, migrate later.)
2. **MyParcel connector scope** — tracking-only read at Phase 1; shipment creation is a Phase 5
   allow-list candidate.
3. ~~First pilot user~~ — decided 2026-06-07: Brad pilots first, then picks Jack or Brendan.

---

## Credential register

Where every secret lives. (Populated as created — never the secrets themselves, only locations.)

| Credential | Where it lives | Created | Notes |
|------------|----------------|---------|-------|
| Anthropic API key `axle-api-key` | Brad's password manager; runtime copy in `C:\Axle\secrets\.env` on the box | 2026-06-05 | `.env` ACL: axle / Administrators / SYSTEM only |
| Windows local admin `bradmin` | Brad's password manager | 2026-06-05 | Box admin account, installs only |
| Windows service user `axle` | Brad's password manager — "Axle — Windows user 'axle' on AXLE-BOX" | 2026-06-05 | Low-privilege; runs the Axle service |
| SQL login `axle_read` | Brad's password manager — "Axle — SQL login axle_read" | 2026-06-06 | db_datareader on BP_LIVE only; read verified, write denied |
| Shopify Client ID + secret (`shpss_`) | Brad's password manager — "Axle — Shopify read-only token" | 2026-06-06 | Read-only scopes; exchanged for 24h tokens at runtime |
| M365 app: tenant ID, client ID, SP object ID, client secret | Brad's password manager — "Axle — M365 app (Axle Mailbox Reader)" | 2026-06-06 | Secret expires 2028-06. Exchange-RBAC roles, all scoped to "Axle Mailboxes" (info@ + drachten@): Mail.Read, **Mail.Send** (2026-06-07), **Mail.ReadWrite** (2026-06-07). SP ObjectId fb851885-1f8a-431a-b839-0307a763483b. admin@ denied on all. |
| MyParcel API key | Brad's password manager — "Axle — MyParcel API key" | 2026-06-06 | Not scopeable — full-privilege key; Phase 1 code does tracking reads only |
| Entra user `jack@budget-parts.nl` | Brad's password manager — "Axle — Entra user jack@" | 2026-06-08 | Unlicensed SSO identity for Tailscale + Axle (role sales). Not a mailbox login; info@ stays shared. Pattern for future salespeople. |
