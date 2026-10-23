# Schliesst die Testinstanz wie ein Klick auf X (WM_CLOSE an ihr Fenster), wartet auf ihr Ende und
# spielt mit -Restore die gesicherte Fensterlage der installierten App zurueck.
# Usage: pwsh -NoProfile -File stop.ps1 -Acc <ordner> [-Restore]
param([Parameter(Mandatory)][string]$Acc, [switch]$Restore)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AbStop -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
'@
$appPid = [int](Get-Content -LiteralPath (Join-Path $Acc 'app.pid') -Raw).Trim()
$h = [IntPtr][int64](Get-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Raw).Trim()
$p = Get-Process -Id $appPid -ErrorAction SilentlyContinue
if ($p) {
  [void][AbStop.Native]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  if (-not $p.WaitForExit(15000)) { throw "Testinstanz $appPid endet nicht" }
  "beendet nach WM_CLOSE"
} else { "lief nicht" }
if ($Restore) {
  $ws = Join-Path $env:APPDATA 'io.github.itbrain258.aidevbridge\.window-state.json'
  $bak = Join-Path $Acc 'window-state.backup.json'
  if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $ws -Force; "Fensterlage zurueckgespielt" }
}
