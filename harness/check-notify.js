// Sandbox check of sprocket-notify.js — the feature-request notification email builder. Requires
// the real module (new file, so the mount sees it fresh); send.js is required transitively but no
// network happens (NOTIFY is off here, and buildNotificationEmail is pure).
process.env.AXLE_SPROCKET_NOTIFY = "";          // ensure disabled for the skip test
const N = require("../box-code/sprocket-notify.js");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log("  FAIL:", n); } };

const rec = {
  id: "FR-0001", goal: "Send an SMS <script>alert(1)</script> when orders ship",
  requester: 'Jack "the lad"', frequency: "weekly", workaround_today: "none today",
  impact: "would save real time", example: "", original_question: "I wish Axle could text people",
  votes: 3,
};

// ---- new-request email ----
(() => {
  const m = N.buildNotificationEmail("new", rec, { baseUrl: "https://axle-box.tail58a804.ts.net" });
  ok(/new feature request/i.test(m.subject), "new: subject says new feature request");
  ok(m.subject.indexOf("\n") === -1 && m.subject.length <= 120, "new: subject single-line + capped");
  ok(m.html.indexOf("FR-0001") !== -1, "new: body has the id");
  ok(m.html.indexOf("/sprocket/requests") !== -1, "new: body links to the requests view");
  ok(m.html.indexOf("<script>") === -1, "new: raw <script> never appears (escaped)");
  ok(m.html.indexOf("&lt;script&gt;") !== -1, "new: the script text is HTML-escaped");
  ok(m.html.indexOf('Jack &quot;the lad&quot;') !== -1, "new: quotes in a field are escaped");
})();

// ---- vote email ----
(() => {
  const m = N.buildNotificationEmail("vote", rec, {});
  ok(/gaining traction/i.test(m.subject), "vote: subject says gaining traction");
  ok(/Votes/.test(m.html) && /3/.test(m.html), "vote: body shows the vote count");
})();

// ---- subject newline strip + length cap ----
(() => {
  const m = N.buildNotificationEmail("new", { id: "FR-9", goal: "line one\nline two " + "x".repeat(300) }, {});
  ok(m.subject.indexOf("\n") === -1, "subject strips newlines");
  ok(m.subject.length <= 120, "subject capped at 120");
})();

// ---- disabled => sendNotification is a no-op (no network) ----
(async () => {
  const r = await N.sendNotification("new", rec, { fromMailbox: "info@budget-parts.nl" });
  ok(r && r.skipped === true, "sendNotification is a no-op when AXLE_SPROCKET_NOTIFY is off");
  ok(N.NOTIFY_ON() === false, "NOTIFY_ON false when env unset");
  ok(N.RECIPIENT() === "admin@budget-parts.nl", "default recipient is admin@budget-parts.nl");

  console.log(`check-notify: ${pass}/${pass + fail} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
