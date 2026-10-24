@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Install Docker Desktop first. See LOCAL_RUN.md.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Start Docker Desktop and wait until its engine is running.
  pause
  exit /b 1
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose is unavailable. Update Docker Desktop.
  pause
  exit /b 1
)
echo Building and starting Liniya. First setup downloads the AI models.
echo This can take several minutes. Keep this window open.
docker compose up --build --wait --wait-timeout 1800
if errorlevel 1 (
  echo Startup did not finish. Recent container logs:
  docker compose logs --tail 80
  echo See LOCAL_RUN.md for troubleshooting. Models already downloaded are retained.
  pause
  exit /b 1
)
echo Liniya is ready at http://localhost:3000
start "" "http://localhost:3000"
echo Close this window freely. Use STOP_WINDOWS.cmd to stop the application.
pause
