Step-1 verification harness (UI rework, 2026-06-10). Run in a Cowork sandbox:
  cd harness/step1 && node run.js
(env AXLE_MIRROR / AXLE_PRE override the box-code mirror / monolith-snapshot paths)

Reuses step0/{fixtures,stubs,child,battery}.js verbatim. Two parts:
 1) Behaviour equivalence vs the pre-Step-0 monolith across the 3 env phases:
    transport fields + JSON/binary bodies + final DB state must be byte-identical.
    HTML bodies are intentionally different in Step 1 and are excluded.
 2) 33 structure assertions on the post tree (F5-F9, F11, F13 page contract).

NB: step0/run.js byte-compares FULL HTML, so it now fails against the Step-1 tree
by design - its gate (pre vs post refactor) was passed and signed off 2026-06-10
before Step 1 changed any markup. Also 2026-06-10: fixed a latent column-shift in
step0/fixtures.js item 5 (missing draft_edit null) so it is a real compose item;
invisible to pre-vs-post diffing, caught by the Step-1 structure assertions.
