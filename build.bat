@echo off
echo Building SGA...
go build -ldflags="-H windowsgui" -o sga.exe .
if %errorlevel% == 0 (
  echo Done: sga.exe
) else (
  echo Build failed.
)
pause
