<#
.SYNOPSIS
Rendert die Grafiken des Play-Store-Eintrags aus fastlane/store-graphics.

.DESCRIPTION
Schreibt fuer jede Sprache unter fastlane/metadata/android
  images/icon.png            512 x 512, aus play-icon.html
  images/featureGraphic.png  1024 x 500, aus feature-graphic.html
Gerendert mit Microsoft Edge im Headless-Modus, der auf jedem Windows 10 und
11 vorhanden ist. Die Bildschirmfotos (images/phoneScreenshots) entstehen
nicht hier, sondern auf einem Geraet oder im Emulator
(docs/android-veroeffentlichung.md).

.EXAMPLE
pwsh -File scripts/android-store-graphics.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'fastlane\store-graphics'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge fehlt.' }

$work = Join-Path ([System.IO.Path]::GetTempPath()) "aidevbridge-store-graphics-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
try {
  function Render([string]$page, [int]$width, [int]$height, [string]$target) {
    $uri = ([System.Uri](Resolve-Path $page).Path).AbsoluteUri
    $profile = Join-Path $work "profile-$width"
    & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
      "--user-data-dir=$profile" "--window-size=$width,$height" "--screenshot=$target" $uri 2>$null | Out-Null
    for ($i = 0; $i -lt 50 -and -not (Test-Path $target); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $target)) { throw "Edge hat $target nicht geschrieben." }
  }

  $icon = Join-Path $work 'icon.png'
  $feature = Join-Path $work 'featureGraphic.png'
  Render (Join-Path $source 'play-icon.html') 512 512 $icon
  Render (Join-Path $source 'feature-graphic.html') 1024 500 $feature

  foreach ($locale in Get-ChildItem -Directory (Join-Path $root 'fastlane\metadata\android')) {
    $images = Join-Path $locale.FullName 'images'
    New-Item -ItemType Directory -Force $images | Out-Null
    Copy-Item $icon (Join-Path $images 'icon.png') -Force
    Copy-Item $feature (Join-Path $images 'featureGraphic.png') -Force
    Write-Host "$($locale.Name): icon.png, featureGraphic.png"
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
