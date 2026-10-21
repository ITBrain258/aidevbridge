# Fensterwaechter der Testinstanz, alle 2 s bis sie endet: ist ihr Fenster maximiert oder minimiert,
# im Vordergrund, ist ihre Windows-Sitzung verbunden (Remote Desktop: nicht getrennt) und nicht
# gesperrt? Eine Zeile je Probe in <Out>: {"t":ms,"zoomed","iconic","fg","active","locked"}.
# Ein Lauf gilt nur, wenn ueber seine ganze Dauer zoomed=true, iconic=false, active=true und
# locked=false war. Gesperrt heisst LogonUI in DERSELBEN Sitzung: Bei Remote Desktop zeigt die
# Konsolensitzung immer den Anmeldebildschirm, das sperrt die eigene Sitzung nicht.
# Usage: pwsh -NoProfile -File win.ps1 -Acc <ordner> -Out <win.jsonl> [-Once]
param([Parameter(Mandatory)][string]$Acc, [string]$Out = '', [switch]$Once)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AbWatch2 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformation(System.IntPtr server, int session, int infoClass, out System.IntPtr buffer, out int bytes);
[DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(System.IntPtr memory);
public static int ConnectState(int session) {
  System.IntPtr buffer; int bytes;
  if (!WTSQuerySessionInformation(System.IntPtr.Zero, session, 8, out buffer, out bytes)) return -1;
  try { return System.Runtime.InteropServices.Marshal.ReadInt32(buffer); } finally { WTSFreeMemory(buffer); }
}
'@
$root = [int](Get-Content -LiteralPath (Join-Path $Acc 'app.pid') -Raw)
$h = [IntPtr][int64](Get-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Raw)
$session = (Get-Process -Id $root).SessionId
function probe {
  [ordered]@{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    zoomed = [AbWatch2.Native]::IsZoomed($h)
    iconic = [AbWatch2.Native]::IsIconic($h)
    fg = [AbWatch2.Native]::GetForegroundWindow() -eq $h
    active = [AbWatch2.Native]::ConnectState($session) -eq 0
    locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
  }
}
if ($Once) {
  $p = probe
  $ok = $p.zoomed -and -not $p.iconic -and $p.active -and -not $p.locked
  "fenster zoomed=$($p.zoomed) iconic=$($p.iconic) fg=$($p.fg) sitzung-aktiv=$($p.active) gesperrt=$($p.locked) ok=$ok"
  exit ($ok ? 0 : 1)
}
while (Get-Process -Id $root -ErrorAction SilentlyContinue) {
  $next = (Get-Date).AddSeconds(2)
  Add-Content -LiteralPath $Out -Value ((probe) | ConvertTo-Json -Compress)
  Start-Sleep -Milliseconds ([math]::Max(0, ($next - (Get-Date)).TotalMilliseconds))
}
