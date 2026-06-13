// rules.js ? deterministic routing rules, ported from the info-triage skill.
// Updated 2026-06-06 after first accuracy review (see roadmap).
// A rule matches if ANY listed value in ANY present field hits ? unless requireAll: true,
// then every present field needs at least one hit. First match by ascending priority wins.
// Phase 2: matched actions are LOGGED ONLY, never executed.

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
  { id: "customer_invoice_reply", priority: 18, subjectContains: ["budget parts bv | invoice"], owner: "Jack", tags: ["Invoice Reply"], draft: true },
  { id: "customer_order_reply", priority: 18, subjectContains: ["budget parts | klantorder"], owner: "Jack", tags: ["Order Reply"], draft: true },
  { id: "shopify_form", priority: 40, requireAll: true, senderAddress: ["mailer@shopify.com"], subjectContains: ["klantbericht", "customer message"], owner: "Jack", draft: true },
  { id: "customer_cancellation", priority: 45, subjectContains: ["cancel", "annuleren", "refund", "annulering"], owner: "Jack", tags: ["Cancellation"], draft: true },
  { id: "customer_tracking", priority: 46, subjectContains: ["tracking", "niet ontvangen", "bezorging", "where is my order", "delivery"], owner: "Jack", tags: ["Tracking"], draft: true },
  { id: "customer_return", priority: 47, subjectContains: ["return", "retour", "wrong", "verkeerd", "uitwisselen", "complaint", "klacht"], owner: "Jack", tags: ["Return"], draft: true },
];

const infoRules = [
  ...noise,
  { ...voicemail, owner: "Jack" },
  { id: "supplier_invoice", priority: 20, senderAddress: ["facturen@myparcel.nl", "nethbil@fedex.com"], subjectContains: ["factuur", "invoice"], owner: "Tom", tags: ["Invoice"] },
  { id: "warranty_warp", priority: 21, requireAll: true, senderAddress: ["psp@allmakes.co.uk"], subjectContains: ["WARP"], owner: "Tom", tags: ["Warranty"] },
  { id: "supplier_order", priority: 22, requireAll: true, senderDomain: ["allmakes.co.uk", "allmakespsp.com"], subjectContains: ["order", "acknowledgement", "back order"], owner: "Tom" },
  { id: "supplier_news", priority: 23, senderAddress: ["marketing@allmakes.co.uk", "sales@hotbray.net"], action: "archive", owner: "Tom", tags: ["Supplier News"] },
  { id: "supplier_direct", priority: 25, senderDomain: ["tuffplusautolighting.com", "breeland.nl"], owner: "Tom" },
  { id: "admin_forward", priority: 30, requireAll: true, senderAddress: ["admin@budget-parts.nl"], subjectContains: ["FW:"], owner: null, llmSubRoute: true },
  { id: "b2b_known", priority: 35, senderDomain: ["sve-automotive.nl", "komplot.be"], owner: "Brendan", tags: ["B2B"], draft: true },
  ...customer,
  { id: "catch_all", priority: 100, catchAll: true, owner: "Jack", draft: true },
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
  info: { mailboxEnv: "MAILBOX_INFO", team: ["Jack", "Brendan", "Tom"], folders: ["inbox", "Shopify Contact Form"], rules: infoRules },
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

