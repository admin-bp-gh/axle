# Commit + push: assets/vocabulary.css refreshed from Workbench (Booth wave 2 added .wb-page__aside), so vocabulary-sync passes (26 Oct 2026).
# Commits only. Deploy is a separate step (deploy.ps1).
function Step($what) { if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: $what failed. Nothing further was done." -ForegroundColor Red; exit 1 } }
$trailer = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01Lxop6hkhqf1mvbwnauiwkh"

Set-Location C:\Admin\Projects\Axle
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: something is already staged (another session?). Run git diff --cached --stat and sort it out first." -ForegroundColor Red; exit 1 }
git add box-code/assets/vocabulary.css commit-vocabulary-sync.ps1
Step "git add"
git commit -m "Axle: vocabulary.css refreshed from Workbench" -m $trailer
Step "git commit"
git push
Step "git push"
git log --oneline -1
Write-Host "Committed and pushed. Next: .\deploy.ps1" -ForegroundColor Green
