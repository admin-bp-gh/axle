// sap-doc-pdf.js - render a referenced SAP document to its Boyum print PDF (READ-ONLY).
//
// Given a salesperson-supplied document type + number, this module:
//   1. resolves DocNum -> DocEntry via parameterised axle_read SQL. The DocEntry is NEVER
//      chosen by the model or by any email/tool content - only by this deterministic lookup
//      from the number a human typed (mirrors the compose recipient-gate philosophy).
//   2. invokes the read-only Crystal renderer (render-doc.ps1) with the FIXED ObjectId for
//      that type and the resolved DocEntry.
//   3. returns the PDF bytes + the document's identity (CardCode/name/total/date) so the
//      caller can show it for human confirmation and scope-check it against the compose
//      customer before the PDF is ever attached.
//
// Read-only throughout: SELECT-only SQL on the axle_read login; the .rpt only SELECTs.
// Nothing is written to SAP and nothing is sent. The PDF lands in draft_attachments behind
// the existing approval gate, exactly like a hand-attached file.

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sql = require("mssql");          // kept for the typed inputs (sql.Int / sql.NVarChar)
const C = require("./connectors.js");  // shared persistent SQL pool (getPool)

// Fixed, code-side map of supported document types -> SAP object type + header table.
// Table names come ONLY from this whitelist (never from user input or the model), so the
// DocNum->DocEntry lookup can never be SQL-injected through the type. DocNum is parameterised.
const DOC_TYPES = {
  order:      { objectId: 17, table: "ORDR", label: "Order",       prefix: "Order" },
  invoice:    { objectId: 13, table: "OINV", label: "Invoice",     prefix: "Invoice" },
  quotation:  { objectId: 23, table: "OQUT", label: "Quotation",   prefix: "Quotation" },
  delivery:   { objectId: 15, table: "ODLN", label: "Delivery",    prefix: "Delivery" },
  creditnote: { objectId: 14, table: "ORIN", label: "Credit note", prefix: "CreditNote" },
};

// 64-bit Windows PowerShell 5.1 (NOT pwsh 7 - Crystal is a .NET Framework component).
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const RENDER_PS1 = "C:\\Axle\\render\\render-doc.ps1";
const OUT_DIR = "C:\\Axle\\render\\out";

function docTypeInfo(type) {
  const t = DOC_TYPES[String(type || "order").toLowerCase()];
  if (!t) throw new Error("Unsupported document type: " + type);
  return t;
}

// Resolve a user-supplied document number to its DocEntry + identity (READ-ONLY).
// Returns { ok, candidates:[...] }. Candidates (plural) so a human disambiguates when a
// number is shared across series; this never auto-picks an ambiguous match.
async function resolveDocument(type, docNum) {
  const t = docTypeInfo(type);
  const n = parseInt(String(docNum).replace(/\D/g, ""), 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Invalid document number" };
  const pool = await C.getPool();
  const r = await pool.request().input("n", sql.Int, n).query(
    "SELECT DocEntry, DocNum, CardCode, CardName, DocTotal, DocCur, DocDate " +
    "FROM " + t.table + " WHERE DocNum = @n ORDER BY DocEntry"
  );
  const candidates = r.recordset.map((d) => ({
    type: t.label, objectId: t.objectId,
    docEntry: d.DocEntry, docNum: d.DocNum,
    cardCode: d.CardCode, cardName: d.CardName,
    docTotal: d.DocTotal, docCur: d.DocCur, docDate: d.DocDate,
  }));
  return { ok: true, candidates };
}

// Invoke the read-only Crystal renderer for a resolved (objectId, docEntry).
// Resolves to { ok:true, buffer, bytes } or { ok:false, error }.
function renderPdf(objectId, docEntry) {
  return new Promise((resolve) => {
    const out = path.join(OUT_DIR, "doc-" + objectId + "-" + docEntry + "-" + crypto.randomBytes(4).toString("hex") + ".pdf");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RENDER_PS1,
      "-ObjectId", String(objectId), "-DocKey", String(docEntry), "-Out", out];
    execFile(PS, args, { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (line.indexOf("RENDER_OK") === 0) {
        try {
          const buffer = fs.readFileSync(out);
          fs.unlink(out, () => {});
          return resolve({ ok: true, buffer, bytes: buffer.length });
        } catch (e) { return resolve({ ok: false, error: "PDF read failed: " + e.message }); }
      }
      try { fs.unlinkSync(out); } catch (e) { /* nothing to clean */ }
      const msg = line.indexOf("RENDER_ERR") === 0 ? line.slice("RENDER_ERR".length).trim()
        : String((stderr && stderr.toString().trim()) || (err && err.message) || "render failed");
      return resolve({ ok: false, error: msg });
    });
  });
}

// High-level: resolve a UNIQUE document and render it. Returns the PDF buffer + the
// document identity (for human confirmation + the customer-scope check) or candidates/
// errors. NEVER renders when the number is ambiguous or absent.
async function buildDocumentPdf(type, docNum) {
  const res = await resolveDocument(type, docNum);
  if (!res.ok) return res;
  if (res.candidates.length === 0) return { ok: false, error: "No such document" };
  if (res.candidates.length > 1) return { ok: false, ambiguous: true, candidates: res.candidates };
  const doc = res.candidates[0];
  const r = await renderPdf(doc.objectId, doc.docEntry);
  if (!r.ok) return { ok: false, error: r.error, doc };
  return { ok: true, doc, filename: docTypeInfo(type).prefix + "-" + doc.docNum + ".pdf", buffer: r.buffer, bytes: r.bytes };
}

// Resolve a Shopify order NAME (e.g. "S17878") to its SAP sales order(s) (READ-ONLY).
// ORDR.NumAtCard carries the Shopify order name (e.g. "#S17878 - TR 100437"), so a webshop
// reference resolves on the trusted SAP side. Returns the SAME candidate shape as
// resolveDocument so the caller treats it identically (always an Order / objectId 17). The
// token is matched WHOLE (S17878 must not match S178780) via the same guard the customer
// resolver uses. Like resolveDocument: returns candidates (plural); never auto-picks ambiguity.
function tokenInNumAtCard(token, numAtCard) {
  const found = String(numAtCard || "").toUpperCase().match(/S\d{3,}/g) || [];
  return found.includes(token);
}
async function resolveShopifyOrder(sName) {
  const token = String(sName || "").trim().toUpperCase();
  if (!/^S\d{3,}$/.test(token)) return { ok: false, error: "Invalid Shopify order name" };
  const o = DOC_TYPES.order;
  const pool = await C.getPool();
  const r = await pool.request().input("like", sql.NVarChar, "%" + token + "%").query(
    "SELECT TOP 20 DocEntry, DocNum, CardCode, CardName, DocTotal, DocCur, DocDate, NumAtCard " +
    "FROM ORDR WHERE NumAtCard LIKE @like ORDER BY DocEntry DESC"
  );
  // Whole-token guard: keep only rows whose NumAtCard actually contains the S-number as a token.
  const candidates = (r.recordset || [])
    .filter((d) => tokenInNumAtCard(token, d.NumAtCard))
    .map((d) => ({
      type: o.label, objectId: o.objectId,
      docEntry: d.DocEntry, docNum: d.DocNum,
      cardCode: d.CardCode, cardName: d.CardName,
      docTotal: d.DocTotal, docCur: d.DocCur, docDate: d.DocDate,
      shopifyName: token,
    }));
  return { ok: true, candidates };
}

// Resolve an inbound sender's email to a SINGLE active SAP customer (READ-ONLY). Returns
// { cardCode, cardName } only when EXACTLY one active customer matches E_Mail/U_E_Mail; on no
// match or several (a shared address), returns { cardCode: null } so the caller falls back to an
// explicit human confirm rather than assuming a customer.
async function customerByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.indexOf("@") < 1) return { cardCode: null };
  const pool = await C.getPool();
  const r = await pool.request().input("e", sql.NVarChar, e).query(
    "SELECT CardCode, CardName FROM OCRD WHERE CardType='C' AND validFor='Y' " +
    "AND (LOWER(E_Mail) = @e OR LOWER(U_E_Mail) = @e)"
  );
  const rows = r.recordset || [];
  if (rows.length === 1) return { cardCode: rows[0].CardCode, cardName: rows[0].CardName };
  return { cardCode: null };
}

module.exports = { DOC_TYPES, docTypeInfo, resolveDocument, resolveShopifyOrder, tokenInNumAtCard, renderPdf, buildDocumentPdf, customerByEmail };

// --- CLI for box testing:  node sap-doc-pdf.js <type> <docNum>  (writes a PDF, prints identity) ---
if (require.main === module) {
  (async () => {
    const type = process.argv[2] || "order";
    const num = process.argv[3] || "226108";
    const out = await buildDocumentPdf(type, num);
    if (!out.ok) { console.log("FAILED:", JSON.stringify(out)); process.exit(1); }
    const dest = path.join(OUT_DIR, "cli-" + type + "-" + out.doc.docNum + ".pdf");
    fs.writeFileSync(dest, out.buffer);
    console.log("OK  ", out.doc.type, out.doc.docNum, "->", "DocEntry", out.doc.docEntry,
      "| customer", out.doc.cardCode, out.doc.cardName, "|", out.doc.docTotal, out.doc.docCur,
      "|", out.bytes, "bytes ->", dest);
    process.exit(0);
  })().catch((e) => { console.log("ERROR:", e.message); process.exit(1); });
}
