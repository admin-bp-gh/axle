// resolve-customer.js - Axle Compose: deterministic, READ-ONLY customer resolver.
//
// Turns whatever a salesperson knows about a customer - a SAP sales-order number, an
// AR-invoice number, a SAP customer code, an email (full OR partial), a Shopify order
// number, a name, a company fragment, a VAT number, or a phone number - into a customer
// identity and, critically, a SENDABLE EMAIL ADDRESS.
//
// SECURITY INVARIANT (the crown jewel of Compose):
//   The recipient address is produced ONLY here, by deterministic SAP/Shopify reads.
//   No language model, and no tool result, ever sets, suggests, or alters a To address.
//   This module performs SELECT reads exclusively - it writes nothing, anywhere.
//   When resolution is ambiguous (an email shared by several cards, a name/search match,
//   conflicting identifiers), it returns CANDIDATES for a human to pick. It never auto-picks.
//   Partial / fuzzy matching only ever WIDENS the candidate list a human chooses from; it can
//   never bypass the pick step, and pickRecipient still validates the chosen address against
//   this resolver's own set.
//
// All SQL is parameterised (defence in depth: identifiers are data even though the
// salesperson is trusted). Customers only (OCRD.CardType='C').
//
// Dependency-injected: resolveCustomer(input, deps) takes { sapRead, shopifyOrderByName }.
// The default deps wire to mssql + connectors.js on the box; tests inject mocks.

// ---- language inference (brief sec2.4) -------------------------------------------------
// SAP's own OCRD.LangCode is NOT used: it defaults to Dutch (16) for ~90% of non-NL
// customers (e.g. 249 German customers tagged Dutch vs 76 correctly German), so it is
// worse than useless as a signal. The country-of-address map is the deterministic basis;
// prior-correspondence language (compose-mode) and the manual selector refine it later.
const COUNTRY_LANG = { NL: "nl", BE: "nl", DE: "de", FR: "fr" }; // everything else -> en
const LANG_NAMES = { 3: "English", 9: "German", 13: "Italian", 16: "Dutch", 22: "French", 23: "Spanish" };

function countryLang(country) {
  return COUNTRY_LANG[String(country || "").toUpperCase()] || "en";
}

// ---- small helpers -------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// An OCRD E_Mail / U_E_Mail field can hold one address, or several separated by ; or , -
// split, normalise to lowercase, keep only well-formed addresses, de-duplicate.
function splitEmails(raw) {
  return [...new Set(
    String(raw || "")
      .split(/[;,]/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e))
  )];
}

// Classify a single identifier token. Order matters: '@' wins for email (full or partial);
// K-codes are always customer codes; #S-numbers are Shopify orders; bare digits are a SAP
// DocNum (sales order OR AR invoice) first, falling back to a phone/general search; anything
// else (a name, a company fragment, a VAT number) is a general multi-field search.
function detectType(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t) return { type: "empty", value: "" };
  if (t.includes("@")) return { type: "email", value: t.toLowerCase() };
  if (/^K\d{3,}$/i.test(t)) return { type: "card_code", value: t.toUpperCase() };
  if (/^#?S\d{3,}$/i.test(t)) return { type: "shopify_order", value: t.replace(/^#/, "").toUpperCase() };
  if (/^\d{3,}$/.test(t)) return { type: "doc_number", value: t };
  return { type: "search", value: t };
}

// ---- result envelopes ----------------------------------------------------------------
// Every public call returns this shape:
//   { resolved, matched_via, customer|null, candidates[], needsAddressPick, identifier, message }
// resolved === true  =>  exactly one customer AND at least one sendable address.
function resolvedResult(customer, identifier) {
  const n = customer.sendableAddresses.length;
  return {
    resolved: n >= 1,
    matched_via: customer.matched_via,
    customer,
    candidates: [],
    needsAddressPick: n > 1,
    identifier,
    message:
      n === 0 ? "Customer identified, but no email is on file - add one in SAP or enter manually."
      : n > 1 ? "Customer identified; more than one address on file - pick which to use."
      : "Resolved.",
  };
}
function candidateResult(candidates, message, identifier, via) {
  return { resolved: false, matched_via: via || identifier.type, customer: null, candidates, needsAddressPick: false, identifier, message };
}
function notFound(type, raw, message) {
  return { resolved: false, matched_via: "not_found", customer: null, candidates: [], needsAddressPick: false, identifier: { raw, type }, message };
}

// ---- shaping OCRD rows ----------------------------------------------------------------
// Columns pulled for an identity. SEARCH_COLS adds the fields the multi-field search needs.
const OCRD_COLS = "CardCode, CardName, CardFName, E_Mail, U_E_Mail, Country, LangCode, Phone1, Phone2, frozenFor, LicTradNum, ZipCode";

function languageSignals(country, langCode, knownAccount) {
  return {
    country: country || null,
    country_map: countryLang(country),
    sap_lang_code: langCode == null ? null : langCode,
    sap_lang_name: LANG_NAMES[langCode] || (langCode == null ? null : String(langCode)),
    note: knownAccount
      ? "language_hint follows the country->language map; SAP LangCode is shown for transparency but NOT used (it defaults to Dutch for most non-NL customers)."
      : "No SAP account; language_hint defaults to English - set manually if the customer writes in another language.",
  };
}

// Build the resolved-customer object from an OCRD-shaped row. `extra` may carry a document
// contact (person name + email) discovered when matching via a sales order / invoice. Sendable
// addresses come from BOTH E_Mail and U_E_Mail (the secondary email UDF) plus any doc contact.
function customerFromOcrd(row, via, extra = {}) {
  const country = row.Country || null;
  const sendable = [...new Set([...splitEmails(row.E_Mail), ...splitEmails(row.U_E_Mail), ...splitEmails(extra.contactEmail)])];
  const notes = [];
  if (row.frozenFor === "Y") notes.push("This account is frozen in SAP - confirm before contacting.");
  if (!sendable.length) notes.push("No email address on file - nothing can be auto-filled; enter one manually if appropriate.");
  return {
    cardCode: row.CardCode || null,
    name: row.CardName || null,
    contactName: extra.contactName || row.CardFName || null, // person to greet (doc contact, else OCRD CardFName)
    country,
    language_hint: countryLang(country),
    language_signals: languageSignals(country, row.LangCode, true),
    knownAccount: true,
    frozen: row.frozenFor === "Y",
    phone: row.Phone1 || row.Phone2 || null,
    sendableAddresses: sendable,
    notes,
    matched_via: via,
    context: null,                               // filled with source_doc + lines for doc matches
  };
}

// A lightweight candidate (for the human pick list). Only ever carries addresses that came
// straight from SAP - never anything a model produced. Includes CardFName as contactName and
// the secondary U_E_Mail so a customer reachable only via U_E_Mail still has a sendable address.
function candidateFromOcrd(row, reason) {
  const sendable = [...new Set([...splitEmails(row.E_Mail), ...splitEmails(row.U_E_Mail)])];
  return {
    cardCode: row.CardCode,
    name: row.CardName,
    contactName: row.CardFName || null,
    email: sendable[0] || null,
    sendableAddresses: sendable,
    country: row.Country || null,
    language_hint: countryLang(row.Country),
    frozen: row.frozenFor === "Y",
    reason: reason || null,
  };
}

// ---- resolution paths (exact identifiers) --------------------------------------------

// 3. Customer code -> OCRD directly. On a miss, fall back to the general search (a typo'd or
//    partial code can still surface via CardCode LIKE in searchCustomers).
async function byCardCode(code, deps) {
  const rows = await deps.sapRead(
    `SELECT TOP 2 ${OCRD_COLS} FROM OCRD WHERE CardType='C' AND validFor='Y' AND CardCode=@code`, { code }
  );
  if (!rows.length) return searchCustomers(code, deps);
  return resolvedResult(customerFromOcrd(rows[0], "card_code"), { raw: code, type: "card_code" });
}

// 4. Email -> OCRD. Exact match on E_Mail OR U_E_Mail first (1 => resolved; >1 => candidates,
//    since this DB shares 2,269 addresses across up to 12 cards). On no exact match: if the
//    token is a PARTIAL email (a fragment, no valid full address), do a CONTAINS search across
//    E_Mail/U_E_Mail and return candidates. Only a COMPLETE, valid, unmatched email becomes a
//    B2C/guest recipient; an unmatched fragment is "not found" (never a silent guest).
async function byEmail(email, deps, identifierType) {
  const ident = { raw: email, type: identifierType || "email" };
  const rows = await deps.sapRead(
    `SELECT TOP 25 ${OCRD_COLS} FROM OCRD WHERE CardType='C' AND validFor='Y' AND (LOWER(LTRIM(RTRIM(E_Mail)))=@e OR LOWER(LTRIM(RTRIM(U_E_Mail)))=@e)`,
    { e: email }
  );
  if (rows.length === 1) return resolvedResult(customerFromOcrd(rows[0], "email"), ident);
  if (rows.length > 1) {
    return candidateResult(
      rows.map((r) => candidateFromOcrd(r, "shares this email address")),
      `This email is on ${rows.length} customer cards - pick the right account.`, ident, "email"
    );
  }
  // No exact hit. Try a partial (contains) email search before deciding guest vs not-found.
  const part = await deps.sapRead(
    `SELECT TOP 25 ${OCRD_COLS} FROM OCRD WHERE CardType='C' AND validFor='Y' AND (LOWER(ISNULL(E_Mail,'')) LIKE @e ESCAPE '!' OR LOWER(ISNULL(U_E_Mail,'')) LIKE @e ESCAPE '!')`,
    { e: "%" + likeEscape(email) + "%" }
  );
  if (part.length) {
    return candidateResult(
      part.map((r) => candidateFromOcrd(r, "email contains \"" + email + "\"")),
      part.length === 1 ? "One customer's email contains that - confirm before sending." : `${part.length} customers' emails contain that - pick one.`,
      ident, "email_partial"
    );
  }
  if (EMAIL_RE.test(email)) {
    // A complete, valid address with no SAP match: treat the typed address as a B2C/guest recipient.
    const cust = {
      cardCode: null, name: null, contactName: null, country: null,
      language_hint: "en", language_signals: languageSignals(null, null, false),
      knownAccount: false, frozen: false, phone: null,
      sendableAddresses: [email],
      notes: ["Not a known SAP customer - treating the typed address as a B2C/guest recipient."],
      matched_via: "email_guest", context: null,
    };
    return resolvedResult(cust, ident);
  }
  return notFound("email", email, `No customer email contains "${email}".`);
}

// 1 & 2. SAP document -> customer. Pulls the BP (OCRD), the document contact (OCPR) for a
//        greeting name/fallback email, and the lines (RDR1/INV1) for downstream context
//        (the turret case: SO -> lines -> [compose-mode then finds the linked PO ETA]).
const DOC_DEFS = {
  sales_order: { head: "ORDR", line: "RDR1" },
  ar_invoice: { head: "OINV", line: "INV1" },
};
async function matchDoc(docNum, kind, deps) {
  const d = DOC_DEFS[kind];
  const rows = await deps.sapRead(
    `SELECT TOP 1 H.DocNum, H.DocEntry, H.CardCode, H.CardName AS DocCardName, H.DocStatus, H.U_Paid, H.CntctCode,
            B.CardName, B.CardFName, B.E_Mail, B.U_E_Mail, B.Country, B.LangCode, B.Phone1, B.Phone2, B.frozenFor, B.LicTradNum,
            P.Name AS ContactName, P.E_MailL AS ContactEmail
       FROM ${d.head} H
       LEFT JOIN OCRD B ON H.CardCode=B.CardCode
       LEFT JOIN OCPR P ON H.CntctCode=P.CntctCode
      WHERE H.DocNum=@n`, { n: Number(docNum) }
  );
  if (!rows.length) return null;
  const h = rows[0];
  const lines = await deps.sapRead(
    `SELECT L.ItemCode, L.Dscription, L.Quantity, L.OpenQty, L.LineStatus
       FROM ${d.line} L INNER JOIN ${d.head} H ON H.DocEntry=L.DocEntry WHERE H.DocNum=@n`, { n: Number(docNum) }
  );
  const cust = customerFromOcrd(
    { CardCode: h.CardCode, CardName: h.CardName, CardFName: h.CardFName, E_Mail: h.E_Mail, U_E_Mail: h.U_E_Mail, Country: h.Country, LangCode: h.LangCode, Phone1: h.Phone1, Phone2: h.Phone2, frozenFor: h.frozenFor, LicTradNum: h.LicTradNum },
    kind,
    { contactEmail: h.ContactEmail, contactName: h.ContactName || h.DocCardName }
  );
  cust.context = {
    source_doc: { type: kind, docNum: h.DocNum, docEntry: h.DocEntry, status: h.DocStatus, paid: h.U_Paid == null ? null : h.U_Paid },
    lines: lines.map((l) => ({ itemCode: l.ItemCode, description: l.Dscription, quantity: l.Quantity, openQty: l.OpenQty, lineStatus: l.LineStatus })),
  };
  return cust;
}

// A bare number can be a sales order OR an AR invoice - probe both, reconcile. If neither
// matches, fall back to the general search (the number may be a phone number).
async function byDocNumber(docNum, deps) {
  const ident = { raw: docNum, type: "doc_number" };
  const so = await matchDoc(docNum, "sales_order", deps);
  const inv = await matchDoc(docNum, "ar_invoice", deps);
  const found = [so, inv].filter(Boolean);
  if (!found.length) return searchCustomers(docNum, deps);
  if (found.length === 1) return resolvedResult(found[0], ident);
  if (found[0].cardCode === found[1].cardCode) {
    const c = found[0];
    c.notes = [...c.notes, `Number ${docNum} matches both a sales order and an AR invoice for this customer.`];
    return resolvedResult(c, ident);
  }
  return candidateResult(
    found.map((c) => ({
      cardCode: c.cardCode, name: c.name, email: c.sendableAddresses[0] || null,
      sendableAddresses: c.sendableAddresses, country: c.country, language_hint: c.language_hint,
      frozen: c.frozen, reason: `from ${c.matched_via.replace("_", " ")} ${docNum}`,
    })),
    `Number ${docNum} matches both a sales order and an invoice belonging to different customers - pick one.`,
    ident, "doc_number"
  );
}

// 5. Shopify order number. PREFERRED route is through SAP: ORDR.NumAtCard carries the
//    Shopify order name (e.g. "#S17878 - TR 100437"), so we resolve to the SAP customer on
//    the trusted side, no email round-trip. Falls back to the Shopify API + email cross-map
//    only when the order has not synced into SAP yet.
function tokenInNumAtCard(token, numAtCard) {
  const found = String(numAtCard || "").toUpperCase().match(/S\d{3,}/g) || [];
  return found.includes(token);
}
function dedupeByCard(rows) {
  const seen = new Map();
  for (const r of rows) if (r.CardCode && !seen.has(r.CardCode)) seen.set(r.CardCode, r);
  return [...seen.values()];
}
async function byShopifyOrder(sName, deps) {
  const token = sName.toUpperCase();                 // e.g. S17877
  const ident = { raw: sName, type: "shopify_order" };
  const rows = await deps.sapRead(
    `SELECT TOP 10 H.DocNum, H.NumAtCard, ${OCRD_COLS.split(", ").map((c) => "B." + c).join(", ")}
       FROM ORDR H LEFT JOIN OCRD B ON H.CardCode=B.CardCode
      WHERE H.NumAtCard LIKE @like`, { like: `%${token}%` }
  );
  const exact = dedupeByCard(rows.filter((r) => tokenInNumAtCard(token, r.NumAtCard)));
  if (exact.length === 1) {
    const c = customerFromOcrd(exact[0], "shopify_order_via_sap");
    c.context = { source_doc: { type: "sales_order", docNum: exact[0].DocNum, shopify_order: token }, lines: [] };
    return resolvedResult(c, ident);
  }
  if (exact.length > 1) {
    return candidateResult(
      exact.map((r) => candidateFromOcrd(r, `Shopify order ${token} on SAP order ${r.DocNum}`)),
      `Shopify order ${token} maps to several customers - pick one.`, ident, "shopify_order"
    );
  }
  // Fallback: ask Shopify directly, then cross-map its customer email to a SAP customer.
  let sh = [];
  try { sh = await deps.shopifyOrderByName(token); } catch { sh = []; }
  const email = sh && sh[0] && sh[0].customer && sh[0].customer.email;
  if (email) {
    const viaEmail = await byEmail(String(email).toLowerCase(), deps, "shopify_order");
    if (viaEmail.resolved && viaEmail.customer) {
      viaEmail.customer.matched_via = viaEmail.customer.knownAccount ? "shopify_order_via_email" : "shopify_order_guest";
      viaEmail.matched_via = viaEmail.customer.matched_via;
    }
    return viaEmail;
  }
  return notFound("shopify_order", sName, `Shopify order ${token} not found in SAP or Shopify.`);
}

// ---- multi-field search (names, company fragments, VAT, phones, partial codes) --------
// LIKE-escape: '!' is the ESCAPE char in every search LIKE, so a literal % _ [ ! in the typed
// text is matched as itself (e.g. an email with an underscore) rather than as a wildcard.
function likeEscape(s) {
  return String(s == null ? "" : s).replace(/[!%_\[]/g, (c) => "!" + c);
}

// Normalise a phone column to digits-only in SQL (strip space - + ( ) . /) so any capture
// format matches. The needle is the trailing national digits of the query (country prefix
// agnostic): +32468164880, 0032 468..., 0468..., 468... all share the subscriber tail.
function normPhoneExpr(col) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;
}
// Postcodes are matched space-stripped (Dutch "3335 LH" and "7075EL" both normalise), so a
// query token like "3335" or "lh" hits the same row's zip and token-AND still pins it.
const SEARCH_FIELDS = ["CardName", "ISNULL(CardFName,'')", "ISNULL(E_Mail,'')", "ISNULL(U_E_Mail,'')", "CardCode", "REPLACE(ISNULL(LicTradNum,''),' ','')", "REPLACE(ISNULL(ZipCode,''),' ','')", "REPLACE(ISNULL(MailZipCod,''),' ','')"];

// Build the parameterised multi-field search: every whitespace token must match SOME field
// (token-AND across a partial OR over all fields), with a phone branch when a token has >=7
// digits. Pure + exported so the exact SQL can be validated against live SAP.
function buildSearchQuery(tokens, limit = 51) {
  const params = {};
  const conds = tokens.map((tok, i) => {
    const key = "t" + i;
    params[key] = "%" + likeEscape(tok) + "%";
    const textOr = SEARCH_FIELDS.map((f) => `LOWER(${f}) LIKE @${key} ESCAPE '!'`).join(" OR ");
    let phoneOr = "";
    const digits = String(tok).replace(/\D/g, "");
    if (digits.length >= 7) {
      params[key + "p"] = "%" + digits.slice(-9) + "%";
      phoneOr = ` OR ${normPhoneExpr("Phone1")} LIKE @${key}p OR ${normPhoneExpr("Phone2")} LIKE @${key}p`;
    }
    return `(${textOr}${phoneOr})`;
  });
  // Relevance bias so the strongest matches survive the TOP cut even when a common token matches
  // thousands of rows (e.g. "van" hits 3,664 names): exact full-name first, then name prefix, then
  // the first token in a name field, then shorter (more specific) names. The resolver re-ranks the
  // fetched window precisely in JS afterwards.
  const full = tokens.join(" ");
  params.full = full;
  params.fullp = likeEscape(full) + "%";
  const order =
    "ORDER BY CASE WHEN LOWER(CardName)=@full OR LOWER(ISNULL(CardFName,''))=@full THEN 0 ELSE 1 END, " +
    "CASE WHEN LOWER(CardName) LIKE @fullp ESCAPE '!' OR LOWER(ISNULL(CardFName,'')) LIKE @fullp ESCAPE '!' THEN 0 ELSE 1 END, " +
    "CASE WHEN LOWER(CardName) LIKE @t0 ESCAPE '!' OR LOWER(ISNULL(CardFName,'')) LIKE @t0 ESCAPE '!' THEN 0 ELSE 1 END, " +
    "LEN(CardName), CardName";
  return {
    sql: `SELECT TOP ${limit} ${OCRD_COLS} FROM OCRD WHERE CardType='C' AND validFor='Y' AND ${conds.join(" AND ")} ${order}`,
    params,
  };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Rank candidate rows by match quality so the best matches lead the pick list.
function rankCandidates(rows, tokens) {
  const full = tokens.join(" ");
  const score = (r) => {
    const name = String(r.CardName || "").toLowerCase();
    const fname = String(r.CardFName || "").toLowerCase();
    const email = String(r.E_Mail || "").toLowerCase();
    const code = String(r.CardCode || "").toLowerCase();
    let s = 0;
    if (name === full || fname === full || email === full || code === full) s += 100;
    if (name.startsWith(full) || fname.startsWith(full)) s += 30;
    for (const tok of tokens) {
      if (name.includes(tok)) s += 8;
      if (fname.includes(tok)) s += 8;
      if (email.includes(tok)) s += 6;
      if (code.includes(tok)) s += 5;
      try { if (new RegExp("\\b" + escapeRe(tok) + "\\b").test(name + " " + fname)) s += 4; } catch (e) { /* ignore */ }
    }
    return s;
  };
  return rows.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s).map((x) => x.r);
}

// A short, human reason for why a row matched (shown in the pick list).
function matchReason(r, tokens) {
  const fname = String(r.CardFName || "");
  if (fname && tokens.some((t) => fname.toLowerCase().includes(t))) return "contact: " + fname;
  const vat = String(r.LicTradNum || "").toLowerCase().replace(/\s/g, "");
  if (vat && tokens.some((t) => vat.includes(t.replace(/\s/g, "")))) return "VAT match";
  const zip = String(r.ZipCode || "").toLowerCase().replace(/\s/g, "");
  if (zip && tokens.some((t) => /\d/.test(t) && zip.includes(t.replace(/\s/g, "")))) return "postcode match";
  if (tokens.some((t) => t.replace(/\D/g, "").length >= 7)) return "phone match";
  if (!r.E_Mail && !r.U_E_Mail) return "no email on file";
  return null;
}

// Bounded Levenshtein for the light typo fallback.
function lev(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Light typo tolerance: only runs when the strict search found nothing. Prefilters by the
// 4-char prefix of the longest alphabetic token (so the DB does the heavy lifting), then keeps
// rows where some name word is within edit distance 2 of a query token.
async function fuzzySearch(rawQuery, deps) {
  const tokens = String(rawQuery).toLowerCase().split(/\s+/).filter((t) => t.length >= 4 && /[a-z]/.test(t));
  if (!tokens.length) return [];
  // Prefilter on EACH token's 4-char prefix (union, bounded to the 4 longest tokens), so a rare
  // discriminating token surfaces the row even when another token is common - e.g. "aubroek
  // automotive": "auto%" matches ~2,000 rows, but "aubr%" is rare and finds "Aubroeck Automotive".
  const probes = tokens.slice().sort((a, b) => b.length - a.length).slice(0, 4);
  const seen = new Map();
  for (const tok of probes) {
    const rows = await deps.sapRead(
      `SELECT TOP 50 ${OCRD_COLS} FROM OCRD WHERE CardType='C' AND validFor='Y' AND (LOWER(CardName) LIKE @p ESCAPE '!' OR LOWER(ISNULL(CardFName,'')) LIKE @p ESCAPE '!')`,
      { p: "%" + likeEscape(tok.slice(0, 4)) + "%" }
    );
    for (const r of rows) if (!seen.has(r.CardCode)) seen.set(r.CardCode, r);
  }
  // Keep a row only when EVERY query token is within edit distance 2 of some name word (a fuzzy
  // token-AND), so a single shared common word ("Automotive") can't pull in unrelated companies.
  const scored = [];
  for (const r of seen.values()) {
    const words = (String(r.CardName || "") + " " + String(r.CardFName || "")).toLowerCase().split(/\s+/).filter(Boolean);
    let total = 0, all = true;
    for (const tok of tokens) {
      let best = 99;
      for (const w of words) best = Math.min(best, lev(tok, w));
      if (best > 2) { all = false; break; }
      total += best;
    }
    if (all) scored.push({ r, d: total });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, 15).map((s) => candidateFromOcrd(s.r, "possible spelling match"));
}

// 6. The general search. ALWAYS returns candidates for a human to pick - never auto-selects
//    (a name/company/phone is the weakest identifier). Strict multi-field token-AND first;
//    if that finds nothing, the light typo fallback.
async function searchCustomers(rawQuery, deps) {
  const ident = { raw: rawQuery, type: "search" };
  const tokens = String(rawQuery == null ? "" : rawQuery).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return notFound("search", rawQuery, "Empty search.");
  const { sql, params } = buildSearchQuery(tokens, 51);     // fetch 51 to detect overflow past 50
  const rows = await deps.sapRead(sql, params);
  if (rows.length) {
    const many = rows.length > 50;                          // the relevance ORDER BY keeps the best in-window
    const cands = rankCandidates(rows.slice(0, 50), tokens).slice(0, 25).map((r) => candidateFromOcrd(r, matchReason(r, tokens)));
    const message = many
      ? `Many customers match - showing the closest ${cands.length}. Add a surname, company, email or phone number to narrow it down.`
      : cands.length === 1 ? "One possible match - confirm this is the right customer before sending."
      : `${cands.length} customers match - pick the right one.`;
    return candidateResult(cands, message, ident, "search");
  }
  const fz = await fuzzySearch(rawQuery, deps);
  if (fz.length) return candidateResult(fz, `No exact match - showing the closest spellings to "${rawQuery}".`, ident, "search_fuzzy");
  return notFound("search", rawQuery, `No customer matches "${rawQuery}".`);
}

// byName kept as a thin alias (search already returns candidates and never auto-selects).
async function byName(name, deps) { return searchCustomers(name, deps); }

// ---- recipient confirmation (the crown-jewel gate) -----------------------------------
// Given the sendable addresses THIS resolver produced and an optional human-picked address,
// return the confirmed recipient, or "" if none is valid. The recipient MUST be one of the
// resolver's own addresses: a picked address is honoured only when it is in that set; a picked
// address that is not in the set is REJECTED with no silent fallback (a tampered or
// model-supplied To can never get through). With no pick, the sole address is taken; if there
// is more than one and nothing was picked, "" forces an explicit human choice.
function pickRecipient(validAddrs, pickAddr) {
  const addrs = (validAddrs || []).filter(Boolean);
  const pick = String(pickAddr == null ? "" : pickAddr).trim().toLowerCase();
  if (pick) {
    const i = addrs.map((a) => a.toLowerCase()).indexOf(pick);
    return i >= 0 ? addrs[i] : "";
  }
  return addrs.length === 1 ? addrs[0] : "";
}

// ---- dispatch ------------------------------------------------------------------------
async function resolveOne(raw, deps) {
  const { type, value } = detectType(raw);
  if (type === "empty") return notFound("empty", raw, "Empty identifier.");
  if (type === "email") return byEmail(value, deps);
  if (type === "card_code") return byCardCode(value, deps);
  if (type === "shopify_order") return byShopifyOrder(value, deps);
  if (type === "doc_number") return byDocNumber(value, deps);
  return searchCustomers(raw, deps);
}

// Public entry. Accepts a single identifier (string) or several (array). With several, every
// identifier is resolved and reconciled: all-agree => merged high-confidence result; disagree
// => candidates (a conflict is surfaced, never silently resolved).
async function resolveCustomer(input, deps) {
  deps = deps || defaultDeps();
  const tokens = (Array.isArray(input) ? input : [input]).map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
  if (!tokens.length) return notFound("empty", "", "No identifier provided.");
  if (tokens.length === 1) return resolveOne(tokens[0], deps);

  const parts = [];
  for (const t of tokens) parts.push(await resolveOne(t, deps));
  const resolved = parts.filter((p) => p.resolved && p.customer && p.customer.cardCode);
  const cards = [...new Set(resolved.map((p) => p.customer.cardCode))];
  const ident = { raw: tokens.join(" + "), type: "multi" };

  if (cards.length === 1 && resolved.length) {
    const base = resolved[0];
    const addrs = new Set();
    for (const p of resolved) p.customer.sendableAddresses.forEach((a) => addrs.add(a));
    base.customer.sendableAddresses = [...addrs];
    base.customer.context = Object.assign({}, ...resolved.map((p) => p.customer.context).filter(Boolean));
    base.needsAddressPick = base.customer.sendableAddresses.length > 1;
    base.identifier = ident;
    base.message = `Resolved from ${tokens.length} identifiers (all agree on ${base.customer.cardCode}).`;
    return base;
  }
  if (cards.length > 1) {
    return candidateResult(
      resolved.map((p) => ({
        cardCode: p.customer.cardCode, name: p.customer.name,
        email: p.customer.sendableAddresses[0] || null, sendableAddresses: p.customer.sendableAddresses,
        country: p.customer.country, language_hint: p.customer.language_hint,
        frozen: p.customer.frozen, reason: `from ${p.matched_via}`,
      })),
      "The identifiers point to different customers - pick the correct one.", ident, "conflict"
    );
  }
  const withCands = parts.find((p) => p.candidates && p.candidates.length);
  if (withCands) { withCands.identifier = ident; return withCands; }
  return notFound("multi", ident.raw, "Could not resolve any of the provided identifiers.");
}

// ---- default dependencies (box runtime) ----------------------------------------------
// Lazily required so the module can be imported and unit-tested without mssql present.
function defaultDeps() {
  return { sapRead: defaultSapRead, shopifyOrderByName: defaultShopify };
}
async function defaultSapRead(query, params = {}) {
  // Use the ONE shared persistent pool from connectors.js (lazily required so this module can
  // still be unit-tested with injected deps and no mssql present). Reused, not opened/closed
  // per call — same pool the engine and doc resolver use, so nothing clobbers anything.
  const pool = await require("./connectors.js").getPool();
  const req = pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const r = await req.query(query);
  return r.recordset;
}
async function defaultShopify(orderName) {
  return require("./connectors.js").shopifyOrderByName(orderName);
}

module.exports = {
  resolveCustomer, resolveOne, pickRecipient,
  // exported for tests / reuse:
  detectType, countryLang, splitEmails, customerFromOcrd, candidateFromOcrd,
  byEmail, byName, byDocNumber, byShopifyOrder, byCardCode,
  searchCustomers, buildSearchQuery, fuzzySearch, rankCandidates, matchReason, lev, likeEscape, normPhoneExpr,
};
