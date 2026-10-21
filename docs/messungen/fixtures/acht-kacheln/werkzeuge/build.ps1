# Baut die Testinstanz ausserhalb des Worktrees nach <Acc>: git archive HEAD, node_modules als
# Junction auf das des Worktrees, npm run build, dann der dev-Bau mit opt-level 3 in eigenem
# Zielordner. debug_assertions bleiben an; nur dann gelten die Test-Schalter (settings.rs:518-541).
# Junctions nur mit cmd /c rmdir loesen. Usage: pwsh -NoProfile -File build.ps1 -Acc <ordner> -Worktree <worktree>
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$Worktree)
$ErrorActionPreference = 'Stop'
$src = Join-Path $Acc 'src'
$junction = Join-Path $src 'node_modules'
$exe = Join-Path $Acc 'target\debug\agentbridge.exe'
if (Get-Process -Name agentbridge -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) { throw 'die Testinstanz laeuft' }
if (Test-Path -LiteralPath $junction) {
  if ((Get-Item -LiteralPath $junction -Force).LinkType -ne 'Junction') { throw 'node_modules in src ist keine Junction' }
  cmd /c rmdir "$junction"
  if (Test-Path -LiteralPath $junction) { throw 'Junction noch da' }
}
if (-not (Test-Path -LiteralPath (Join-Path $Worktree 'node_modules\vite'))) { throw 'node_modules des Worktrees fehlt' }
if (Test-Path -LiteralPath $src) { Remove-Item -LiteralPath $src -Recurse -Force }
New-Item -ItemType Directory -Force -Path $src | Out-Null
$commit = (git -C $Worktree rev-parse HEAD).Trim()
$tar = Join-Path $Acc "src-$commit.tar"
git -C $Worktree archive --format=tar -o $tar $commit
if ($LASTEXITCODE) { throw 'git archive' }
& "$env:SystemRoot\System32\tar.exe" -xf $tar -C $src
if ($LASTEXITCODE) { throw 'tar' }
cmd /c mklink /J "$junction" "$(Join-Path $Worktree 'node_modules')" | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $junction 'vite'))) { throw 'Junction wirkt nicht' }
Push-Location $src
try {
  npm run build 2>&1 | Select-Object -Last 4
  if ($LASTEXITCODE) { throw 'npm run build' }
} finally { Pop-Location }
Push-Location (Join-Path $src 'src-tauri')
try {
  $env:CARGO_TARGET_DIR = Join-Path $Acc 'target'
  $env:CARGO_PROFILE_DEV_OPT_LEVEL = '3'
  cargo build --locked --features tauri/custom-protocol 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE) { throw 'cargo build' }
} finally {
  Pop-Location
  Remove-Item Env:CARGO_TARGET_DIR, Env:CARGO_PROFILE_DEV_OPT_LEVEL -ErrorAction SilentlyContinue
}
$text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($exe))
foreach ($asset in Get-ChildItem -LiteralPath (Join-Path $src 'dist\assets') -File) { "Asset $($asset.Name) im Binary: $($text.Contains($asset.Name))" }
"Commit $commit, exe sha256 $((Get-FileHash -LiteralPath $exe).Hash)"
