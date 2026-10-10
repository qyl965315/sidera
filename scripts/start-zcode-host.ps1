param([switch]$Build)
$ErrorActionPreference = 'Stop'
$sideraRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$zcodeRoot = Join-Path $sideraRoot '.sidera-dev/zcode'
$upstream = Join-Path $zcodeRoot 'upstream'
$pinnedCommit = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
$agentEntry = if ($env:SIDERA_ZCODE_AGENT_ENTRY) { $env:SIDERA_ZCODE_AGENT_ENTRY } else { Join-Path $zcodeRoot 'host/resources/glm/zcode.cjs' }
$serverEntry = Join-Path $upstream 'packages/server/dist/entry-http.js'
$sdkEntry = Join-Path $zcodeRoot 'sdk-entry.ts'
$sdkBundle = Join-Path $zcodeRoot 'sdk.mjs'

if (-not (Test-Path -LiteralPath $agentEntry -PathType Leaf)) {
    throw 'Installed official ZCode Agent entry is missing. Set SIDERA_ZCODE_AGENT_ENTRY to the existing official bundle; this script does not install or log in.'
}
if (-not (Test-Path -LiteralPath (Join-Path $upstream '.git'))) {
    if (-not $Build) { throw 'Pinned official service is missing. Run this script with -Build to build it.' }
    New-Item -ItemType Directory -Force -Path $zcodeRoot | Out-Null
    & git clone --no-checkout https://github.com/zai-org/ZCode $upstream
    if ($LASTEXITCODE -ne 0) { throw 'Official ZCode source clone failed.' }
    & git -C $upstream checkout --detach $pinnedCommit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned official ZCode checkout failed.' }
}
$actualCommit = (& git -C $upstream rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $pinnedCommit) { throw 'ZCode source differs from the verified pin. Review a Host upgrade explicitly.' }
if ($Build) {
    Push-Location -LiteralPath $upstream
    try {
        & node scripts/check-workspace-freshness.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Official workspace freshness check failed.' }
        & npx.cmd --yes pnpm@10.33.2 --filter '@zcode/server...' install --ignore-scripts --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Pinned ZCode dependencies failed.' }
        & npx.cmd --yes pnpm@10.33.2 --filter '@zcode/server' exec tsup
        if ($LASTEXITCODE -ne 0) { throw 'Pinned ZCode service build failed.' }
        Set-Content -LiteralPath $sdkEntry -Encoding utf8NoBOM -Value "export {connectViaWebSocket} from './upstream/packages/client/src/index.ts';"
        & npx.cmd --yes pnpm@10.33.2 --filter '@zcode/server' exec esbuild $sdkEntry --bundle --platform=node --format=esm "--outfile=$sdkBundle"
        if ($LASTEXITCODE -ne 0) { throw 'Official ZCode SDK bundle failed.' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf) -or -not (Test-Path -LiteralPath $sdkBundle -PathType Leaf)) {
    throw 'Pinned service/SDK build is missing. Run with -Build.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 19389 -ErrorAction SilentlyContinue) {
    throw 'Port 19389 is already in use. Preserve the existing Host; do not start another.'
}
# Account credentials remain in the official Host. Do not offer unrelated API billing paths.
foreach ($variable in @('DEEPSEEK_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','ZAI_API_KEY','ZHIPU_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY')) {
    [System.Environment]::SetEnvironmentVariable($variable, $null, 'Process')
}
$env:PORT = '19389'
$env:ZCODE_SERVER_HOST = '127.0.0.1'
$env:ZCODE_AGENT_SERVER_COMMAND = (Get-Command node).Source
$env:ZCODE_AGENT_SERVER_ARGS_JSON = ConvertTo-Json -Compress -InputObject @($agentEntry, 'app-server', '--stdio')
Push-Location -LiteralPath $upstream
try {
    Write-Host 'Sidera GLM: starting the pinned official loopback ZCode service. Existing Human account login stays in the Host.'
    & node $serverEntry
    if ($LASTEXITCODE -ne 0) { throw 'ZCode service stopped with an error.' }
} finally { Pop-Location }
