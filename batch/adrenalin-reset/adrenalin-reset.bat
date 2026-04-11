@echo off
:: Kill Adrenalin processes
taskkill /f /im RadeonSoftware.exe 2>nul
taskkill /f /im AMDRSServ.exe 2>nul
taskkill /f /im amdow.exe 2>nul
taskkill /f /im AMDRSSrcExt.exe 2>nul
timeout /t 2 /nobreak >nul

set "stamp=%date:~-4%%date:~-7,2%%date:~-10,2%_%time:~0,2%%time:~3,2%"
set "stamp=%stamp: =0%"

:: Clear CN config cache
set "CN=%LOCALAPPDATA%\AMD\CN"
if exist "%CN%" (
    ren "%CN%" "CN_backup_%stamp%" 2>nul
    if exist "%CN%" rd /s /q "%CN%" 2>nul
    echo [OK] CN config cleared.
) else (
    echo [--] CN folder not found - already cleared.
)

:: Clear broader AMD LocalAppData caches
set "AMDLOCAL=%LOCALAPPDATA%\AMD"
if exist "%AMDLOCAL%\DxCache" (
    rd /s /q "%AMDLOCAL%\DxCache" 2>nul
    echo [OK] DxCache cleared.
)
if exist "%AMDLOCAL%\Radeonsoftware" (
    ren "%AMDLOCAL%\Radeonsoftware" "Radeonsoftware_backup_%stamp%" 2>nul
    echo [OK] RadeonSoftware local cache cleared.
)

:: Clear Roaming AMD config
set "AMDROAMING=%APPDATA%\AMD"
if exist "%AMDROAMING%\CNext" (
    ren "%AMDROAMING%\CNext" "CNext_backup_%stamp%" 2>nul
    echo [OK] Roaming CNext config cleared.
)

echo.
echo Adrenalin config caches reset.
echo Make your display changes in Windows Settings NOW.
echo.
echo Press any key to relaunch Adrenalin, or close this window to leave it off...
pause >nul
start "" "C:\Program Files\AMD\CNext\CNext\RadeonSoftware.exe"