// test-connections.js — read-only smoke test of all four connections.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env" });
const sql = require("mssql");

async function testSql() {
  const pool = await sql.connect({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  });
  const r = await pool.request().query("SELECT TOP 1 ItemCode FROM OITM");
  await pool.close();
  return `SAP SQL OK (sample ItemCode: ${r.recordset[0].ItemCode})`;
}

async function testGraph() {
  const t = await fetch(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const { access_token } = await t.json();
  if (!access_token) throw new Error("no Graph token returned");
  const m = await fetch(`https://graph.microsoft.com/v1.0/users/${process.env.MAILBOX_INFO}/messages?$top=1&$select=subject`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await m.json();
  if (data.error) throw new Error(data.error.message);
  return `M365 Graph OK (newest info@ subject: "${data.value[0].subject}")`;
}

async function testShopify() {
  const t = await fetch(`https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const { access_token } = await t.json();
  if (!access_token) throw new Error("no Shopify token returned");
  const q = await fetch(`https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token },
    body: JSON.stringify({ query: "{ shop { name } }" }),
  });
  const data = await q.json();
  if (!data.data) throw new Error(JSON.stringify(data.errors));
  return `Shopify OK (shop: ${data.data.shop.name})`;
}

async function testMyParcel() {
  const auth = Buffer.from(process.env.MYPARCEL_API_KEY).toString("base64");
  const res = await fetch("https://api.myparcel.nl/shipments?size=1", {
    headers: { Authorization: `basic ${auth}`, Accept: "application/json", "User-Agent": "CustomApiCall/2" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return `MyParcel OK (latest shipment id: ${data.data.shipments[0].id})`;
}

(async () => {
  const tests = [["SAP SQL", testSql], ["M365 Graph", testGraph], ["Shopify", testShopify], ["MyParcel", testMyParcel]];
  for (const [name, fn] of tests) {
    try { console.log("PASS  " + (await fn())); }
    catch (e) { console.log(`FAIL  ${name}: ${e.message}`); }
  }
  process.exit(0);
})();
