// check-env.js — verifies all required secrets are present. Never prints values.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env" });

const required = [
  "ANTHROPIC_API_KEY",
  "SQL_SERVER", "SQL_DATABASE", "SQL_USER", "SQL_PASSWORD",
  "SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_STOREFRONT_TOKEN",
  "M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET",
  "MAILBOX_INFO", "MAILBOX_DRACHTEN",
  "MYPARCEL_API_KEY",
];

let ok = true;
for (const name of required) {
  const set = Boolean(process.env[name]);
  console.log(`${set ? "OK     " : "MISSING"} ${name}`);
  if (!ok) ok = ok;
  if (!set) ok = false;
}
// Drafting through the Workbench shared agent (AXLE_AGENT=step) needs its shared secret; without it
// Axle falls back to drafting directly through the Anthropic API.
if (process.env.AXLE_AGENT === "step" && !process.env.AGENT_TOKEN) {
  console.log("WARN    AGENT_TOKEN (AXLE_AGENT=step is set; drafts fall back to the direct Anthropic API until it is)");
}
process.exit(ok ? 0 : 1);
