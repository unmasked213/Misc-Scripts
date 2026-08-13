@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-PlaylistBuilder.ps1"
set "exit_code=%errorlevel%"
echo.
if not "%exit_code%"=="0" (
    echo Uninstallation failed with exit code %exit_code%.
)
pause
exit /b %exit_code%
