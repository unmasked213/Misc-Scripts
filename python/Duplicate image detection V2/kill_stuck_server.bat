@echo off
echo Killing any Python processes on port 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do (
    echo Found process: %%a
    taskkill /PID %%a /F 2>nul
)
echo.
echo Done. You can now restart the server.
pause
