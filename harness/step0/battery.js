// battery.js - the ordered request battery + DB dump for the Step-0 equivalence harness.
// Same sequence is fired at the pre and post servers; every response is recorded
// (status / location / content-type / set-cookie / normalized body) for byte-diffing.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const BRAD = "admin@budget-parts.nl";
const JACK = "jack@budget-parts.nl";

const norm = (s) => String(s)
  .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?\b/g, "«TS»")
  .replace(/\b(Today|Vandaag)\s\d{1,2}:\d{2}(am|pm)?\b/g, "$1 «T»")
  // synthetic compose conversation keys are random by design; keep the SHAPE, mask the value
  .replace(/compose:[a-z0-9]{6,12}-[0-9a-f]{8}/g, "compose:«KEY»");

function dbGet(dbPath, sql, ...p) {
  let d;
  try { d = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { d = new DatabaseSync(dbPath); }
  try { return d.prepare(sql).get(...p); } finally { d.close(); }
}
async function settle(dbPath, sql, pred, ...p) {
  for (let i = 0; i < 400; i++) {
    const row = dbGet(dbPath, sql, ...p);
    if (pred(row)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("settle timeout: " + sql);
}

async function req(base, rec, step) {
  const headers = { "Tailscale-User-Login": step.user === null ? undefined : (step.user || BRAD) };
  if (step.user === null) delete headers["Tailscale-User-Login"];
  if (step.lang) headers.Cookie = "axle_lang=" + step.lang;
  if (step.referer) headers.Referer = step.referer;
  if (step.origin) headers.Origin = step.origin;
  const init = { method: step.method || "GET", headers, redirect: "manual" };
  if (step.form) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(step.form)) {
      if (Array.isArray(v)) v.forEach((x) => usp.append(k, x)); else usp.append(k, v);
    }
    init.body = usp.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(base + step.path, init);
  const ctype = String(r.headers.get("content-type") || "");
  const buf = Buffer.from(await r.arrayBuffer());
  const isText = /text|json|javascript/.test(ctype);
  rec.push({
    name: step.name, method: init.method, path: step.path,
    status: r.status,
    location: r.headers.get("location") || "",
    ctype,
    setCookie: r.headers.get("set-cookie") || "",
    disp: r.headers.get("content-disposition") || "",
    bodySha: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16),
    body: isText ? norm(buf.toString("utf8")) : "<binary " + buf.length + "b>",
  });
}

const BIGB64 = "A".repeat(4_194_308); // decodes to just over the 3 MB cap

function fullBattery(gate) {
  const touch = (n) => ({ name: "touch " + n, gate: n });
  return [
    { name: "inbox brad", path: "/" },
    { name: "inbox jack", path: "/", user: JACK },
    { name: "inbox brad nl", path: "/", lang: "nl" },
    { name: "inbox info open all", path: "/?mailbox=info&show=open&scope=all" },
    { name: "inbox drachten all", path: "/?mailbox=drachten&show=all" },
    { name: "inbox done", path: "/?show=done" },
    { name: "inbox archived", path: "/?show=archived" },
    { name: "inbox synced banner", path: "/?synced=1" },
    { name: "item1", path: "/item/1" },
    { name: "item1 nl", path: "/item/1", lang: "nl" },
    { name: "item1 jack", path: "/item/1", user: JACK },
    { name: "item2", path: "/item/2" },
    { name: "item3 flagged", path: "/item/3" },
    { name: "item4 cf", path: "/item/4" },
    { name: "item4 cf nl", path: "/item/4", lang: "nl" },
    { name: "item5 compose", path: "/item/5" },
    { name: "item6 done", path: "/item/6" },
    { name: "item7 archived", path: "/item/7" },
    { name: "item8 new", path: "/item/8" },
    { name: "item9 drachten", path: "/item/9" },
    { name: "item404", path: "/item/999" },
    { name: "att ok", path: "/item/1/attachment/0" },
    { name: "att 404", path: "/item/1/attachment/9" },
    { name: "block page item2", path: "/item/2/block" },
    { name: "block page item1 sapwarn", path: "/item/1/block" },
    { name: "block page item9", path: "/item/9/block" },
    { name: "block page compose redirect", path: "/item/5/block" },
    { name: "blocks", path: "/blocks" },
    { name: "audit", path: "/audit" },
    { name: "audit q", path: "/audit?q=felicitas" },
    { name: "audit sqli", path: "/audit?q=%27%20OR%201%3D1%20--" },
    { name: "audit wildcard", path: "/audit?q=100%25_test" },
    { name: "audit action", path: "/audit?action=email_sent" },
    { name: "audit item", path: "/audit?item=6" },
    { name: "audit combined", path: "/audit?q=kind&action=email_sent&item=6" },
    { name: "audit jack 403", path: "/audit", user: JACK },
    { name: "setlang nl", path: "/setlang?lang=nl", referer: "https://axle-box.tail58a804.ts.net/item/1" },
    { name: "setlang bad", path: "/setlang?lang=zz" },
    { name: "no header 403", path: "/", user: null },
    { name: "unregistered 403", path: "/", user: "stranger@nowhere.example" },
    // --- mutations ---
    { name: "work save item2", method: "POST", path: "/item/2/work", form: { feedback: "Nieuwe feedback", reply: "Aangepast antwoord", answer_21: "Ja, retour is binnen", action: "save" } },
    { name: "item2 after save", path: "/item/2" },
    { name: "work redraft item2", method: "POST", path: "/item/2/work", form: { feedback: "Nieuwe feedback", reply: "Aangepast antwoord", action: "redraft" } },
    { name: "item2 busy render", path: "/item/2" },
    touch("go-MSG2"),
    { name: "settle item2", settle: ["SELECT status AS s FROM work_items WHERE id = 2", (r) => r && r.s !== "investigating"] },
    { name: "item2 after redraft", path: "/item/2" },
    { name: "language item1 fr", method: "POST", path: "/item/1/language", form: { language: "fr" } },
    { name: "owner item1 tom", method: "POST", path: "/item/1/owner", form: { owner: "Tom" } },
    { name: "owner item1 invalid", method: "POST", path: "/item/1/owner", form: { owner: "Hacker" } },
    { name: "item1 after meta", path: "/item/1" },
    { name: "translate reply", method: "POST", path: "/item/1/translate-reply", form: { text: "Hallo daar" } },
    { name: "attach add", method: "POST", path: "/item/1/attach-add", form: { name: "paste.png", ctype: "image/png", data: Buffer.from("tiny").toString("base64"), reply: "Concept met bijlage" } },
    { name: "attach add oversize", method: "POST", path: "/item/1/attach-add", form: { name: "big.bin", ctype: "application/octet-stream", data: BIGB64 } },
    { name: "work remove att", method: "POST", path: "/item/1/work", form: { remove_att: "502", reply: "x [image:502] y", action: "save" } },
    { name: "item1 after remove", path: "/item/1" },
    { name: "attach-doc in scope", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "226108" } },
    { name: "attach-doc scope warn", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "226449" } },
    { name: "attach-doc override", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "226449", docentry: "90002", confirm: "1" } },
    { name: "attach-doc ambiguous", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "777" } },
    { name: "attach-doc pick reject", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "777", docentry: "99999" } },
    { name: "attach-doc notfound", method: "POST", path: "/item/1/attach-doc", form: { doctype: "order", docnum: "999" } },
    { name: "attach-doc cf refused", method: "POST", path: "/item/4/attach-doc", form: { doctype: "order", docnum: "226108" } },
    { name: "attach-doc item404", method: "POST", path: "/item/999/attach-doc", form: { doctype: "order", docnum: "226108" } },
    { name: "item1 staged docs", path: "/item/1" },
    { name: "resolve known", method: "POST", path: "/compose/resolve", form: { who: "K127177" } },
    { name: "resolve multi", method: "POST", path: "/compose/resolve", form: { who: "multi" } },
    { name: "resolve none", method: "POST", path: "/compose/resolve", form: { who: "nobody" } },
    { name: "resolve empty", method: "POST", path: "/compose/resolve", form: { who: "" } },
    { name: "compose create", method: "POST", path: "/compose", form: { who: "K127177", instruction: "Vraag om betaling van order 226108", scenario: "awaiting_payment", language: "auto", mailbox: "info", pick_card: "K127177", pick_addr: "laurens@yvesmichiels.be", att_name: "a.png", att_ctype: "image/png", att_data: Buffer.from("imgpng").toString("base64") } },
    { name: "item10 busy render", path: "/item/10" },
    touch("go-compose"),
    { name: "settle item10", settle: ["SELECT status AS s FROM work_items WHERE id = 10", (r) => r && r.s !== "investigating"] },
    { name: "item10 ready", path: "/item/10" },
    { name: "compose lang change", method: "POST", path: "/item/10/language", form: { language: "en" } },
    { name: "settle item10 lang", settle: ["SELECT status AS s, language AS l FROM work_items WHERE id = 10", (r) => r && r.s !== "investigating" && r.l === "en"] },
    { name: "item10 en", path: "/item/10" },
    { name: "compose missing instruction", method: "POST", path: "/compose", form: { who: "K127177", instruction: "" } },
    { name: "compose tampered addr", method: "POST", path: "/compose", form: { who: "multi", pick_card: "K130312", pick_addr: "evil@attacker.example", instruction: "x" } },
    { name: "compose via pick", method: "POST", path: "/compose", form: { who: "multi", pick_card: "K130312", pick_addr: "felicitas@example.com", instruction: "Update over de order" } },
    { name: "settle item11", settle: ["SELECT status AS s FROM work_items WHERE id = 11", (r) => r && r.s !== "investigating"] },
    { name: "item11 ready", path: "/item/11" },
    { name: "cf recipient tampered", method: "POST", path: "/item/4/contactform-recipient", form: { addr: "evil@attacker.example" } },
    { name: "cf recipient ok", method: "POST", path: "/item/4/contactform-recipient", form: { addr: "admin@pietbv.nl" } },
    { name: "item4 confirmed", path: "/item/4" },
    { name: "send cf", method: "POST", path: "/item/4/send", form: { reply: "Thanks Piet, your order ships today.", cf_subject: "#S17915 - RoverParts.eu" } },
    { name: "item4 sent", path: "/item/4" },
    { name: "send compose", method: "POST", path: "/item/5/send", form: { reply: "Beste Laurens, graag de betaling van order 226108.", compose_subject: "Betaling order 226108" } },
    { name: "send compose sha-dup", method: "POST", path: "/item/5/send", form: { reply: "Beste Laurens, graag de betaling van order 226108.", compose_subject: "Betaling order 226108" } },
    { name: "item5 sent", path: "/item/5" },
    { name: "send reply inline", method: "POST", path: "/item/1/send", form: { reply: "Bedankt!\n[image:501]\nZie https://roverparts.eu/products/da4634" } },
    { name: "send duplicate", method: "POST", path: "/item/1/send", form: { reply: "Bedankt!\n[image:501]\nZie https://roverparts.eu/products/da4634" } },
    { name: "item1 sent", path: "/item/1" },
    { name: "send flagged refused", method: "POST", path: "/item/3/send", form: { reply: "x" } },
    { name: "status phone item2", method: "POST", path: "/item/2/status", form: { to: "phone" } },
    { name: "item2 phone", path: "/item/2" },
    { name: "status reopen item2", method: "POST", path: "/item/2/status", form: { to: "reopen" } },
    { name: "item2 reopened", path: "/item/2" },
    { name: "status reopen item7", method: "POST", path: "/item/7/status", form: { to: "reopen" } },
    { name: "item7 reopened", path: "/item/7" },
    { name: "block post item2", method: "POST", path: "/item/2/block", form: { kind: "address" } },
    { name: "block post item9 domain", method: "POST", path: "/item/9/block", form: { kind: "domain" } },
    { name: "blocks after", path: "/blocks" },
    { name: "unblock 1", method: "POST", path: "/blocks/1/unblock" },
    { name: "blocks final", path: "/blocks" },
    { name: "sync start", method: "POST", path: "/sync" },
    { name: "inbox syncing render", path: "/" },
    touch("go-sync"),
    { name: "settle sync", settle: ["SELECT running AS r FROM sync_state WHERE id = 1", (r) => r && r.r === 0] },
    { name: "inbox after sync", path: "/?synced=1" },
    { name: "inbox final", path: "/" },
    { name: "audit final", path: "/audit" },
  ];
}

function offBattery() {
  return [
    { name: "inbox actions off", path: "/" },
    { name: "item4 off", path: "/item/4" },
    { name: "item5 off", path: "/item/5" },
    { name: "send compose 403", method: "POST", path: "/item/5/send", form: { reply: "x", compose_subject: "s" } },
    { name: "send cf 403", method: "POST", path: "/item/4/send", form: { reply: "x", cf_subject: "s" } },
    { name: "cf recipient still ok", method: "POST", path: "/item/4/contactform-recipient", form: { addr: "piet@example.nl" } },
    { name: "item4 confirmed off", path: "/item/4" },
    { name: "send reply still on", method: "POST", path: "/item/1/send", form: { reply: "Hoi, dit is een gewone reply." } },
    { name: "item1 sent off-phase", path: "/item/1" },
  ];
}

function csrfBattery() {
  const ok = "https://axle-box.tail58a804.ts.net";
  return [
    { name: "csrf get ok", path: "/" },
    { name: "csrf post no origin", method: "POST", path: "/item/2/work", form: { feedback: "no origin", action: "save" } },
    { name: "csrf post evil origin", method: "POST", path: "/item/2/work", form: { feedback: "evil", action: "save" }, origin: "https://evil.example" },
    { name: "csrf post good origin", method: "POST", path: "/item/2/work", form: { feedback: "good", action: "save" }, origin: ok },
    { name: "csrf post evil referer", method: "POST", path: "/item/2/work", form: { feedback: "ref", action: "save" }, referer: "https://evil.example/page" },
    { name: "csrf send evil origin", method: "POST", path: "/item/5/send", form: { reply: "x", compose_subject: "s" }, origin: "https://evil.example" },
    { name: "item2 csrf final", path: "/item/2" },
  ];
}

const TABLES = ["work_items", "questions", "drafts", "sends", "draft_attachments", "sender_blocks", "audit_log", "users", "sync_state", "translations"];
function dumpDb(dbPath) {
  let d;
  try { d = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { d = new DatabaseSync(dbPath); }
  const out = {};
  try {
    for (const t of TABLES) out[t] = d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  } finally { d.close(); }
  return norm(JSON.stringify(out, null, 1));
}

async function runBattery(kind, base, gateDir, dbPath) {
  const steps = kind === "full" ? fullBattery(gateDir) : kind === "off" ? offBattery() : csrfBattery();
  const rec = [];
  for (const s of steps) {
    if (s.gate) { fs.writeFileSync(path.join(gateDir, s.gate), "go"); continue; }
    if (s.settle) { await settle(dbPath, s.settle[0], s.settle[1]); continue; }
    await req(base, rec, s);
  }
  return { records: rec, dump: dumpDb(dbPath) };
}

module.exports = { runBattery };
