@echo off
:: ================================================================
:: rotate-display.bat
:: Thin wrapper around rotate-display.py.
:: Preserves the .bat name for existing shortcuts/hotkeys.
::
:: All logic lives in rotate-display.py - this just invokes it
:: with the correct path and forwards any CLI arguments.
::
:: Double-click             -> toggle the configured monitor
:: rotate-display.bat -p    -> re-pick the target monitor
:: rotate-display.bat -d    -> diagnostic (full enumeration)
:: rotate-display.bat -r    -> clear the saved config
:: ================================================================
python "%~dp0rotate-display.py" %*
if errorlevel 1 pause
