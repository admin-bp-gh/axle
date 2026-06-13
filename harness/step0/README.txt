Step-0 equivalence harness (UI rework, 2026-06-10). Run in a Cowork sandbox:
  AXLE_MIRROR=<mounted box-code path> AXLE_PRE=<this dir>/pre-app node run.js
pre-app/ = the pre-refactor monolith snapshot (also in box git history pre-Step-0).
Stubs replace the network/model modules; express, db.js, rules.js, scenarios.js,
send-guard.js and the views/routes tree run REAL. PASS = every response (120 across
3 env phases) and the final DB state byte-identical between the two trees.
