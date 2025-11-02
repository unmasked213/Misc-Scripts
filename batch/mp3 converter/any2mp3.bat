:: Script: any2mp3.bat
:: Purpose: Converts .m4a and .opus audio files to .mp3 format at 320 kbps CBR
::          - Leaves original files untouched (no deletion)
::          - Skips conversion if an .mp3 with the same name already exists
::          - Encodes at constant bitrate 320 kbps (highest standard MP3 quality)
::          - Processes all compatible files in the current directory
:: Usage: Place this batch file in the folder containing your audio files, then double-click to run
::        The script will convert all .m4a and .opus files to .mp3 format
:: Dependencies: FFmpeg must be installed and available in PATH
::               Download from: https://ffmpeg.org/download.html

@echo off
setlocal enableextensions enabledelayedexpansion

:: ---- Settings ----
set "CBR_KBPS=320k"

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ffmpeg not found in PATH. Install it and try again.
  echo Get it from: https://ffmpeg.org/download.html
  pause
  exit /b 1
)

set "count_total=0"
set "count_done=0"
set "count_skip=0"
set "count_fail=0"

for %%E in (m4a opus) do (
  for /f "delims=" %%F in ('dir /b /a:-d "*.%%E" 2^>nul') do (
    set /a count_total+=1
    set "src=%%~fF"
    set "dst=%%~dpnF.mp3"

    if exist "!dst!" (
      echo [SKIP] "%%~nxF" --> MP3 already exists
      set /a count_skip+=1
    ) else (
      echo [CONVERT] "%%~nxF" --> "%%~nF.mp3"
      ffmpeg -hide_banner -loglevel error -y -i "!src!" -vn -c:a libmp3lame -b:a !CBR_KBPS! "!dst!"
      if errorlevel 1 (
        echo [FAIL] "%%~nxF"
        set /a count_fail+=1
        if exist "!dst!" del /q "!dst!" >nul 2>&1
      ) else (
        echo [OK] "%%~nxF"
        set /a count_done+=1
      )
    )
  )
)

if "%count_total%"=="0" (
  echo No .m4a or .opus files found in this folder.
) else (
  echo.
  echo Summary: total=%count_total%  converted=%count_done%  skipped=%count_skip%  failed=%count_fail%
)

echo.
echo Done.
pause
