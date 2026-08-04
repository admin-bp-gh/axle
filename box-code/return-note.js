// return-note.js — enrichment for a Shopify self-service "Return items" notification.
// The notification lands in info@ ("Return requested for order #S18522"); its sender is our own
// mailer, NOT the customer. So a reply is a NEW outbound to the order's customer, whose address we
// obtain the crown-jewel way: the deterministic resolver (resolve-customer.byShopifyOrder), never
// the email body or the model. This module is READ-ONLY: it parses the order reference and resolves
// the candidate address set; it NEVER sets w.recipient (auto-set/human-confirmed in ingest/UI) and
// NEVER sends. Shape mirrors contact-form.js so the item view can render it the same way.

// Parse the Shopify order name from the notification. The subject is the reliable source
// ("Return requested for order #S18522"); fall back to scanning the body.
function parseOrderRef(email) {
  const hay = `${email.subject || ""}\n${email.text || ""}`;
  const m = hay.match(/#?S\d{4,6}/i);
  return m ? m[0].toUpperCase().replace(/^S/, "#S").replace(/^##/, "#") : null;
}

// deps.resolveCustomer is injectable for unit tests; defaults to the box resolver.
async function buildReturnNotification(email, mailbox, deps = {}) {
  const resolveCustomer = deps.resolveCustomer || require("./resolve-customer.js").resolveCustomer;
  const orderRef = parseOrderRef(email);

  let resolved = { matched: false, matched_via: null, cardCode: null, name: null, country: null, frozen: false };
  let candidateAddresses = [];
  if (orderRef) {
    try {
      const r = await resolveCustomer(orderRef);          // byShopifyOrder → the order's customer
      if (r && r.resolved && r.customer) {
        resolved = {
          matched: true, matched_via: r.matched_via || "shopify_order",
          cardCode: r.customer.cardCode || null, name: r.customer.name || null,
          country: r.customer.country || null, frozen: !!r.customer.frozen,
        };
        candidateAddresses = (r.customer.sendableAddresses || []).filter(Boolean);
      }
    } catch (e) {
      resolved.error = e.message;
    }
  }

  return {
    parsed: { orderRef, name: resolved.name || null },
    resolved,
    candidateAddresses,                                   // the set pickRecipient validates against
    defaultRecipient: candidateAddresses.length === 1 ? candidateAddresses[0] : null,
    source: "shopify_return_notification",
  };
}

module.exports = { buildReturnNotification, parseOrderRef };
