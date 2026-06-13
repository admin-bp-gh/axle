UI rework Step-2 harness (2026-06-10)
=====================================
Run:   cd harness/step2 && AXLE_MIRROR=<path-to-box-code> node run.js
(Defaults: AXLE_MIRROR=../../box-code, AXLE_PRE=../step0/pre-app. Node 22+ for node:sqlite.)

Part 1 - behaviour equivalence vs the pre-Step-0 monolith snapshot, reusing the
step0 fixtures/stubs/battery across 3 env phases (actions on / off / CSRF).
Transport fields + JSON/binary bodies + final DB dumps must be byte-identical;
HTML bodies are expected to differ (that is the point of Step 2).
Note: translate.js is stubbed without its cache table, so the F2 re-ordering of
summary-translation calls cannot create a false dump diff (and on the box the
cache is sha-keyed, so insert order never matters).

Part 2 - 52 structure assertions on the post tree (fresh fixtures, actions on):
three-pane shell, lazy /queue on item deep links, card queue + needs-me-next
order (F1/F2), Live indicator + Sync kept (F3), collapsed toolbar with counted
tabs (F4), HX fragment swaps + busy self-poller, pane-shaped HX 404, htmx
vendored + identity-gated, Step-1 centre-pane contract spot-checks, EN/NL
STRINGS parity incl. the new action-state vocabulary.

Last run 2026-06-10: PHASES A/B/C PASS (104+9+7 responses), STRUCTURE 52/52 PASS.
