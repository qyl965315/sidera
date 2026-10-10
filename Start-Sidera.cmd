@echo off
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
 echo Sidera requires Node.js 24 or newer. Install Node.js, then open this launcher again.
 pause
 exit /b 1
)
node.exe scripts\local-launcher.ts %*
if errorlevel 1 pause
