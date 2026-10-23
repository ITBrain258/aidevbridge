# Fenster der Testinstanz: min | restore | front | title
# Usage: pwsh -NoProfile -File win.ps1 -Acc <ordner> -Do <min|restore|front|title>
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$Do)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace AbW -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
'@
$h = [IntPtr][int64](Get-Content -LiteralPath (Join-Path $Acc 'app.hwnd') -Raw).Trim()
switch ($Do) {
  'min' { [void][AbW.Native]::ShowWindow($h, 6) }
  'restore' { [void][AbW.Native]::ShowWindow($h, 9); Start-Sleep -Milliseconds 300; [void][AbW.Native]::ShowWindow($h, 3); [void][AbW.Native]::SetForegroundWindow($h) }
  'front' { [void][AbW.Native]::SetForegroundWindow($h) }
  'title' { }
}
$sb = New-Object System.Text.StringBuilder 256; [void][AbW.Native]::GetWindowText($h, $sb, 256)
"{0} titel='{1}' minimiert={2} vorn={3}" -f (Get-Date).ToString('HH:mm:ss.fff'), $sb, [AbW.Native]::IsIconic($h), ([AbW.Native]::GetForegroundWindow() -eq $h)
