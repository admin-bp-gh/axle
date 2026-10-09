// return-label.test.js - "+ Return label" (2026-10-09): which shape a label takes (related to the
// original shipment, unrelated PostNL within NL, or refused), and the MyParcel calls behind it,
// with the network faked. Run: node return-label.test.js
const assert = require("assert");
const RL = require("./return-label.js");

let pass = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  ok  " + name); });

const shipped = { id: 901, shop: "drachten", status: "7 (delivered - at recipient)", carrier: "DHL For You", reference: "123456", recipient: { country: "DE" } };
const concept = { id: 902, shop: "gouda", status: "1 (pending - concept)", carrier: "PostNL", reference: "123457" };

(async () => {
  console.log("return-label");

  await test("mode reads the gate", () => {
    const was = process.env.AXLE_ACTION_RETURN_LABEL;
    delete process.env.AXLE_ACTION_RETURN_LABEL; assert.strictEqual(RL.mode(), "off");
    process.env.AXLE_ACTION_RETURN_LABEL = "DRY"; assert.strictEqual(RL.mode(), "dry");
    process.env.AXLE_ACTION_RETURN_LABEL = "on"; assert.strictEqual(RL.mode(), "on");
    if (was == null) delete process.env.AXLE_ACTION_RETURN_LABEL; else process.env.AXLE_ACTION_RETURN_LABEL = was;
  });

  await test("usable: a carried shipment yes, a concept or a return leg no", () => {
    assert.ok(RL.usable(shipped));
    assert.ok(!RL.usable(concept));
    assert.ok(!RL.usable({ id: 1, status: "10 (delivered - return ready for pickup)" }));
    assert.ok(!RL.usable(null));
  });

  await test("related: the original shipment found by SAP order number, on its own branch, any country", async () => {
    const calls = [];
    const p = await RL.plan({ orderNums: ["123457", "123456"], country: "DE", name: "Hans Müller", email: "h@x.de" },
      { myparcelSearch: async (term) => { calls.push(term); return term === "123456" ? [shipped] : [concept]; } });
    assert.deepStrictEqual(calls, ["123457", "123456"], "the concept on the first order is skipped, the second order is tried");
    assert.strictEqual(p.kind, "related");
    assert.strictEqual(p.shop, "drachten");
    assert.strictEqual(p.parentId, 901);
    assert.strictEqual(p.country, "DE");
    assert.strictEqual(p.contentType, RL.RELATED_CT);
    const rs = p.body.data.return_shipments[0];
    assert.strictEqual(rs.parent, 901);
    assert.strictEqual(rs.carrier, 1);
    assert.strictEqual(rs.name, "Hans Müller");
  });

  await test("unrelated: no shipment and a Dutch customer gets a bare PostNL label on Gouda", async () => {
    const p = await RL.plan({ orderNums: [], country: "nl", name: "Jan", email: "" }, { myparcelSearch: async () => { throw new Error("never called"); } });
    assert.strictEqual(p.kind, "unrelated");
    assert.strictEqual(p.shop, "gouda");
    assert.strictEqual(p.contentType, RL.UNRELATED_CT);
    const rs = p.body.data.return_shipments[0];
    assert.strictEqual(rs.parent, undefined);
    assert.strictEqual(rs.email, undefined, "an empty address is left out, not sent as ''");
    assert.strictEqual(rs.options.package_type, 1);
  });

  await test("refused: no shipment found and the customer is abroad, or has no country", async () => {
    const none = { myparcelSearch: async () => [] };
    let p = await RL.plan({ orderNums: ["1"], country: "BE" }, none);
    assert.strictEqual(p.kind, "refused"); assert.strictEqual(p.reason, "no_shipment_abroad"); assert.strictEqual(p.country, "BE");
    p = await RL.plan({ orderNums: [], country: "" }, none);
    assert.strictEqual(p.reason, "no_country");
    p = await RL.plan({ orderNums: ["1"], country: "NL" }, { myparcelSearch: async () => { throw new Error("down"); } });
    assert.strictEqual(p.kind, "unrelated", "a MyParcel search error falls through to the NL label");
  });

  await test("create posts on the right branch, fetches the A6 label and the barcode", async () => {
    const seen = [];
    const fetchFn = async (url, init = {}) => {
      seen.push({ url, method: init.method || "GET", ct: init.headers["Content-Type"], auth: init.headers.Authorization });
      if (url.endsWith("/shipments") && init.method === "POST") return { status: 200, text: async () => JSON.stringify({ data: { ids: [{ id: 555 }] } }) };
      if (url.includes("/shipment_labels/555")) return seen.filter((s) => s.url.includes("/shipment_labels/")).length < 2
        ? { status: 404, text: async () => "not yet" }
        : { status: 200, arrayBuffer: async () => Buffer.from("%PDF-1.4 label") };
      if (url.endsWith("/shipments/555")) return { status: 200, text: async () => JSON.stringify({ data: { shipments: [{ barcode: "3SABC1" }] } }) };
      throw new Error("unexpected " + url);
    };
    const deps = { fetch: fetchFn, delayMs: 0,
      mpAccounts: () => [{ shop: "gouda", key: "G" }, { shop: "drachten", key: "D" }],
      mpHeaders: (key) => ({ Authorization: "basic " + key }) };
    const p = await RL.plan({ orderNums: ["123456"], country: "DE", name: "H" }, { myparcelSearch: async () => [shipped] });
    const made = await RL.create(p, deps);
    assert.strictEqual(made.id, 555);
    assert.strictEqual(made.barcode, "3SABC1");
    assert.strictEqual(made.shop, "drachten");
    assert.strictEqual(made.pdf.toString().slice(0, 4), "%PDF");
    assert.strictEqual(seen[0].auth, "basic D", "the branch that shipped the parcel");
    assert.strictEqual(seen[0].ct, RL.RELATED_CT);
    assert.strictEqual(seen.filter((s) => s.url.includes("/shipment_labels/")).length, 2, "the label is retried until it is ready");
  });

  await test("create throws on a refused shipment, and attaches nothing", async () => {
    const deps = { fetch: async () => ({ status: 422, text: async () => '{"errors":[{"message":"invalid"}]}' }), delayMs: 0,
      mpAccounts: () => [{ shop: "gouda", key: "G" }], mpHeaders: () => ({}) };
    const p = await RL.plan({ orderNums: [], country: "NL", name: "J" }, {});
    await assert.rejects(() => RL.create(p, deps), /HTTP 422/);
    await assert.rejects(() => RL.create({ ...p, shop: "drachten" }, deps), /no MyParcel key for branch drachten/);
  });

  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
