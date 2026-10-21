# Fensterabnahme (Task 7, Step 2 und 3) an der laufenden Testinstanz: ein Aufruf je Punkt. Jeder Punkt
# haelt vorher und nachher Zeit und tmux-Clients fest, treibt das Fenster ueber abnahme.mjs (echte
# CDP-Eingaben) und wertet mit `ana.mjs check` aus. Alles geht zusaetzlich nach <LogDir>\abnahme.txt.
# Usage: pwsh -NoProfile -File abnahme.ps1 -Acc <ordner> -LogDir <ordner> -Socket <s> -Punkt <prep|p1|p2a|p2b|p3a|p3b|p3c|p4>
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$LogDir, [Parameter(Mandatory)][string]$Socket,
  [Parameter(Mandatory)][ValidateSet('prep', 'p1', 'p2a', 'p2b', 'p3a', 'p3b', 'p3c', 'p4')][string]$Punkt, [int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$log = Join-Path $LogDir 'abnahme.txt'
function say([string]$text) { $line = "$(Get-Date -Format HH:mm:ss) [$Punkt] $text"; $line; Add-Content -LiteralPath $log -Value $line }
function drive { $o = node (Join-Path $here 'abnahme.mjs') $Port @args 2>&1; $o | ForEach-Object { say "  $_" }; if ($LASTEXITCODE) { throw "abnahme.mjs $($args -join ' ')" } }
function vmState([string]$when) { $o = & (Join-Path $here 'vm.ps1') $Socket state 2>&1; say "vm state $($when):"; $o | ForEach-Object { say "  $_" } }
function now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function check([long]$from, [long]$to) { say "check $from $to"; node (Join-Path $here 'ana.mjs') $LogDir check $from $to 2>&1 | ForEach-Object { say "  $_" } }
function go([string]$mode, [string[]]$names) { & (Join-Path $here 'vm.ps1') $Socket go $mode @names | Out-Null; if ($LASTEXITCODE) { throw 'vm go' } }
$all8 = @('f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8')
switch ($Punkt) {
  'prep' {
    # f1-f8 als Kacheln 1-8, dazu acht-b mit b1 als Kachel 9.
    $state = (node (Join-Path $here 'abnahme.mjs') $Port state) -join ' '
    foreach ($s in 'f5', 'f6', 'f7', 'f8') { if ($state -notmatch ":$s[ ""]") { drive open acht-a $s; Start-Sleep -Seconds 2 } }
    $hosts = (node (Join-Path $here 'abnahme.mjs') $Port hosts) -join ' '
    if ($hosts -notmatch 'acht-b') { drive addhost acht-b 192.0.2.20 u 'C:\Users\U\.ssh\abtest_rsa'; Start-Sleep -Seconds 8 }
    drive hosts
    drive open acht-b b1
    Start-Sleep -Seconds 6
    drive state
    vmState 'nach prep'
  }
  'p2a' {
    vmState vorher; $from = now
    drive p2a
    $to = now; vmState nachher; check $from $to
  }
  'p2b' {
    vmState vorher; $from = now
    go L1 $all8
    say "Flut L1 f1-f8 ab $from (180 s)"
    drive p2b $LogDir
    $rest = 180000 - ((now) - $from); if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
    $to = $from + 180000; Start-Sleep -Seconds 5; vmState nachher; check $from $to
  }
  'p3a' {
    vmState vorher; $from = now
    drive p3
    $to = now; vmState nachher; check $from $to
  }
  'p3b' {
    vmState vorher; $from = now
    go L1 $all8
    say "Flut L1 f1-f8 ab $from (180 s)"
    Start-Sleep -Seconds 15
    drive p3
    $rest = 180000 - ((now) - $from); if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
    $to = $from + 180000; Start-Sleep -Seconds 5; vmState nachher; check $from $to
  }
  'p3c' {
    vmState vorher; $from = now
    drive p3c
    $to = now; vmState nachher; check $from $to
  }
  'p4' {
    vmState vorher; $from = now
    drive p4
    $to = now; vmState nachher; check $from $to
  }
  'p1' { throw 'p1 laeuft ueber neustart: stop.ps1, dann abnahme.mjs p1 im Hintergrund, dann start.ps1' }
}
