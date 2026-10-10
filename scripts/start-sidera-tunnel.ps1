param([switch]$Doctor)
$ErrorActionPreference = 'Stop'
$sideraRoot = Split-Path -Parent $PSScriptRoot
$sideraTunnel = Join-Path $sideraRoot '.sidera-dev/tunnel'
if ($Doctor) {
    & pwsh -NoProfile -File (Join-Path $sideraTunnel 'run.ps1') -Doctor -Explain
    exit $LASTEXITCODE
}
$sideraMutex = [Threading.Mutex]::new($false, 'Local\Sidera-Tunnel-sidera-r1-astra-e2e')
$sideraHeld = $false
try {
    try { $sideraHeld = $sideraMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $sideraHeld = $true }
    if (-not $sideraHeld) { throw 'Sidera tunnel already has an owner; no duplicate client started.' }
    $sideraExisting = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -match '--profile\s+sidera-r1-astra-e2e(?:\s|$)'
    }
    if ($sideraExisting) { throw 'Sidera profile already has a live tunnel client; reconcile it without starting another.' }
    $sideraSecure = (Get-Content -LiteralPath (Join-Path $sideraTunnel 'runtime-key.dpapi') -Raw).Trim() | ConvertTo-SecureString
    $sideraPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sideraSecure)
    $env:SIDERA_TUNNEL_RUNTIME_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($sideraPtr)
    $sideraConnection = Get-Content -LiteralPath (Join-Path $sideraRoot '.sidera-dev/sol/data/connection.json') -Raw | ConvertFrom-Json
    $env:SIDERA_GPT_MCP_AUTH = 'Bearer ' + $sideraConnection.gptHttpToken
    Set-Location -LiteralPath $sideraRoot
    & node (Join-Path $PSScriptRoot 'tunnel-supervisor.ts')
    exit $LASTEXITCODE
} finally {
    if ($sideraPtr) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($sideraPtr) }
    if ($sideraSecure) { $sideraSecure.Dispose() }
    Remove-Item Env:SIDERA_TUNNEL_RUNTIME_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:SIDERA_GPT_MCP_AUTH -ErrorAction SilentlyContinue
    if ($sideraHeld) { $sideraMutex.ReleaseMutex() }
    $sideraMutex.Dispose()
}
