# dev-env.ps1 — redirect every package/browser cache into the repo-local .cache/ dir.
#
# Why: this machine runs under a workspace-write file sandbox. Default cache locations
# (C:\Users\<u>\AppData\Local\npm-cache, %USERPROFILE%\AppData\Local\ms-playwright,
# %LOCALAPPDATA%\camoufox, ...) live outside the workspace and are denied.
# Sourcing this script keeps every tool self-contained inside the checkout, so the same
# commands also work unchanged on CI.
#
# Usage (every shell that touches node/npm/pnpm/playwright/camoufox):
#   . .\scripts\dev-env.ps1

$repoRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $repoRoot '.cache'

$dirs = @{
    'npm'        = Join-Path $cacheRoot 'npm'
    'pnpm-store' = Join-Path $cacheRoot 'pnpm-store'
    'electron'   = Join-Path $cacheRoot 'electron'
    'playwright' = Join-Path $cacheRoot 'playwright'
    'camoufox'   = Join-Path $cacheRoot 'camoufox'
    'tmp'        = Join-Path $cacheRoot 'tmp'
}
foreach ($d in $dirs.Values) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$env:npm_config_cache              = $dirs['npm']
$env:npm_config_store_dir          = $dirs['pnpm-store']
$env:npm_config_tmp                = $dirs['tmp']
$env:npm_config_registry           = 'https://registry.npmmirror.com'
$env:ELECTRON_CACHE                = $dirs['electron']
$env:electron_config_cache         = $dirs['electron']
$env:PLAYWRIGHT_BROWSERS_PATH      = $dirs['playwright']
$env:CAMOUFOX_INSTALL_DIR          = $dirs['camoufox']
$env:TMP                           = $dirs['tmp']
$env:TEMP                          = $dirs['tmp']

Write-Host "[dev-env] cache root: $cacheRoot" -ForegroundColor DarkGray
