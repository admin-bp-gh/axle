// phone-numbers.js - the customer's phone numbers as SAP holds them (round 2, request 13): one OCRD
// phone field split into its numbers, and the tel: target of a number. Pure; customer-summary.js
// splits, routes/item.js links. Tested in customer-contact.test.js.
"use strict";

// One phone field as its numbers: split at ; , a line break, " of ", " or ", " en ", and at a "/"
// only when every part is a whole number (six digits or more), so a Belgian "02/123.45.67" stays one.
const digits = (s) => (s.match(/\d/g) || []).length;
function splitPhones(v) {
  return String(v || "").split(/\s*(?:[;,\r\n]|\s(?:of|or|en)\s)\s*/i)
    .flatMap((p) => { const parts = p.split(/\s*\/\s*/); return parts.length > 1 && parts.every((x) => digits(x) >= 6) ? parts : [p]; })
    .map((p) => p.trim()).filter(Boolean);
}

// The tel: target of a number as written, or null when it is not one: a leading + or 00 kept, a
// "(0)" after the country code dropped, spaces, dots, hyphens, brackets and a slash inside one number
// ("02/123.45.67") removed; 6 to 15 digits.
// "+31 (0)10 123 4567" -> "+31101234567".
function telHref(number) {
  const s = String(number || "").trim().replace(/^(\+|00)\s*(\d{1,3})\s*\(0\)/, "$1$2");
  const d = s.replace(/[\s.\-()\/]/g, "");
  return /^\+?\d{6,15}$/.test(d) ? d : null;
}

module.exports = { splitPhones, telHref };
