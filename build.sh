#!/bin/sh
set -e

# ---------------------------------------------------------------
# Przygotuj klucz API z apikey.txt
# ---------------------------------------------------------------
APIKEY=""
if [ -f apikey.txt ]; then
    APIKEY=$(grep -v '^#' apikey.txt | head -1 | tr -d '[:space:]')
fi

if [ -z "$APIKEY" ]; then
    echo "[UWAGA] apikey.txt nie istnieje lub jest pusty."
    echo "        Stwórz apikey.txt i wpisz swój klucz Google Places API."
    echo "        Aplikacja zostanie zbudowana bez wbudowanego klucza."
    echo ""
fi

mkdir -p dist

# ---------------------------------------------------------------
# macOS Apple Silicon (arm64)
# ---------------------------------------------------------------
echo "Budowanie: dist/sga_macos_arm64 ..."
GOOS=darwin GOARCH=arm64 go build \
    -ldflags="-X main.builtInKey=$APIKEY" \
    -o dist/sga_macos_arm64 .

# ---------------------------------------------------------------
# macOS Intel (amd64)
# ---------------------------------------------------------------
echo "Budowanie: dist/sga_macos_intel ..."
GOOS=darwin GOARCH=amd64 go build \
    -ldflags="-X main.builtInKey=$APIKEY" \
    -o dist/sga_macos_intel .

# ---------------------------------------------------------------
# Windows (amd64) — brak okna konsoli
# ---------------------------------------------------------------
echo "Budowanie: dist/sga_windows.exe ..."
GOOS=windows GOARCH=amd64 go build \
    -ldflags="-H windowsgui -X main.builtInKey=$APIKEY" \
    -o dist/sga_windows.exe .

echo ""
echo "Gotowe! Pliki w dist/:"
ls -lh dist/
