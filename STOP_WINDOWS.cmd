@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is not installed.
  pause
  exit /b 1
)
docker compose down
if errorlevel 1 (
  echo Stop failed. Check Docker Desktop.
  pause
  exit /b 1
)
echo Stopped. Downloaded models are retained.
pause
