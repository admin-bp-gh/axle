// customer-summary.js - FR-0002: read-only customer overview for the item view.
//
// Given a CardCode, returns the at-a-glance summary the card shows (discount tier / price list,
// open orders count+value, open invoices count+outstanding, account balance) and, for the detail
// modal, lifetime stats + recent orders + recent invoices.
//
// READ-ONLY: it only SELECTs from SAP via the shared read-only pool in connectors.js (the same
// pool the draft engine uses). It never writes anything, anywhere. The CardCode is always resolved
// on the trusted side (compose_customer, or the inbound sender via customerByEmail) - never taken
// from email content - so this can only ever read the email's own customer.
"use strict";
const sql = require("mssql");
const C = require("./connectors.js");

// "13. Sales - Pro (10%)" -> "Sales - Pro (10%)" (strip Brad's leading sort-number prefix).
function cleanTier(name) {
  return String(name || "").replace(/^\s*\d+\.\s*/, "").trim() || null;
}

// Short TTL cache so repeated item views don't re-hit SAP for the same customer. The summary is
// live-ish data (open orders/invoices), so a few minutes stale is fine for an at-a-glance card.
const _cache = new Map();              // cardCode -> { at, data }
const TTL_MS = 3 * 60 * 1000;

// At-a-glance summary for the card. Returns null if the CardCode doesn't exist in OCRD.
async function summarise(cardCode) {
  const cc = String(cardCode || "").trim();
  if (!cc) return null;
  const hit = _cache.get(cc);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const pool = await C.getPool();
  const head = await pool.request().input("cc", sql.NVarChar, cc).query(
    `SELECT T0.CardCode, T0.CardName, T0.CardType, T0.Balance, T0.Currency, T0.Country,
            T0.frozenFor, T1.GroupName, T2.ListName
       FROM OCRD T0
       LEFT JOIN OCRG T1 ON T1.GroupCode = T0.GroupCode
       LEFT JOIN OPLN T2 ON T2.ListNum  = T0.ListNum
      WHERE T0.CardCode = @cc`);
  if (!head.recordset.length) { _cache.set(cc, { at: Date.now(), data: null }); return null; }
  const h = head.recordset[0];

  const agg = await pool.request().input("cc", sql.NVarChar, cc).query(
    `SELECT
       (SELECT COUNT(*)                     FROM ORDR WHERE CardCode=@cc AND DocStatus='O') AS openOrders,
       (SELECT ISNULL(SUM(DocTotal),0)      FROM ORDR WHERE CardCode=@cc AND DocStatus='O') AS openOrdersVal,
       (SELECT COUNT(*)                     FROM OINV WHERE CardCode=@cc AND DocStatus='O') AS openInvoices,
       (SELECT ISNULL(SUM(DocTotal-PaidToDate),0) FROM OINV WHERE CardCode=@cc AND DocStatus='O') AS openInvOutstanding`);
  const a = agg.recordset[0] || {};

  const data = {
    cardCode: h.CardCode,
    cardName: h.CardName,
    cardType: h.CardType,                 // 'C' customer / 'S' supplier
    country: h.Country || null,
    currency: h.Currency || "EUR",
    group: h.GroupName || null,
    frozen: h.frozenFor === "Y",
    tier: cleanTier(h.ListName),
    balance: Number(h.Balance) || 0,
    openOrders: a.openOrders || 0,
    openOrdersVal: Number(a.openOrdersVal) || 0,
    openInvoices: a.openInvoices || 0,
    openInvOutstanding: Number(a.openInvOutstanding) || 0,
  };
  _cache.set(cc, { at: Date.now(), data });
  return data;
}

// Full detail for the modal: the summary + lifetime stats + recent orders + recent invoices.
async function detail(cardCode) {
  const summary = await summarise(cardCode);
  if (!summary) return null;
  const cc = summary.cardCode;
  const pool = await C.getPool();

  const stats = (await pool.request().input("cc", sql.NVarChar, cc).query(
    `SELECT
       (SELECT ISNULL(SUM(DocTotal),0) FROM OINV WHERE CardCode=@cc) AS lifetimeInv,
       (SELECT ISNULL(SUM(DocTotal),0) FROM OINV WHERE CardCode=@cc AND DocDate >= DATEADD(month,-12,GETDATE())) AS inv12m,
       (SELECT CONVERT(varchar(10), MIN(DocDate), 23) FROM OINV WHERE CardCode=@cc) AS firstInv,
       (SELECT CONVERT(varchar(10), MAX(DocDate), 23) FROM ORDR WHERE CardCode=@cc) AS lastOrder`)).recordset[0] || {};

  const orders = (await pool.request().input("cc", sql.NVarChar, cc).query(
    `SELECT TOP 10 DocNum, CONVERT(varchar(10), DocDate, 23) AS docDate, DocTotal, DocStatus
       FROM ORDR WHERE CardCode=@cc ORDER BY DocDate DESC, DocNum DESC`)).recordset;

  const invoices = (await pool.request().input("cc", sql.NVarChar, cc).query(
    `SELECT TOP 10 DocNum, CONVERT(varchar(10), DocDate, 23) AS docDate, DocTotal, PaidToDate, DocStatus
       FROM OINV WHERE CardCode=@cc ORDER BY DocDate DESC, DocNum DESC`)).recordset;

  return {
    summary,
    stats: {
      lifetimeInv: Number(stats.lifetimeInv) || 0,
      inv12m: Number(stats.inv12m) || 0,
      firstInv: stats.firstInv || null,
      lastOrder: stats.lastOrder || null,
    },
    orders: orders.map((o) => ({ docNum: o.DocNum, docDate: o.docDate, total: Number(o.DocTotal) || 0, open: o.DocStatus === "O" })),
    invoices: invoices.map((i) => ({ docNum: i.DocNum, docDate: i.docDate, total: Number(i.DocTotal) || 0, outstanding: (Number(i.DocTotal) || 0) - (Number(i.PaidToDate) || 0), open: i.DocStatus === "O" })),
  };
}

module.exports = { summarise, detail, cleanTier };
