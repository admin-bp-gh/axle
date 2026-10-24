// The house signature under every outgoing reply and compose (24 Oct 2026): the same block the
// Workbench customer-comms wrapper uses, so a hand-written reply and an automated email look like
// one company. Added in code, below the model's or the salesperson's text, never part of the stored
// text (the integrity hash covers the text only). The sending mailbox's own site is listed first.
const SITES = {
  info:     { name: "Gouda",    line: "Kampenringweg 13, 2803 PE Gouda" },
  drachten: { name: "Drachten", line: "Het Gangboord 4C, 9206 BJ Drachten" },
};
const PHONE = "+31 (0)182 698 939";
const SMALL = "font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#667085";

// mailbox: "info" | "drachten" | "admin" (the work item's mailbox). admin signs like Gouda.
function signatureHtml(mailbox) {
  const first = mailbox === "drachten" ? "drachten" : "info";
  const order = [first, first === "info" ? "drachten" : "info"];
  const rows = order.map((k) => `${SITES[k].name}: ${SITES[k].line}`).join("<br>");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:1px solid #eaecf0"><tr><td style="padding-top:12px;${SMALL}">` +
    `<strong style="color:#101828">Budget Parts B.V.</strong><br>${rows}<br>` +
    `${PHONE} &middot; <a href="https://roverparts.eu" style="color:#1d3b2a">roverparts.eu</a></td></tr></table>`;
}

module.exports = { signatureHtml };
