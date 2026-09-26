@echo off
set "automation_script=%LOCALAPPDATA%\PlaylistBuilder\playlist_automation.py"
set "config_file=%APPDATA%\PlaylistBuilder\playlist_builder.json"

if not exist "%automation_script%" (
    echo Playlist Builder is not installed:
    echo %automation_script%
    pause
    exit /b 1
)

if not exist "%config_file%" (
    echo Playlist Builder configuration was not found:
    echo %config_file%
    pause
    exit /b 1
)

where py.exe >nul 2>&1
if "%errorlevel%"=="0" (
    py.exe -3 "%automation_script%" --config "%config_file%" --merge-now
) else (
    python.exe "%automation_script%" --config "%config_file%" --merge-now
)

set "exit_code=%errorlevel%"
echo.
if not "%exit_code%"=="0" (
    echo One or more merges could not be updated. Existing outputs were preserved.
)
pause
exit /b %exit_code%
