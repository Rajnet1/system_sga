@echo off
setlocal

:: ---------------------------------------------------------------
:: Przygotuj klucz API z apikey.txt (pierwsza niepusta linia)
:: ---------------------------------------------------------------
set "APIKEY="
if exist apikey.txt (
    for /f "tokens=*" %%L in (apikey.txt) do (
        if not defined APIKEY set "APIKEY=%%L"
    )
)

if not defined APIKEY (
    echo [UWAGA] apikey.txt nie istnieje lub jest pusty.
    echo         Stwórz apikey.txt i wpisz swój klucz Google Places API.
    echo         Aplikacja zostanie zbudowana bez wbudowanego klucza.
    echo.
)

if not exist dist mkdir dist

:: ---------------------------------------------------------------
:: Windows (amd64) — brak okna konsoli
:: ---------------------------------------------------------------
echo Budowanie: dist\sga_windows.exe ...
set GOOS=windows
set GOARCH=amd64
go build -ldflags="-H windowsgui -X main.builtInKey=%APIKEY%" -o dist\sga_windows.exe .
if errorlevel 1 goto fail

:: ---------------------------------------------------------------
:: macOS Apple Silicon (arm64)
:: ---------------------------------------------------------------
echo Budowanie: dist\sga_macos_arm64 ...
set GOOS=darwin
set GOARCH=arm64
go build -ldflags="-X main.builtInKey=%APIKEY%" -o dist\sga_macos_arm64 .
if errorlevel 1 goto fail

:: ---------------------------------------------------------------
:: macOS Intel (amd64)
:: ---------------------------------------------------------------
echo Budowanie: dist\sga_macos_intel ...
set GOARCH=amd64
go build -ldflags="-X main.builtInKey=%APIKEY%" -o dist\sga_macos_intel .
if errorlevel 1 goto fail

echo.
echo Gotowe! Pliki w dist\:
dir /b dist\
goto done

:fail
echo.
echo BLAD budowania!
:done
pause
endlocal
