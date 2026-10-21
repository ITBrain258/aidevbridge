# Run the repository's explicit Windows delivery pipeline. No installation or publication.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [IntPtr]::Size -ne 8) {
    throw 'The Windows x64 delivery build requires 64-bit PowerShell 7 on Windows.'
}
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $taskRepository
try {
    & node (Join-Path $PSScriptRoot 'release-windows-artifacts.mjs') build
    if ($LASTEXITCODE -ne 0) {
        throw "Windows delivery failed (exit $LASTEXITCODE). Retained run files identify the failed stage."
    }
} finally {
    Pop-Location
}
