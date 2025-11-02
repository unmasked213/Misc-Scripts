@echo off
echo Killing duplicate AI and browser processes...

:: Kill extra Claude processes (leave one)
for /f "skip=1 tokens=2 delims=," %%p in ('tasklist /fi "imagename eq claude.exe" /fo csv') do (
    if not defined first_claude (
        set first_claude=1
    ) else (
        taskkill /f /pid %%p
    )
)

:: Kill extra ChatGPT processes (leave one)
for /f "skip=1 tokens=2 delims=," %%p in ('tasklist /fi "imagename eq chatgpt.exe" /fo csv') do (
    if not defined first_chatgpt (
        set first_chatgpt=1
    ) else (
        taskkill /f /pid %%p
    )
)

:: Kill extra Cursor processes (leave one)
for /f "skip=1 tokens=2 delims=," %%p in ('tasklist /fi "imagename eq cursor.exe" /fo csv') do (
    if not defined first_cursor (
        set first_cursor=1
    ) else (
        taskkill /f /pid %%p
    )
)

:: Kill extra Brave browser processes
taskkill /f /im brave.exe >nul 2>&1

:: Kill Electron zombies
taskkill /f /im electron.exe >nul 2>&1

:: Kill LGHub ghosts
taskkill /f /im lghub_agent.exe >nul 2>&1
taskkill /f /im lghub_system_tray.exe >nul 2>&1

echo Cleanup done.
pause
