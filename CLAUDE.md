# CLAUDE.md - AI Assistant Guide for Misc-Scripts Repository

**Last Updated**: 2025-12-22
**Repository**: Misc-Scripts - A collection of Windows automation, media processing, and system management utilities

---

## Repository Overview

This repository contains practical utility scripts for Windows users, organized into four main categories:

- **`batch/`** - Windows batch scripts for system automation
- **`python/`** - Python scripts for media processing, window management, and utilities
- **`javascript/`** - Browser userscripts for enhanced web browsing (Violentmonkey/Tampermonkey)
- **`typescript/`** - TypeScript/React components for UI applications

Each script folder contains its own detailed README.md with user-friendly setup and usage instructions.

---

## Core Principles & Philosophy

When working with this codebase, adhere to these fundamental principles:

### 1. **Safety First**
- **Never delete files directly** - Always move to a trash folder first for user review
- **Preview before action** - Show what will be changed before making changes
- **Graceful degradation** - Skip problematic files rather than failing entirely
- **User confirmation** - For destructive operations, require explicit user confirmation

### 2. **User-Friendly Design**
- Scripts are designed for **non-technical Windows users**
- Documentation uses **plain language**, avoiding jargon
- Provide both **GUI (double-click)** and **CLI** usage methods
- Include **progress feedback** for long-running operations
- Keep windows open on completion (use `pause` or `input()`) for user review

### 3. **Clear Communication**
- Use **descriptive status messages**: `[CONVERT]`, `[OK]`, `[SKIP]`, `[FAIL]`
- Show **progress percentages** for long operations
- Provide **summary statistics** at completion
- Log errors to files rather than just displaying them

### 4. **Windows-Centric**
- All scripts assume **Windows environment**
- Use Windows-specific APIs when needed (pywin32, win32gui, etc.)
- Paths use Windows conventions
- Scripts should work when double-clicked from File Explorer

---

## Repository Structure

```
Misc-Scripts/
├── README.md                          # High-level overview with links to all scripts
├── CLAUDE.md                          # This file - AI assistant guide
├── batch/
│   ├── clean_ghosts.bat              # Kill duplicate AI assistant/browser processes
│   └── mp3 converter/
│       ├── any2mp3.bat               # Convert audio files to MP3
│       └── README.md
├── python/
│   ├── Duplicate image detection V2/
│   │   ├── dupefinder.py            # Core duplicate detection engine
│   │   ├── server.py                # Flask web server for browser UI
│   │   ├── install_dependencies.bat # Easy dependency installation
│   │   ├── README.md                # Full documentation
│   │   └── QUICK_START.md           # Quick onboarding guide
│   ├── media_stats/
│   │   ├── folder_stats.py          # Analyze folder sizes and file counts
│   │   ├── image_stats.py           # Categorize images by resolution/size
│   │   ├── video_stats.py           # Categorize videos by resolution/length/codec/HDR
│   │   └── README.md
│   ├── minimize_windows/
│   │   ├── minimize_windows.py      # Auto-minimize windows by rules
│   │   ├── MinimizeWindow.ps1       # PowerShell alternative
│   │   └── README.md
│   ├── Mimic keystrokes (auto typing)/
│   │   ├── mimic_keystrokes.py      # Simulate human typing
│   │   ├── content_to_imitate.txt   # Text input file
│   │   └── README.md
│   ├── ha_dashboard_launcher/
│   │   ├── ha_dashboard_launcher.py # Home Assistant dashboard window
│   │   └── README.md
│   └── create_list_of_filenames/
│       ├── list_files_by_folder.py  # Generate organized file lists
│       └── README.md
├── javascript/
│   └── violentmonkey_userscripts/    # Browser userscripts
│       ├── global_short_video_hider.user.js    # Hide short videos on any site
│       ├── page_hopper.user.js                 # Navigate paginated sites with [ ]
│       ├── rectangle_link_selector.user.js     # Select links by drawing rectangle
│       ├── reddit_to_libreddit_redirector.user.js  # Redirect Reddit to Libreddit
│       ├── universal_image_downloader.user.js  # Download images from any site
│       └── video_management_examplesite.user.js    # Video management utilities
└── typescript/
    ├── meta_prompt_creator.tsx       # Advanced markdown UI component
    └── meta_prompt_creator_simplified.tsx
```

---

## Code Conventions

### Python Scripts

#### File Header Format
Every Python script should begin with a comprehensive docstring:

```python
"""
Script: script_name.py
Purpose: Brief description of what the script does
         - Key feature 1
         - Key feature 2
         - Key feature 3
Usage: python script_name.py [arguments]
       Additional usage notes
Requirements: package1, package2
              Install: pip install package1 package2
"""
```

#### Configuration Constants
- Place **user-configurable variables** at the top of the script or in a clearly marked section
- Use **UPPERCASE** for true constants (e.g., `SNAP_TOLERANCE = 400`)
- Use **descriptive variable names** (e.g., `keywords_to_minimize`, not `kw_list`)

```python
# Config section example
URL = 'http://homeassistant.local:8123/dashboard-home/home'
INTERVAL = 300  # 5 minutes
SNAP_TOLERANCE = 400
```

#### Function Documentation
```python
def function_name(param1, param2):
    """Brief description of what the function does.

    Can include additional details if needed.
    """
    # Implementation
```

#### Error Handling
- Use **try-except** blocks for operations that may fail
- **Don't crash on individual file errors** - skip the file and continue
- **Log skipped/failed items** to a file or display at the end
- Print clear error messages that help users understand what went wrong

```python
try:
    # Process file
    process_file(file_path)
except Exception as e:
    print(f"Error processing {file_path}: {e}")
    skipped_files.append(file_path)
```

#### Progress Feedback
For operations processing many files:

```python
total = len(files)
for i, file_path in enumerate(files, 1):
    progress = (i / total) * 100
    print(f"Progress: {progress:.1f}% ({i}/{total})")
    # Process file
```

#### Interactive Script Behavior
Scripts should remain open for user review when double-clicked:

```python
if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\nOperation cancelled by user.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        input("\nPress Enter to close...")
```

### Batch Scripts

#### File Header Format
```batch
:: Script: script_name.bat
:: Purpose: Brief description
::          - Key feature 1
::          - Key feature 2
:: Usage: How to run the script
:: Dependencies: Required external tools
::               Where to get them

@echo off
```

#### Status Messages
Use clear prefixes for different types of output:

```batch
echo [CONVERT] "filename.m4a" --> "filename.mp3"
echo [OK] "filename.m4a"
echo [SKIP] "filename.m4a" --> MP3 already exists
echo [FAIL] "filename.m4a"
echo [ERROR] ffmpeg not found in PATH
```

#### Error Checking
```batch
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ffmpeg not found in PATH
  pause
  exit /b 1
)
```

#### Summary Statistics
Always provide a summary at the end:

```batch
echo.
echo Summary: total=%count_total%  converted=%count_done%  skipped=%count_skip%  failed=%count_fail%
echo.
pause
```

### TypeScript/React Components

- Use **functional components** with hooks
- Include **inline styles** when appropriate for self-contained components
- Use **TypeScript** for type safety
- Comment complex logic, especially custom markdown parsing

### JavaScript/Violentmonkey Userscripts

Userscripts follow a specific format for browser extension compatibility:

#### File Header Format (UserScript Metadata Block)
```javascript
// ==UserScript==
// @name         Script Name
// @namespace    script-namespace
// @version      1.0
// @description  Brief description of what the script does
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @author       Unmasked213
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/script_name.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/script_name.user.js
// ==/UserScript==
```

#### Script Structure
```javascript
(function() {
    'use strict';

    // Configuration constants at the top
    const CONFIG = {
        SETTING_1: 'value',
        SETTING_2: 100,
    };

    // State management
    const state = {
        isActive: false,
        // ...
    };

    // Helper functions
    function helperFunction() {
        // Implementation
    }

    // Main logic
    function init() {
        // Initialize script
    }

    // Start the script
    init();
})();
```

#### Best Practices for Userscripts
- **Use IIFE** (Immediately Invoked Function Expression) to avoid polluting global scope
- **'use strict'** at the top of the IIFE
- **Configuration constants** at the top in a CONFIG object for easy customization
- **Minimal @grant permissions** - only request what's needed
- **@run-at document-idle** for most scripts (unless early interception needed)
- **Include @updateURL and @downloadURL** pointing to raw GitHub URLs for auto-updates
- **Use WeakSet/WeakMap** for tracking DOM elements to avoid memory leaks
- **Avoid aggressive DOM polling** - prefer MutationObserver when possible
- **Respect page performance** - debounce/throttle expensive operations

#### Naming Convention
- Files end with `.user.js` (required by userscript managers)
- Use descriptive snake_case names: `global_short_video_hider.user.js`

---

## Documentation Standards

### README Structure

Each script folder's README.md should follow this structure:

```markdown
# Script Name

## What does it do?

[Plain-language explanation suitable for non-technical users]
[Explain the problem it solves]
[List key features]

## How to set up

### Step 1: Install [Prerequisite 1]
[Detailed instructions with links]

### Step 2: Install [Prerequisite 2]
[More instructions]

## How to use it

### [Method 1 name]:
[Step-by-step instructions]

### [Method 2 name]:
[Alternative method]

## Tips and tricks

- [Helpful tip 1]
- [Helpful tip 2]

## Troubleshooting

**[Common problem]?**
- [Solution]
```

### Documentation Style Guide

1. **Use plain language** - Write for users who may not be programmers
2. **Be concrete** - Use specific examples rather than abstract descriptions
3. **Include screenshots or examples** - Show, don't just tell
4. **Explain prerequisites** - Don't assume users know what Python or FFmpeg is
5. **Provide links** - Direct users to download pages for dependencies
6. **Use bold for emphasis** - Highlight important warnings or notes
7. **Break into sections** - Use headers to make information scannable

### Examples of Good Documentation

**Good**: "This tool helps you find duplicate and similar images in your photo collection."

**Bad**: "Image deduplication utility using perceptual hashing algorithms."

**Good**: "Open Command Prompt and type: `pip install opencv-python-headless`"

**Bad**: "Install dependencies via pip"

---

## Development Workflow

### Git Branch Naming

- Feature branches use the pattern: `claude/<description>-<session-id>`
- Example: `claude/audit-and-fix-scripts-01NrSLh7yGyBZ9AKYTVuQ3oL`
- Always develop on the designated feature branch
- Never push directly to `main`

### Pull Request Process

1. **Create feature branch** from main
2. **Make changes** with clear, focused commits
3. **Test thoroughly** - Verify scripts work when double-clicked on Windows
4. **Update documentation** - README changes for user-facing modifications
5. **Create PR** with descriptive title and summary
6. **Merge** after review

### Commit Message Guidelines

- Use **descriptive commit messages** that explain what and why
- Start with a **verb**: "Add", "Fix", "Update", "Refactor", "Remove"
- Reference the **feature or issue** being addressed

Examples:
- ✅ `Fix dupefinder.py: add missing build_thumbnail function`
- ✅ `Update README: reflect current scripts and add comprehensive documentation`
- ✅ `Add interactive mode and improve user feedback`
- ❌ `Fixed bug`
- ❌ `Updated files`

### Testing Checklist

Before submitting a PR, verify:

- [ ] **Script runs when double-clicked** (for Windows scripts)
- [ ] **Error handling works** - Try with invalid inputs, missing files, etc.
- [ ] **Progress messages display** for long operations
- [ ] **Window stays open** for user to review results
- [ ] **Documentation is updated** if user-facing changes were made
- [ ] **Dependencies are documented** in README
- [ ] **File headers are complete** and accurate

---

## Common Patterns & Idioms

### Path Handling

```python
from pathlib import Path

# Use Path objects for better cross-platform compatibility
target_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

# Check file types
def is_image_file(path: Path) -> bool:
    return path.suffix.lower() in {".jpg", ".jpeg", ".png", ".gif"}

# Recursive file searching
for file_path in target_path.rglob("*.jpg"):
    process_file(file_path)
```

### User Input

```python
# Get user input with fallback
folder_path = input("Enter folder path (or press Enter for current folder): ").strip()
if not folder_path:
    folder_path = os.getcwd()

# Validate input
if not os.path.exists(folder_path):
    print(f"Error: Path does not exist: {folder_path}")
    input("Press Enter to exit...")
    sys.exit(1)
```

### Safe File Operations

```python
# Create trash folder instead of deleting
import shutil

trash_folder = os.path.join(os.getcwd(), "_trash")
os.makedirs(trash_folder, exist_ok=True)

# Move file to trash
destination = os.path.join(trash_folder, os.path.basename(file_path))
shutil.move(file_path, destination)
print(f"Moved to trash: {file_path}")
```

### Windows-Specific Operations

```python
import win32gui
import win32con
import pygetwindow as gw

# Get all windows
all_windows = gw.getAllWindows()

# Minimize a window
for window in all_windows:
    if "keyword" in window.title.lower():
        win32gui.ShowWindow(window._hWnd, win32con.SW_MINIMIZE)
        print(f"Minimized: {window.title}")
```

---

## Dependencies & Requirements

### Python Scripts

Common dependencies used across scripts:

- **Pillow** (`PIL`) - Image processing (image_stats.py, dupefinder.py)
- **opencv-python-headless** - Computer vision operations (dupefinder.py)
- **numpy** - Numerical operations (dupefinder.py, used by opencv)
- **Flask** - Web server framework (dupefinder V2 web interface)
- **flask-cors** - CORS support for Flask (dupefinder V2 web interface)
- **pygetwindow** - Window management (minimize_windows.py)
- **pywin32** (win32gui, win32con) - Windows API access (minimize_windows.py, mimic_keystrokes.py)
- **pywebview** - Display web content in native window (ha_dashboard_launcher.py)
- **screeninfo** - Multi-monitor support (ha_dashboard_launcher.py)
- **keyboard** - Keyboard event handling (mimic_keystrokes.py)
- **pyautogui** - GUI automation for typing simulation (mimic_keystrokes.py)
- **pathlib** - Path handling (standard library, Python 3.4+)
- **multiprocessing** - Parallel processing (folder_stats.py, image_stats.py, video_stats.py) - standard library

### Batch Scripts

- **FFmpeg** - Audio/video processing (any2mp3.bat)
- **tasklist/taskkill** - Process management (clean_ghosts.bat) - built into Windows

### Browser Userscripts

- **Violentmonkey** or **Tampermonkey** - Browser extension to run userscripts
- No additional dependencies - pure JavaScript

### Installation Best Practices

When adding new dependencies:

1. **Test installation** on a clean Windows system
2. **Document in README** with step-by-step instructions
3. **Include in script docstring** with exact pip command
4. **Check for alternatives** - Prefer packages with fewer sub-dependencies
5. **Verify Windows compatibility** - Some packages have issues on Windows

---

## Troubleshooting Common Issues

### "pip is not recognized"

Python is not in PATH. User needs to reinstall Python with "Add Python to PATH" checked.

### "ffmpeg is not recognized"

FFmpeg is not installed or not in PATH. Direct user to https://ffmpeg.org/download.html.

### Script closes immediately when double-clicked

Missing `input()` or `pause` at the end. Add:

```python
input("\nPress Enter to close...")
```

Or for batch:
```batch
pause
```

### Permission errors on Windows

Script may need to run as Administrator, or files may be in use by another program.

### Import errors despite pip install

User may have multiple Python installations. Suggest using full path to pip:

```batch
python -m pip install package_name
```

---

## Recent Changes & History

Based on recent git history, key changes include:

### December 2025
- **Duplicate Image Finder V2** - Complete rewrite with modern Flask-based web interface
  - Real-time progress streaming with Server-Sent Events (SSE)
  - Light/dark theme support with accessible focus states
  - Keyboard navigation and responsive image grid
  - Heartbeat-based auto-shutdown when browser closes
  - Undo functionality for file operations
- **Browser Userscripts** - Added six new Violentmonkey userscripts:
  - `global_short_video_hider.user.js` - Hide short videos on any website
  - `page_hopper.user.js` - Navigate paginated sites with keyboard shortcuts
  - `rectangle_link_selector.user.js` - Select multiple links by drawing rectangles
  - `reddit_to_libreddit_redirector.user.js` - Privacy-focused Reddit redirect
  - `universal_image_downloader.user.js` - Download images from any site
  - `video_management_examplesite.user.js` - Video management utilities

### November 2025
- **Multiprocessing optimization** - Added parallel processing to folder_stats.py, image_stats.py, and video_stats.py for significant performance improvements on large collections
- **Enhanced video analysis** - video_stats.py (renamed from video_stats_v2.py) now includes codec detection, HDR/SDR status, framerate analysis, and bitrate metrics
- **Interactive features** - folder_stats.py now prompts for results count when double-clicked
- **Improved reporting** - Added color-coded file counts in folder_stats.py, file format breakdown in image_stats.py, and top largest files display
- **Code quality audit** - Improved error handling, added docstrings, fixed deprecation warnings
- **Documentation restructuring** - Simplified main README, added detailed subfolder READMEs

---

## Working with AI Assistants

### When Adding Features

1. **Maintain the safety-first principle** - Preview, don't delete
2. **Keep documentation in sync** - Update README if user-facing changes
3. **Test on Windows** - Verify double-click behavior
4. **Follow existing patterns** - Use established conventions for similar functionality
5. **Consider non-technical users** - Write clear error messages and instructions

### When Fixing Bugs

1. **Understand the context** - Read the entire script and its README
2. **Test the fix** - Verify it doesn't break other functionality
3. **Update comments** - Keep code documentation accurate
4. **Check for similar issues** - Look for the same bug pattern in other scripts

### When Refactoring

1. **Preserve user experience** - Don't change how users interact with scripts
2. **Maintain backward compatibility** - Existing file formats, output formats, etc.
3. **Document changes** - Update docstrings and READMEs as needed
4. **Test thoroughly** - Verify all use cases still work

---

## Project Goals & Future Direction

This repository aims to:

1. **Provide practical utilities** for Windows power users
2. **Maintain accessibility** for non-programmers
3. **Prioritize safety** in all file operations
4. **Stay focused** - Each script does one thing well
5. **Be maintainable** - Clear code, good documentation, minimal dependencies

When proposing new scripts or features, consider:

- Does it solve a real Windows user problem?
- Can non-technical users understand and use it?
- Is it safe (no accidental data loss)?
- Is the scope appropriate (not too complex)?
- Are dependencies reasonable (available via pip/installer)?

---

## Quick Reference

### Starting a New Python Script

```python
"""
Script: new_script.py
Purpose: [What it does]
         - [Feature 1]
         - [Feature 2]
Usage: python new_script.py [args]
Requirements: [packages]
              Install: pip install [packages]
"""

import sys
from pathlib import Path

# Configuration
SETTING_1 = "value"
SETTING_2 = 100

def main():
    try:
        # Main logic here
        print("Starting...")

        # Process files with progress
        # ...

        print("Done!")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled by user.")
    finally:
        input("\nPress Enter to close...")
```

### Starting a New Batch Script

```batch
:: Script: new_script.bat
:: Purpose: [What it does]
:: Usage: [How to run]
:: Dependencies: [External tools]

@echo off
setlocal enableextensions enabledelayedexpansion

echo Starting...

:: Check dependencies
where external_tool >nul 2>&1
if errorlevel 1 (
  echo [ERROR] external_tool not found
  pause
  exit /b 1
)

:: Main logic
set "count=0"
for %%F in (*.ext) do (
  echo Processing "%%~nxF"
  set /a count+=1
)

echo.
echo Processed %count% files
pause
```

### Starting a New Userscript

```javascript
// ==UserScript==
// @name         New Script Name
// @namespace    new-script
// @version      1.0
// @description  [What it does]
// @match        *://*.example.com/*
// @run-at       document-idle
// @grant        none
// @author       Unmasked213
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/new_script.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/new_script.user.js
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        DEBUG: false,
        // Add settings here
    };

    // State
    const state = {};

    // Helper functions
    function log(...args) {
        if (CONFIG.DEBUG) console.log('[NewScript]', ...args);
    }

    // Main initialization
    function init() {
        log('Initializing...');
        // Setup observers, event listeners, etc.
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
```

---

## Contact & Contributions

This is a personal utility collection. When working on improvements:

- Focus on **user experience** for Windows users
- Maintain **safety** as the top priority
- Keep **documentation** clear and comprehensive
- Follow **established patterns** for consistency

For questions about specific scripts, refer to their individual README files.

---

**End of CLAUDE.md**
