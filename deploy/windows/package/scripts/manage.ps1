param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('QuickStart', 'QuickStop', 'InstallService', 'UninstallService', 'StartService', 'StopService', 'Status', 'OpenFirewall', 'CloseFirewall')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path $PSScriptRoot -Parent
$ConfigPath = Join-Path $PackageRoot 'config\wynai.env'
$ConfigTemplatePath = Join-Path $PackageRoot 'config\wynai.env.template'
$DataDir = Join-Path $PackageRoot 'data'
$RuntimeDir = Join-Path $PackageRoot 'runtime'
$LogsDir = Join-Path $RuntimeDir 'logs'
$PidsDir = Join-Path $RuntimeDir 'pids'
$PidFile = Join-Path $PidsDir 'wynai.pid'
$NodeExe = Join-Path $RuntimeDir 'node\node.exe'
$ServerScript = Join-Path $PackageRoot 'app\server.mjs'
$ServiceExe = Join-Path $RuntimeDir 'service\wynai-service.exe'
$ServiceConfig = Join-Path $RuntimeDir 'service\wynai-service.xml'
$ServiceName = 'WynAIService'
$FirewallGroup = 'WynAI'

function Ensure-Config {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        if (-not (Test-Path -LiteralPath $ConfigTemplatePath)) {
            throw "Configuration template not found: $ConfigTemplatePath"
        }
        Copy-Item -LiteralPath $ConfigTemplatePath -Destination $ConfigPath
        Write-Host "Created configuration: $ConfigPath" -ForegroundColor Yellow
        Write-Host 'Review WYN_BASE_URL, WYN_TOKEN and LLM settings before production use.' -ForegroundColor Yellow
    }
}

function Read-Config {
    Ensure-Config
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { continue }
        $key = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $values[$key] = $value
    }
    return $values
}

function Get-Settings {
    $config = Read-Config
    $hostValue = if ($config.ContainsKey('HOST') -and $config['HOST']) { $config['HOST'] } else { '0.0.0.0' }
    $portValue = if ($config.ContainsKey('PORT') -and $config['PORT']) { $config['PORT'] } else { '8787' }
    $proxyPortValue = if ($config.ContainsKey('WYN_VIEW_PROXY_PORT') -and $config['WYN_VIEW_PROXY_PORT']) { $config['WYN_VIEW_PROXY_PORT'] } else { '8788' }
    $mainPort = 0
    $proxyPort = 0
    if (-not [int]::TryParse($portValue, [ref]$mainPort) -or $mainPort -lt 1 -or $mainPort -gt 65535) {
        throw "Invalid PORT in $ConfigPath"
    }
    if (-not [int]::TryParse($proxyPortValue, [ref]$proxyPort) -or $proxyPort -lt 1 -or $proxyPort -gt 65535) {
        throw "Invalid WYN_VIEW_PROXY_PORT in $ConfigPath"
    }
    if ($mainPort -eq $proxyPort) { throw 'PORT and WYN_VIEW_PROXY_PORT must be different.' }
    $healthHost = $hostValue
    if ($healthHost -eq '0.0.0.0' -or $healthHost -eq '::') { $healthHost = '127.0.0.1' }
    return [pscustomobject]@{
        Config = $config
        Host = $hostValue
        HealthHost = $healthHost
        Port = $mainPort
        ProxyPort = $proxyPort
        BaseUrl = "http://${healthHost}:$mainPort"
    }
}

function Set-RuntimeEnvironment($settings) {
    [Environment]::SetEnvironmentVariable('WYN_AI_ENV_FILE', $ConfigPath, 'Process')
    [Environment]::SetEnvironmentVariable('WYN_AI_DATA_DIR', $DataDir, 'Process')
    foreach ($entry in $settings.Config.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
}

function Ensure-RuntimeDirectories {
    foreach ($path in @($DataDir, (Join-Path $DataDir 'analysis-runs'), $LogsDir, $PidsDir)) {
        if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    }
}

function Assert-NodeRuntime {
    if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Bundled Node runtime not found: $NodeExe" }
    $output = & $NodeExe --version 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $details = ($output | Out-String).Trim()
        throw "Bundled Node runtime cannot run on this Windows version (exit code $exitCode). $details"
    }
    Write-Host "Node runtime check passed: $output"
}

function Test-PortAvailable([int]$port) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        try { $listener.Stop() } catch {}
    }
}

function Test-Live($settings, [int]$timeoutSeconds = 2) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$($settings.BaseUrl)/api/live" -TimeoutSec $timeoutSeconds
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-Live($settings, [int]$timeoutSeconds) {
    for ($attempt = 0; $attempt -lt $timeoutSeconds; $attempt++) {
        if (Test-Live $settings 2) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-PortableProcess {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $processIdValue = 0
    if (-not [int]::TryParse($text, [ref]$processIdValue)) { return $null }
    return Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
}

function Show-RecentLogs {
    $files = Get-ChildItem -LiteralPath $LogsDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 6
    foreach ($file in $files) {
        Write-Host "----- $($file.FullName) -----"
        Get-Content -LiteralPath $file.FullName -Tail 60
    }
}

function Start-Portable {
    Assert-NodeRuntime
    if (-not (Test-Path -LiteralPath $ServerScript)) { throw "Server entry not found: $ServerScript" }
    Ensure-RuntimeDirectories
    $settings = Get-Settings
    if (Test-Live $settings) {
        Write-Host "Wyn AI is already running: $($settings.BaseUrl)" -ForegroundColor Green
        return
    }
    $existing = Get-PortableProcess
    if ($existing) { throw "A previous process recorded in $PidFile is still running (PID $($existing.Id))." }
    if (-not (Test-PortAvailable $settings.Port)) { throw "Port $($settings.Port) is already in use." }
    if (-not (Test-PortAvailable $settings.ProxyPort)) { throw "Port $($settings.ProxyPort) is already in use." }
    Set-RuntimeEnvironment $settings
    $stdout = Join-Path $LogsDir 'stdout.log'
    $stderr = Join-Path $LogsDir 'stderr.log'
    $arguments = '"' + $ServerScript + '"'
    $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $PackageRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
    if (-not (Wait-Live $settings 30)) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Show-RecentLogs
        throw 'Wyn AI failed the startup liveness check.'
    }
    Write-Host "Wyn AI started: $($settings.BaseUrl)" -ForegroundColor Green
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$($settings.BaseUrl)/api/health" -TimeoutSec 10 | Out-Null
        Write-Host 'Wyn connectivity check passed.' -ForegroundColor Green
    } catch {
        Write-Host 'Warning: the process is running, but Wyn connectivity/configuration is not ready.' -ForegroundColor Yellow
    }
    if ($env:WYN_AI_NO_BROWSER -ne '1') { Start-Process $settings.BaseUrl | Out-Null }
}

function Stop-Portable {
    $process = Get-PortableProcess
    if (-not $process) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Write-Host 'Portable Wyn AI process is not running.'
        return
    }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.CommandLine -and $processInfo.CommandLine -notlike '*server.mjs*') {
        throw "PID $($process.Id) no longer belongs to Wyn AI; refusing to stop it."
    }
    Stop-Process -Id $process.Id -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $process.Id -Force }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Portable Wyn AI process stopped.' -ForegroundColor Green
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This action requires an elevated Administrator command prompt.'
    }
}

function Protect-Config {
    try {
        $acl = Get-Acl -LiteralPath $ConfigPath
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
        $rights = [Security.AccessControl.FileSystemRights]::FullControl
        $allow = [Security.AccessControl.AccessControlType]::Allow
        foreach ($sidValue in @('S-1-5-18', 'S-1-5-32-544')) {
            $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, $allow)
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $ConfigPath -AclObject $acl
        Write-Host 'Configuration ACL restricted to SYSTEM and Administrators.'
    } catch {
        Write-Host "Warning: could not restrict configuration ACL: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Install-ServiceAction {
    Assert-Administrator
    Ensure-RuntimeDirectories
    $settings = Get-Settings
    Assert-NodeRuntime
    if (Test-Live $settings) { throw 'Wyn AI is already running in portable mode. Run quick-stop.bat before installing the service.' }
    if (-not (Test-Path -LiteralPath $ServiceExe)) { throw "WinSW executable not found: $ServiceExe" }
    if (-not (Test-Path -LiteralPath $ServiceConfig)) { throw "WinSW configuration not found: $ServiceConfig" }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw "Service $ServiceName is already installed." }
    Protect-Config
    & $ServiceExe install $ServiceConfig
    if ($LASTEXITCODE -ne 0 -and -not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        throw "WinSW service installation failed with code $LASTEXITCODE."
    }
    try {
        Start-Service -Name $ServiceName
    } catch {
        Show-RecentLogs
        throw
    }
    if (-not (Wait-Live $settings 60)) {
        Show-RecentLogs
        throw 'The Windows service was installed but failed the liveness check.'
    }
    Write-Host "Service installed and started: $ServiceName" -ForegroundColor Green
    Write-Host "Application URL: $($settings.BaseUrl)"
    if ($settings.Host -eq '0.0.0.0') {
        $reply = Read-Host "Open Windows Firewall ports $($settings.Port) and $($settings.ProxyPort)? [y/N]"
        if ($reply -match '^(y|yes)$') { Open-FirewallAction }
    }
}

function Uninstall-ServiceAction {
    Assert-Administrator
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $service.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30)) }
        & $ServiceExe uninstall $ServiceConfig
        if ($LASTEXITCODE -ne 0 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
            throw "WinSW service uninstall failed with code $LASTEXITCODE."
        }
    }
    Write-Host 'Service removed. Configuration, data and logs were preserved.' -ForegroundColor Green
}

function Start-ServiceAction {
    Assert-Administrator
    $settings = Get-Settings
    Assert-NodeRuntime
    try {
        Start-Service -Name $ServiceName
    } catch {
        Show-RecentLogs
        throw
    }
    if (-not (Wait-Live $settings 60)) {
        Show-RecentLogs
        throw 'Service started but failed the liveness check.'
    }
    Write-Host "Service started: $ServiceName" -ForegroundColor Green
}

function Stop-ServiceAction {
    Assert-Administrator
    Stop-Service -Name $ServiceName -Force
    Write-Host "Service stopped: $ServiceName" -ForegroundColor Green
}

function Open-FirewallAction {
    Assert-Administrator
    $settings = Get-Settings
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "Wyn AI ports $($settings.Port), $($settings.ProxyPort)" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort @($settings.Port, $settings.ProxyPort) | Out-Null
    Write-Host "Firewall ports opened: $($settings.Port), $($settings.ProxyPort)" -ForegroundColor Green
}

function Close-FirewallAction {
    Assert-Administrator
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host 'Wyn AI firewall rules removed.' -ForegroundColor Green
}

function Show-Status {
    $settings = Get-Settings
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $portable = Get-PortableProcess
    Write-Host "Package: $PackageRoot"
    Write-Host "Configuration: $ConfigPath"
    Write-Host "Service: $(if ($service) { $service.Status } else { 'Not installed' })"
    Write-Host "Portable process: $(if ($portable) { 'Running, PID ' + $portable.Id } else { 'Not running' })"
    Write-Host "Main URL: $($settings.BaseUrl)"
    Write-Host "View proxy port: $($settings.ProxyPort)"
    Write-Host "Liveness: $(if (Test-Live $settings) { 'OK' } else { 'Unavailable' })"
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri "$($settings.BaseUrl)/api/health" -TimeoutSec 5
        Write-Host "Wyn health: HTTP $($health.StatusCode)"
    } catch {
        Write-Host 'Wyn health: unavailable or not configured' -ForegroundColor Yellow
    }
}

switch ($Action) {
    'QuickStart' { Start-Portable }
    'QuickStop' { Stop-Portable }
    'InstallService' { Install-ServiceAction }
    'UninstallService' { Uninstall-ServiceAction }
    'StartService' { Start-ServiceAction }
    'StopService' { Stop-ServiceAction }
    'Status' { Show-Status }
    'OpenFirewall' { Open-FirewallAction }
    'CloseFirewall' { Close-FirewallAction }
}