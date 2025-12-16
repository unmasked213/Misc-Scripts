@echo off
:: Duplicate Image Finder - Quick Launcher
:: Double-click this file to start the application

:: Use pythonw.exe to launch without showing CMD window
start "" pythonw dupefinder_gui.py

:: If pythonw is not found, fall back to python with visible window
if errorlevel 1 (
    title Duplicate Image Finder
    echo.
    echo ========================================
    echo   Duplicate Image Finder
    echo ========================================
    echo.
    echo Starting application...
    echo.

    python dupefinder_gui.py

    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to start the application
        echo.
        echo Make sure Python is installed and required packages are installed:
        echo   pip install opencv-python-headless numpy pillow
        echo.
        pause
    )
)
