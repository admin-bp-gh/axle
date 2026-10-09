"use strict";
// return-label.js - the "+ Return label" action (2026-10-09): a prepaid PostNL return label from
// MyParcel, attached to the reply as a PDF. CHARGEABLE once the customer uses it, so the route
// behind this asks the salesperson first and the whole action sits behind AXLE_ACTION_RETURN_LABEL
// (off / dry / on). Pure planning here; the network calls are injectable for the tests.
//
// Two shapes, decided in code:
//   related    - the original shipment is found in OUR MyParcel account by SAP order number (the
//                label reference always carries it). MyParcel builds the return against that parent,
//                on the branch that shipped it, so the customer's address and country come from the
//                shipment itself and the parcel comes back to that branch. Works for every country
//                the original carrier serves.
//   unrelated  - no parent found: a bare PostNL return label on the Gouda account (the return
//                address is the Gouda shop's; the customer writes nothing). PostNL only carries
//                these within the Netherlands, so this shape is refused for any other country.
// Everything else (the parcel being outside the country, the customer never having had an order)
// comes back as a refusal the salesperson reads, never a label that will not work.
const C = require("./connectors.js");

const RELATED_CT = "application/vnd.return_shipment+json;charset=utf-8;version=1.1";
const UNRELATED_CT = "application/vnd.unrelated_return_shipment+json;charset=utf-8;version=1.1";
const POSTNL = 1;
const API = "https://api.myparcel.nl";

function mode() {
  const v = String(process.env.AXLE_ACTION_RETURN_LABEL || "").trim().toLowerCase();
  return v === "on" ? "on" : v === "dry" ? "dry" : "off";
}

// Was this shipment one the carrier actually took (not a concept, not a return itself)?
const usable = (s) => s && s.id && !/^(1|17|13|30|31) /.test(String(s.status || "")) && !/return/i.test(String(s.status || ""));

// Decide the shape. orderNums = the SAP order numbers the thread references (trusted: from the
// resolved SAP documents, never from the email text). country = ISO-2 from the customer card.
async function plan({ orderNums = [], country = "", name = "", email = "" }, deps = {}) {
  const search = deps.myparcelSearch || C.myparcelSearch;
  const nums = [...new Set(orderNums.map((n) => String(n || "").trim()).filter(Boolean))].slice(0, 5);
  for (const n of nums) {
    let hits = [];
    try { hits = await search(n, 5); } catch (e) { hits = []; }
    const parent = hits.find((s) => usable(s) && String(s.reference || "").includes(n));
    if (parent) {
      return {
        kind: "related", shop: parent.shop, parentId: parent.id, order: n, carrier: parent.carrier || "PostNL",
        country: (parent.recipient && parent.recipient.country) || country || "",
        body: { data: { return_shipments: [{ parent: parent.id, carrier: POSTNL, name: String(name || "").slice(0, 60), email: String(email || "").slice(0, 120) || undefined }] } },
        contentType: RELATED_CT,
      };
    }
  }
  const cc = String(country || "").trim().toUpperCase();
  if (cc !== "NL") {
    return { kind: "refused", reason: cc ? "no_shipment_abroad" : "no_country", country: cc, orders: nums };
  }
  return {
    kind: "unrelated", shop: "gouda", country: cc,
    body: { data: { return_shipments: [{ carrier: POSTNL, name: String(name || "").slice(0, 60), email: String(email || "").slice(0, 120) || undefined,
      options: { package_type: 1, signature: 0, only_recipient: 0, return: 0, label_description: "Retour RoverParts.eu" } }] } },
    contentType: UNRELATED_CT,
  };
}

// Create the return shipment on the right branch and fetch its label. Throws on any failure so
// the caller attaches nothing and says why.
async function create(p, deps = {}) {
  const accounts = (deps.mpAccounts || C.mpAccounts)();
  const acct = accounts.find((a) => a.shop === p.shop) || (p.shop === "gouda" ? accounts[0] : null);
  if (!acct) throw new Error(`no MyParcel key for branch ${p.shop}`);
  const headers = (deps.mpHeaders || C.mpHeaders)(acct.key);
  const fetchFn = deps.fetch || fetch;
  const r = await fetchFn(`${API}/shipments`, {
    method: "POST", headers: { ...headers, "Content-Type": p.contentType }, body: JSON.stringify(p.body),
  });
  const text = await r.text();
  if (r.status !== 200 && r.status !== 201) throw new Error(`MyParcel return shipment HTTP ${r.status}: ${text.slice(0, 200)}`);
  let id = null;
  try { id = JSON.parse(text).data.ids[0].id; } catch (e) { id = null; }
  if (!id) throw new Error(`MyParcel return: no shipment id in response: ${text.slice(0, 200)}`);
  // The label: PostNL assigns it at creation; a moment later for other carriers.
  let pdf = null, last = "";
  for (let i = 0; i < 6 && !pdf; i++) {
    const lr = await fetchFn(`${API}/shipment_labels/${id}?format=A6`, { headers: { ...headers, Accept: "application/pdf" } });
    if (lr.status === 200) pdf = Buffer.from(await lr.arrayBuffer());
    else { last = `HTTP ${lr.status}`; await new Promise((res) => setTimeout(res, deps.delayMs == null ? 700 : deps.delayMs)); }
  }
  if (!pdf) throw new Error(`MyParcel return label ${id} not ready (${last})`);
  let barcode = null;
  try {
    const sr = await fetchFn(`${API}/shipments/${id}`, { headers });
    if (sr.status === 200) barcode = (JSON.parse(await sr.text()).data.shipments[0] || {}).barcode || null;
  } catch (e) { barcode = null; }
  return { id: Number(id), barcode, pdf, shop: acct.shop };
}

module.exports = { mode, plan, create, usable, RELATED_CT, UNRELATED_CT };
