# axle-pull.ps1 (v5) - place Taildropped files into the Axle tree.
# v5 (UI rework step 0): the app tree now has subfolders (views\, routes\, hardening\).
# Routing rule: a file goes to where a file of that NAME already lives ANYWHERE under
# C:\Axle\app (node_modules excluded). Basenames are unique across the tree by
# convention; if a name is ever found in two places the file is SKIPPED with a warning.
# A name found nowhere is NEW: placed in the app root only when it came from
# C:\Axle\_incoming (same contract as before - brand-new subfolder files are placed
# manually once, after which they update normally).
# Looks in two inboxes so it works regardless of Tailscale's "save received files to"
# setting:
#   1) C:\Axle\_incoming            - dedicated Taildrop folder (recommended)
#   2) %USERPROFILE%\Downloads      - default; only recent files that match a known Axle
#                                     file are touched, so nothing unrelated is disturbed.
# Strips any " (N)" collision suffix, copies over the live file, runs node --check on every
# .js, and removes the consumed copy.
#   Mac: axle-send.sh server.js routes/item.js views/ui.js ...   Box: C:\Axle\axle-pull.ps1
$app  = "C:\Axle\app"
$rx   = "C:\Axle\_incoming"
$dl   = Join-Path $env:USERPROFILE "Downloads"
New-Item -ItemType Directory -Force $rx | Out-Null

function Canon([string]$name) { return [regex]::Replace($name, '^(.*?) \(\d+\)(\.[^.]+)$', '$1$2') }
# Every place a file of this name already lives under the app tree (node_modules excluded).
function Homes([string]$canon) {
  return @(Get-ChildItem $app -Recurse -File -Filter $canon -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\node_modules\\' })
}

$jobs = @()
foreach ($f in (Get-ChildItem $rx -File -ErrorAction SilentlyContinue)) {
  $jobs += [pscustomobject]@{ Path = $f.FullName; Name = (Canon $f.Name); New = $true }
}
$cut = (Get-Date).AddMinutes(-30)
foreach ($f in (Get-ChildItem $dl -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $cut })) {
  $canon = Canon $f.Name
  if ((Homes $canon).Count -ge 1) { $jobs += [pscustomobject]@{ Path = $f.FullName; Name = $canon; New = $false } }
}
if (-not $jobs) { Write-Host "Nothing to place. (Send from the Mac, then re-run.)"; return }

$jobs = $jobs | Sort-Object { (Get-Item $_.Path).LastWriteTime } -Descending |
        Group-Object Name | ForEach-Object { $_.Group[0] }

$bad = 0
foreach ($j in $jobs) {
  $homes = Homes $j.Name
  if ($homes.Count -gt 1) {
    Write-Host ("  SKIP  " + $j.Name + "  (name exists in " + $homes.Count + " places: " +
      (($homes | ForEach-Object { $_.Directory.FullName.Replace($app, 'app') }) -join ', ') + " - resolve manually)") -ForegroundColor Red
    $bad++; continue
  }
  if ($homes.Count -eq 1) { $dest = $homes[0].FullName }
  elseif ($j.New) {
    $dest = Join-Path $app $j.Name
    Write-Host ("  NEW   " + $j.Name + "  -> app root (move it once if it belongs in views\ or routes\)") -ForegroundColor Yellow
  } else { continue }
  Copy-Item $j.Path $dest -Force
  $where = Split-Path $dest -Parent
  if ([IO.Path]::GetExtension($j.Name) -ieq ".js") {
    & node --check $dest 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host ("  OK    " + $j.Name + "  -> " + $where) -ForegroundColor Green }
    else { Write-Host ("  FAIL  " + $j.Name + "  (node --check failed - do NOT restart)") -ForegroundColor Red; $bad++ }
  } else { Write-Host ("  saved " + $j.Name + "  -> " + $where) }
  Remove-Item $j.Path -Force
}
Write-Host ""
if ($bad) { Write-Host "$bad file(s) failed/skipped - resolve before committing/restarting." -ForegroundColor Red }
else { Write-Host "All files placed and syntax-checked. Next: git commit; restart server if server code changed." -ForegroundColor Green }
