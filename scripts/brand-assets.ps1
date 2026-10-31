<#
.SYNOPSIS
Erzeugt alle Logo-Dateien der App aus src-tauri/icons/source.png.

.DESCRIPTION
source.png ist das freigestellte Logo mit transparentem Hintergrund. Daraus
entstehen
  src-tauri/icons/*                Desktop-Icons, mit `tauri icon`
  src-tauri/gen/android/.../res    Android-Launcher, Vordergrund, Hintergrund
  src/assets/logo.png              Logo im Erststart, 256 x 256
  docs/images/logo.png             Logo im README, 400 x 400
Android kennt kein Icon ohne Flaeche: der Launcher legt den Vordergrund auf eine
Hintergrundebene und schneidet auf seine Form zu. Deshalb steht das Logo dort
verkleinert in der sicheren Zone auf dunklem Grund. ic_launcher_monochrome.png
bleibt unveraendert: das Zeichen fuer Themed Icons ist das `>_` aus dem Logo.
Die Store-Grafiken macht scripts/android-store-graphics.ps1.
Gerendert mit Microsoft Edge im Headless-Modus, wie dort auch.

.EXAMPLE
pwsh -File scripts/brand-assets.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root 'src-tauri\icons'
$source = Join-Path $icons 'source.png'
$res = Join-Path $root 'src-tauri\gen\android\app\src\main\res'
# ab-bg-canvas aus src/styles.css, dieselbe Flaeche wie der Startbildschirm
$canvas = '#15171C'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge fehlt.' }

$work = Join-Path ([System.IO.Path]::GetTempPath()) "aidevbridge-brand-assets-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
$logoUri = ([System.Uri]$source).AbsoluteUri
$script:renderCount = 0

# Rendert das Logo auf eine transparente Leinwand. $percent ist die Kantenlaenge
# des Logos, $background und $radius beschreiben die Flaeche dahinter.
function Render-Logo([int]$size, [double]$percent, [string]$background, [string]$radius, [string]$target) {
  $page = Join-Path $work "page-$size.html"
  $edgeOfLogo = $size * $percent / 100
  $offset = ($size - $edgeOfLogo) / 2
  Set-Content -Encoding utf8 $page @"
<!doctype html><html><head><style>
html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
#f{position:absolute;left:0;top:0;width:${size}px;height:${size}px;background:$background;border-radius:$radius}
img{position:absolute;left:${offset}px;top:${offset}px;width:${edgeOfLogo}px;height:${edgeOfLogo}px}
</style></head><body><div id="f"></div><img src="$logoUri"></body></html>
"@
  $shot = Join-Path $work 'shot.png'
  if (Test-Path -LiteralPath $shot) { [System.IO.File]::Delete($shot) }
  $uri = ([System.Uri]$page).AbsoluteUri
  # Eigenes Profil je Aufruf und ein Zeitlimit: mit einem geteilten Profil blieb
  # Edge beim Nachfolger eines noch laufenden Prozesses haengen.
  $script:renderCount++
  $edgeArgs = @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', '--allow-file-access-from-files',
    "--user-data-dir=$(Join-Path $work "profile-$script:renderCount")",
    "--window-size=$size,$size", "--screenshot=$shot", $uri
  )
  $process = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden
  if (-not $process.WaitForExit(60000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Edge hat $target nicht in 60 s geschrieben."
  }
  for ($i = 0; $i -lt 25 -and -not (Test-Path -LiteralPath $shot); $i++) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path -LiteralPath $shot)) { throw "Edge hat $target nicht geschrieben." }
  New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
  Copy-Item $shot $target -Force
  Write-Host (Resolve-Path -Relative -LiteralPath $target)
}

try {
  Push-Location $root
  # Desktop: `tauri icon` schreibt auch android/ und ios/ in das Ziel, davon
  # wird nur die oberste Ebene gebraucht.
  $desktop = Join-Path $work 'desktop'
  & npx --no-install tauri icon $source -o $desktop | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'tauri icon ist fehlgeschlagen.' }
  Get-ChildItem -File $desktop | Copy-Item -Destination $icons -Force

  # Android: Vordergrund und Hintergrund sind 108 dp gross, sicher sind die
  # mittleren 66 dp. Das Logo reicht bis in seine Ecken, 64 Prozent halten es
  # in diesem Kreis. Die Launcher-Icons fuer Android 7 sind 48 dp.
  $densities = [ordered]@{ mdpi = 1.0; hdpi = 1.5; xhdpi = 2.0; xxhdpi = 3.0; xxxhdpi = 4.0 }
  foreach ($density in $densities.GetEnumerator()) {
    $dir = Join-Path $res "mipmap-$($density.Key)"
    $layer = [int](108 * $density.Value)
    $legacy = [int](48 * $density.Value)
    Render-Logo $layer 64 'transparent' '0' (Join-Path $dir 'ic_launcher_foreground.png')
    Render-Logo $layer 0 $canvas '0' (Join-Path $dir 'ic_launcher_background.png')
    Render-Logo $legacy 90 $canvas '18%' (Join-Path $dir 'ic_launcher.png')
    Render-Logo $legacy 78 $canvas '50%' (Join-Path $dir 'ic_launcher_round.png')
  }

  Render-Logo 256 100 'transparent' '0' (Join-Path $root 'src\assets\logo.png')
  Render-Logo 400 100 'transparent' '0' (Join-Path $root 'docs\images\logo.png')
} finally {
  Pop-Location
  Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
