@echo off
setlocal
cd /d "%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell is required for masked key setup. See LOCAL_RUN.md.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; try { $path=Join-Path (Get-Location) '.env.local'; $script:lines=@(); if(Test-Path -LiteralPath $path){$script:lines=@(Get-Content -LiteralPath $path -Encoding UTF8)}; function Set-Setting([string]$name,[string]$value){$script:lines=@($script:lines | Where-Object {$_ -notmatch ('^\s*'+[regex]::Escape($name)+'\s*=')}); $script:lines+=($name+'='+$value)}; function Read-Key([string]$name,[string]$prompt){$secret=Read-Host $prompt -AsSecureString; if($secret.Length -eq 0){$secret.Dispose(); return}; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret); try {$value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr); if($value -notmatch '^[A-Za-z0-9_-]{20,}$'){throw 'Invalid key format'}; Set-Setting $name $value} finally {$value=$null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret.Dispose()}}; Write-Host 'Keys are masked and saved only in .env.local. Blank input keeps an existing key.'; Read-Key 'LLM_API_KEY' 'OpenAI API key'; Read-Key 'BOSON_API_KEY' 'Boson API key (optional)'; Set-Setting 'LLM_BACKEND' 'cloud'; Set-Setting 'LLM_BASE_URL' 'https://api.openai.com/v1'; Set-Setting 'LLM_MODEL' 'gpt-4.1-mini'; [IO.File]::WriteAllLines($path,[string[]]$script:lines,[Text.UTF8Encoding]::new($false)); Write-Host 'Saved private settings. Restart the app with START_WINDOWS.cmd.'; exit 0} catch {Write-Host 'Key setup failed. Check the key format and that this folder is writable. No key values are printed.'; exit 1}"
if errorlevel 1 (
  pause
  exit /b 1
)
pause
exit /b 0
