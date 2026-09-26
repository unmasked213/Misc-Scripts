@echo off
:: Duplicate Image Finder - Dependency Installer
:: This script automatically installs all required Python packages

title Duplicate Image Finder - Setup

echo.
echo ================================================
echo   Duplicate Image Finder - Setup
echo ================================================
echo.
echo This will install the required Python packages:
echo   - opencv-python-headless
echo   - numpy
echo   - pillow
echo   - flask
echo.
echo Press any key to continue...
pause >nul

echo.
echo [STEP 1/3] Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH
    echo.
    echo Please install Python from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation
    echo.
    pause
    exit /b 1
)

python --version
echo [OK] Python is installed

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
    echo [ERROR] Python 3.10 or later is required
    echo.
    echo Install a current Python release from https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

echo.
echo [STEP 2/3] Upgrading pip...
python -m pip install --upgrade pip
if errorlevel 1 (
    echo [WARNING] Could not upgrade pip, continuing anyway...
)

echo.
echo [STEP 3/3] Installing required packages...
echo.
python -m pip install -r "%~dp0requirements.txt"

if errorlevel 1 (
    echo.
    echo [ERROR] Installation failed
    echo.
echo Please try running this as Administrator or install manually:
echo   python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Installation Complete!
echo ================================================
echo.
echo All required packages have been installed.
echo.
echo You can now run the Duplicate Image Finder by:
echo   - Double-clicking "Launch Duplicate Finder Web.vbs"
echo   - Or running "python server.py" from command line
echo.
echo Press any key to exit...
pause >nul
