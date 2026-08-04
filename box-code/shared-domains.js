// shared-domains.js — OBSOLETE, safe to delete.
//
// Written 2026-07-27 as a guardrail: it refused a whole-domain sender block on consumer webmail,
// ISP mail, or a service the business depends on. Within the hour Brad chose the simpler fix —
// remove whole-domain blocking altogether, so only a single address can ever be blocked. With the
// option gone there is nothing left for this to guard, and dead code that looks load-bearing is
// worse than no code.
//
// Nothing imports this file. Delete it (and C:\Axle\app\shared-domains.js on the box) whenever
// convenient. The reasoning is preserved in routes/admin.js's POST /item/:id/block and in the
// roadmap entry for 2026-07-27.
module.exports = {};
