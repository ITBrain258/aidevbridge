# Speicher der Testinstanz alle 5 s, bis sie endet: agentbridge.exe aus <Acc>\app.pid und alle
# Nachfahren, die msedgewebview2.exe mit dem eigenen --user-data-dir sind. Je Prozess Private
# Bytes, Working Set, CPU-Sekunden, GPU-Speicher dediziert und geteilt (MB). Eine Zeile je Probe:
# {"t":ms,"p":[[pid,typ,privat,ws,cpu,gpuDed,gpuShr],...]}; typ ist app, browser oder --type=.
# Usage: pwsh -NoProfile -File mem.ps1 -Acc <ordner> -Out <mem.jsonl> [-Samples n] [-UserData <ordner>]
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$Out, [int]$Samples = 0,
  [string]$UserData = (Join-Path $Acc 'webview2'))
$ErrorActionPreference = 'Stop'
function mb($bytes) { [math]::Round($bytes / 1MB, 1) }
$root = [int](Get-Content -LiteralPath (Join-Path $Acc 'app.pid') -Raw)
for ($i = 0; ($Samples -eq 0 -or $i -lt $Samples) -and (Get-Process -Id $root -ErrorAction SilentlyContinue); $i++) {
  $next = (Get-Date).AddSeconds(5)
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate
  $tree = @($all | Where-Object ProcessId -eq $root)
  for ($j = 0; $j -lt $tree.Count; $j++) { $tree += @($all | Where-Object { $_.ParentProcessId -eq $tree[$j].ProcessId -and $_.CreationDate -ge $tree[$j].CreationDate }) }
  $gpu = @{}
  foreach ($s in (Get-Counter '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples) {
    if ($s.InstanceName -match '^pid_(\d+)_') {
      $key = "$($Matches[1]) $(($s.Path -replace '.*\\').ToLower())"
      $gpu[$key] = ($gpu[$key] ?? 0) + $s.CookedValue
    }
  }
  $rows = [System.Collections.Generic.List[object]]::new()
  foreach ($x in $tree) {
    if ($x.Name -eq 'msedgewebview2.exe' -and $x.CommandLine -notlike "*--user-data-dir=*$UserData*") { continue }
    $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
    if (-not $g) { continue }
    $type = if ($x.Name -ne 'msedgewebview2.exe') { 'app' } elseif ($x.CommandLine -match '--type=(\S+)') { $Matches[1] } else { 'browser' }
    $rows.Add(@($x.ProcessId, $type, (mb $g.PrivateMemorySize64), (mb $g.WorkingSet64), [math]::Round($g.TotalProcessorTime.TotalSeconds, 2),
        (mb ($gpu["$($x.ProcessId) dedicated usage"] ?? 0)), (mb ($gpu["$($x.ProcessId) shared usage"] ?? 0))))
  }
  Add-Content -LiteralPath $Out -Value (@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); p = $rows } | ConvertTo-Json -Compress -Depth 5)
  if ($Samples -eq 0 -or $i + 1 -lt $Samples) { Start-Sleep -Milliseconds ([math]::Max(0, ($next - (Get-Date)).TotalMilliseconds)) }
}
