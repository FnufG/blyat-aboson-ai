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
powershell.exe -NoLogo -NoProfile -Command "$p=Join-Path (Get-Location) '.env.local'; if(-not (Test-Path -LiteralPath $p)){exit 1}; $line=@(Get-Content -LiteralPath $p -Encoding UTF8 | Where-Object {$_ -match '^\s*LLM_API_KEY\s*='} | Select-Object -Last 1); if($line.Count -eq 0){exit 1}; $value=($line[0] -split '=',2)[1].Trim().Trim([char]34).Trim([char]39); if([string]::IsNullOrWhiteSpace($value)){exit 1}; exit 0"
if errorlevel 1 (
  echo OpenAI key is missing. Opening masked key setup.
  call CONFIGURE_KEYS_WINDOWS.cmd
  if errorlevel 1 echo Key setup was not completed. The interface can open, but cloud answers will be unavailable.
)
echo Building and starting Liniya. First setup downloads speech recognition data.
echo This can take several minutes. Keep this window open.
docker compose up --build --wait --wait-timeout 1800
if errorlevel 1 (
  echo Startup did not finish. Recent container logs:
  docker compose logs --tail 80
  echo See LOCAL_RUN.md for troubleshooting. Models already downloaded are retained.
  pause
  exit /b 1
)
echo The Liniya interface is ready at http://localhost:3000
echo Cloud answers require LLM_API_KEY in .env.local. See LOCAL_RUN.md.
start "" "http://localhost:3000"
echo Close this window freely. Use STOP_WINDOWS.cmd to stop the application.
pause
