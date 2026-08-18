@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows-package.ps1" %*
if errorlevel 1 (
  echo.
  echo Windows package build failed.
  pause
  exit /b 1
)
echo.
echo Windows package build completed.
pause