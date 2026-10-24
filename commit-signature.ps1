# Commit + push: the house signature block under every Axle reply and compose (24 Oct 2026).
#   signature.js renders Budget Parts B.V., both sites (the sending mailbox's first), phone and
#   roverparts.eu in the same style as the Workbench customer-comms footer; send-guard appends it
#   below our reply, above the quoted history. Text and its integrity hash are unchanged.
# Commits only. Deploy is a separate step (deploy.ps1).
function Step($what) { if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: $what failed. Nothing further was done." -ForegroundColor Red; exit 1 } }
$trailer = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01DQubTFHUxcFBhudn1Ef8GZ"

Set-Location C:\Admin\Projects\Axle
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: something is already staged (another session?). Run git diff --cached --stat and sort it out first." -ForegroundColor Red; exit 1 }
git add box-code/signature.js box-code/send-guard.js box-code/assets/vocabulary.css commit-signature.ps1
Step "git add"
git commit -m "Axle: house signature block (Budget Parts B.V., both sites, phone, roverparts.eu) under every reply and compose; vocabulary.css refreshed from Workbench" -m $trailer
Step "git commit"
git push
Step "git push"
git log --oneline -1
Write-Host "Committed and pushed. Next: .\deploy.ps1" -ForegroundColor Green
