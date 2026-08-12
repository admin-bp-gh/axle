// views/ui.js - Axle's shared view layer: esc(), the STRINGS i18n dictionary (EN/NL,
// parity-tested), label + timestamp formatting, untrusted-email rendering (linkify /
// quoted-history folding) and the page() layout shell.
// Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10): presentation
// helpers only - no routes, no DB access, no network. Server-side rendering stays
// authoritative; everything is escaped here exactly as before.
const rulesets = require("../rules.js");

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- i18n: Axle's own wording, per UI language --------------------------------
// Customer content (emails, drafts) is NOT here — that is translated on demand by
// translate.js. This dictionary covers only the chrome Axle itself authors.
const UI_LANGS = ["en", "nl"];
const DEFAULT_LANG = "en";
const langOK = (l) => (UI_LANGS.includes(l) ? l : DEFAULT_LANG);

const STRINGS = {
  en: {
    inbox: "Inbox", audit: "Audit",
    // The mailbox filter is named after the LOCATION the team works in, not the address:
    // everyone says "Gouda" and "Drachten", never "info@". The query value stays 'info'.
    mailbox: "Mailbox", status: "Status", all: "All", info: "Gouda", drachten: "Drachten",
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
    your_feedback: "Your answer & feedback",
    feedback_ph: "Answer the questions above and add anything else Axle should know — one reply covers it all.",
    feedback_none: "none", questions_for_you: "Questions for you", open_lc: "open", no_questions: "No questions.",
    answer: "Answer",
    save: "Save", save_redraft: "Save & redraft",
    redraft_hint: "redraft regenerates the reply with your input — runs in the background",
    actions: "Actions", mark_done: "Mark done", archive: "Archive", reopen: "Reopen",
    mark_phone: "Resolved by phone",
    done_tip: "The work is completed (close the item)",
    phone_tip: "Completed without an email - e.g. you called the customer",
    archive_tip: "No action was needed (FYI / noise)",
    block_tip: "Stop future emails from this sender appearing in Axle",
    res_replied: "replied", res_done: "completed", res_phone: "by phone", res_no_action: "no action needed",
    res_outlook: "handled in Outlook", res_forwarded: "handed over",
    nav_blocks: "Blocked",
    block_sender: "Block sender", block_title: "Block this sender",
    block_explain: "Future emails from this sender will no longer appear in Axle. They still arrive in the shared mailbox in Outlook. The block applies to both info@ and drachten@, and can be undone at any time on the Blocked page.",
    block_addr_opt: "Address to block",
    block_sap_warn: "Careful - this address matches a SAP customer:",
    block_sap_none: "No SAP customer matches this address.",
    block_sap_unknown: "Could not check SAP for this address.",
    block_confirm_btn: "Block and archive this email", block_back: "Cancel",
    blocks_title: "Blocked senders", blocks_none: "No blocked senders.", unblock: "Unblock",
    blocks_explain: "Emails from these senders are ignored by Axle (they still arrive in Outlook). Anyone on the team can unblock; every change is audited.",
    col_sender_b: "Sender", col_kind_b: "Scope", col_by_b: "Blocked by", col_when_b: "When", col_item_b: "From item",
    copy_draft: "Copy draft", copied: "Copied to clipboard", send_reply_to: "Send reply to", send_now: "Send now",
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
    uploading: "Uploading…",
    sync_now: "Sync now", syncing: "Syncing…", last_synced: "Last synced", never: "never",
    sync_started: "Sync started — new emails appear shortly.",
    scope_label: "Items", scope_mine: "Assigned to me",
    // Compose ("New email")
    compose_new: "New email", compose_title: "Compose a new email",
    compose_who: "Who is this customer?", compose_who_ph: "Customer code, email, order #, invoice # or name",
    compose_find: "Find customer", compose_finding: "Looking up…",
    compose_scenario: "Quick start (optional)", compose_instruction: "What should the email say?",
    compose_instruction_ph: "Two ways to work: tell Axle in plain language what to write and it researches the facts and drafts it (use Draft) — or just write the email yourself and send it as-is (use Send now).",
    compose_subject: "Subject", compose_subject_ph: "Subject line (needed to send now)",
    compose_language: "Language", compose_lang_auto: "Auto", compose_from: "Send from",
    compose_create: "Draft", compose_send_now: "Send now", compose_creating: "Drafting…", compose_sending: "Sending…", compose_cancel: "Cancel",
    compose_need_subject: "Add a subject line to send now.",
    compose_send_confirm: "Send this email now to {to}?",
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
    // {owner}/{address}: handing an item to someone who works a different mailbox forwards the
    // email there and closes this item, so the confirm has to say both things plainly.
    owner_handover_confirm: "Hand this email over to {owner}?\n\nIt will be forwarded to {address} and closed here.",
    owner_handover_hint: "forwards the email and closes this item",
    attach_doc_title: "Attach SAP document", attach_doc_hint: "Attach the standard SAP/Boyum print PDF of a referenced document to this email.",
    attach_doc_type: "Type", attach_doc_number: "Number", attach_doc_btn: "Attach PDF",
    attach_doc_none: "No document with that number.", attach_doc_ambiguous: "Several documents share that number - pick one:",
    attach_doc_scope_warn: "This document belongs to a different customer than this email.",
    attach_doc_doc_cust: "Document customer", attach_doc_email_cust: "Email customer",
    attach_doc_scope_confirm: "Attach anyway", attach_doc_render_failed: "Could not generate the PDF.",
    attach_doc_compose_only: "PDF attach isn't available on this item.",
    doc_order: "Order", doc_invoice: "Invoice", doc_quotation: "Quotation", doc_delivery: "Delivery", doc_creditnote: "Credit note",
    sugg_title: "Suggested documents", sugg_hint: "Documents this email seems to reference, found in SAP. Review and attach the ones you want — nothing is attached or sent automatically.",
    suggest_close_chip: "No reply needed?", suggest_close_title: "Axle suggests no email reply is needed. Review it and mark it Done if you agree — nothing closes automatically.",
    sugg_add: "Attach", sugg_ref: "mentioned as", sugg_pick: "Several documents share this number — pick one:",
    sugg_other_cust: "Different customer — review before attaching", sugg_other_cust_hint: "These numbers were in the email but resolve to another customer's document. Attaching one needs an explicit confirm.",
    sugg_review: "Review", sugg_preview: "Preview", sugg_preview_title: "Open the document PDF in a new tab — nothing is attached.",
    cust_card_title: "Customer", cust_tier: "Discount tier", cust_open_orders: "Open orders", cust_open_invoices: "Open invoices",
    cust_view_full: "View full customer", cust_detail_title: "Customer overview", cust_close: "Close", cust_loading: "Loading…",
    cust_lifetime: "Lifetime invoiced", cust_12m: "Last 12 months", cust_balance: "Account balance", cust_since: "Customer since", cust_last_order: "Last order",
    cust_recent_orders: "Recent orders", cust_recent_invoices: "Recent invoices", cust_no_customer: "Not a known SAP customer.", cust_load_error: "Could not load customer details.",
    cust_frozen: "On hold", cust_open: "Open", cust_closed: "Closed", cust_paid: "Paid", cust_unpaid: "Unpaid", cust_none: "None",
    col_doc: "Doc", col_date: "Date", col_total: "Total", col_status: "Status",
    contactform_chip: "Contact form", contactform_draft_only: "Contact-form message — the customer's address is in the body, not the sender. Reply via Compose or Outlook; in-thread Send is disabled.",
    contactform_send_blocked: "In-thread Send is disabled for contact-form messages (the sender is Shopify's mailer, not the customer). Use Compose or Outlook.",
    cf_customer_label: "Contact-form customer", cf_pick: "Choose the address to reply to:",
    cf_from_form: "from the form", cf_on_file: "on file in SAP",
    cf_confirm_to: "Confirm recipient", cf_to_confirmed: "Recipient confirmed", cf_change: "Change recipient",
    cf_no_address: "No usable customer address was found in this message — it can't be answered here yet.",
    cf_matched: "Matched in SAP", cf_not_matched: "No SAP match — replying to the address from the form.",
    cf_order: "Order", cf_recipient_rejected: "That address is not one of the resolved options — pick one of the listed addresses.",
    recip_bad_address: "That isn't a single valid email address. Enter one address, with no commas, semicolons or angle brackets.",
    recip_change: "Change recipient", recip_other: "Other address…", recip_use: "Use address",
    recip_from_sender: "sender", recip_on_file: "on file", recip_from_form: "from form", recip_typed: "typed",
    recip_typed_confirm: "{to} is not one of {customer}'s known addresses. Send there anyway?",
    recip_changed_pill: "changed", recip_changed_title: "This reply is going somewhere other than the default address.",
    recip_current: "Currently sending to", recip_confirm_btn: "Confirm recipient", recip_none_yet: "no recipient yet",
    recip_confirm_hint: "Choose the recipient in the Send button below before this can be sent.",
    recip_this_customer: "this customer",
    cf_send_not_enabled: "Recipient confirmed. Sending contact-form replies isn't enabled yet (action #4 off).",
    cf_confirm_first: "Confirm the recipient above before this can be sent.",
    cf_subject: "Subject", cf_subject_hint: "This is a new email to the customer — set the subject they'll see.",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Reset to AI draft", reset_ai_confirm: "Replace your current text with the original AI draft?",
    show_translation: "Show translation", hide_translation: "Hide translation",
    earlier_msgs: "Earlier in this conversation", footer_fold: "Signature & footer",
    inline_image: "inline image", more_actions: "More actions",
    sap_docs: "SAP documents", attach_manual: "Attach by number",
    relang_note: "Changing the language re-drafts the email.",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Select an item from the list to start.",
    load_error: "This could not be loaded. Pick the item again or reload the page — if it keeps failing, the audit log has the details.",
    live_updated: "Live · updated {t}",
    filter_btn: "Filter",
    sort_label: "Sort",
    sort_needs: "Needs me first", sort_new: "Newest first", sort_old: "Oldest first", sort_prio: "Priority first",
    // Sprocket — the in-app helper (floating cog + chat panel)
    sprocket_tagline: "Axle helper",
    sprocket_open: "Open Sprocket, the Axle helper",
    sprocket_close: "Close",
    sprocket_greeting: "Hi, I'm Sprocket — your Axle helper. Ask me how to do anything in Axle.",
    sprocket_ph: "How do I…?",
    sprocket_send: "Send",
    sprocket_thinking: "Sprocket's looking that up…",
    sprocket_error: "Sorry — something went wrong. Please try again.",
    sprocket_dupe_note: "Good news — someone else has asked for this too, so I've added your vote to it.",
    sprocket_dupe_note_self: "Looks like this matches one you've already logged — I've kept it on the existing request rather than adding a duplicate.",
    sprocket_requests_nav: "Requests",
    sprocket_new_badge: "New, un-reviewed requests",
    sprocket_requests_title: "Feature requests",
    sprocket_requests_hint: "Captured by Sprocket. The .jsonl / .md files on the box are the source of truth — edit status and notes there.",
    sprocket_no_requests: "No requests yet.",
    sprocket_votes: "vote(s)",
    sprocket_f_today: "Today", sprocket_f_freq: "Frequency", sprocket_f_impact: "Impact",
    sprocket_f_example: "Example", sprocket_f_also: "Also asked by", sprocket_f_notes: "Notes",
    sprocket_status_new: "New", sprocket_status_approved: "Approved", sprocket_status_in_progress: "In progress",
    sprocket_status_done: "Done", sprocket_status_declined: "Declined",
  },
  nl: {
    inbox: "Postvak", audit: "Audit",
    mailbox: "Mailbox", status: "Status", all: "Alle", info: "Gouda", drachten: "Drachten",
    // NB "archived" is the FILTER-TAB label only (chips use STATUS_LABEL) — kept short so the
    // counted NL tabs fit the queue pane.
    open: "Open", done: "Afgehandeld", archived: "Archief", search_emails: "Zoek e-mails…", of: "van",
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
    your_feedback: "Jouw antwoord & feedback",
    feedback_ph: "Beantwoord de vragen hierboven en voeg toe wat Axle verder moet weten — alles in één reactie.",
    feedback_none: "geen", questions_for_you: "Vragen voor jou", open_lc: "open", no_questions: "Geen vragen.",
    answer: "Antwoord",
    save: "Opslaan", save_redraft: "Opslaan & opnieuw opstellen",
    redraft_hint: "opnieuw opstellen genereert het antwoord met jouw invoer — draait op de achtergrond",
    actions: "Acties", mark_done: "Markeer afgehandeld", archive: "Archiveer", reopen: "Heropen",
    mark_phone: "Telefonisch afgehandeld",
    done_tip: "Het werk is afgerond (item sluiten)",
    phone_tip: "Afgerond zonder e-mail - bv. de klant gebeld",
    archive_tip: "Geen actie nodig (ter info / ruis)",
    block_tip: "Toekomstige e-mails van deze afzender niet meer in Axle tonen",
    res_replied: "beantwoord", res_done: "afgerond", res_phone: "telefonisch", res_no_action: "geen actie nodig",
    res_outlook: "afgehandeld in Outlook", res_forwarded: "overgedragen",
    nav_blocks: "Geblokkeerd",
    block_sender: "Blokkeer afzender", block_title: "Deze afzender blokkeren",
    block_explain: "Toekomstige e-mails van deze afzender verschijnen niet meer in Axle. Ze komen nog wel aan in de gedeelde mailbox in Outlook. De blokkade geldt voor info@ en drachten@, en is altijd terug te draaien op de pagina Geblokkeerd.",
    block_addr_opt: "Te blokkeren adres",
    block_sap_warn: "Let op - dit adres hoort bij een SAP-klant:",
    block_sap_none: "Geen SAP-klant met dit adres.",
    block_sap_unknown: "Kon SAP niet controleren voor dit adres.",
    block_confirm_btn: "Blokkeer en archiveer deze e-mail", block_back: "Annuleren",
    blocks_title: "Geblokkeerde afzenders", blocks_none: "Geen geblokkeerde afzenders.", unblock: "Deblokkeer",
    blocks_explain: "E-mails van deze afzenders worden door Axle genegeerd (ze komen nog wel aan in Outlook). Iedereen in het team kan deblokkeren; elke wijziging wordt gelogd.",
    col_sender_b: "Afzender", col_kind_b: "Bereik", col_by_b: "Geblokkeerd door", col_when_b: "Wanneer", col_item_b: "Uit item",
    copy_draft: "Kopieer concept", copied: "Gekopieerd", send_reply_to: "Verstuur antwoord naar", send_now: "Nu versturen",
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
    uploading: "Uploaden…",
    sync_now: "Nu synchroniseren", syncing: "Synchroniseren…", last_synced: "Laatst gesynchroniseerd", never: "nooit",
    sync_started: "Synchronisatie gestart — nieuwe e-mails verschijnen zo.",
    scope_label: "Items", scope_mine: "Aan mij",
    // Compose ("Nieuwe e-mail")
    compose_new: "Nieuwe e-mail", compose_title: "Nieuwe e-mail opstellen",
    compose_who: "Welke klant is dit?", compose_who_ph: "Klantcode, e-mail, order #, factuur # of naam",
    compose_find: "Klant zoeken", compose_finding: "Opzoeken…",
    compose_scenario: "Snelstart (optioneel)", compose_instruction: "Wat moet de e-mail zeggen?",
    compose_instruction_ph: "Twee manieren: vertel Axle in gewone taal wat het moet schrijven — Axle zoekt de feiten op en stelt het op (gebruik Concept) — of schrijf de e-mail zelf en verstuur hem zoals hij is (gebruik Nu versturen).",
    compose_subject: "Onderwerp", compose_subject_ph: "Onderwerpregel (nodig om nu te versturen)",
    compose_language: "Taal", compose_lang_auto: "Auto", compose_from: "Verzenden vanaf",
    compose_create: "Concept", compose_send_now: "Nu versturen", compose_creating: "Opstellen…", compose_sending: "Versturen…", compose_cancel: "Annuleren",
    compose_need_subject: "Voeg een onderwerpregel toe om nu te versturen.",
    compose_send_confirm: "Deze e-mail nu versturen naar {to}?",
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
    owner_handover_confirm: "Deze e-mail overdragen aan {owner}?\n\nHij wordt doorgestuurd naar {address} en hier afgesloten.",
    owner_handover_hint: "stuurt de e-mail door en sluit dit item",
    attach_doc_title: "SAP-document bijvoegen", attach_doc_hint: "Voeg de standaard SAP/Boyum print-PDF van een document toe aan deze e-mail.",
    attach_doc_type: "Type", attach_doc_number: "Nummer", attach_doc_btn: "PDF bijvoegen",
    attach_doc_none: "Geen document met dat nummer.", attach_doc_ambiguous: "Meerdere documenten met dat nummer - kies er een:",
    attach_doc_scope_warn: "Dit document hoort bij een andere klant dan deze e-mail.",
    attach_doc_doc_cust: "Klant van document", attach_doc_email_cust: "Klant van e-mail",
    attach_doc_scope_confirm: "Toch bijvoegen", attach_doc_render_failed: "Kon de PDF niet genereren.",
    attach_doc_compose_only: "PDF bijvoegen is niet beschikbaar bij dit item.",
    doc_order: "Order", doc_invoice: "Factuur", doc_quotation: "Offerte", doc_delivery: "Levering", doc_creditnote: "Creditnota",
    sugg_title: "Voorgestelde documenten", sugg_hint: "Documenten waarnaar deze e-mail lijkt te verwijzen, gevonden in SAP. Bekijk en voeg toe wat u wilt — er wordt niets automatisch bijgevoegd of verzonden.",
    suggest_close_chip: "Geen antwoord nodig?", suggest_close_title: "Axle stelt voor dat geen e-mailantwoord nodig is. Beoordeel het item en markeer het als gereed als u het ermee eens bent — er wordt niets automatisch gesloten.",
    sugg_add: "Bijvoegen", sugg_ref: "genoemd als", sugg_pick: "Meerdere documenten met dit nummer — kies er een:",
    sugg_other_cust: "Andere klant — controleer voor bijvoegen", sugg_other_cust_hint: "Deze nummers stonden in de e-mail maar horen bij het document van een andere klant. Bijvoegen vereist een expliciete bevestiging.",
    sugg_review: "Bekijken", sugg_preview: "Voorbeeld", sugg_preview_title: "Open de document-PDF in een nieuw tabblad — er wordt niets bijgevoegd.",
    cust_card_title: "Klant", cust_tier: "Kortingsniveau", cust_open_orders: "Openstaande orders", cust_open_invoices: "Openstaande facturen",
    cust_view_full: "Volledige klant bekijken", cust_detail_title: "Klantoverzicht", cust_close: "Sluiten", cust_loading: "Laden…",
    cust_lifetime: "Totaal gefactureerd", cust_12m: "Laatste 12 maanden", cust_balance: "Accountsaldo", cust_since: "Klant sinds", cust_last_order: "Laatste order",
    cust_recent_orders: "Recente orders", cust_recent_invoices: "Recente facturen", cust_no_customer: "Geen bekende SAP-klant.", cust_load_error: "Kon klantgegevens niet laden.",
    cust_frozen: "Geblokkeerd", cust_open: "Open", cust_closed: "Afgesloten", cust_paid: "Betaald", cust_unpaid: "Onbetaald", cust_none: "Geen",
    col_doc: "Doc", col_date: "Datum", col_total: "Totaal", col_status: "Status",
    contactform_chip: "Contactformulier", contactform_draft_only: "Contactformulier-bericht — het e-mailadres van de klant staat in de tekst, niet bij de afzender. Beantwoord via Opstellen of Outlook; verzenden in thread is uitgeschakeld.",
    contactform_send_blocked: "Verzenden in thread is uitgeschakeld voor contactformulier-berichten (de afzender is de mailer van Shopify, niet de klant). Gebruik Opstellen of Outlook.",
    cf_customer_label: "Contactformulier-klant", cf_pick: "Kies het adres om op te antwoorden:",
    cf_from_form: "uit het formulier", cf_on_file: "bekend in SAP",
    cf_confirm_to: "Ontvanger bevestigen", cf_to_confirmed: "Ontvanger bevestigd", cf_change: "Ontvanger wijzigen",
    cf_no_address: "Geen bruikbaar klantadres gevonden in dit bericht — kan hier nog niet beantwoord worden.",
    cf_matched: "Gekoppeld in SAP", cf_not_matched: "Geen SAP-koppeling — antwoord naar het adres uit het formulier.",
    cf_order: "Order", cf_recipient_rejected: "Dat adres is geen van de gevonden opties — kies een van de getoonde adressen.",
    recip_bad_address: "Dat is geen geldig e-mailadres. Vul één adres in, zonder komma's, puntkomma's of punthaken.",
    recip_change: "Ontvanger wijzigen", recip_other: "Ander adres…", recip_use: "Adres gebruiken",
    recip_from_sender: "afzender", recip_on_file: "bekend adres", recip_from_form: "uit formulier", recip_typed: "ingetypt",
    recip_typed_confirm: "{to} is geen bekend adres van {customer}. Toch daarheen versturen?",
    recip_changed_pill: "gewijzigd", recip_changed_title: "Dit antwoord gaat naar een ander adres dan het standaardadres.",
    recip_current: "Wordt nu verstuurd naar", recip_confirm_btn: "Ontvanger bevestigen", recip_none_yet: "nog geen ontvanger",
    recip_confirm_hint: "Kies hieronder in de Verstuur-knop de ontvanger voordat dit verstuurd kan worden.",
    recip_this_customer: "deze klant",
    cf_send_not_enabled: "Ontvanger bevestigd. Versturen van contactformulier-antwoorden is nog niet ingeschakeld (actie #4 uit).",
    cf_confirm_first: "Bevestig eerst de ontvanger hierboven voordat dit verstuurd kan worden.",
    cf_subject: "Onderwerp", cf_subject_hint: "Dit is een nieuwe e-mail aan de klant — stel het onderwerp in dat de klant ziet.",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Terug naar AI-concept", reset_ai_confirm: "Je huidige tekst vervangen door het originele AI-concept?",
    show_translation: "Toon vertaling", hide_translation: "Verberg vertaling",
    earlier_msgs: "Eerder in dit gesprek", footer_fold: "Handtekening & voettekst",
    inline_image: "afbeelding in tekst", more_actions: "Meer acties",
    sap_docs: "SAP-documenten", attach_manual: "Bijvoegen op nummer",
    relang_note: "Een andere taal stelt de e-mail opnieuw op.",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Kies een item uit de lijst om te beginnen.",
    load_error: "Dit kon niet worden geladen. Kies het item opnieuw of herlaad de pagina — blijft het misgaan, dan staan de details in het auditlog.",
    live_updated: "Live · bijgewerkt {t}",
    filter_btn: "Filter",
    sort_label: "Sorteren",
    sort_needs: "Actie eerst", sort_new: "Nieuwste eerst", sort_old: "Oudste eerst", sort_prio: "Prioriteit eerst",
    // Sprocket — de in-app hulp (zwevende tandwielknop + chatvenster)
    sprocket_tagline: "Axle-hulp",
    sprocket_open: "Open Sprocket, de Axle-hulp",
    sprocket_close: "Sluiten",
    sprocket_greeting: "Hoi, ik ben Sprocket — je Axle-hulp. Vraag me hoe je iets in Axle doet.",
    sprocket_ph: "Hoe doe ik…?",
    sprocket_send: "Versturen",
    sprocket_thinking: "Sprocket zoekt het even op…",
    sprocket_error: "Sorry — er ging iets mis. Probeer het opnieuw.",
    sprocket_dupe_note: "Goed nieuws — iemand anders heeft hier ook om gevraagd, dus ik heb jouw stem eraan toegevoegd.",
    sprocket_dupe_note_self: "Dit lijkt op een verzoek dat je al hebt ingediend — ik heb het bij het bestaande verzoek gehouden in plaats van een duplicaat aan te maken.",
    sprocket_requests_nav: "Verzoeken",
    sprocket_new_badge: "Nieuwe, nog niet bekeken verzoeken",
    sprocket_requests_title: "Functieverzoeken",
    sprocket_requests_hint: "Vastgelegd door Sprocket. De .jsonl / .md-bestanden op de box zijn leidend — pas status en notities daar aan.",
    sprocket_no_requests: "Nog geen verzoeken.",
    sprocket_votes: "stem(men)",
    sprocket_f_today: "Nu", sprocket_f_freq: "Frequentie", sprocket_f_impact: "Impact",
    sprocket_f_example: "Voorbeeld", sprocket_f_also: "Ook gevraagd door", sprocket_f_notes: "Notities",
    sprocket_status_new: "Nieuw", sprocket_status_approved: "Goedgekeurd", sprocket_status_in_progress: "In behandeling",
    sprocket_status_done: "Klaar", sprocket_status_declined: "Afgewezen",
  },
};
const t = (lang, k) => (STRINGS[lang] && STRINGS[lang][k] != null) ? STRINGS[lang][k]
  : (STRINGS.en[k] != null ? STRINGS.en[k] : k);

// --- labels that depend on a controlled vocabulary, per language ---------------
const titleCase = (s) => String(s == null ? "" : s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// Step 2 (F2): action-state vocabulary — each label names what the USER does next,
// not Axle's internal state ("Needs your answer", not "Awaiting input"). Same keys,
// same routes; rename only. statusWithRes still appends the resolution reason.
const STATUS_LABEL = {
  en: { new: "New", investigating: "Drafting…", awaiting_input: "Needs your answer", ready: "Ready to send", done: "Done", archived: "Archived" },
  nl: { new: "Nieuw", investigating: "Wordt opgesteld…", awaiting_input: "Jouw antwoord nodig", ready: "Klaar om te versturen", done: "Afgehandeld", archived: "Gearchiveerd" },
};
const statusLabel = (lang, s) => (STATUS_LABEL[lang] && STATUS_LABEL[lang][s]) || STATUS_LABEL.en[s] || titleCase(s);
// "Done · by phone" / "Archived · no action needed": the status label plus the recorded
// resolution reason (work_items.resolution), when one is set. Legacy closed items have none.
// A resolution records HOW an item was CLOSED, so it is meaningless on an open one and is not
// rendered there — belt to the braces of ingest.js clearing it on reopen. Without this guard an
// item reopened before that fix went in keeps showing e.g. "Needs your answer · handled in
// Outlook", which reads like a contradiction. (2026-08-06.)
const statusWithRes = (lang, w) =>
  statusLabel(lang, w.status) +
  (w.resolution && (w.status === "done" || w.status === "archived") ? " · " + t(lang, "res_" + w.resolution) : "");
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
  en: { en: "English", nl: "Dutch", de: "German", fr: "French", es: "Spanish", other: "another language" },
  nl: { en: "Engels", nl: "Nederlands", de: "Duits", fr: "Frans", es: "Spaans", other: "een andere taal" },
};
const langDisplay = (uiLang, code) => (LANG_DISPLAY[uiLang] && LANG_DISPLAY[uiLang][code]) || code || "?";

// Drachten has no fixed owner (Rob & Huub share it); show the mailbox name as the owner.
const ownerLabel = (w) => w.owner || (w.mailbox === "drachten" ? "Drachten" : "—");

// Valid reassignment targets for an item, derived from its mailbox's routing rules' own
// owner labels (rules.js stays the single source of truth for who works a mailbox), so a
// reassign can only ever produce a label the inbox "mine" queues already understand.
// 'reassignOnly' labels are offered too: owners a human may hand an item to that no rule assigns
// automatically (info@'s Tom — purchasing is worked in Outlook, so nothing routes to him, but
// sales can still pass him something deliberately). rules.js remains the single source of truth.
const ownerChoices = (mailbox) => {
  const rs = rulesets[mailbox] || {};
  const fromRules = (rs.rules || []).map((r) => r.owner);
  return [...new Set(fromRules.concat(rs.reassignOnly || []).filter(Boolean))].sort();
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
// --- Step-1 presentation helpers: chip menus + conversation timeline ------------

// A chip that IS the control (F5): click the chip, get a dropdown, one click posts
// the change through the existing audited route. Pure <details> + a form per menu —
// still works without JS; the small script in page() closes open menus on an
// outside click. `chipHtml` is provided pre-escaped by the caller.
// An option may carry `confirm`: a prompt shown before the form posts. It is rendered into
// data-confirm and read via dataset by the shared handler at the bottom of the page script -
// as DATA, never as JavaScript source (see the long note there; interpolating a translated
// string into JS inside an attribute silently disables the confirmation).
function chipMenu({ chipClass, chipHtml, title, action, field, options, current, note }) {
  const items = options.map((o) =>
    `<button name="${esc(field)}" value="${esc(o.value)}"${o.value === current ? ' class="on"' : ""}${o.confirm ? ` data-confirm="${esc(o.confirm)}"` : ""}>${esc(o.label)}</button>`).join("");
  return `<details class="chipmenu"><summary title="${esc(title)}"><span class="chip ${chipClass}">${chipHtml}<span class="caret">&#9662;</span></span></summary>
<form method="post" action="${action}" class="chipmenu-list">${items}${note ? `<div class="menunote">${esc(note)}</div>` : ""}</form></details>`;
}

// Render-side folding for the conversation timeline (F7). The regexes mirror the
// patterns engine.js classify() folds for language detection — duplicated here on
// purpose: classify() must not change, and presentation must never feed it.
const FOOTER_LINE = /confidential|vertraulich|disclaimer|privileged|bestimmt sind|intended (only|solely|for)|unauthori[sz]ed use/i;
const SEG_MARKERS = [
  /^\s*-{2,}\s*(Original Message|Oorspronkelijk bericht|Ursprüngliche Nachricht|Forwarded message|Doorgestuurd bericht)/i,
  /^\s*(From|Van|Von|Fra|Från)\s*:\s.+@/i,
  /^\s*(On|Am|Op)\s.+\s(wrote|schrieb|schreef)\b/i,
  /<[^>]+@[^>]+>\s*(wrote|schrieb|schreef)\b/i,
];

// Split the newest message's own text from its legal footer. Folded, never dropped.
function foldFooter(text) {
  const lines = String(text || "").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) if (FOOTER_LINE.test(lines[i])) { cut = i; break; }
  if (cut < 1) return { main: String(text || ""), footer: "" };
  return { main: lines.slice(0, cut).join("\n").replace(/\s+$/, ""), footer: lines.slice(cut).join("\n") };
}

// Split quoted history into individual messages where marker lines allow (capped at
// 9 + remainder); falls back to one block. Display-only — nothing is dropped.
function segmentQuoted(quoted) {
  const lines = String(quoted || "").split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*>/.test(lines[i]) && SEG_MARKERS.some((re) => re.test(lines[i]))) starts.push(i);
  }
  if (!starts.length) return [String(quoted || "")];
  const cut = starts.slice(0, 9);
  if (cut[0] !== 0) cut.unshift(0);
  const segs = [];
  for (let s = 0; s < cut.length; s++) {
    const seg = lines.slice(cut[s], s + 1 < cut.length ? cut[s + 1] : lines.length).join("\n").trim();
    if (seg) segs.push(seg);
  }
  return segs.length ? segs : [String(quoted || "")];
}

// The conversation timeline (F7): newest customer message as an open card (footer
// folded, [cid:] tokens replaced by a readable marker, optional translation behind
// a toggle), older messages collapsed beneath as individual quoted cards.
// emailTrPending (UX round): the translation isn't cached yet - render the toggle
// and a spinner placeholder; the item page's background fetch fills it in.
function renderTimeline(w, lang, emailTr, emailTrPending) {
  const raw = String(w.email_text || "");
  if (!raw.trim()) return `<pre class="mail">${esc(t(lang, "body_not_stored"))}</pre>`;
  const imgMark = "[\u{1F4F7} " + t(lang, "inline_image") + "]";
  const clean = (s) => String(s)
    .replace(/\[cid:[^\]]*\]/gi, imgMark)
    .replace(/^\s*(Inline-Bild|Inline image|Afbeelding)\s*$/gim, imgMark);
  const { top, quoted } = splitQuoted(raw);
  const { main, footer } = foldFooter(top);
  const who = w.sender_name || w.sender_email || "";
  let html = `<div class="msg">
    <div class="msg-head"><span class="who-line"><b>${esc(who)}</b><span class="muted">${esc(fmtDateTime(w.email_received, lang))}</span></span>${emailTr || emailTrPending ? `<button type="button" class="mini" id="emailtrbtn" onclick="toggleEmailTr()">${esc(t(lang, "show_translation"))}</button>` : ""}</div>
    <pre class="mail">${linkify(clean(main))}</pre>
    ${footer ? `<details class="fold"><summary>${esc(t(lang, "footer_fold"))}</summary><pre class="mail muted">${linkify(clean(footer))}</pre></details>` : ""}
    ${emailTr || emailTrPending ? `<div class="trbox msgtr" id="emailtr" style="display:none"><p class="muted trnote">${esc(t(lang, "translation_note").replace("{lang}", langDisplay(lang, (w.language || "").toLowerCase())))}</p><pre class="mail" id="emailtrpre"${emailTrPending ? ' data-pending="1"' : ""}>${emailTr ? linkify(String(emailTr)) : `<span class="spin"></span> ${esc(t(lang, "translating"))}`}</pre></div>` : ""}
  </div>`;
  if (quoted) {
    const segs = segmentQuoted(quoted);
    const n = quoted.split("\n").length;
    html += `<details class="fold older"><summary>${esc(t(lang, "earlier_msgs"))} (${n} ${esc(t(lang, "lines"))})</summary>
      ${segs.map((s) => `<div class="msg quoted"><pre class="mail">${linkify(clean(s))}</pre></div>`).join("")}</details>`;
  }
  return html;
}
// -------------------------------------------------------------------------------

// --- Sprocket: the in-app helper widget -----------------------------------------
// A floating circular cog button fixed bottom-right on EVERY page (it sits outside
// #workpane, so htmx swaps never touch it). Click toggles a small chat panel that POSTs
// to /sprocket/ask and renders the answer. Self-contained: markup + a single IIFE here,
// styles in components.css. Read-only/log-only — the panel only asks Sprocket questions.
// All rendered text goes in via textContent in the script (never innerHTML), so a model
// answer can't inject markup; the greeting/labels below are esc()'d for the HTML context.
const SP_COG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
function sprocketWidget(lang) {
  const S = JSON.stringify({ thinking: t(lang, "sprocket_thinking"), error: t(lang, "sprocket_error") });
  return `<div id="sprocket" class="sprocket" data-open="0">
  <button type="button" class="sprocket-fab" id="sprocketFab" aria-label="${esc(t(lang, "sprocket_open"))}" aria-expanded="false">${SP_COG}</button>
  <section class="sprocket-panel" id="sprocketPanel" role="dialog" aria-label="Sprocket" hidden>
    <header class="sp-head"><span class="sp-title">${SP_COG}<span>Sprocket</span><span class="sp-tag">${esc(t(lang, "sprocket_tagline"))}</span></span>
      <button type="button" class="sp-close" id="sprocketClose" aria-label="${esc(t(lang, "sprocket_close"))}">&times;</button></header>
    <div class="sp-log" id="sprocketLog" aria-live="polite"><div class="sp-msg sp-bot">${esc(t(lang, "sprocket_greeting"))}</div></div>
    <form class="sp-input" id="sprocketForm">
      <textarea id="sprocketQ" rows="1" placeholder="${esc(t(lang, "sprocket_ph"))}" aria-label="${esc(t(lang, "sprocket_ph"))}"></textarea>
      <button type="submit" class="sp-send" id="sprocketSend" aria-label="${esc(t(lang, "sprocket_send"))}">&#9654;</button>
    </form>
  </section>
</div>
<script>
(function () {
  var root = document.getElementById("sprocket"); if (!root) return;
  var S = ${S};
  var fab = document.getElementById("sprocketFab"), panel = document.getElementById("sprocketPanel"),
      form = document.getElementById("sprocketForm"), input = document.getElementById("sprocketQ"),
      log = document.getElementById("sprocketLog"), send = document.getElementById("sprocketSend"),
      closeBtn = document.getElementById("sprocketClose");
  var busy = false;
  function open(o) { panel.hidden = !o; root.setAttribute("data-open", o ? "1" : "0"); fab.setAttribute("aria-expanded", o ? "true" : "false"); if (o) setTimeout(function () { input.focus(); }, 0); }
  fab.addEventListener("click", function () { open(panel.hidden); });
  closeBtn.addEventListener("click", function () { open(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) open(false); });
  function addMsg(who, text) { var d = document.createElement("div"); d.className = "sp-msg " + (who === "you" ? "sp-you" : "sp-bot"); d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var q = input.value.trim(); if (!q) return;
    // Build the transcript so far (everything already in the log, minus any pending bubble) so the
    // intake can be multi-turn — the server stays stateless and the client holds the conversation.
    var prior = [];
    log.querySelectorAll(".sp-msg").forEach(function (el) {
      if (el.classList.contains("sp-pending")) return;
      prior.push({ role: el.classList.contains("sp-you") ? "you" : "bot", text: el.textContent });
    });
    addMsg("you", q); input.value = ""; grow();
    busy = true; send.disabled = true;
    var pend = addMsg("bot", S.thinking); pend.classList.add("sp-pending");
    fetch("/sprocket/ask", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ q: q, history: JSON.stringify(prior) }) })
      .then(function (r) { return r.json().catch(function () { return { error: S.error }; }); })
      .then(function (d) { pend.classList.remove("sp-pending"); pend.textContent = (d && d.answer) ? d.answer : (d && d.error) ? d.error : S.error; })
      .catch(function () { pend.classList.remove("sp-pending"); pend.textContent = S.error; })
      .finally(function () { busy = false; send.disabled = false; log.scrollTop = log.scrollHeight; input.focus(); });
  });
})();
</script>`;
}
// -------------------------------------------------------------------------------

// Bump on any assets/* change so browsers re-fetch (express.static serves the
// files; the query string only busts the cache).
const ASSET_V = "polaris14";   // 2026-08-12: withdrawn-draft card added then removed

// page(): the layout shell. opts.shell renders the full-width three-pane workspace
// (body becomes a fixed-height flex column; the panes scroll individually). htmx is
// vendored locally and loaded on every page — inert without hx- attributes, so the
// non-shell pages (blocks, audit, block-confirm) are unaffected. refreshOnHistoryMiss
// makes a back/forward without a cached snapshot do a plain full reload.
function page(title, user, body, refreshSec, opts) {
  const lang = langOK(user.lang);
  const isShell = !!(opts && opts.shell);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}
<title>${esc(title)} - Axle</title>
<link rel="stylesheet" href="/assets/tokens.css?v=${ASSET_V}">
<link rel="stylesheet" href="/assets/components.css?v=${ASSET_V}">
<meta name="htmx-config" content='{"refreshOnHistoryMiss":true,"historyCacheSize":0,"timeout":60000}'>
<script src="/assets/htmx.min.js?v=${ASSET_V}" defer></script>
</head><body${isShell ? ' class="appshell"' : ""}>
<header><span class="brand">Axle</span><a href="/">${esc(t(lang, "inbox"))}</a><a href="/blocks">${esc(t(lang, "nav_blocks"))}</a>${user.role === "admin" ? `<a href="/audit">${esc(t(lang, "audit"))}</a><a href="/sprocket/requests">${esc(t(lang, "sprocket_requests_nav"))}${user.sprocketNew ? ` <span class="hbadge" title="${esc(t(lang, "sprocket_new_badge"))}">${esc(String(user.sprocketNew))}</span>` : ""}</a>` : ""}
<span class="who"><span class="langtoggle"><a class="${lang === "en" ? "on" : ""}" href="/setlang?lang=en">EN</a><span class="sep">/</span><a class="${lang === "nl" ? "on" : ""}" href="/setlang?lang=nl">NL</a></span><span>${esc(user.display_name)} (${esc(user.role)})</span></span></header>
<main${isShell ? ' class="wide"' : ""}>${body}</main>
${sprocketWidget(lang)}
<script>
// Close any open chip/action menu on an outside click (presentation only).
document.addEventListener("click", function (e) {
  document.querySelectorAll("details.chipmenu[open], details.menu[open]").forEach(function (d) {
    if (!d.contains(e.target)) d.removeAttribute("open");
  });
});
// Pop-up menu placement (presentation only). The chip/action/filter menus are <details>
// lists that live INSIDE the overflow:auto panes, so a list opening near a pane edge gets
// clipped by the pane — which is why the action-bar "More actions" menu hid behind the
// queue when the bar wrapped and stranded its button on the left. Fix: when a menu opens,
// position its list with position:fixed (which escapes the panes' overflow), anchored to
// its summary, flipped above/below for room and CLAMPED into the viewport so it can never
// be clipped or run off-screen. z-index lifts it over the Sprocket cog too. Without JS the
// menus still open exactly as before (this only relocates an already-open list).
(function () {
  var GAP = 6, PAD = 8, openEl = null;
  function listOf(d) { return d.querySelector(".menu-list, .chipmenu-list"); }
  function place(d) {
    var s = d.querySelector("summary"), l = listOf(d);
    if (!s || !l) return;
    l.style.position = "fixed"; l.style.margin = "0";
    l.style.maxWidth = "calc(100vw - " + (PAD * 2) + "px)";
    l.style.maxHeight = "calc(100vh - " + (PAD * 2) + "px)";
    l.style.overflowY = "auto";
    var r = s.getBoundingClientRect(), w = l.offsetWidth, h = l.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    // Action overflow menus open upward; filter (.down) and chip menus open downward.
    var up = d.classList.contains("menu") && !d.classList.contains("down");
    var top = up ? r.top - GAP - h : r.bottom + GAP;
    if (up && top < PAD) top = r.bottom + GAP;              // no room above -> drop below
    else if (!up && top + h > vh - PAD) top = r.top - GAP - h; // no room below -> flip above
    top = Math.max(PAD, Math.min(top, vh - PAD - h));
    var left = Math.max(PAD, Math.min(r.left, vw - PAD - w)); // anchor to button, clamp in
    l.style.top = top + "px"; l.style.left = left + "px";
    l.style.right = "auto"; l.style.bottom = "auto"; l.style.zIndex = "80";
  }
  function clear(d) {
    var l = listOf(d); if (!l) return;
    ["position", "margin", "maxWidth", "maxHeight", "overflowY", "top", "left", "right", "bottom", "zIndex"]
      .forEach(function (k) { l.style[k] = ""; });
  }
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!d || !d.matches || !d.matches("details.menu, details.chipmenu")) return;
    if (d.open) { openEl = d; place(d); } else { if (openEl === d) openEl = null; clear(d); }
  }, true);
  function reflow() { if (openEl && openEl.open) place(openEl); }
  window.addEventListener("resize", reflow);
  window.addEventListener("scroll", reflow, true);
})();
// htmx failure surface: by default htmx silently ignores error responses, network
// failures and timeouts — a failed queue-click looked like "nothing happened". When a
// request TARGETED AT THE WORK PANES fails, show the server's pane-shaped error if we
// got one (the error middleware renders those), else a generic message. Failures of
// background fetches (queue poll) stay silent — they retry on their own.
["htmx:responseError", "htmx:sendError", "htmx:timeout"].forEach(function (ev) {
  document.body.addEventListener(ev, function (e) {
    var wp = document.getElementById("workpane");
    var tgt = e.detail && e.detail.target;
    if (!wp || !tgt || (tgt !== wp && !wp.contains(tgt))) return;
    var xhr = e.detail && e.detail.xhr;
    if (ev === "htmx:responseError" && xhr && xhr.responseText) { wp.innerHTML = xhr.responseText; return; }
    wp.innerHTML = '<div class="empty-state"><p class="muted">' + ${JSON.stringify(esc(t(lang, "load_error")))} +
      (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "") + "</p></div>";
  });
});
// --- Loading feedback singletons (UX round, 2026-06-11): the user must always see
// that something is happening. Presentation only - no request is changed.
// (1) Queue-card click -> work-pane swap: spinner on the clicked card + a dimmed
// overlay on the panes while htmx fetches (the first view of an item can take a
// moment). Background swaps (queue poll, busy-item poll) deliberately show nothing.
(function () {
  function clearLoad() { document.querySelectorAll(".ax-loading").forEach(function (el) { el.classList.remove("ax-loading"); }); }
  document.body.addEventListener("htmx:beforeRequest", function (e) {
    var src = e.detail && e.detail.elt;
    var card = src && src.closest ? src.closest("a.qcard") : null;
    if (!card) return;
    clearLoad();
    card.classList.add("ax-loading");
    var wp = document.getElementById("workpane");
    if (wp) wp.classList.add("ax-loading");
  });
  ["htmx:afterRequest", "htmx:sendError", "htmx:timeout"].forEach(function (ev) {
    document.body.addEventListener(ev, clearLoad);
  });
})();
// (2) Any form submit: lock the pressed button with a spinner and start the top
// progress bar. The setTimeout(0) runs AFTER the form has serialised, so disabling
// the submitter never drops its name=value from the post (Save/Done/etc rely on it).
// (3) Any plain same-tab link navigation: top progress bar only.
(function () {
  document.addEventListener("submit", function (e) {
    var b = e.submitter || null;
    setTimeout(function () {
      if (e.defaultPrevented) return;   // client-side validation stopped it
      if (b && b.classList) { b.classList.add("ax-busy"); b.disabled = true; }
      document.body.classList.add("ax-nav");
    }, 0);
  });
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || a.target === "_blank" || a.hasAttribute("hx-get") || a.hasAttribute("download")) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#" || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;   // anchors / mailto / absolute
    setTimeout(function () { if (!e.defaultPrevented) document.body.classList.add("ax-nav"); }, 0);
  });
  // A back/forward restore (bfcache) must never show stale spinners or locked buttons.
  window.addEventListener("pageshow", function () {
    document.body.classList.remove("ax-nav");
    document.querySelectorAll("button.ax-busy").forEach(function (b) { b.classList.remove("ax-busy"); b.disabled = false; });
    document.querySelectorAll(".ax-loading").forEach(function (el) { el.classList.remove("ax-loading"); });
  });
})();
// (4) FR-0001: draggable splitter for the queue / work boundary. Sets --queue-w on .shell and
// persists it per browser (localStorage); double-click resets to the responsive default; arrow
// keys nudge when the handle is focused. Desktop only (the handle is hidden in the mobile layout).
(function () {
  var KEY = "axleQueueW", MIN = 220, MAX = 560;
  function shellEl() { return document.querySelector(".shell"); }
  function setW(px) { var s = shellEl(); if (s) s.style.setProperty("--queue-w", px + "px"); }
  function clampW(px) { return Math.max(MIN, Math.min(MAX, Math.round(px))); }
  function curW() { var s = shellEl(); return s ? (parseInt(getComputedStyle(s).gridTemplateColumns, 10) || 320) : 320; }
  function save() { try { localStorage.setItem(KEY, curW()); } catch (e) {} }
  try { var v = parseInt(localStorage.getItem(KEY), 10); if (v) setW(clampW(v)); } catch (e) {}
  var split = document.getElementById("paneSplit");
  if (!split) return;
  var dragging = false;
  function moveTo(clientX) { var s = shellEl(); if (!s) return; setW(clampW(clientX - s.getBoundingClientRect().left)); }
  split.addEventListener("pointerdown", function (e) { dragging = true; try { split.setPointerCapture(e.pointerId); } catch (x) {} document.body.classList.add("ax-resizing"); e.preventDefault(); });
  split.addEventListener("pointermove", function (e) { if (dragging) moveTo(e.clientX); });
  function stop(e) { if (!dragging) return; dragging = false; try { split.releasePointerCapture(e.pointerId); } catch (x) {} document.body.classList.remove("ax-resizing"); save(); }
  split.addEventListener("pointerup", stop);
  split.addEventListener("pointercancel", stop);
  split.addEventListener("dblclick", function () { var s = shellEl(); if (s) s.style.removeProperty("--queue-w"); try { localStorage.removeItem(KEY); } catch (x) {} });
  split.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    setW(clampW(curW() + (e.key === "ArrowLeft" ? -16 : 16))); save(); e.preventDefault();
  });
})();

// Confirmation prompts. The text lives in the button's data-confirm attribute and is read as
// DATA, never compiled as JavaScript source. Used by the Send buttons and by any chipMenu option
// that carries a confirm (the owner handover, which forwards the email when it is picked).
//
// It used to be an inline onclick="return confirm('...')". Interpolating a translated string into
// JS source inside an HTML attribute is a trap: HTML-escaping turns ' into &#39;, the parser
// decodes it back to a bare ' BEFORE the JS is compiled, and the string literal ends early. The
// handler then throws a SyntaxError, silently, and the button submits WITH NO CONFIRMATION. Any
// apostrophe would do it - a customer named "Jan's Garage", or the English recipient warning.
// Read via dataset, the same text can contain quotes, backslashes, anything, and stays inert.
//
// Capture phase so it runs before the form submits; cancelling the click cancels the submit.
(function () {
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-confirm]") : null;
    if (!btn) return;
    if (!window.confirm(btn.dataset.confirm)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
</script>
</body></html>`;
}

// --- Step-2 three-pane shell -----------------------------------------------------
// The work area (centre + context) is ONE swappable unit: clicking a queue card asks
// htmx to replace #workpane's contents with the same fragment GET /item/:id returns
// for an HX request, so browsing never reloads the queue. Server-rendered HTML
// throughout; without JS every queue card is a plain link and the page still works.
const workPanes = (centerHtml, contextHtml, opts) => {
  const back = opts && opts.back;   // mobile Back bar label; also marks this as a real item view
  return `<section class="pane-center${back ? " has-item" : ""}">${back ? `<a class="m-back" href="/" onclick="if(window.history.length>1){history.back();return false;}">${esc(back)}</a>` : ""}<div class="pane-inner">${centerHtml}</div></section>
<aside class="pane-context">${contextHtml}</aside>`;
};

// queueHtml is either the inline-rendered queue (GET /) or lazyQueue() below.
const shell = (queueHtml, panesHtml) =>
  `<div class="shell"><aside class="pane-queue" id="queuepane">${queueHtml}</aside>` +
  `<div class="pane-split" id="paneSplit" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize panels" title="Drag to resize · double-click to reset"></div>` +
  `<div class="workpanes" id="workpane">${panesHtml}</div></div>`;

// Lazy queue stub for item deep links: htmx fills it from GET /queue after load, so
// a plain GET /item/:id keeps exactly its old side effects (no inbox audit row, no
// summary translations) and still renders standalone — without JS the fallback is a
// link back to the inbox, the item itself fully usable.
// While the fragment loads, shimmer skeleton rows show the queue is on its way
// (without JS the skeleton is static and the back-link still works).
const QSKEL = `<div class="qskel"><span></span><span></span><span></span></div>`;
const lazyQueue = (lang, qs) =>
  `<div class="queue-lazy" hx-get="/queue${qs ? "?" + esc(qs) : ""}" hx-trigger="load" hx-swap="outerHTML"><a href="&#47;">${esc(t(lang, "back_inbox"))}</a>${QSKEL.repeat(4)}</div>`;

module.exports = {
  esc, UI_LANGS, DEFAULT_LANG, langOK, STRINGS, t,
  titleCase, statusLabel, statusWithRes, intentLabel, kindLabel, langDisplay,
  ownerLabel, ownerChoices, TZ, ymdTZ, fmtTime, parseTS, fmtDateTime,
  linkify, splitQuoted, fmtSize, renderAttachments, renderMail, page,
  chipMenu, foldFooter, segmentQuoted, renderTimeline, ASSET_V,
  workPanes, shell, lazyQueue,
};
