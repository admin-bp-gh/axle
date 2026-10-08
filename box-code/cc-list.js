// cc-list.js - the Cc of a reply (round 2, request 8): what is on it, what may be offered, and
// whether a posted address may be added. Pure; the route (server.js POST /item/:id/cc) supplies the
// item, the known address set (recipient-set.js, the same set the To menu offers) and the stored
// thread (message-store.js itemThread).
//
// work_items.cc_json holds [{ addr, source }], source one of:
//   onfile  - in the known set for the customer (resolver-produced, or the thread sender);
//   copied  - the customer copied it (to or cc) on their own newest email: offered, never added
//             by itself, and only ever by a person's click;
//   typed   - typed by a person; it passed the same screen as a typed To.
// Never one of our own mailboxes, never the To, no duplicates, at most MAX_CC. send-guard.itemCc
// screens the list again at send time, so a list that went stale refuses the send rather than
// sending to a bad address.
"use strict";
const SG = require("./send-guard.js");

const MAX_CC = SG.MAX_CC;
const norm = (a) => String(a == null ? "" : a).trim().toLowerCase();

// The item's current Cc. Tolerant of a bad column (the send screen refuses that case).
function list(w) {
  try {
    const l = JSON.parse(w.cc_json || "[]");
    return Array.isArray(l) ? l.filter((e) => e && e.addr).map((e) => ({ addr: norm(e.addr), source: String(e.source || "typed") })) : [];
  } catch (e) { return []; }
}

// The customer's newest message in the thread (oldest-first list): the newest not sent from one of
// our own mailboxes. Null when there is none.
function newestCustomerMessage(thread) {
  for (let i = (thread || []).length - 1; i >= 0; i--) {
    if (!SG.isOwnAddress(thread[i].from && thread[i].from.address)) return thread[i];
  }
  return null;
}

// The addresses that may be offered as Cc, [{ addr, source }]: the known set (minus a typed To, which
// is not known) as onfile, then the to and cc recipients of the customer's newest message as copied.
// Lower-cased and de-duplicated (first wins); our own mailboxes, the current To and addresses already
// in Cc are left out.
function suggestions(w, known, thread, to) {
  const taken = new Set([norm(to), ...list(w).map((e) => e.addr)]);
  const out = [];
  const offer = (addr, source) => {
    const a = norm(addr);
    if (!a || taken.has(a) || SG.isOwnAddress(a) || !SG.acceptTypedRecipient(a)) return;
    taken.add(a);
    out.push({ addr: a, source });
  };
  for (const e of known || []) if (e.source !== "typed") offer(e.addr, "onfile");
  const m = newestCustomerMessage(thread);
  if (m) for (const r of [...(m.to || []), ...(m.cc || [])]) offer(r && r.address, "copied");
  return out;
}

// Whether a posted address may be added: { entry, cc } (the new list) or { refuse } with one of
// bad_address | own | same_as_to | duplicate | too_many. An address from the suggestions keeps its
// source; any other is screened like a typed To and stored as typed.
function add(w, posted, offered, to) {
  const addr = SG.acceptTypedRecipient(posted);
  if (!addr) return { refuse: "bad_address" };
  if (SG.isOwnAddress(addr)) return { refuse: "own" };
  if (addr === norm(to)) return { refuse: "same_as_to" };
  const cur = list(w);
  if (cur.some((e) => e.addr === addr)) return { refuse: "duplicate" };
  if (cur.length >= MAX_CC) return { refuse: "too_many" };
  const hit = (offered || []).find((e) => e.addr === addr);
  const entry = { addr, source: hit ? hit.source : "typed" };
  return { entry, cc: [...cur, entry] };
}

// The list without one address ({ cc, removed }: removed false when it was not there).
function remove(w, addr) {
  const a = norm(addr);
  const cur = list(w);
  const cc = cur.filter((e) => e.addr !== a);
  return { cc, removed: cc.length !== cur.length };
}

// The column value for a list: NULL when empty.
const column = (cc) => (cc.length ? JSON.stringify(cc) : null);

module.exports = { MAX_CC, list, newestCustomerMessage, suggestions, add, remove, column };
