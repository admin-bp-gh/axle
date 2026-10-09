// views/ui.js - Axle's shared view layer: esc(), the STRINGS i18n dictionary (EN/NL,
// parity-tested), label + timestamp formatting, untrusted-email rendering (linkify /
// quoted-history folding) and the page() layout shell.
// Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10): presentation
// helpers only - no routes, no DB access, no network. Server-side rendering stays
// authoritative; everything is escaped here exactly as before.
const rulesets = require("../rules.js");
const BASE = require("../base-path.js");   // AXLE_BASE_PATH URL prefix ("" or e.g. "/axle")
const FMT = require("../reply-format.js"); // formatting markers in our own reply text
const B = BASE.path;                        // plain [A-Za-z0-9_/-]: safe in attributes, selectors and RegExp sources

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- i18n: Axle's own wording, per UI language --------------------------------
// Customer content (emails, drafts) is NOT here, that is translated on demand by
// translate.js. This dictionary covers only the chrome Axle itself authors.
const UI_LANGS = ["en", "nl"];
const DEFAULT_LANG = "en";
const langOK = (l) => (UI_LANGS.includes(l) ? l : DEFAULT_LANG);

const STRINGS = {
  en: {
    inbox: "Inbox", adoption: "Adoption",
    // The mailbox filter is named after the LOCATION the team works in, not the address:
    // everyone says "Gouda" and "Drachten", never "info@". The query value stays 'info'.
    mailbox: "Mailbox", all: "All", info: "Gouda", drachten: "Drachten",
    search_emails: "Search emails",
    col_status: "Status",
    check: "Check", back_inbox: "Back", no_subject: "(no subject)",
    injection_chip: "Possible scam or injection",
    investigating_banner: "Axle is drafting this reply. You can work on other emails.",
    customer_email: "Customer email",
    translation_note: "Translated for you: the customer wrote in {lang}.",
    withdrawn_title: "Axle wrote a reply but withdrew it.",
    withdrawn_vin: "It claimed something was checked against the customer's VIN, which Axle cannot do.",
    withdrawn_sourcing: "It told the customer how we source the part.",
    withdrawn_availability: "It promised a part whose availability is still unknown.",
    withdrawn_next: "Answer the questions or add feedback and redraft, or write the reply yourself below.",
    withdrawn_show: "Show the withdrawn text (reference only, not sendable)",
    remove: "Remove", file_too_big: "That file is over the 3 MB limit.",
    attach_total: "Attachment limit reached (3 MB total for this reply).",
    feedback_ph: "Tell Axle what to change",
    answer: "Answer",
    redraft_hint: "Writes the reply again with your note, in the background",
    mark_done: "Mark done", reopen: "Reopen",
    new_order_ratchet: "Create order", new_order_ratchet_tip: "Open Ratchet's order builder with this e-mail already read in; you review before anything is created",
    mark_phone: "Resolved by phone",
    done_tip: "The work is completed (close the item)",
    phone_tip: "Completed without an email, for example you called the customer",
    res_replied: "replied", res_done: "completed", res_phone: "by phone", res_no_action: "no action needed",
    res_outlook: "handled in Outlook", res_forwarded: "handed over",
    block_sender: "Block sender", block_title: "Block this sender?",
    block_explain: "Future emails from this address no longer appear in Axle. They still arrive in Outlook, and you can undo it under Blocked senders.",
    block_explain_outlook: "Future emails from this address go to the Axle Blocked folder in Outlook instead of the inbox. Nothing is deleted, and you can undo it under Blocked senders.",
    block_sap_warn: "Careful: this address matches a SAP customer: {name} ({code}).",
    block_sap_none: "No SAP customer uses this address.",
    block_sap_unknown: "Could not check SAP for this address.",
    block_confirm_btn: "Block and archive", block_refused: "This sender cannot be blocked.",
    blocks_title: "Blocked senders", blocks_none: "No blocked senders.", unblock: "Unblock", unblocked_toast: "Unblocked {x}",
    blocks_ol_status: "Outlook filing", blocks_ol_off: "off, blocked senders still reach the Outlook inbox",
    blocks_ol_on: "active", blocks_ol_dry: "dry run, nothing is written to Outlook",
    blocks_ol_missing: "rule missing, rebuilt on the next block or sync",
    blocks_ol_msgs: "filed", blocks_ol_never: "not synced yet", blocks_domain: "Domain",
    col_sender_b: "Sender", col_by_b: "Blocked by", col_when_b: "When", col_item_b: "From email",
    sent_to: "Sent to",
    send_disabled_inj: "Sending is disabled until you have checked it.",
    what_checked: "What Axle checked", none_paren: "(none)", not_found: "No such work item.",
    body_not_stored: "(body not stored)",
    send_refused: "Send refused by guardrails", send_failed: "Send failed",
    send_failed_note: "Nothing was sent. You can try again.",
    translating: "Translating…",
    attach_failed: "Attachment failed",
    img_inline_btn: "Insert in text",
    sync_now: "Sync now", syncing: "Syncing", never: "never",
    sync_started: "Sync started. New emails appear shortly.",
    // Compose ("New email")
    compose_new: "New email",
    compose_who_ph: "Code, email, order, invoice or name",
    compose_finding: "Looking up",
    compose_instruction: "What should it say",
    compose_instruction_ph: "Tell Axle what to write, or write the email yourself",
    compose_subject: "Subject",
    compose_from: "Send from",
    compose_cancel: "Cancel",
    compose_need_subject: "Add a subject to send it.",
    compose_pick_address: "Pick the address to use:",
    compose_pick_customer: "More than one match. Pick the customer:",
    compose_not_found: "No customer found. Check the identifier.",
    compose_guest: "Not a known SAP account. Axle sends to this address.",
    compose_frozen: "This account is frozen in SAP. Check before contacting.",
    compose_need_who_instr: "Enter a customer and an instruction.",
    compose_need_pick: "Find the customer and confirm the recipient first.",
    compose_draft_only: "Draft only: sending new emails is not enabled yet.",
    compose_your_instruction: "Your instruction",
    compose_origin_chip: "New email", compose_failed: "Could not create the email",
    compose_customer_label: "Customer", compose_send_blocked: "Sending new emails is not enabled yet (draft only).",
    lang_fix: "Customer's language",
    owner_fix: "Assign to",
    // {owner}/{address}: handing an item to someone who works a different mailbox forwards the
    // email there and closes this item, so the confirm has to say both things plainly.
    owner_handover_confirm: "Hand this email over to {owner}?\n\nIt will be forwarded to {address} and closed here.",
    owner_handover_hint: "forwards the email and closes this item",
    attach_doc_title: "Attach SAP document",
    attach_doc_type: "Type", attach_doc_number: "Number",
    attach_doc_none: "No document with that number.", attach_doc_ambiguous: "Several documents share that number. Pick one:",
    attach_doc_scope_warn: "This document belongs to a different customer than this email.",
    attach_doc_doc_cust: "Document customer", attach_doc_email_cust: "Email customer",
    attach_doc_scope_confirm: "Attach anyway", attach_doc_render_failed: "Could not generate the PDF.",
    attach_doc_compose_only: "PDF attach isn't available on this item.",
    doc_order: "Order", doc_invoice: "Invoice", doc_quotation: "Quotation", doc_delivery: "Delivery", doc_creditnote: "Credit note",
    sugg_title: "Suggested documents",
    suggest_close_chip: "No reply needed?", suggest_close_title: "Axle suggests no email reply is needed. Review it and mark it Done if you agree. Nothing closes automatically.",
    ack_draft_chip: "Just acknowledge?", ack_draft_title: "Nothing here needs answering, so Axle has written a short courtesy reply. Send it, or simply mark the item Done. Nothing goes out on its own.",
    prev_draft_summary: "Draft for an earlier message in this thread",
    prev_draft_hint: "The customer wrote again after this was drafted, so it is not an answer to their latest message. Kept for reference only: it cannot be sent.",
    sugg_pick: "Several documents share this number. Pick one:",
    sugg_other_cust_hint: "These numbers were in the email but resolve to another customer's document. Attaching one needs an explicit confirm.",
    sugg_preview: "Preview",
    cust_lifetime: "Lifetime invoiced", cust_12m: "Last 12 months", cust_balance: "Account balance", cust_since: "Customer since", cust_last_order: "Last order",
    cust_recent_orders: "Recent orders", cust_recent_invoices: "Recent invoices", cust_no_customer: "Not a known SAP customer.", cust_load_error: "Could not load customer details.",
    cust_frozen: "On hold", cust_open: "Open", cust_closed: "Closed", cust_paid: "Paid", cust_unpaid: "Unpaid", cust_none: "None",
    col_doc: "Doc", col_date: "Date", col_total: "Total", col_status: "Status",
    cust_best_guess: "Best guess", cust_best_guess_tip: "The caller's number is on several customer records. This is the only one who ordered in the last 12 months. Check on the call.",
    vm_people_title: "People we know at this customer", vm_people_matched: "number matched", vm_people_last_email: "last email",
    voicemail_phone_only: "This is a voicemail, so there is nobody to email. Call the customer back, then close it as resolved by phone.",
    contactform_chip: "Contact form",
    cf_customer_label: "Contact-form customer",
    cf_no_address: "No usable customer address was found in this message, so it can't be answered here yet.",
    cf_matched: "Matched in SAP", cf_not_matched: "No SAP match: replying to the address from the form.",
    cf_order: "Order", cf_recipient_rejected: "That address is not one of the resolved options. Pick one of the listed addresses.",
    recip_bad_address: "That isn't a single valid email address. Enter one address, with no commas, semicolons or angle brackets.",
    cc_refused: "Cc can't be changed on this email.", cc_own: "Only info@, drachten@ and admin@ can be copied from our own domain.",
    cc_sending_box: "This reply is sent from that mailbox, so it can't be copied.",
    cc_same_as_to: "That address is already the To.", cc_duplicate: "That address is already in Cc.",
    cc_too_many: "Cc holds at most {n} addresses.", sent_to_cc: "Sent to {to}, cc {cc}",
    recip_change: "Change recipient", recip_other: "Other address...", recip_use: "Use address",
    recip_from_sender: "sender", recip_on_file: "on file", recip_from_form: "from form", recip_typed: "typed",
    recip_typed_pill: "not on file", recip_typed_warn: "{to} is not one of {customer}'s known addresses. Check it before you send.",
    recip_changed_pill: "changed", recip_changed_title: "This reply is going somewhere other than the default address.",
    recip_confirm_btn: "Choose recipient",
    recip_this_customer: "this customer",
    cf_send_not_enabled: "Recipient set. Sending contact-form replies isn't enabled yet (action #4 off).",
    cf_confirm_first: "No address found for this customer. Choose the recipient on the To line before this can be sent.",
    cf_subject: "Subject",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Reset to draft", reset_ai_confirm: "Replace your text with Axle's draft?",
    hide_translation: "Hide translation",
    earlier_msgs: "Earlier in this conversation", footer_fold: "Signature and footer",
    inline_image: "inline image",
    // mobile Phase 2 (M-28, M-32, M-56, M-58)
    restored: "Unsaved edits restored", restore_offer: "You have unsaved edits from {t}. The draft has changed since.",
    restore: "Restore", discard: "Discard", draft_kept: "Draft kept", to_label: "To",
    // M-01/M-02/M-08/M-13/M-14: mobile Phase 1A
    close: "Close", cancel: "Cancel",
    workbench_home: "Workbench home", clear_search: "Clear search",
    send_to: "Send to",
    relang_note: "Changing the language re-drafts the email.",
    // M-19/M-23/M-36/M-44: mobile Phase 1B
    show_full: "Show full message", show_less: "Show less",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Pick an email from the list.",
    load_error: "This could not be loaded. Pick the email again or reload the page. If it keeps failing, the audit log has the details.",
    load_more: "Load more",
    updates_waiting: "New activity, refresh",
    retry: "Retry",
    load_failed_title: "This email could not be loaded.",
    pull_refresh: "Pull to refresh",
    refreshing: "Refreshing",
    // Teach Axle (Phase 6, 2026-10-05)
    teach_title: "Teach Axle", teach_page: "Teach Axle",
    teach_ph: "What should Axle have known?",
    teach_btn: "Flag for Brad", teach_withdraw: "Withdraw",
    teach_pending: "Waiting for Brad", teach_approved: "Learned", teach_rejected: "Not added", teach_retired: "Retired",
    teach_retire: "Retire", teach_retire_confirm: "Remove this entry from Axle's knowledge? It stays on record as retired.",
    teach_draft_then: "Draft at the time of flagging",
    teach_approve: "Approve", teach_reject: "Reject", teach_none: "Nothing waiting.",
    teach_decided: "Decided", teach_col_text: "Text", teach_col_by: "Reviewed",
    teach_approved_toast: "Approved", teach_rejected_toast: "Rejected", teach_retired_toast: "Retired",
    // Redesign phase 1 (2026-10-07): page shell, queue A, history, compose A, client library
    mine: "Mine", show_label: "Show", search: "Search", more: "More", back: "Back",
    history: "History", history_none: "No closed emails.", history_no_match: "No closed emails match '{q}'.",
    teach_review: "Teach review", audit_log: "Audit log", updated: "Updated {t}",
    no_open: "No open emails.", nothing_waiting: "Nothing waiting. New emails appear here on their own.",
    // Round 2 (requests 6 and 12): Open | History beside Mine | All, one search for both lists
    list_label: "List", open_list: "Open", open_no_match: "No open emails match '{q}'.",
    q_count_0: "No matches", q_count_1: "1 match", q_count_n: "{n} matches",
    q_in_all: "{n} in All", q_in_history: "{n} in History", q_in_open: "{n} in Open",
    q_in_all_history: "{n} in All, History", q_in_all_open: "{n} in All, Open",
    snip_body: "In the email", snip_sent: "In our reply", snip_files: "Attachment", snip_recipients: "Recipients",
    snip_customer: "Customer", snip_sender: "From", snip_subject: "Subject", snip_summary: "Summary",
    attach: "Attach", compose_write: "Write it myself", compose_draft_ai: "Draft with Axle", send: "Send",
    compose_frozen_pill: "Frozen", compose_need_instr: "Tell Axle what to write.",
    confirm_ok: "Continue", unchanged: "Nothing was changed.", post_failed: "That did not go through. Check the connection and try again.",
    // Redesign phase 2 (2026-10-07): the email screen
    not_sap: "Not a SAP customer", cust_orders_1: "{n} open order", cust_orders_n: "{n} open orders",
    cust_invoices_1: "{n} open invoice", cust_invoices_n: "{n} open invoices", translate: "Translate",
    reply: "Reply", recip_email_ph: "Email address", sugg_label: "Suggested", sugg_n_docs: "{n} documents",
    pick_doc: "Which document?", other_doc: "Other document...", other_doc_title: "Other document",
    doc_other_cust: "Different customer", back_email: "Back to the email", saved: "Saved",
    change_lang: "Change language", marked_done: "Marked done",
    handed_over: "Handed over to {owner}", owner_handover_ok: "Hand over", blocked_toast: "Sender blocked",
    handover_title: "Hand over to {owner}", handover_note_label: "Note for your colleague",
    handover_note_ph: "What has been done, what is still open, what they should know",
    handover_forward_note: "The email is also forwarded to {address}.",
    handover_redraft_hint: "The email moves to their queue with your note on top; Axle then redrafts the reply for them with the whole thread in view.",
    handover_note_required: "Write a note first: this email moves to another mailbox.",
    handover_banner: "Handed over by {by} (from {from})", unassigned: "unassigned",
    return_label: "+ Return label", return_label_ok: "Create label", return_label_toast: "Return label attached, redrafting",
    return_label_confirm: "Create a return label?\n\nA prepaid PostNL return label to our warehouse is created in MyParcel and attached to this reply. We pay for it once the customer uses it. Axle then redrafts the reply to say the label is attached.",
    return_label_off: "Return labels are not enabled.",
    return_label_no_country: "This email does not resolve to a SAP customer with a country, so no return label can be made.",
    return_label_abroad: "None of our shipments were found for this customer's orders, and a plain PostNL return label only works within the Netherlands (customer country: {country}). Nothing was created.",
    return_label_dry: "Dry run: a return label would be created ({what}). Nothing was created.",
    return_label_failed: "MyParcel could not create the return label. Nothing was attached.",
    teach_done: "Flagged for Brad", teach_withdrawn: "Flag withdrawn", not_sent: "Not sent",
    nothing_sent: "Nothing was sent.", details: "Details", redraft: "Redraft",
    answer_ph: "Answer here, then redraft", needs_input: "Axle needs your input before this is right.",
    q_1: "1 question", q_n: "{n} questions", check_shelf: "Check on the shelf",
    // Redesign phase 3 (2026-10-07): the rare pages
    col_email: "Email", col_user: "User", col_action: "Action", col_detail: "Detail",
    not_found_t: "Not found", forbidden: "No access", owners_only: "Only owners can open this page.",
    att_title: "Attachment", att_missing: "No such attachment on this email.",
    att_fetch_failed: "Could not fetch the attachment. It may have expired or the email may have been moved.",
    audit_ph: "User, action or detail", audit_any: "Any action", audit_item_ph: "Email #", audit_clear: "Clear",
    audit_note: "Last 500 entries, newest first, Amsterdam time.",
    audit_match_1: "1 match, newest first, Amsterdam time.", audit_matches: "{n} matches, newest first, Amsterdam time.",
    audit_capped: "Newest 500 matches, Amsterdam time. Narrow the search for older entries.",
    ad_window: "{from} to {to}", ad_sends: "Replies sent via Axle", ad_unchanged: "Sent unchanged", ad_box_replied: "{box} replied via Axle",
    ad_by_user: "Adoption by user", ad_col_sends: "Axle sends", ad_col_accept: "Draft acceptance", ad_col_median: "Median match",
    ad_col_last: "Last Axle send", ad_today: "Today", ad_day_1: "1 day ago", ad_days: "{n} days ago", ad_never: "Never",
    ad_b_verbatim: "Unchanged", ad_b_light: "Light edit", ad_b_moderate: "Moderate edit", ad_b_heavy: "Heavy rewrite",
    ad_daily: "Daily activity", ad_in: "Emails in", ad_sent: "Sent via Axle",
    ad_resolved: "Where replies are resolved", ad_r_replied: "Replied via Axle", ad_r_done: "Closed (sent elsewhere)",
    ad_r_phone: "Phone", ad_r_no_action: "No reply needed", ad_r_open: "Still open", ad_r_outlook: "Handled in Outlook", ad_r_forwarded: "Handed over",
    ad_weekly: "Draft acceptance by week", ad_weekly_hint: "Graded sends per ISO week. Style examples live from week 40.",
    ad_col_week: "Week", ad_col_heavy: "Heavily edited",
    ad_digest: "Most-edited drafts, last 7 days", ad_digest_hint: "Under 80 % match, worst first per topic.",
    ad_col_topic: "Topic", ad_col_by: "Sent by", ad_col_match: "Match", ad_col_edit: "Edit", ad_col_chars: "Draft to sent (chars)",
    ad_digest_none: "No edited sends in the last 7 days.", ad_topics: "Draft edited most by topic",
    ad_conf: "Is Axle's confidence trustworthy?", ad_conf_hint: "Sent unchanged, by Axle's own confidence.", ad_col_conf: "Confidence",
    ad_c_high: "High", ad_c_medium: "Medium", ad_c_low: "Low", ad_c_none: "None",
    mark_done_bar: "Mark done", mark_phone_bar: "Resolved by phone", save_failed: "Not saved", save_failed_tip: "Could not save. Your text is still on this screen and Axle tries again as you type.",
    // Round 2 phase 3b: attachments in their message and the photo viewer, the rich editor, the
    // camera, translate on the reply, Cc, the customer's contact line
    att_open: "Open {name}", att_failed: "Could not load",
    media_unread: "Axle could not read: {list}", media_too_large: "too large", media_too_many: "too many attachments",
    media_total_limit: "too many attachments", media_type: "file type not supported", media_unavailable: "could not be fetched",
    viewer_title: "Photo", viewer_count: "{i} of {n}", viewer_prev: "Previous photo", viewer_next: "Next photo", viewer_open: "Open original",
    fmt_toolbar: "Formatting", fmt_bold: "Bold", fmt_italic: "Italic", fmt_underline: "Underline", fmt_list: "Bulleted list", reply_ph: "Write your reply",
    camera: "Take photo", reply_tr_note: "Translated for you: the reply is in {lang}.",
    cc_add: "Add Cc", cc_label: "Cc", cc_more: "Add", cc_menu: "Add to Cc", cc_src_copied: "copied by the customer", cc_src_internal: "internal", cc_remove: "Remove {addr} from Cc",
    contact_email: "Email", contact_phone: "Phone",
    ad_thresholds: "Unchanged: 97 % or more of the draft kept. Light edit 80 %, moderate 45 %, heavy below 45 %. Drachten is the shared Rob and Huub login.",
  },
  nl: {
    inbox: "Postvak", adoption: "Adoptie",
    mailbox: "Mailbox", all: "Alle", info: "Gouda", drachten: "Drachten",
    search_emails: "Zoek in e-mails",
    col_status: "Status",
    check: "Controleer", back_inbox: "Terug", no_subject: "(geen onderwerp)",
    injection_chip: "Mogelijk oplichting of injectie",
    investigating_banner: "Axle schrijft dit antwoord. Je kunt intussen aan andere e-mails werken.",
    customer_email: "E-mail van klant",
    translation_note: "Voor je vertaald: de klant schreef in het {lang}.",
    withdrawn_title: "Axle had een antwoord geschreven maar heeft het ingetrokken.",
    withdrawn_vin: "Het beweerde iets aan het chassisnummer van de klant te hebben gecontroleerd, en dat kan Axle niet.",
    withdrawn_sourcing: "Het vertelde de klant hoe wij het onderdeel inkopen.",
    withdrawn_availability: "Het beloofde een onderdeel waarvan de beschikbaarheid nog onbekend is.",
    withdrawn_next: "Beantwoord de vragen of geef feedback en stel opnieuw op, of schrijf het antwoord hieronder zelf.",
    withdrawn_show: "Toon de ingetrokken tekst (alleen ter referentie, niet te versturen)",
    remove: "Verwijderen", file_too_big: "Dat bestand is groter dan de limiet van 3 MB.",
    attach_total: "Bijlagelimiet bereikt (max 3 MB totaal voor dit antwoord).",
    feedback_ph: "Vertel Axle wat er anders moet",
    answer: "Antwoord",
    redraft_hint: "Schrijft het antwoord opnieuw met jouw opmerking, op de achtergrond",
    mark_done: "Markeer afgehandeld", reopen: "Heropen",
    new_order_ratchet: "Order aanmaken", new_order_ratchet_tip: "Opent de orderbouwer van Ratchet met deze e-mail al ingelezen; je controleert alles voordat er iets wordt aangemaakt",
    mark_phone: "Telefonisch afgehandeld",
    done_tip: "Het werk is afgerond (item sluiten)",
    phone_tip: "Afgerond zonder e-mail, bijvoorbeeld de klant gebeld",
    res_replied: "beantwoord", res_done: "afgerond", res_phone: "telefonisch", res_no_action: "geen actie nodig",
    res_outlook: "afgehandeld in Outlook", res_forwarded: "overgedragen",
    block_sender: "Blokkeer afzender", block_title: "Deze afzender blokkeren?",
    block_explain: "Toekomstige e-mails van dit adres verschijnen niet meer in Axle. Ze komen nog wel aan in Outlook, en je kunt het terugdraaien onder Geblokkeerde afzenders.",
    block_explain_outlook: "Toekomstige e-mails van dit adres gaan in Outlook naar de map Axle Blocked in plaats van de inbox. Er wordt niets verwijderd, en je kunt het terugdraaien onder Geblokkeerde afzenders.",
    block_sap_warn: "Let op: dit adres hoort bij een SAP-klant: {name} ({code}).",
    block_sap_none: "Geen SAP-klant gebruikt dit adres.",
    block_sap_unknown: "Kon SAP niet controleren voor dit adres.",
    block_confirm_btn: "Blokkeer en archiveer", block_refused: "Deze afzender kan niet worden geblokkeerd.",
    blocks_title: "Geblokkeerde afzenders", blocks_none: "Geen geblokkeerde afzenders.", unblock: "Deblokkeer", unblocked_toast: "{x} gedeblokkeerd",
    blocks_ol_status: "Outlook-filtering", blocks_ol_off: "uit, geblokkeerde afzenders komen nog in de Outlook-inbox",
    blocks_ol_on: "actief", blocks_ol_dry: "proefrun, er wordt niets in Outlook geschreven",
    blocks_ol_missing: "regel ontbreekt, wordt bij de volgende blokkade of sync opnieuw aangemaakt",
    blocks_ol_msgs: "verplaatst", blocks_ol_never: "nog niet gesynchroniseerd", blocks_domain: "Domein",
    col_sender_b: "Afzender", col_by_b: "Geblokkeerd door", col_when_b: "Wanneer", col_item_b: "Uit e-mail",
    sent_to: "Verstuurd naar",
    send_disabled_inj: "Versturen is uitgeschakeld totdat je het hebt gecontroleerd.",
    what_checked: "Wat Axle heeft gecontroleerd", none_paren: "(geen)", not_found: "Dit werkitem bestaat niet.",
    body_not_stored: "(inhoud niet opgeslagen)",
    send_refused: "Versturen geweigerd door beveiliging", send_failed: "Versturen mislukt",
    send_failed_note: "Er is niets verstuurd. Je kunt het opnieuw proberen.",
    translating: "Vertalen…",
    attach_failed: "Bijlage mislukt",
    img_inline_btn: "In tekst invoegen",
    sync_now: "Nu synchroniseren", syncing: "Synchroniseren", never: "nooit",
    sync_started: "Synchronisatie gestart. Nieuwe e-mails verschijnen zo.",
    // Compose ("Nieuwe e-mail")
    compose_new: "Nieuwe e-mail",
    compose_who_ph: "Code, e-mail, order, factuur of naam",
    compose_finding: "Opzoeken",
    compose_instruction: "Wat moet erin staan",
    compose_instruction_ph: "Vertel Axle wat het moet schrijven, of schrijf de e-mail zelf",
    compose_subject: "Onderwerp",
    compose_from: "Verzenden vanaf",
    compose_cancel: "Annuleren",
    compose_need_subject: "Vul een onderwerp in om te versturen.",
    compose_pick_address: "Kies het te gebruiken adres:",
    compose_pick_customer: "Meerdere klanten gevonden. Kies de klant:",
    compose_not_found: "Geen klant gevonden. Controleer wat je hebt ingevuld.",
    compose_guest: "Geen bekend SAP-account. Axle verstuurt naar dit adres.",
    compose_frozen: "Dit account is geblokkeerd in SAP. Controleer dit voordat je contact opneemt.",
    compose_need_who_instr: "Voer een klant en een opdracht in.",
    compose_need_pick: "Zoek eerst de klant en bevestig de ontvanger.",
    compose_draft_only: "Alleen concept: nieuwe e-mails versturen is nog niet ingeschakeld.",
    compose_your_instruction: "Jouw opdracht",
    compose_origin_chip: "Nieuwe e-mail", compose_failed: "Kon de e-mail niet aanmaken",
    compose_customer_label: "Klant", compose_send_blocked: "Nieuwe e-mails versturen is nog niet ingeschakeld (alleen concept).",
    lang_fix: "Taal van de klant",
    owner_fix: "Toewijzen aan",
    owner_handover_confirm: "Deze e-mail overdragen aan {owner}?\n\nHij wordt doorgestuurd naar {address} en hier afgesloten.",
    owner_handover_hint: "stuurt de e-mail door en sluit dit item",
    attach_doc_title: "SAP-document bijvoegen",
    attach_doc_type: "Type", attach_doc_number: "Nummer",
    attach_doc_none: "Geen document met dat nummer.", attach_doc_ambiguous: "Meerdere documenten met dat nummer. Kies er een:",
    attach_doc_scope_warn: "Dit document hoort bij een andere klant dan deze e-mail.",
    attach_doc_doc_cust: "Klant van document", attach_doc_email_cust: "Klant van e-mail",
    attach_doc_scope_confirm: "Toch bijvoegen", attach_doc_render_failed: "Kon de PDF niet genereren.",
    attach_doc_compose_only: "PDF bijvoegen is niet beschikbaar bij dit item.",
    doc_order: "Order", doc_invoice: "Factuur", doc_quotation: "Offerte", doc_delivery: "Levering", doc_creditnote: "Creditnota",
    sugg_title: "Voorgestelde documenten",
    suggest_close_chip: "Geen antwoord nodig?", suggest_close_title: "Axle stelt voor dat geen e-mailantwoord nodig is. Beoordeel het item en markeer het als gereed als u het ermee eens bent. Er wordt niets automatisch gesloten.",
    ack_draft_chip: "Alleen bevestigen?", ack_draft_title: "Hier hoeft niets beantwoord te worden, dus Axle heeft een korte beleefde reactie geschreven. Verstuur die, of markeer het item gewoon als gereed. Er gaat niets vanzelf de deur uit.",
    prev_draft_summary: "Concept voor een eerder bericht in dit gesprek",
    prev_draft_hint: "De klant heeft opnieuw geschreven nadat dit concept was gemaakt, dus het is geen antwoord op het laatste bericht. Alleen ter referentie bewaard: het kan niet worden verzonden.",
    sugg_pick: "Meerdere documenten met dit nummer. Kies er een:",
    sugg_other_cust_hint: "Deze nummers stonden in de e-mail maar horen bij het document van een andere klant. Bijvoegen vereist een expliciete bevestiging.",
    sugg_preview: "Voorbeeld",
    cust_lifetime: "Totaal gefactureerd", cust_12m: "Laatste 12 maanden", cust_balance: "Accountsaldo", cust_since: "Klant sinds", cust_last_order: "Laatste order",
    cust_recent_orders: "Recente orders", cust_recent_invoices: "Recente facturen", cust_no_customer: "Geen bekende SAP-klant.", cust_load_error: "Kon klantgegevens niet laden.",
    cust_frozen: "Geblokkeerd", cust_open: "Open", cust_closed: "Afgesloten", cust_paid: "Betaald", cust_unpaid: "Onbetaald", cust_none: "Geen",
    col_doc: "Doc", col_date: "Datum", col_total: "Totaal", col_status: "Status",
    cust_best_guess: "Beste gok", cust_best_guess_tip: "Het nummer van de beller staat bij meerdere klantrecords. Dit is de enige die in de laatste 12 maanden heeft besteld. Controleer het tijdens het gesprek.",
    vm_people_title: "Bekende personen bij deze klant", vm_people_matched: "nummer komt overeen", vm_people_last_email: "laatste e-mail",
    voicemail_phone_only: "Dit is een voicemail, dus er is niemand om te mailen. Bel de klant terug en sluit het daarna als telefonisch afgehandeld.",
    contactform_chip: "Contactformulier",
    cf_customer_label: "Contactformulier-klant",
    cf_no_address: "Geen bruikbaar klantadres gevonden in dit bericht, dus het kan hier nog niet beantwoord worden.",
    cf_matched: "Gekoppeld in SAP", cf_not_matched: "Geen SAP-koppeling: antwoord naar het adres uit het formulier.",
    cf_order: "Order", cf_recipient_rejected: "Dat adres is geen van de gevonden opties. Kies een van de getoonde adressen.",
    recip_bad_address: "Dat is geen geldig e-mailadres. Vul één adres in, zonder komma's, puntkomma's of punthaken.",
    cc_refused: "De Cc van deze e-mail kan niet worden gewijzigd.", cc_own: "Van ons eigen domein kunnen alleen info@, drachten@ en admin@ in Cc.",
    cc_sending_box: "Dit antwoord gaat uit vanuit die mailbox, dus die kan niet in Cc.",
    cc_same_as_to: "Dat adres staat al bij Aan.", cc_duplicate: "Dat adres staat al in Cc.",
    cc_too_many: "In Cc passen hoogstens {n} adressen.", sent_to_cc: "Verstuurd naar {to}, cc {cc}",
    recip_change: "Ontvanger wijzigen", recip_other: "Ander adres...", recip_use: "Adres gebruiken",
    recip_from_sender: "afzender", recip_on_file: "bekend adres", recip_from_form: "uit formulier", recip_typed: "ingetypt",
    recip_typed_pill: "niet bekend", recip_typed_warn: "{to} is geen bekend adres van {customer}. Controleer het voor je verstuurt.",
    recip_changed_pill: "gewijzigd", recip_changed_title: "Dit antwoord gaat naar een ander adres dan het standaardadres.",
    recip_confirm_btn: "Ontvanger kiezen",
    recip_this_customer: "deze klant",
    cf_send_not_enabled: "Ontvanger ingesteld. Versturen van contactformulier-antwoorden is nog niet ingeschakeld (actie #4 uit).",
    cf_confirm_first: "Geen adres gevonden voor deze klant. Kies de ontvanger op de Aan-regel voordat dit verstuurd kan worden.",
    cf_subject: "Onderwerp",
    // UI rework Step 1 (2026-06-10)
    reset_ai: "Terug naar concept", reset_ai_confirm: "Je tekst vervangen door het concept van Axle?",
    hide_translation: "Verberg vertaling",
    earlier_msgs: "Eerder in dit gesprek", footer_fold: "Handtekening en voettekst",
    inline_image: "afbeelding in tekst",
    // mobile Phase 2 (M-28, M-32, M-56, M-58)
    restored: "Niet-opgeslagen wijzigingen hersteld", restore_offer: "Je hebt niet-opgeslagen wijzigingen van {t}. De tekst is sindsdien veranderd.",
    restore: "Herstellen", discard: "Weggooien", draft_kept: "Concept bewaard", to_label: "Aan",
    // M-01/M-02/M-08/M-13/M-14: mobile Phase 1A
    close: "Sluiten", cancel: "Annuleren",
    workbench_home: "Workbench-start", clear_search: "Zoekopdracht wissen",
    send_to: "Verzenden naar",
    relang_note: "Een andere taal stelt de e-mail opnieuw op.",
    // M-19/M-23/M-36/M-44: mobile Phase 1B
    show_full: "Volledig bericht tonen", show_less: "Minder tonen",
    // UI rework Step 2 (2026-06-10): three-pane shell + queue
    shell_select: "Kies een e-mail uit de lijst.",
    load_error: "Dit kon niet worden geladen. Kies de e-mail opnieuw of herlaad de pagina. Blijft het misgaan, dan staan de details in het auditlog.",
    load_more: "Meer laden",
    updates_waiting: "Nieuwe activiteit, verversen",
    retry: "Opnieuw proberen",
    load_failed_title: "Deze e-mail kon niet worden geladen.",
    pull_refresh: "Trek om te verversen",
    refreshing: "Verversen",
    // Teach Axle (Phase 6, 2026-10-05)
    teach_title: "Leer Axle iets", teach_page: "Leer Axle iets",
    teach_ph: "Wat had Axle moeten weten?",
    teach_btn: "Doorgeven aan Brad", teach_withdraw: "Intrekken",
    teach_pending: "Wacht op Brad", teach_approved: "Geleerd", teach_rejected: "Niet toegevoegd", teach_retired: "Ingetrokken",
    teach_retire: "Intrekken", teach_retire_confirm: "Deze regel uit de kennis van Axle halen? Hij blijft bewaard als ingetrokken.",
    teach_draft_then: "Concept op het moment van melden",
    teach_approve: "Goedkeuren", teach_reject: "Afwijzen", teach_none: "Niets in de wacht.",
    teach_decided: "Beoordeeld", teach_col_text: "Tekst", teach_col_by: "Beoordeeld door",
    teach_approved_toast: "Goedgekeurd", teach_rejected_toast: "Afgewezen", teach_retired_toast: "Ingetrokken",
    // Redesign fase 1 (2026-10-07): pagina, wachtrij A, geschiedenis, nieuwe e-mail A, clientbibliotheek
    mine: "Aan mij", show_label: "Toon", search: "Zoeken", more: "Meer", back: "Terug",
    history: "Historie", history_none: "Geen afgesloten e-mails.", history_no_match: "Geen afgesloten e-mails gevonden voor '{q}'.",
    teach_review: "Leer Axle iets", audit_log: "Auditlog", updated: "Bijgewerkt {t}",
    no_open: "Geen open e-mails.", nothing_waiting: "Niets te doen. Nieuwe e-mails verschijnen hier vanzelf.",
    // Ronde 2 (verzoeken 6 en 12): Open | Historie naast Aan mij | Alle, een zoekveld voor beide lijsten
    list_label: "Lijst", open_list: "Open", open_no_match: "Geen open e-mails gevonden voor '{q}'.",
    q_count_0: "Geen resultaten", q_count_1: "1 resultaat", q_count_n: "{n} resultaten",
    q_in_all: "{n} in Alle", q_in_history: "{n} in Historie", q_in_open: "{n} in Open",
    q_in_all_history: "{n} in Alle, Historie", q_in_all_open: "{n} in Alle, Open",
    snip_body: "In de e-mail", snip_sent: "In ons antwoord", snip_files: "Bijlage", snip_recipients: "Ontvangers",
    snip_customer: "Klant", snip_sender: "Van", snip_subject: "Onderwerp", snip_summary: "Samenvatting",
    attach: "Bijvoegen", compose_write: "Zelf schrijven", compose_draft_ai: "Opstellen met Axle", send: "Versturen",
    compose_frozen_pill: "Geblokkeerd", compose_need_instr: "Vertel Axle wat het moet schrijven.",
    confirm_ok: "Doorgaan", unchanged: "Er is niets gewijzigd.", post_failed: "Dat is niet gelukt. Controleer de verbinding en probeer het opnieuw.",
    // Redesign fase 2 (2026-10-07): het e-mailscherm
    not_sap: "Geen SAP-klant", cust_orders_1: "{n} openstaande order", cust_orders_n: "{n} openstaande orders",
    cust_invoices_1: "{n} openstaande factuur", cust_invoices_n: "{n} openstaande facturen",
    translate: "Vertalen", reply: "Antwoord", recip_email_ph: "E-mailadres", sugg_label: "Voorgesteld",
    sugg_n_docs: "{n} documenten", pick_doc: "Welk document?", other_doc: "Ander document...",
    other_doc_title: "Ander document", doc_other_cust: "Andere klant", back_email: "Terug naar de e-mail",
    saved: "Opgeslagen", change_lang: "Taal wijzigen", marked_done: "Afgehandeld",
    handed_over: "Overgedragen aan {owner}", owner_handover_ok: "Overdragen",
    handover_title: "Overdragen aan {owner}", handover_note_label: "Notitie voor je collega",
    handover_note_ph: "Wat is er gedaan, wat staat nog open, wat moet je collega weten",
    handover_forward_note: "De e-mail wordt ook doorgestuurd naar {address}.",
    handover_redraft_hint: "De e-mail gaat naar hun lijst met jouw notitie erboven; Axle stelt het antwoord daarna opnieuw op met de hele conversatie in beeld.",
    handover_note_required: "Schrijf eerst een notitie: deze e-mail gaat naar een andere mailbox.",
    handover_banner: "Overgedragen door {by} (van {from})", unassigned: "niet toegewezen",
    return_label: "+ Retourlabel", return_label_ok: "Label maken", return_label_toast: "Retourlabel bijgevoegd, wordt opnieuw opgesteld",
    return_label_confirm: "Retourlabel maken?\n\nEr wordt in MyParcel een betaald PostNL-retourlabel naar ons magazijn gemaakt en bij dit antwoord gevoegd. Wij betalen het zodra de klant het gebruikt. Axle stelt het antwoord daarna opnieuw op en vermeldt het label.",
    return_label_off: "Retourlabels zijn niet ingeschakeld.",
    return_label_no_country: "Deze e-mail is niet te koppelen aan een SAP-klant met een land, dus er kan geen retourlabel worden gemaakt.",
    return_label_abroad: "Geen zending van ons gevonden bij de orders van deze klant, en een los PostNL-retourlabel werkt alleen binnen Nederland (land klant: {country}). Er is niets gemaakt.",
    return_label_dry: "Proefrun: er zou een retourlabel worden gemaakt ({what}). Er is niets gemaakt.",
    return_label_failed: "MyParcel kon het retourlabel niet maken. Er is niets bijgevoegd.",
    blocked_toast: "Afzender geblokkeerd", teach_done: "Doorgegeven aan Brad",
    teach_withdrawn: "Melding ingetrokken", not_sent: "Niet verstuurd", nothing_sent: "Er is niets verstuurd.",
    details: "Details", redraft: "Opnieuw opstellen", answer_ph: "Antwoord hier en stel daarna opnieuw op",
    needs_input: "Axle heeft je input nodig voordat dit klopt.", q_1: "1 vraag", q_n: "{n} vragen",
    check_shelf: "Controleer in het schap",
    // Redesign fase 3 (2026-10-07): de zeldzame pagina's
    col_email: "E-mail", col_user: "Gebruiker", col_action: "Actie", col_detail: "Details",
    not_found_t: "Niet gevonden", forbidden: "Geen toegang", owners_only: "Alleen eigenaren kunnen deze pagina openen.",
    att_title: "Bijlage", att_missing: "Deze bijlage bestaat niet bij deze e-mail.",
    att_fetch_failed: "Kon de bijlage niet ophalen. Mogelijk is hij verlopen of is de e-mail verplaatst.",
    audit_ph: "Gebruiker, actie of detail", audit_any: "Elke actie", audit_item_ph: "E-mail #", audit_clear: "Wissen",
    audit_note: "Laatste 500 regels, nieuwste eerst, Amsterdamse tijd.",
    audit_match_1: "1 resultaat, nieuwste eerst, Amsterdamse tijd.", audit_matches: "{n} resultaten, nieuwste eerst, Amsterdamse tijd.",
    audit_capped: "Nieuwste 500 resultaten, Amsterdamse tijd. Verfijn de zoekopdracht voor oudere regels.",
    ad_window: "{from} tot {to}", ad_sends: "Antwoorden verstuurd via Axle", ad_unchanged: "Ongewijzigd verstuurd", ad_box_replied: "{box} beantwoord via Axle",
    ad_by_user: "Adoptie per gebruiker", ad_col_sends: "Via Axle verstuurd", ad_col_accept: "Conceptacceptatie", ad_col_median: "Mediane overeenkomst",
    ad_col_last: "Laatst via Axle", ad_today: "Vandaag", ad_day_1: "1 dag geleden", ad_days: "{n} dagen geleden", ad_never: "Nooit",
    ad_b_verbatim: "Ongewijzigd", ad_b_light: "Kleine aanpassing", ad_b_moderate: "Matige aanpassing", ad_b_heavy: "Herschreven",
    ad_daily: "Dagelijkse activiteit", ad_in: "E-mails binnen", ad_sent: "Verstuurd via Axle",
    ad_resolved: "Waar antwoorden worden afgehandeld", ad_r_replied: "Beantwoord via Axle", ad_r_done: "Gesloten (elders verstuurd)",
    ad_r_phone: "Telefonisch", ad_r_no_action: "Geen antwoord nodig", ad_r_open: "Nog open", ad_r_outlook: "Afgehandeld in Outlook", ad_r_forwarded: "Overgedragen",
    ad_weekly: "Conceptacceptatie per week", ad_weekly_hint: "Beoordeelde verzendingen per ISO-week. Stijlvoorbeelden actief vanaf week 40.",
    ad_col_week: "Week", ad_col_heavy: "Sterk aangepast",
    ad_digest: "Meest aangepaste concepten, laatste 7 dagen", ad_digest_hint: "Minder dan 80 % overeenkomst, slechtste eerst per onderwerp.",
    ad_col_topic: "Onderwerp", ad_col_by: "Verstuurd door", ad_col_match: "Overeenkomst", ad_col_edit: "Aanpassing", ad_col_chars: "Concept naar verstuurd (tekens)",
    ad_digest_none: "Geen aangepaste verzendingen in de laatste 7 dagen.", ad_topics: "Concept het meest aangepast per onderwerp",
    ad_conf: "Klopt het vertrouwen van Axle?", ad_conf_hint: "Ongewijzigd verstuurd, per eigen inschatting van Axle.", ad_col_conf: "Vertrouwen",
    ad_c_high: "Hoog", ad_c_medium: "Gemiddeld", ad_c_low: "Laag", ad_c_none: "Geen",
    mark_done_bar: "Afgehandeld", mark_phone_bar: "Teruggebeld", save_failed: "Niet opgeslagen", save_failed_tip: "Kon niet opslaan. Je tekst staat nog op dit scherm en Axle probeert het opnieuw zodra je typt.",
    // Ronde 2 fase 3b: bijlagen bij hun bericht en de fotoviewer, de opmaakeditor, de camera,
    // vertalen bij het antwoord, Cc, de contactregel van de klant
    att_open: "{name} openen", att_failed: "Kon niet laden",
    media_unread: "Axle kon niet lezen: {list}", media_too_large: "te groot", media_too_many: "te veel bijlagen",
    media_total_limit: "te veel bijlagen", media_type: "bestandstype niet ondersteund", media_unavailable: "kon niet worden opgehaald",
    viewer_title: "Foto", viewer_count: "{i} van {n}", viewer_prev: "Vorige foto", viewer_next: "Volgende foto", viewer_open: "Origineel openen",
    fmt_toolbar: "Opmaak", fmt_bold: "Vet", fmt_italic: "Cursief", fmt_underline: "Onderstrepen", fmt_list: "Opsomming", reply_ph: "Schrijf je antwoord",
    camera: "Foto maken", reply_tr_note: "Voor je vertaald: het antwoord is in het {lang}.",
    cc_add: "Cc toevoegen", cc_label: "Cc", cc_more: "Toevoegen", cc_menu: "Toevoegen aan Cc", cc_src_copied: "door de klant in kopie", cc_src_internal: "intern", cc_remove: "{addr} uit Cc halen",
    contact_email: "E-mail", contact_phone: "Telefoon",
    ad_thresholds: "Ongewijzigd: 97 % of meer van het concept behouden. Kleine aanpassing 80 %, matig 45 %, herschreven onder 45 %. Drachten is de gedeelde login van Rob en Huub.",
  },
};
// t(lang, key, vars): the string, with {name} placeholders filled from vars when given. Filled by a
// function, so a "$&" or "$'" in a value (typed text, a file name, an address) stays as typed; use
// vars rather than .replace whenever a value comes from a person or a customer.
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
const t = (lang, k, vars) => {
  const s = (STRINGS[lang] && STRINGS[lang][k] != null) ? STRINGS[lang][k] : (STRINGS.en[k] != null ? STRINGS.en[k] : k);
  return vars ? fill(s, vars) : s;
};

// --- labels that depend on a controlled vocabulary, per language ---------------
const titleCase = (s) => String(s == null ? "" : s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// Step 2 (F2): action-state vocabulary, each label names what the USER does next,
// not Axle's internal state ("Needs your answer", not "Awaiting input"). Same keys,
// same routes; rename only. statusWithRes still appends the resolution reason.
const STATUS_LABEL = {
  en: { new: "New", investigating: "Drafting", awaiting_input: "Needs your answer", ready: "Ready to send", done: "Done", archived: "Archived" },
  nl: { new: "Nieuw", investigating: "Wordt opgesteld", awaiting_input: "Jouw antwoord nodig", ready: "Klaar om te versturen", done: "Afgehandeld", archived: "Gearchiveerd" },
};
const statusLabel = (lang, s) => (STATUS_LABEL[lang] && STATUS_LABEL[lang][s]) || STATUS_LABEL.en[s] || titleCase(s);
// "Done · by phone" / "Archived · no action needed": the status label plus the recorded
// resolution reason (work_items.resolution), when one is set. Legacy closed items have none.
// A resolution records HOW an item was CLOSED, so it is meaningless on an open one and is not
// rendered there, belt to the braces of ingest.js clearing it on reopen. Without this guard an
// item reopened before that fix went in keeps showing e.g. "Needs your answer · handled in
// Outlook", which reads like a contradiction. (2026-08-06.)
const statusWithRes = (lang, w) =>
  statusLabel(lang, w.status) +
  (w.resolution && (w.status === "done" || w.status === "archived") ? " · " + t(lang, "res_" + w.resolution) : "");
// The "no reply needed" chip, rendered identically by the inbox and the item page. Since 2026-08-15
// a suggest_close item may ALSO carry a short courtesy draft (see acknowledgement.js), and "No reply
// needed?" beside a filled send box is a contradiction, so the label follows what is actually
// there. Never rendered on a closed item: the suggestion is spent once someone has acted.
const suggestCloseChip = (lang, w) => {
  if (!w.suggest_close || w.status === "done" || w.status === "archived") return "";
  const k = w.ack_draft ? "ack_draft" : "suggest_close";
  return pill(t(lang, k + "_chip"), "warn", `title="${esc(t(lang, k + "_title"))}"`);
};
const INTENT_LABEL = {
  en: { stock_price_enquiry: "Stock / price enquiry", order_status: "Order status", cancellation: "Cancellation", return_complaint: "Return / complaint", b2b_order: "B2B order", supplier: "Supplier", invoice: "Invoice", other: "Other" },
  nl: { stock_price_enquiry: "Voorraad / prijs", order_status: "Orderstatus", cancellation: "Annulering", return_complaint: "Retour / klacht", b2b_order: "B2B-order", supplier: "Leverancier", invoice: "Factuur", other: "Overig" },
};
const intentLabel = (lang, s) => (s ? ((INTENT_LABEL[lang] && INTENT_LABEL[lang][s]) || INTENT_LABEL.en[s] || titleCase(s)) : "-");
// In-language name of a language code, for "the customer wrote in {lang}".
const LANG_DISPLAY = {
  en: { en: "English", nl: "Dutch", de: "German", fr: "French", es: "Spanish", other: "another language" },
  nl: { en: "Engels", nl: "Nederlands", de: "Duits", fr: "Frans", es: "Spaans", other: "een andere taal" },
};
const langDisplay = (uiLang, code) => (LANG_DISPLAY[uiLang] && LANG_DISPLAY[uiLang][code]) || code || "?";

// Drachten has no fixed owner (Rob & Huub share it); show the mailbox name as the owner.
const ownerLabel = (w) => w.owner || (w.mailbox === "drachten" ? "Drachten" : "-");

// Valid reassignment targets for an item, derived from its mailbox's routing rules' own
// owner labels (rules.js stays the single source of truth for who works a mailbox), so a
// reassign can only ever produce a label the inbox "mine" queues already understand.
// 'reassignOnly' labels are offered too: owners a human may hand an item to that no rule assigns
// automatically (info@'s Tom, purchasing is worked in Outlook, so nothing routes to him, but
// sales can still pass him something deliberately). rules.js remains the single source of truth.
const ownerChoices = (mailbox) => {
  const rs = rulesets[mailbox] || {};
  const fromRules = (rs.rules || []).map((r) => r.owner);
  return [...new Set(fromRules.concat(rs.reassignOnly || []).filter(Boolean))].sort();
};

// Friendly, localised timestamps in the office timezone. EN: "Today 10:32am" /
// "Friday 10:32am" / "Fri 5 Jun, 10:32am". NL: 24-hour Dutch, "Vandaag 10:32" /
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
// Renders both markdown links [visible text](url), used by our drafts so the customer code
// shows instead of a raw URL, and bare URLs (truncated display, full href on hover). Links and
// URLs are found by reply-format.js tokens(), so where a URL ends is the same rule as in the reply
// editor and the sent email; an image token is just text here.
function linkAnchor(tok) {
  if (tok.type === "image") return esc(tok.raw);
  const shown = tok.type === "link" ? tok.text : tok.url.length > 72 ? tok.url.slice(0, 60) + "…" + tok.url.slice(-8) : tok.url;
  return `<a href="${esc(tok.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tok.url)}">${esc(shown)}</a>`;
}
const linkify = (s) => FMT.tokens(s).map((tok) => (tok.type === "text" ? esc(tok.raw) : linkAnchor(tok))).join("");

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

// A plain-text body as paragraphs: a blank line starts a new one, single line breaks and spacing
// stay (axle.css keeps white space). Every paragraph is escaped and linkified.
const paras = (text) => String(text || "").split(/\n[ \t\r]*\n/).filter((p) => p.trim())
  .map((p) => `<p>${linkify(p.replace(/^\n+|\s+$/g, ""))}</p>`).join("");

// Our own reply text, read-only (a sent reply, an earlier draft): paras plus the formatting markers
// of reply-format.js as bold, italic and lists. Never used for the customer's text, where an
// asterisk is just an asterisk.
const replyParas = (text) => FMT.displayHtml(text, { esc, atom: linkAnchor });

// The attachments of one message (round 2, request 1): photos (png, jpeg, gif, webp) as thumbnails
// that open the viewer in axle.js (data-photo; data-meta names the message: sender and time), each
// a skeleton until it loads and a "could not load" tile with Retry when it fails or its fetch is
// known to have failed; then the other files as chips with a type icon, name and size: a PDF opens in
// a new tab, anything else downloads. atts: [{ name, size, url, image, pdf, contentType, failed }].
function attachmentsHtml(atts, meta, lang) {
  if (!atts.length) return "";
  const L = (k) => esc(t(lang, k));
  const photos = atts.filter((a) => a.image).map((a) => `<div class="ax-thumb"${a.failed ? " data-failed" : ""}>
    <button type="button" class="ax-thumb__b" data-photo="${esc(a.url)}" data-name="${esc(a.name)}" data-meta="${esc(meta)}" aria-label="${esc(t(lang, "att_open", { name: a.name }))}" title="${esc(a.name)} (${fmtSize(a.size)})"><span class="wb-skel" aria-hidden="true"></span><img ${a.failed ? "data-src" : "src"}="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></button>
    <button type="button" class="ax-thumb__fail" data-photo-retry title="${esc(a.name)}">${icon("alert")}<span>${L("att_failed")}</span><span class="wb-link">${L("retry")}</span></button></div>`);
  const files = atts.filter((a) => !a.image).map((a) => `<a class="wb-pillbtn ax-file" href="${esc(a.url)}"${a.pdf ? ' target="_blank" rel="noopener"' : " download"} title="${esc(a.name)}">${icon(/^image\//i.test(a.contentType || "") ? "image" : "file")}<span>${esc(a.name)}</span><small>${fmtSize(a.size)}</small></a>`);
  return `<div class="ax-atts-in">${photos.length ? `<div class="ax-thumbs">${photos.join("")}</div>` : ""}${files.length ? `<div class="ax-files">${files.join("")}</div>` : ""}</div>`;
}
// The quiet line under the newest message's attachments naming what Axle's drafter could not read
// (draft-media.js notShownFor: [{ name, reason }]).
const unreadLine = (notShown, lang) => notShown.length
  ? `<p class="ax-unread">${icon("info")}<span>${esc(t(lang, "media_unread", { list: notShown.map((x) => `${x.name} (${t(lang, "media_" + x.reason)})`).join(", ") }))}</span></p>` : "";

// Render-side folding for the conversation timeline (F7). The regexes mirror the
// patterns engine.js classify() folds for language detection, duplicated here on
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
// 9 + remainder); falls back to one block. Display-only, nothing is dropped.
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

// The customer's email (F7): one line naming sender, address, time and mailbox, with Translate when
// the customer wrote in another language than the reader's; the newest message (its legal footer
// folded, [cid:] tokens shown as a readable marker, clamped on a phone behind "Show full message");
// the translation behind the toggle; its attachments and what Axle could not read; older messages
// folded beneath, one block each.
// emailTrPending: the translation is not cached yet; axle.js fills it in (POST /item/:id/translations).
// thread: message-store's itemThread (oldest first). Its newest message (the item's latest message)
// carries the newest attachments; each earlier stored message's attachments go into the quoted block
// that holds its text, or, when no quoted block does, into a block of its own (sender, time, its
// text). An email from before round 2 with no stored message lists the newest message's files from
// attachments_json through the old index-based route. notShown: draft-media.js notShownFor(w).
const SHOWABLE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
function renderTimeline(w, lang, emailTr, emailTrPending, thread = [], notShown = []) {
  const L = (k) => esc(t(lang, k));
  const who = w.sender_name ? `<b>${esc(w.sender_name)}</b> · ${esc(w.sender_email || "")}` : `<b>${esc(w.sender_email || "")}</b>`;
  const tr = emailTr || emailTrPending;
  const from = `<div class="ax-from"><span>${who} · ${esc(fmtDateTime(w.email_received, lang))} · ${esc(w.mailbox)}@</span>${tr ? `<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-tr-email aria-expanded="false" data-on="${L("hide_translation")}" data-off="${L("translate")}">${L("translate")}</button>` : ""}</div>`;
  const newest = thread.find((m) => m.graphId === w.latest_message_id) || thread[thread.length - 1];
  const meta = (m) => `${m.from.name || m.from.address} · ${fmtDateTime(m.received, lang)}`;
  let newestAtts;
  if (newest) newestAtts = newest.attachments;
  else {
    try { newestAtts = JSON.parse(w.attachments_json || "[]") || []; } catch (e) { newestAtts = []; }
    newestAtts = newestAtts.map((a, i) => ({ name: a.name, size: a.size, contentType: a.contentType, image: SHOWABLE_IMAGE.test(a.contentType || ""),
      pdf: /^application\/pdf$/i.test(a.contentType || ""), url: `${B}/item/${w.id}/attachment/${i}` }));
  }
  const files = attachmentsHtml(newestAtts, newest ? meta(newest) : `${w.sender_name || w.sender_email || ""} · ${fmtDateTime(w.email_received, lang)}`, lang) + unreadLine(notShown, lang);
  const raw = String(w.email_text || "");
  if (!raw.trim()) return `${from}<p class="wb-hint">${L("body_not_stored")}</p>${files}`;
  const imgMark = "[\u{1F4F7} " + t(lang, "inline_image") + "]";
  const clean = (s) => String(s)
    .replace(/\[cid:[^\]]*\]/gi, imgMark)
    .replace(/^\s*(Inline-Bild|Inline image|Afbeelding)\s*$/gim, imgMark);
  const { top, quoted } = splitQuoted(raw);
  const { main, footer } = foldFooter(top);
  const fold = (summary, body) => `<details class="wb-details ax-fold"><summary>${summary}${icon("chevron-right")}</summary>${body}</details>`;
  // The earlier messages: the quoted blocks of the newest message, each with the files of the stored
  // message whose own text it holds, then the stored messages no quoted block holds.
  const flat = (s) => String(s).replace(/^[ \t]*>+ ?/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
  const segs = (quoted ? segmentQuoted(quoted) : []).map((x) => ({ text: x, flat: flat(x), files: "" }));
  const loose = [];
  for (const m of thread.filter((x) => x !== newest).reverse()) {
    const own = foldFooter(splitQuoted(m.body).top).main;
    const key = flat(own).slice(0, 60);
    const seg = key.length >= 12 && segs.find((x) => x.flat.includes(key));
    if (seg) seg.files += attachmentsHtml(m.attachments, meta(m), lang);
    else loose.push(`<div class="ax-msg ax-quoted"><p class="ax-qfrom">${esc(meta(m))}</p>${paras(clean(own))}${attachmentsHtml(m.attachments, meta(m), lang)}</div>`);
  }
  const earlier = segs.map((x) => `<div class="ax-msg ax-quoted">${paras(clean(x.text))}${x.files}</div>`).concat(loose);
  return `${from}<div class="ax-msg" data-clamp>${paras(clean(main))}</div>
    <button type="button" class="ax-more" data-more-toggle aria-expanded="false" data-more="${L("show_full")}" data-less="${L("show_less")}" hidden>${L("show_full")}${icon("chevron-down")}</button>
    ${tr ? `<div class="ax-tr" data-tr-box hidden><p class="wb-hint">${esc(t(lang, "translation_note").replace("{lang}", langDisplay(lang, (w.language || "").toLowerCase())))}</p><div class="ax-msg"${emailTrPending ? " data-tr-pending" : ""}>${emailTr ? paras(emailTr) : TR_SKEL(lang)}</div></div>` : ""}
    ${footer ? fold(L("footer_fold"), `<div class="ax-msg ax-quiet">${paras(clean(footer))}</div>`) : ""}
    ${files}
    ${earlier.length ? fold(`${L("earlier_msgs")} (${earlier.length})`, earlier.join("")) : ""}`;
}
// The skeleton a translation shows while it is fetched (the customer's email and the reply).
const TR_SKEL = (lang) => `<div class="wb-skel-rows" aria-label="${esc(t(lang, "translating"))}"><span class="wb-skel" style="width:90%"></span><span class="wb-skel" style="width:70%"></span></div>`;

// --- Icons: the Workbench stroke set (web/src/components/ui/icon.tsx), as markup ---------------
// Trusted static SVG, 16 px (20 on touch through the --icon token). [stroke width, inner markup].
const ICONS = {
  bolt: [2.4, '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10.5H12l1-8.5z"/>'],
  clock: [2, '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'],
  check: [2.4, '<polyline points="20 6 9 17 4 12"/>'],
  back: [2.2, '<polyline points="15 18 9 12 15 6"/>'],
  user: [2, '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  note: [2, '<path d="M4 4h16v12l-4 4H4Z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>'],
  search: [2.2, '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'],
  alert: [2.2, '<path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'],
  x: [2.2, '<path d="M6 6l12 12M18 6 6 18"/>'],
  refresh: [2, '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><polyline points="21 3 21 9 15 9"/>'],
  edit: [2, '<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'],
  clip: [2, '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'],
  mail: [2, '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>'],
  send: [2.2, '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>'],
  wand: [2, '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9 4 20M17.8 6.2 19 5M11.2 6.2 10 5"/>'],
  trash: [2, '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'],
  plus: [2.2, '<path d="M12 5v14M5 12h14"/>'],
  lock: [2, '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'],
  "chevron-down": [2.2, '<path d="m6 9 6 6 6-6"/>'],
  "chevron-right": [2.2, '<path d="m9 6 6 6-6 6"/>'],
  dots: [2.6, '<path d="M5 12h.01M12 12h.01M19 12h.01"/>'],
  info: [2.2, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'],
  home: [2.2, '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/>'],
  // Axle's own additions in the same stroke style (round 2): the reply's formatting, the camera, file
  // and photo chips, the customer's phone
  bold: [2.4, '<path d="M7 4h6.5a4 4 0 0 1 0 8H7zM7 12h7.5a4 4 0 0 1 0 8H7z"/>'],
  italic: [2.2, '<path d="M10 4h8M6 20h8M14.5 4l-5 16"/>'],
  underline: [2.2, '<path d="M7 4v6a5 5 0 0 0 10 0V4M5 20h14"/>'],
  list: [2.2, '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>'],
  camera: [2, '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>'],
  file: [2, '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'],
  image: [2, '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'],
  phone: [2, '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'],
};
const icon = (name, cls) => {
  const [w, d] = ICONS[name];
  return `<svg class="wb-i${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
};
// A square ghost icon button; the label is its accessible name and tooltip. attrs: pre-escaped;
// cls: extra classes.
const iconBtn = (label, name, attrs, cls) =>
  `<button type="button" class="wb-btn wb-btn--ghost wb-btn--icon${cls ? " " + cls : ""}" aria-label="${esc(label)}" title="${esc(label)}"${attrs ? " " + attrs : ""}>${icon(name)}</button>`;
// A pill: status (no border) in a tone; attrs pre-escaped.
const pill = (text, tone, attrs) => `<span class="wb-pill" data-tone="${tone || "neutral"}"${attrs ? " " + attrs : ""}>${esc(text)}</span>`;
// The house link to the Workbench home, drawn only when Axle runs under Workbench's base path.
const homeLink = (lang) => B
  ? `<a class="wb-btn wb-btn--ghost wb-btn--icon" href="/#/" aria-label="${esc(t(lang, "workbench_home"))}" title="${esc(t(lang, "workbench_home"))}">${icon("home")}</a>`
  : "";

// Bump on any assets/* change so browsers re-fetch (express.static serves the
// files; the query string only busts the cache).
const ASSET_V = "ax15";  // 2026-10-09: live refresh no longer held by a focused row; handover note, return label

// The words axle.js shows itself (toasts, banners, the compose drawer, the draft protection).
const CLIENT_KEYS = [
  "close", "cancel", "confirm_ok", "retry", "unchanged", "post_failed", "load_failed_title", "load_error",
  "updated", "syncing", "sync_started", "pull_refresh", "refreshing",
  "restored", "restore_offer", "restore", "discard", "draft_kept",
  "compose_finding", "compose_pick_address", "compose_pick_customer", "compose_not_found", "compose_guest",
  "compose_frozen", "compose_frozen_pill", "compose_need_pick", "compose_need_instr", "compose_need_subject",
  "file_too_big", "attach_total", "remove",
  "inbox", "details", "not_sent", "nothing_sent", "pick_doc", "doc_other_cust", "attach_failed",
  "viewer_title", "viewer_count", "viewer_prev", "viewer_next", "viewer_open",
];
const clientStrings = (lang) =>
  JSON.stringify(Object.fromEntries(CLIENT_KEYS.map((k) => [k, t(lang, k)]))).replace(/</g, "\\u003c");

// The work area when no email is open: one sentence, the empty-inbox one while the list is empty
// (axle.css shows it when .ax carries data-empty).
const voidPane = (lang) =>
  `<div class="ax-void"><p class="ax-void__pick">${esc(t(lang, "shell_select"))}</p><p class="ax-void__empty">${esc(t(lang, "nothing_waiting"))}</p></div>`;

// page(): the document shell. Links the shared tokens and vocabulary, Axle's layout sheet, htmx and
// axle.js. Framed in Workbench (user.inFrame) Axle draws no bar at all; standalone it draws one slim
// top bar (the panes add their own on a phone, see axle.css). opts.shell: body is the queue and work
// area (shell()), with the void template axle.js restores; otherwise body sits in the page column,
// after opts.head (a desk page's own phone bar, see deskPage()), both in .ax-pagewrap.
// htmx: refreshOnHistoryMiss makes a back/forward without a cached snapshot a plain full reload.
function page(title, user, body, refreshSec, opts) {
  const lang = langOK(user.lang);
  const isShell = !!(opts && opts.shell);
  const cls = ["wb-app", "ax-doc", user.inFrame ? "is-framed" : "", (opts && opts.bodyClass) || ""].filter(Boolean).join(" ");
  const top = user.inFrame ? "" : `<header class="wb-page__hd ax-top">${homeLink(lang)}<a class="ax-top__t" href="${B}/">Axle</a></header>`;
  return `<!doctype html><html lang="${lang === "nl" ? "nl" : "en-GB"}" data-base="${B}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}
<title>${esc(title)} · Axle</title>
<link rel="stylesheet" href="${B}/assets/tokens.css?v=${ASSET_V}">
<link rel="stylesheet" href="${B}/assets/vocabulary.css?v=${ASSET_V}">
<link rel="stylesheet" href="${B}/assets/axle.css?v=${ASSET_V}">
<meta name="htmx-config" content='{"refreshOnHistoryMiss":true,"historyCacheSize":0,"timeout":60000}'>
<script src="${B}/assets/htmx.min.js?v=${ASSET_V}" defer></script>
<script src="${B}/assets/reply-format.js?v=${ASSET_V}" defer></script>
<script src="${B}/assets/axle-editor.js?v=${ASSET_V}" defer></script>
<script src="${B}/assets/axle.js?v=${ASSET_V}" defer></script>
<script type="application/json" id="ax-l10n">${clientStrings(lang)}</script>
</head><body class="${esc(cls)}">
${top}
${isShell ? body + `<template id="ax-void">${voidPane(lang)}</template>` : `<div class="ax-pagewrap">${(opts && opts.head) || ""}<main class="ax-page">${body}</main></div>`}
</body></html>`;
}

// A desk page (blocked senders, Teach review, audit log, adoption, a result or error): on a phone
// standalone its own top bar (back, the title), from 640 up a back link and the title, then the body.
// opts.count: a number beside the title; opts.back: { href, label } (default: the inbox).
function deskPage(title, user, body, opts = {}) {
  const lang = langOK(user.lang);
  const count = opts.count != null ? `<span class="wb-count">${esc(opts.count)}</span>` : "";
  const back = opts.back || { href: B + "/", label: t(lang, "inbox") };
  return page(title, user,
    `<a class="wb-link ax-back" href="${esc(back.href)}">${icon("back")}${esc(back.label)}</a><h1 class="ax-h1">${esc(title)}${count}</h1>${body}`,
    null, { head: `<header class="wb-page__hd ax-ptop"><a class="wb-btn wb-btn--ghost wb-btn--icon" href="${esc(back.href)}" aria-label="${esc(back.label)}">${icon("back")}</a><h1 class="wb-page__t">${esc(title)} ${count}</h1></header>` });
}
// A Banner: tone bad (with role alert), warn or info; html is pre-escaped.
const bannerHtml = (tone, html) =>
  `<div class="wb-banner" data-tone="${tone}"${tone === "bad" ? ' role="alert"' : ""}>${icon(tone === "info" ? "info" : "alert")}<div class="wb-banner__body">${html}</div></div>`;
// A page that only says what went wrong (not found, owners only, a fetch that failed).
const bannerPage = (title, user, message, opts) => deskPage(title, user, bannerHtml("bad", esc(message)), opts);
const notFoundPage = (user) => bannerPage(t(user.lang, "not_found_t"), user, t(user.lang, "not_found"));

// --- The queue and the work area -------------------------------------------------------------
// The work area is ONE swappable unit (#workpane): a queue row asks htmx to replace its contents
// with the fragment GET /item/:id returns for an HX request, so browsing never reloads the queue.
// workPanes() frames a pane that is not an email (the not-found and route-error panes, server.js
// passes an empty second argument from the old three-pane days): the back controls and the content.
const workPanes = (html, _context, opts) => {
  const lang = (opts && opts.lang) || "en";
  return `<div class="ax-email" data-ax-pane><header class="wb-page__hd ax-ptop"><a class="wb-btn wb-btn--ghost wb-btn--icon" href="${B}/" data-back aria-label="${esc(t(lang, "inbox"))}">${icon("back")}</a><h1 class="wb-page__t">${esc((opts && opts.title) || "")}</h1></header><div class="ax-col"><a class="wb-link ax-back" href="${B}/" data-back>${icon("back")}${esc(t(lang, "inbox"))}</a>${html}</div></div>`;
};

// queueHtml is the inline-rendered queue (GET /) or lazyQueue() below. empty: the open list has no
// rows, so the work area says so.
const shell = (queueHtml, panesHtml, empty) =>
  `<div class="ax"${empty ? " data-empty" : ""}><aside class="ax-queue" id="queuepane">${queueHtml}</aside>` +
  `<main class="ax-main" id="workpane">${panesHtml}</main></div>`;

// Lazy queue for item deep links: htmx fills it from GET /queue after load, so a plain GET
// /item/:id keeps exactly its side effects (no inbox audit row, no summary translations). Skeleton
// rows while it loads; without JS, a link back to the inbox.
const SKELROW = `<div class="ax-skelrow"><span class="wb-skel" style="width:38%"></span><span class="wb-skel" style="width:66%"></span><span class="wb-skel" style="width:86%"></span></div>`;
const lazyQueue = (lang, qs) =>
  `<div hx-get="${B}/queue${qs ? "?" + esc(qs) : ""}" hx-trigger="load" hx-target="#queuepane" hx-swap="innerHTML" aria-busy="true">${SKELROW.repeat(5)}<noscript><a class="wb-link" href="${B}/">${esc(t(lang, "inbox"))}</a></noscript></div>`;

module.exports = {
  esc, UI_LANGS, DEFAULT_LANG, langOK, STRINGS, t,
  titleCase, statusLabel, statusWithRes, suggestCloseChip, intentLabel, langDisplay,
  ownerLabel, ownerChoices, TZ, ymdTZ, fmtTime, parseTS, fmtDateTime,
  linkify, splitQuoted, fmtSize, paras, replyParas, page, TR_SKEL,
  foldFooter, segmentQuoted, renderTimeline, ASSET_V,
  icon, iconBtn, pill, homeLink, voidPane, workPanes, shell, lazyQueue, SKELROW,
  deskPage, bannerHtml, bannerPage, notFoundPage,
};
