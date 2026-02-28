# Batch Scripts

Windows batch automation scripts for process management and file conversion.

---

## Scripts

### [clean_ghosts.bat](clean_ghosts.bat)

Cleans up duplicate AI assistant and browser processes that accumulate during development work.

**What it does:**
- Keeps one instance each of Claude, ChatGPT, and Cursor (kills duplicates)
- Kills all Brave browser processes
- Kills Electron zombie processes
- Kills LGHub ghost processes

**Usage:**
```batch
:: Double-click to run, or from command line:
clean_ghosts.bat
```

**Dependencies:** None (uses built-in Windows `tasklist` and `taskkill`)

---

### [mp3 converter/any2mp3.bat](mp3%20converter/)

Converts audio files (M4A, OPUS) to MP3 format using FFmpeg.

**What it does:**
- Converts `.m4a` and `.opus` files to `.mp3` at 320 kbps (highest standard quality)
- Skips files that already have an MP3 version
- Leaves original files untouched
- Shows progress with `[CONVERT]`, `[OK]`, `[SKIP]`, `[FAIL]` status messages

**Usage:**
1. Copy `any2mp3.bat` into the folder with your audio files
2. Double-click to run
3. Review the summary when complete

**Dependencies:** [FFmpeg](https://ffmpeg.org/download.html) must be installed and in PATH

See [mp3 converter/README.md](mp3%20converter/README.md) for detailed setup instructions.

---

### [rotate_display/rotate-display.bat](rotate_display/)

Toggles a display between Landscape and Portrait orientation using direct Windows API calls. Created as a workaround for AMD Adrenalin driver refusing to rotate displays properly.

**What it does:**
- Prompts for a display number (1, 2, 3, etc.)
- Toggles between Landscape (0°) and Portrait (270°) orientation
- Uses embedded C#/P/Invoke code to call `ChangeDisplaySettingsEx` directly
- Bypasses GPU driver software entirely

**Usage:**
1. Double-click to run
2. Enter the display number to rotate
3. Orientation toggles immediately

**Dependencies:** None (uses built-in PowerShell and Windows API)

---

## Status Message Format

All batch scripts use consistent status prefixes:
- `[CONVERT]` - Currently processing
- `[OK]` - Successfully completed
- `[SKIP]` - Already done or not applicable
- `[FAIL]` - Error occurred
- `[ERROR]` - Critical failure (script cannot continue)
