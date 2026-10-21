# Schliesst die Testinstanz ueber ihre eigene PID (CloseMainWindow auf ihr Tauri-Fenster, sonst
# WM_CLOSE an genau dieses Fenster), spielt die Fensterlage aus der Sicherung zurueck und prueft
# die sha256. Usage: pwsh -NoProfile -File stop.ps1 -Acc <ordner> -LogDir <ordner>
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$LogDir)
$ErrorActionPreference = 'Stop'
$ws = Join-Path $env:APPDATA 'dev.agentbridge.app\.window-state.json'
$want = (Get-Content -LiteralPath (Join-Path $Acc 'window-state.sha256') -Raw).Trim()
$procId = [int](Get-Content -LiteralPath (Join-Path $Acc 'app.pid') -Raw)
$hwnd = [IntPtr][int64](Get-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Raw)
Add-Type -Namespace AbWinS -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
'@
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
if ($p) {
  if ($p.Path -ne (Join-Path $Acc 'target\debug\agentbridge.exe')) { throw "pid $procId ist nicht die Testinstanz: $($p.Path)" }
  $owner = [uint32]0
  [void][AbWinS.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  $cls = [System.Text.StringBuilder]::new(64)
  [void][AbWinS.Native]::GetClassName($hwnd, $cls, 64)
  if ($owner -ne $procId -or "$cls" -ne 'Tauri Window') { throw "hwnd $hwnd ist nicht das Fenster der Testinstanz ($owner, '$cls')" }
  if ($p.MainWindowHandle -eq $hwnd) { [void]$p.CloseMainWindow() }
  else { [void][AbWinS.Native]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  if (-not $p.WaitForExit(20000)) { throw "pid $procId endete nicht binnen 20 s" }
}
Copy-Item -LiteralPath (Join-Path $Acc 'window-state.backup.json') -Destination $ws -Force
$after = (Get-FileHash -LiteralPath $ws).Hash
"pid $procId beendet; Fensterlage $after (Sicherung $want, ok=$($after -eq $want))"
Add-Content -LiteralPath (Join-Path $LogDir 'starts.txt') -Value ("{0} stop pid={1} fensterlage={2} ok={3}" -f (Get-Date).ToUniversalTime().ToString('o'), $procId, $after, ($after -eq $want))
if ($after -ne $want) { throw 'Fensterlage nicht zurueckgespielt' }
