"use strict";
// forwarded-origin.js - who wrote the email a colleague forwarded to us (round of 15 Oct 2026).
// Pure and deterministic: plain text in, addresses out. No model, no network, no database.
//
// When one of our own mailboxes sends us an email, send-guard.ownMailCase decides who the reply is
// for: the colleague (their own message) or the customer whose email they forwarded. This module
// reads the forwarded part: the header blocks a mail client writes above a forwarded or quoted
// message, in the order they appear, and the forward markers.
//
// Recognised header blocks (plain text, as Graph returns bodies; leading "> " quote marks and
// "*" bold marks are ignored):
//   * Outlook EN/NL/DE: "From: | Van: | Von:" followed within six lines by Sent, Date, To, Subject,
//     Cc (or Verzonden, Datum, Aan, Onderwerp, Gesendet, An, Betreff);
//   * Gmail and Apple Mail forwards: the same From line under "---------- Forwarded message" or
//     "Begin forwarded message:" (the From line is then followed by Date/Subject/To);
//   * reply attributions: "On <date>, Name <addr> wrote:", "Op <date> schreef Name <addr>:", and the
//     German "Am <date> schrieb Name <addr>:", on one line or wrapped over two.
// A block counts only when its line holds one screened address (the To screen of send-guard is
// applied by the caller). A From line with a name only gives a block without an address.
//
// SECURITY. What this returns is text from an email body. It is offered to a human only as the
// recipient-set source 'forwarded' (labelled, amber "not on file" unless the resolver knows the
// address), and only for mail whose thread sender is one of our own mailboxes; never sent without
// the human pressing Send, and never via the model.

const FROM_RE = /^(?:from|van|von)\s*:\s*(.*)$/i;
const NEXT_RE = /^(?:sent|date|to|subject|cc|verzonden|datum|aan|onderwerp|gesendet|an|betreff)\s*:/i;
const ATTRIB_RE = /^(?:on|op|am)\s.+\s(?:wrote|schreef|schrieb)\s.*:\s*$|^(?:on|op|am)\s.+\swrote\s*:\s*$/i;
const ATTRIB_START_RE = /^(?:on|op|am)\s/i;
const FWD_MARKER_RE = /^(?:-{2,}\s*(?:forwarded message|doorgestuurd bericht|weitergeleitete nachricht)\s*-*|begin (?:forwarded message|doorgestuurd bericht)\s*:)\s*$/i;
const ADDR_RE = /([^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+\.[a-z]{2,})/i;
const ADDR_ONLY_RE = /^[^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+\.[a-z]{2,}$/i;

// A line without quote marks, bold stars and surrounding white space.
const clean = (line) => String(line).replace(/^[\s>]+/, "").replace(/\*/g, "").trim();

// The address and the name on a From value: "Name <a@b.nl>", "Name [mailto:a@b.nl]", "a@b.nl",
// "Name <a@b.nl<mailto:a@b.nl>>". The address is the one in the LAST angle brackets (or mailto
// brackets), as a mail client writes the real sender after the display name; a display name can
// hold anything ("jan@x.nl" <attacker@evil.com>, "Evil <a@evil.com>" <real@x.nl>). Without
// brackets the value must hold exactly one address, else none is read. The name is what stands
// before the first bracket, unquoted.
const BRACKETED_RE = /<\s*(?:mailto:)?([^<>\s]+@[^<>\s]+?)\s*>|\[\s*mailto:([^\]\s]+)\s*\]/gi;
function addressOf(value) {
  const v = String(value || "");
  const cut = v.search(/[<[]/);
  const name = (cut < 0 ? v : v.slice(0, cut)).replace(/["']/g, " ").replace(/\s+/g, " ").trim();
  const bracketed = [...v.matchAll(BRACKETED_RE)].map((m) => m[1] || m[2]);
  if (bracketed.length) {
    const a = bracketed[bracketed.length - 1].toLowerCase();
    return { addr: ADDR_ONLY_RE.test(a) ? a : "", name };
  }
  const bare = v.match(new RegExp(ADDR_RE.source, "gi")) || [];
  return bare.length === 1 ? { addr: bare[0].toLowerCase(), name: "" } : { addr: "", name: bare.length ? "" : name };
}

// Every header block in the text, top to bottom: [{ addr, name, kind: "from" | "attribution", line }],
// line being the block's first line (0-based, over the text split on line breaks).
function headerBlocks(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n").map(clean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FROM_RE.exec(l);
    if (f && lines.slice(i + 1, i + 7).some((x) => NEXT_RE.test(x))) {
      out.push({ ...addressOf(f[1]), kind: "from", line: i });
      continue;
    }
    if (!ATTRIB_START_RE.test(l)) continue;
    const one = ATTRIB_RE.test(l) ? l : (lines[i + 1] && ATTRIB_RE.test(l + " " + lines[i + 1]) ? l + " " + lines[i + 1] : "");
    if (!one) continue;
    const m = ADDR_RE.exec(one.replace(/mailto:/gi, " "));
    if (!m) continue;
    // The name: after "schreef" or "schrieb" (NL, DE), else after the last comma before the address (EN).
    const n = /(?:schreef|schrieb)\s+([^<]*?)\s*</i.exec(one) || /,\s*([^,<]*?)\s*<[^>]*>\s*wrote/i.exec(one);
    out.push({ addr: m[1].toLowerCase(), name: n ? n[1].replace(/"/g, "").trim() : "", kind: "attribution", line: i });
  }
  return out;
}

// The text from a header block on: the forwarded message itself, without what was written above it.
const textFrom = (text, block) => String(text || "").replace(/\r\n?/g, "\n").split("\n").slice(block.line).join("\n");

// Does the text carry a Gmail or Apple Mail forward marker line?
const hasForwardMarker = (text) => String(text || "").replace(/\r\n?/g, "\n").split("\n").some((l) => FWD_MARKER_RE.test(clean(l)));

// Does the subject start with a forward prefix (FW:, Fwd:, Doorst:, WG:, TR:)? A subject that starts
// with a reply prefix is a reply, even when FW: follows ("RE: FW: ...").
const isForwardSubject = (subject) => /^\s*(?:fw|fwd|doorst|door|wg|tr)\s*:/i.test(String(subject || ""));

module.exports = { headerBlocks, textFrom, hasForwardMarker, isForwardSubject, addressOf };
