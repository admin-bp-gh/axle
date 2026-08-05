// check-env.js — verifies all required secrets are present. Never prints values.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env" });

const required = [
  "ANTHROPIC_API_KEY",
  "SQL_SERVER", "SQL_DATABASE", "SQL_USER", "SQL_PASSWORD",
  "SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET",
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
process.exit(ok ? 0 : 1);
