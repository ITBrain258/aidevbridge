# Startet die abgeschottete Testinstanz aus <Acc> und maximiert NUR ihr eigenes Fenster.
# - Beim ersten Start sichert es die mit der echten App geteilte Fensterlage samt sha256 nach
#   <Acc>; spaeter bricht es ab, wenn die Datei nicht mehr der Sicherung gleicht.
# - Bricht ab, wenn eine andere agentbridge laeuft (etwa die App des Nutzers).
# - Der Debug-Bau ist eine Konsolen-App: Start unter cmd /c ohne Konsolenfenster, stdout und
#   stderr nach <LogDir>. Schreibt <Acc>\app.pid und <Acc>\app.hwnd.
# - Sucht das 'Tauri Window' der eigenen PID, laesst der Fensterlage 1,5 s fuer ihre
#   Wiederherstellung und maximiert, bis das Fenster 3 s maximiert bleibt.
# Usage: pwsh -NoProfile -File start.ps1 -Acc <ordner> -LogDir <ordner> -Socket abtest_<datum>_acht [-Port 9333]
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$LogDir, [Parameter(Mandatory)][string]$Socket, [int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $Acc 'target\debug\agentbridge.exe'
$ws = Join-Path $env:APPDATA 'dev.agentbridge.app\.window-state.json'
$bak = Join-Path $Acc 'window-state.backup.json'
$sha = Join-Path $Acc 'window-state.sha256'
if (-not (Test-Path -LiteralPath $bak)) {
  Copy-Item -LiteralPath $ws -Destination $bak
  Set-Content -LiteralPath $sha -Value (Get-FileHash -LiteralPath $bak).Hash -NoNewline
}
$want = (Get-Content -LiteralPath $sha -Raw).Trim()
$have = (Get-FileHash -LiteralPath $ws).Hash
"Fensterlage vor dem Start: $have (Sicherung $want, gleich=$($have -eq $want))"
if (Get-Process -Name agentbridge -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) { throw 'die Testinstanz laeuft schon' }
if ($have -ne $want) { throw 'Fensterlage weicht von der Sicherung ab: den Nutzer fragen, ob seine App lief; danach stop.ps1 (spielt zurueck) oder neue Sicherung' }
$other = @(Get-Process -Name agentbridge -ErrorAction SilentlyContinue | Where-Object Path -ne $exe); if ($other) { throw "andere agentbridge laeuft ($($other.Path -join ', ')): den Nutzer bitten, sie zu schliessen" }
New-Item -ItemType Directory -Force -Path (Join-Path $Acc 'settings'), $LogDir | Out-Null
Add-Type -Namespace AbWin -Name Native -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
public static System.IntPtr FindTauri(uint pid) {
  System.IntPtr found = System.IntPtr.Zero;
  EnumWindows((h, l) => {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p == pid) { var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "Tauri Window") { found = h; return false; } }
    return true; }, System.IntPtr.Zero);
  return found;
}
'@
$stamp = (Get-Date).ToUniversalTime().ToString('HHmmss')
$psi = [System.Diagnostics.ProcessStartInfo]::new($env:ComSpec)
$psi.Arguments = "/d /c `"`"$exe`" 1>>`"$LogDir\app-stdout-$stamp.txt`" 2>>`"$LogDir\app-stderr-$stamp.txt`"`""
$psi.WorkingDirectory = $Acc
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment['AGENTBRIDGE_SETTINGS_DIR'] = Join-Path $Acc 'settings'
$psi.Environment['AGENTBRIDGE_TMUX_SOCKET'] = $Socket
$psi.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $Acc 'webview2'
$psi.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-port=$Port"
$t0 = Get-Date
$cmd = [System.Diagnostics.Process]::Start($psi)
$app = $null
while (-not $app -and (Get-Date) -lt $t0.AddSeconds(15)) {
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($cmd.Id) AND Name='agentbridge.exe'"
  if ($child) { $app = Get-Process -Id $child.ProcessId } else { Start-Sleep -Milliseconds 20 }
}
if (-not $app -or $app.Path -ne $exe) { throw "kein eigenes agentbridge.exe unter cmd $($cmd.Id)" }
Set-Content -LiteralPath (Join-Path $Acc 'app.pid') -Value $app.Id -NoNewline
$h = [IntPtr]::Zero
while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $t0.AddSeconds(30)) {
  if ($app.HasExited) { throw 'die Instanz endete beim Start' }
  $found = [AbWin.Native]::FindTauri([uint32]$app.Id)
  if ($found -ne [IntPtr]::Zero -and [AbWin.Native]::IsWindowVisible($found)) { $h = $found } else { Start-Sleep -Milliseconds 20 }
}
if ($h -eq [IntPtr]::Zero) { throw 'kein sichtbares Tauri Window binnen 30 s' }
Set-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Value ([int64]$h) -NoNewline
Start-Sleep -Milliseconds 1500
$since = $null
$until = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $until) {
  if (-not [AbWin.Native]::IsZoomed($h)) { $since = $null; [void][AbWin.Native]::ShowWindow($h, 3) }
  elseif (-not $since) { $since = Get-Date }
  elseif (((Get-Date) - $since).TotalMilliseconds -ge 3000) { break }
  Start-Sleep -Milliseconds 20
}
"pid=$($app.Id) hwnd=$h maximiert=$([AbWin.Native]::IsZoomed($h)) nach $([int]((Get-Date) - $t0).TotalMilliseconds) ms"
Add-Content -LiteralPath (Join-Path $LogDir 'starts.txt') -Value ("{0} start pid={1} hwnd={2} fensterlage={3}" -f $t0.ToUniversalTime().ToString('o'), $app.Id, $h, $have)
