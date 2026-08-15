# deploy.ps1 — sync the box to the repo, prove it, restart.
#
# The standing deploy tool. Replaces the pile of one-off scripts written on 2026-08-12: it works
# out for itself which files changed, so there is nothing to edit between deploys — just
# right-click -> "Run with PowerShell" whenever the repo is ahead of the box.
#
# What it does, stopping at the first problem:
#   1. Compares every file under box-code\ with its counterpart in C:\Axle\app and stages the ones
#      that differ (content hash, not timestamp — a re-copied identical file is not a change).
#   2. Runs axle-pull.ps1, which places each file and node --checks the JS.
#   3. Runs the test suites AGAINST THE LIVE TREE. Any failure: stops without restarting.
#   4. Restarts the Axle Server task and confirms the PID changed.
#
# Self-elevates: the task runs as the low-privilege `axle` account, so an unelevated restart
# fails with "Access is denied". Logs line by line to deploy.log so the result survives even if
# the window closes, and pauses at the end.
#
# Deploys UPDATES to files that already exist on the box. A repo file with no counterpart in the
# live tree is listed but NOT sent unless you pass -IncludeNew: most such files are repo-only dev
# helpers, not pending deploys.
#
# Flags (optional, for a shell):  -WhatIf  list changes and stop.   -NoRestart  deploy but leave
# the running server alone (safe for test-only or asset-only changes).   -IncludeNew  also send
# files the box does not have yet.

param([switch]$WhatIf, [switch]$NoRestart, [switch]$IncludeNew)

# Files that live in the repo but must NEVER be pushed to the box. On its first run (2026-08-12)
# this script treated "absent from the live tree" as "deploy it" and pushed 14 such files,
# including a second copy of axle-pull.ps1 INSIDE app\ — the real one lives at C:\Axle\axle-pull.ps1
# and a duplicate is an invitation to edit the wrong one. Nothing broke, but the box should hold
# what it runs and nothing else. New files now also need -IncludeNew (see below).
$neverDeploy = @(
  "axle-pull.ps1",        # box tooling: lives at C:\Axle\, not in the app tree
  "axle-send.sh",         # Mac-side helper
  "shared-domains.js"     # marked obsolete in its own header
)

$repo = "C:\Admin\Projects\Axle"
$src  = Join-Path $repo "box-code"
$app  = "C:\Axle\app"
$log  = Join-Path $repo "deploy.log"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated - relaunching as administrator (approve the UAC prompt)..." -ForegroundColor Yellow
  $argList = @("-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`"")
  if ($WhatIf)     { $argList += "-WhatIf" }
  if ($NoRestart)  { $argList += "-NoRestart" }
  if ($IncludeNew) { $argList += "-IncludeNew" }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  Start-Sleep -Seconds 3     # keep this window up briefly so a failed relaunch is visible
  exit
}

"=== deploy.ps1  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Encoding utf8
function Say($msg, $colour = "Gray") {
  Write-Host $msg -ForegroundColor $colour
  $msg | Out-File $log -Append -Encoding utf8
}

# The suites worth running on every deploy: pure, fast, no live systems needed.
$suites = @("accuracy-gates.test.js","fitment-gate.test.js","part-dossier.test.js","part-finder.test.js")

try {
  Say "Running as: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
  if (-not (Test-Path $src)) { throw "repo source missing: $src" }
  if (-not (Test-Path $app)) { throw "live tree missing: $app" }

  Say "`n=== 1. Comparing repo -> box ===" "Cyan"
  $changed = @(); $skippedNew = @()
  Get-ChildItem $src -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $neverDeploy -notcontains $_.Name } |
    ForEach-Object {
      $rel  = $_.FullName.Substring($src.Length).TrimStart('\')
      $dest = Join-Path $app $rel
      $isNew = -not (Test-Path $dest)
      $differs = $isNew -or
                 ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $dest -Algorithm SHA256).Hash)
      if (-not $differs) { return }
      # Default is UPDATES ONLY. A file absent from the box is usually repo-only (a dev helper, a
      # harness) rather than something waiting to be deployed, so adding it is an explicit choice.
      if ($isNew -and -not $IncludeNew) { $skippedNew += $rel; return }
      $changed += [pscustomobject]@{ Rel = $rel; Path = $_.FullName; New = $isNew }
    }

  if ($skippedNew.Count) {
    Say ("  {0} repo-only file(s) NOT on the box - re-run with -IncludeNew to add them:" -f $skippedNew.Count) "Yellow"
    foreach ($n in $skippedNew) { Say "      $n" }
  }
  if (-not $changed.Count) {
    Say "  box already matches the repo - nothing to deploy." "Green"
    if (-not $NoRestart) { Say "  (no restart needed)" }
    return
  }
  foreach ($c in $changed) { Say ("  {0}  {1}" -f $(if ($c.New) { "NEW " } else { "diff" }), $c.Rel) }

  # --- 1b. Dependency check -------------------------------------------------------------------
  # Added 2026-08-15, after this script took the server down. It skipped the NEW file
  # outlook-block.js (correctly, per the -IncludeNew rule), then deployed the MODIFIED
  # routes\admin.js that had just gained `require("../outlook-block.js")`, passed every suite (they
  # exercise other modules and never load admin.js), restarted, and left Axle dead. The warning
  # about repo-only files was printed several screens earlier and is easy to miss.
  #
  # So: every relative require in a file we are about to deploy must resolve to something that will
  # exist on the box afterwards - either already there, or going out in this same run. Anything
  # else stops the deploy BEFORE a single file moves, which is the only safe moment.
  Say "`n=== 1b. Dependency check ===" "Cyan"
  $deploying = @{}
  foreach ($c in $changed) { $deploying[$c.Rel.Replace('\','/').ToLower()] = $true }
  $broken = @()
  foreach ($c in ($changed | Where-Object { $_.Rel -like "*.js" })) {
    $text = Get-Content $c.Path -Raw
    foreach ($m in [regex]::Matches($text, 'require\(\s*["''](\.[^"'']+)["'']\s*\)')) {
      $req = $m.Groups[1].Value
      # Resolve relative to the file's own folder IN THE LIVE TREE, then try the usual Node
      # resolution order: exact, +.js, +.json, /index.js.
      $baseDir = Split-Path (Join-Path $app $c.Rel) -Parent
      $cand = @($req, "$req.js", "$req.json", "$req/index.js") | ForEach-Object {
        [IO.Path]::GetFullPath((Join-Path $baseDir ($_ -replace '/','\')))
      }
      $ok = $false
      foreach ($p in $cand) {
        if (Test-Path $p) { $ok = $true; break }
        # Only paths inside the app tree can be satisfied by this run; a require that climbs out of
        # it (..\..\something) is left to Test-Path alone rather than mangled by Substring.
        if ($p.StartsWith($app, [StringComparison]::OrdinalIgnoreCase)) {
          $rel = $p.Substring($app.Length).TrimStart('\').Replace('\','/').ToLower()
          if ($deploying.ContainsKey($rel)) { $ok = $true; break }   # arriving in this same run
        }
      }
      if (-not $ok) { $broken += [pscustomobject]@{ File = $c.Rel; Requires = $req } }
    }
  }
  if ($broken.Count) {
    foreach ($b in $broken) {
      $missing = Split-Path $b.Requires -Leaf
      $hint = if ($skippedNew | Where-Object { (Split-Path $_ -Leaf) -like "$missing*" }) {
        "it is in the repo-only list above - re-run with -IncludeNew, or place it by hand first"
      } else { "it is missing from the repo as well - nothing can deploy this file" }
      Say ("  [X] {0} requires {1} which will NOT be on the box - {2}" -f $b.File, $b.Requires, $hint) "Red"
    }
    throw ("{0} unmet dependency(ies) - NOTHING deployed, server untouched." -f $broken.Count)
  }
  Say ("  all relative requires in {0} changed file(s) resolve on the box." -f $changed.Count) "Green"
  if ($WhatIf) { Say "`n-WhatIf: stopping without changing anything." "Yellow"; return }

  Say "`n=== 2. Staging + placing ===" "Cyan"
  New-Item -ItemType Directory -Force "C:\Axle\_incoming" | Out-Null
  foreach ($c in $changed) { Copy-Item $c.Path "C:\Axle\_incoming" -Force }
  & C:\Axle\axle-pull.ps1 2>&1 | ForEach-Object { Say "  $_" }

  # axle-pull routes by BASENAME. A brand-new file destined for a subfolder lands in the app root
  # and must be moved once by hand - flag it rather than let it sit in the wrong place unnoticed.
  foreach ($c in $changed) {
    $dest = Join-Path $app $c.Rel
    if (-not (Test-Path $dest)) {
      Say ("  [!] {0} did not land at its expected path - check where axle-pull put it." -f $c.Rel) "Yellow"
    }
  }

  Say "`n=== 3. Test suites against the LIVE tree ===" "Cyan"
  Push-Location $app
  $failed = @()
  foreach ($s in $suites) {
    if (-not (Test-Path (Join-Path $app $s))) { Say "  (skipped $s - not deployed)"; continue }
    & node $s 2>&1 | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { $failed += $s }
  }
  Pop-Location
  if ($failed.Count) { throw ("TESTS FAILED: " + ($failed -join ", ") + " - NOT restarting. Fix, then re-run.") }

  if ($NoRestart) { Say "`n-NoRestart: files are live, server left running." "Yellow"; return }

  Say "`n=== 4. Restarting Axle Server ===" "Cyan"
  $before = (Get-NetTCPConnection -LocalPort 8484 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  Stop-ScheduledTask  -TaskName "Axle Server"
  Start-ScheduledTask -TaskName "Axle Server"
  Start-Sleep -Seconds 10
  $after = (Get-NetTCPConnection -LocalPort 8484 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if (-not $after) { throw "Server is DOWN after restart - check C:\Axle\logs\server.log" }
  Say "  before PID $before / after PID $after" "Green"
  if ($before -and $before -eq $after) { Say "  WARNING: same PID - it may not have restarted." "Yellow" }

  Say "`nDEPLOY OK - now hard-refresh Axle over Tailscale and check the change on a real item." "Green"
}
catch {
  Say "`nFAILED: $($_.Exception.Message)" "Red"
  Say $_.ScriptStackTrace
}
finally {
  Write-Host "`nFull log: $log"
  Read-Host "`nPress Enter to close"
}
