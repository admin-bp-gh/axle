// Sandbox harness for the drachten@ unread-seed change. Mocks global.fetch so getMessages
// runs with no network: asserts the unread mode builds `$filter=isRead eq false` with NO
// $orderby (Graph rejects orderby-on-receivedDateTime + filter-on-isRead), that normal mode
// is byte-unchanged, and that results are still sorted newest-first client-side.
// Run: node harness-unread.js   (from C:\Axle\app or box-code)
process.env.M365_TENANT_ID = "t"; process.env.M365_CLIENT_ID = "c"; process.env.M365_CLIENT_SECRET = "s";

const assert = require("assert");
const C = require("./connectors.js");

let captured = [];
global.fetch = async (url) => {
  captured.push(url);
  if (url.includes("login.microsoftonline.com")) return { json: async () => ({ access_token: "tok", expires_in: 3600 }) };
  // messages endpoint: two msgs out of order to prove client-side sort
  return { json: async () => ({ value: [
    { id: "a", conversationId: "A", subject: "older", from: { emailAddress: { address: "x@y.z", name: "X" } }, receivedDateTime: "2026-06-01T10:00:00Z", body: { content: "" }, categories: [], hasAttachments: false },
    { id: "b", conversationId: "B", subject: "newer", from: { emailAddress: { address: "p@q.r", name: "P" } }, receivedDateTime: "2026-06-10T10:00:00Z", body: { content: "" }, categories: [], hasAttachments: false },
  ] }) };
};

(async () => {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); } };

  // 1. UNREAD mode (folders:["inbox"] -> no folder-resolution fetch)
  captured = [];
  const unread = await C.getMessages("drachten@budget-parts.nl", { unreadOnly: true, folders: ["inbox"] });
  const uMsgUrl = captured.find((u) => u.includes("/messages"));
  ok(uMsgUrl.includes("$filter=isRead eq false") || uMsgUrl.includes("$filter=isRead%20eq%20false"), "unread: filter is isRead eq false -> " + uMsgUrl);
  ok(!uMsgUrl.includes("$orderby"), "unread: NO $orderby (Graph rejects mixed filter/orderby)");
  ok(!uMsgUrl.includes("receivedDateTime ge"), "unread: no date filter (ignores watermark)");
  ok(unread.length === 2 && unread[0].subject === "newer", "unread: results sorted newest-first client-side");

  // 2. NORMAL watermark mode unchanged
  captured = [];
  await C.getMessages("info@budget-parts.nl", { sinceIso: "2026-06-09T00:00:00Z", folders: ["inbox"] });
  const nMsgUrl = captured.find((u) => u.includes("/messages"));
  ok(nMsgUrl.includes("$orderby=receivedDateTime desc"), "normal: keeps $orderby=receivedDateTime desc");
  ok(nMsgUrl.includes("filter=receivedDateTime ge 2026-06-09T00:00:00Z") || nMsgUrl.includes("receivedDateTime%20ge"), "normal: keeps watermark date filter");
  ok(!nMsgUrl.includes("isRead"), "normal: no isRead filter");

  // 3. NORMAL with no sinceIso (fresh DB) -> no filter at all, orderby kept
  captured = [];
  await C.getMessages("info@budget-parts.nl", { folders: ["inbox"] });
  const fMsgUrl = captured.find((u) => u.includes("/messages"));
  ok(!fMsgUrl.includes("$filter="), "fresh: no $filter when no sinceIso");
  ok(fMsgUrl.includes("$orderby=receivedDateTime desc"), "fresh: orderby kept");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
