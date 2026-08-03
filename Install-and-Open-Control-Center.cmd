@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not complete. See logs\install-windows.log and README.md.
  pause
  exit /b 1
)
exit /b 0
