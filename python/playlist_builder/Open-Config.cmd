@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "config_file=%APPDATA%\PlaylistBuilder\playlist_builder.json"
set "editor=C:\Program Files (x86)\Notepad++\notepad++.exe"
set "log_file=%TEMP%\PlaylistBuilder-OpenConfig.log"

>"%log_file%" echo [%DATE% %TIME%] Open-Config started.
>>"%log_file%" echo Config: %config_file%
>>"%log_file%" echo Editor: %editor%

if not exist "%config_file%" goto missing_config
if not exist "%editor%" goto missing_editor

start "" "%editor%" -multiInst "%config_file%"
if errorlevel 1 goto launch_failed

>>"%log_file%" echo Launch command completed successfully.
exit /b 0

:missing_config
>>"%log_file%" echo ERROR: Configuration file was not found.
echo Playlist Builder configuration was not found:
echo %config_file%
echo.
echo Run Install.cmd first.
echo.
echo Diagnostic log:
echo %log_file%
pause
exit /b 1

:missing_editor
>>"%log_file%" echo ERROR: Notepad++ executable was not found.
echo Notepad++ was not found:
echo %editor%
echo.
echo Diagnostic log:
echo %log_file%
pause
exit /b 1

:launch_failed
set "launch_error=%errorlevel%"
>>"%log_file%" echo ERROR: Notepad++ launch failed with exit code %launch_error%.
echo Failed to open the Playlist Builder configuration in Notepad++.
echo.
echo Editor: %editor%
echo Config: %config_file%
echo Exit code: %launch_error%
echo.
echo Diagnostic log:
echo %log_file%
pause
exit /b %launch_error%
