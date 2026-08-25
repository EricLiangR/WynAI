param(
    [string]$Version = '1.0.4',
    [string]$NodeRuntimeZip = '',
    [switch]$SkipTests,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$ExpectedNodeVersion = 'v18.20.8'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$PackageTemplate = Join-Path $ProjectRoot 'deploy\windows\package'
$WinSWSource = Join-Path $ProjectRoot 'deploy\windows\assets\WinSW-x64.exe'
if (-not $NodeRuntimeZip) { $NodeRuntimeZip = Join-Path $ProjectRoot 'deploy\windows\assets\node-v18.20.8-win-x64.zip' }
$ReleaseRoot = Join-Path $ProjectRoot 'release\windows'
$NodeExtractRoot = Join-Path $ReleaseRoot '_node-runtime'
$PackageName = "WynAI-$Version-windows-x64"
$StageDir = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"
$ZipHashPath = "$ZipPath.sha256"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-Exists([string]$path, [string]$description) {
    if (-not (Test-Path -LiteralPath $path)) { throw "$description not found: $path" }
}

function Invoke-Native([string]$description, [scriptblock]$command) {
    Write-Host "[RUN] $description" -ForegroundColor Cyan
    & $command
    if ($LASTEXITCODE -ne 0) { throw "$description failed with exit code $LASTEXITCODE" }
}

function Get-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid release version: $Version" }
Assert-Exists $PackageTemplate 'Windows package template'
Assert-Exists $WinSWSource 'WinSW asset'
Assert-Exists $NodeRuntimeZip 'Node runtime ZIP'
if (-not (Test-Path -LiteralPath $ReleaseRoot)) { New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null }
if (Test-Path -LiteralPath $NodeExtractRoot) { Remove-Item -LiteralPath $NodeExtractRoot -Recurse -Force }
New-Item -ItemType Directory -Path $NodeExtractRoot -Force | Out-Null
$tarExe = (Get-Command tar.exe -ErrorAction Stop).Source
Invoke-Native 'extract Node runtime' { & $tarExe -xf $NodeRuntimeZip -C $NodeExtractRoot }
$NodeSourceDir = Get-ChildItem -LiteralPath $NodeExtractRoot -Directory | Select-Object -First 1
if (-not $NodeSourceDir) { throw "Node runtime directory not found after extracting $NodeRuntimeZip" }
$NodeExe = Join-Path $NodeSourceDir.FullName 'node.exe'
$NpmExe = Join-Path $NodeSourceDir.FullName 'npm.cmd'
$NodeLicense = Join-Path $NodeSourceDir.FullName 'LICENSE'
$NodeReadme = Join-Path $NodeSourceDir.FullName 'README.md'
Assert-Exists $NodeExe 'Node executable'
Assert-Exists $NpmExe 'npm executable'
Assert-Exists $NodeLicense 'Node license'

$nodeVersion = (& $NodeExe --version).Trim()
if ($nodeVersion -ne $ExpectedNodeVersion) {
    throw "Node version mismatch. Expected $ExpectedNodeVersion, found $nodeVersion at $NodeExe"
}
Write-Host "Building $PackageName with Node $nodeVersion"

if (-not $SkipTests) {
    Push-Location $ProjectRoot
    try {
        Invoke-Native 'npm run check' { & $NpmExe run check }
        Invoke-Native 'npm test' { & $NpmExe test }
    } finally {
        Pop-Location
    }
}

if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
if (Test-Path -LiteralPath $ZipHashPath) { Remove-Item -LiteralPath $ZipHashPath -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
Copy-Item -Path (Join-Path $PackageTemplate '*') -Destination $StageDir -Recurse -Force

$AppDir = Join-Path $StageDir 'app'
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
foreach ($file in @('server.mjs', 'package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination $AppDir -Force
}
foreach ($directory in @('lib', 'public', 'skills')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $directory) -Destination $AppDir -Recurse -Force
}

Push-Location $AppDir
try {
    Invoke-Native 'install production dependencies' { & $NpmExe ci --omit=dev --ignore-scripts --no-audit --no-fund }
} finally {
    Pop-Location
}

$NodeRuntimeDir = Join-Path $StageDir 'runtime\node'
New-Item -ItemType Directory -Path $NodeRuntimeDir -Force | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination $NodeRuntimeDir -Force
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $StageDir 'licenses\Node_LICENSE.txt') -Force
if (Test-Path -LiteralPath $NodeReadme) { Copy-Item -LiteralPath $NodeReadme -Destination (Join-Path $StageDir 'licenses\Node_README.md') -Force }

$ServiceDir = Join-Path $StageDir 'runtime\service'
Copy-Item -LiteralPath $WinSWSource -Destination (Join-Path $ServiceDir 'wynai-service.exe') -Force

$gitCommit = (& git -C $ProjectRoot rev-parse --short HEAD).Trim()
$gitDirty = [bool]((& git -C $ProjectRoot status --porcelain) -join '')
$metadata = [ordered]@{
    product = 'Wyn AI'
    version = $Version
    package = $PackageName
    platform = 'windows-x64'
    nodeVersion = $nodeVersion
    minimumWindowsServer = '2012 R2'
    buildTime = (Get-Date).ToUniversalTime().ToString('o')
    gitCommit = $gitCommit
    gitDirty = $gitDirty
}
[IO.File]::WriteAllText((Join-Path $StageDir 'version.json'), ($metadata | ConvertTo-Json) + "`n", $Utf8NoBom)

$binaryChecksums = @(
    "$(Get-FileHash (Join-Path $NodeRuntimeDir 'node.exe') -Algorithm SHA256 | Select-Object -ExpandProperty Hash)  runtime/node/node.exe",
    "$(Get-FileHash (Join-Path $ServiceDir 'wynai-service.exe') -Algorithm SHA256 | Select-Object -ExpandProperty Hash)  runtime/service/wynai-service.exe"
)
[IO.File]::WriteAllLines((Join-Path $StageDir 'SHA256SUMS.txt'), $binaryChecksums, $Utf8NoBom)

Invoke-Native 'create ZIP package' { & $tarExe -a -c -f $ZipPath -C $ReleaseRoot $PackageName }
Invoke-Native 'validate ZIP package' { & $tarExe -tf $ZipPath | Out-Null }
$zipHash = Get-FileHash $ZipPath -Algorithm SHA256
[IO.File]::WriteAllText($ZipHashPath, "$($zipHash.Hash)  $([IO.Path]::GetFileName($ZipPath))`n", $Utf8NoBom)

if (-not $SkipSmokeTest) {
    $SmokeRoot = Join-Path $ReleaseRoot '_smoke'
    if (Test-Path -LiteralPath $SmokeRoot) { Remove-Item -LiteralPath $SmokeRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $SmokeRoot -Force | Out-Null
    try {
        Invoke-Native 'extract ZIP for smoke test' { & $tarExe -xf $ZipPath -C $SmokeRoot }
        $SmokePackage = Join-Path $SmokeRoot $PackageName
        $mainPort = Get-FreePort
        do { $proxyPort = Get-FreePort } while ($proxyPort -eq $mainPort)
        $smokeConfig = @"
HOST=127.0.0.1
PORT=$mainPort
WYN_VIEW_PROXY_PORT=$proxyPort
WYN_BASE_URL=http://127.0.0.1:1
WYN_TOKEN=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
"@
        [IO.File]::WriteAllText((Join-Path $SmokePackage 'config\wynai.env'), $smokeConfig, $Utf8NoBom)
        $oldNoBrowser = $env:WYN_AI_NO_BROWSER
        $oldNoPause = $env:WYN_AI_NO_PAUSE
        $env:WYN_AI_NO_BROWSER = '1'
        $env:WYN_AI_NO_PAUSE = '1'
        try {
            Push-Location $SmokePackage
            try {
                Invoke-Native 'start packaged application' { & cmd.exe /d /c quick-start.bat }
                $live = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$mainPort/api/live" -TimeoutSec 5
                if ($live.StatusCode -ne 200) { throw "Smoke liveness check returned HTTP $($live.StatusCode)" }
                $skillCatalog = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$mainPort/api/smart-query/skills" -TimeoutSec 5
                $packagedSkillIds = @($skillCatalog.items | ForEach-Object { $_.id })
                foreach ($expectedSkillId in @('sales-baseline', 'retail-baseline', 'laboratory-baseline')) {
                    if ($packagedSkillIds -notcontains $expectedSkillId) {
                        throw "Smoke skill catalog is missing $expectedSkillId"
                    }
                }
                Invoke-Native 'stop packaged application' { & cmd.exe /d /c quick-stop.bat }
            } finally {
                Pop-Location
            }
        } finally {
            $env:WYN_AI_NO_BROWSER = $oldNoBrowser
            $env:WYN_AI_NO_PAUSE = $oldNoPause
            $pidFile = Join-Path $SmokePackage 'runtime\pids\wynai.pid'
            if (Test-Path -LiteralPath $pidFile) {
                $processIdValue = [int](Get-Content -LiteralPath $pidFile -Raw)
                Stop-Process -Id $processIdValue -Force -ErrorAction SilentlyContinue
            }
        }
    } finally {
        if (Test-Path -LiteralPath $SmokeRoot) { Remove-Item -LiteralPath $SmokeRoot -Recurse -Force }
    }
}

if (Test-Path -LiteralPath $NodeExtractRoot) { Remove-Item -LiteralPath $NodeExtractRoot -Recurse -Force }
Write-Host ''
Write-Host "Windows package created: $ZipPath" -ForegroundColor Green
Write-Host "SHA256 file: $ZipHashPath" -ForegroundColor Green
