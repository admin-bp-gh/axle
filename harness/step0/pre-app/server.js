// server.js - Axle team tool web server.
// v9: search - live filter box on the inbox (all useful fields incl. body text),
//     search-with-highlight inside the email on the detail page.
// v8: attachments listed on the detail page, opened via on-demand Graph fetch
//     (nothing stored on disk; PDFs/images inline, all other types download-only).
// v7: email rendering - clickable URLs, quoted-history folding.
// v6: identity via Tailscale Serve headers.
// The app binds 127.0.0.1 only. Tailscale Serve (configured once: `tailscale serve
// --bg 8484`) terminates HTTPS on the tailnet and injects the visitor's identity as
// the Tailscale-User-Login header. No public surface; no CLI dependency.
// Salesperson answers are TRUSTED input (passed via seed context); email stays untrusted.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const rulesets = require("./rules.js");
const C = require("./connectors.js");
const E = require("./engine.js");
const SG = require("./send-guard.js");
const SEND = require("./send.js");
const TR = require("./translate.js");
const INGEST = require("./ingest.js");
const RESOLVE = require("./resolve-customer.js");   // Compose: deterministic read-only customer resolver
const COMPOSE = require("./compose.js");            // Compose: compose-mode engine (draft-only)
const SCEN = require("./scenarios.js");             // Compose: seeded quick-start scenario library
const SAPDOC = require("./sap-doc-pdf.js");         // Compose: render a referenced SAP document to its Boyum print PDF (read-only)
const DOCSUGGEST = require("./doc-suggest.js");     // Auto-attach: resolve + scope-filter referenced documents (read-only)
const crypto = require("crypto");                   // synthetic conversation keys
const { db, audit, acquireSync, releaseSync, syncStatus } = require("./db.js");

const PORT = 8484;
const BIND_IP = "127.0.0.1";
const MAILBOX_OF = {
  info: process.env[rulesets.info.mailboxEnv],
  drachten: process.env[rulesets.drachten.mailboxEnv],
};
const anthropic = new Anthropic();

// Allow-list action #4 — "send reply to contact-form customer". OFF by default; Brad enables it
// deliberately at the gate by setting AXLE_ACTION_CONTACTFORM_SEND=on in the box .env and
// restarting. Until then, contact-form items draft and hold only: the Send button never appears
// and /item/:id/send refuses them at the route. Governed separately from compose's action #3.
const ACTION_CONTACTFORM_SEND = process.env.AXLE_ACTION_CONTACTFORM_SEND === "on";

// Allow-list action #3 - "send new (non-reply) / composed email". OFF by default; Brad enables it
// at Gate D by setting AXLE_ACTION_COMPOSE_SEND=on in the box .env and restarting. Until then a
// compose item drafts and holds only: no Send button, and /item/:id/send refuses it at the route.
const ACTION_COMPOSE_SEND = process.env.AXLE_ACTION_COMPOSE_SEND === "on";

// Recover items stuck in 'investigating' after a crash/restart mid-redraft.
const stuck = db.prepare("UPDATE work_items SET status = 'awaiting_input', updated_at = datetime('now') WHERE status = 'investigating'").run();
if (stuck.changes) audit("system", "recovered_stuck_items", null, `${stuck.changes} item(s) reset to awaiting_input on startup`);
// Clear a stuck sync lock left by a manual sync that died with a previous server instance.
const stuckSync = db.prepare("UPDATE sync_state SET running = 0 WHERE id = 1 AND running = 1").run();
if (stuckSync.changes) audit("system", "sync_lock_reset", null, "cleared running flag on startup");

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Read one cookie value from the request (no cookie-parser dependency).
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// --- i18n: Axle's own wording, per UI language --------------------------------
// Customer content (emails, drafts) is NOT here — that is translated on demand by
// translate.js. This dictionary covers only the chrome Axle itself authors.
const UI_LANGS = ["en", "nl"];
const DEFAULT_LANG = "en";
const langOK = (l) => (UI_LANGS.includes(l) ? l : DEFAULT_LANG);

const STRINGS = {
  en: {
    inbox: "Inbox", audit: "Audit",
    mailbox: "Mailbox", status: "Status", all: "All", info: "Info", drachten: "Drachten",
    open: "Open", done: "Done", archived: "Archived", search_emails: "Search emails…", of: "of",
    col_status: "Status", col_prio: "Prio", col_box: "Box", col_from: "From", col_subject: "Subject",
    col_intent: "Intent", col_owner: "Owner", col_open: "Open", col_updated: "Updated",
    no_items: "No items", check: "Check", back_inbox: "← back to inbox", no_subject: "(no subject)",
    priority: "Priority", language: "Language", confidence: "Confidence", owner: "Owner",
    injection_chip: "Possible scam / injection — review carefully", from: "From",
    investigating_banner: "Axle is investigating — this page refreshes automatically. You can go back to the inbox and work on other items.",
    customer_email: "Customer email", search_in_email: "Search in this email…", match: "match", matches: "matches",
    translation_heading: "English translation",
    translation_note: "Translated for you — the customer wrote in {lang}.",
    draft_note: "This is what the customer will receive. The translation below is for your reference only.",
    draft_reply: "Draft reply", holding_reply: "Holding reply (optional)",
    no_draft_await: "Held — answer the questions below, then redraft.",
    no_draft_busy: "Being drafted now.", no_draft_none: "No draft for this item.",
    reply_to_send: "Reply to send", reply_hint: "This exact text goes to the customer — edit it however you like before sending.",
    ai_draft_ref: "AI draft (reference)", ai_holding_ref: "AI holding reply (reference)",
    use_this: "Use this as my reply", edited_badge: "edited",
    attachments: "Attachments", no_attachments: "No attachments yet.",
    add_attachment: "Add a file", attach_hint: "Pictures or files to send with this reply (max 3 MB each).",
    remove: "Remove", file_too_big: "That file is over the 3 MB limit.",
    attach_total: "Attachment limit reached (3 MB total for this reply).",
    with_atts: "with {n} attachment(s)",
    your_feedback: "Your feedback",
    feedback_ph: "Optional — anything Axle should know or do differently. Used together with your answers below.",
    feedback_none: "none", questions_for_you: "Questions for you", open_lc: "open", no_questions: "No questions.",
    answer: "Answer", answer_ph: "Your answer (leave empty to skip)", unanswered: "unanswered",
    save: "Save", save_redraft: "Save & redraft",
    redraft_hint: "redraft regenerates the reply with your input — runs in the background",
    actions: "Actions", mark_done: "Mark done", archive: "Archive", reopen: "Reopen",
    mark_phone: "Resolved by phone",
    done_tip: "The work is completed (close the item)",
    phone_tip: "Completed without an email - e.g. you called the customer",
    archive_tip: "No action was needed (FYI / noise)",
    block_tip: "Stop future emails from this sender appearing in Axle",
    res_replied: "replied", res_done: "completed", res_phone: "by phone", res_no_action: "no action needed",
    nav_blocks: "Blocked",
    block_sender: "Block sender", block_title: "Block this sender",
    block_explain: "Future emails from this sender will no longer appear in Axle. They still arrive in the shared mailbox in Outlook. The block applies to both info@ and drachten@, and can be undone at any time on the Blocked page.",
    block_addr_opt: "Only this address", block_dom_opt: "The whole domain",
    block_sap_warn: "Careful - this address matches a SAP customer:",
    block_sap_none: "No SAP customer matches this address.",
    block_sap_unknown: "Could not check SAP for this address.",
    block_confirm_btn: "Block and archive this email", block_back: "Cancel",
    blocks_title: "Blocked senders", blocks_none: "No blocked senders.", unblock: "Unblock",
    blocks_explain: "Emails from these senders are ignored by Axle (they still arrive in Outlook). Anyone on the team can unblock; every change is audited.",
    col_sender_b: "Sender", col_kind_b: "Scope", col_by_b: "Blocked by", col_when_b: "When", col_item_b: "From item",
    copy_draft: "Copy draft", copied: "Copied to clipboard", send_reply_to: "Send reply to",
    send_confirm: "Send this reply to {to}?\\n\\nThe customer will receive it. The draft is sent exactly as shown.",
    sent_to: "Sent to", on_word: "on",
    send_disabled_inj: "Sending disabled: this item is flagged as possible injection.",
    actions_hint_sent: "Reply sent via Axle.",
    actions_hint_send: "Send replies in-thread; the draft goes verbatim to the customer.",
    actions_hint_copy: "Copy the draft into Outlook, or resolve questions to enable Send.",
    what_checked: "What Axle checked", none_paren: "(none)", not_found: "No such work item.",
    quoted_history: "Quoted history", lines: "lines", body_not_stored: "(body not stored)",
    send_refused: "Send refused by guardrails", send_failed: "Send failed",
    send_failed_note: "Nothing was sent — you can try again.",
    translate_btn: "Translate my reply", translating: "Translating…",
    drop_hint: "or drag & drop files here", attach_failed: "Attachment failed",
    paste_hint: "You can also paste a screenshot straight from the clipboard (Ctrl+V).",
    paste_hint_inline: "Pasting into the reply box also places it inline in the text.",
    img_inline_btn: "Insert in text",
    sync_now: "Sync now", syncing: "Syncing…", last_synced: "Last synced", never: "never",
    sync_started: "Sync started — new emails appear shortly.",
    scope_label: "Items", scope_mine: "Assigned to me",
    // Compose ("New email")
    compose_new: "New email", compose_title: "Compose a new email",
    compose_who: "Who is this customer?", compose_who_ph: "Customer code, email, order #, invoice # or name",
    compose_find: "Find customer", compose_finding: "Looking up…",
    compose_scenario: "Quick start (optional)", compose_instruction: "What should the email say?",
    compose_instruction_ph: "Tell Axle in plain language what to write. Axle researches the facts and drafts it.",
    compose_language: "Language", compose_lang_auto: "Auto", compose_from: "Send from",
    compose_create: "Draft this email", compose_creating: "Drafting…", compose_cancel: "Cancel",
    compose_recipient: "Recipient", compose_to: "To", compose_pick_address: "Pick the address to use:",
    compose_pick_customer: "More than one match — pick the customer:",
    compose_not_found: "No customer found — check the identifier.",
    compose_guest: "Not a known SAP account — will send to this address.",
    compose_frozen: "This account is frozen in SAP — confirm before contacting.",
    compose_need_who_instr: "Enter a customer and an instruction.",
    compose_need_pick: "Find the customer and confirm the recipient first.",
    compose_draft_only: "Draft only — sending new emails isn't enabled yet.",
    compose_your_instruction: "Your instruction", compose_scenario_label: "Scenario",
    compose_origin_chip: "New email", compose_failed: "Could not create the email",
    compose_customer_label: "Customer", compose_send_blocked: "Sending new emails is not enabled yet (draft only).",
    compose_relang: "Apply & re-draft",
    lang_fix: "Customer's language", lang_fix_btn: "Set",
    owner_fix: "Assign to", owner_fix_btn: "Reassign",
    attach_doc_title: "Attach SAP document", attach_doc_hint: "Attach the standard SAP/Boyum print PDF of a referenced document to this email.",
    attach_doc_type: "Type", attach_doc_number: "Number", attach_doc_btn: "Attach PDF",
    attach_doc_none: "No document with that number.", attach_doc_ambiguous: "Several documents share that number - pick one:",
    attach_doc_scope_warn: "This document belongs to a different customer than this email.",
    attach_doc_doc_cust: "Document customer", attach_doc_email_cust: "Email customer",
    attach_doc_scope_confirm: "Attach anyway", attach_doc_render_failed: "Could not generate the PDF.",
    attach_doc_compose_only: "PDF attach isn't available on this item.",
    doc_order: "Order", doc_invoice: "Invoice", doc_quotation: "Quotation", doc_delivery: "Delivery", doc_creditnote: "Credit note",
    sugg_title: "Suggested documents", sugg_hint: "Documents this email seems to reference, found in SAP. Review and attach the ones you want — nothing is attached or sent automatically.",
    sugg_add: "Attach", sugg_ref: "mentioned as", sugg_pick: "Several documents share this number — pick one:",
    sugg_other_cust: "Different customer — review before attaching", sugg_other_cust_hint: "These numbers were in the email but resolve to another customer's document. Attaching one needs an explicit confirm.",
    sugg_review: "Review",
    contactform_chip: "Contact form", contactform_draft_only: "Contact-form message — the customer's address is in the body, not the sender. Reply via Compose or Outlook; in-thread Send is disabled.",
    contactform_send_blocked: "In-thread Send is disabled for contact-form messages (the sender is Shopify's mailer, not the customer). Use Compose or Outlook.",
    cf_customer_label: "Contact-form customer", cf_pick: "Choose the address to reply to:",
    cf_from_form: "from the form", cf_on_file: "on file in SAP",
    cf_confirm_to: "Confirm recipient", cf_to_confirmed: "Recipient confirmed", cf_change: "Change recipient",
    cf_no_address: "No usable customer address was found in this message — it can't be answered here yet.",
    cf_matched: "Matched in SAP", cf_not_matched: "No SAP match — replying to the address from the form.",
    cf_order: "Order", cf_recipient_rejected: "That address is not one of the resolved options — pick one of the listed addresses.",
    cf_send_not_enabled: "Recipient confirmed. Sending contact-form replies isn't enabled yet (action #4 off).",
    cf_confirm_first: "Confirm the recipient above before this can be sent.",
    cf_subject: "Subject", cf_subject_hint: "This is a new email to the customer — set the subject they'll see.",
  },
  nl: {
    inbox: "Postvak", audit: "Audit",
    mailbox: "Mailbox", status: "Status", all: "Alle", info: "Info", drachten: "Drachten",
    open: "Open", done: "Afgehandeld", archived: "Gearchiveerd", search_emails: "Zoek e-mails…", of: "van",
    col_status: "Status", col_prio: "Prio", col_box: "Vak", col_from: "Van", col_subject: "Onderwerp",
    col_intent: "Type", col_owner: "Eigenaar", col_open: "Open", col_updated: "Bijgewerkt",
    no_items: "Geen items", check: "Controleer", back_inbox: "← terug naar postvak", no_subject: "(geen onderwerp)",
    priority: "Prioriteit", language: "Taal", confidence: "Betrouwbaarheid", owner: "Eigenaar",
    injection_chip: "Mogelijk oplichting / injectie — controleer zorgvuldig", from: "Van",
    investigating_banner: "Axle is aan het onderzoeken — deze pagina ververst automatisch. Je kunt terug naar het postvak en aan andere items werken.",
    customer_email: "E-mail van klant", search_in_email: "Zoek in deze e-mail…", match: "resultaat", matches: "resultaten",
    translation_heading: "Nederlandse vertaling",
    translation_note: "Voor je vertaald — de klant schreef in het {lang}.",
    draft_note: "Dit is wat de klant ontvangt. De vertaling hieronder is alleen ter referentie.",
    draft_reply: "Conceptantwoord", holding_reply: "Tussentijds antwoord (optioneel)",
    no_draft_await: "In de wacht — beantwoord de vragen hieronder en stel opnieuw op.",
    no_draft_busy: "Wordt nu opgesteld.", no_draft_none: "Geen concept voor dit item.",
    reply_to_send: "Antwoord om te versturen", reply_hint: "Deze tekst gaat exact naar de klant — pas hem gerust aan voor je verstuurt.",
    ai_draft_ref: "AI-concept (referentie)", ai_holding_ref: "AI tussentijds antwoord (referentie)",
    use_this: "Gebruik dit als mijn antwoord", edited_badge: "bewerkt",
    attachments: "Bijlagen", no_attachments: "Nog geen bijlagen.",
    add_attachment: "Bestand toevoegen", attach_hint: "Foto's of bestanden om met dit antwoord mee te sturen (max 3 MB per stuk).",
    remove: "Verwijderen", file_too_big: "Dat bestand is groter dan de limiet van 3 MB.",
    attach_total: "Bijlagelimiet bereikt (max 3 MB totaal voor dit antwoord).",
    with_atts: "met {n} bijlage(n)",
    your_feedback: "Jouw feedback",
    feedback_ph: "Optioneel — alles wat Axle moet weten of anders moet doen. Wordt samen met je antwoorden hieronder gebruikt.",
    feedback_none: "geen", questions_for_you: "Vragen voor jou", open_lc: "open", no_questions: "Geen vragen.",
    answer: "Antwoord", answer_ph: "Jouw antwoord (leeg laten om over te slaan)", unanswered: "niet beantwoord",
    save: "Opslaan", save_redraft: "Opslaan & opnieuw opstellen",
    redraft_hint: "opnieuw opstellen genereert het antwoord met jouw invoer — draait op de achtergrond",
    actions: "Acties", mark_done: "Markeer afgehandeld", archive: "Archiveer", reopen: "Heropen",
    mark_phone: "Telefonisch afgehandeld",
    done_tip: "Het werk is afgerond (item sluiten)",
    phone_tip: "Afgerond zonder e-mail - bv. de klant gebeld",
    archive_tip: "Geen actie nodig (ter info / ruis)",
    block_tip: "Toekomstige e-mails van deze afzender niet meer in Axle tonen",
    res_replied: "beantwoord", res_done: "afgerond", res_phone: "telefonisch", res_no_action: "geen actie nodig",
    nav_blocks: "Geblokkeerd",
    block_sender: "Blokkeer afzender", block_title: "Deze afzender blokkeren",
    block_explain: "Toekomstige e-mails van deze afzender verschijnen niet meer in Axle. Ze komen nog wel aan in de gedeelde mailbox in Outlook. De blokkade geldt voor info@ en drachten@, en is altijd terug te draaien op de pagina Geblokkeerd.",
    block_addr_opt: "Alleen dit adres", block_dom_opt: "Het hele domein",
    block_sap_warn: "Let op - dit adres hoort bij een SAP-klant:",
    block_sap_none: "Geen SAP-klant met dit adres.",
    block_sap_unknown: "Kon SAP niet controleren voor dit adres.",
    block_confirm_btn: "Blokkeer en archiveer deze e-mail", block_back: "Annuleren",
    blocks_title: "Geblokkeerde afzenders", blocks_none: "Geen geblokkeerde afzenders.", unblock: "Deblokkeer",
    blocks_explain: "E-mails van deze afzenders worden door Axle genegeerd (ze komen nog wel aan in Outlook). Iedereen in het team kan deblokkeren; elke wijziging wordt gelogd.",
    col_sender_b: "Afzender", col_kind_b: "Bereik", col_by_b: "Geblokkeerd door", col_when_b: "Wanneer", col_item_b: "Uit item",
    copy_draft: "Kopieer concept", copied: "Gekopieerd", send_reply_to: "Verstuur antwoord naar",
    send_confirm: "Dit antwoord versturen naar {to}?\\n\\nDe klant ontvangt het. Het concept wordt exact zo verstuurd als getoond.",
    sent_to: "Verstuurd naar", on_word: "op",
    send_disabled_inj: "Versturen uitgeschakeld: dit item is gemarkeerd als mogelijke injectie.",
    actions_hint_sent: "Antwoord verstuurd via Axle.",
    actions_hint_send: "Antwoorden gaan in de thread; het concept gaat woordelijk naar de klant.",
    actions_hint_copy: "Kopieer het concept naar Outlook, of beantwoord de vragen om versturen mogelijk te maken.",
    what_checked: "Wat Axle heeft gecontroleerd", none_paren: "(geen)", not_found: "Dit werkitem bestaat niet.",
    quoted_history: "Geciteerde geschiedenis", lines: "regels", body_not_stored: "(inhoud niet opgeslagen)",
    send_refused: "Versturen geweigerd door beveiliging", send_failed: "Versturen mislukt",
    send_failed_note: "Er is niets verstuurd — je kunt het opnieuw proberen.",
    translate_btn: "Vertaal mijn antwoord", translating: "Vertalen…",
    drop_hint: "of sleep bestanden hierheen", attach_failed: "Bijlage mislukt",
    paste_hint: "Je kunt ook een schermafbeelding direct vanaf het klembord plakken (Ctrl+V).",
    paste_hint_inline: "Plakken in het antwoordvak plaatst hem ook in de tekst zelf.",
    img_inline_btn: "In tekst invoegen",
    sync_now: "Nu synchroniseren", syncing: "Synchroniseren…", last_synced: "Laatst gesynchroniseerd", never: "nooit",
    sync_started: "Synchronisatie gestart — nieuwe e-mails verschijnen zo.",
    scope_label: "Items", scope_mine: "Aan mij",
    // Compose ("Nieuwe e-mail")
    compose_new: "Nieuwe e-mail", compose_title: "Nieuwe e-mail opstellen",
    compose_who: "Welke klant is dit?", compose_who_ph: "Klantcode, e-mail, order #, factuur # of naam",
    compose_find: "Klant zoeken", compose_finding: "Opzoeken…",
    compose_scenario: "Snelstart (optioneel)", compose_instruction: "Wat moet de e-mail zeggen?",
    compose_instruction_ph: "Vertel Axle in gewone taal wat het moet schrijven. Axle zoekt de feiten op en stelt het op.",
    compose_language: "Taal", compose_lang_auto: "Auto", compose_from: "Verzenden vanaf",
    compose_create: "Concept opstellen", compose_creating: "Opstellen…", compose_cancel: "Annuleren",
    compose_recipient: "Ontvanger", compose_to: "Aan", compose_pick_address: "Kies het te gebruiken adres:",
    compose_pick_customer: "Meerdere matches — kies de klant:",
    compose_not_found: "Geen klant gevonden — controleer de gegevens.",
    compose_guest: "Geen bekend SAP-account — wordt naar dit adres verstuurd.",
    compose_frozen: "Dit account is geblokkeerd in SAP — controleer voor contact.",
    compose_need_who_instr: "Voer een klant en een opdracht in.",
    compose_need_pick: "Zoek eerst de klant en bevestig de ontvanger.",
    compose_draft_only: "Alleen concept — nieuwe e-mails versturen is nog niet ingeschakeld.",
    compose_your_instruction: "Jouw opdracht", compose_scenario_label: "Scenario",
    compose_origin_chip: "Nieuwe e-mail", compose_failed: "Kon de e-mail niet aanmaken",
    compose_customer_label: "Klant", compose_send_blocked: "Nieuwe e-mails versturen is nog niet ingeschakeld (alleen concept).",
    compose_relang: "Toepassen & opnieuw opstellen",
    lang_fix: "Taal van de klant", lang_fix_btn: "Instellen",
    owner_fix: "Toewijzen aan", owner_fix_btn: "Toewijzen",
    attach_doc_title: "SAP-document bijvoegen", attach_doc_hint: "Voeg de standaard SAP/Boyum print-PDF van een document toe aan deze e-mail.",
    attach_doc_type: "Type", attach_doc_number: "Nummer", attach_doc_btn: "PDF bijvoegen",
    attach_doc_none: "Geen document met dat nummer.", attach_doc_ambiguous: "Meerdere documenten met dat nummer - kies er een:",
    attach_doc_scope_warn: "Dit document hoort bij een andere klant dan deze e-mail.",
    attach_doc_doc_cust: "Klant van document", attach_doc_email_cust: "Klant van e-mail",
    attach_doc_scope_confirm: "Toch bijvoegen", attach_doc_render_failed: "Kon de PDF niet genereren.",
    attach_doc_compose_only: "PDF bijvoegen is niet beschikbaar bij dit item.",
    doc_order: "Order", doc_invoice: "Factuur", doc_quotation: "Offerte", doc_delivery: "Levering", doc_creditnote: "Creditnota",
    sugg_title: "Voorgestelde documenten", sugg_hint: "Documenten waarnaar deze e-mail lijkt te verwijzen, gevonden in SAP. Bekijk en voeg toe wat u wilt — er wordt niets automatisch bijgevoegd of verzonden.",
    sugg_add: "Bijvoegen", sugg_ref: "genoemd als", sugg_pick: "Meerdere documenten met dit nummer — kies er een:",
    sugg_other_cust: "Andere klant — controleer voor bijvoegen", sugg_other_cust_hint: "Deze nummers stonden in de e-mail maar horen bij het document van een andere klant. Bijvoegen vereist een expliciete bevestiging.",
    sugg_review: "Bekijken",
    contactform_chip: "Contactformulier", contactform_draft_only: "Contactformulier-bericht — het e-mailadres van de klant staat in de tekst, niet bij de afzender. Beantwoord via Opstellen of Outlook; verzenden in thread is uitgeschakeld.",
    contactform_send_blocked: "Verzenden in thread is uitgeschakeld voor contactformulier-berichten (de afzender is de mailer van Shopify, niet de klant). Gebruik Opstellen of Outlook.",
    cf_customer_label: "Contactformulier-klant", cf_pick: "Kies het adres om op te antwoorden:",
    cf_from_form: "uit het formulier", cf_on_file: "bekend in SAP",
    cf_confirm_to: "Ontvanger bevestigen", cf_to_confirmed: "Ontvanger bevestigd", cf_change: "Ontvanger wijzigen",
    cf_no_address: "Geen bruikbaar klantadres gevonden in dit bericht — kan hier nog niet beantwoord worden.",
    cf_matched: "Gekoppeld in SAP", cf_not_matched: "Geen SAP-koppeling — antwoord naar het adres uit het formulier.",
    cf_order: "Order", cf_recipient_rejected: "Dat adres is geen van de gevonden opties — kies een van de getoonde adressen.",
    cf_send_not_enabled: "Ontvanger bevestigd. Versturen van contactformulier-antwoorden is nog niet ingeschakeld (actie #4 uit).",
    cf_confirm_first: "Bevestig eerst de ontvanger hierboven voordat dit verstuurd kan worden.",
    cf_subject: "Onderwerp", cf_subject_hint: "Dit is een nieuwe e-mail aan de klant — stel het onderwerp in dat de klant ziet.",
  },
};
const t = (lang, k) => (STRINGS[lang] && STRINGS[lang][k] != null) ? STRINGS[lang][k]
  : (STRINGS.en[k] != null ? STRINGS.en[k] : k);

// --- labels that depend on a controlled vocabulary, per language ---------------
const titleCase = (s) => String(s == null ? "" : s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const STATUS_LABEL = {
  en: { new: "New", investigating: "Investigating", awaiting_input: "Awaiting input", ready: "Ready", done: "Done", archived: "Archived" },
  nl: { new: "Nieuw", investigating: "Onderzoeken", awaiting_input: "Wacht op invoer", ready: "Klaar", done: "Afgehandeld", archived: "Gearchiveerd" },
};
const statusLabel = (lang, s) => (STATUS_LABEL[lang] && STATUS_LABEL[lang][s]) || STATUS_LABEL.en[s] || titleCase(s);
// "Done · by phone" / "Archived · no action needed": the status label plus the recorded
// resolution reason (work_items.resolution), when one is set. Legacy closed items have none.
const statusWithRes = (lang, w) => statusLabel(lang, w.status) + (w.resolution ? " · " + t(lang, "res_" + w.resolution) : "");
const INTENT_LABEL = {
  en: { stock_price_enquiry: "Stock / price enquiry", order_status: "Order status", cancellation: "Cancellation", return_complaint: "Return / complaint", b2b_order: "B2B order", supplier: "Supplier", invoice: "Invoice", other: "Other" },
  nl: { stock_price_enquiry: "Voorraad / prijs", order_status: "Orderstatus", cancellation: "Annulering", return_complaint: "Retour / klacht", b2b_order: "B2B-order", supplier: "Leverancier", invoice: "Factuur", other: "Overig" },
};
const intentLabel = (lang, s) => (s ? ((INTENT_LABEL[lang] && INTENT_LABEL[lang][s]) || INTENT_LABEL.en[s] || titleCase(s)) : "—");
const KIND_LABEL = {
  en: { blocking: "Question", physical: "Please check", optional: "Optional" },
  nl: { blocking: "Vraag", physical: "Controleer", optional: "Optioneel" },
};
const kindLabel = (lang, k) => (KIND_LABEL[lang] && KIND_LABEL[lang][k]) || KIND_LABEL.en[k] || titleCase(k);
// In-language name of a language code, for "the customer wrote in {lang}".
const LANG_DISPLAY = {
  en: { en: "English", nl: "Dutch", de: "German", fr: "French", other: "another language" },
  nl: { en: "Engels", nl: "Nederlands", de: "Duits", fr: "Frans", other: "een andere taal" },
};
const langDisplay = (uiLang, code) => (LANG_DISPLAY[uiLang] && LANG_DISPLAY[uiLang][code]) || code || "?";

// Drachten has no fixed owner (Rob & Huub share it); show the mailbox name as the owner.
const ownerLabel = (w) => w.owner || (w.mailbox === "drachten" ? "Drachten" : "—");

// Valid reassignment targets for an item, derived from its mailbox's routing rules' own
// owner labels (rules.js stays the single source of truth for who works a mailbox), so a
// reassign can only ever produce a label the inbox "mine" queues already understand.
const ownerChoices = (mailbox) => {
  const rules = ((rulesets[mailbox] || {}).rules) || [];
  return [...new Set(rules.map((r) => r.owner).filter(Boolean))].sort();
};

// Friendly, localised timestamps in the office timezone. EN: "Today 10:32am" /
// "Friday 10:32am" / "Fri 5 Jun, 10:32am". NL: 24-hour Dutch — "Vandaag 10:32" /
// "vrijdag 10:32" / "vr 5 jun, 10:32". Full ISO stays in data-sort for correct sorting.
const TZ = "Europe/Amsterdam";
const ymdTZ = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ }); // "YYYY-MM-DD"
const fmtTime = (d, lang) => lang === "nl"
  ? d.toLocaleTimeString("nl-NL", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: false })
  : d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", "").toLowerCase();
const REL = { en: { today: "Today", yesterday: "Yesterday" }, nl: { today: "Vandaag", yesterday: "Gisteren" } };
// SQLite stores datetimes as naive UTC ('YYYY-MM-DD HH:MM:SS', no zone); new Date() would
// read those as LOCAL time and land 1-2h off. Mark them UTC. Graph timestamps already carry
// a zone (…Z) and pass through unchanged.
function parseTS(iso) {
  const s = String(iso || "");
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) return new Date(s.replace(" ", "T") + "Z");
  return new Date(s);
}
const fmtDateTime = (iso, lang) => {
  lang = langOK(lang);
  const loc = lang === "nl" ? "nl-NL" : "en-GB";
  const d = parseTS(iso);
  if (isNaN(d)) return String(iso || "");
  const now = new Date();
  const diffDays = Math.round((Date.parse(ymdTZ(now)) - Date.parse(ymdTZ(d))) / 86400000);
  const time = fmtTime(d, lang);
  if (diffDays <= 0) return `${REL[lang].today} ${time}`;
  if (diffDays === 1) return `${REL[lang].yesterday} ${time}`;
  if (diffDays < 7) return `${d.toLocaleDateString(loc, { timeZone: TZ, weekday: "long" })} ${time}`;
  const sameYear = ymdTZ(d).slice(0, 4) === ymdTZ(now).slice(0, 4);
  const wd = d.toLocaleDateString(loc, { timeZone: TZ, weekday: "short" }).replace(".", "");
  const dm = d.toLocaleDateString(loc, { timeZone: TZ, day: "numeric", month: "short" }).replace(".", "");
  const yr = sameYear ? "" : " " + d.toLocaleDateString(loc, { timeZone: TZ, year: "numeric" });
  return `${wd} ${dm}${yr}, ${time}`;
};

// --- Email body rendering (untrusted content) ---------------------------------
// linkify: escape everything, but render http(s) URLs as clickable anchors.
// Long URLs (Shopify click-tracking etc.) get truncated DISPLAY text only; the
// real destination stays in href and shows on hover. New tab, no referrer.
// Renders both markdown links [visible text](url) — used by our drafts so the customer code
// shows instead of a raw URL — and bare URLs (truncated display, full href on hover).
const MD_OR_URL = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"]+)/g;
function linkify(s) {
  let out = "", last = 0, m;
  MD_OR_URL.lastIndex = 0;
  while ((m = MD_OR_URL.exec(s)) !== null) {
    out += esc(s.slice(last, m.index));
    if (m[1] !== undefined) {                          // markdown link: m[1]=text, m[2]=url
      const url = m[2].replace(/[).,;:!?']+$/, "");
      out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(m[1])}</a>`;
    } else {                                           // bare URL: m[3]
      const url = m[3].replace(/[).,;:!?']+$/, "");    // drop trailing punctuation
      const shown = url.length > 72 ? url.slice(0, 60) + "…" + url.slice(-8) : url;
      out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(shown)}</a>`;
      out += esc(m[3].slice(url.length));              // re-emit any trimmed punctuation
    }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// splitQuoted: find the first reply/forward marker line (EN/NL/DE) and fold
// everything from there down. Never folds if the marker is the first line
// (the whole mail would vanish) or if the tail is trivially short.
function splitQuoted(text) {
  const lines = text.split("\n");
  const isMarker = (l) =>
    /^\s*>/.test(l) ||
    /^\s*-{2,}\s*(Original Message|Oorspronkelijk bericht|Ursprüngliche Nachricht|Forwarded message|Doorgestuurd bericht)/i.test(l) ||
    /^\s*(From|Van|Von)\s*:\s.+@/i.test(l) ||
    /^\s*(On|Am|Op)\s.+\s(wrote|schrieb|schreef)\b/i.test(l);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (isMarker(lines[i])) { idx = i; break; }
  if (idx < 1 || lines.length - idx < 3) return { top: text, quoted: "" };
  return { top: lines.slice(0, idx).join("\n").replace(/\s+$/, ""), quoted: lines.slice(idx).join("\n") };
}

const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : (n || 0) + " B";

// Attachment links for the detail page. Index-based URLs; the route resolves the
// index against the stored metadata, so only attachments Axle ingested are fetchable.
function renderAttachments(w) {
  let atts = [];
  try { atts = JSON.parse(w.attachments_json || "[]"); } catch (e) { /* ignore bad json */ }
  if (!atts.length) return "";
  const links = atts.map((a, i) =>
    `<a class="att" href="/item/${w.id}/attachment/${i}" target="_blank" rel="noopener">&#128206; ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span></a>`);
  return `<p class="attrow">${links.join(" ")}</p>`;
}

function renderMail(text, lang) {
  const { top, quoted } = splitQuoted(String(text || ""));
  let html = `<pre class="mail">${linkify(top)}</pre>`;
  if (quoted) {
    const n = quoted.split("\n").length;
    html += `<details><summary>${esc(t(lang, "quoted_history"))} (${n} ${esc(t(lang, "lines"))})</summary><pre class="mail muted">${linkify(quoted)}</pre></details>`;
  }
  return html;
}
// -------------------------------------------------------------------------------

function page(title, user, body, refreshSec) {
  const lang = langOK(user.lang);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}
<title>${esc(title)} - Axle</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f5f5f4; color: #1c1917; }
  header { background: #1c1917; color: #fafaf9; padding: 10px 16px; display: flex; gap: 16px; align-items: baseline; }
  header .brand { font-weight: 700; font-size: 18px; }
  header .who { margin-left: auto; font-size: 13px; opacity: .8; display: flex; align-items: baseline; gap: 12px; }
  header a { color: #fafaf9; text-decoration: none; }
  .langtoggle a { opacity: .55; padding: 0 2px; font-weight: 600; }
  .langtoggle a.on { opacity: 1; text-decoration: underline; }
  .langtoggle .sep { opacity: .4; }
  main { padding: 16px; max-width: 1100px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e7e5e4; }
  th { background: #fafaf9; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr.rowlink:hover { background: #fef9c3; cursor: pointer; }
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { background: #f5f5f4; color: #1c1917; }
  th .arrow { font-size: 10px; color: #57534e; margin-left: 2px; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .s-ready { background: #dcfce7; color: #166534; }
  .s-awaiting_input { background: #fef3c7; color: #92400e; }
  .s-investigating { background: #dbeafe; color: #1e40af; }
  .s-new { background: #e7e5e4; color: #44403c; }
  .s-done, .s-archived { background: #f5f5f4; color: #a8a29e; }
  .inj { background: #fee2e2; color: #991b1b; }
  .chip.sugg { background: #eef2ff; color: #3730a3; font-weight: 600; }
  .k-blocking { background: #fef3c7; color: #92400e; }
  .k-physical { background: #dbeafe; color: #1e40af; }
  .p1 { color: #b91c1c; font-weight: 700; }
  .p3 { color: #a8a29e; }
  .filters { margin-bottom: 14px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .fgroup { display: inline-flex; align-items: center; }
  .flabel { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #78716c; font-weight: 700; margin-right: 8px; }
  .seg { padding: 5px 11px; font-size: 13px; color: #44403c; text-decoration: none; border: 1px solid #d6d3d1; border-radius: 6px; margin-right: 6px; background: #fff; }
  .seg:last-child { margin-right: 0; }
  .seg:hover { border-color: #a8a29e; }
  .seg.on { background: #1c1917; color: #fafaf9; border-color: #1c1917; }
  .filters .spacer { flex: 1 1 auto; }
  .syncform { display: inline-flex; align-items: center; gap: 8px; }
  .syncform button[disabled] { opacity: .6; cursor: default; }
  .syncform .synced { font-size: 12px; }
  input[type=search] { font-size: 14px; padding: 6px 10px; border: 1px solid #a8a29e; border-radius: 6px; min-width: 220px; }
  .qcount { font-size: 13px; color: #78716c; margin-left: 8px; min-width: 80px; }
  mark.hit { background: #fde047; padding: 0; }
  .boxhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .boxhead h3 { margin: 0 0 8px; }
  .muted { color: #78716c; }
  .box { background: #fff; border: 1px solid #e7e5e4; border-radius: 6px; padding: 12px 14px; margin: 12px 0; }
  .box h3 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: .03em; color: #57534e; }
  .trbox { background: #f8fafc; border-color: #dbeafe; border-left: 3px solid #93c5fd; }
  .trbox h3 { color: #1e40af; }
  .trnote { margin: 0 0 8px; font-size: 13px; }
  pre.mail { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 14px; margin: 0; }
  textarea.draft { width: 100%; min-height: 220px; font-family: inherit; font-size: 14px; padding: 8px; box-sizing: border-box; }
  #replybox { min-height: 240px; border: 2px solid #166534; border-radius: 6px; background: #fff; }
  .airef textarea.draft { min-height: 120px; background: #fafaf9; color: #57534e; }
  button.mini { font-size: 12px; padding: 3px 9px; }
  button.warn { border-color: #b45309; color: #92400e; }
  .suggrow { padding: 3px 0; font-size: 14px; }
  .suggrow .muted { font-size: 13px; }
  .attitem { padding: 4px 0; font-size: 14px; }
  .cfopt { display: block; margin: 4px 0; font-size: 14px; }
  .cfpick { margin: 6px 0 0; }
  .cfsubj { width: 100%; padding: 7px 9px; font-size: 14px; box-sizing: border-box; }
  .attnote { margin: 8px 0 6px; }
  input[type=file] { font-size: 13px; }
  .attzone.drag { outline: 2px dashed #166534; outline-offset: -4px; background: #f0fdf4; }
  .replytr { margin-top: 10px; padding: 10px 12px; }
  .replytr .trbody { color: #1e40af; }
  textarea.ans { width: 100%; min-height: 44px; font-family: inherit; font-size: 14px; padding: 6px; box-sizing: border-box; margin-top: 4px; }
  ul.qs { margin: 0; padding-left: 0; list-style: none; }
  ul.qs li { padding: 8px 0; border-bottom: 1px dashed #e7e5e4; }
  button { font-size: 14px; padding: 8px 14px; border-radius: 6px; border: 1px solid #a8a29e; background: #fff; cursor: pointer; }
  button.primary { background: #1c1917; color: #fafaf9; border-color: #1c1917; }
  button.send { background: #166534; border-color: #166534; }
  .sent { color: #166534; font-weight: 600; }
  .actions form { display: inline; margin-right: 8px; }
  .banner { background: #dbeafe; color: #1e40af; padding: 10px 14px; border-radius: 6px; margin: 12px 0; font-weight: 600; }
  details summary { cursor: pointer; color: #57534e; }
  .attrow { margin: 10px 0 0; padding-top: 10px; border-top: 1px dashed #e7e5e4; }
  a.att { margin-right: 16px; text-decoration: none; }
  a.att:hover { text-decoration: underline; }
  /* Compose ("New email") button + modal */
  .compose-open { background: #166534; color: #fafaf9; border-color: #166534; font-weight: 600; }
  .compose-open:hover { background: #14532d; border-color: #14532d; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; z-index: 50; padding: 24px; overflow: auto; }
  .modal-card { background: #fff; border-radius: 10px; width: 100%; max-width: 680px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #e7e5e4; }
  .modal-head h2 { margin: 0; font-size: 18px; }
  .modal-x { border: none; background: none; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 6px; color: #57534e; }
  .modal form { padding: 16px 18px; }
  .fld { display: block; margin: 0 0 14px; }
  .fld > span { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #78716c; font-weight: 700; margin-bottom: 5px; }
  .fld input[type=text], .fld textarea, .fld select { width: 100%; font-family: inherit; font-size: 14px; padding: 8px; box-sizing: border-box; border: 1px solid #a8a29e; border-radius: 6px; }
  .fld textarea { min-height: 120px; }
  .whorow { display: flex; gap: 8px; } .whorow input { flex: 1; }
  .fldrow { display: flex; gap: 14px; } .fldrow .fld { flex: 1; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .schip { padding: 5px 10px; font-size: 13px; border: 1px solid #d6d3d1; border-radius: 14px; background: #fff; cursor: pointer; }
  .schip.on { background: #1c1917; color: #fafaf9; border-color: #1c1917; }
  .resolvebox { border: 1px solid #dbeafe; background: #f8fafc; border-radius: 6px; padding: 10px 12px; margin: 0 0 14px; font-size: 14px; }
  .resolvebox .rok { color: #166534; font-weight: 600; }
  .resolvebox .rwarn { color: #92400e; }
  .resolvebox .rbad { color: #991b1b; }
  .resolvebox label { display: block; padding: 3px 0; cursor: pointer; }
  .resolvebox label.cand { display: flex; align-items: flex-start; gap: 8px; padding: 6px 6px; border-radius: 5px; }
  .resolvebox label.cand:hover { background: #eff6ff; }
  .cand-body { display: flex; flex-direction: column; line-height: 1.4; min-width: 0; }
  .cand-l1 { word-break: break-word; }
  .cand-l2 { font-size: 13px; word-break: break-word; }
  .cand-r { font-size: 12px; margin-top: 1px; }
  .modal-foot { display: flex; align-items: center; gap: 10px; border-top: 1px solid #e7e5e4; padding-top: 14px; }
  .modal-foot .spacer { flex: 1; }
  .cmpatt { padding: 3px 0; font-size: 14px; }
  .instr-editor { min-height: 92px; max-height: 240px; overflow-y: auto; border: 1px solid #d6d3d1; border-radius: 6px; padding: 8px 10px; font: inherit; font-size: 14px; line-height: 1.5; background: #fff; white-space: pre-wrap; }
  .instr-editor:focus { outline: none; border-color: #93c5fd; box-shadow: 0 0 0 2px #dbeafe; }
  .instr-editor:empty:before { content: attr(data-ph); color: #a8a29e; }
  .instr-editor .lbl { font-weight: 700; }
  .instr-editor .hint { color: #57534e; font-style: italic; }
</style></head><body>
<header><span class="brand">Axle</span><a href="/">${esc(t(lang, "inbox"))}</a><a href="/blocks">${esc(t(lang, "nav_blocks"))}</a>${user.role === "admin" ? `<a href="/audit">${esc(t(lang, "audit"))}</a>` : ""}
<span class="who"><span class="langtoggle"><a class="${lang === "en" ? "on" : ""}" href="/setlang?lang=en">EN</a><span class="sep">/</span><a class="${lang === "nl" ? "on" : ""}" href="/setlang?lang=nl">NL</a></span><span>${esc(user.display_name)} (${esc(user.role)})</span></span></header>
<main>${body}</main></body></html>`;
}

const app = express();
// Limit raised so an attachment (browser-encoded to base64 in a hidden field) fits in a
// normal form post — no multipart/dependency needed. Per-file cap is enforced separately.
app.use(express.urlencoded({ extended: false, limit: "16mb" }));

const MAX_ATTACH_BYTES = 3 * 1024 * 1024;       // 3 MB per file (Graph inline-attachment headroom)
const MAX_ATTACH_TOTAL = 3 * 1024 * 1024;       // 3 MB total across an item's attachments

// Identity from Tailscale Serve headers. No header = request didn't come through Serve.
app.use((req, res, next) => {
  const login = String(req.headers["tailscale-user-login"] || "");
  if (!login) {
    audit("system", "no_identity_header", null, `direct request from ${req.socket.remoteAddress}`);
    return res.status(403).send("<h1>Forbidden</h1><p>Axle must be accessed via its tailnet HTTPS address.</p>");
  }
  const user = db.prepare("SELECT * FROM users WHERE tailscale_login = ?").get(login);
  if (!user) {
    audit(login, "access_denied", null, "unregistered tailnet user");
    return res.status(403).send(`<h1>Not registered</h1><p>Tailnet identity <b>${esc(login)}</b> is not registered in Axle. Ask Brad to add you.</p>`);
  }
  req.user = user;
  req.user.lang = langOK(getCookie(req, "axle_lang")); // per-browser UI language (header toggle)
  next();
});

// CSRF hardening (opt-in, off until Brad sets the env). Auth is via the Serve-injected
// Tailscale-User-Login header rather than a cookie, so SameSite gives no protection: a malicious
// website could drive a tailnet user's browser to POST here and the Serve proxy would still attach
// that user's identity. When AXLE_ALLOWED_ORIGIN is set (e.g. https://axle.<tailnet>.ts.net), any
// state-changing request whose Origin/Referer is a DIFFERENT origin is rejected. Left a no-op until
// the env is set, so it can never lock the team out before the exact Serve origin is confirmed.
const ALLOWED_ORIGIN = process.env.AXLE_ALLOWED_ORIGIN || "";
app.use((req, res, next) => {
  if (!ALLOWED_ORIGIN || req.method === "GET" || req.method === "HEAD") return next();
  const src = req.headers.origin || req.headers.referer || "";
  let ok = !src;                                      // no Origin/Referer (non-browser tooling) — allowed
  if (src) { try { ok = new URL(src).origin === ALLOWED_ORIGIN; } catch (e) { ok = false; } }
  if (!ok) {
    audit(req.user.tailscale_login, "csrf_blocked", null, `${req.method} ${req.path} origin=${String(src).slice(0, 80)}`);
    return res.status(403).send("<h1>Forbidden</h1><p>Cross-origin request blocked.</p>");
  }
  next();
});

// Language toggle: set the per-browser language cookie and return to the prior page.
app.get("/setlang", (req, res) => {
  const l = langOK(req.query.lang);
  res.setHeader("Set-Cookie", `axle_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax`);
  let back = "/";
  try { if (req.headers.referer) { const u = new URL(req.headers.referer); back = u.pathname + u.search; } } catch (e) { /* ignore */ }
  if (!back.startsWith("/")) back = "/";
  audit(req.user.tailscale_login, "set_language", null, l);
  res.redirect(back);
});

// Manual "Sync now": run the info@ ingest IN-PROCESS in the background. Same watermark path as
// the scheduled task -- it ingests every email new since the last sync (drachten@ stays off until
// that team is given access). Holding the lock in the server process (with a guaranteed release in
// finally) means the button and "last synced" always update; a server restart mid-sync is healed
// by the startup reset above. Acquiring the same lock as the scheduled task ensures no overlap.
function startSync(login) {
  if (!acquireSync("manual:" + login)) return false; // already running (scheduled or manual)
  audit(login, "manual_sync", null, "started");
  setImmediate(async () => {
    try {
      await INGEST.runBoxes(["info"]);
      audit(login, "manual_sync_done", null, null);
    } catch (e) {
      audit(login, "manual_sync_error", null, e.message.slice(0, 200));
    } finally {
      releaseSync();
    }
  });
  return true;
}
app.post("/sync", (req, res) => {
  startSync(req.user.tailscale_login);
  res.redirect("/?synced=1");
});

function persistResult(itemId, result, toolLog, seed) {
  const status = result.status === "ready" ? "ready"
    : result.status === "no_reply" ? "done"   // conversation closed - no reply warranted
    : "awaiting_input";
  // A fresh AI draft supersedes any earlier human edit - clear draft_edit so the new draft shows.
  db.prepare(
    `UPDATE work_items SET status = ?, confidence = ?, brief_md = ?, draft_edit = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(status, result.confidence, [
    `## Investigation (${toolLog.length} tool calls)`,
    toolLog.map((t) => `- ${t.ok ? "OK" : "FAIL"} ${t.tool} - ${t.purpose}\n  ${t.input.replace(/\s+/g, " ").slice(0, 160)}`).join("\n") || "- none",
    "",
    "## Seed context",
    "```json",
    JSON.stringify(seed, null, 2),
    "```",
  ].join("\n"), itemId);
  const ver = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE work_item_id = ?").get(itemId).v || 0) + 1;
  if (result.draft) db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 0, ?)").run(itemId, ver, result.draft);
  if (result.interim_draft) db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 1, ?)").run(itemId, ver, result.interim_draft);
  db.prepare("DELETE FROM questions WHERE work_item_id = ? AND answer IS NULL").run(itemId);
  const insQ = db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, ?, ?)");
  for (const q of result.questions_for_salesperson || []) insQ.run(itemId, "blocking", q);
  for (const q of result.physical_checks || []) insQ.run(itemId, "physical", q);
  return { status, ver };
}

async function runRedraft(itemId, login) {
  try {
    const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId);

    // Compose redraft (origin='compose'): re-run COMPOSE mode instead of the inbound reply path.
    // The resolved customer is rebuilt from the stored, address-free compose_customer; the
    // recipient stays CODE-HELD from w.recipient and is never re-derived by the model. Answered
    // questions and feedback are TRUSTED staff input, so they are folded into the salesperson
    // instruction (the trusted block) - never into the untrusted customer-reference data.
    if (w.origin === "compose") {
      const customer = JSON.parse(w.compose_customer || "null");
      const resolved = { customer, identifier: customer && customer.matched_via ? { type: customer.matched_via } : null };
      const answered = db.prepare("SELECT question, answer FROM questions WHERE work_item_id = ? AND answer IS NOT NULL").all(itemId);
      let taskPrompt = String(w.compose_instruction || "");
      if (answered.length) {
        taskPrompt += "\n\nAnswers to your earlier questions (trusted input from our salesperson):\n"
          + answered.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n");
      }
      if (w.feedback && w.feedback.trim()) {
        taskPrompt += "\n\nFurther guidance from our salesperson (trusted): " + w.feedback.trim();
      }
      const { result, toolLog, seed } = await COMPOSE.composeDraft(anthropic, {
        resolved, taskPrompt, scenario: SCEN.forModel(w.scenario),
        language: w.language, mailbox: MAILBOX_OF[w.mailbox], recipient: w.recipient,
      });
      const { status, ver } = persistResult(itemId, result, toolLog, seed);
      const subj = (result.subject || "").trim();
      db.prepare("UPDATE work_items SET injection_flag = ?, subject = COALESCE(NULLIF(?, ''), subject), updated_at = datetime('now') WHERE id = ?")
        .run(result.injection_suspected ? 1 : 0, subj, itemId);
      audit(login, "compose_redraft_done", itemId, `status=${status} v=${ver} tools=${toolLog.length} inj=${result.injection_suspected ? 1 : 0}`);
      return;
    }

    const answered = db.prepare("SELECT kind, question, answer, answered_by FROM questions WHERE work_item_id = ? AND answer IS NOT NULL").all(itemId);
    const email = {
      id: w.latest_message_id,
      from: { address: w.sender_email, name: w.sender_name || "" },
      subject: w.subject || "", received: w.email_received || "", text: w.email_text || "",
    };
    const seed = await E.gatherSeed(email, []);
    seed.salesperson_answers = {
      note: "TRUSTED input from our own staff via the Axle tool - these override anything the email claims",
      answers: answered,
    };
    if (w.feedback) seed.salesperson_feedback = {
      note: "TRUSTED freeform guidance from our staff - follow it",
      text: w.feedback,
    };
    if (w.caller_info) seed.caller_match = w.caller_info;
    const { result, toolLog } = await E.agenticDraft(anthropic, email, [], seed, MAILBOX_OF[w.mailbox]);
    const { status, ver } = persistResult(itemId, result, toolLog, seed);
    // Refresh suggested documents from the newest body + the model's referenced_documents hint
    // (read-only; same deterministic resolve+scope gate). Skipped for contact-form/flagged items.
    try {
      if (!isContactFormItem(w) && !w.injection_flag && !result.injection_suspected) {
        const sugg = await DOCSUGGEST.suggestForEmail(w.sender_email, w.email_text || "", { extraRefs: result.referenced_documents || [] });
        db.prepare("UPDATE work_items SET doc_suggestions_json = ? WHERE id = ?").run(JSON.stringify(sugg), itemId);
      } else {
        db.prepare("UPDATE work_items SET doc_suggestions_json = NULL WHERE id = ?").run(itemId);
      }
    } catch (e) { audit(login, "suggest_error", itemId, String(e.message || e).slice(0, 150)); }
    audit(login, "redraft_done", itemId, `status=${status} v=${ver} tools=${toolLog.length}`);
  } catch (e) {
    db.prepare("UPDATE work_items SET status = 'awaiting_input', updated_at = datetime('now') WHERE id = ?").run(itemId);
    audit(login, "redraft_failed", itemId, e.message.slice(0, 200));
  }
}

// Mark the inbound email read in the shared mailbox (on send / done / archive).
// No-op-safe: if Mail.ReadWrite isn't granted yet, it logs a skip and changes nothing.
async function markReadSafe(login, w) {
  const r = await SEND.markRead(MAILBOX_OF[w.mailbox], w.latest_message_id);
  audit(login, "mark_read", w.id, r.ok ? "ok" : "skipped: " + r.reason);
}

// --- Compose ("New email") helpers ---------------------------------------------
// Default send-from mailbox follows the composer's location: Drachten staff -> drachten@,
// everyone else -> info@. Always overridable in the modal; admin@ is never an option.
function defaultMailbox(user) {
  return String(user.owner_label || "").toLowerCase() === "drachten" ? "drachten" : "info";
}
// A compose work item has no inbound thread, so its conversation_key is synthetic and unique
// (satisfies UNIQUE(mailbox, conversation_key)). Step 5 will consolidate a customer's reply
// onto the item by (recipient, normalised subject) + the stored sent message-id, not this key.
function composeConvKey() {
  return "compose:" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Inbox.
app.get("/", async (req, res) => {
  const lang = req.user.lang;
  const mb = ["info", "drachten"].includes(req.query.mailbox) ? req.query.mailbox : "all";
  const show = ["open", "done", "archived", "all"].includes(req.query.show) ? req.query.show : "open";
  // Scope: "mine" shows only items routed to this user (owner label); "all" shows everything.
  // Sales default to their own queue; admins default to all for oversight. Either can toggle.
  const scope = ["mine", "all"].includes(req.query.scope) ? req.query.scope
    : (req.user.role === "admin" ? "all" : "mine");
  const myOwner = req.user.owner_label || req.user.display_name;
  const statusCond = show === "open" ? "w.status NOT IN ('done','archived')"
    : show === "done" ? "w.status = 'done'"
    : show === "archived" ? "w.status = 'archived'"
    : "1=1";
  const conds = [statusCond];
  const params = [];
  if (mb !== "all") { conds.push("w.mailbox = ?"); params.push(mb); }
  if (scope === "mine") { conds.push("w.owner = ?"); params.push(myOwner); }
  // Open work is prioritised (injection first); completed views are newest-first.
  const order = show === "open"
    ? " ORDER BY w.injection_flag DESC, w.priority ASC, w.updated_at DESC"
    : " ORDER BY w.updated_at DESC";
  const items = db.prepare(
    `SELECT w.*, (SELECT COUNT(*) FROM questions q WHERE q.work_item_id = w.id AND q.answer IS NULL) AS open_q
     FROM work_items w WHERE ${conds.join(" AND ")}${order}`
  ).all(...params);
  audit(req.user.tailscale_login, "view_inbox", null, `mailbox=${mb} scope=${scope} show=${show} items=${items.length} lang=${lang}`);
  const investigating = items.some((w) => w.status === "investigating");
  const sync = syncStatus();
  // Axle authors summaries in English; translate into the viewer's language (cached).
  const sumTr = {};
  if (lang !== "en") {
    await Promise.all(items.map(async (w) => {
      if (w.summary) { try { sumTr[w.id] = await TR.translate(anthropic, lang, w.summary); } catch (e) { /* fall back to English */ } }
    }));
  }
  const sumOf = (w) => (lang !== "en" && sumTr[w.id]) || w.summary || "";
  // Auto-attach inbox hint: a paperclip when the item has attachable (in-scope/ambiguous) suggested
  // documents. Out-of-scope-only items show nothing here (they need an explicit confirm anyway).
  const suggHint = (w) => {
    if (!w.doc_suggestions_json || w.injection_flag) return "";
    let n = 0;
    try { n = (JSON.parse(w.doc_suggestions_json) || []).filter((s) => s.status === "in_scope" || s.status === "ambiguous").length; }
    catch (e) { return ""; }
    return n ? ` <span class="chip sugg" title="${esc(t(lang, "sugg_title"))}">&#128206;${n}</span>` : "";
  };
  const mbLink = (v, label) => `<a class="seg${mb === v ? " on" : ""}" href="/?mailbox=${v}&show=${show}&scope=${scope}">${label}</a>`;
  const showLink = (v, label) => `<a class="seg${show === v ? " on" : ""}" href="/?mailbox=${mb}&show=${v}&scope=${scope}">${label}</a>`;
  const scopeLink = (v, label) => `<a class="seg${scope === v ? " on" : ""}" href="/?mailbox=${mb}&show=${show}&scope=${v}">${label}</a>`;
  const searchable = (w) => [
    "#" + w.id, statusLabel(lang, w.status), w.mailbox, w.sender_name, w.sender_email, w.subject,
    sumOf(w), w.summary, intentLabel(lang, w.intent), ownerLabel(w), w.rule_id, w.email_text,
  ].filter(Boolean).join(" ").toLowerCase();
  const rows = items.map((w) => `
    <tr class="rowlink" data-search="${esc(searchable(w))}" onclick="location.href='/item/${w.id}'">
      <td data-sort="${w.id}">${w.id}</td>
      <td data-sort="${esc(statusWithRes(lang, w))}"><span class="chip s-${esc(w.status)}">${esc(statusWithRes(lang, w))}</span>${w.injection_flag ? ` <span class="chip inj">${esc(t(lang, "check"))}</span>` : ""}</td>
      <td class="p${w.priority || 2}" data-sort="${w.priority || 2}">P${w.priority || 2}</td>
      <td data-sort="${esc(w.mailbox)}">${esc(w.mailbox)}@</td>
      <td data-sort="${esc(w.sender_name || w.sender_email)}">${esc(w.sender_name || w.sender_email)}<br><span class="muted">${esc(w.sender_email)}</span>${w.caller_info ? `<br><span class="muted">&#128222; ${esc(w.caller_info)}</span>` : ""}</td>
      <td data-sort="${esc(w.subject || "")}">${w.origin === "compose" ? "&#9998; " : ""}${esc((w.subject || t(lang, "no_subject")).slice(0, 60))}${suggHint(w)}<br><span class="muted">${esc(sumOf(w).slice(0, 80))}</span></td>
      <td data-sort="${esc(intentLabel(lang, w.intent))}">${esc(intentLabel(lang, w.intent))}</td>
      <td data-sort="${esc(ownerLabel(w))}">${esc(ownerLabel(w))}</td>
      <td data-sort="${w.open_q || 0}">${w.open_q || ""}</td>
      <td class="muted" data-sort="${esc(w.updated_at || "")}">${esc(fmtDateTime(w.updated_at, lang))}</td>
    </tr>`).join("");
  const lastSync = sync.finished_at ? fmtDateTime(sync.finished_at, lang) : t(lang, "never");

  // --- Compose modal (built once per inbox render) ---
  const defMb = defaultMailbox(req.user);
  const scenList = SCEN.chips(lang);                       // [{key,label,skeleton}]
  const scenChipsHtml = scenList.map((s) => `<button type="button" class="schip" data-key="${esc(s.key)}">${esc(s.label)}</button>`).join("");
  const scenSkeletons = {}; scenList.forEach((s) => { scenSkeletons[s.key] = s.skeleton; });
  // UI strings the client script needs — JSON-encoded so quotes/encoding can never break the JS.
  const L = JSON.stringify({
    to: t(lang, "compose_to"), pick_address: t(lang, "compose_pick_address"), pick_customer: t(lang, "compose_pick_customer"),
    not_found: t(lang, "compose_not_found"), guest: t(lang, "compose_guest"), frozen: t(lang, "compose_frozen"),
    finding: t(lang, "compose_finding"), need_instr: t(lang, "compose_need_who_instr"), need_pick: t(lang, "compose_need_pick"),
    no_att: t(lang, "no_attachments"), remove: t(lang, "remove"), file_big: t(lang, "file_too_big"),
    att_total: t(lang, "attach_total"), creating: t(lang, "compose_creating"),
  });
  const composeUi = `
    <div id="composeModal" class="modal" style="display:none" role="dialog" aria-modal="true">
      <div class="modal-card">
        <div class="modal-head"><h2>${esc(t(lang, "compose_title"))}</h2>
          <button type="button" class="modal-x" id="composeClose" aria-label="Close">&times;</button></div>
        <form method="post" action="/compose" id="composeForm" autocomplete="off">
          <label class="fld"><span>${esc(t(lang, "compose_who"))}</span>
            <div class="whorow">
              <input type="text" name="who" id="who" placeholder="${esc(t(lang, "compose_who_ph"))}">
              <button type="button" class="mini" id="findBtn">${esc(t(lang, "compose_find"))}</button>
            </div></label>
          <div id="resolveBox" class="resolvebox" style="display:none"></div>
          <input type="hidden" name="pick_card" id="pick_card">
          <input type="hidden" name="pick_addr" id="pick_addr">
          <label class="fld"><span>${esc(t(lang, "compose_scenario"))}</span>
            <div class="chips" id="scenchips">${scenChipsHtml}</div></label>
          <input type="hidden" name="scenario" id="scenario">
          <label class="fld"><span>${esc(t(lang, "compose_instruction"))}</span>
            <div id="instrEditor" class="instr-editor" contenteditable="true" role="textbox" aria-multiline="true" data-ph="${esc(t(lang, "compose_instruction_ph"))}"></div>
            <textarea name="instruction" id="instruction" style="display:none"></textarea></label>
          <div class="fldrow">
            <label class="fld"><span>${esc(t(lang, "compose_language"))}</span>
              <select name="language" id="clang">
                <option value="auto">${esc(t(lang, "compose_lang_auto"))}</option>
                <option value="en">EN</option><option value="nl">NL</option>
                <option value="de">DE</option><option value="fr">FR</option><option value="es">ES</option>
              </select></label>
            <label class="fld"><span>${esc(t(lang, "compose_from"))}</span>
              <select name="mailbox" id="cmailbox">
                <option value="info"${defMb === "info" ? " selected" : ""}>info@</option>
                <option value="drachten"${defMb === "drachten" ? " selected" : ""}>drachten@</option>
              </select></label>
          </div>
          <label class="fld"><span>${esc(t(lang, "attachments"))}</span>
            <div class="attzone" id="cmpAttzone">
              <div id="cmpAttlist" class="muted">${esc(t(lang, "no_attachments"))}</div>
              <p class="muted attnote">${esc(t(lang, "attach_hint"))} ${esc(t(lang, "drop_hint"))}. ${esc(t(lang, "paste_hint"))}</p>
              <input type="file" id="cmpFile" multiple>
            </div></label>
          <div id="cmpAttHidden"></div>
          <div class="modal-foot">${!ACTION_COMPOSE_SEND ? `<span class="muted">${esc(t(lang, "compose_draft_only"))}</span>` : ""}
            <span class="spacer"></span>
            <button type="button" id="composeCancel">${esc(t(lang, "compose_cancel"))}</button>
            <button type="submit" class="primary" id="composeSubmit">${esc(t(lang, "compose_create"))}</button>
          </div>
        </form>
      </div>
    </div>
    <script>
    (function () {
      var modal = document.getElementById("composeModal");
      if (!modal) return;
      var L = ${L}, SKEL = ${JSON.stringify(scenSkeletons)};
      var SKELSET = Object.keys(SKEL).map(function (k) { return SKEL[k]; });
      var MAX = ${MAX_ATTACH_BYTES}, MAXTOT = ${MAX_ATTACH_TOTAL}, staged = [];
      var $ = function (id) { return document.getElementById(id); };
      function openM() { modal.style.display = "flex"; $("who").focus(); }
      function closeM() { modal.style.display = "none"; }
      $("composeBtn").addEventListener("click", openM);
      $("composeClose").addEventListener("click", closeM);
      $("composeCancel").addEventListener("click", closeM);
      // Close only on an explicit action (X / Cancel / Esc). Deliberately NOT on a backdrop/outside
      // click - a drag-to-select inside the form that releases outside the card must never dismiss it.
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal.style.display !== "none") closeM(); });
      function esc2(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

      // Rich instruction editor: render the scenario skeleton with bold frame labels ("Situation:")
      // and subtle italic guidance, so a paragraph reads as a fill-in-the-blanks form. The submitted
      // value is always the plain text (innerText) mirrored into the hidden #instruction field.
      function fmtSkeleton(sk) {
        var NL = String.fromCharCode(10);
        return String(sk).split(NL).map(function (line) {
          var i = line.indexOf(":");
          if (i > 0 && i <= 22) return '<div><span class="lbl">' + esc2(line.slice(0, i + 1)) + '</span><span class="hint">' + esc2(line.slice(i + 1)) + "</span></div>";
          return "<div>" + (line ? esc2(line) : "<br>") + "</div>";
        }).join("");
      }
      function syncInstr() { var ed = $("instrEditor"); if (ed) $("instruction").value = ed.innerText; }
      (function () {
        var ed = $("instrEditor"); if (!ed) return;
        ed.addEventListener("input", syncInstr);
        ed.addEventListener("paste", function (e) { e.preventDefault(); var t = ((e.clipboardData || window.clipboardData).getData("text") || ""); document.execCommand("insertText", false, t); });
      })();

      // Scenario chips: select tags the scenario + fills the instruction with a starter (only
      // when the box is empty or still holds another starter — never clobbers typed text).
      var chips = modal.querySelectorAll(".schip");
      chips.forEach(function (ch) {
        ch.addEventListener("click", function () {
          var wasOn = ch.classList.contains("on");
          chips.forEach(function (c) { c.classList.remove("on"); });
          var instr = $("instruction");
          if (wasOn) { $("scenario").value = ""; return; }
          ch.classList.add("on");
          $("scenario").value = ch.getAttribute("data-key");
          var sk = SKEL[ch.getAttribute("data-key")] || "";
          if (sk && (!instr.value.trim() || SKELSET.indexOf(instr.value) >= 0)) { $("instrEditor").innerHTML = fmtSkeleton(sk); syncInstr(); }
        });
      });

      // Recipient resolution (read-only). pick_addr is only ever set from a resolver address.
      function clearPick() { $("pick_card").value = ""; $("pick_addr").value = ""; }
      function setPick(card, addr) { $("pick_card").value = card || ""; $("pick_addr").value = addr || ""; }
      function addrRadios(name, addrs, card) {
        return addrs.map(function (a) {
          return '<label><input type="radio" name="' + name + '"' + (addrs.length === 1 ? " checked" : "") +
            ' value="' + esc2(a) + '" data-card="' + esc2(card || "") + '"> ' + esc2(a) + "</label>";
        }).join("");
      }
      function wirePicks() {
        modal.querySelectorAll('#resolveBox input[name=raddr]').forEach(function (r) {
          r.addEventListener("change", function () { setPick($("pick_card").value, r.value); });
        });
        modal.querySelectorAll('#resolveBox input[name=rcand]').forEach(function (r) {
          r.addEventListener("change", function () {
            setPick(r.getAttribute("data-card"), "");
            modal.querySelectorAll(".candaddr").forEach(function (b) { b.style.display = "none"; });
            var sub = $("cand_" + r.value);
            if (sub) { sub.style.display = "block"; var one = sub.querySelector("input[type=radio]"); if (one && sub.querySelectorAll("input").length === 1) { one.checked = true; setPick(r.getAttribute("data-card"), one.value); } }
          });
        });
        modal.querySelectorAll('#resolveBox input[name=caddr]').forEach(function (r) {
          r.addEventListener("change", function () { setPick(r.getAttribute("data-card"), r.value); });
        });
      }
      function renderResolve(d) {
        var box = $("resolveBox"); box.style.display = "block"; clearPick();
        if (d.error) { box.innerHTML = '<span class="rbad">' + esc2(d.error) + "</span>"; return; }
        if (d.resolved && d.customer) {
          var c = d.customer;
          var who = esc2(c.name || c.contactName || "") + (c.cardCode ? " (" + esc2(c.cardCode) + ")" : "") + (c.country ? " &middot; " + esc2(c.country) : "") + (c.contactName && c.contactName !== c.name ? " &middot; " + esc2(c.contactName) : "");
          var h = "";
          if (c.addresses.length <= 1) {
            setPick(c.cardCode, c.addresses[0] || "");
            h += '<div class="rok">&#10003; ' + esc2(L.to) + ": " + esc2(c.addresses[0] || "—") + "</div><div class=\\"muted\\">" + who + "</div>";
          } else {
            h += "<div>" + who + "</div><div class=\\"muted\\">" + esc2(L.pick_address) + "</div>" + addrRadios("raddr", c.addresses, c.cardCode);
            setPick(c.cardCode, "");
          }
          if (!c.knownAccount) h += '<div class="rwarn">' + esc2(L.guest) + "</div>";
          if (c.frozen) h += '<div class="rwarn">' + esc2(L.frozen) + "</div>";
          box.innerHTML = h; wirePicks(); return;
        }
        if (d.candidates && d.candidates.length) {
          var html = '<div class="muted">' + esc2(d.message || L.pick_customer) + "</div>";
          d.candidates.forEach(function (c, i) {
            var meta = esc2(c.cardCode || "") + (c.country ? " &middot; " + esc2(c.country) : "") + (c.frozen ? ' &middot; <span class="rwarn">frozen</span>' : "");
            var det = [];
            if (c.contactName && c.contactName !== c.name) det.push(esc2(c.contactName));
            if (c.email) det.push(esc2(c.email));
            html += '<label class="cand"><input type="radio" name="rcand" value="' + i + '" data-card="' + esc2(c.cardCode) + '">' +
              '<span class="cand-body">' +
                '<span class="cand-l1"><b>' + esc2(c.name || "—") + '</b> <span class="muted">&middot; ' + meta + "</span></span>" +
                (det.length ? '<span class="cand-l2 muted">' + det.join(" &middot; ") + "</span>" : "") +
                (c.reason ? '<span class="cand-r muted">— ' + esc2(c.reason) + "</span>" : "") +
              "</span></label>";
            html += '<div class="candaddr" id="cand_' + i + '" style="display:none;margin-left:26px">' +
              (c.addresses || []).map(function (a) { return '<label><input type="radio" name="caddr" value="' + esc2(a) + '" data-card="' + esc2(c.cardCode) + '"> ' + esc2(a) + "</label>"; }).join("") + "</div>";
          });
          box.innerHTML = html; wirePicks(); return;
        }
        box.innerHTML = '<span class="rwarn">' + esc2(d.message || L.not_found) + "</span>";
      }
      function doFind() {
        var who = $("who").value.trim(); if (!who) return;
        var box = $("resolveBox"); box.style.display = "block"; box.innerHTML = '<span class="muted">' + esc2(L.finding) + "</span>";
        fetch("/compose/resolve", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "who=" + encodeURIComponent(who) })
          .then(function (x) { return x.json(); }).then(renderResolve)
          .catch(function () { box.innerHTML = '<span class="rbad">(error)</span>'; });
      }
      $("findBtn").addEventListener("click", doFind);
      $("who").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doFind(); } });
      $("who").addEventListener("input", clearPick);

      // Attachments staged client-side (base64), injected as hidden inputs on submit.
      function renderAtts() {
        var list = $("cmpAttlist");
        if (!staged.length) { list.className = "muted"; list.textContent = L.no_att; return; }
        list.className = "";
        list.innerHTML = staged.map(function (f, i) {
          return '<div class="cmpatt">&#128206; ' + esc2(f.name) + ' <span class="muted">(' + Math.round(f.size / 1024) + ' KB)</span> <button type="button" class="mini" data-i="' + i + '">' + esc2(L.remove) + "</button></div>";
        }).join("");
        list.querySelectorAll("button[data-i]").forEach(function (b) {
          b.addEventListener("click", function () { staged.splice(+b.getAttribute("data-i"), 1); renderAtts(); });
        });
      }
      function addFiles(files) {
        var arr = [].slice.call(files);
        (function next(i) {
          if (i >= arr.length) { renderAtts(); return; }
          var f = arr[i];
          if (f.size > MAX) { alert(L.file_big); return next(i + 1); }
          var tot = staged.reduce(function (s, x) { return s + x.size; }, 0);
          if (tot + f.size > MAXTOT) { alert(L.att_total); return next(i + 1); }
          var rd = new FileReader();
          rd.onload = function () { staged.push({ name: f.name, ctype: f.type || "application/octet-stream", b64: String(rd.result).split(",")[1] || "", size: f.size }); next(i + 1); };
          rd.readAsDataURL(f);
        })(0);
      }
      $("cmpFile").addEventListener("change", function () { addFiles(this.files); this.value = ""; });
      var zone = $("cmpAttzone");
      ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
      zone.addEventListener("dragleave", function (e) { if (e.target === zone) zone.classList.remove("drag"); });
      zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("drag"); addFiles(e.dataTransfer.files); });

      // Paste-to-attach in the modal: an image on the clipboard (Win+Shift+S) is staged with
      // a single Ctrl+V anywhere in the modal. A paste that carries TEXT into a field stays a
      // text paste (the instruction editor's own handler above already inserts it).
      function pextOf(type) { var m = /^image\\/(png|jpe?g|gif|webp)/i.exec(type || ""); return m ? m[1].replace("jpeg", "jpg") : "png"; }
      modal.addEventListener("paste", function (e) {
        if (!e.clipboardData) return;
        var items = e.clipboardData.items || [], imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\\//i.test(items[i].type)) { var f = items[i].getAsFile(); if (f) imgs.push(f); }
        }
        if (!imgs.length) return;
        var tg = e.target, inField = tg && (tg.tagName === "TEXTAREA" || tg.tagName === "INPUT" || tg.isContentEditable);
        if (inField && (e.clipboardData.getData("text/plain") || "").length) return;
        e.preventDefault();
        var stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
        addFiles(imgs.map(function (f, i2) {
          return new File([f], "snippet-" + stamp + (imgs.length > 1 ? "-" + (i2 + 1) : "") + "." + pextOf(f.type), { type: f.type || "image/png" });
        }));
      });

      // Submit: require an instruction and a confirmed recipient; inject staged attachments.
      $("composeForm").addEventListener("submit", function (e) {
        syncInstr();
        if (!$("instruction").value.trim()) { e.preventDefault(); alert(L.need_instr); return; }
        if (!$("pick_addr").value) { e.preventDefault(); alert(L.need_pick); return; }
        var hid = $("cmpAttHidden"); hid.innerHTML = "";
        staged.forEach(function (f) {
          function add(n, v) { var i = document.createElement("input"); i.type = "hidden"; i.name = n; i.value = v; hid.appendChild(i); }
          add("att_name", f.name); add("att_ctype", f.ctype); add("att_data", f.b64);
        });
        $("composeSubmit").textContent = L.creating;
      });
    })();
    </script>`;

  const body = `
    ${req.query.synced ? `<div class="banner">${esc(t(lang, "sync_started"))}</div>` : ""}
    <div class="filters">
      <button type="button" class="seg compose-open" id="composeBtn">&#43; ${esc(t(lang, "compose_new"))}</button>
      <span class="fgroup"><span class="flabel">${esc(t(lang, "scope_label"))}</span>${scopeLink("mine", esc(t(lang, "scope_mine")))}${scopeLink("all", esc(t(lang, "all")))}</span>
      <span class="fgroup"><span class="flabel">${esc(t(lang, "mailbox"))}</span>${mbLink("all", esc(t(lang, "all")))}${mbLink("info", esc(t(lang, "info")))}${mbLink("drachten", esc(t(lang, "drachten")))}</span>
      <span class="fgroup"><span class="flabel">${esc(t(lang, "status"))}</span>${showLink("open", esc(t(lang, "open")))}${showLink("done", esc(t(lang, "done")))}${showLink("archived", esc(t(lang, "archived")))}${showLink("all", esc(t(lang, "all")))}</span>
      <span class="spacer"></span>
      <form method="post" action="/sync" class="syncform">
        <button class="seg" ${sync.running ? "disabled" : ""}>${sync.running ? `&#8635; ${esc(t(lang, "syncing"))}` : `&#8635; ${esc(t(lang, "sync_now"))}`}</button>
        <span class="muted synced">${esc(t(lang, "last_synced"))}: ${esc(lastSync)}</span>
      </form>
      <input id="q" type="search" placeholder="${esc(t(lang, "search_emails"))}" autocomplete="off"><span class="qcount" id="qcount"></span>
    </div>
    <table id="inbox"><thead><tr>
      <th class="sortable" data-col="0" data-type="num"># <span class="arrow"></span></th>
      <th class="sortable" data-col="1" data-type="text">${esc(t(lang, "col_status"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="2" data-type="num">${esc(t(lang, "col_prio"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="3" data-type="text">${esc(t(lang, "col_box"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="4" data-type="text">${esc(t(lang, "col_from"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="5" data-type="text">${esc(t(lang, "col_subject"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="6" data-type="text">${esc(t(lang, "col_intent"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="7" data-type="text">${esc(t(lang, "col_owner"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="8" data-type="num">${esc(t(lang, "col_open"))} <span class="arrow"></span></th>
      <th class="sortable" data-col="9" data-type="date">${esc(t(lang, "col_updated"))} <span class="arrow"></span></th>
    </tr></thead><tbody>
    ${rows || `<tr><td colspan="10" class="muted">${esc(t(lang, "no_items"))}${mb === "all" ? "" : " — " + esc(mb) + "@"}</td></tr>`}</tbody></table>
    <script>
    (function () {
      var q = document.getElementById("q"), c = document.getElementById("qcount");
      function apply() {
        var v = q.value.trim().toLowerCase(), n = 0;
        document.querySelectorAll("tr.rowlink").forEach(function (tr) {
          var show = !v || (tr.getAttribute("data-search") || "").indexOf(v) >= 0;
          tr.style.display = show ? "" : "none";
          if (show) n++;
        });
        c.textContent = v ? n + " ${t(lang, "of")} ${items.length}" : "";
        sessionStorage.setItem("axle_q", q.value);
      }
      q.addEventListener("input", apply);
      q.value = sessionStorage.getItem("axle_q") || "";
      if (q.value) apply();
    })();
    // Click a column header to sort; click again to reverse. Choice persists per tab.
    (function () {
      var table = document.getElementById("inbox");
      if (!table) return;
      var tbody = table.tBodies[0], ths = table.querySelectorAll("th.sortable");
      function applySort(th, dir) {
        var col = +th.getAttribute("data-col"), type = th.getAttribute("data-type") || "text";
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr.rowlink"));
        rows.sort(function (a, b) {
          var x = a.children[col].getAttribute("data-sort"), y = b.children[col].getAttribute("data-sort"), r;
          if (type === "num") r = (parseFloat(x) || 0) - (parseFloat(y) || 0);
          else if (type === "date") r = (Date.parse(x) || 0) - (Date.parse(y) || 0);
          else r = String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
          return dir === "desc" ? -r : r;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        ths.forEach(function (t) { t.removeAttribute("data-dir"); t.querySelector(".arrow").textContent = ""; });
        th.setAttribute("data-dir", dir);
        th.querySelector(".arrow").textContent = dir === "asc" ? "▲" : "▼";
        sessionStorage.setItem("axle_sort", JSON.stringify({ col: col, dir: dir }));
      }
      ths.forEach(function (th) {
        th.addEventListener("click", function () {
          applySort(th, th.getAttribute("data-dir") === "asc" ? "desc" : "asc");
        });
      });
      try {
        var s = JSON.parse(sessionStorage.getItem("axle_sort") || "null");
        if (s) { var th = table.querySelector('th.sortable[data-col="' + s.col + '"]'); if (th) applySort(th, s.dir || "asc"); }
      } catch (e) {}
    })();
    </script>
    ${composeUi}`;
  res.send(page("Inbox", req.user, body, sync.running ? 8 : investigating ? 15 : 0));
});

// --- Compose ("New email") -----------------------------------------------------
// Step 3: DRAFT-ONLY. Allow-list action #3 ("send new non-reply email") is OFF, so Compose
// researches + drafts + holds; it never sends. The recipient is produced ONLY by the
// deterministic resolver (resolve-customer.js) and re-validated here against a fresh
// resolution — no model output or free-typed value can set or redirect the To address.

// AJAX: resolve a customer identifier to a recipient (or candidates) for the modal. Read-only.
app.post("/compose/resolve", async (req, res) => {
  const who = String(req.body.who || "").trim();
  audit(req.user.tailscale_login, "compose_resolve", null, who.slice(0, 80));
  if (!who) return res.json({ resolved: false, candidates: [], message: "" });
  try {
    const r = await RESOLVE.resolveCustomer(who);
    if (r.resolved && r.customer) {
      const c = r.customer;
      return res.json({
        resolved: true, matched_via: r.matched_via, needsAddressPick: r.needsAddressPick, message: r.message,
        customer: {
          cardCode: c.cardCode, name: c.name, contactName: c.contactName || null, country: c.country,
          knownAccount: c.knownAccount, frozen: c.frozen, language_hint: c.language_hint,
          addresses: c.sendableAddresses || [], notes: c.notes || [],
        },
      });
    }
    if (r.candidates && r.candidates.length) {
      return res.json({
        resolved: false, message: r.message,
        candidates: r.candidates.map((c) => ({
          cardCode: c.cardCode, name: c.name, contactName: c.contactName || null,
          email: c.email || (c.sendableAddresses && c.sendableAddresses[0]) || null,
          addresses: c.sendableAddresses || (c.email ? [c.email] : []),
          country: c.country, frozen: c.frozen, reason: c.reason || null,
        })),
      });
    }
    return res.json({ resolved: false, candidates: [], message: r.message || t(req.user.lang, "compose_not_found") });
  } catch (e) {
    audit(req.user.tailscale_login, "compose_resolve_error", null, e.message.slice(0, 200));
    res.status(502).json({ resolved: false, error: e.message.slice(0, 200) });
  }
});

// Submit: resolve deterministically, validate the recipient came from the resolver, run
// compose-mode, persist an origin='compose' work item, and land on the detail page.
app.post("/compose", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const who = String(req.body.who || "").trim();
  const instruction = String(req.body.instruction || "").trim();
  const scenarioKey = (req.body.scenario && SCEN.byKey(req.body.scenario)) ? String(req.body.scenario) : null;
  const langSel = ["en", "nl", "de", "fr", "es"].includes(req.body.language) ? req.body.language : "auto";
  const mailbox = ["info", "drachten"].includes(req.body.mailbox) ? req.body.mailbox : defaultMailbox(req.user);
  const pickCard = String(req.body.pick_card || "").trim();
  const pickAddr = String(req.body.pick_addr || "").trim().toLowerCase();

  const fail = (msg) => res.status(400).send(page(t(lang, "compose_failed"), req.user,
    `<p><b>${esc(t(lang, "compose_failed"))}:</b> ${esc(msg)}</p><p><a href="&#47;">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));

  if (!who || !instruction) return fail(t(lang, "compose_need_who_instr"));

  // Resolve deterministically (read-only). The modal already showed this to the salesperson;
  // we re-resolve server-side so the recipient is authoritative, never a posted free-text value.
  let chosen, validAddrs;
  try {
    const r0 = await RESOLVE.resolveCustomer(who);
    if (r0.resolved && r0.customer) {
      chosen = r0; validAddrs = r0.customer.sendableAddresses || [];
    } else if (r0.candidates && r0.candidates.length && pickCard) {
      const rc = await RESOLVE.resolveCustomer(pickCard);     // disambiguate to the picked card
      if (rc.resolved && rc.customer) { chosen = rc; validAddrs = rc.customer.sendableAddresses || []; }
    }
  } catch (e) {
    audit(login, "compose_error", null, "resolve: " + e.message.slice(0, 180));
    return fail(e.message.slice(0, 200));
  }
  if (!chosen) return fail(t(lang, "compose_need_pick"));

  // SECURITY INVARIANT (the crown jewel): the recipient MUST be an address the resolver
  // produced. pickRecipient honours a posted pick_addr only if it is in that set (else rejects
  // with no fallback), or takes the sole address when nothing was picked. A tampered or
  // model-supplied address can never reach the To line.
  const recipient = RESOLVE.pickRecipient(validAddrs, pickAddr);
  if (!recipient) return fail(t(lang, "compose_need_pick"));

  const language = langSel === "auto" ? (chosen.customer.language_hint || "en") : langSel;

  // Persist immediately as origin='compose', status='investigating', then run the slow research +
  // draft in the BACKGROUND so the salesperson lands on the task at once (the detail page shows the
  // "investigating" banner and auto-refreshes) instead of waiting on a 30-60s hang. The draft is
  // produced by runRedraft's compose branch, which rebuilds everything from the stored item - the
  // sanitized customer carries NO address, and the recipient stays code-held in `recipient`.
  const modelCustomer = COMPOSE.sanitizeCustomerForModel(chosen.customer);
  const subject = scenarioKey ? SCEN.byKey(scenarioKey).label_en : "New email";   // provisional; the draft proposes the final one
  const itemId = db.prepare(
    "INSERT INTO work_items (mailbox, conversation_key, sender_email, sender_name, subject, language, intent, priority, status, origin, compose_instruction, compose_customer, recipient, scenario, owner) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'investigating', 'compose', ?, ?, ?, ?, ?)"
  ).run(
    mailbox, composeConvKey(), recipient, chosen.customer.name || chosen.customer.contactName || recipient,
    subject, language, scenarioKey, 2, instruction, JSON.stringify(modelCustomer), recipient, scenarioKey,
    req.user.owner_label || req.user.display_name
  ).lastInsertRowid;

  // Attachments staged in the modal (base64), capped per-file and per-item.
  const names = asArray(req.body.att_name), ctypes = asArray(req.body.att_ctype), datas = asArray(req.body.att_data);
  let total = 0, atts = 0;
  for (let i = 0; i < datas.length; i++) {
    const b64 = String(datas[i] || ""); if (!b64) continue;
    const size = Math.floor((b64.length * 3) / 4);
    if (size > MAX_ATTACH_BYTES || total + size > MAX_ATTACH_TOTAL) continue;
    total += size; atts++;
    db.prepare("INSERT INTO draft_attachments (work_item_id, name, content_type, size, content_b64, added_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(itemId, String(names[i] || "attachment").slice(0, 200), String(ctypes[i] || "application/octet-stream").slice(0, 100), size, b64, login);
  }

  audit(login, "compose_created", itemId,
    `via=${chosen.matched_via} mailbox=${mailbox}@ lang=${language} scenario=${scenarioKey || "-"} atts=${atts} (drafting in background)`);
  setImmediate(() => runRedraft(itemId, login));   // research + draft happen off the request path
  res.redirect("/item/" + itemId);
});

// Item detail.
// A webshop contact-form message (filed in info@'s "Shopify Contact Form" folder). The thread
// sender is Shopify's mailer, not the customer, so in-thread Send must stay disabled for these.
function isContactFormItem(w) {
  return w.rule_id === "shopify_form" || (w.sender_email || "").toLowerCase() === "mailer@shopify.com";
}

// A proposed subject for a contact-form reply (a NEW outbound, so no "Re:"). Order-ref-aware,
// in the customer's language. Deterministic default; the salesperson can edit it before sending.
// Proposed subject for a NEW outbound contact-form reply. Language follows the DRAFT
// (work_items.language = the customer's actual message language), NOT the country map
// (cf.language) — so an English draft never gets a Dutch subject. Order-ref wins when present.
function contactFormSubject(cf, draftLang) {
  const ref = cf && cf.parsed && cf.parsed.orderRef;
  if (ref) return `${ref} - RoverParts.eu`;
  return draftLang === "nl" ? "Uw bericht aan RoverParts.eu" : "Your message to RoverParts.eu";
}

// --- Auto-attach: suggested documents for an inbound item (READ-ONLY) -------------------
// Compute (Step 3) the SAP documents this email appears to reference and that belong to the
// email's customer, so the salesperson can one-click attach them instead of typing the number.
// This only READS SAP via the deterministic resolve+scope filter; it renders/stages NOTHING (the
// one-click reuses the existing /attach-doc route behind the approval gate). Safety: skip
// injection-flagged items entirely (surface nothing automatically), skip compose/contact-form
// (the feature is about inbound customer emails). A failure here must never break the item page.
//
// Lazy + cached by (item, latest inbound message). Step 4 moves this to ingest-time storage and
// adds the inbox hint + model hint; until then the cache keeps repeat views and auto-refresh cheap.
const _suggCache = new Map();   // key -> { suggestions }
async function computeItemSuggestions(w) {
  if (!w || w.origin === "compose" || isContactFormItem(w) || w.injection_flag) return { suggestions: [] };
  // Prefer the ingest-time stored result (instant; computed once when the email arrived).
  if (w.doc_suggestions_json != null) {
    try { return { suggestions: JSON.parse(w.doc_suggestions_json) || [] }; } catch (e) { /* fall through to lazy compute */ }
  }
  // Lazy fallback (older items ingested before this feature, or a transient ingest error): compute
  // once and cache per (item, latest inbound message). Same deterministic, read-only path as ingest.
  if (!w.sender_email || !w.email_text) return { suggestions: [] };
  const key = w.id + ":" + (w.latest_message_id || "");
  if (_suggCache.has(key)) return _suggCache.get(key);
  let out = { suggestions: [] };
  try { out = { suggestions: await DOCSUGGEST.suggestForEmail(w.sender_email, w.email_text, {}) }; }
  catch (e) { audit("system", "suggest_error", w.id, String(e.message || e).slice(0, 150)); }
  if (_suggCache.size >= 500) _suggCache.delete(_suggCache.keys().next().value); // bound memory (oldest-out)
  _suggCache.set(key, out);
  return out;
}

// Render the "Suggested documents" panel. in_scope -> one-click Attach; ambiguous -> a button per
// in-scope candidate (validated in-set by the route); out_of_scope -> a separate "different
// customer - review" area whose button hits /attach-doc WITHOUT confirm, so the existing
// scope-warn + attach-anyway (SCOPE-OVERRIDE audit) screen handles it. Every button posts to the
// proven /attach-doc route; this panel never renders or stages anything itself.
function suggestionsPanel(w, suggestions, lang) {
  if (!suggestions || !suggestions.length) return "";
  const docType = (objectId) => {
    for (const k of Object.keys(SAPDOC.DOC_TYPES)) if (SAPDOC.DOC_TYPES[k].objectId === objectId) return k;
    return "order";
  };
  const fmtDoc = (d) => {
    const date = d.docDate ? new Date(d.docDate).toISOString().slice(0, 10) : "";
    const money = (d.docTotal != null ? d.docTotal : "") + (d.docCur ? " " + d.docCur : "");
    return `${esc(String(d.type))} ${esc(String(d.docNum))} &middot; ${esc(d.cardName || d.cardCode || "")} &middot; ${esc(String(money))}${date ? " &middot; " + esc(date) : ""}`;
  };
  // A hidden form posting the resolved doc to /attach-doc. Keyed by DocNum (deterministic) +
  // DocEntry (so the route picks exactly this document from its own resolved set).
  const addForm = (d, label, cls) => `
    <form method="post" action="/item/${w.id}/attach-doc" style="margin:3px 0">
      <input type="hidden" name="doctype" value="${esc(docType(d.objectId))}">
      <input type="hidden" name="docnum" value="${esc(String(d.docNum))}">
      <input type="hidden" name="docentry" value="${esc(String(d.docEntry))}">
      <button class="${cls}">${esc(label)} &mdash; ${fmtDoc(d)}</button>
    </form>`;

  const inScope = suggestions.filter((s) => s.status === "in_scope" || s.status === "ambiguous");
  const offScope = suggestions.filter((s) => s.status === "out_of_scope");

  const inHtml = inScope.map((s) => {
    const ref = `<span class="muted">${esc(t(lang, "sugg_ref"))} "${esc(s.reference.raw)}"</span>`;
    if (s.status === "in_scope") return `<div class="suggrow">${addForm(s.docs[0], t(lang, "sugg_add"), "mini")} ${ref}</div>`;
    // ambiguous: a button per in-scope candidate
    return `<div class="suggrow"><p class="muted" style="margin:2px 0">${esc(t(lang, "sugg_pick"))} ${ref}</p>${s.docs.map((d) => addForm(d, t(lang, "sugg_add"), "mini")).join("")}</div>`;
  }).join("");

  const offHtml = offScope.length ? `
    <details style="margin-top:8px">
      <summary>${esc(t(lang, "sugg_other_cust"))} (${offScope.length})</summary>
      <p class="muted">${esc(t(lang, "sugg_other_cust_hint"))}</p>
      ${offScope.map((s) => `<div class="suggrow">${s.docs.map((d) => addForm(d, t(lang, "sugg_review"), "mini warn")).join("")} <span class="muted">${esc(t(lang, "sugg_ref"))} "${esc(s.reference.raw)}"</span></div>`).join("")}
    </details>` : "";

  return `<div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "sugg_title"))}</h3></div>
      <p class="muted">${esc(t(lang, "sugg_hint"))}</p>
      ${inHtml}${offHtml}
    </div>`;
}

app.get("/item/:id", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  audit(req.user.tailscale_login, "view_item", w.id, `lang=${lang}`);
  const isCompose = w.origin === "compose";   // a proactively-composed outbound item (no inbound email)
  const isContactForm = isContactFormItem(w);  // webshop contact-form msg: real recipient is in the body, not the sender

  // Contact-form enrichment (from ingest): parsed customer + candidate addresses. Parsed once
  // here so both the work form (subject) and the customer header below can use it.
  let cf = null;
  if (isContactForm) { try { cf = JSON.parse(w.contact_form_json || "null"); } catch (e) { cf = null; } }
  const cfSubjectDefault = isContactForm ? contactFormSubject(cf, w.language || lang) : "";

  // AI reference drafts (source='ai'); human-sent drafts are kept separately for the audit
  // trail and must not be shown as "the AI draft".
  const full = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 0 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);
  const interim = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 1 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);
  const latestVer = full ? full.version : (interim ? interim.version : 0);
  const questions = db.prepare("SELECT * FROM questions WHERE work_item_id = ? ORDER BY id").all(w.id);
  const open = questions.filter((q) => !q.answer);
  const busy = w.status === "investigating";
  const editable = !busy && !["done", "archived"].includes(w.status);
  const sentRow = db.prepare("SELECT * FROM sends WHERE work_item_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1").get(w.id);
  // Send is allowed any time the item isn't flagged (questions need not be answered first);
  // an injection-flagged item can NEVER send. The body is re-validated by send-guard on submit.
  // compose: action #3 OFF -> never a Send button. contact-form (action #4): the sender is
  // Shopify's mailer, not the customer, so a send is a NEW outbound to the code-held, confirmed
  // recipient - allowed only when action #4 is enabled AND a recipient has been confirmed.
  const cfCanSend = isContactForm && ACTION_CONTACTFORM_SEND && !!w.recipient;
  const composeCanSend = isCompose && ACTION_COMPOSE_SEND && !!w.recipient;
  const canSend = editable && !w.injection_flag && (!isCompose || composeCanSend) && (!isContactForm || cfCanSend);
  // The editable reply: the human's saved edit if any, else the AI full draft, else the holding reply.
  const replyText = w.draft_edit != null ? w.draft_edit : (full ? full.body : (interim ? interim.body : ""));
  const atts = db.prepare("SELECT id, name, content_type, size FROM draft_attachments WHERE work_item_id = ? ORDER BY id").all(w.id);

  // Auto-attach: SAP documents this inbound email references and that belong to its customer
  // (read-only; rendered/staged only when the human clicks Attach, via the existing /attach-doc
  // route). Skipped for compose/contact-form/injection-flagged items inside the helper.
  const suggBox = editable ? suggestionsPanel(w, (await computeItemSuggestions(w)).suggestions, lang) : "";

  // --- On-view translation into the viewer's language (cached; best-effort) -------
  // Customer content (email, draft) is translated only when its language differs from
  // the viewer's. Questions are authored in English, so translate only for non-EN viewers.
  const custLang = (w.language || "").toLowerCase();
  const needContent = custLang && custLang !== lang;
  const tr = async (text) => { try { return await TR.translate(anthropic, lang, text); } catch (e) { return null; } };
  let emailTr = null, draftTr = null, interimTr = null;
  if (needContent) {
    // Compose has no inbound email to translate; keep the draft/holding translation for a cross-language viewer.
    const top = isCompose ? "" : splitQuoted(String(w.email_text || "")).top;
    [emailTr, draftTr, interimTr] = await Promise.all([
      top.trim() ? tr(top) : null,
      full && full.body.trim() ? tr(full.body) : null,
      interim && interim.body.trim() ? tr(interim.body) : null,
    ]);
  }
  const qTr = {};
  if (lang !== "en") await Promise.all(questions.map(async (q) => { qTr[q.id] = await tr(q.question); }));
  const qText = (q) => (lang !== "en" && qTr[q.id]) || q.question;
  const langName = langDisplay(lang, custLang);
  // A labelled translation block (display-only). `note` explains why it's shown.
  const trBlock = (text, note) => text
    ? `<div class="box trbox"><h3>${esc(t(lang, "translation_heading"))}</h3>${note ? `<p class="muted trnote">${esc(note)}</p>` : ""}<pre class="mail">${linkify(String(text))}</pre></div>`
    : "";

  const scen = isCompose && w.scenario ? SCEN.byKey(w.scenario) : null;   // scenario chip for compose
  const chips = [
    isCompose ? `<span class="chip origin">${esc(t(lang, "compose_origin_chip"))}</span>` : "",
    isContactForm ? `<span class="chip origin">${esc(t(lang, "contactform_chip"))}</span>` : "",
    `<span class="chip s-${esc(w.status)}">${esc(statusWithRes(lang, w))}</span>`,
    `<span class="chip p${w.priority || 2}">${esc(t(lang, "priority"))} ${w.priority || 2}</span>`,
    w.injection_flag ? `<span class="chip inj">${esc(t(lang, "injection_chip"))}</span>` : "",
    isCompose
      ? (scen ? `<span class="chip">${esc(lang === "nl" ? scen.label_nl : scen.label_en)}</span>` : "")
      : `<span class="chip">${esc(intentLabel(lang, w.intent))}</span>`,
    `<span class="chip">${esc(t(lang, "language"))}: ${esc((w.language || "?").toUpperCase())}</span>`,
    w.confidence ? `<span class="chip">${esc(t(lang, "confidence"))}: ${esc(w.confidence)}</span>` : "",
    `<span class="chip">${esc(t(lang, "owner"))}: ${esc(ownerLabel(w))}</span>`,
  ].filter(Boolean).join(" ");

  const qItems = questions.map((q) => `
    <li><span class="chip k-${esc(q.kind)}">${esc(kindLabel(lang, q.kind))}</span> ${esc(qText(q))}
    ${q.answer
      ? `<br><b>${esc(t(lang, "answer"))}:</b> ${esc(q.answer)} <span class="muted">(${esc(q.answered_by)}, ${esc(fmtDateTime(q.answered_at, lang))})</span>`
      : editable
        ? `<textarea class="ans" name="answer_${q.id}" placeholder="${esc(t(lang, "answer_ph"))}"></textarea>`
        : `<br><span class="muted">${esc(t(lang, "unanswered"))}</span>`}</li>`).join("");

  const feedbackInner = editable
    ? `<textarea class="ans" name="feedback" placeholder="${esc(t(lang, "feedback_ph"))}">${esc(w.feedback || "")}</textarea>`
    : (w.feedback ? `<pre class="mail">${esc(w.feedback)}</pre>` : `<span class="muted">${esc(t(lang, "feedback_none"))}</span>`);
  const questionsInner = questions.length ? `<ul class="qs">${qItems}</ul>` : `<span class="muted">${esc(t(lang, "no_questions"))}</span>`;

  // AI reference blocks (read-only): the original AI draft / holding reply, kept visible and
  // in the audit trail. "Use this" copies one into the editable reply box. Their translations
  // (for a cross-language viewer) sit underneath, muted.
  const aiRef = (label, srcId, bodyText, trText) => bodyText && bodyText.trim() ? `
    <div class="box airef"><div class="boxhead"><h3>${esc(label)}</h3>
      ${editable ? `<button type="button" class="mini" onclick="useReply('${srcId}')">${esc(t(lang, "use_this"))}</button>` : ""}</div>
      <textarea id="${srcId}" class="draft" readonly>${esc(bodyText)}</textarea>
      ${trText ? `<p class="muted trnote" style="margin:8px 0 0">${esc(t(lang, "translation_heading"))}</p><pre class="mail muted">${linkify(String(trText))}</pre>` : ""}
    </div>` : "";
  const aiRefs = editable
    ? aiRef(`${t(lang, "ai_draft_ref")}${full ? ` (v${latestVer})` : ""}`, "ai_full", full && full.body, draftTr)
      + aiRef(t(lang, "ai_holding_ref"), "ai_interim", interim && interim.body, interimTr)
    : "";

  // Staged outbound attachments (per item). Each row has a Remove submit button; the file
  // picker base64-encodes a chosen file into hidden fields and auto-submits (no multipart).
  const attRowsHtml = atts.length
    ? atts.map((a) => `<div class="attitem">&#128206; ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span>${(editable && /^image\//i.test(a.content_type || "")) ? ` <button type="button" class="mini" onclick="insImg(${a.id})">${esc(t(lang, "img_inline_btn"))}</button>` : ""}${editable ? ` <button class="mini" name="remove_att" value="${a.id}" formnovalidate>${esc(t(lang, "remove"))}</button>` : ""}</div>`).join("")
    : `<span class="muted">${esc(t(lang, "no_attachments"))}</span>`;

  // Contact-form sends go to the code-held confirmed recipient; all other replies to the sender.
  const sendTo = (isContactForm || isCompose) ? (w.recipient || "") : w.sender_email;
  const sendConfirm = t(lang, "send_confirm").replace("{to}", sendTo)
    + (atts.length ? " (" + t(lang, "with_atts").replace("{n}", atts.length) + ")" : "");
  const sendBtn = canSend
    ? `<button class="primary send" formaction="/item/${w.id}/send" formnovalidate onclick="return confirm('${esc(sendConfirm)}');">${esc(t(lang, "send_reply_to"))} ${esc(sendTo)}</button>`
    : w.injection_flag ? `<span class="muted">${esc(t(lang, "send_disabled_inj"))}</span>`
    : isContactForm ? `<span class="muted">${esc(t(lang, w.recipient ? "cf_send_not_enabled" : "cf_confirm_first"))}</span>`
    : isCompose ? `<span class="muted">${esc(t(lang, "compose_draft_only"))}</span>` : "";

  // The work form: editable reply, attachments, feedback, questions, and the action buttons.
  // Save/Save&redraft post to /work; Send posts the same form (incl. the reply) to /send.
  const replyTranslate = needContent
    ? `<p style="margin:8px 0 0"><button type="button" class="mini" onclick="translateReply()">${esc(t(lang, "translate_btn"))}</button></p>
       <div id="replytr" class="trbox replytr" style="display:none"><pre class="mail trbody"></pre></div>`
    : "";
  const workSection = editable
    ? `<form method="post" action="/item/${w.id}/work" id="workform">
         ${isContactForm ? `<div class="box"><h3>${esc(t(lang, "cf_subject"))}</h3>
           <p class="muted trnote">${esc(t(lang, "cf_subject_hint"))}</p>
           <input class="cfsubj" name="cf_subject" value="${esc(cfSubjectDefault)}"></div>` : ""}
         ${isCompose ? `<div class="box"><h3>${esc(t(lang, "cf_subject"))}</h3>
           <p class="muted trnote">${esc(t(lang, "cf_subject_hint"))}</p>
           <input class="cfsubj" name="compose_subject" value="${esc(w.subject || "")}"></div>` : ""}
         <div class="box"><h3>${esc(t(lang, "reply_to_send"))}</h3>
           <p class="muted trnote">${esc(t(lang, "reply_hint"))}</p>
           <textarea class="draft" id="replybox" name="reply">${esc(replyText)}</textarea>${replyTranslate}</div>
         <div class="box attzone" id="attzone"><h3>${esc(t(lang, "attachments"))}${atts.length ? ` (${atts.length})` : ""}</h3>
           <div id="attlist">${attRowsHtml}</div>
           <p class="muted attnote">${esc(t(lang, "attach_hint"))} ${esc(t(lang, "drop_hint"))}. ${esc(t(lang, "paste_hint"))} ${esc(t(lang, "paste_hint_inline"))}</p>
           <input type="file" id="att_file" multiple></div>
         <div class="box"><h3>${esc(t(lang, "your_feedback"))}</h3>${feedbackInner}</div>
         <div class="box"><h3>${esc(t(lang, "questions_for_you"))} (${open.length} ${esc(t(lang, "open_lc"))})</h3>${questionsInner}</div>
         <p><button name="action" value="save">${esc(t(lang, "save"))}</button>
            <button class="primary" name="action" value="redraft">${esc(t(lang, "save_redraft"))}</button>
            ${sendBtn}
            <span class="muted">${esc(t(lang, "redraft_hint"))}</span></p>
       </form>`
    : `${(sentRow && sentRow.body) || replyText
          ? `<div class="box"><h3>${esc(t(lang, "reply_to_send"))}</h3>${sentRow ? `<p class="sent">&#10003; ${esc(t(lang, "sent_to"))} ${esc(sentRow.to_addr)} ${esc(t(lang, "on_word"))} ${esc((sentRow.sent_at || "").slice(0, 16))} UTC</p>` : ""}<textarea class="draft" readonly>${esc((sentRow && sentRow.body) || replyText)}</textarea></div>`
          : ""}
       ${atts.length ? `<div class="box"><h3>${esc(t(lang, "attachments"))} (${atts.length})</h3><div id="attlist">${attRowsHtml}</div></div>` : ""}
       <div class="box"><h3>${esc(t(lang, "your_feedback"))}</h3>${feedbackInner}</div>
       <div class="box"><h3>${esc(t(lang, "questions_for_you"))}</h3>${questionsInner}</div>`;

  // Close actions with clear semantics (each button carries a tooltip):
  //   Mark done            = the work is completed (a send sets this automatically as "replied")
  //   Resolved by phone    = completed, but not by email (status done, resolution "phone")
  //   Archive              = no action was needed (FYI / noise)
  //   Block sender         = inbound only: archive AND stop future mail from this sender (own page)
  const actions = busy ? "" : `
    <div class="actions box"><h3>${esc(t(lang, "actions"))}</h3>
      ${["done", "archived"].includes(w.status)
        ? `<form method="post" action="/item/${w.id}/status"><button name="to" value="reopen">${esc(t(lang, "reopen"))}</button></form>`
        : `<form method="post" action="/item/${w.id}/status"><button name="to" value="done" title="${esc(t(lang, "done_tip"))}">${esc(t(lang, "mark_done"))}</button></form>
           <form method="post" action="/item/${w.id}/status"><button name="to" value="phone" title="${esc(t(lang, "phone_tip"))}">${esc(t(lang, "mark_phone"))}</button></form>
           <form method="post" action="/item/${w.id}/status"><button name="to" value="archived" title="${esc(t(lang, "archive_tip"))}">${esc(t(lang, "archive"))}</button></form>
           ${!isCompose ? `<form method="get" action="/item/${w.id}/block"><button title="${esc(t(lang, "block_tip"))}">${esc(t(lang, "block_sender"))}</button></form>` : ""}`}
    </div>`;

  // Compose items have no inbound email: show the trusted instruction, the resolved customer, and
  // the code-held confirmed recipient instead of the "Customer email" box. compose_customer carries
  // NO address (the recipient lives only in w.recipient), so nothing the model produced is shown here.
  let cc = null;
  if (isCompose) { try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; } }
  const custWho = cc
    ? (cc.name && cc.contactName && cc.contactName !== cc.name ? `${cc.name} (${cc.contactName})` : (cc.name || cc.contactName || ""))
    : "";
  const custBits = cc ? [
    custWho, cc.cardCode || "", cc.country || "",
    cc.knownAccount === false ? t(lang, "compose_guest") : "",
    cc.frozen ? t(lang, "compose_frozen") : "",
  ].filter(Boolean).map(esc).join(" &middot; ") : "";
  const custNotes = cc && Array.isArray(cc.notes) && cc.notes.length
    ? `<ul class="muted" style="margin:6px 0 0">${cc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  // The "Attach SAP document" control - shared by compose and inbound items (rendered inside
  // composeHeader for compose, and standalone just above the work form for inbound replies).
  const attachDocFormBox = `<div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "attach_doc_title"))}</h3></div>
      <p class="muted">${esc(t(lang, "attach_doc_hint"))}</p>
      <form method="post" action="/item/${w.id}/attach-doc" class="attdoc">
        <label>${esc(t(lang, "attach_doc_type"))}:
          <select name="doctype">
            <option value="order">${esc(t(lang, "doc_order"))}</option>
            <option value="invoice">${esc(t(lang, "doc_invoice"))}</option>
            <option value="quotation">${esc(t(lang, "doc_quotation"))}</option>
            <option value="delivery">${esc(t(lang, "doc_delivery"))}</option>
            <option value="creditnote">${esc(t(lang, "doc_creditnote"))}</option>
          </select></label>
        <input name="docnum" inputmode="numeric" placeholder="${esc(t(lang, "attach_doc_number"))}" style="width:8em">
        <button class="mini">${esc(t(lang, "attach_doc_btn"))}</button>
      </form>
    </div>`;
  const composeHeader = `
    <div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "compose_customer_label"))}</h3></div>
      <p><b>${esc(t(lang, "compose_to"))}:</b> ${esc(w.recipient || w.sender_email || "")}</p>
      ${custBits ? `<p class="muted">${custBits}</p>` : ""}
      ${custNotes}
      ${editable ? `<form method="post" action="/item/${w.id}/language" class="relang" style="margin-top:8px">
        <label>${esc(t(lang, "compose_language"))}: <select name="language">${["en", "nl", "de", "fr", "es"].map((l) => `<option value="${l}"${(w.language || "") === l ? " selected" : ""}>${l.toUpperCase()}</option>`).join("")}</select></label>
        <button class="mini">${esc(t(lang, "compose_relang"))}</button>
      </form>` : ""}
    </div>
    <div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "compose_your_instruction"))}</h3></div>
      <pre class="mail">${esc(w.compose_instruction || "")}</pre>
      ${!ACTION_COMPOSE_SEND ? `<p class="muted trnote" style="margin:8px 0 0">${esc(t(lang, "compose_draft_only"))}</p>` : ""}
    </div>
    ${editable ? attachDocFormBox : ""}`;

  // Contact-form items: the real customer is in the body, not the sender. Show the parsed
  // customer and a confirmed-recipient picker over the DETERMINISTIC candidate set (form-typed
  // address first, SAP/Shopify addresses pickable). The chosen address is code-held in
  // w.recipient only after a human confirms it AND it passes pickRecipient at the route; nothing
  // here is model-derived. Send stays off until allow-list action #4. (cf parsed earlier.)
  let contactFormHeader = "";
  if (isContactForm) {
    const p = (cf && cf.parsed) || {};
    const rv = (cf && cf.resolved) || {};
    const cands = (cf && cf.candidateAddresses) || [];
    const formAddr = String(p.email || "").toLowerCase();
    const who = [
      p.name || rv.name || "",
      rv.matched && rv.cardCode ? rv.cardCode : "",
      p.countryCode || rv.country || "",
      rv.frozen ? t(lang, "compose_frozen") : "",
    ].filter(Boolean).map(esc).join(" &middot; ");
    const matchLine = rv.matched
      ? `<p class="muted">${esc(t(lang, "cf_matched"))}${rv.name ? ` — ${esc(rv.name)}` : ""}</p>`
      : `<p class="muted">${esc(t(lang, "cf_not_matched"))}</p>`;
    const orderLine = p.orderRef ? `<p class="muted">${esc(t(lang, "cf_order"))}: ${esc(p.orderRef)}</p>` : "";
    const phoneLine = p.phone ? `<p class="muted">&#128222; ${esc(p.phone)}</p>` : "";
    const addrTag = (a) => a.toLowerCase() === formAddr ? t(lang, "cf_from_form") : t(lang, "cf_on_file");
    const pickerForm = editable && cands.length
      ? `<form method="post" action="/item/${w.id}/contactform-recipient" class="cfpick">
           <p class="muted">${esc(t(lang, "cf_pick"))}</p>
           ${cands.map((a, i) => `<label class="cfopt"><input type="radio" name="addr" value="${esc(a)}" ${(w.recipient ? w.recipient.toLowerCase() === a.toLowerCase() : i === 0) ? "checked" : ""}> ${esc(a)} <span class="muted">(${esc(addrTag(a))})</span></label>`).join("")}
           <p><button class="primary" name="confirm" value="1">${esc(t(lang, "cf_confirm_to"))}</button></p>
         </form>`
      : "";
    const toState = w.recipient
      ? `<p><b>${esc(t(lang, "compose_to"))}:</b> ${esc(w.recipient)} <span class="chip s-ready">&#10003; ${esc(t(lang, "cf_to_confirmed"))}</span></p>
         ${editable && cands.length ? `<details><summary class="muted">${esc(t(lang, "cf_change"))}</summary>${pickerForm}</details>` : ""}`
      : (cands.length ? pickerForm : `<p class="muted">${esc(t(lang, "cf_no_address"))}</p>`);
    contactFormHeader = `
      <div class="box">
        <div class="boxhead"><h3>${esc(t(lang, "cf_customer_label"))}</h3></div>
        ${who ? `<p>${who}</p>` : ""}
        ${matchLine}${orderLine}${phoneLine}
        ${toState}
      </div>`;
  }

  const body = `
    <p><a href="&#47;">${esc(t(lang, "back_inbox"))}</a></p>
    <h2>#${w.id} ${esc(w.subject || t(lang, "no_subject"))}</h2>
    <p>${chips}</p>
    ${(editable && !isCompose) ? `<form method="post" action="/item/${w.id}/language" class="relang" style="margin:0 12px 8px 0;display:inline-block">
      <label class="muted">${esc(t(lang, "lang_fix"))}: <select name="language">${["nl", "en", "de", "fr", "es"].map((l) => `<option value="${l}"${(w.language || "") === l ? " selected" : ""}>${l.toUpperCase()}</option>`).join("")}</select></label>
      <button class="mini">${esc(t(lang, "lang_fix_btn"))}</button>
    </form>` : ""}
    ${(editable && ownerChoices(w.mailbox).some((o) => o !== (w.owner || ""))) ? `<form method="post" action="/item/${w.id}/owner" class="relang" style="margin:0 0 8px;display:inline-block">
      <label class="muted">${esc(t(lang, "owner_fix"))}: <select name="owner">${ownerChoices(w.mailbox).map((o) => `<option value="${esc(o)}"${(w.owner || "") === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
      <button class="mini">${esc(t(lang, "owner_fix_btn"))}</button>
    </form>` : ""}
    ${isCompose
      ? `<p class="muted">${esc(t(lang, "compose_from"))}: ${esc(w.mailbox)}@ &middot; ${esc(fmtDateTime(w.created_at, lang))}</p>`
      : `<p class="muted">${esc(t(lang, "from"))} ${esc(w.sender_name || w.sender_email)}${w.sender_name ? ` (${esc(w.sender_email)})` : ""} &middot; ${esc(fmtDateTime(w.email_received, lang))} &middot; ${esc(w.mailbox)}@</p>`}
    ${w.caller_info ? `<p class="muted">&#128222; ${esc(w.caller_info)}</p>` : ""}
    ${busy ? `<div class="banner">${esc(t(lang, "investigating_banner"))}</div>` : ""}

    ${isCompose ? composeHeader : (isContactForm ? contactFormHeader : "") + `<div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "customer_email"))}</h3>
        <span><input id="mq" type="search" placeholder="${esc(t(lang, "search_in_email"))}" autocomplete="off"><span class="qcount" id="mqcount"></span></span></div>
      <div id="mailwrap">${renderMail(w.email_text || t(lang, "body_not_stored"), lang)}${renderAttachments(w)}</div>
    </div>`}
    ${trBlock(emailTr, t(lang, "translation_note").replace("{lang}", langName))}
    <script>
    (function () {
      var mq = document.getElementById("mq"), c = document.getElementById("mqcount"),
          wrap = document.getElementById("mailwrap");
      if (!mq || !c || !wrap) return;   // compose items have no inbound-email search box - nothing to wire
      function clearMarks() {
        wrap.querySelectorAll("mark.hit").forEach(function (m) {
          var p = m.parentNode;
          p.replaceChild(document.createTextNode(m.textContent), m);
          p.normalize();
        });
      }
      function markAll(v) {
        var n = 0, texts = [],
            walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) texts.push(walker.currentNode);
        texts.forEach(function (t) {
          var s = t.nodeValue, l = s.toLowerCase(), i = l.indexOf(v);
          if (i < 0) return;
          var frag = document.createDocumentFragment(), pos = 0;
          while (i >= 0) {
            frag.appendChild(document.createTextNode(s.slice(pos, i)));
            var m = document.createElement("mark");
            m.className = "hit";
            m.textContent = s.slice(i, i + v.length);
            frag.appendChild(m);
            pos = i + v.length;
            i = l.indexOf(v, pos);
            n++;
          }
          frag.appendChild(document.createTextNode(s.slice(pos)));
          t.parentNode.replaceChild(frag, t);
        });
        return n;
      }
      mq.addEventListener("input", function () {
        clearMarks();
        var v = mq.value.trim().toLowerCase();
        if (v.length < 2) { c.textContent = ""; return; }
        var n = markAll(v);
        wrap.querySelectorAll("details").forEach(function (d) {
          if (d.querySelector("mark.hit")) d.open = true;
        });
        c.textContent = n + " " + (n === 1 ? "${t(lang, "match")}" : "${t(lang, "matches")}");
        var first = wrap.querySelector("mark.hit");
        if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    })();
    </script>

    ${busy && !full && !interim ? `<div class="box"><span class="muted">${esc(t(lang, "no_draft_busy"))}</span></div>` : ""}
    ${aiRefs}
    ${suggBox}
    ${(editable && !isCompose && !isContactForm) ? attachDocFormBox : ""}
    ${workSection}
    ${actions}
    <div class="box"><details><summary>${esc(t(lang, "what_checked"))}</summary><pre class="mail">${esc(w.brief_md || t(lang, "none_paren"))}</pre></details></div>
    <script>
    function useReply(srcId) {
      var s = document.getElementById(srcId), r = document.getElementById("replybox");
      if (s && r) { r.value = s.value; r.focus(); }
    }
    function translateReply() {
      var r = document.getElementById("replybox"), out = document.getElementById("replytr");
      if (!r || !out) return;
      var b = out.querySelector(".trbody");
      out.style.display = "block"; b.textContent = ${JSON.stringify(t(lang, "translating"))};
      fetch("/item/${w.id}/translate-reply", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent(r.value) })
        .then(function (x) { return x.json(); })
        .then(function (d) { b.textContent = d.text || d.error || ""; })
        .catch(function () { b.textContent = "(error)"; });
    }
    // Insert text at the caret of a textarea (used for [image:N] inline tokens).
    function insAt(ta, txt) {
      var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      var e = ta.selectionEnd == null ? s : ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + txt.length;
      ta.focus();
    }
    // "Insert in text" button on an image attachment row: place its inline token at the caret.
    function insImg(id) {
      var ta = document.getElementById("replybox");
      if (ta) insAt(ta, "[image:" + id + "]");
    }
    (function () {
      var form = document.getElementById("workform");
      if (!form) return;
      var MAX = ${MAX_ATTACH_BYTES};
      // Add one or more files (picker, drag-drop or paste) via AJAX, persisting the current
      // form inputs first, then reload once all are stored. When tokenTa is a textarea
      // (paste into the reply box), each stored IMAGE also drops its [image:id] token at the
      // caret; the token-edited reply is then persisted with one final no-file call so the
      // reload renders it back.
      function addFiles(files, tokenTa) {
        if (!files || !files.length) return;
        var base = new URLSearchParams(new FormData(form)); // reply, feedback, answers
        var arr = [].slice.call(files), tokensAdded = false;
        (function next(i) {
          if (i >= arr.length) {
            if (!tokensAdded) { location.reload(); return; }
            var p2 = new URLSearchParams(new FormData(form));   // now includes the tokens
            fetch("/item/${w.id}/attach-add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p2.toString() })
              .then(function () { location.reload(); }).catch(function () { location.reload(); });
            return;
          }
          var file = arr[i];
          if (file.size > MAX) { alert(${JSON.stringify(t(lang, "file_too_big"))}); return next(i + 1); }
          var rd = new FileReader();
          rd.onload = function () {
            var p = new URLSearchParams(base.toString());
            p.set("name", file.name); p.set("ctype", file.type || "application/octet-stream");
            p.set("data", String(rd.result).split(",")[1] || "");
            fetch("/item/${w.id}/attach-add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() })
              .then(function (x) { return x.json(); })
              .then(function (d) {
                if (d && d.error) { alert(d.error); }
                else if (tokenTa && d && d.id && /^image\\//i.test(file.type || "")) { insAt(tokenTa, "[image:" + d.id + "]"); tokensAdded = true; }
                next(i + 1);
              })
              .catch(function () { alert(${JSON.stringify(t(lang, "attach_failed"))}); next(i + 1); });
          };
          rd.readAsDataURL(file);
        })(0);
      }
      var picker = document.getElementById("att_file");
      if (picker) picker.addEventListener("change", function () { addFiles(this.files); this.value = ""; });
      var zone = document.getElementById("attzone");
      if (zone) {
        ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
        zone.addEventListener("dragleave", function (e) { if (e.target === zone) zone.classList.remove("drag"); });
        zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("drag"); addFiles(e.dataTransfer.files); });
      }
      // Stop the browser navigating away if a file is dropped outside the zone.
      ["dragover", "drop"].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); }, false); });

      // Paste-to-attach: a screenshot snipped to the clipboard (Win+Shift+S) is attached with
      // a single Ctrl+V - no save-to-file step. Pasted into the reply box, it also places its
      // inline [image:N] token at the caret. A paste that carries TEXT into a text field is
      // left alone (e.g. an Excel range copies both text and a picture - the text wins).
      function extOf(type) { var m = /^image\\/(png|jpe?g|gif|webp)/i.exec(type || ""); return m ? m[1].replace("jpeg", "jpg") : "png"; }
      document.addEventListener("paste", function (e) {
        if (!zone || !e.clipboardData) return;
        var items = e.clipboardData.items || [], imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\\//i.test(items[i].type)) { var f = items[i].getAsFile(); if (f) imgs.push(f); }
        }
        if (!imgs.length) return;
        var tg = e.target, inField = tg && (tg.tagName === "TEXTAREA" || tg.tagName === "INPUT");
        if (inField && (e.clipboardData.getData("text/plain") || "").length) return;
        e.preventDefault();
        var stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
        var renamed = imgs.map(function (f, i2) {
          return new File([f], "snippet-" + stamp + (imgs.length > 1 ? "-" + (i2 + 1) : "") + "." + extOf(f.type), { type: f.type || "image/png" });
        });
        addFiles(renamed, (tg && tg.id === "replybox") ? tg : null);
      });
    })();
    </script>`;
  res.send(page(`Item ${w.id}`, req.user, body, busy ? 10 : 0));
});

// Open an attachment: fetched from Graph on demand, streamed to the browser.
// Untrusted content rules: PDFs/images render inline; everything else (incl.
// HTML/SVG, which can carry active content) is forced to download; nosniff always.
app.get("/item/:id/attachment/:idx", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  let atts = [];
  try { atts = JSON.parse(w.attachments_json || "[]"); } catch (e) { /* ignore */ }
  const a = atts[parseInt(req.params.idx, 10)];
  if (!a) return res.status(404).send(page("Not found", req.user, "<p>No such attachment on this item.</p>"));
  try {
    const file = await C.getAttachment(MAILBOX_OF[w.mailbox], w.latest_message_id, a.id);
    audit(req.user.tailscale_login, "open_attachment", w.id, `${a.name} (${fmtSize(file.size)})`);
    const ct = String(file.contentType || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const inlineOk = ct === "application/pdf" || /^image\/(png|jpe?g|gif|webp)$/.test(ct);
    const fname = String(file.name || a.name || "attachment").replace(/[^\w. ()\[\]-]/g, "_");
    res.set({
      "Content-Type": inlineOk ? ct : "application/octet-stream",
      "Content-Disposition": `${inlineOk ? "inline" : "attachment"}; filename="${fname}"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(Buffer.from(file.contentBytes, "base64"));
  } catch (e) {
    audit(req.user.tailscale_login, "attachment_error", w.id, e.message.slice(0, 200));
    res.status(502).send(page("Error", req.user, `<p>Could not fetch attachment: ${esc(e.message)}</p><p class="muted">It may have expired or the email may have been moved.</p>`));
  }
});

// Persist the editable inputs shared by /work and /send: feedback, the edited reply
// (draft_edit), and any answers typed into open questions. TRUSTED staff input.
function saveWorkInputs(w, body, login) {
  if ("feedback" in body) {
    const fb = String(body.feedback || "").trim();
    db.prepare("UPDATE work_items SET feedback = ? WHERE id = ?").run(fb || null, w.id);
    if (fb) audit(login, "save_feedback", w.id, fb.slice(0, 100));
  }
  if ("reply" in body) {
    db.prepare("UPDATE work_items SET draft_edit = ? WHERE id = ?").run(String(body.reply || ""), w.id);
  }
  const openQs = db.prepare("SELECT * FROM questions WHERE work_item_id = ? AND answer IS NULL").all(w.id);
  for (const q of openQs) {
    const val = String(body["answer_" + q.id] || "").trim();
    if (!val) continue;
    db.prepare("UPDATE questions SET answer = ?, answered_by = ?, answered_at = datetime('now') WHERE id = ?")
      .run(val, login, q.id);
    audit(login, "answer_question", w.id, `q${q.id}: ${val.slice(0, 100)}`);
  }
}

// Add an outbound attachment (base64 from the browser, no multipart). Enforces per-file and
// per-item size caps. Returns { error, id }: error is a localised string (id null) on
// failure; on success error is null and id is the new draft_attachments id - the browser
// uses it to build an [image:id] inline token. An empty body.data is a pure form-save
// no-op (error null, id null), used by the paste flow to persist the token-edited reply.
function addAttachment(w, body, login, lang) {
  const b64 = String(body.data || "");
  if (!b64) return { error: null, id: null };
  const size = Math.floor((b64.length * 3) / 4); // approx decoded byte length
  if (size > MAX_ATTACH_BYTES) return { error: t(lang, "file_too_big"), id: null };
  const total = db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM draft_attachments WHERE work_item_id = ?").get(w.id).s;
  if (total + size > MAX_ATTACH_TOTAL) return { error: t(lang, "attach_total"), id: null };
  const name = String(body.name || "attachment").replace(/[\r\n]/g, " ").slice(0, 200);
  const ctype = String(body.ctype || "application/octet-stream").slice(0, 100);
  const id = db.prepare("INSERT INTO draft_attachments (work_item_id, name, content_type, size, content_b64, added_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(w.id, name, ctype, size, b64, login).lastInsertRowid;
  audit(login, "attachment_added", w.id, `${name} (${fmtSize(size)})`);
  return { error: null, id };
}

// Save reply/feedback/answers; add/remove an attachment; optionally kick off a redraft.
app.post("/item/:id/work", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));

  saveWorkInputs(w, req.body, req.user.tailscale_login);

  if (req.body.remove_att) {
    const attId = parseInt(req.body.remove_att, 10) || 0;
    const info = db.prepare("DELETE FROM draft_attachments WHERE id = ? AND work_item_id = ?").run(attId, w.id);
    if (info.changes) {
      // Strip any [image:id] inline tokens for the removed attachment from the saved reply,
      // so the normal flow can't leave a dangling token (send-guard would refuse it).
      db.prepare("UPDATE work_items SET draft_edit = REPLACE(draft_edit, ?, '') WHERE id = ? AND draft_edit IS NOT NULL")
        .run(`[image:${attId}]`, w.id);
      audit(req.user.tailscale_login, "attachment_removed", w.id, `att ${attId}`);
    }
  }

  if (req.body.action === "redraft" && w.status !== "investigating") {
    db.prepare("UPDATE work_items SET status = 'investigating', updated_at = datetime('now') WHERE id = ?").run(w.id);
    audit(req.user.tailscale_login, "redraft_started", w.id, null);
    setImmediate(() => runRedraft(w.id, req.user.tailscale_login));
  }
  res.redirect("/item/" + w.id);
});

// Change an item's language.
//  - Compose item: this is the OUTBOUND draft language the salesperson chose, so re-draft in it
//    (reuses the redraft loop, which already honours w.language).
//  - Inbound item: this CORRECTS the detected customer language when Axle got it wrong (e.g. an
//    image-only reply mis-tagged EN). It only re-tags the item — fixing the translation panel and
//    the language chip — and does NOT re-draft, since the reply already follows the customer's own
//    email. A fresh draft remains one click away via "Save & redraft".
app.post("/item/:id/language", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  const newLang = ["en", "nl", "de", "fr", "es"].includes(req.body.language) ? req.body.language : null;
  if (!newLang || newLang === w.language) return res.redirect("/item/" + w.id);

  if (w.origin === "compose") {
    if (w.status !== "investigating") {
      db.prepare("UPDATE work_items SET language = ?, status = 'investigating', updated_at = datetime('now') WHERE id = ?").run(newLang, w.id);
      audit(req.user.tailscale_login, "compose_language_change", w.id, `${w.language || "?"} -> ${newLang}`);
      setImmediate(() => runRedraft(w.id, req.user.tailscale_login));
    }
  } else if (!["done", "archived"].includes(w.status)) {
    db.prepare("UPDATE work_items SET language = ?, updated_at = datetime('now') WHERE id = ?").run(newLang, w.id);
    audit(req.user.tailscale_login, "language_corrected", w.id, `${w.language || "?"} -> ${newLang}`);
  }
  res.redirect("/item/" + w.id);
});

// Reassign an item's owner (any registered user - e.g. Jack hands a mis-routed supplier
// email to Tom). The new owner must be one of the mailbox's own routing labels (see
// ownerChoices) - never free text - so the inbox "mine" queues stay consistent. Closed
// items are immutable (reopen first), matching the other metadata edits.
app.post("/item/:id/owner", (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  const to = String(req.body.owner || "");
  if (ownerChoices(w.mailbox).includes(to) && to !== (w.owner || "") && !["done", "archived"].includes(w.status)) {
    db.prepare("UPDATE work_items SET owner = ?, updated_at = datetime('now') WHERE id = ?").run(to, w.id);
    audit(req.user.tailscale_login, "owner_changed", w.id, `${ownerLabel(w)} -> ${to}`);
  }
  res.redirect("/item/" + w.id);
});

// On-demand: translate the salesperson's CURRENT (possibly edited) reply into their own
// language so they can read what they're about to send. Returns JSON; cached like all
// translations. The text is treated strictly as data by the translator.
app.post("/item/:id/translate-reply", async (req, res) => {
  const text = String(req.body.text || "");
  if (!text.trim()) return res.json({ text: "" });
  try { res.json({ text: await TR.translate(anthropic, req.user.lang, text) }); }
  catch (e) { res.status(502).json({ error: e.message.slice(0, 200) }); }
});

// AJAX attachment add (used by both the file picker and drag-and-drop, one call per file).
// Persists the in-progress reply/answers first so a reload won't lose them.
app.post("/item/:id/attach-add", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: t(lang, "not_found") });
  saveWorkInputs(w, req.body, req.user.tailscale_login);
  const r = addAttachment(w, req.body, req.user.tailscale_login, lang);
  if (r.error) return res.status(413).json({ error: r.error });
  res.json({ ok: true, id: r.id });   // id lets the browser place an [image:id] inline token
});

// Attach the Boyum print PDF of a referenced SAP document to a COMPOSE email (DRAFT-ONLY).
// The DocEntry is resolved deterministically from the number the salesperson typed - never the
// model, never email content. The PDF is rendered READ-ONLY via Crystal and staged in
// draft_attachments behind the same approval gate as any hand-attached file: it never sends and
// never writes to SAP. A document whose customer differs from the email's is held for an explicit
// confirm, so another customer's document can't be attached by mistake.
app.post("/item/:id/attach-doc", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  const back = `<p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`;
  const small = (html, code) => res.status(code || 200).send(page(t(lang, "attach_doc_title"), req.user,
    `<div class="box"><h3>${esc(t(lang, "attach_doc_title"))}</h3>${html}${back}</div>`));

  if (isContactFormItem(w)) { audit(login, "attach_doc_refused", w.id, "contact-form item"); return small(`<p>${esc(t(lang, "attach_doc_compose_only"))}</p>`, 400); }

  const type = String(req.body.doctype || "order").toLowerCase();
  const num = String(req.body.docnum || "").trim();
  if (!SAPDOC.DOC_TYPES[type] || !num) return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400);

  let resolved;
  try { resolved = await SAPDOC.resolveDocument(type, num); }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!resolved.ok || !resolved.candidates.length) { audit(login, "attach_doc_notfound", w.id, `${type} ${num}`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 404); }

  // Choose the document: the unique match, or the candidate the human picked - validated to be IN
  // the resolver's own set (an out-of-set DocEntry is rejected, mirroring the recipient gate).
  let doc;
  const pick = parseInt(req.body.docentry, 10);
  if (resolved.candidates.length === 1) doc = resolved.candidates[0];
  else if (Number.isInteger(pick)) {
    doc = resolved.candidates.find((c) => c.docEntry === pick);
    if (!doc) { audit(login, "attach_doc_pick_rejected", w.id, `entry ${pick} not in set`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400); }
  } else {
    const opts = resolved.candidates.map((c) => `
      <form method="post" action="/item/${w.id}/attach-doc" style="margin:4px 0">
        <input type="hidden" name="doctype" value="${esc(type)}"><input type="hidden" name="docnum" value="${esc(num)}"><input type="hidden" name="docentry" value="${c.docEntry}">
        <button class="mini">${esc(c.type)} ${esc(String(c.docNum))} &middot; ${esc(c.cardCode || "")} ${esc(c.cardName || "")} &middot; ${esc(String(c.docTotal))} ${esc(c.docCur || "")} &middot; ${esc(c.docDate ? new Date(c.docDate).toISOString().slice(0, 10) : "")}</button>
      </form>`).join("");
    return small(`<p>${esc(t(lang, "attach_doc_ambiguous"))}</p>${opts}`, 200);
  }

  // Customer-scope guard: attach straight away only when the document's customer matches the
  // email's resolved customer; otherwise hold for an explicit confirm.
  // The email's customer, to scope the document against. For compose it's the resolved compose
  // customer; for an inbound reply it's the sender resolved to a SINGLE active SAP customer (else
  // "", which forces the explicit show-and-confirm below).
  let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
  let itemCard = (cc && cc.cardCode) || "";
  let itemName = (cc && cc.name) || "";
  if (w.origin !== "compose" && !itemCard && w.sender_email) {
    try { const m = await SAPDOC.customerByEmail(w.sender_email); if (m && m.cardCode) { itemCard = m.cardCode; itemName = m.cardName || ""; } }
    catch (e) { audit(login, "attach_doc_scope_lookup_failed", w.id, e.message.slice(0, 120)); }
  }
  if ((!itemCard || itemCard !== doc.cardCode) && req.body.confirm !== "1") {
    audit(login, "attach_doc_scope_warn", w.id, `doc ${doc.cardCode || "?"} vs item ${itemCard || "?"}`);
    return small(`<p>${esc(t(lang, "attach_doc_scope_warn"))}</p>
      <p class="muted">${esc(t(lang, "attach_doc_doc_cust"))}: ${esc(doc.cardCode || "")} ${esc(doc.cardName || "")}<br>
      ${esc(t(lang, "attach_doc_email_cust"))}: ${esc(itemCard || "-")} ${esc(itemName)}</p>
      <form method="post" action="/item/${w.id}/attach-doc">
        <input type="hidden" name="doctype" value="${esc(type)}"><input type="hidden" name="docnum" value="${esc(String(doc.docNum))}"><input type="hidden" name="docentry" value="${doc.docEntry}"><input type="hidden" name="confirm" value="1">
        <button class="primary">${esc(t(lang, "attach_doc_scope_confirm"))}</button>
      </form>`, 200);
  }

  // Render (READ-ONLY) + stage in draft_attachments (capped, base64) - just like a hand-attached file.
  let r;
  try { r = await SAPDOC.renderPdf(doc.objectId, doc.docEntry); }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!r.ok) { audit(login, "attach_doc_render_failed", w.id, String(r.error).slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }

  const filename = SAPDOC.docTypeInfo(type).prefix + "-" + doc.docNum + ".pdf";
  const ares = addAttachment(w, { data: r.buffer.toString("base64"), name: filename, ctype: "application/pdf" }, login, lang);
  if (ares.error) return small(`<p>${esc(ares.error)}</p>`, 413);
  const override = !(itemCard && itemCard === doc.cardCode);
  audit(login, "doc_pdf_attached", w.id, `${doc.type} ${doc.docNum} DocEntry ${doc.docEntry} cust ${doc.cardCode || "?"} ${r.bytes}b${override ? " SCOPE-OVERRIDE" : ""}`);
  res.redirect("/item/" + w.id);
});

// Confirm the contact-form reply recipient (Step 3 of the contact-form build). The candidate
// set was built deterministically at ingest (the parsed form address + any SAP/Shopify addresses)
// and stored on the item. The posted address is honoured ONLY if pickRecipient finds it in that
// set — a tampered or out-of-set value is rejected with no fallback, so a recipient the resolver
// never produced can't get through. The chosen address is code-held in w.recipient. This sets a
// recipient only; it NEVER sends (allow-list action #4 is still off — that's Step 4's gate).
app.post("/item/:id/contactform-recipient", (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  if (!isContactFormItem(w)) {
    return res.status(400).send(page(t(lang, "send_refused"), req.user,
      `<p>${esc(t(lang, "send_refused"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
  let cf = null;
  try { cf = JSON.parse(w.contact_form_json || "null"); } catch (e) { cf = null; }
  const cands = (cf && cf.candidateAddresses) || [];
  const picked = String(req.body.addr || "").trim().toLowerCase();

  // pickRecipient: returns the address only if it is one the resolver produced; else "".
  const recipient = RESOLVE.pickRecipient(cands, picked);
  if (!recipient) {
    audit(login, "contactform_recipient_rejected", w.id, `picked=${picked.slice(0, 80)} not in candidate set`);
    return res.status(400).send(page(t(lang, "send_refused"), req.user,
      `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_recipient_rejected"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
  db.prepare("UPDATE work_items SET recipient = ?, updated_at = datetime('now') WHERE id = ?").run(recipient, w.id);
  audit(login, "contactform_recipient_set", w.id, `to=${recipient}`);
  res.redirect("/item/" + w.id);
});

// Send the approved reply (allow-list action #1). The salesperson can edit the reply and
// send at any time; deterministic guardrails (send-guard) re-validate the FINAL body - an
// injection-flagged item can never send, recipient is hard-locked to the sender, every URL
// must be allowlisted. Both the AI draft (drafts, source='ai') and the actual sent text
// (sends.body + a source='human' draft) are kept for the self-improvement layer. De-dup is
// on (work_item_id, body_sha256): a double-click of the identical body can't send twice.
app.post("/item/:id/send", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));

  // Allow-list action #3 ("send new / composed email"). While AXLE_ACTION_COMPOSE_SEND is OFF a
  // compose item drafts and holds only - refuse at the route, not merely by hiding the button. When
  // ON, it sends a FRESH email to the CODE-HELD, human-confirmed recipient (w.recipient - set only by
  // the resolver + pickRecipient at compose time, never by the model or email content); a confirmed
  // recipient is required first.
  const isComposeItem = w.origin === "compose";
  if (isComposeItem) {
    if (!ACTION_COMPOSE_SEND) {
      audit(login, "compose_send_blocked", w.id, "action #3 disabled (draft-only)");
      return res.status(403).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "compose_send_blocked"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
    if (!w.recipient) {
      audit(login, "compose_send_no_recipient", w.id, "no confirmed recipient");
      return res.status(400).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "compose_need_pick"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
  }

  // Contact-form messages: the thread sender is Shopify's mailer, not the customer, so a send is
  // a NEW outbound to the code-held, human-confirmed recipient - governed by allow-list action #4.
  // While #4 is OFF, refuse at the route (not just a hidden button). When ON, a recipient must
  // have been confirmed first. When permitted, isCF routes the assembly to the new-outbound path.
  const isCF = isContactFormItem(w);
  if (isCF) {
    if (!ACTION_CONTACTFORM_SEND) {
      audit(login, "contactform_send_blocked", w.id, "action #4 disabled (draft-only)");
      return res.status(403).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_send_not_enabled"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
    if (!w.recipient) {
      audit(login, "contactform_send_no_recipient", w.id, "no confirmed recipient");
      return res.status(400).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_confirm_first"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
  }

  saveWorkInputs(w, req.body, login);                 // persist the edited reply + any answers/feedback
  const body = String(req.body.reply != null ? req.body.reply : (w.draft_edit || ""));

  // The AI draft this reply was edited from (latest AI full, else AI holding) - for lineage.
  const aiSrc = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND source = 'ai' ORDER BY is_interim ASC, version DESC, id DESC LIMIT 1").get(w.id);

  // Staged attachments: loaded BEFORE assembly so the assembler can resolve any [image:N]
  // tokens the human placed against this item's own staged rows (and refuse bad ones).
  const attRows = db.prepare("SELECT id, name, content_type, size, content_b64 FROM draft_attachments WHERE work_item_id = ? ORDER BY id").all(w.id);

  let payload;
  try {
    // Contact-form: new outbound to the code-held recipient with the human-approved subject.
    // Everything else: in-thread reply hard-locked to the sender. Both re-validate the FINAL body.
    payload = isComposeItem ? SG.assembleNewOutboundSend(w, body, req.body.compose_subject, attRows)
            : isCF ? SG.assembleNewOutboundSend(w, body, req.body.cf_subject, attRows)
            : SG.assembleSend(w, body, attRows);
  } catch (e) {
    audit(login, "send_refused", w.id, e.message.slice(0, 200));
    return res.status(400).send(page("Send refused", req.user,
      `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(e.message)}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }

  // De-dup an identical body for this item (double-click / refresh).
  if (db.prepare("SELECT 1 FROM sends WHERE work_item_id = ? AND body_sha256 = ?").get(w.id, payload.sha256)) {
    return res.redirect("/item/" + w.id);
  }

  // Bytes for Graph, metadata for the audit record. Attachments whose id the assembler
  // validated as inline get the send-guard contentId (the <img> in the HTML references it);
  // the rest stay regular attachments.
  const inlineSet = new Set(payload.inlineIds || []);
  const attMeta = attRows.map((a) => ({ name: a.name, contentType: a.content_type, size: a.size, inline: inlineSet.has(a.id) || undefined }));
  const graphAtts = attRows.map((a) => ({
    name: a.name, contentType: a.content_type, contentBytes: a.content_b64,
    ...(inlineSet.has(a.id) ? { contentId: SG.contentIdFor(a.id) } : {}),
  }));

  // Record the exact sent text as a human draft (keeps the AI-vs-sent pair in the history).
  const ver = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE work_item_id = ?").get(w.id).v || 0) + 1;
  const humanDraftId = db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body, source, edited_by) VALUES (?, ?, 0, ?, 'human', ?)")
    .run(w.id, ver, body, login).lastInsertRowid;

  // Reserve a pending send; UNIQUE(work_item_id, body_sha256) rejects a race double-send.
  try {
    db.prepare("INSERT INTO sends (work_item_id, draft_id, source_draft_id, to_addr, subject, body_sha256, body, attachments_json, status, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(w.id, humanDraftId, aiSrc ? aiSrc.id : null, payload.to, payload.subject, payload.sha256, body, attMeta.length ? JSON.stringify(attMeta) : null, login);
  } catch (e) {
    db.prepare("DELETE FROM drafts WHERE id = ?").run(humanDraftId);
    return res.redirect("/item/" + w.id);
  }

  try {
    // Contact-form is a fresh email (no thread); originalMessageId=null so send.js threads nothing.
    const r = await SEND.sendReply({
      mailbox: MAILBOX_OF[w.mailbox], originalMessageId: (isCF || isComposeItem) ? null : w.latest_message_id,
      to: payload.to, subject: payload.subject, html: payload.html, attachments: graphAtts,
    });
    db.prepare("UPDATE sends SET status = 'sent', graph_message_id = ? WHERE work_item_id = ? AND body_sha256 = ?").run(r.sentId || "sent", w.id, payload.sha256);
    db.prepare("UPDATE work_items SET status = 'done', resolution = 'replied', draft_edit = NULL, updated_at = datetime('now') WHERE id = ?").run(w.id);
    db.prepare("DELETE FROM draft_attachments WHERE work_item_id = ?").run(w.id); // bytes no longer needed; metadata kept in sends
    const edited = aiSrc ? String(aiSrc.body) !== body : true;
    audit(login, "email_sent", w.id,
      `kind=${isComposeItem ? "compose_new" : isCF ? "contactform_new" : "reply"} to=${payload.to} edited=${edited} ai_draft=${aiSrc ? aiSrc.id : "-"} atts=${attMeta.length}${inlineSet.size ? ` inline=${inlineSet.size}` : ""} threaded=${r.threaded} sha=${payload.sha256.slice(0, 12)}`);
    if (!isComposeItem) await markReadSafe(login, w);
    res.redirect("/item/" + w.id);
  } catch (e) {
    db.prepare("DELETE FROM sends WHERE work_item_id = ? AND body_sha256 = ? AND status = 'pending'").run(w.id, payload.sha256);
    db.prepare("DELETE FROM drafts WHERE id = ?").run(humanDraftId);   // remove the speculative human draft on failure
    audit(login, "send_failed", w.id, e.message.slice(0, 200));
    res.status(502).send(page("Send failed", req.user,
      `<p><b>${esc(t(lang, "send_failed"))}:</b> ${esc(e.message)}</p><p>${esc(t(lang, "send_failed_note"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
});

// Status changes: done / phone (= done, resolved without email) / archived / reopen.
// Each close records HOW the item was resolved in work_items.resolution ("replied" is set
// by the send route itself); reopen clears it again.
app.post("/item/:id/status", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  const CLOSE = { done: ["done", "done"], phone: ["done", "phone"], archived: ["archived", "no_action"] };
  const to = req.body.to === "reopen"
    ? (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE work_item_id = ?").get(w.id).n ? "ready" : "new")
    : CLOSE[req.body.to] ? CLOSE[req.body.to][0] : null;
  const resolution = req.body.to === "reopen" ? null : CLOSE[req.body.to] ? CLOSE[req.body.to][1] : null;
  if (to && w.status !== "investigating") {
    db.prepare("UPDATE work_items SET status = ?, resolution = ?, updated_at = datetime('now') WHERE id = ?").run(to, resolution, w.id);
    audit(req.user.tailscale_login, "status_change", w.id, `${w.status} -> ${to}${resolution && resolution !== "done" ? ` (${resolution})` : ""}`);
    if (to === "done" || to === "archived") await markReadSafe(req.user.tailscale_login, w);
  }
  res.redirect(req.body.to === "reopen" ? "/item/" + w.id : "/");
});

// ---- Block sender (Axle-only suppression, reversible) -------------------------------------
// GET = a confirm page: choose address-only vs whole-domain, with a SAP-customer check so a
// real customer isn't blocked by accident. POST = insert the block, archive this item
// (resolution no_action) and mark the inbound read. The pattern is derived in code from the
// item's STORED sender address - never from typed input. Blocks are global (info@ +
// drachten@); the mail still arrives in Outlook (no mailbox write). Everything is audited.
app.get("/item/:id/block", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  if (w.origin === "compose") return res.redirect("/item/" + w.id);
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return res.redirect("/item/" + w.id);

  // SAP check: warn when the address belongs to a real customer (guest matches have no
  // CardCode and don't count). A SQL failure must not break the page - show "unknown".
  let sapNote = `<p class="muted">${esc(t(lang, "block_sap_unknown"))}</p>`;
  try {
    const r = await RESOLVE.resolveCustomer(addr);
    const hit = (r && r.customer && r.customer.cardCode) ? r.customer
      : ((r && r.candidates) || []).find((c) => c.cardCode);
    sapNote = hit
      ? `<p><b>&#9888; ${esc(t(lang, "block_sap_warn"))}</b> ${esc(hit.name || "?")} [${esc(hit.cardCode)}]</p>`
      : `<p class="muted">${esc(t(lang, "block_sap_none"))}</p>`;
  } catch (e) { /* keep the unknown note */ }

  res.send(page(t(lang, "block_title"), req.user, `
    <p><a href="/item/${w.id}">&larr; #${w.id}</a></p>
    <h2>${esc(t(lang, "block_title"))}</h2>
    <div class="box">
      <p><b>${esc(w.sender_name || addr)}</b> &lt;${esc(addr)}&gt;</p>
      <p class="muted">${esc(t(lang, "block_explain"))}</p>
      ${sapNote}
      <form method="post" action="/item/${w.id}/block">
        <p><label><input type="radio" name="kind" value="address" checked> ${esc(t(lang, "block_addr_opt"))} (${esc(addr)})</label><br>
           <label><input type="radio" name="kind" value="domain"> ${esc(t(lang, "block_dom_opt"))} (@${esc(domain)})</label></p>
        <button class="primary">${esc(t(lang, "block_confirm_btn"))}</button>
        <a href="/item/${w.id}" style="margin-left:10px">${esc(t(lang, "block_back"))}</a>
      </form>
    </div>`));
});

app.post("/item/:id/block", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  if (w.origin === "compose") return res.redirect("/item/" + w.id);
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return res.redirect("/item/" + w.id);
  const kind = req.body.kind === "domain" ? "domain" : "address";
  const pattern = (kind === "domain" ? "@" + domain : addr).slice(0, 200);
  db.prepare("INSERT OR IGNORE INTO sender_blocks (pattern, kind, reason, added_by, work_item_id) VALUES (?, ?, 'unwanted sender', ?, ?)")
    .run(pattern, kind, req.user.tailscale_login, w.id);
  db.prepare("UPDATE work_items SET status = 'archived', resolution = 'no_action', updated_at = datetime('now') WHERE id = ?").run(w.id);
  audit(req.user.tailscale_login, "sender_blocked", w.id, `${pattern} (${kind})`);
  await markReadSafe(req.user.tailscale_login, w);
  res.redirect("/");
});

// Blocklist viewer: visible to the whole team, unblock allowed for anyone (audited), so a
// mistake is fixable on the spot without waiting for Brad.
app.get("/blocks", (req, res) => {
  const lang = req.user.lang;
  const rows = db.prepare("SELECT * FROM sender_blocks ORDER BY id DESC").all();
  const trs = rows.map((b) => `<tr>
      <td>${esc(b.pattern)}</td><td>${esc(b.kind)}</td><td>${esc(b.added_by)}</td>
      <td class="muted">${esc(fmtDateTime(b.added_at, lang))}</td>
      <td>${b.work_item_id ? `<a href="/item/${b.work_item_id}">#${b.work_item_id}</a>` : ""}</td>
      <td><form method="post" action="/blocks/${b.id}/unblock"><button class="mini">${esc(t(lang, "unblock"))}</button></form></td>
    </tr>`).join("");
  res.send(page(t(lang, "blocks_title"), req.user, `
    <h2>${esc(t(lang, "blocks_title"))}</h2>
    <p class="muted">${esc(t(lang, "blocks_explain"))}</p>
    ${rows.length
      ? `<table><tr><th>${esc(t(lang, "col_sender_b"))}</th><th>${esc(t(lang, "col_kind_b"))}</th><th>${esc(t(lang, "col_by_b"))}</th><th>${esc(t(lang, "col_when_b"))}</th><th>${esc(t(lang, "col_item_b"))}</th><th></th></tr>${trs}</table>`
      : `<p class="muted">${esc(t(lang, "blocks_none"))}</p>`}`));
});

app.post("/blocks/:id/unblock", (req, res) => {
  const b = db.prepare("SELECT * FROM sender_blocks WHERE id = ?").get(req.params.id);
  if (b) {
    db.prepare("DELETE FROM sender_blocks WHERE id = ?").run(b.id);
    audit(req.user.tailscale_login, "sender_unblocked", b.work_item_id || null, `${b.pattern} (${b.kind})`);
  }
  res.redirect("/blocks");
});

// Audit log viewer (admin only). Searchable over the WHOLE table (not just the newest 500):
// free text runs a parameterised LIKE across user/action/detail (wildcards escaped, so input
// is matched literally), combinable with an action-type dropdown and a work-item filter.
// Results stay capped at the newest 500 matches. The search itself is audit-logged.
app.get("/audit", (req, res) => {
  if (req.user.role !== "admin") {
    audit(req.user.tailscale_login, "audit_denied", null, null);
    return res.status(403).send(page("Forbidden", req.user, "<p>Admins only.</p>"));
  }
  const q = String(req.query.q || "").trim().slice(0, 100);
  const act = String(req.query.action || "").trim().slice(0, 60);
  const item = parseInt(String(req.query.item || ""), 10) || 0;
  audit(req.user.tailscale_login, "view_audit", null,
    (q || act || item) ? `q=${q || "-"} action=${act || "-"} item=${item || "-"}` : null);

  const conds = [], params = [];
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    conds.push("(user LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR COALESCE(detail, '') LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (act) { conds.push("action = ?"); params.push(act); }
  if (item) { conds.push("work_item_id = ?"); params.push(item); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT 500`).all(...params);
  const actionNames = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);

  const opts = ['<option value="">(any action)</option>']
    .concat(actionNames.map((a) => `<option value="${esc(a)}"${a === act ? " selected" : ""}>${esc(a)}</option>`)).join("");
  const form = `<form method="get" action="/audit" style="margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input name="q" value="${esc(q)}" placeholder="Search user, action or detail&hellip;" style="width:18em">
      <select name="action">${opts}</select>
      <input name="item" value="${item || ""}" inputmode="numeric" placeholder="Item #" style="width:6em">
      <button class="mini">Search</button>${(q || act || item) ? ` <a href="/audit">Clear</a>` : ""}
    </form>`;
  const trs = rows.map((r) => `<tr><td>${r.id}</td><td class="muted">${esc(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td>${r.work_item_id ? `<a href="/item/${r.work_item_id}">#${r.work_item_id}</a>` : ""}</td><td class="muted">${esc(r.detail || "")}</td></tr>`).join("");
  const note = (q || act || item)
    ? `${rows.length} match(es)${rows.length === 500 ? " — newest 500 shown, narrow the search for older entries" : ""}, newest first. Times are UTC.`
    : "Last 500 entries, newest first. Times are UTC.";
  res.send(page("Audit", req.user, `${form}<p class="muted">${esc(note)}</p><table><tr><th>#</th><th>When</th><th>User</th><th>Action</th><th>Item</th><th>Detail</th></tr>${trs}</table>`));
});

app.listen(PORT, BIND_IP, () => {
  console.log(`Axle web listening on ${BIND_IP}:${PORT} (loopback; fronted by Tailscale Serve)`);
});

