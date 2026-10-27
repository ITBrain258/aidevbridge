<#
.SYNOPSIS
Hinterlegt den Android-Signaturschluessel und optional den Zugang zu Google
Play als Secrets im GitHub-Environment "android-release".

.DESCRIPTION
Der Workflow .github/workflows/android.yml signiert ein Release nur im Job
"sign" und laedt es nur im Job "play" zu Google Play hoch; beide lesen ihre
Secrets aus dem Environment "android-release" und sonst niemand
(docs/specs/2026-10-27-android-design.md §6). Dieses Skript legt das
Environment an, falls es fehlt, und setzt

  ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
  ANDROID_KEY_PASSWORD   aus <SigningDir>\keystore.properties und der .jks
  PLAY_SERVICE_ACCOUNT_JSON   nur mit -PlayServiceAccountJson

Kein Wert erscheint auf der Kommandozeile eines Prozesses: Die Schluessel
gehen ueber eine temporaere dotenv-Datei (`gh secret set -f`), die danach
geloescht wird, das JSON ueber die Standardeingabe.

Voraussetzung: GitHub CLI, angemeldet mit Schreibrecht auf das Repository
(`gh auth login`).

.EXAMPLE
pwsh -File scripts/android-github-secrets.ps1

.EXAMPLE
pwsh -File scripts/android-github-secrets.ps1 -PlayServiceAccountJson "$HOME\Downloads\aidevbridge-play.json"
#>
param(
  [string]$SigningDir = (Join-Path $HOME 'aidevbridge-android-signing'),
  [string]$PlayServiceAccountJson = '',
  [string]$Repo = 'ITBrain258/aidevbridge',
  [switch]$SkipKeystore
)

$ErrorActionPreference = 'Stop'
$Environment = 'android-release'

function Invoke-Gh {
  & gh @args
  if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') ist gescheitert (Exit $LASTEXITCODE)" }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) fehlt: https://cli.github.com, danach "gh auth login".'
}
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh ist nicht angemeldet: "gh auth login" ausfuehren.' }

# Legt das Environment an oder laesst ein vorhandenes, wie es ist.
Invoke-Gh api --method PUT "repos/$Repo/environments/$Environment" --silent
Write-Host "Environment $Environment in $Repo ist da."

if (-not $SkipKeystore) {
  $propsFile = Join-Path $SigningDir 'keystore.properties'
  if (-not (Test-Path $propsFile)) { throw "$propsFile fehlt." }
  $props = @{}
  foreach ($line in Get-Content $propsFile) {
    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*?)\s*$') { $props[$Matches[1]] = $Matches[2] }
  }
  foreach ($key in 'storeFile', 'storePassword', 'keyAlias', 'keyPassword') {
    if (-not $props[$key]) { throw "$propsFile nennt $key nicht." }
  }
  $store = $props['storeFile']
  if (-not [System.IO.Path]::IsPathRooted($store)) { $store = Join-Path $SigningDir $store }
  if (-not (Test-Path $store)) { throw "Der Schluessel $store fehlt." }

  $dotenv = [System.IO.Path]::GetTempFileName()
  try {
    $lines = @(
      "ANDROID_KEYSTORE_BASE64=$([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($store)))",
      "ANDROID_KEYSTORE_PASSWORD=$($props['storePassword'])",
      "ANDROID_KEY_ALIAS=$($props['keyAlias'])",
      "ANDROID_KEY_PASSWORD=$($props['keyPassword'])"
    )
    [System.IO.File]::WriteAllLines($dotenv, $lines)
    Invoke-Gh secret set --env $Environment --repo $Repo -f $dotenv
  } finally {
    Remove-Item -Force $dotenv -ErrorAction SilentlyContinue
  }
  Write-Host 'Signaturschluessel hinterlegt.'
}

if ($PlayServiceAccountJson) {
  if (-not (Test-Path $PlayServiceAccountJson)) { throw "$PlayServiceAccountJson fehlt." }
  $json = Get-Content -Raw $PlayServiceAccountJson
  $null = $json | ConvertFrom-Json
  $json | & gh secret set PLAY_SERVICE_ACCOUNT_JSON --env $Environment --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw 'PLAY_SERVICE_ACCOUNT_JSON liess sich nicht setzen.' }
  Write-Host 'Zugang zu Google Play hinterlegt.'
}

Invoke-Gh secret list --env $Environment --repo $Repo
