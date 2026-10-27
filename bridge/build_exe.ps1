# Build the Windows one-file bridge with PyInstaller.
# Usage (from repo root or bridge/):
#   powershell -ExecutionPolicy Bypass -File bridge/build_exe.ps1
#   powershell -ExecutionPolicy Bypass -File bridge/build_exe.ps1 -Python "C:\path\to\python.exe"

param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    & $Python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --console `
        --name "启动免费题库" `
        --add-data "resource;resource" `
        --collect-all fontTools `
        free_tiku_bridge.py

    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }

    # The bridge prefers resource/ next to the exe; keep a copy there too.
    $distDir = Join-Path $here "dist"
    $resOut = Join-Path $distDir "resource"
    New-Item -ItemType Directory -Force -Path (Join-Path $resOut "api") | Out-Null
    Copy-Item -Path (Join-Path $here "resource\*") -Destination $resOut -Recurse -Force

    Write-Host ""
    Write-Host "Built: $distDir\启动免费题库.exe"
    Write-Host "Resource folder: $resOut"
}
finally {
    Pop-Location
}
