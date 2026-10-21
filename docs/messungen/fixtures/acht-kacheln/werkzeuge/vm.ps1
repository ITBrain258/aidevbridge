# Fuehrt vm.sh auf 192.0.2.20 aus; das Skript geht byte-genau ueber stdin (ohne angehaengtes CRLF).
# Usage: pwsh -NoProfile -File vm.ps1 <socket> <befehl> [argumente...]
param([Parameter(Mandatory)][string]$Socket, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
Get-Content -AsByteStream -Raw -LiteralPath (Join-Path $PSScriptRoot 'vm.sh') |
  ssh -i C:/Users/U/.ssh/abtest_rsa -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 u@192.0.2.20 bash -s -- $Socket @Rest
exit $LASTEXITCODE
