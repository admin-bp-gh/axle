"use strict";
// forward-guard.js - DETERMINISTIC guardrails for the reassign-and-forward handover
// (allow-list action #6, 2026-08-08). Pure and model-independent: no LLM, no network, no DB.
// Given a work item and the owner label a human picked, it either returns a validated forward
// payload or throws with a clear reason.
//
// WHAT THIS ACTION IS. Reassigning an item to an owner who works a DIFFERENT mailbox is a real
// handover, not a relabel. Axle forwards the email to that owner's mailbox so the work physically
// moves: it lands where they actually work, and (once the caller closes the item and marks the
// source message read) it leaves the handing-over team's Axle queue and their Outlook unread list.
// Reassigning inside the same mailbox - Sales(Gouda) -> Tom, both info@ - forwards nothing and
// keeps the old relabel behaviour.
//
// DESTINATION MODEL. This is the whole security story, and it is deliberately much narrower than
// the customer-facing send path:
//
//     THE DESTINATION CAN ONLY EVER BE ONE OF OUR OWN THREE MAILBOXES.
//
// It is looked up in code from rules.OWNER_HOME - a fixed table of owner label -> mailbox - using
// the label a human clicked, which the caller has already validated against ownerChoices(). There
// is no path from an email body, a tool result, a model output or a free-text field to the To
// address. A hostile email therefore cannot cause a forward to anywhere outside the company; the
// worst it could achieve is landing in a colleague's mailbox, which is where mail lives anyway.
//
// Because the destination is internal-only, the outbound URL allowlist that governs customer
// replies is deliberately NOT applied here: we are relaying an email between our own staff, and
// stripping or refusing a customer's own links would defeat the point of a handover.
//
// Invariants enforced here:
//   * an injection-flagged item is NEVER forwarded (a suspect email must not be quietly pushed
//     into another mailbox - and admin@ is read by an LLM triage skill, so this matters);
//   * only a live INBOUND item with a real Graph message id can be forwarded (never a compose
//     item, which has no inbound message, and never an already-closed one);
//   * the destination differs from the item's own mailbox, so a forward can never loop a mailbox
//     back into itself;
//   * the handover note is built from OUR strings plus a sanitised sender name/address - never
//     raw email content, which travels in the forwarded body where it belongs.
const rulesets = require("./rules.js");

// Owner labels the forward path knows about, with their home mailbox. Single source: rules.js.
const { ownerHome } = rulesets;

// Where a reassignment to `toOwner` should send an item currently living in `itemMailbox`.
// Returns { box, address } for a cross-mailbox handover, or null when nothing should be sent:
// an unknown label, an owner with no mailbox of their own (Tom), or an owner who already works
// this mailbox. null is NOT an error - it means "plain relabel", the pre-2026-08-08 behaviour.
function forwardTargetFor(itemMailbox, toOwner) {
  const home = ownerHome(toOwner);
  if (!home || !home.address) return null;
  if (home.box === String(itemMailbox || "")) return null;
  return home;
}

// Strip anything that is not safely displayable from a customer-controlled display name before it
// goes into our handover note. The note is a plain-text `comment` on a Graph forward; Graph places
// it in the message body, so angle brackets, ampersands and newlines are removed rather than
// trusted to be encoded. The address is not sanitised but SCREENED (below): it either looks like
// one address or it is dropped.
function plainName(s) {
  return String(s == null ? "" : s)
    .replace(/[<>&"'\r\n\t]/g, " ")                            // no markup, no extra lines
    .split(/\s+/)
    // Drop whole tokens that look like an address or a header: a display name is customer-
    // controlled, and "Jan <attacker@evil.com>" or "To: victim@evil.com" pasted into a name
    // must not be able to read as a second sender or a second header in our note.
    .filter((tok) => tok && !tok.includes("@") && !tok.includes(":"))
    .join(" ")
    .trim()
    .slice(0, 80);
}
const ADDR_OK = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function plainAddress(s) {
  const a = String(s == null ? "" : s).trim().toLowerCase();
  return ADDR_OK.test(a) && a.length <= 254 ? a : "";
}

// The handover note placed above the forwarded message. Ours, not the customer's: it says who
// handed the item over, from which queue, and where the original came from, so the receiving
// person has the context Axle had without opening Axle. A base URL (AXLE_BASE_URL, e.g.
// https://axle-box.tail58a804.ts.net) adds a deep link; without one the item number still shows.
function handoverNote(workItem, { fromOwner, toOwner, byName, byLogin }) {
  const who = plainName(byName) || plainName(byLogin) || "Axle";
  const from = plainName(fromOwner) || "unassigned";
  const senderName = plainName(workItem.sender_name);
  const senderAddr = plainAddress(workItem.sender_email);
  const origin = senderName && senderAddr ? `${senderName} <${senderAddr}>` : (senderAddr || senderName || "unknown");
  const base = String(process.env.AXLE_BASE_URL || "").trim().replace(/\/+$/, "");
  const link = base ? `${base}/item/${workItem.id}` : `Axle item #${workItem.id}`;
  return [
    `Handed over in Axle by ${who}.`,
    `From: ${from}  ->  To: ${plainName(toOwner)}`,
    `Original sender: ${origin}`,
    link,
    "",
  ].join("\n");
}

// Assemble and validate a handover forward. Returns { to, box, mailboxKey, messageId, comment,
// toOwner, fromOwner } or throws. The caller performs the Graph call and only then writes to the
// DB, so a failed forward leaves the item exactly as it was.
function assembleForward(workItem, { toOwner, byName, byLogin } = {}) {
  if (!workItem) throw new Error("refused: no work item");
  if (workItem.injection_flag) throw new Error("refused: item is flagged as possible injection - resolve it before handing it over");
  if (workItem.origin === "compose") throw new Error("refused: a composed email has no inbound message to forward");
  if (["done", "archived"].includes(String(workItem.status || ""))) throw new Error("refused: item is closed - reopen it first");
  if (!workItem.latest_message_id) throw new Error("refused: item has no source message to forward");

  const target = forwardTargetFor(workItem.mailbox, toOwner);
  if (!target) throw new Error(`refused: ${String(toOwner || "(none)")} has no mailbox of their own to forward to`);

  const to = plainAddress(target.address);
  if (!to) throw new Error("refused: owner mailbox address is not a valid single address");

  return {
    to,                                   // one of our own mailboxes, from the fixed owner table
    box: target.box,                      // the destination mailbox key ('info' | 'drachten' | 'admin')
    mailboxKey: String(workItem.mailbox),  // the mailbox we forward FROM (Graph acts as this user)
    messageId: workItem.latest_message_id,
    toOwner: String(toOwner),
    fromOwner: workItem.owner || null,
    comment: handoverNote(workItem, { fromOwner: workItem.owner, toOwner, byName, byLogin }),
  };
}

module.exports = { forwardTargetFor, assembleForward, handoverNote, plainName, plainAddress };
