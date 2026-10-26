# Commit + push: print with attachments (one PDF: email or thread, images under their message, PDF attachments appended via pdf-lib, other files listed); new tests added to deploy.ps1 (26 Oct 2026).
# Commits only. Deploy is a separate step (deploy.ps1).
function Step($what) { if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: $what failed. Nothing further was done." -ForegroundColor Red; exit 1 } }
$trailer = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01Lxop6hkhqf1mvbwnauiwkh"

Set-Location C:\Admin\Projects\Axle
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: something is already staged (another session?). Run git diff --cached --stat and sort it out first." -ForegroundColor Red; exit 1 }
git add box-code/package.json box-code/package-lock.json box-code/print-view.js box-code/views/ui.js box-code/assets/axle.js box-code/assets/axle.css box-code/routes/item.js box-code/print-attachments.js box-code/print-attachments.test.js deploy.ps1 commit-print-attachments.ps1
Step "git add"
git commit -m "Axle: print email or thread with attachments as one PDF (pdf-lib)" -m $trailer
Step "git commit"
git push
Step "git push"
git log --oneline -1
Write-Host "Committed and pushed. Next: .\deploy.ps1" -ForegroundColor Green
