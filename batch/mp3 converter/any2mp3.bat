@echo off
setlocal enableextensions enabledelayedexpansion

:: any2mp3.bat — Convert .m4a and .opus in this folder to .mp3 @ 320 kbps
:: - Leaves originals untouched
:: - Skips if an .mp3 with the same basename already exists
:: - Requires ffmpeg in PATH

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
