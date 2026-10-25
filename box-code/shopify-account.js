// shopify-account.js - the "Shopify account" card on an email (2026-10-25): the customer's account
// state behind the sender's address and the four account actions staff otherwise do in the Shopify
// admin. Classic customer accounts: invite, create and invite, activation link, password reset.
// Rules live here, not in the UI: which action a state allows, a 10-minute cooldown per customer
// and action, and one row in shopify_account_actions per attempt. Shopify userErrors come back
// verbatim. Clients are injected (deps) so the tests run without the network.
const C = require("./connectors.js");
const { db } = require("./db.js");

const COOLDOWN_MIN = 10;
const ALLOWED = {
  send_invite: ["DISABLED", "INVITED", "DECLINED"],
  create_and_invite: [],            // only when no customer exists (state null)
  activation_url: ["DISABLED", "INVITED", "DECLINED"],
  password_reset: ["ENABLED"],
};
const ACTIONS = Object.keys(ALLOWED);

// The actions a looked-up card offers: state null = no customer found.
function allowedActions(state) {
  if (state === null) return ["create_and_invite"];
  return ACTIONS.filter((a) => ALLOWED[a].includes(state));
}

function defaultDeps() {
  return {
    lookup: C.shopifyCustomerLookup,
    admin: C.shopifyGraphql,
    recover: C.storefrontCustomerRecover,
    now: () => Date.now(),
  };
}

// The card's data: { found: 0|1|n, customer|null, customers (on several), actions }.
async function lookup(email, deps = defaultDeps()) {
  const rows = email ? await deps.lookup(email) : [];
  const shape = (c) => ({
    id: c.id, name: c.displayName || "", email: c.email || "", state: c.state, tags: c.tags || [],
    company: c.companyContactProfiles?.[0]?.company?.name || null,
    lastOrder: c.lastOrder ? { name: c.lastOrder.name, date: c.lastOrder.createdAt } : null,
  });
  if (rows.length === 1) { const c = shape(rows[0]); return { found: 1, customer: c, actions: allowedActions(c.state) }; }
  if (rows.length === 0) return { found: 0, customer: null, actions: allowedActions(null) };
  return { found: rows.length, customer: null, customers: rows.map(shape), actions: [] };
}

function lastOk(customerId, action) {
  if (!customerId) return null;
  return db.prepare("SELECT ts FROM shopify_account_actions WHERE shopify_customer_id = ? AND action = ? AND result = 'ok' ORDER BY id DESC LIMIT 1").get(customerId, action);
}
function record(row) {
  db.prepare("INSERT INTO shopify_account_actions (work_item_id, shopify_customer_id, action, user, result, error) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.workItemId ?? null, row.customerId ?? null, row.action, row.user, row.result, row.error ?? null);
}
function recent(workItemId, limit = 5) {
  return db.prepare("SELECT ts, action, user, result, error FROM shopify_account_actions WHERE work_item_id = ? ORDER BY id DESC LIMIT ?").all(workItemId, limit);
}

const userErrText = (errs) => errs.map((e) => e.message).join("; ");

// Runs one action for an email's customer. Returns { ok: true, action, url? } or
// { ok: false, reason: not_allowed | cooldown | no_customer | several | user_errors | failed, message? }.
// Every outcome, including a refusal, is a row in shopify_account_actions.
async function run({ action, email, name, workItemId, user }, deps = defaultDeps()) {
  if (!ACTIONS.includes(action)) throw new Error("unknown action " + action);
  const l = await lookup(email, deps);
  const customer = l.customer;
  const refuse = (reason, extra = {}) => {
    record({ workItemId, customerId: customer?.id, action, user, result: "refused", error: reason + (extra.message ? ": " + extra.message : "") });
    return { ok: false, reason, ...extra };
  };
  if (l.found > 1) return refuse("several");
  if (action !== "create_and_invite" && !customer) return refuse("no_customer");
  if (!l.actions.includes(action)) return refuse("not_allowed", { state: customer ? customer.state : null });
  const last = lastOk(customer?.id, action);
  if (last) {
    const ageMin = (deps.now() - Date.parse(last.ts.replace(" ", "T") + "Z")) / 60000;
    if (ageMin < COOLDOWN_MIN) return refuse("cooldown", { minutes: Math.ceil(COOLDOWN_MIN - ageMin) });
  }

  let customerId = customer?.id || null, url = null;
  try {
    if (action === "create_and_invite") {
      const parts = String(name || "").trim().split(/\s+/);
      const input = { email, firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || ""), lastName: parts.length > 1 ? parts[parts.length - 1] : "" };
      const d = await deps.admin(`mutation ($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, { input });
      if (d.customerCreate.userErrors.length) throw { userErrors: d.customerCreate.userErrors };
      customerId = d.customerCreate.customer.id;
    }
    if (action === "send_invite" || action === "create_and_invite") {
      const d = await deps.admin(`mutation ($id: ID!) { customerSendAccountInviteEmail(customerId: $id) { userErrors { field message } } }`, { id: customerId });
      if (d.customerSendAccountInviteEmail.userErrors.length) throw { userErrors: d.customerSendAccountInviteEmail.userErrors };
    }
    if (action === "activation_url") {
      const d = await deps.admin(`mutation ($id: ID!) { customerGenerateAccountActivationUrl(customerId: $id) { accountActivationUrl userErrors { field message } } }`, { id: customerId });
      if (d.customerGenerateAccountActivationUrl.userErrors.length) throw { userErrors: d.customerGenerateAccountActivationUrl.userErrors };
      url = d.customerGenerateAccountActivationUrl.accountActivationUrl;
    }
    if (action === "password_reset") {
      const errs = await deps.recover(customer.email || email);
      if (errs.length) throw { userErrors: errs };
    }
  } catch (e) {
    if (e && e.userErrors) {
      const message = userErrText(e.userErrors);
      record({ workItemId, customerId, action, user, result: "failed", error: message.slice(0, 300) });
      return { ok: false, reason: "user_errors", message, userErrors: e.userErrors };
    }
    const message = String(e?.message || e).slice(0, 300);
    record({ workItemId, customerId, action, user, result: "failed", error: message });
    return { ok: false, reason: "failed", message };
  }
  record({ workItemId, customerId, action, user, result: "ok" });
  return { ok: true, action, customerId, url };
}

module.exports = { ACTIONS, COOLDOWN_MIN, allowedActions, lookup, run, recent, defaultDeps };
