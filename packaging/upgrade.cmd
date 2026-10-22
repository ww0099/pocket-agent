@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upgrade.ps1" %*
exit /b %ERRORLEVEL%
