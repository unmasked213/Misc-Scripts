@echo off
title Duplicate Image Finder - Web Interface
echo.
echo ============================================================
echo   Duplicate Image Finder - Web Interface
echo ============================================================
echo.

REM Try to find Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo ERROR: Python not found in PATH
        echo Please install Python from https://python.org
        pause
        exit /b 1
    )
    set PYTHON=python3
) else (
    set PYTHON=python
)

REM Check if Flask is installed, if not install requirements
%PYTHON% -c "import flask" >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing required packages...
    echo.
    %PYTHON% -m pip install -r requirements.txt
    echo.
)

echo Starting server...
echo.
echo Open your browser to: http://localhost:5000
echo Press Ctrl+C to stop the server
echo.

%PYTHON% server.py

pause
