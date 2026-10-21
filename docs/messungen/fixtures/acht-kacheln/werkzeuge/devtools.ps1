# Schliesst das DevTools-Fenster, das der Debug-Bau bei jedem Start oeffnet, per WM_CLOSE; nur Fenster
# aus dem eigenen Prozessbaum der Testinstanz (<Acc>\app.pid). Gibt die Zahl der geschlossenen aus.
# Usage: pwsh -NoProfile -File devtools.ps1 -Acc <ordner>
param([Parameter(Mandatory)][string]$Acc)
$ErrorActionPreference = 'Stop'
$appPid = [int](Get-Content -LiteralPath (Join-Path $Acc 'app.pid') -Raw).Trim()
$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate
$root = $all | Where-Object ProcessId -eq $appPid
if (-not $root) { throw "Testinstanz $appPid laeuft nicht" }
$tree = @($root); $frontier = @($root)
while ($frontier) { $next = @(); foreach ($f in $frontier) { $next += @($all | Where-Object { $_.ParentProcessId -eq $f.ProcessId -and $_.CreationDate -ge $f.CreationDate }) }; $tree += $next; $frontier = $next }
$pids = $tree.ProcessId
Add-Type -Namespace AbDev -Name Native -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
'@
$script:closed = 0
[AbDev.Native]::EnumWindows({ param($h, $l)
    $p = 0; [void][AbDev.Native]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -contains [int]$p -and [AbDev.Native]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256; [void][AbDev.Native]::GetWindowText($h, $sb, 256)
      if ("$sb".StartsWith('DevTools')) { [void][AbDev.Native]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $script:closed++ }
    }
    return $true }, [IntPtr]::Zero) | Out-Null
"DevTools geschlossen: $script:closed"
