[CmdletBinding()]
param(
    [switch]$SkipNodeInstall,
    [switch]$SkipClaudeInstall,
    [switch]$SkipProjectInstall,
    [switch]$SkipCertGeneration
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Write-Status {
    param([string]$Message)

    Write-Host $Message -ForegroundColor Cyan
}

function Test-CommandExists {
    param([string]$CommandName)

    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Get-NpmCommand {
    if (Test-CommandExists 'npm.cmd') {
        return 'npm.cmd'
    }

    if (Test-CommandExists 'npm') {
        return 'npm'
    }

    return $null
}

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathSegments = @($machinePath, $userPath) | Where-Object { $_ }

    if ($pathSegments.Count -gt 0) {
        $env:Path = $pathSegments -join ';'
    }
}

function Get-CommandVersion {
    param(
        [string]$CommandName,
        [string[]]$Arguments = @('--version')
    )

    try {
        $output = & $CommandName @Arguments 2>$null
        if ($LASTEXITCODE -eq 0 -and $output) {
            return ($output | Select-Object -First 1)
        }
    } catch {
        return 'installed'
    }

    return 'installed'
}

function Ensure-NodeAndNpm {
    $npmCommand = Get-NpmCommand

    if ((Test-CommandExists 'node') -and $npmCommand) {
        $script:NpmCommand = $npmCommand
        Write-Host ("Node.js detected: {0}" -f (Get-CommandVersion 'node' @('-v')))
        Write-Host ("npm detected: {0}" -f (Get-CommandVersion $script:NpmCommand @('-v')))
        return
    }

    if ($SkipNodeInstall) {
        throw 'Node.js and npm are required but were not found in PATH.'
    }

    if (-not (Test-CommandExists 'winget')) {
        throw 'Node.js 18+ and npm are required. Install them from https://nodejs.org or install winget, then re-run this script.'
    }

    Write-Status 'Installing Node.js LTS with winget...'
    & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements

    if ($LASTEXITCODE -ne 0) {
        throw 'winget failed to install Node.js.'
    }

    Refresh-Path

    $npmCommand = Get-NpmCommand

    if (-not (Test-CommandExists 'node') -or -not $npmCommand) {
        throw 'Node.js and npm were installed, but are not visible in this PowerShell session. Open a new terminal and re-run install.ps1.'
    }

    $script:NpmCommand = $npmCommand

    Write-Host ("Node.js detected: {0}" -f (Get-CommandVersion 'node' @('-v')))
    Write-Host ("npm detected: {0}" -f (Get-CommandVersion $script:NpmCommand @('-v')))
}

function Ensure-ClaudeCli {
    if (Test-CommandExists 'claude') {
        Write-Host ("Claude Code CLI detected: {0}" -f (Get-CommandVersion 'claude'))
        return
    }

    if ($SkipClaudeInstall) {
        throw 'Claude Code CLI is required but was not found in PATH.'
    }

    Write-Status 'Installing Claude Code CLI (@anthropic-ai/claude-code)...'
    & $script:NpmCommand install -g @anthropic-ai/claude-code

    if ($LASTEXITCODE -ne 0) {
        throw 'Claude Code CLI installation failed. If npm global installs are blocked, run PowerShell as Administrator or configure a user npm prefix and re-run.'
    }

    Refresh-Path

    if (-not (Test-CommandExists 'claude')) {
        throw 'Claude Code CLI installation did not complete successfully.'
    }

    Write-Host ("Claude Code CLI detected: {0}" -f (Get-CommandVersion 'claude'))
}

function Ensure-NativeTerminalDependency {
    if (Test-CommandExists 'powershell.exe') {
        Write-Host 'Windows native terminal launcher detected: powershell.exe'
    } else {
        Write-Warning 'powershell.exe was not found. Native terminal launch may fail, but the web terminal will still work.'
    }
}

function Ensure-LocalRuntimeFiles {
    $configPath = Join-Path $scriptDir 'server\config.json'
    $certPath = Join-Path $scriptDir 'server\cert.pem'
    $keyPath = Join-Path $scriptDir 'server\key.pem'

    if (-not (Test-Path $configPath)) {
        Write-Status 'Creating default server/config.json...'
        '{}' | Set-Content -Path $configPath -Encoding ascii
    }

    if ((-not (Test-Path $certPath)) -or (-not (Test-Path $keyPath))) {
        if ($SkipCertGeneration) {
            throw 'TLS files are missing in server/. Re-run without -SkipCertGeneration or create cert.pem and key.pem manually.'
        }

        Write-Status 'Generating local TLS certs...'
        & $script:NpmCommand --prefix server run generate:certs

        if ($LASTEXITCODE -ne 0) {
            throw 'Certificate generation failed.'
        }
    }
}

try {
    Write-Status 'Starting Claude Code WebUI installer for Windows...'

    Ensure-NodeAndNpm
    Ensure-ClaudeCli
    Ensure-NativeTerminalDependency

    if (-not $SkipProjectInstall) {
        Write-Status 'Installing project dependencies...'
        & $script:NpmCommand run install:all

        if ($LASTEXITCODE -ne 0) {
            throw 'Project dependency installation failed.'
        }
    }

    Ensure-LocalRuntimeFiles

    Write-Host ''
    Write-Host 'Installation complete.'
    Write-Host '--------------------------------'
    Write-Host 'To start the WebUI, run:'
    Write-Host '  npm.cmd run dev'
    Write-Host ''
    Write-Host 'For LAN/mobile testing, run client with:'
    Write-Host '  npm.cmd --prefix client run dev -- --host 0.0.0.0'
    Write-Host '--------------------------------'
} catch {
    Write-Error $_
    exit 1
}
