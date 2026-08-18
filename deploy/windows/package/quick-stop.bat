@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action QuickStop
if errorlevel 1 (
  echo.
  echo Operation failed. Review the message and runtime logs.
  if not "%WYN_AI_NO_PAUSE%"=="1" pause
  exit /b 1
)