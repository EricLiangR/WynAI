@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action StartService
if errorlevel 1 (
  echo.
  echo Operation failed. Review the message and runtime logs.
  if not "%WYN_AI_NO_PAUSE%"=="1" pause
  exit /b 1
)
pause