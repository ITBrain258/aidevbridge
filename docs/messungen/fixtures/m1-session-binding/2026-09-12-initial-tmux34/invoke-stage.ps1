param(
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$RemoteCommand,
    [Parameter(Mandatory=$true)][string]$Source,
    [Parameter(Mandatory=$true)][string]$ExpectedSourceSha256
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$archive = $PSScriptRoot
if ($Stage -notmatch '^[a-z0-9-]+$') { throw 'Invalid stage' }
if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSourceSha256) { throw 'Source hash mismatch' }
$outPath = Join-Path $archive ($Stage + '.jsonl')
$errPath = $outPath + '.stderr'
$exitPath = $outPath + '.exit'
foreach ($p in @($outPath, $errPath, $exitPath, ($outPath + '.invocation.json'))) { if (Test-Path -LiteralPath $p) { throw 'Stage already exists' } }
$arguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', 'u@192.0.2.20', $RemoteCommand)
$metadata = @{ stage=$Stage; source=$Source; source_sha256=$ExpectedSourceSha256; executable='C:\Windows\System32\OpenSSH\ssh.exe'; arguments=$arguments; started_utc=[DateTime]::UtcNow.ToString('o') }
[IO.File]::WriteAllText(($outPath + '.invocation.json'), ($metadata | ConvertTo-Json -Depth 4), $utf8)
$info = [Diagnostics.ProcessStartInfo]::new($metadata.executable)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($argument in $arguments) { [void]$info.ArgumentList.Add($argument) }
$outStream = [IO.FileStream]::new($outPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$errStream = [IO.FileStream]::new($errPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$writeFailure = $null
try {
    if (-not $process.Start()) { throw 'SSH did not start' }
    Write-Output ('LIVE SSH PID ' + $process.Id + ' stage ' + $Stage + ' archive ' + $archive)
    $outTask = $process.StandardOutput.BaseStream.CopyToAsync($outStream)
    $errTask = $process.StandardError.BaseStream.CopyToAsync($errStream)
    try {
        $sourceBytes = [IO.File]::ReadAllBytes($Source)
        $process.StandardInput.BaseStream.Write($sourceBytes, 0, $sourceBytes.Length)
        $process.StandardInput.Close()
    } catch { $writeFailure = $_.Exception.ToString(); try { $process.StandardInput.Close() } catch {} }
    $process.WaitForExit()
    $outTask.GetAwaiter().GetResult()
    $errTask.GetAwaiter().GetResult()
    $code = $process.ExitCode
    [IO.File]::WriteAllText($exitPath, ($code.ToString() + "`n"), $utf8)
    if ($writeFailure) { [IO.File]::WriteAllText(($outPath + '.stdin-error'), $writeFailure, $utf8) }
} finally { $outStream.Dispose(); $errStream.Dispose(); $process.Dispose() }
Write-Output ('TERMINAL stage=' + $Stage + ' exit=' + $code + ' stdout_bytes=' + (Get-Item -LiteralPath $outPath).Length + ' stderr_bytes=' + (Get-Item -LiteralPath $errPath).Length)
if ($writeFailure -or $code -ne 0) { throw ('SSH stage failed: ' + $Stage + ', actual exit ' + $code) }
