// rules.js ? deterministic routing rules, ported from the info-triage skill.
// Updated 2026-06-06 after first accuracy review (see roadmap).
// A rule matches if ANY listed value in ANY present field hits ? unless requireAll: true,
// then every present field needs at least one hit. First match by ascending priority wins.
// Phase 2: matched actions are LOGGED ONLY, never executed.

// Gouda info@ sales is one shared queue: Jack and Brendan both work it (each user's
// owner_label = "Sales(Gouda)"). A single owner label keeps their "mine" inboxes identical
// and survives staffing changes. Drachten keeps its own label.
const SALES_GOUDA = "Sales(Gouda)";

// PURCHASING IS NOT ROUTED IN AXLE (2026-08-06, Brad's call). Tom works entirely in Outlook, and
// server-side Outlook rules already file the vast majority of his mail into "Purchasing | Tom",
// which Axle does not read. Anything of his that does reach the Inbox gets moved there by hand,
// and outlook-close.js then clears it from Axle on the 'moved' rule. So no rule assigns to Tom:
// an Axle owner label for someone who never opens Axle is a trap — it parks work in a queue
// nobody watches, which looks identical to work being handled.
//
// What triggered this: `supplier_invoice` matched on sender OR subject, so ANY email whose
// subject contained "factuur"/"invoice" was routed to purchasing. That is how #992 — a Belgian
// customer's propshaft complaint, subject "Klacht propshaft … factuur #427858" — ended up owned
// by Tom. The supplier rules below survive, because their real job is to keep supplier
// correspondence OUT of the drafting path (none of them sets `draft`), but they now match on the
// sender alone and land in the sales queue like everything else.
//
// Tom stays available as a MANUAL reassign target (reassignOnly, below) — sales can hand him an
// item deliberately; nothing does it automatically.

const noise = [
  { id: "noise_postnl", priority: 10, senderDomain: ["edm.postnl.nl"], action: "archive" },
  { id: "noise_trustedshops", priority: 10, senderDomain: ["etrusted.com"], action: "archive" },
  { id: "noise_newsletter", priority: 10, senderAddress: ["redactie@amklassiek.nl"], action: "archive" },
  { id: "noise_marketing", priority: 10, senderDomain: ["mail.hallmark.eu", "exmoortrim.co.uk", "mailing.dhl.nl", "cdm-bedrijfskleding.nl", "hbm-machines.com", "ehbo-koffer.nl"], action: "archive" },
  { id: "shipment_notice", priority: 15, senderAddress: ["no-reply@myparcel.nl"], action: "categorise", tags: ["Shipment Notice"] },
  { id: "spam_known", priority: 10, senderAddress: ["info@impexcompany.nl"], senderDomain: ["leafautoparts.com"], action: "junk" },
];

const voicemail = { id: "voicemail", priority: 10, senderAddress: ["voicemail@hipservice.nl"], action: "categorise", tags: ["Voicemail"] };

const customer = [
  { id: "customer_invoice_reply", priority: 18, subjectContains: ["budget parts bv | invoice"], owner: SALES_GOUDA, tags: ["Invoice Reply"], draft: true },
  { id: "customer_order_reply", priority: 18, subjectContains: ["budget parts | klantorder"], owner: SALES_GOUDA, tags: ["Order Reply"], draft: true },
  { id: "shopify_form", priority: 40, requireAll: true, senderAddress: ["mailer@shopify.com"], subjectContains: ["klantbericht", "customer message"], owner: SALES_GOUDA, draft: true },
  { id: "customer_cancellation", priority: 45, subjectContains: ["cancel", "annuleren", "refund", "annulering"], owner: SALES_GOUDA, tags: ["Cancellation"], draft: true },
  { id: "customer_tracking", priority: 46, subjectContains: ["tracking", "niet ontvangen", "bezorging", "where is my order", "delivery"], owner: SALES_GOUDA, tags: ["Tracking"], draft: true },
  // Shopify self-service "Return items" notification: sender is our own info@, but the mailer's
  // subject is exact. Higher priority than customer_return so it is tagged distinctly. newOutbound
  // marks it for the new-outbound recipient flow (reply goes to the order's customer, not info@).
  { id: "shopify_return_request", priority: 44, subjectContains: ["return requested for order"], owner: SALES_GOUDA, tags: ["Return"], draft: true, newOutbound: true },
  { id: "customer_return", priority: 47, subjectContains: ["return", "retour", "wrong", "verkeerd", "uitwisselen", "complaint", "klacht"], owner: SALES_GOUDA, tags: ["Return"], draft: true },
];

const infoRules = [
  ...noise,
  { ...voicemail, owner: SALES_GOUDA },
  // Sender-only, deliberately: the subject condition that used to sit here is what misrouted
  // customer mail. These two addresses send nothing but invoices, so the sender IS the rule —
  // and unlike `requireAll`, an invoice with an unexpected subject still matches.
  { id: "supplier_invoice", priority: 20, senderAddress: ["facturen@myparcel.nl", "nethbil@fedex.com"], owner: SALES_GOUDA, tags: ["Invoice"] },
  { id: "warranty_warp", priority: 21, requireAll: true, senderAddress: ["psp@allmakes.co.uk"], subjectContains: ["WARP"], owner: SALES_GOUDA, tags: ["Warranty"] },
  { id: "supplier_order", priority: 22, requireAll: true, senderDomain: ["allmakes.co.uk", "allmakespsp.com"], subjectContains: ["order", "acknowledgement", "back order"], owner: SALES_GOUDA },
  // Archived, so no work item is created and the owner label would never be read anyway.
  { id: "supplier_news", priority: 23, senderAddress: ["marketing@allmakes.co.uk", "sales@hotbray.net"], action: "archive", tags: ["Supplier News"] },
  { id: "supplier_direct", priority: 25, senderDomain: ["tuffplusautolighting.com", "breeland.nl"], owner: SALES_GOUDA },
  { id: "admin_forward", priority: 30, requireAll: true, senderAddress: ["admin@budget-parts.nl"], subjectContains: ["FW:"], owner: null, llmSubRoute: true },
  { id: "b2b_known", priority: 35, senderDomain: ["sve-automotive.nl", "komplot.be"], owner: SALES_GOUDA, tags: ["B2B"], draft: true },
  ...customer,
  { id: "catch_all", priority: 100, catchAll: true, owner: SALES_GOUDA, draft: true },
];

const drachtenRules = [
  ...noise,
  { ...voicemail, owner: "Drachten" },
  ...customer.map((r) => ({ ...r, owner: "Drachten" })), // Drachten: Rob & Huub share; owner labelled "Drachten"
  { id: "catch_all", priority: 100, catchAll: true, owner: "Drachten", draft: true },
];

module.exports = {
  // 'folders' = the mail folders Axle ingests for this mailbox. info@ also reads "Shopify Contact
  // Form" (customer messages from the webshop contact form, which a server-side Outlook rule files
  // out of the Inbox). Names are resolved to Graph folder ids at read time.
  // 'reassignOnly' = owner labels a human may hand an item to, that no rule ever assigns
  // automatically. Tom is here and not in any rule: purchasing is worked in Outlook (see the
  // note at the top), but sales can still pass him something deliberately.
  info: { mailboxEnv: "MAILBOX_INFO", team: ["Jack", "Brendan", "Tom"], reassignOnly: ["Tom"], folders: ["inbox", "Shopify Contact Form"], rules: infoRules },
  drachten: { mailboxEnv: "MAILBOX_DRACHTEN", team: ["Rob", "Huub"], folders: ["inbox"], rules: drachtenRules },
};


// Shared rule matcher (first match by ascending priority wins).
function matchRule(email, rules) {
  const addr = email.from.address.toLowerCase();
  const domain = addr.split("@")[1] || "";
  const subject = email.subject.toLowerCase();
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (rule.catchAll) return rule;
    const checks = [];
    if (rule.senderDomain) checks.push(rule.senderDomain.some((d) => domain === d || domain.endsWith("." + d)));
    if (rule.senderAddress) checks.push(rule.senderAddress.some((a) => addr === a.toLowerCase()));
    if (rule.subjectContains) checks.push(rule.subjectContains.some((s) => subject.includes(s.toLowerCase())));
    if (!checks.length) continue;
    if (rule.requireAll ? checks.every(Boolean) : checks.some(Boolean)) return rule;
  }
  return null;
}
module.exports.matchRule = matchRule;

