@echo off
setlocal
cd /d "%~dp0"

python -m unittest discover -s tests -p "test_*.py" -v
if errorlevel 1 (
    echo.
    echo Safety tests failed.
    pause
    exit /b 1
)

echo.
echo All safety tests passed.
pause

