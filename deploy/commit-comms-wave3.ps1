# Commit + push: Customer Comms wave 3, the Axle side (25 Oct 2026). Explicit paths only.
#   The "Unsubscribe <token>" mail rule (the unsubscribe footer's mailto fallback, handled by Workbench and
#   marked read), the "Notify when back in stock" rows in the Shopify account menu (POST /item/:id/notify-stock,
#   recorded in Workbench with source axle) and GET /api/replies for Workbench's nightly outcomes pass
#   (loopback, no Serve header, X-Agent-Token). All three go through comms-client.js.
# Commits only. Deploy is a separate step (deploy.ps1), after the Workbench wave 3 deploy.
function Step($what) { if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: $what failed. Nothing further was done." -ForegroundColor Red; exit 1 } }
$trailer = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01JeattX21mVkR6pcjbw68UA"

Set-Location C:\Admin\Projects\Axle
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: something is already staged (another session?). Run git diff --cached --stat and sort it out first." -ForegroundColor Red; exit 1 }
git add box-code/comms-client.js box-code/comms-client.test.js `
        box-code/rules.js box-code/rules.test.js box-code/ingest.js box-code/server.js `
        box-code/routes/item.js box-code/views/ui.js box-code/assets/axle.js `
        deploy/commit-comms-wave3.ps1
Step "git add"
git commit -m "Axle: Customer Comms wave 3, Unsubscribe <token> mail rule, Notify when back in stock, GET /api/replies for the outcomes pass" -m "Unsubscribe mails with a valid token are handled through Workbench POST /api/comms/unsubscribe and marked read; anything else stays for a human. The Shopify account menu lists the part codes the latest draft names, each recording the customer's back-in-stock interest (POST /api/comms/interest, source axle). GET /api/replies answers the first inbound message per address after since, token-guarded on loopback. Audited as comms_unsubscribe, comms_interest, comms_replies." -m $trailer
Step "git commit"
git push
Step "git push"
git log --oneline -1
Write-Host "Committed and pushed. Next: .\deploy.ps1" -ForegroundColor Green
# Restart only, if needed after the deploy: .\restart-axle.ps1
