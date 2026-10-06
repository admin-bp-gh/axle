// views/ui.js - Axle's shared view layer: esc(), the STRINGS i18n dictionary (EN/NL,
// parity-tested), label + timestamp formatting, untrusted-email rendering (linkify /
// quoted-history folding) and the page() layout shell.
// Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10): presentation
// helpers only - no routes, no DB access, no network. Server-side rendering stays
// authoritative; everything is escaped here exactly as before.
const rulesets = require("../rules.js");
const BASE = require("../base-path.js");   // AXLE_BASE_PATH URL prefix ("" or e.g. "/axle")
const B = BASE.path;                        // plain [A-Za-z0-9_/-]: safe in attributes, selectors and RegExp sources

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
    inbox: "Inbox", audit: "Audit", adoption: "Adoption",
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
    withdrawn_title: "Axle wrote a reply but withdrew it.",
    withdrawn_vin: "It claimed something was checked against the customer's VIN, which Axle cannot do.",
    withdrawn_sourcing: "It told the customer how we source the part.",
    withdrawn_availability: "It promised a part whose availability is still unknown.",
    withdrawn_next: "Answer the questions or add feedback and redraft, or write the reply yourself below.",
    withdrawn_show: "Show the withdrawn text (reference only, not sendable)",
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
    new_order_ratchet: "Create order", new_order_ratchet_tip: "Open Ratchet's order builder with this e-mail already read in; you review before anything is created",
    mark_phone: "Resolved by phone",
    done_tip: "The work is completed (close the item)",
    phone_tip: "Completed without an email - e.g. you called the customer",
    archive_tip: "No action was needed (FYI / noise)",
    block_tip: "Stop future emails from this sender appearing in Axle",
    block_tip_outlook: "Stop future emails from this sender reaching Axle and the Outlook inbox",
    res_replied: "replied", res_done: "completed", res_phone: "by phone", res_no_action: "no action needed",
    res_outlook: "handled in Outlook", res_forwarded: "handed over",
    nav_blocks: "Blocked",
    block_sender: "Block sender", block_title: "Block this sender",
    block_explain: "Future emails from this sender will no longer appear in Axle. They still arrive in the shared mailbox in Outlook. The block applies to both info@ and drachten@, and can be undone at any time on the Blocked page.",
    block_explain_outlook: "Future emails from this sender will no longer appear in Axle, and Outlook will file them into the \"Axle Blocked\" folder instead of the inbox - including any already sitting in the inbox. Nothing is deleted. The block applies to both info@ and drachten@, and undoing it on the Blocked page also moves their mail back.",
    block_addr_opt: "Address to block",
    block_sap_warn: "Careful - this address matches a SAP customer:",
    block_sap_none: "No SAP customer matches this address.",
    block_sap_unknown: "Could not check SAP for this address.",
    block_confirm_btn: "Block and archive this email", block_back: "Cancel",
    blocks_title: "Blocked senders", blocks_none: "No blocked senders.", unblock: "Unblock",
    blocks_explain: "Emails from these senders are ignored by Axle (they still arrive in Outlook). Anyone on the team can unblock; every change is audited.",
    blocks_explain_outlook: "Emails from these senders are ignored by Axle and filed by Outlook into the \"Axle Blocked\" folder - never deleted. Anyone on the team can unblock, which also moves their mail back to the inbox; every change is audited.",
    blocks_ol_status: "Outlook filing", blocks_ol_off: "off - blocked senders still reach the Outlook inbox",
    blocks_ol_on: "active", blocks_ol_dry: "dry run (nothing is written to Outlook)",
    blocks_ol_missing: "rule missing - will be rebuilt on the next block or sync",
    blocks_ol_msgs: "filed", blocks_ol_never: "not synced yet",
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
    ack_draft_chip: "Just acknowledge?", ack_draft_title: "Nothing here needs answering — Axle has written a short courtesy reply. Send it, or simply mark the item Done. Nothing goes out on its own.",
    prev_draft_summary: "Draft for an earlier message in this thread",
    prev_draft_hint: "The customer wrote again after this was drafted, so it is not an answer to their latest message. Kept for reference only — it cannot be sent.",
    sugg_add: "Attach", sugg_ref: "mentioned as", sugg_pick: "Several documents share this number — pick one:",
    sugg_other_cust: "Different customer — review before attaching", sugg_other_cust_hint: "These numbers were in the email but resolve to another customer's document. Attaching one needs an explicit confirm.",
    sugg_review: "Review", sugg_preview: "Preview", sugg_preview_title: "Open the document PDF in a new tab — nothing is attached.",
    cust_card_title: "Customer", cust_tier: "Discount tier", cust_open_orders: "Open orders", cust_open_invoices: "Open invoices",
    cust_view_full: "View full customer", cust_detail_title: "Customer overview", cust_close: "Close", cust_loading: "Loading…",
    cust_lifetime: "Lifetime invoiced", cust_12m: "Last 12 months", cust_balance: "Account balance", cust_since: "Customer since", cust_last_order: "Last order",
    cust_recent_orders: "Recent orders", cust_recent_invoices: "Recent invoices", cust_no_customer: "Not a known SAP customer.", cust_load_error: "Could not load customer details.",
    cust_frozen: "On hold", cust_open: "Open", cust_closed: "Closed", cust_paid: "Paid", cust_unpaid: "Unpaid", cust_none: "None",
    col_doc: "Doc", col_date: "Date", col_total: "Total", col_status: "Status",
    cust_best_guess: "Best guess", cust_best_guess_tip: "The caller's number is on several customer records. This is the only one who ordered in the last 12 months. Check on the call.",
    vm_people_title: "People we know at this customer", vm_people_matched: "number matched", vm_people_last_email: "last email",
    voicemail_phone_only: "This is a voicemail, so there is nobody to email. Call the customer back and close the item as resolved by phone.",
    contactform_chip: "Contact form", contactform_draft_only: "Contact-form message — the customer's address is in the body, not the sender. Reply via Compose or Outlook; in-thread Send is disabled.",
    contactform_send_blocked: "In-thread Send is disabled for contact-form messages (the sender is Shopify's mailer, not the customer). Use Compose or Outlook.",
    cf_customer_label: "Contact-form customer", cf_pick: "Choose the address to reply to:",
    cf_from_form: "from the form", cf_on_file: "on file in SAP",
    cf_confirm_to: "Confirm recipient", cf_to_confirmed: "Recipient set", cf_change: "Change recipient",
    cf_no_address: "No usable customer address was found in this message — it can't be answered here yet.",
    cf_matched: "Matched in SAP", cf_not_matched: "No SAP match — replying to the address from the form.",
    cf_order: "Order", cf_recipient_rejected: "That address is not one of the resolved options — pick one of the listed addresses.",
    recip_bad_address: "That isn't a single valid email address. Enter one address, with no commas, semicolons or angle brackets.",
    recip_change: "Change recipient", recip_other: "Other address…", recip_use: "Use address",
    recip_from_sender: "sender", recip_on_file: "on file", recip_from_form: "from form", recip_typed: "typed",
    recip_typed_pill: "not on file", recip_typed_warn: "{to} is not one of {customer}'s known addresses. Check it before you send.",
    recip_change_hint: "change it in the Send button", sending: "Sending…",
    recip_changed_pill: "changed", recip_changed_title: "This reply is going somewhere other than the default address.",
    recip_current: "Currently sending to", recip_confirm_btn: "Choose recipient", recip_none_yet: "no recipient yet",
    recip_confirm_hint: "Choose the recipient in the Send button below before this can be sent.",
    recip_this_customer: "this customer",
    cf_send_not_enabled: "Recipient set. Sending contact-form replies isn't enabled yet (action #4 off).",
    cf_confirm_first: "No address found for this customer. Choose the recipient in the Send button before this can be sent.",
    cf_subject: "Subject", cf_subject_hint: "This is a new email to the customer — set the subject they'll see.",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Reset to AI draft", reset_ai_confirm: "Replace your current text with the original AI draft?",
    show_translation: "Show translation", hide_translation: "Hide translation",
    earlier_msgs: "Earlier in this conversation", footer_fold: "Signature & footer",
    inline_image: "inline image", more_actions: "More actions",
    // mobile Phase 2 (M-28, M-32, M-56, M-58)
    restored: "Unsaved edits restored", restore_offer: "You have unsaved edits from {t}. The draft has changed since.",
    restore: "Restore", discard: "Discard", draft_kept: "Draft kept", to_label: "To:",
    save_now: "Save your edits without redrafting",
    // M-01/M-02/M-08/M-13/M-14: mobile Phase 1A
    menu: "Menu", close: "Close", cancel: "Cancel", filters: "Filters", sort: "Sort", sync: "Mail",
    workbench_home: "Workbench home", signed_in_as: "Signed in as", no_matches: "No matches for '{q}'", clear_search: "Clear search",
    best_on_desktop: "Best on desktop", search_open: "Search emails", send_to: "Send to",
    sap_docs: "SAP documents", attach_manual: "Attach by number",
    relang_note: "Changing the language re-drafts the email.",
    // M-19/M-23/M-36/M-44: mobile Phase 1B
    customer_docs: "Customer & docs", show_full: "Show full message", show_less: "Show less",
    back_to_email: "Back to email", back_to_ctx: "Back to Customer & docs",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Select an item from the list to start.",
    load_error: "This could not be loaded. Pick the item again or reload the page — if it keeps failing, the audit log has the details.",
    live_updated: "Live · updated {t}",
    filter_btn: "Filter",
    sort_label: "Sort",
    sort_needs: "Needs me first", sort_new: "Newest first", sort_old: "Oldest first", sort_prio: "Priority first",
    load_more: "Load more (50 of {n})",
    updates_waiting: "New activity, refresh",
    searching_loaded: "Searched the {n} loaded emails",
    retry: "Retry",
    load_failed_title: "Couldn't load this email",
    pull_refresh: "Pull to refresh",
    refreshing: "Refreshing",
    // Teach Axle (Phase 6, 2026-10-05)
    teach: "Teach", teach_title: "Teach Axle", teach_page: "Teach Axle",
    teach_hint: "Something Axle should have known for this email? Write it down in one or two sentences. Brad reviews it before Axle learns it.",
    teach_ph: "What should Axle have known?",
    teach_btn: "Flag for Brad", teach_withdraw: "Withdraw",
    teach_pending: "waiting for Brad", teach_approved: "learned", teach_rejected: "not added", teach_retired: "retired",
    teach_retire: "Retire", teach_retire_confirm: "Remove this entry from Axle's knowledge? It stays on record as retired.",
    teach_explain: "Flags from the team. Edit the text if needed, then Approve: it joins the business knowledge on the next draft. Reject keeps the flag on record without teaching it.",
    teach_draft_then: "Draft at the time of flagging",
    teach_approve: "Approve", teach_reject: "Reject", teach_none: "Nothing waiting.",
    teach_decided: "Decided (newest first)", teach_col_text: "Text", teach_col_by: "Decided by",
  },
  nl: {
    inbox: "Postvak", audit: "Audit", adoption: "Adoptie",
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
    withdrawn_title: "Axle had een antwoord geschreven maar heeft het ingetrokken.",
    withdrawn_vin: "Het beweerde iets aan het chassisnummer van de klant te hebben gecontroleerd, en dat kan Axle niet.",
    withdrawn_sourcing: "Het vertelde de klant hoe wij het onderdeel inkopen.",
    withdrawn_availability: "Het beloofde een onderdeel waarvan de beschikbaarheid nog onbekend is.",
    withdrawn_next: "Beantwoord de vragen of geef feedback en stel opnieuw op, of schrijf het antwoord hieronder zelf.",
    withdrawn_show: "Toon de ingetrokken tekst (alleen ter referentie, niet te versturen)",
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
    new_order_ratchet: "Order aanmaken", new_order_ratchet_tip: "Opent de orderbouwer van Ratchet met deze e-mail al ingelezen; je controleert alles voordat er iets wordt aangemaakt",
    mark_phone: "Telefonisch afgehandeld",
    done_tip: "Het werk is afgerond (item sluiten)",
    phone_tip: "Afgerond zonder e-mail - bv. de klant gebeld",
    archive_tip: "Geen actie nodig (ter info / ruis)",
    block_tip: "Toekomstige e-mails van deze afzender niet meer in Axle tonen",
    block_tip_outlook: "Toekomstige e-mails van deze afzender niet meer in Axle en niet meer in de Outlook-inbox",
    res_replied: "beantwoord", res_done: "afgerond", res_phone: "telefonisch", res_no_action: "geen actie nodig",
    res_outlook: "afgehandeld in Outlook", res_forwarded: "overgedragen",
    nav_blocks: "Geblokkeerd",
    block_sender: "Blokkeer afzender", block_title: "Deze afzender blokkeren",
    block_explain: "Toekomstige e-mails van deze afzender verschijnen niet meer in Axle. Ze komen nog wel aan in de gedeelde mailbox in Outlook. De blokkade geldt voor info@ en drachten@, en is altijd terug te draaien op de pagina Geblokkeerd.",
    block_explain_outlook: "Toekomstige e-mails van deze afzender verschijnen niet meer in Axle, en Outlook verplaatst ze naar de map \"Axle Blocked\" in plaats van de inbox - ook de e-mails die er nu al staan. Er wordt niets verwijderd. De blokkade geldt voor info@ en drachten@; deblokkeren op de pagina Geblokkeerd zet hun e-mails ook weer terug.",
    block_addr_opt: "Te blokkeren adres",
    block_sap_warn: "Let op - dit adres hoort bij een SAP-klant:",
    block_sap_none: "Geen SAP-klant met dit adres.",
    block_sap_unknown: "Kon SAP niet controleren voor dit adres.",
    block_confirm_btn: "Blokkeer en archiveer deze e-mail", block_back: "Annuleren",
    blocks_title: "Geblokkeerde afzenders", blocks_none: "Geen geblokkeerde afzenders.", unblock: "Deblokkeer",
    blocks_explain: "E-mails van deze afzenders worden door Axle genegeerd (ze komen nog wel aan in Outlook). Iedereen in het team kan deblokkeren; elke wijziging wordt gelogd.",
    blocks_explain_outlook: "E-mails van deze afzenders worden door Axle genegeerd en door Outlook in de map \"Axle Blocked\" gezet - nooit verwijderd. Iedereen in het team kan deblokkeren; hun e-mails gaan dan ook terug naar de inbox. Elke wijziging wordt gelogd.",
    blocks_ol_status: "Outlook-filtering", blocks_ol_off: "uit - geblokkeerde afzenders komen nog in de Outlook-inbox",
    blocks_ol_on: "actief", blocks_ol_dry: "proefrun (er wordt niets in Outlook geschreven)",
    blocks_ol_missing: "regel ontbreekt - wordt bij de volgende blokkade of sync opnieuw aangemaakt",
    blocks_ol_msgs: "verplaatst", blocks_ol_never: "nog niet gesynchroniseerd",
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
    ack_draft_chip: "Alleen bevestigen?", ack_draft_title: "Hier hoeft niets beantwoord te worden — Axle heeft een korte beleefde reactie geschreven. Verstuur die, of markeer het item gewoon als gereed. Er gaat niets vanzelf de deur uit.",
    prev_draft_summary: "Concept voor een eerder bericht in dit gesprek",
    prev_draft_hint: "De klant heeft opnieuw geschreven nadat dit concept was gemaakt, dus het is geen antwoord op het laatste bericht. Alleen ter referentie bewaard — het kan niet worden verzonden.",
    sugg_add: "Bijvoegen", sugg_ref: "genoemd als", sugg_pick: "Meerdere documenten met dit nummer — kies er een:",
    sugg_other_cust: "Andere klant — controleer voor bijvoegen", sugg_other_cust_hint: "Deze nummers stonden in de e-mail maar horen bij het document van een andere klant. Bijvoegen vereist een expliciete bevestiging.",
    sugg_review: "Bekijken", sugg_preview: "Voorbeeld", sugg_preview_title: "Open de document-PDF in een nieuw tabblad — er wordt niets bijgevoegd.",
    cust_card_title: "Klant", cust_tier: "Kortingsniveau", cust_open_orders: "Openstaande orders", cust_open_invoices: "Openstaande facturen",
    cust_view_full: "Volledige klant bekijken", cust_detail_title: "Klantoverzicht", cust_close: "Sluiten", cust_loading: "Laden…",
    cust_lifetime: "Totaal gefactureerd", cust_12m: "Laatste 12 maanden", cust_balance: "Accountsaldo", cust_since: "Klant sinds", cust_last_order: "Laatste order",
    cust_recent_orders: "Recente orders", cust_recent_invoices: "Recente facturen", cust_no_customer: "Geen bekende SAP-klant.", cust_load_error: "Kon klantgegevens niet laden.",
    cust_frozen: "Geblokkeerd", cust_open: "Open", cust_closed: "Afgesloten", cust_paid: "Betaald", cust_unpaid: "Onbetaald", cust_none: "Geen",
    col_doc: "Doc", col_date: "Datum", col_total: "Totaal", col_status: "Status",
    cust_best_guess: "Beste gok", cust_best_guess_tip: "Het nummer van de beller staat bij meerdere klantrecords. Dit is de enige die in de laatste 12 maanden heeft besteld. Controleer het tijdens het gesprek.",
    vm_people_title: "Bekende personen bij deze klant", vm_people_matched: "nummer komt overeen", vm_people_last_email: "laatste e-mail",
    voicemail_phone_only: "Dit is een voicemail, dus er is niemand om te mailen. Bel de klant terug en sluit het item als telefonisch afgehandeld.",
    contactform_chip: "Contactformulier", contactform_draft_only: "Contactformulier-bericht — het e-mailadres van de klant staat in de tekst, niet bij de afzender. Beantwoord via Opstellen of Outlook; verzenden in thread is uitgeschakeld.",
    contactform_send_blocked: "Verzenden in thread is uitgeschakeld voor contactformulier-berichten (de afzender is de mailer van Shopify, niet de klant). Gebruik Opstellen of Outlook.",
    cf_customer_label: "Contactformulier-klant", cf_pick: "Kies het adres om op te antwoorden:",
    cf_from_form: "uit het formulier", cf_on_file: "bekend in SAP",
    cf_confirm_to: "Ontvanger bevestigen", cf_to_confirmed: "Ontvanger ingesteld", cf_change: "Ontvanger wijzigen",
    cf_no_address: "Geen bruikbaar klantadres gevonden in dit bericht — kan hier nog niet beantwoord worden.",
    cf_matched: "Gekoppeld in SAP", cf_not_matched: "Geen SAP-koppeling — antwoord naar het adres uit het formulier.",
    cf_order: "Order", cf_recipient_rejected: "Dat adres is geen van de gevonden opties — kies een van de getoonde adressen.",
    recip_bad_address: "Dat is geen geldig e-mailadres. Vul één adres in, zonder komma's, puntkomma's of punthaken.",
    recip_change: "Ontvanger wijzigen", recip_other: "Ander adres…", recip_use: "Adres gebruiken",
    recip_from_sender: "afzender", recip_on_file: "bekend adres", recip_from_form: "uit formulier", recip_typed: "ingetypt",
    recip_typed_pill: "niet bekend", recip_typed_warn: "{to} is geen bekend adres van {customer}. Controleer het voor je verstuurt.",
    recip_change_hint: "wijzig in de Verstuur-knop", sending: "Versturen…",
    recip_changed_pill: "gewijzigd", recip_changed_title: "Dit antwoord gaat naar een ander adres dan het standaardadres.",
    recip_current: "Wordt nu verstuurd naar", recip_confirm_btn: "Ontvanger kiezen", recip_none_yet: "nog geen ontvanger",
    recip_confirm_hint: "Kies hieronder in de Verstuur-knop de ontvanger voordat dit verstuurd kan worden.",
    recip_this_customer: "deze klant",
    cf_send_not_enabled: "Ontvanger ingesteld. Versturen van contactformulier-antwoorden is nog niet ingeschakeld (actie #4 uit).",
    cf_confirm_first: "Geen adres gevonden voor deze klant. Kies de ontvanger in de Verstuur-knop voordat dit verstuurd kan worden.",
    cf_subject: "Onderwerp", cf_subject_hint: "Dit is een nieuwe e-mail aan de klant — stel het onderwerp in dat de klant ziet.",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Terug naar AI-concept", reset_ai_confirm: "Je huidige tekst vervangen door het originele AI-concept?",
    show_translation: "Toon vertaling", hide_translation: "Verberg vertaling",
    earlier_msgs: "Eerder in dit gesprek", footer_fold: "Handtekening & voettekst",
    inline_image: "afbeelding in tekst", more_actions: "Meer acties",
    // mobile Phase 2 (M-28, M-32, M-56, M-58)
    restored: "Niet-opgeslagen wijzigingen hersteld", restore_offer: "Je hebt niet-opgeslagen wijzigingen van {t}. De tekst is sindsdien veranderd.",
    restore: "Herstellen", discard: "Weggooien", draft_kept: "Concept bewaard", to_label: "Aan:",
    save_now: "Bewaar je wijzigingen zonder opnieuw op te stellen",
    // M-01/M-02/M-08/M-13/M-14: mobile Phase 1A
    menu: "Menu", close: "Sluiten", cancel: "Annuleren", filters: "Filters", sort: "Sorteren", sync: "Mail",
    workbench_home: "Workbench-start", signed_in_as: "Ingelogd als", no_matches: "Geen resultaten voor '{q}'", clear_search: "Zoekopdracht wissen",
    best_on_desktop: "Werkt het best op een computer", search_open: "E-mails zoeken", send_to: "Verzenden naar",
    sap_docs: "SAP-documenten", attach_manual: "Bijvoegen op nummer",
    relang_note: "Een andere taal stelt de e-mail opnieuw op.",
    // M-19/M-23/M-36/M-44: mobile Phase 1B
    customer_docs: "Klant & documenten", show_full: "Volledig bericht tonen", show_less: "Minder tonen",
    back_to_email: "Terug naar e-mail", back_to_ctx: "Terug naar Klant & documenten",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Kies een item uit de lijst om te beginnen.",
    load_error: "Dit kon niet worden geladen. Kies het item opnieuw of herlaad de pagina — blijft het misgaan, dan staan de details in het auditlog.",
    live_updated: "Live · bijgewerkt {t}",
    filter_btn: "Filter",
    sort_label: "Sorteren",
    sort_needs: "Actie eerst", sort_new: "Nieuwste eerst", sort_old: "Oudste eerst", sort_prio: "Prioriteit eerst",
    load_more: "Meer laden (50 van {n})",
    updates_waiting: "Nieuwe activiteit, verversen",
    searching_loaded: "Gezocht in de {n} geladen e-mails",
    retry: "Opnieuw proberen",
    load_failed_title: "Deze e-mail kon niet worden geladen",
    pull_refresh: "Trek om te verversen",
    refreshing: "Verversen",
    // Teach Axle (Phase 6, 2026-10-05)
    teach: "Leren", teach_title: "Leer Axle iets", teach_page: "Leer Axle iets",
    teach_hint: "Had Axle iets moeten weten voor deze e-mail? Schrijf het op in een of twee zinnen. Brad beoordeelt het voordat Axle het leert.",
    teach_ph: "Wat had Axle moeten weten?",
    teach_btn: "Doorgeven aan Brad", teach_withdraw: "Intrekken",
    teach_pending: "wacht op Brad", teach_approved: "geleerd", teach_rejected: "niet toegevoegd", teach_retired: "ingetrokken",
    teach_retire: "Intrekken", teach_retire_confirm: "Deze regel uit de kennis van Axle halen? Hij blijft bewaard als ingetrokken.",
    teach_explain: "Meldingen van het team. Pas de tekst zo nodig aan en keur goed: vanaf de volgende conceptmail hoort het bij de bedrijfskennis. Afwijzen bewaart de melding zonder dat Axle het leert.",
    teach_draft_then: "Concept op het moment van melden",
    teach_approve: "Goedkeuren", teach_reject: "Afwijzen", teach_none: "Niets in de wacht.",
    teach_decided: "Beoordeeld (nieuwste eerst)", teach_col_text: "Tekst", teach_col_by: "Beoordeeld door",
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
// The "no reply needed" chip, rendered identically by the inbox and the item page. Since 2026-08-15
// a suggest_close item may ALSO carry a short courtesy draft (see acknowledgement.js), and "No reply
// needed?" beside a filled send box is a contradiction — so the label follows what is actually
// there. Never rendered on a closed item: the suggestion is spent once someone has acted.
const suggestCloseChip = (lang, w) => {
  if (!w.suggest_close || w.status === "done" || w.status === "archived") return "";
  const k = w.ack_draft ? "ack_draft" : "suggest_close";
  return `<span class="chip sugg" title="${esc(t(lang, k + "_title"))}">${esc(t(lang, k + "_chip"))}</span>`;
};
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
    `<a class="att" href="${B}/item/${w.id}/attachment/${i}" target="_blank" rel="noopener">&#128206; ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span></a>`);
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
function chipMenu({ chipClass, chipHtml, title, action, field, options, current, note, lang }) {
  const items = options.map((o) =>
    `<button name="${esc(field)}" value="${esc(o.value)}"${o.value === current ? ' class="on"' : ""}${o.confirm ? ` data-confirm="${esc(o.confirm)}"` : ""}>${esc(o.label)}</button>`).join("");
  return `<details class="chipmenu"><summary title="${esc(title)}"><span class="chip ${chipClass}">${chipHtml}<span class="caret">&#9662;</span></span></summary>
<form method="post" action="${action}" class="chipmenu-list">${items}${note ? `<div class="menunote">${esc(note)}</div>` : ""}<div class="sheet-title m-only">${esc(title)}</div><button type="button" class="m-only" data-close>${esc(t(lang || "en", "cancel"))}</button></form></details>`;
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
  // M-23: .msg-latest is clamped on the phone; the phone-only toggle unfolds it
  let html = `<div class="msg msg-latest">
    <div class="msg-head"><span class="who-line"><b>${esc(who)}</b><span class="muted">${esc(fmtDateTime(w.email_received, lang))}</span></span>${emailTr || emailTrPending ? `<button type="button" class="mini" id="emailtrbtn" onclick="toggleEmailTr()">${esc(t(lang, "show_translation"))}</button>` : ""}</div>
    <pre class="mail">${linkify(clean(main))}</pre>
    <button type="button" class="m-only foldrow msgmore" data-msg-toggle aria-expanded="false" data-more="${esc(t(lang, "show_full"))}" data-less="${esc(t(lang, "show_less"))}"><span>${esc(t(lang, "show_full"))}</span><span class="chev" aria-hidden="true">&#9662;</span></button>
    ${footer ? `<details class="fold"><summary>${esc(t(lang, "footer_fold"))}</summary><pre class="mail muted">${linkify(clean(footer))}</pre></details>` : ""}
    ${emailTr || emailTrPending ? `<div class="trbox msgtr" id="emailtr" style="display:none"><p class="muted trnote">${esc(t(lang, "translation_note").replace("{lang}", langDisplay(lang, (w.language || "").toLowerCase())))}</p><pre class="mail" id="emailtrpre"${emailTrPending ? ' data-pending="1"' : ""}>${emailTr ? linkify(String(emailTr)) : `<span class="spin m-hide"></span><span class="m-hide"> ${esc(t(lang, "translating"))}</span><span class="m-only sk-lines" aria-hidden="true"><span class="sk"></span><span class="sk"></span><span class="sk"></span></span>`}</pre></div>` : ""}
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

// Bump on any assets/* change so browsers re-fetch (express.static serves the
// files; the query string only busts the cache).
const ASSET_V = "polaris27";   // 2026-10-06: Create order link in the item action bar

// page(): the layout shell. opts.shell renders the full-width three-pane workspace
// (body becomes a fixed-height flex column; the panes scroll individually). htmx is
// vendored locally and loaded on every page — inert without hx- attributes, so the
// non-shell pages (blocks, audit, block-confirm) are unaffected. refreshOnHistoryMiss
// makes a back/forward without a cached snapshot do a plain full reload.
// M-01/M-02: phone app bar menu, rendered as a bottom sheet. Hidden on desktop (.m-only).
function appMenu(lang, user) {
  const L = (k) => esc(t(lang, k));
  return `<details class="menu appmenu m-only"><summary class="btn appmenu-btn" aria-label="${L("menu")}"><span class="burger" aria-hidden="true"></span></summary><div class="menu-list">`
    + `<div class="sheet-title">${L("menu")}</div>`
    + (B ? `<a class="mitem wb-home" href="/#/">${L("workbench_home")}</a><div class="mlabel">Axle</div>` : "")
    + `<a class="mitem" href="${B}/">${L("inbox")}</a><a class="mitem" href="${B}/blocks">${L("nav_blocks")}</a>`
    + (user.role === "admin" ? `<a class="mitem" href="${B}/audit">${L("audit")}</a><a class="mitem" href="${B}/adoption">${L("adoption")}</a><a class="mitem" href="${B}/teach">${L("teach")}</a>` : "")
    + `<div class="mlabel">${L("language")}</div><div class="segrow"><a class="seg${lang === "en" ? " on" : ""}" href="${B}/setlang?lang=en">EN</a><a class="seg${lang === "nl" ? " on" : ""}" href="${B}/setlang?lang=nl">NL</a></div>`
    + `<div class="who-row muted">${L("signed_in_as")} <b>${esc(user.display_name)}</b> (${esc(user.role)})</div>`
    + `<button type="button" data-close>${L("close")}</button></div></details>`;
}

function page(title, user, body, refreshSec, opts) {
  const lang = langOK(user.lang);
  const isShell = !!(opts && opts.shell);
  // C5: opts.bodyClass joins the appshell class (e.g. ax-detail on an item deep link)
  const bodyCls = [isShell ? "appshell" : "", (opts && opts.bodyClass) || ""].filter(Boolean).join(" ");
  // C2: the empty work panes, restored by Back and by a tab swap
  const emptyPanes = isShell ? workPanes(`<div class="empty-state"><p class="muted">${esc(t(lang, "shell_select"))}</p></div>`, "") : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}
<title>${esc(title)} - Axle</title>
<link rel="stylesheet" href="${B}/assets/tokens.css?v=${ASSET_V}">
<link rel="stylesheet" href="${B}/assets/components.css?v=${ASSET_V}">
<meta name="htmx-config" content='{"refreshOnHistoryMiss":true,"historyCacheSize":0,"timeout":60000}'>
<script src="${B}/assets/htmx.min.js?v=${ASSET_V}" defer></script>
</head><body${bodyCls ? ` class="${esc(bodyCls)}"` : ""}>
${user.inFrame ? "" : `<header>${B ? `<a class="wb-home" href="/#/" title="${esc(t(lang, "workbench_home"))}" aria-label="${esc(t(lang, "workbench_home"))}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/></svg></a>` : ""}<span class="brand">Axle</span><a href="${B}/">${esc(t(lang, "inbox"))}</a><a href="${B}/blocks">${esc(t(lang, "nav_blocks"))}</a>${user.role === "admin" ? `<a href="${B}/audit">${esc(t(lang, "audit"))}</a><a href="${B}/adoption">${esc(t(lang, "adoption"))}</a><a href="${B}/teach">${esc(t(lang, "teach"))}</a>` : ""}
<span class="who"><span class="langtoggle"><a class="${lang === "en" ? "on" : ""}" href="${B}/setlang?lang=en">EN</a><span class="sep">/</span><a class="${lang === "nl" ? "on" : ""}" href="${B}/setlang?lang=nl">NL</a></span><span>${esc(user.display_name)} (${esc(user.role)})</span></span>${appMenu(lang, user)}</header>`}
<main${isShell ? ' class="wide"' : ""}>${opts && opts.desktopNote ? `<div class="banner desktop-note m-only">${esc(t(lang, "best_on_desktop"))}</div>` : ""}${body}</main>
<script>
// M-09: one phone test shared by the positioner and the splitter
window.__axPhone = window.matchMedia("(max-width: 1100px)");
${isShell ? `// C2: the empty work panes (Back and tab swaps restore them)
window.__axEmptyPanes = ${JSON.stringify(emptyPanes)};
// M-52: labels for the client-built skeleton detail (F8: plus the pull-to-refresh row)
window.__axS = ${JSON.stringify({ back_inbox: t(lang, "back_inbox"), send_now: t(lang, "send_now"), more_actions: t(lang, "more_actions"), pull_refresh: t(lang, "pull_refresh"), refreshing: t(lang, "refreshing") })};
` : ""}// M-08: a [data-close] row closes its sheet
document.addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest("[data-close]") : null;
  if (!b) return;
  var d = b.closest("details"); if (d) d.removeAttribute("open");
  e.preventDefault();
});
// M-23: "Show full message" unfolds the clamped newest message
document.addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest("[data-msg-toggle]") : null;
  if (!b) return;
  var m = b.closest(".msg"); if (!m) return;
  var open = m.classList.toggle("open");
  b.setAttribute("aria-expanded", open ? "true" : "false");
  var s = b.querySelector("span"); if (s) s.textContent = open ? b.getAttribute("data-less") : b.getAttribute("data-more");
});
// M-23: no toggle when the clamped text fits
function axFoldCheck() {
  document.querySelectorAll(".msg-latest").forEach(function (m) {
    var b = m.querySelector("[data-msg-toggle]"), p = m.querySelector("pre.mail");
    if (!b || !p || m.classList.contains("open")) return;
    if (!window.__axPhone.matches) { b.hidden = false; return; }
    b.hidden = p.scrollHeight <= p.clientHeight + 1;
  });
}
// M-36: the context sheet (body.ax-ctx); no history entry, no hash
(function () {
  var savedY = 0;
  function openCtx() {
    savedY = window.scrollY;
    document.body.classList.add("ax-ctx");
    var c = document.querySelector("#workpane .pane-context") || document.querySelector(".pane-context");
    if (c) c.scrollTop = 0;
    var bk = c && c.querySelector(".m-ctxback"); if (bk && bk.focus) bk.focus({ preventScroll: true });
  }
  function closeCtx(restore) {
    if (!document.body.classList.contains("ax-ctx")) return;
    document.body.classList.remove("ax-ctx");
    if (!restore) return;
    window.scrollTo(0, savedY);
    var l = document.querySelector("[data-ctx-open]"); if (l && l.focus) l.focus({ preventScroll: true });
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest ? e.target.closest("[data-ctx-open]") : null;
    if (o) { e.preventDefault(); openCtx(); return; }
    var x = e.target.closest ? e.target.closest("[data-ctx-close]") : null;
    if (x) { e.preventDefault(); closeCtx(true); }
  });
  function isWork(e) {
    var wp = document.getElementById("workpane"), tg = e.detail && e.detail.target;
    return !!(wp && tg && (tg === wp || tg.contains(wp)));
  }
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (!isWork(e)) return;
    closeCtx(false);
    axFoldCheck();
  });
  document.body.addEventListener("htmx:beforeHistorySave", function () { closeCtx(false); });
  var mq = window.__axPhone, onMq = function () { axFoldCheck(); };
  if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", axFoldCheck); else axFoldCheck();
  window.addEventListener("load", axFoldCheck);
})();
// M-26 / M-27 / M-33 / M-56 / M-57 / M-58: phone-only editor auto-grow, keyboard tracker and local autosave.
// Every storage call is wrapped and gated on __axPhone at the time of the call; nothing is posted.
(function () {
  var S = ${JSON.stringify({ restored: t(lang, "restored"), restore_offer: t(lang, "restore_offer"), restore: t(lang, "restore"), discard: t(lang, "discard"), draft_kept: t(lang, "draft_kept"), close: t(lang, "close") })};
  var PH = window.__axPhone, PRE = "axle.draft.", PEND = "axle.pending.", MAXAGE = 14 * 864e5, CR = String.fromCharCode(13);
  var FSEL = "#replybox, textarea.ans[name=feedback], input[name=cf_subject], input[name=return_subject], input[name=compose_subject]";
  var cur = null;   // { id, base, timer } for the item on screen
  function phone() { return !!(PH && PH.matches); }
  function ls(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function ss(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  function nz(v) { return v == null ? null : String(v).split(CR).join("").trim(); }
  // M-26 / M-27: the editor grows with its text, no inner scroll
  function grow(el) { if (!el || !phone()) return; el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; }
  function growAll() { document.querySelectorAll("#replybox, textarea.ans").forEach(grow); }
  // M-33: --kb follows the on-screen keyboard (the bar and open sheets sit at bottom: var(--kb))
  function kb() {
    var vv = window.visualViewport;
    if (!phone() || !vv) return 0;
    var v = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    document.documentElement.style.setProperty("--kb", v + "px");
    return v;
  }
  window.__axKb = kb;
  if (window.visualViewport) { window.visualViewport.addEventListener("resize", kb); window.visualViewport.addEventListener("scroll", kb); }
  // M-56: autosave of the reply, subject and feedback, keyed by the item id in #workform's action
  function fields() {
    var f = document.getElementById("workform");
    return { reply: document.getElementById("replybox"),
      subject: f ? f.querySelector("input[name=cf_subject], input[name=return_subject], input[name=compose_subject]") : null,
      feedback: f ? f.querySelector("textarea.ans[name=feedback]") : null };
  }
  function vals(F) { return { reply: F.reply ? F.reply.value : null, subject: F.subject ? F.subject.value : null, feedback: F.feedback ? F.feedback.value : null }; }
  // the server-rendered values (defaultValue is immune to the browser's own form restore)
  function defs(F) { return { reply: F.reply ? F.reply.defaultValue : null, subject: F.subject ? F.subject.defaultValue : null, feedback: F.feedback ? F.feedback.defaultValue : null }; }
  function same(a, b) { return !!a && !!b && nz(a.reply) === nz(b.reply) && nz(a.subject) === nz(b.subject) && nz(a.feedback) === nz(b.feedback); }
  function put(F, d) { ["reply", "subject", "feedback"].forEach(function (k) { if (F[k] && d[k] != null) F[k].value = d[k]; }); growAll(); }
  function idFrom(s) { var m = new RegExp("^${B}/item/([0-9]+)(/|$)").exec(s || ""); return m ? m[1] : null; }
  function itemId() {
    var f = document.getElementById("workform");
    if (f) return idFrom(f.getAttribute("action"));
    if (!document.querySelector("#workpane .has-item")) return null;
    var el = document.querySelector("#workpane form[action^='${B}/item/'], #workpane [hx-get^='${B}/item/']");
    return el ? idFrom(el.getAttribute("action") || el.getAttribute("hx-get")) : null;
  }
  function write() {
    if (!cur) return;
    clearTimeout(cur.timer); cur.timer = null;
    if (!phone()) return;
    var F = fields(); if (!F.reply) return;
    var v = vals(F), k = PRE + cur.id, base = cur.base;
    if (same(v, base)) { ls(function (s) { s.removeItem(k); }); return; }
    ls(function (s) { s.setItem(k, JSON.stringify({ reply: v.reply, subject: v.subject, feedback: v.feedback, base: base, t: Date.now() })); });
  }
  function later() { if (!cur || !phone()) return; clearTimeout(cur.timer); cur.timer = setTimeout(write, 600); }
  function flush() { if (cur && cur.timer) write(); }
  window.__axFlush = flush; window.__axMarkCards = markCards;   // M-58: the in-app Back (Phase 3) flushes and re-marks the cards
  function dropNote() { document.querySelectorAll(".restored-note").forEach(function (n) { n.remove(); }); }
  function btn(txt, fn, cls) { var b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = txt; b.addEventListener("click", fn); return b; }
  function note(F, d, offer) {
    dropNote();
    var box = F.reply.closest(".box"); if (!box) return;
    var n = document.createElement("div"); n.className = "restored-note m-only"; n.setAttribute("role", "status");
    var p = document.createElement("span"); p.className = "rn-text";
    if (offer) {
      var dt = new Date(d.t || 0);
      p.textContent = S.restore_offer.replace("{t}", ("0" + dt.getHours()).slice(-2) + ":" + ("0" + dt.getMinutes()).slice(-2));
    } else p.textContent = S.restored;
    n.appendChild(p);
    if (offer) {
      // Restore puts the local text back on top of the new server text and re-bases on it
      n.appendChild(btn(S.restore, function () { put(F, d); if (cur) { cur.base = defs(F); write(); } dropNote(); }, "mini primary rn-restore"));
      n.appendChild(btn(S.discard, function () { if (cur) { var k = PRE + cur.id; ls(function (s) { s.removeItem(k); }); } dropNote(); markCards(); }, "mini rn-discard"));
    } else {
      var x = btn(String.fromCharCode(215), dropNote, "mini rn-x"); x.setAttribute("aria-label", S.close); n.appendChild(x);
    }
    var h = box.querySelector(".boxhead");
    box.insertBefore(n, h ? h.nextSibling : box.firstChild);
  }
  // Runs after every render of an item (load or #workpane swap): clear after a landed submit, then restore
  function onRender() {
    cur = null;
    if (!phone()) return;
    var id = itemId(), F = fields();
    if (id) {
      var p = ss(function (s) { return s.getItem(PEND + id); });
      if (p != null) {
        if (!F.reply || nz(F.reply.defaultValue) === nz(p)) ls(function (s) { s.removeItem(PRE + id); });
        ss(function (s) { s.removeItem(PEND + id); });
      }
    }
    if (!id || !F.reply) return;
    cur = { id: id, base: defs(F), timer: null };
    growAll();
    var raw = ls(function (s) { return s.getItem(PRE + id); }), d = null;
    try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = null; }
    if (!d) return;
    if (same(d, cur.base)) { ls(function (s) { s.removeItem(PRE + id); }); return; }
    if (same(d.base, cur.base)) { put(F, d); note(F, d, false); }
    else note(F, d, true);   // the server text changed since: offer, never overwrite
  }
  function prune() {
    if (!phone()) return;
    ls(function (s) {
      var now = Date.now(), dead = [];
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i); if (!k || k.indexOf(PRE) !== 0) continue;
        var d = null; try { d = JSON.parse(s.getItem(k)); } catch (e) { d = null; }
        if (!d || !d.t || now - d.t > MAXAGE) dead.push(k);
      }
      dead.forEach(function (k) { s.removeItem(k); });
    });
  }
  // M-58: "Draft kept" on the queue card of every item with a stored draft
  function markCards() {
    if (!phone()) return;
    document.querySelectorAll("a.qcard[href^='${B}/item/']").forEach(function (a) {
      var h = a.getAttribute("href") || "", id = idFrom(h);
      if (!id || h !== "${B}/item/" + id) return;
      var has = !!ls(function (s) { return s.getItem(PRE + id) != null; });
      var ex = a.querySelector(".draft-kept");
      if (has && !ex) {
        var b = a.querySelector(".q-badges"); if (!b) return;
        var sp = document.createElement("span"); sp.className = "badge draft-kept m-only"; sp.textContent = S.draft_kept; b.appendChild(sp);
      } else if (!has && ex) ex.remove();
    });
  }
  document.addEventListener("input", function (e) {
    if (!phone()) return;
    var el = e.target; if (!el || !el.matches) return;
    if (el.matches("#replybox, textarea.ans")) grow(el);
    if (cur && el.matches(FSEL) && el.closest("#workform")) later();
  });
  // M-56: a submit of the work form (Save, Save & redraft, Send) marks the draft for clearing on landing
  document.addEventListener("submit", function (e) {
    var f = e.target; if (!f || f.id !== "workform" || !cur || !phone()) return;
    write();
    var F = fields(), id = cur.id;
    if (F.reply) { var v = F.reply.value; ss(function (s) { s.setItem(PEND + id, v); }); }
  });
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });
  function isWork(e) {
    var wp = document.getElementById("workpane"), tg = e.detail && e.detail.target;
    return !!(wp && tg && (tg === wp || tg.contains(wp)));
  }
  document.body.addEventListener("htmx:beforeSwap", flush);
  document.body.addEventListener("htmx:afterSwap", function (e) { if (isWork(e)) onRender(); markCards(); });
  document.body.addEventListener("htmx:historyRestore", function () { onRender(); markCards(); });
  var onMq = function () {
    if (PH.matches) { kb(); growAll(); markCards(); return; }
    if (document.documentElement.style.getPropertyValue("--kb")) document.documentElement.style.setProperty("--kb", "0px");
    document.querySelectorAll("#replybox, textarea.ans").forEach(function (el) {
      if (!el.style.height) return;
      el.style.removeProperty("height"); if (!el.getAttribute("style")) el.removeAttribute("style");
    });
  };
  if (PH.addEventListener) PH.addEventListener("change", onMq); else if (PH.addListener) PH.addListener(onMq);
  function init() { prune(); onRender(); markCards(); kb(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.addEventListener("load", growAll);
})();
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
// be clipped or run off-screen. Without JS the
// menus still open exactly as before (this only relocates an already-open list).
(function () {
  var GAP = 6, PAD = 8, openEl = null;
  function listOf(d) { return d.querySelector(".menu-list, .chipmenu-list"); }
  function place(d) {
    if (window.__axPhone.matches) return;   // M-09: the phone uses CSS bottom sheets
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
  // M-09: no inline placement survives a desktop/phone switch
  var mq = window.__axPhone, onMq = function () { document.querySelectorAll("details.menu[open], details.chipmenu[open]").forEach(clear); if (!mq.matches) reflow(); };
  if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
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
    // the server body (pane-shaped error from the middleware or the item 404); wire its Retry
    if (ev === "htmx:responseError" && xhr && xhr.responseText) {
      wp.innerHTML = xhr.responseText;
      if (window.htmx && window.htmx.process) window.htmx.process(wp);
      document.body.classList.add("ax-detail");
      return;
    }
    // C4 / M-51: the same detail-shaped error screen the server renders, built here
    wp.innerHTML = ${JSON.stringify(workPanes(`<div class="errbox" role="alert"><span class="erric" aria-hidden="true">!</span><h2>${esc(t(lang, "load_failed_title"))}</h2><p class="muted" data-ax-errmsg></p></div>`, "", { back: t(lang, "back_inbox"), title: t(lang, "load_failed_title"), lang }))};
    var msg = wp.querySelector("[data-ax-errmsg]");
    if (msg) { msg.removeAttribute("data-ax-errmsg"); msg.textContent = ${JSON.stringify(t(lang, "load_error"))} + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : ""); }
    var rc = e.detail && e.detail.requestConfig, pi = e.detail && e.detail.pathInfo;
    var path = pi && (pi.finalRequestPath || pi.requestPath);
    var box = wp.querySelector(".errbox");
    // Retry only for a GET, never for a POST
    if (box && path && rc && rc.verb === "get") {
      var rb = document.createElement("button");
      rb.type = "button"; rb.className = "retry"; rb.textContent = ${JSON.stringify(t(lang, "retry"))};
      rb.addEventListener("click", function () { htmx.ajax("GET", path, { target: "#workpane", swap: "innerHTML" }); });
      box.appendChild(rb);
    }
    document.body.classList.add("ax-detail");
  });
});
// M-07 / M-17 / M-18 / M-20: phone list and detail navigation, plus the tab swap reset (C2)
(function () {
  function phone() { return !!(window.__axPhone && window.__axPhone.matches); }
  function srcElt(e) { var d = e.detail || {}; return (d.requestConfig && d.requestConfig.elt) || d.elt || null; }
  function isCard(el) { return !!(el && el.closest && el.closest("a.qcard")); }
  function resetWork() {
    var wp = document.getElementById("workpane");
    if (!wp || typeof window.__axEmptyPanes !== "string") return false;
    wp.innerHTML = window.__axEmptyPanes;
    document.body.classList.remove("ax-detail");
    document.title = "Inbox - Axle";
    return true;
  }
  // card tap: remember the list scroll and URL
  document.body.addEventListener("htmx:beforeRequest", function (e) {
    if (!phone() || !isCard(srcElt(e))) return;
    window.__axCardElt = srcElt(e);   // M-52: Back during the skeleton aborts this request
    if (location.pathname.indexOf("${B}/item/") === 0) return;
    window.__axList = { y: window.scrollY, url: location.pathname + location.search };
  });
  // the opened email starts at the top
  document.body.addEventListener("htmx:afterSwap", function (e) {
    var tg = e.detail && e.detail.target;
    if (!phone() || !tg || tg.id !== "workpane" || !isCard(srcElt(e))) return;
    window.scrollTo(0, 0);
  });
  // Back: back to the list in place, never history.back()
  document.addEventListener("click", function (e) {
    if (!phone() || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest("a.m-back:not(.m-ctxback)") : null;
    if (!a) return;
    var L = window.__axList;
    if (window.__axFlush) window.__axFlush();   // M-58: the last keystrokes reach localStorage before the pane empties
    if (window.__axCardElt && window.htmx) { try { htmx.trigger(window.__axCardElt, "htmx:abort"); } catch (x) {} window.__axCardElt = null; }
    if (!resetWork()) return;
    e.preventDefault();
    window.scrollTo(0, (L && L.y) || 0);
    history.pushState({ htmx: true }, "", (L && L.url) || "${B}/");
    if (window.__axMarkCards) window.__axMarkCards();
    // F8: the in-place Back never reloads, so the list refreshes itself here (scroll kept, 5 s debounce)
    if (window.__axQReturn) window.__axQReturn();
  });
  // a tab swap empties the work panes at every width
  document.body.addEventListener("htmx:afterSwap", function (e) {
    var tg = e.detail && e.detail.target, el = srcElt(e);
    if (!tg || tg.id !== "queuepane" || !el || !el.closest || !el.closest("a.qtab")) return;
    resetWork();
  });
})();
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
    if (!wp) return;
    // M-52: the phone paints a skeleton detail instead of the dimmed overlay
    if (window.__axPhone.matches && window.__axS) { skDetail(wp, card); return; }
    wp.classList.add("ax-loading");
  });
  function h(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function skDetail(wp, card) {
    var S = window.__axS;
    // SKBAR: mirrors skBar(lang) in routes/item.js
    var bar = '<div class="actionbar sk-bar m-only" aria-hidden="true"><span class="send-split"><button class="send send-stack" type="button" disabled><span class="send-now">' + h(S.send_now) + '</span><span class="send-to"></span></button><details class="menu recip-pop"><summary class="btn send-caret"><span class="m-only recip-line"><span class="sk" style="width:70%"></span></span>&#9662;</summary></details></span><details class="menu"><summary class="btn">&#8943;&nbsp;' + h(S.more_actions) + '</summary></details></div>';
    wp.innerHTML = '<section class="pane-center has-item sk-detail"><a class="m-back" href="${B}/"><span class="m-back-ic" aria-hidden="true">&larr;</span><span class="sr">' + h(S.back_inbox) + '</span><span class="m-back-title"></span></a>'
      + '<div class="pane-inner" aria-hidden="true"><div class="sk-chips"><span class="sk sk-chip"></span><span class="sk sk-chip"></span><span class="sk sk-chip"></span></div>'
      + '<div class="box skbox"><span class="sk sk-t" style="width:45%"></span><span class="sk" style="width:95%"></span><span class="sk" style="width:88%"></span><span class="sk" style="width:60%"></span><span class="sk sk-box"></span></div>'
      + '<div class="box skbox"><span class="sk sk-t" style="width:35%"></span><span class="sk sk-box" style="height:44px"></span><span class="sk sk-tall"></span></div>'
      + bar + '</div></section><aside class="pane-context"></aside>';
    // the title "#id subject" from the card, set as text
    var m = new RegExp("^${B}/item/([0-9]+)").exec(card.getAttribute("href") || ""), sj = card.querySelector(".q-subj");
    var subj = sj ? sj.textContent.trim() : "";
    if (subj.charCodeAt(0) === 9998) subj = subj.slice(1).trim();   // the compose pencil
    var tt = wp.querySelector(".m-back-title"); if (tt) tt.textContent = (m ? "#" + m[1] + " " : "") + subj;
    document.body.classList.add("ax-detail");
    window.scrollTo(0, 0);
  }
  ["htmx:afterRequest", "htmx:sendError", "htmx:timeout"].forEach(function (ev) {
    document.body.addEventListener(ev, clearLoad);
  });
})();
// M-55: a busy-item poll swap keeps the phone reader's scroll position
(function () {
  var pollEl = null, y = 0;
  function srcElt(e) { var d = e.detail || {}; return (d.requestConfig && d.requestConfig.elt) || d.elt || null; }
  document.body.addEventListener("htmx:beforeRequest", function (e) {
    var el = srcElt(e);
    if (!el || !el.getAttribute || (el.getAttribute("hx-trigger") || "").indexOf("load delay:10s") < 0) return;
    if (!window.__axPhone.matches) { pollEl = null; return; }
    pollEl = el; y = window.scrollY;
  });
  document.body.addEventListener("htmx:afterSwap", function (e) {
    var tg = e.detail && e.detail.target;
    if (!pollEl || !tg || tg.id !== "workpane" || srcElt(e) !== pollEl) return;
    pollEl = null;
    if (window.__axPhone.matches) window.scrollTo(0, y);
  });
})();
// ESC (every width): the last open menu, else the context sheet; focus moves (phone only)
(function () {
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" && e.key !== "Esc") return;
    var cm = document.getElementById("composeModal");
    if (cm && cm.style.display !== "none") return;   // the compose modal has its own ESC
    if (document.querySelector("dialog[open]")) return;   // native dialogs (#cusModal) close themselves
    var open = document.querySelectorAll("details.menu[open], details.chipmenu[open]");
    if (open.length) { open[open.length - 1].removeAttribute("open"); return; }
    if (document.body.classList.contains("ax-ctx")) {
      var bk = document.querySelector("#workpane .m-ctxback") || document.querySelector(".m-ctxback");
      if (bk) bk.click();   // the [data-ctx-close] path, scroll and focus restored
    }
  });
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!window.__axPhone.matches || !d || !d.matches || !d.matches("details.menu, details.chipmenu")) return;
    if (d.open) {
      var tl = d.querySelector(".sheet-title");
      if (!tl) { var l = d.querySelector(".menu-list, .chipmenu-list"); tl = l && l.querySelector("button, a[href]"); }
      else tl.setAttribute("tabindex", "-1");
      if (tl && tl.focus) tl.focus({ preventScroll: true });
    } else {
      // back to the summary, unless the focus already moved elsewhere (an outside tap)
      var a = document.activeElement, s = d.querySelector("summary");
      if (s && s.focus && (!a || a === document.body || d.contains(a))) s.focus({ preventScroll: true });
    }
  }, true);
})();
// Mobile fix 1, phone only: F1 slim bar while typing, F2 swipe-down closes a sheet,
// F3 the in-form Save & redraft, F6 back to the Open list after Send or a handover.
(function () {
  function phone() { return !!(window.__axPhone && window.__axPhone.matches); }
  function ss(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }
  // F1: body.ax-typing while a text field in #workform has focus. The removal waits 250ms so a
  // tap on Send or "..." lands before the bar grows back to two rows (the focusout comes on
  // mousedown, the click after it at the same point).
  var TSEL = "#workform textarea, #workform input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=hidden])";
  var tTimer = null;
  function typing(el) { return !!(el && el.matches && el.matches(TSEL)); }
  function setTyping(on) { document.body.classList.toggle("ax-typing", !!on && phone()); }
  document.addEventListener("focusin", function (e) {
    if (!phone() || !typing(e.target)) return;
    clearTimeout(tTimer); setTyping(true);
  });
  document.addEventListener("focusout", function () {
    if (!document.body.classList.contains("ax-typing")) return;
    clearTimeout(tTimer);
    tTimer = setTimeout(function () { if (!typing(document.activeElement)) setTyping(false); }, 250);
  });
  // a swap can remove the focused field without a focusout
  document.body.addEventListener("htmx:afterSwap", function () { if (!typing(document.activeElement)) setTyping(false); });
  var mq = window.__axPhone, onMq = function () { if (!mq.matches) setTyping(false); };
  if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
  // F2: a downward drag of 60px on an open bottom sheet closes it. Only a mostly vertical drag
  // that starts with the sheet scrolled to its top counts; the panel follows the finger. Closing
  // removes [open], so the toggle handlers above (focus return, positioner clear) run as for Cancel.
  var SHEET = "details.menu[open] > .menu-list, details.chipmenu[open] > .chipmenu-list", sw = null;
  document.addEventListener("touchstart", function (e) {
    sw = null;
    if (!phone() || e.touches.length !== 1) return;
    var t = e.target, l = t && t.closest ? t.closest(SHEET) : null;
    if (!l || t.closest("input, textarea, select")) return;
    sw = { l: l, x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0, on: false };
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    if (!sw || !e.touches.length) return;
    var dx = e.touches[0].clientX - sw.x, dy = e.touches[0].clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy || sw.l.scrollTop > 0) { sw = null; return; }
      sw.on = true;
    }
    sw.dy = Math.max(0, dy);
    sw.l.style.transform = "translateY(" + sw.dy + "px)";
  }, { passive: true });
  function endSwipe() {
    var s = sw; sw = null;
    if (!s || !s.on) return;
    s.l.style.transform = ""; if (!s.l.getAttribute("style")) s.l.removeAttribute("style");
    if (s.dy >= 60) { var d = s.l.closest("details"); if (d) d.removeAttribute("open"); }
  }
  document.addEventListener("touchend", endSwipe);
  document.addEventListener("touchcancel", endSwipe);
  // F3: the phone-only Save & redraft under the feedback box clicks the bar's own redraft button,
  // so the post is identical. It is type=button on purpose: a submit button inside the form would
  // become the form's default button and change what Enter in a subject field does at every width.
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-redraft-proxy]") : null;
    if (!b) return;
    var real = document.querySelector('button[form="workform"][name="action"][value="redraft"]');
    if (!real) return;
    e.preventDefault();
    real.click();
    setTimeout(function () { b.classList.add("ax-busy"); b.disabled = true; }, 0);
  });
  // F6: after Send now or an owner handover the phone lands on the Open list. The hidden ret=list
  // is added only at submit time (no markup at rest); the server honours it on success only.
  var RET = "axle.retlist";
  document.addEventListener("submit", function (e) {
    var f = e.target; if (!f || !f.querySelector) return;
    var old = f.querySelector("input[name=ret]"); if (old) old.remove();
    if (!phone()) return;
    var b = e.submitter || null, act = f.getAttribute("action") || "", fa = (b && b.getAttribute("formaction")) || "";
    // RegExp from strings: this script sits in a template literal, where a backslash escape would be eaten
    var send = f.id === "workform" && new RegExp("^${B}/item/[0-9]+/send$").test(fa);
    var fwd = new RegExp("^${B}/item/[0-9]+/owner$").test(act) && !!b && b.hasAttribute("data-confirm");   // only handover options carry a confirm
    if (!send && !fwd) return;
    var i = document.createElement("input"); i.type = "hidden"; i.name = "ret"; i.value = "list"; f.appendChild(i);
    var m = new RegExp("^${B}/item/([0-9]+)/").exec(send ? fa : act);
    if (m) ss(function (s) { s.setItem(RET, JSON.stringify({ id: m[1], t: Date.now() })); });
  });
  window.addEventListener("pageshow", function () { document.querySelectorAll("form input[name=ret]").forEach(function (i) { i.remove(); }); });
  // Landing on "/" within 2 minutes means the send or handover succeeded (a refusal or failure
  // renders its own page, which drops the marker), so the item's local draft is done with.
  var rm = null;
  try { rm = JSON.parse(ss(function (s) { var v = s.getItem(RET); s.removeItem(RET); return v; }) || "null"); } catch (x) { rm = null; }
  if (rm && rm.id && location.pathname === "${B}/" && Date.now() - rm.t < 120000) {
    try { window.localStorage.removeItem("axle.draft." + rm.id); } catch (x) {}
    ss(function (s) { s.removeItem("axle.pending." + rm.id); });
  }
})();
// Mobile fix 2 (F8), phone only: the list keeps itself fresh. The queue poll (routes/inbox.js)
// runs at a 45 s floor when idle and refreshes a scrolled list with its scroll kept; this block
// adds the refresh on return (tab visible again, bfcache restore, the in-place Back) and a
// pull-to-refresh gesture. Every entry point is gated on __axPhone at the time of the call.
(function () {
  function phone() { return !!(window.__axPhone && window.__axPhone.matches); }
  function listUp() {
    var qp = document.getElementById("queuepane");
    if (!qp || document.body.classList.contains("ax-detail") || getComputedStyle(qp).display === "none") return null;
    return qp;
  }
  // Scroll keep: a background refresh sets __axQKeepY; the next #queuepane swap puts the list back
  // where the reader left it (the M-55 pattern for the busy item, here for the queue).
  document.body.addEventListener("htmx:afterSwap", function (e) {
    var tg = e.detail && e.detail.target;
    if (!tg || tg.id !== "queuepane") return;
    var y = window.__axQKeepY; window.__axQKeepY = null;
    pullReset();
    if (y != null && phone()) window.scrollTo(0, y);
  });
  // a failed queue request swaps nothing: drop the saved scroll and the pull row
  document.body.addEventListener("htmx:afterRequest", function (e) {
    var d = e.detail || {}, tg = d.target;
    if (!tg || tg.id !== "queuepane" || d.successful) return;
    window.__axQKeepY = null;
    pullReset();
  });
  // Refresh on return. Skipped while a field in the list has focus (typing a search) or the list
  // is paged past page 1 (a refresh would collapse the Load more cards, as the poll rule M-12 says).
  var lastRet = 0;
  window.__axQReturn = function () {
    if (!phone() || typeof window.__axQFetch !== "function") return;
    var qp = listUp(); if (!qp) return;
    var a = document.activeElement; if (a && a !== document.body && qp.contains(a)) return;
    var ql = document.getElementById("qlist"); if (ql && +ql.getAttribute("data-page") > 1) return;
    if (Date.now() - lastRet < 5000) return;
    lastRet = Date.now();
    window.__axQKeepY = window.scrollY;
    window.__axQFetch();
  };
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") window.__axQReturn(); });
  window.addEventListener("pageshow", function (e) { if (e.persisted) window.__axQReturn(); });
  // Pull to refresh: a mostly vertical downward drag that starts in #queuepane with the page at the
  // top. Only the indicator row moves (a transform, passive listeners, no preventDefault); it is
  // created here on the phone only, so the desktop DOM never has it. Release past 70px refreshes.
  var PULL = 70, pl = null, busy = null;
  function pullEl(qp) {
    var el = qp.querySelector(".qpull"); if (el) return el;
    var head = qp.querySelector(".queue-head"); if (!head) return null;
    el = document.createElement("div"); el.className = "qpull"; el.setAttribute("role", "status"); el.hidden = true;
    el.innerHTML = '<span class="spin" aria-hidden="true"></span><span class="qpull-t"></span>';
    head.parentNode.insertBefore(el, head.nextSibling);
    return el;
  }
  function pullText(el, k) { var s = el.querySelector(".qpull-t"), S = window.__axS || {}; if (s) s.textContent = S[k] || ""; }
  function pullHide(el) {
    if (!el) return;
    el.classList.remove("on", "ready"); el.classList.add("snap"); el.style.transform = "";
    clearTimeout(el.__axH);
    el.__axH = setTimeout(function () { if (!el.classList.contains("on")) { el.hidden = true; el.classList.remove("snap"); } }, 200);
  }
  function pullReset() {
    pl = null;
    if (busy) { clearTimeout(busy.t); pullHide(busy.el); busy = null; }
    document.querySelectorAll(".qpull:not([hidden])").forEach(pullHide);
  }
  document.addEventListener("touchstart", function (e) {
    pl = null;
    if (busy || !phone() || e.touches.length !== 1 || window.scrollY > 0) return;
    var t = e.target, qp = listUp();
    if (!qp || !t || !t.closest || !qp.contains(t) || t.closest("input, textarea, select")) return;
    if (document.querySelector("details.menu[open], details.chipmenu[open], dialog[open]")) return;
    pl = { qp: qp, x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0, on: false, el: null };
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    if (!pl || !e.touches.length) return;
    var dx = e.touches[0].clientX - pl.x, dy = e.touches[0].clientY - pl.y;
    if (!pl.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { pl = null; return; }
      pl.el = pullEl(pl.qp); if (!pl.el) { pl = null; return; }
      pl.on = true;
      clearTimeout(pl.el.__axH);   // a new drag inside the 200ms snap-back keeps the row
      pl.el.classList.remove("snap", "on"); pullText(pl.el, "pull_refresh"); pl.el.hidden = false;
    }
    pl.dy = Math.max(0, dy);
    pl.el.style.transform = "translateY(" + Math.round(Math.min(pl.dy * 0.6, 48)) + "px)";
    pl.el.classList.toggle("ready", pl.dy >= PULL);
    var sp = pl.el.querySelector(".spin"); if (sp) sp.style.transform = "rotate(" + Math.round(pl.dy * 4) + "deg)";
  }, { passive: true });
  function endPull() {
    var s = pl; pl = null;
    if (!s || !s.on) return;
    var sp = s.el.querySelector(".spin"); if (sp) sp.style.transform = "";
    if (s.dy < PULL || !document.contains(s.el) || typeof window.__axQFetch !== "function") { pullHide(s.el); return; }
    s.el.classList.remove("ready"); s.el.classList.add("on", "snap"); pullText(s.el, "refreshing");
    s.el.style.transform = "translateY(40px)";
    // the swap (or a failed request) ends it; the timer is only a backstop
    busy = { el: s.el, t: setTimeout(pullReset, 20000) };
    window.__axQKeepY = null;
    window.scrollTo(0, 0);
    window.__axQFetch();
  }
  document.addEventListener("touchend", endPull);
  document.addEventListener("touchcancel", function () { var s = pl; pl = null; if (s && s.on) pullHide(s.el); });
  var mq = window.__axPhone, onMq = function () { if (!mq.matches) { pl = null; document.querySelectorAll(".qpull").forEach(function (el) { el.remove(); }); } };
  if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
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
  if (window.__axPhone.matches) return;   // M-09: no splitter on the phone
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
// DATA, never compiled as JavaScript source. NOT used by Send any more (2026-09-30: sending is
// one click; the recipient is printed on the button, so a dialog repeating it was pure friction).
// Still used by any chipMenu option that carries a confirm (the owner handover, which forwards
// the email when it is picked).
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

// One-click send, guarded against the second click. With no dialog in the way, a nervous double
// tap would submit twice; the route's duplicate guard would refuse the second, but the person
// would see an error page for a send that worked. So the first click locks the button and shows
// "Sending…" while the form goes off. Bubble phase, after the submit has been allowed.
(function () {
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-once]") : null;
    if (!btn || e.defaultPrevented) return;
    var now = btn.querySelector(".send-now");
    setTimeout(function () {
      if (now) now.textContent = btn.dataset.once; else btn.textContent = btn.dataset.once;
      btn.disabled = true;
    }, 0);
  });
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
  const title = opts && opts.title;   // M-19: item app bar title (phone-only markup)
  const lang = (opts && opts.lang) || "en";
  // M-19: 44x44 chevron, label kept for screen readers, two-line title
  const backInner = back ? `<span class="m-back-ic" aria-hidden="true">&larr;</span><span class="sr">${esc(back)}</span>${title ? `<span class="m-back-title">${esc(title)}</span>` : ""}` : "";
  // M-36: the context sheet's "Back to email" bar; id="ctx" is the no-JS :target fallback
  const ctxBack = back ? `<a class="m-back m-ctxback m-only" id="ctx" href="#" data-ctx-close><span class="m-back-ic" aria-hidden="true">&larr;</span>${esc(t(lang, "back_to_email"))}</a>` : "";
  return `<section class="pane-center${back ? " has-item" : ""}">${back ? `<a class="m-back" href="${B}/">${backInner}</a>` : ""}<div class="pane-inner">${centerHtml}</div></section>
<aside class="pane-context">${ctxBack}${contextHtml}</aside>`;
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
  `<div class="queue-lazy" hx-get="${B}/queue${qs ? "?" + esc(qs) : ""}" hx-trigger="load" hx-swap="outerHTML"><a href="${B}&#47;">${esc(t(lang, "back_inbox"))}</a>${QSKEL.repeat(4)}</div>`;

module.exports = {
  esc, UI_LANGS, DEFAULT_LANG, langOK, STRINGS, t,
  titleCase, statusLabel, statusWithRes, suggestCloseChip, intentLabel, kindLabel, langDisplay,
  ownerLabel, ownerChoices, TZ, ymdTZ, fmtTime, parseTS, fmtDateTime,
  linkify, splitQuoted, fmtSize, renderAttachments, renderMail, page,
  chipMenu, foldFooter, segmentQuoted, renderTimeline, ASSET_V,
  workPanes, shell, lazyQueue,
};
