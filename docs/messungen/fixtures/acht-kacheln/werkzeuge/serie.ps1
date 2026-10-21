# Die ganze Messreihe auf einer laufenden Testinstanz, in der Reihenfolge des Plans:
# N4-L1, N6-L1, N8-L1, N8-L2, N4-L2. Vorher und nachher je Lauf eine erzwungene Speicherbereinigung
# (gc.mjs); Kacheln oeffnet und schliesst abnahme.mjs ueber echte Klicks. Jeder Lauf prueft vor
# jeder Phase das Fenster (run.ps1 -Acc); scheitert eine Pruefung, endet die Reihe dort.
# Usage: pwsh -NoProfile -File serie.ps1 -Acc <ordner> -LogDir <ordner> -Socket <s> [-Port 9333]
param([Parameter(Mandatory)][string]$Acc, [Parameter(Mandatory)][string]$LogDir, [Parameter(Mandatory)][string]$Socket, [int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
function drive { node (Join-Path $here 'abnahme.mjs') $Port @args; if ($LASTEXITCODE) { throw "abnahme.mjs $($args -join ' ')" } }
function forceGc([string]$label) { node (Join-Path $here 'gc.mjs') $Port $LogDir $label; if ($LASTEXITCODE) { throw "gc.mjs $label" } }
function tiles { (node (Join-Path $here 'abnahme.mjs') $Port state) -join ' ' }
function closeTo([int]$keep) {
  # schliesst die Kacheln hinter Position <keep>, von hinten
  $order = ((tiles) -replace '.*"order":"([^"]*)".*', '$1') -split ' '
  for ($n = $order.Count; $n -gt $keep; $n--) { drive close $n; Start-Sleep -Milliseconds 700 }
}
function openNames([string[]]$names) { foreach ($s in $names) { drive open acht-a $s; Start-Sleep -Seconds 2 } }
function run([string]$name, [string]$mode, [string[]]$names) {
  Start-Sleep -Seconds 10
  forceGc "$name-vor"
  & (Join-Path $here 'run.ps1') -LogDir $LogDir -Socket $Socket -Run $name -Mode $mode -Names ($names -join ',') -Acc $Acc
  forceGc "$name-nach"
  "$(Get-Date -Format HH:mm:ss) $name fertig: $(tiles)"
}
& (Join-Path $here 'win.ps1') -Acc $Acc -Once
if ($LASTEXITCODE) { throw 'Fenster nicht maximiert oder PC gesperrt' }
closeTo 4
"$(Get-Date -Format HH:mm:ss) Start: $(tiles)"
run 'N4-L1' 'L1' @('f1', 'f2', 'f3', 'f4')
openNames @('f5', 'f6')
run 'N6-L1' 'L1' @('f1', 'f2', 'f3', 'f4', 'f5', 'f6')
openNames @('f7', 'f8')
run 'N8-L1' 'L1' @('f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8')
run 'N8-L2' 'L2' @('f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8')
closeTo 4
run 'N4-L2' 'L2' @('f1', 'f2', 'f3', 'f4')
node (Join-Path $here 'ana.mjs') $LogDir | Set-Content -LiteralPath (Join-Path $LogDir 'ana.txt')
"$(Get-Date -Format HH:mm:ss) Reihe fertig"
