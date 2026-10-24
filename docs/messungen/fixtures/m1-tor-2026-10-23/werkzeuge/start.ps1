# Startet die abgeschottete Testinstanz (Debug-Bau) mit eigener settings.toml, eigenem tmux-Socket,
# eigenem WebView2-Ordner und CDP-Port, maximiert NUR ihr eigenes Fenster.
# Sichert beim ersten Start die mit der installierten App geteilte Fensterlage.
# Usage: pwsh -NoProfile -File start.ps1 -Acc <ordner> -Socket <socket> [-Port 9333]
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$Socket, [int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $Acc 'target\debug\aidevbridge.exe'
$ws = Join-Path $env:APPDATA 'io.github.itbrain258.aidevbridge\.window-state.json'
$bak = Join-Path $Acc 'window-state.backup.json'
if (-not (Test-Path -LiteralPath $bak) -and (Test-Path -LiteralPath $ws)) { Copy-Item -LiteralPath $ws -Destination $bak }
$other = @(Get-Process -Name aidevbridge -ErrorAction SilentlyContinue | Where-Object Path -ne $exe)
if ($other) { throw "andere aidevbridge laeuft ($($other.Path -join ', ')): erst schliessen" }
if (Get-Process -Name aidevbridge -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) { throw 'die Testinstanz laeuft schon' }
$logDir = Join-Path $Acc 'logs'
New-Item -ItemType Directory -Force -Path (Join-Path $Acc 'settings'), $logDir | Out-Null
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
$psi.Arguments = "/d /c `"`"$exe`" 1>>`"$logDir\app-stdout-$stamp.txt`" 2>>`"$logDir\app-stderr-$stamp.txt`"`""
$psi.WorkingDirectory = $Acc
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment['AIDEVBRIDGE_SETTINGS_DIR'] = Join-Path $Acc 'settings'
$psi.Environment['AIDEVBRIDGE_TMUX_SOCKET'] = $Socket
$psi.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $Acc 'webview2'
$psi.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-port=$Port"
$t0 = Get-Date
$cmd = [System.Diagnostics.Process]::Start($psi)
$app = $null
while (-not $app -and (Get-Date) -lt $t0.AddSeconds(20)) {
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($cmd.Id) AND Name='aidevbridge.exe'"
  if ($child) { $app = Get-Process -Id $child.ProcessId } else { Start-Sleep -Milliseconds 50 }
}
if (-not $app -or $app.Path -ne $exe) { throw "kein eigenes aidevbridge.exe unter cmd $($cmd.Id)" }
Set-Content -LiteralPath (Join-Path $Acc 'app.pid') -Value $app.Id -NoNewline
$h = [IntPtr]::Zero
while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $t0.AddSeconds(40)) {
  if ($app.HasExited) { throw 'die Instanz endete beim Start' }
  $found = [AbWin.Native]::FindTauri([uint32]$app.Id)
  if ($found -ne [IntPtr]::Zero -and [AbWin.Native]::IsWindowVisible($found)) { $h = $found } else { Start-Sleep -Milliseconds 50 }
}
if ($h -eq [IntPtr]::Zero) { throw 'kein sichtbares Tauri Window binnen 40 s' }
Set-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Value ([int64]$h) -NoNewline
Start-Sleep -Milliseconds 1500
$since = $null
$until = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $until) {
  if (-not [AbWin.Native]::IsZoomed($h)) { $since = $null; [void][AbWin.Native]::ShowWindow($h, 3) }
  elseif (-not $since) { $since = Get-Date }
  elseif (((Get-Date) - $since).TotalMilliseconds -ge 2000) { break }
  Start-Sleep -Milliseconds 50
}
"pid=$($app.Id) hwnd=$h maximiert=$([AbWin.Native]::IsZoomed($h)) nach $([int]((Get-Date) - $t0).TotalMilliseconds) ms"
