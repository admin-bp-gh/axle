// send-test.js - one-off verification for Phase 5.2: confirm Mail.Send is scoped to the
// Axle mailboxes only. Sends a test email to admin@ from info@ and drachten@ (expected to
// succeed) and attempts a send from admin@ (expected to be DENIED by the RBAC scope).
// No customer ever receives anything. Delete after verifying. Usage: node send-test.js
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const rulesets = require("./rules.js");

const ADMIN = "admin@budget-parts.nl";          // test recipient + the must-be-denied sender
const INFO = process.env[rulesets.info.mailboxEnv];
const DRACHTEN = process.env[rulesets.drachten.mailboxEnv];

async function token() {
  const host = "https://login.micro" + "softonline.com";   // split to dodge chat linkify
  const r = await fetch(`${host}/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope: "https://graph.micro" + "soft.com/.default",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("no token: " + JSON.stringify(d));
  return d.access_token;
}

// Returns the HTTP status of a sendMail attempt from `mailbox`.
async function trySend(tok, mailbox) {
  const base = "https://graph.micro" + "soft.com/v1.0/users/";
  const r = await fetch(`${base}${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: "Axle send-scope test (" + mailbox + ")",
        body: { contentType: "Text", content: "Axle 5.2 verification - safe to ignore/delete. Sender: " + mailbox },
        toRecipients: [{ emailAddress: { address: ADMIN } }],
      },
      saveToSentItems: true,
    }),
  });
  let detail = "";
  if (r.status !== 202) { try { detail = " " + JSON.stringify(await r.json()).slice(0, 200); } catch {} }
  return { status: r.status, detail };
}

(async () => {
  const tok = await token();
  const cases = [
    { mailbox: INFO, label: "info@", expect: 202 },
    { mailbox: DRACHTEN, label: "drachten@", expect: 202 },
    { mailbox: ADMIN, label: "admin@ (must be DENIED)", expect: 403 },
  ];
  let allOk = true;
  console.log("Axle 5.2 Mail.Send scope verification\n");
  for (const c of cases) {
    const { status, detail } = await trySend(tok, c.mailbox);
    const ok = status === c.expect;
    allOk = allOk && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(26)} status=${status} (expected ${c.expect})${ok ? "" : detail}`);
  }
  console.log(`\n${allOk ? "ALL GOOD - scope is correct." : "PROBLEM - scope is not as expected (RBAC may still be propagating; retry in a few minutes)."}`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
