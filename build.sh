#!/bin/sh
set -e

# --- Odczyt klucza API -------------------------------------------
APIKEY=""
if [ -f apikey.txt ]; then
    APIKEY=$(tr -d '\r\n[:space:]' < apikey.txt)
fi

if [ -z "$APIKEY" ]; then
    echo "[UWAGA] apikey.txt pusty lub nieistniejacy. Budowanie bez wbudowanego klucza."
else
    echo "Klucz API wczytany ($(echo "$APIKEY" | cut -c1-8)...)"
fi

mkdir -p dist
export CGO_ENABLED=0

# --- Budowanie ---------------------------------------------------
echo "Budowanie: dist/sga_macos_arm64 ..."
GOOS=darwin GOARCH=arm64 go build \
    -ldflags="-X main.builtInKey=$APIKEY" \
    -o dist/sga_macos_arm64 .

echo "Budowanie: dist/sga_macos_intel ..."
GOOS=darwin GOARCH=amd64 go build \
    -ldflags="-X main.builtInKey=$APIKEY" \
    -o dist/sga_macos_intel .

echo "Budowanie: dist/sga_windows.exe ..."
GOOS=windows GOARCH=amd64 go build \
    -ldflags="-H windowsgui -X main.builtInKey=$APIKEY" \
    -o dist/sga_windows.exe .

echo ""
echo "Gotowe! Pliki w dist/:"
ls -lh dist/
