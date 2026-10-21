# Ein Lauf der Lastmessung: Uhrabstand, 60 s Ruhe, Flut (L1 180 s, L2 120 s) auf den genannten
# Sessions, 60 s Nachlauf, Uhrabstand. Davor und danach Last und tmux-Clients der VM, zuletzt
# probe.log und flood.log der VM (lokal als .txt: *.log steht in .gitignore). Marken: phases.jsonl.
# Mit -Acc bricht der Lauf vor jeder Phase ab, wenn das Fenster der Testinstanz nicht maximiert
# oder der PC gesperrt ist (win.ps1 -Once); die Marke heisst dann invalid.
# Usage: pwsh -NoProfile -File run.ps1 -LogDir <ordner> -Socket <s> -Run N4-L1 -Mode L1 -Names f1,f2,f3,f4 [-Acc <ordner>]
param([Parameter(Mandatory)][string]$LogDir, [Parameter(Mandatory)][string]$Socket, [Parameter(Mandatory)][string]$Run,
  [Parameter(Mandatory)][ValidateSet('L1', 'L2')][string]$Mode, [Parameter(Mandatory)][string]$Names, [string]$Acc = '')
$ErrorActionPreference = 'Stop'
function vm {
  & (Join-Path $PSScriptRoot 'vm.ps1') $Socket @args
  if ($LASTEXITCODE) { throw "vm.sh $($args -join ' ') endete mit $LASTEXITCODE" }
}
function mark([string]$name) {
  if ($Acc) {
    $state = & (Join-Path $PSScriptRoot 'win.ps1') -Acc $Acc -Once
    if ($LASTEXITCODE) {
      Add-Content -LiteralPath (Join-Path $LogDir 'phases.jsonl') -Value (@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); run = $Run; mark = 'invalid' } | ConvertTo-Json -Compress)
      throw "$Run vor $name ungueltig: $state"
    }
  }
  $line = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); run = $Run; mark = $name } | ConvertTo-Json -Compress
  Add-Content -LiteralPath (Join-Path $LogDir 'phases.jsonl') -Value $line
  "$(Get-Date -Format HH:mm:ss) $Run $name"
}
function clock([string]$when) {
  node (Join-Path $PSScriptRoot 'clock.mjs') (Join-Path $LogDir 'clock.jsonl') "$Run-$when"
  if ($LASTEXITCODE) { throw 'clock.mjs' }
}
clock before
vm state | Set-Content -LiteralPath (Join-Path $LogDir "vm-$Run-before.txt")
mark idle
Start-Sleep -Seconds 60
mark flood
$list = $Names -split ','
vm go $Mode @list | Out-Null
Start-Sleep -Seconds ($Mode -eq 'L1' ? 180 : 120)
mark rest
Start-Sleep -Seconds 60
mark end
vm state | Set-Content -LiteralPath (Join-Path $LogDir "vm-$Run-after.txt")
clock after
foreach ($name in 'probe', 'flood') { vm logs "$name.log" | Set-Content -LiteralPath (Join-Path $LogDir "$name.txt") }
