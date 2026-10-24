@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not defined PORT set "PORT=17381"
set "URL=http://127.0.0.1:%PORT%/"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

rem Reuse an existing healthy server instead of starting a duplicate process.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo Fabula is already running at %URL%
  start "" "%URL%"
  exit /b 0
)

echo Starting Fabula at %URL%
start "Fabula Server" /D "%~dp0" "%ComSpec%" /d /k node server.js %PORT%

for /l %%I in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 (
    echo Fabula is ready at %URL%
    start "" "%URL%"
    exit /b 0
  )
)

echo Fabula did not become ready.
echo Check the "Fabula Server" window for the startup error.
pause
exit /b 1
