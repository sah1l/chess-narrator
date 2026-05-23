# Setup verification for chess-game-explainer (Windows)
# Checks that Node, npm, ffmpeg, and Chrome are findable, then runs npm install.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

$ErrorActionPreference = 'Stop'
$Failed = $false

function Check-Cmd($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Host "  [OK]    $name -> $($cmd.Source)" -ForegroundColor Green
    } else {
        Write-Host "  [MISS]  $name not found. $hint" -ForegroundColor Red
        $script:Failed = $true
    }
}

Write-Host "chess-game-explainer setup check"
Write-Host ""

Check-Cmd "node"   "Install Node 22+ from https://nodejs.org"
Check-Cmd "npm"    "Bundled with Node"
Check-Cmd "ffmpeg" "Install via choco install ffmpeg, scoop install ffmpeg, or winget install Gyan.FFmpeg"

# Chrome / Chromium / Edge — any will do for headless screenshots
$browser = $null
foreach ($b in @("chrome", "chromium", "msedge")) {
    $c = Get-Command $b -ErrorAction SilentlyContinue
    if ($c) { $browser = $c; break }
}
# Also check well-known install locations
if (-not $browser) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { $browser = @{ Source = $p }; break }
    }
}
if ($browser) {
    Write-Host "  [OK]    browser -> $($browser.Source)" -ForegroundColor Green
} else {
    Write-Host "  [MISS]  chrome/chromium/edge not found on PATH or standard locations." -ForegroundColor Red
    $Failed = $true
}

if ($Failed) {
    Write-Host ""
    Write-Host "Some dependencies are missing. Install them and re-run this script." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "All deps look good. Running npm install..."
npm install
Write-Host ""
Write-Host "Done. Try: node src/cli.js analyze samples/sample-game.pgn"
