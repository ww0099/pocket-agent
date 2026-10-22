@echo off
setlocal
set "AGENT_ROOT=%~dp0"
set "TEMP=%AGENT_ROOT%data\tmp"
set "TMP=%AGENT_ROOT%data\tmp"
if not exist "%AGENT_ROOT%data\tmp" mkdir "%AGENT_ROOT%data\tmp"
"%AGENT_ROOT%runtime\win-x64\node.exe" "%AGENT_ROOT%app\dist\cli.js" %*
exit /b %ERRORLEVEL%
