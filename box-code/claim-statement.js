// claim-statement.js - Step 3 of the carrier-claim build: the purchase-value statement.
//
// MyParcel's claim template says the payout is "op basis van 100% van de inkoopwaarde", so every
// investigation asks for an inkoopfactuur. We cannot send one. A supplier invoice covers a whole
// delivery: dozens of parts that were never in this parcel, at our buying prices, for customers
// who have nothing to do with the claim. The team refused on exactly those grounds in October
// 2025 ("meerdere onderdelen op staan die niet gericht zijn naar deze klant") and that refusal
// was right. It also does not always exist - three of the eight lines on order 227148 have no
// usable purchase record at all.
//
// So Axle produces the document that actually answers the question: a one-page statement of the
// purchase value of THIS parcel's contents, line by line, from our own accounting records, with
// the supplier invoice behind each line named as a reference. It discloses exactly what the claim
// needs and nothing else.
//
// Rendering: headless Edge, already on the box, so no new npm dependency and nothing to keep
// patched. HTML in, PDF out.
//
// SAFETY. Every value printed comes from claimDossier - that is, from SAP and from our own
// MyParcel record. NO text from the inbound email reaches this document, so a claim email cannot
// influence a word of what we send an insurer. Everything is HTML-escaped on the way in anyway,
// because SAP item descriptions are free text that staff edit.
//
// READ-ONLY: builds a file in the render out-dir and returns the bytes. Writes nothing to SAP,
// stages nothing, sends nothing. The caller stages it behind the existing approval gate.

"use strict";
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const EDGE = process.env.AXLE_EDGE_EXE ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = process.env.AXLE_RENDER_OUT || path.join(__dirname, "..", "render", "out");

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Money, in the reader's convention. MyParcel writes Dutch, so nl formatting is the default.
//
// Plain rounding of the actual double, deliberately. An earlier version added Number.EPSILON to
// "fix" the half-cent case; that was cargo-cult - EPSILON is relative to 1, so it changes nothing
// at scale 100 - and the premise was wrong anyway. A literal like 1.005 is not representable: the
// stored value really is 1.00499999999999989, so rounding it down is correct, not a bug. What
// float noise CAN do is turn 1.58 x 3 into 4.740000000000001, and rounding to the cent fixes
// exactly that. SAP gives us values already at 2dp, so a true half-cent does not arise here.
function money(n, lang) {
  const v = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  return lang === "en" ? v : v.replace(".", ",");
}

function isoDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? String(d).slice(0, 10) : dt.toISOString().slice(0, 10);
}

const T = {
  nl: {
    title: "Opgave inkoopwaarde",
    subtitle: "Specificatie van de inkoopwaarde van de inhoud van de zending",
    shipment: "Zending", carrier: "Vervoerder", shipped: "Verzonden op",
    order: "Onze order", invoice: "Onze verkoopfactuur", recipient: "Geadresseerde",
    weight: "Gewicht", insured: "Verzekerd bedrag",
    qty: "Aantal", part: "Artikelnummer", desc: "Omschrijving", brand: "Uitvoering",
    unit: "Inkoopprijs p/st", line: "Inkoopwaarde", source: "Inkoopreferentie",
    total: "Totale inkoopwaarde",
    noSource: "geen inkoopfactuur van vóór de verzenddatum",
    basisHead: "Grondslag",
    basis: "De inkoopwaarde per regel is de door ons geboekte inkoopkostprijs van de daadwerkelijk " +
      "verzonden artikelen, ontleend aan onze administratie (SAP Business One) bij de verkoopfactuur " +
      "van deze zending. Waar een inkoopfactuur van vóór de verzenddatum beschikbaar is, is deze " +
      "als referentie vermeld. Een latere inkoop is bewust niet gebruikt: die betreft niet de goederen " +
      "die in deze zending zaten.",
    privacyHead: "Toelichting",
    privacy: "Onze inkoopfacturen bevatten telkens een volledige levering met tientallen artikelen " +
      "die geen deel uitmaakten van deze zending. Deze opgave bevat daarom uitsluitend de regels van " +
      "deze zending.",
    footer: "Opgesteld uit de administratie van Budget Parts B.V.",
    generated: "Opgemaakt op",
  },
  en: {
    title: "Statement of purchase value",
    subtitle: "Purchase value of the contents of this shipment, line by line",
    shipment: "Shipment", carrier: "Carrier", shipped: "Shipped on",
    order: "Our order", invoice: "Our sales invoice", recipient: "Recipient",
    weight: "Weight", insured: "Insured amount",
    qty: "Qty", part: "Part number", desc: "Description", brand: "Grade",
    unit: "Purchase price ea.", line: "Purchase value", source: "Purchase reference",
    total: "Total purchase value",
    noSource: "no purchase invoice dated on or before dispatch",
    basisHead: "Basis",
    basis: "The purchase value per line is our booked cost of the goods actually shipped, taken " +
      "from our accounting records (SAP Business One) against the sales invoice for this shipment. " +
      "Where a purchase invoice dated on or before dispatch exists, it is named as a reference. A " +
      "later purchase is deliberately not used: it does not concern the goods that were in this parcel.",
    privacyHead: "Note",
    privacy: "Each of our purchase invoices covers a whole delivery of dozens of parts that were not " +
      "in this shipment. This statement therefore lists only the lines of this shipment.",
    footer: "Prepared from the records of Budget Parts B.V.",
    generated: "Prepared on",
  },
};

// ---------------------------------------------------------------- the document
// Pure function: dossier in, HTML out. Kept separate from rendering so the whole document can be
// asserted in a unit test without Edge, a printer or a filesystem.
function buildStatementHtml(dossier, opts = {}) {
  const lang = opts.lang === "en" ? "en" : "nl";
  const t = T[lang];
  const d = dossier || {};
  const s = d.shipment || {};
  const inv = (d.sales_invoices || [])[0] || null;
  const ord = (d.orders || [])[0] || null;
  const rows = d.contents || [];
  const today = isoDate(opts.now || new Date());

  const meta = [
    [t.shipment, s.barcode || d.barcode],
    [t.carrier, s.carrier],
    [t.shipped, isoDate(s.created)],
    [t.order, ord ? ord.doc_num : null],
    [t.invoice, inv ? `${inv.doc_num} (${isoDate(inv.date)})` : null],
    [t.recipient, [s.recipient && s.recipient.person, s.recipient && s.recipient.company].filter(Boolean).join(", ")],
    [t.weight, s.weight_g ? `${s.weight_g} g` : null],
    [t.insured, d.insurance && d.insurance.insured_eur != null ? `EUR ${money(d.insurance.insured_eur, lang)}` : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const body = rows.map((r) => {
    // Supplier, invoice and date on their own lines, with the invoice number and date each held
    // unbroken. Run together with separators they wrapped mid-value ("2026-" / "06-09"), which on
    // a reference an insurer may quote back at us is worse than merely untidy.
    const src = r.purchase_source
      ? `${esc(r.purchase_source.supplier)}<br><span class="nb">${esc(r.purchase_source.supplier_invoice)}</span>` +
        `<br><span class="nb">${esc(isoDate(r.purchase_source.date))}</span>`
      : `<span class="muted">${esc(t.noSource)}</span>`;
    return `<tr>
      <td class="num">${esc(r.quantity)}</td>
      <td class="code">${esc(r.customer_code || r.item_code)}</td>
      <td>${esc(r.description)}</td>
      <td>${esc(r.quality || "")}</td>
      <td class="num">${money(r.unit_purchase_cost, lang)}</td>
      <td class="num">${money(r.line_purchase_cost, lang)}</td>
      <td class="src">${src}</td>
    </tr>`;
  }).join("\n");

  const total = d.purchase_value ? d.purchase_value.total_eur : 0;

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 10pt/1.4 "Segoe UI", Arial, sans-serif; color: #111; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #005A0A; padding-bottom: 8px; }
  .co { font-size: 9pt; color: #333; text-align: right; }
  .co b { color: #005A0A; font-size: 11pt; }
  h1 { font-size: 15pt; margin: 0 0 2px; }
  .sub { color: #555; font-size: 9pt; margin: 0; }
  table.meta { margin: 14px 0 4px; border-collapse: collapse; font-size: 9pt; }
  table.meta td { padding: 1px 14px 1px 0; vertical-align: top; }
  table.meta td.k { color: #555; white-space: nowrap; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 9pt; }
  table.lines th { text-align: left; border-bottom: 1px solid #005A0A; padding: 5px 6px; font-size: 8.5pt;
                   text-transform: uppercase; letter-spacing: .3px; color: #005A0A; }
  table.lines td { padding: 5px 6px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.code { font-family: Consolas, monospace; white-space: nowrap; }
  td.src { font-size: 8pt; color: #444; }
  .nb { white-space: nowrap; }
  .muted { color: #888; font-style: italic; }
  tr.total td { border-top: 2px solid #005A0A; border-bottom: none; font-weight: bold; padding-top: 8px; }
  .notes { margin-top: 16px; font-size: 8.5pt; color: #333; }
  .notes h2 { font-size: 9pt; margin: 10px 0 2px; color: #005A0A; text-transform: uppercase; letter-spacing: .3px; }
  .notes p { margin: 0; }
  .foot { margin-top: 18px; padding-top: 6px; border-top: 1px solid #ddd; font-size: 8pt; color: #666;
          display: flex; justify-content: space-between; }
</style></head><body>
<div class="head">
  <div><h1>${esc(t.title)}</h1><p class="sub">${esc(t.subtitle)}</p></div>
  <div class="co"><b>Budget Parts B.V.</b><br>Kampenringweg 13<br>2803 PE Gouda<br>
    KvK 28064788 &middot; BTW NL817343118B01</div>
</div>

<table class="meta">
${meta.map(([k, v]) => `  <tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("\n")}
</table>

<table class="lines">
  <!-- Fixed widths: the description is the column a reader actually reads, so it gets the room.
       Without these, the browser sized every column by its content and the descriptions wrapped
       to three lines while the numeric columns sat half empty. -->
  <colgroup>
    <col style="width:6%"><col style="width:14%"><col style="width:30%"><col style="width:10%">
    <col style="width:11%"><col style="width:11%"><col style="width:18%">
  </colgroup>
  <thead><tr>
    <th class="num">${esc(t.qty)}</th><th>${esc(t.part)}</th><th>${esc(t.desc)}</th>
    <th>${esc(t.brand)}</th><th class="num">${esc(t.unit)}</th>
    <th class="num">${esc(t.line)}</th><th>${esc(t.source)}</th>
  </tr></thead>
  <tbody>
${body}
    <tr class="total">
      <td colspan="5">${esc(t.total)}</td>
      <td class="num">EUR ${money(total, lang)}</td><td></td>
    </tr>
  </tbody>
</table>

<div class="notes">
  <h2>${esc(t.basisHead)}</h2><p>${esc(t.basis)}</p>
  <h2>${esc(t.privacyHead)}</h2><p>${esc(t.privacy)}</p>
</div>

<div class="foot"><span>${esc(t.footer)}</span><span>${esc(t.generated)} ${esc(today)}</span></div>
</body></html>`;
}

// ---------------------------------------------------------------- render
//
// WHY THIS POLLS INSTEAD OF WAITING FOR THE PROCESS. On Windows the msedge.exe we launch is a
// launcher: it hands off to the real browser and exits, so execFile's callback fires almost
// immediately, long before the PDF is on disk. The first version treated that callback as
// "finished", read a file that did not exist yet, and reported "Edge produced no PDF" - which
// read like Edge had failed when in fact it was still working. The give-away was the throwaway
// profile directory: fully populated (so Edge was doing real work) and undeletable (so its
// processes still held locks) at the moment we declared failure.
//
// So completion is judged by the OUTPUT, not the process: wait for the PDF to appear and for its
// size to stop changing. The exec error is still captured, because a genuine launch failure
// (missing exe, blocked by policy) should say so rather than time out silently.
function waitForPdf(p, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastSize = -1, stable = 0;
    const tick = () => {
      let st = null;
      try { st = fs.statSync(p); } catch { /* not written yet */ }
      if (st && st.size > 0) {
        // Two consecutive equal sizes: Edge has finished flushing, not caught mid-write.
        if (st.size === lastSize) { if (++stable >= 2) return resolve(true); }
        else { stable = 0; lastSize = st.size; }
      }
      if (Date.now() - started > timeoutMs) return resolve(!!(st && st.size > 0));
      setTimeout(tick, 250);
    };
    tick();
  });
}

// Throwaway profiles are litter if a render dies mid-flight, and Edge may still hold locks on the
// one we just used. Sweep anything older than an hour on the way in, so the out-dir heals itself
// rather than accumulating hundreds of files (which is exactly what the first failed run left).
function sweepOldProfiles() {
  try {
    const cutoff = Date.now() - 3600e3;
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (!/^edge-profile-/.test(name) && !/^claim-[0-9a-f]{8}\.(html|pdf)$/.test(name)) continue;
      const p = path.join(OUT_DIR, name);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); }
      catch { /* locked or already gone - next sweep will get it */ }
    }
  } catch { /* out-dir may not exist yet */ }
}

function htmlToPdf(html, opts = {}) {
  return new Promise((resolve) => {
    const stamp = crypto.randomBytes(4).toString("hex");
    const htmlPath = path.join(OUT_DIR, `claim-${stamp}.html`);
    const pdfPath = path.join(OUT_DIR, `claim-${stamp}.pdf`);
    const profile = path.join(OUT_DIR, `edge-profile-${stamp}`);
    const timeout = opts.timeout || 60000;
    const cleanup = () => {
      for (const p of [htmlPath, pdfPath]) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
      // Edge often still holds this; the next run's sweep clears it.
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      sweepOldProfiles();
      fs.writeFileSync(htmlPath, html, "utf8");
    } catch (e) { return resolve({ ok: false, error: "could not stage the statement HTML: " + e.message }); }

    const args = [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      "file:///" + htmlPath.replace(/\\/g, "/"),
    ];

    let launchError = null;
    execFile(EDGE, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      // Captured for the error message only. A non-zero exit here does NOT mean failure: the
      // launcher routinely exits before the browser has finished.
      if (err) launchError = String(err.message || err).split("\n")[0];
      const e = String(stderr || "").trim();
      if (e) launchError = (launchError ? launchError + " | " : "") + e.split("\n").slice(0, 2).join(" ");
    });

    waitForPdf(pdfPath, timeout).then((appeared) => {
      let buffer = null;
      if (appeared) { try { buffer = fs.readFileSync(pdfPath); } catch { /* handled below */ } }
      cleanup();
      if (!buffer || !buffer.length) {
        return resolve({
          ok: false,
          error: "Edge produced no PDF within " + Math.round(timeout / 1000) + "s" +
                 (launchError ? " (" + launchError + ")" : ""),
        });
      }
      // A PDF starts %PDF-. Anything else means Edge wrote something we must not attach.
      if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") {
        return resolve({ ok: false, error: "the rendered file is not a PDF" });
      }
      resolve({ ok: true, buffer, bytes: buffer.length });
    });
  });
}

// High-level: dossier -> attachable PDF. Refuses rather than producing an empty or misleading
// document - a statement with no lines would assert a purchase value of zero to an insurer.
async function buildStatementPdf(dossier, opts = {}) {
  if (!dossier || !dossier.found) return { ok: false, error: "no claim dossier" };
  if (!(dossier.contents || []).length) return { ok: false, error: "the shipment's invoice has no lines to value" };
  if (!dossier.purchase_value || !(dossier.purchase_value.total_eur > 0)) {
    return { ok: false, error: "no purchase value could be established for these lines" };
  }
  const html = buildStatementHtml(dossier, opts);
  const r = await htmlToPdf(html, opts);
  if (!r.ok) return r;
  const inv = (dossier.sales_invoices || [])[0];
  const stem = inv ? `Inkoopwaarde-${inv.doc_num}` : `Inkoopwaarde-${dossier.barcode}`;
  return { ok: true, filename: `${stem}.pdf`, buffer: r.buffer, bytes: r.bytes };
}

module.exports = { buildStatementHtml, htmlToPdf, buildStatementPdf, waitForPdf, sweepOldProfiles, esc, money, T };
