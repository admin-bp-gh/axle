# Commit + push: A3 same email in info@ and drachten@ (reference rule, then AI topic in the classify gate; the other copy closed as duplicate and logged) and A4 print this email / whole thread (26 Oct 2026).
# Commits only. Deploy is a separate step (deploy.ps1).
function Step($what) { if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: $what failed. Nothing further was done." -ForegroundColor Red; exit 1 } }
$trailer = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01Lxop6hkhqf1mvbwnauiwkh"

Set-Location C:\Admin\Projects\Axle
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: something is already staged (another session?). Run git diff --cached --stat and sort it out first." -ForegroundColor Red; exit 1 }
git add box-code/engine.js box-code/ingest.js box-code/sap-doc-pdf.js box-code/routes/item.js box-code/views/ui.js box-code/dual-mailbox.js box-code/dual-mailbox.test.js box-code/print-view.js box-code/print-view.test.js commit-dual-mailbox-print.ps1
Step "git add"
git commit -m "Axle: duplicate email in both mailboxes kept in one (reference rule, then AI topic), print this email or whole thread" -m $trailer
Step "git commit"
git push
Step "git push"
git log --oneline -1
Write-Host "Committed and pushed. Next: .\deploy.ps1" -ForegroundColor Green
