# Final live proof, 27 Sep 2026

Driven from Chrome on the box over Tailscale at the phone layout (inner width 500 to 549, the Chrome window minimum; not an iPhone), live tree at merge 2cba9a5 / HEAD 3c1e8ec, polaris20. Test item #2264, a compose draft to admin@budget-parts.nl. Nothing was sent: the Send confirm was intercepted in the page (window.confirm recorded the text and returned false, the Cancel path) and the item stayed Ready to send.

Sequence, all passed unless marked: New email full screen (01), fill and Draft, item #2264 opened Drafting with the skeleton reply and the disabled skeleton bar (seen, DOM-verified: 4 visible .sk, load delay:10s poller; no still saved), draft landed as Ready to send, reply edited, tab switch and reload showed "Unsaved edits restored" with the edit intact (03), recipient sheet (04) and Use address, text survived, Language and Owner sheets opened and closed without choosing (Owner unchanged: Brad), More actions sheet (06) opened and closed, Send now produced the confirm text with the full address, answered Cancel.

Finding F5 (02): the full-screen compose card is min-height 100dvh with overflow visible, so content taller than the viewport paints over the 45 percent scrim and the queue shows through below the card (content 884 to 1097px against a 701px card). Follow-up fix.
