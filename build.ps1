$ErrorActionPreference = "Stop"

# --- Odczyt klucza API -------------------------------------------
$apiKey = ""
if (Test-Path "apikey.txt") {
    $apiKey = (Get-Content "apikey.txt" -Raw).Trim()
}

if (-not $apiKey) {
    Write-Warning "apikey.txt pusty lub nieistniejacy. Budowanie bez wbudowanego klucza."
} else {
    Write-Host "Klucz API wczytany (${($apiKey.Substring(0, [Math]::Min(8,$apiKey.Length)))}...)"
}

$null = New-Item -ItemType Directory -Force -Path "dist"
$env:CGO_ENABLED = "0"

# --- Budowanie ---------------------------------------------------
function Build($goos, $goarch, $out, $extraFlags = "") {
    $env:GOOS    = $goos
    $env:GOARCH  = $goarch
    $ld = $extraFlags + " -X main.builtInKey=" + $apiKey
    Write-Host "Budowanie: $out ..."
    & go build -ldflags $ld.Trim() -o $out .
    if ($LASTEXITCODE -ne 0) { throw "Blad budowania: $out" }
}

Build "windows" "amd64" "dist\sga_windows.exe" "-H windowsgui"
Build "darwin"  "arm64" "dist\sga_macos_arm64"
Build "darwin"  "amd64" "dist\sga_macos_intel"

Write-Host ""
Write-Host "Gotowe! Pliki w dist\:"
Get-ChildItem dist | Select-Object Name, @{N="Rozmiar";E={"{0:N0} KB" -f ($_.Length/1KB)}} | Format-Table -AutoSize
