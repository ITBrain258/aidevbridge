<#
.SYNOPSIS
Hinterlegt den Android-Signaturschluessel und optional den Zugang zu Google
Play als Secrets im GitHub-Environment "android-release".

.DESCRIPTION
Der Workflow .github/workflows/android.yml signiert ein Release nur im Job
"sign" und laedt es nur im Job "play" zu Google Play hoch; beide lesen ihre
Secrets aus dem Environment "android-release" und sonst niemand
(docs/specs/2026-10-27-android-design.md §6). Dieses Skript legt das
Environment an, falls es fehlt, laesst es nur noch von Tags v* benutzen und
setzt

  ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
  ANDROID_KEY_PASSWORD   aus <SigningDir>\keystore.properties und der .jks
  PLAY_SERVICE_ACCOUNT_JSON   nur mit -PlayServiceAccountJson

Die Regel "nur Tags v*" ist der eigentliche Schutz: Ohne sie koennte jeder
Workflow eines Branches im Repository das Environment nennen und den
Schluessel lesen. Mit -RequireApproval wartet zudem jeder Lauf, der es
benutzt, auf deine Freigabe in GitHub Actions (je Release zweimal: Signieren
und Upload zu Play).

Kein Wert erscheint auf der Kommandozeile eines Prozesses: Jedes Secret geht
ueber die Standardeingabe an `gh secret set`.

Voraussetzung: GitHub CLI, angemeldet mit Schreibrecht auf das Repository
(`gh auth login`).

.EXAMPLE
pwsh -File scripts/android-github-secrets.ps1

.EXAMPLE
pwsh -File scripts/android-github-secrets.ps1 -RequireApproval

.EXAMPLE
pwsh -File scripts/android-github-secrets.ps1 -SkipKeystore -PlayServiceAccountJson "$HOME\Downloads\aidevbridge-play.json"
#>
param(
  [string]$SigningDir = (Join-Path $HOME 'aidevbridge-android-signing'),
  [string]$PlayServiceAccountJson = '',
  [string]$Repo = 'ITBrain258/aidevbridge',
  [switch]$SkipKeystore,
  [switch]$RequireApproval
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

function Set-Secret([string]$Name, [string]$Value) {
  $Value | & gh secret set $Name --env $Environment --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw "$Name liess sich nicht setzen." }
}

# Die Escapes einer .properties-Datei, wie Gradle sie beim lokalen Bau liest
# (java.util.Properties): \\ \: \= \t \n \uXXXX und so weiter.
function ConvertFrom-PropertiesValue([string]$Value) {
  [regex]::Replace($Value, '\\(u[0-9a-fA-F]{4}|.)', {
      param($m)
      $c = $m.Groups[1].Value
      if ($c.Length -eq 5) { return [string][char][Convert]::ToInt32($c.Substring(1), 16) }
      switch -CaseSensitive ($c) { 't' { "`t" } 'n' { "`n" } 'r' { "`r" } 'f' { "`f" } default { $c } }
    })
}

# Legt das Environment an (oder behaelt ein vorhandenes) und erlaubt es nur
# noch Tags v*; mit -RequireApproval wartet jeder Lauf auf dich.
$settings = @{ deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } }
if ($RequireApproval) {
  $me = (& gh api user --jq .id)
  if ($LASTEXITCODE -ne 0) { throw 'Die eigene GitHub-Kennung liess sich nicht lesen.' }
  $settings.reviewers = @(@{ type = 'User'; id = [long]$me })
}
$settings | ConvertTo-Json -Depth 4 | & gh api --method PUT "repos/$Repo/environments/$Environment" --input - --silent
if ($LASTEXITCODE -ne 0) { throw "Das Environment $Environment liess sich nicht einrichten." }
$policies = (& gh api "repos/$Repo/environments/$Environment/deployment-branch-policies") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Die Regeln des Environments liessen sich nicht lesen.' }
if (-not ($policies.branch_policies | Where-Object { $_.type -eq 'tag' -and $_.name -eq 'v*' })) {
  Invoke-Gh api --method POST "repos/$Repo/environments/$Environment/deployment-branch-policies" -f 'name=v*' -f 'type=tag' --silent
}
Write-Host "Environment $Environment in $Repo ist da und nur fuer Tags v* freigegeben$(if ($RequireApproval) { ', mit deiner Freigabe' })."

if (-not $SkipKeystore) {
  $propsFile = Join-Path $SigningDir 'keystore.properties'
  if (-not (Test-Path $propsFile)) { throw "$propsFile fehlt." }
  $props = @{}
  foreach ($line in Get-Content $propsFile) {
    if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*?)\s*$') { $props[$Matches[1]] = ConvertFrom-PropertiesValue $Matches[2] }
  }
  foreach ($key in 'storeFile', 'storePassword', 'keyAlias', 'keyPassword') {
    if (-not $props[$key]) { throw "$propsFile nennt $key nicht." }
  }
  $store = $props['storeFile']
  if (-not [System.IO.Path]::IsPathRooted($store)) { $store = Join-Path $SigningDir $store }
  if (-not (Test-Path $store)) { throw "Der Schluessel $store fehlt." }

  # Einzeln ueber die Standardeingabe: Eine dotenv-Datei deutete `$`, `#`
  # und Anfuehrungszeichen in einem Passwort.
  Set-Secret ANDROID_KEYSTORE_BASE64 ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($store)))
  Set-Secret ANDROID_KEYSTORE_PASSWORD $props['storePassword']
  Set-Secret ANDROID_KEY_ALIAS $props['keyAlias']
  Set-Secret ANDROID_KEY_PASSWORD $props['keyPassword']
  Write-Host 'Signaturschluessel hinterlegt.'
}

if ($PlayServiceAccountJson) {
  if (-not (Test-Path $PlayServiceAccountJson)) { throw "$PlayServiceAccountJson fehlt." }
  $json = Get-Content -Raw $PlayServiceAccountJson
  $null = $json | ConvertFrom-Json
  Set-Secret PLAY_SERVICE_ACCOUNT_JSON $json
  Write-Host 'Zugang zu Google Play hinterlegt.'
}

Invoke-Gh secret list --env $Environment --repo $Repo
