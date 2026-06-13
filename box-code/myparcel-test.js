// myparcel-test.js - one-off LIVE verification of the enriched MyParcel connector.
// READ-ONLY (search + tracktrace GETs). Run ON THE BOX, from anywhere:
//   node myparcel-test.js S12345        <- a recent SAP order number with a shipment
// Loads connectors.js (and via it the .env key) from C:\Axle\app by absolute path, so the
// script works straight from Downloads without being placed. Delete after verifying.
"use strict";
// connectors.js does not load the .env itself (server.js normally does) - load it here.
require("C:\\Axle\\app\\node_modules\\dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const C = require("C:\\Axle\\app\\connectors.js");

// NOTE: process.exitCode (not process.exit) - an immediate exit right after fetch trips a
// libuv assert on Windows. The process ends by itself once undici's keep-alive sockets close.
(async () => {
  const term = process.argv[2];
  if (!term) { console.log("usage: node myparcel-test.js <SAP order number, e.g. 226446>  OR  --recent"); process.exitCode = 1; return; }

  // --recent: list the newest shipments WITHOUT a search filter, to see what the live
  // reference (label_description) values actually look like.
  if (term === "--recent") {
    const auth = Buffer.from(process.env.MYPARCEL_API_KEY).toString("base64");
    const r = await fetch("https://api.myparcel.nl/shipments?size=10", {
      headers: { Authorization: `basic ${auth}`, Accept: "application/json", "User-Agent": "CustomApiCall/2" },
    });
    if (!r.ok) { console.log("HTTP " + r.status); process.exitCode = 1; return; }
    const data = await r.json();
    (data.data.shipments || []).forEach((s) => console.log(
      `id=${s.id} status=${s.status} barcode=${s.barcode || "-"} ref="${(s.options && s.options.label_description) || s.reference_identifier || ""}" to=${(s.recipient || {}).person || "?"} ${(s.recipient || {}).cc || ""}`));
    return;
  }

  console.log(`-- myparcelSearch("${term}") --`);
  const ships = await C.myparcelSearch(term);
  if (!ships.length) { console.log("no shipments found - try another recent order number"); process.exitCode = 1; return; }
  console.log(JSON.stringify(ships, null, 2));

  console.log(`\n-- myparcelTrack(${ships[0].id}) --`);
  const tracks = await C.myparcelTrack(ships[0].id);
  console.log(JSON.stringify(tracks, null, 2));

  const t = tracks[0] || {};
  console.log(`\nSummary: ${ships[0].reference || "?"} | ${ships[0].carrier} | ${t.status || ships[0].status}`
    + (t.delivery_moment ? ` | ${t.delivery_moment_type} delivery ${t.delivery_moment}` : "")
    + (t.tracking_url ? `\nTracking link: ${t.tracking_url}` : ""));
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
