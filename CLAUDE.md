# CLAUDE - Misc-Scripts

A collection of practical Windows automation, media processing, browser enhancement, and system management utility scripts designed for non-technical users with a safety-first approach.

---

## Summary

This repository provides Windows-focused utility scripts organized into four categories: batch automation, Python utilities, browser userscripts, and TypeScript/React components. All scripts prioritize user safety (moving files to trash instead of deleting), clear progress feedback, and double-click execution from Windows File Explorer.

---

## Structure

```
Misc-Scripts/
├── .claude/                           # Claude Code local settings
│   └── settings.local.json           # Permission configuration for Claude Code
├── .git/                              # Git repository data
├── .gitattributes                     # Git attributes configuration
├── .gitignore                         # Files excluded from version control
├── CLAUDE.md                          # This file - AI assistant guide
├── README.md                          # High-level overview with links to all scripts
├── batch/                             # Windows batch scripts for system automation
│   ├── clean_ghosts.bat              # Kill duplicate AI assistant/browser processes
│   └── mp3 converter/
│       ├── any2mp3.bat               # Convert audio files to MP3 using FFmpeg
│       └── README.md
├── javascript/                        # Browser userscripts (Violentmonkey/Tampermonkey)
│   └── violentmonkey_userscripts/
│       ├── global_short_video_hider.user.js    # Hide short videos on any site
│       ├── page_hopper.user.js                 # Navigate paginated sites with [ ]
│       ├── rectangle_link_selector.user.js     # Select links by drawing rectangle
│       ├── reddit_to_redlib_redirector.user.js # Redirect Reddit to Redlib instances
│       ├── universal_image_downloader.user.js  # Download images from any site
│       └── video_management_examplesite.user.js # Video management utilities template
├── python/                            # Python utilities for media and system management
│   ├── create_list_of_filenames/
│   │   ├── list_files_by_folder.py   # Generate organized file lists
│   │   └── README.md
│   ├── Duplicate image detection V2/
│   │   ├── .claude/                  # Local Claude settings for subproject
│   │   ├── dupefinder.py             # Core duplicate detection engine
│   │   ├── index.html                # Web UI frontend
│   │   ├── install_dependencies.bat  # Easy dependency installation
│   │   ├── Launch Duplicate Finder Web.vbs # Windowless launcher script
│   │   ├── QUICK_START.md            # Quick onboarding guide
│   │   ├── README.md                 # Full documentation
│   │   ├── requirements.txt          # Python dependencies
│   │   └── server.py                 # Flask web server for browser UI
│   ├── ha_dashboard_launcher/
│   │   ├── ha_dashboard_launcher.py  # Home Assistant dashboard window
│   │   └── README.md
│   ├── media_stats/
│   │   ├── folder_stats.py           # Analyze folder sizes and file counts
│   │   ├── image_stats.py            # Categorize images by resolution/size
│   │   ├── README.md
│   │   └── video_stats.py            # Categorize videos by resolution/length/codec/HDR
│   ├── Mimic keystrokes (auto typing)/
│   │   ├── content_to_imitate.txt    # Text input file
│   │   ├── mimic_keystrokes.py       # Simulate human typing
│   │   └── README.md
│   └── minimize_windows/
│       ├── minimize_windows.py       # Auto-minimize windows by rules
│       ├── MinimizeWindow.ps1        # PowerShell alternative
│       └── README.md
└── typescript/                        # TypeScript/React UI components
    ├── meta_prompt_creator.tsx       # Advanced markdown UI component
    └── meta_prompt_creator_simplified.tsx
```

---

## Key Components

### batch/

**Purpose**: Windows batch automation scripts for process management and file conversion.

| File | Purpose | Entry Point |
|------|---------|-------------|
| `clean_ghosts.bat` | Kill duplicate AI assistant (Claude, ChatGPT, Cursor) and browser processes | Double-click or CLI |
| `mp3 converter/any2mp3.bat` | Convert audio files (M4A, OPUS) to MP3 using FFmpeg | Double-click or CLI |

**Dependencies**: FFmpeg for `any2mp3.bat`, Windows built-in `tasklist`/`taskkill` for `clean_ghosts.bat`.

---

### python/

**Purpose**: Python utilities for media processing, window management, and file operations.

| Folder | Main Script | Purpose |
|--------|-------------|---------|
| `Duplicate image detection V2/` | `server.py` | Flask web UI for finding duplicate/similar images using perceptual hashing |
| `media_stats/` | `folder_stats.py`, `image_stats.py`, `video_stats.py` | Analyze media collections by size, resolution, codec, etc. |
| `minimize_windows/` | `minimize_windows.py` | Auto-minimize windows matching configurable rules |
| `Mimic keystrokes (auto typing)/` | `mimic_keystrokes.py` | Simulate realistic human typing |
| `ha_dashboard_launcher/` | `ha_dashboard_launcher.py` | Display Home Assistant dashboard in native window |
| `create_list_of_filenames/` | `list_files_by_folder.py` | Generate hierarchical file listings |

**Key Files**:
- `Duplicate image detection V2/dupefinder.py` - Core detection engine with perceptual hashing
- `Duplicate image detection V2/index.html` - Modern web UI with light/dark themes
- `Duplicate image detection V2/requirements.txt` - Dependencies: opencv-python-headless, numpy, pillow, flask, flask-cors

**Common Dependencies**:
- `Pillow` - Image processing
- `opencv-python-headless` - Computer vision (dupefinder)
- `flask`, `flask-cors` - Web server (dupefinder V2)
- `pygetwindow`, `pywin32` - Window management
- `pywebview`, `screeninfo` - Dashboard launcher
- `keyboard`, `pyautogui` - Keystroke simulation

---

### javascript/

**Purpose**: Browser userscripts for enhanced web browsing (require Violentmonkey or Tampermonkey).

| Script | Purpose |
|--------|---------|
| `global_short_video_hider.user.js` | Hide short videos globally on any website |
| `page_hopper.user.js` | Navigate paginated sites using `[` and `]` keys |
| `rectangle_link_selector.user.js` | Select multiple links by right-click dragging a rectangle |
| `reddit_to_redlib_redirector.user.js` | Redirect Reddit to privacy-friendly Redlib instances |
| `universal_image_downloader.user.js` | Download images with double-click |
| `video_management_examplesite.user.js` | Template for site-specific video management |

**Dependencies**: Violentmonkey or Tampermonkey browser extension. Pure JavaScript, no additional libraries.

---

### typescript/

**Purpose**: TypeScript/React UI components for meta prompt creation.

| File | Purpose |
|------|---------|
| `meta_prompt_creator.tsx` | Advanced React component with custom markdown rendering, dark theme |
| `meta_prompt_creator_simplified.tsx` | Simplified version for basic use cases |

**Dependencies**: React, TypeScript.

---

## Development Workflows

### Setup

**Python scripts**:
```bash
# Install Python 3.7+ from python.org with "Add Python to PATH" checked
pip install -r python/Duplicate\ image\ detection\ V2/requirements.txt
# Or for individual scripts, see their README for specific pip commands
```

**Batch scripts**:
- No setup needed for Windows built-in commands
- For `any2mp3.bat`: Install FFmpeg and add to PATH

**Userscripts**:
- Install Violentmonkey/Tampermonkey browser extension
- Copy script contents into new userscript

### Test

No automated test suite is configured. Testing is manual:

1. **Double-click testing** - Verify scripts work when double-clicked on Windows
2. **Error handling** - Test with invalid inputs, missing files
3. **Progress display** - Verify feedback shows for long operations
4. **Window stays open** - Confirm `input()` or `pause` keeps window open

### Build

Not specified in repository. Scripts are interpreted (Python, Batch, JavaScript) or require external React build setup (TypeScript).

### Lint

Not specified in repository. No linter configuration files present.

### Run

**Python scripts**:
```bash
python script_name.py [arguments]
# Or double-click the .py file in Windows Explorer
```

**Batch scripts**:
```batch
:: Double-click the .bat file, or:
script_name.bat
```

**Duplicate Image Finder V2**:
```bash
cd python/Duplicate\ image\ detection\ V2
python server.py
# Then open http://localhost:5000 in browser
# Or double-click "Launch Duplicate Finder Web.vbs"
```

### CI/CD

Not specified in repository. No `.github/workflows/`, CI configuration files, or deployment scripts present.

### Git Workflow

- **Branch naming**: `claude/<description>-<session-id>`
- **Commit messages**: Start with verb (Add, Fix, Update, Refactor, Remove)
- **Never push directly to main**
- **Create PR** with descriptive title and summary

---

## Conventions for AI Assistants

### Safety-First File Operations (CRITICAL)
- **NEVER delete files directly** - Always move to a `_trash` or `_dupes` folder for user review
- **Preview before action** - Show what will be changed before making changes
- **Graceful degradation** - Skip problematic files rather than failing entirely
- **User confirmation** - Require explicit confirmation for destructive operations

### User-Friendly Design
- Scripts target **non-technical Windows users**
- Use **plain language** in documentation, avoid jargon
- Provide both **GUI (double-click)** and **CLI** usage methods
- Include **progress feedback** with percentages for long operations
- Keep windows open on completion using `pause` (batch) or `input()` (Python)

### Status Message Format
Use clear prefixes:
```
[CONVERT] "filename.m4a" --> "filename.mp3"
[OK]      Successfully processed
[SKIP]    Already exists or not applicable
[FAIL]    Error occurred (with reason)
[ERROR]   Critical failure
```

### Python Script Structure
```python
"""
Script: script_name.py
Purpose: Brief description
         - Feature 1
         - Feature 2
Usage: python script_name.py [args]
Requirements: package1, package2
              Install: pip install package1 package2
"""

# Configuration constants at top, UPPERCASE
SETTING_NAME = "value"

def main():
    # Main logic
    pass

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled by user.")
    finally:
        input("\nPress Enter to close...")
```

### Batch Script Structure
```batch
:: Script: script_name.bat
:: Purpose: Brief description
:: Usage: How to run
:: Dependencies: Required tools

@echo off
setlocal enableextensions enabledelayedexpansion

:: Check dependencies first
where required_tool >nul 2>&1
if errorlevel 1 (
  echo [ERROR] required_tool not found
  pause
  exit /b 1
)

:: Main logic...

echo Summary: processed=%count%
pause
```

### Userscript Header Requirements (MANDATORY)

All browser userscripts in this repository MUST follow these rules exactly.

**Identity & Updates**
- Every userscript MUST define:
  - `@name`
  - `@namespace` (stable and repo-backed)
  - `@version` (must be incremented on every change)
  - `@updateURL`
  - `@downloadURL`
- `@namespace` MUST be:
  ```
  https://github.com/unmasked213/Misc-Scripts
  ```
  and MUST NOT vary between scripts or versions.
- `@updateURL` and `@downloadURL` MUST point to the raw GitHub file under:
  ```
  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/<script>.user.js
  ```
- Scripts MUST be installable and updateable via Violentmonkey without manual edits.

**Header Stability**
- The tuple (`@name` + `@namespace`) defines script identity.
- Once a script is published, `@namespace` MUST NEVER change again.
- Changing `@namespace` or removing it requires a one-time uninstall/reinstall and should be avoided.

**Execution & Permissions**
- `@run-at` MUST be explicitly set (`document-start`, `document-idle`, or `document-end`).
- `@grant` MUST be minimal and explicit.
- Do NOT include unused grants.
- Do NOT rely on implicit default grants.

**Formatting**
- The userscript header MUST start at byte 0 of the file.
- No blank lines or characters before `// ==UserScript==`
- Header block MUST be contiguous and unbroken.

**Example Canonical Header**
```javascript
// ==UserScript==
// @name         Example Script
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      1.0
// @description  Brief description
// @author       Unmasked213
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/example_script.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/example_script.user.js
// ==/UserScript==
```

### Userscript Code Structure
- Use IIFE `(function() { 'use strict'; ... })();`
- Configuration in `const CONFIG = { ... }` at top
- Use MutationObserver over polling

### Data Handling
- Use `pathlib.Path` for file paths
- Handle UTF-8 encoding explicitly on Windows
- Validate user input before processing
- Log errors to files or display summary at end

### Security Constraints
- No hardcoded credentials or API keys in scripts
- No network operations without user awareness
- Validate paths to prevent directory traversal

---

## TODOs & Gaps

### Missing Documentation
- [ ] No automated test suite or test documentation
- [ ] No linter configuration (ESLint, flake8, etc.)
- [ ] No CI/CD pipeline configured
- [ ] TypeScript components lack README files

### Unclear Configurations
- [ ] `.claude/settings.local.json` permissions scope is minimal (only `Bash(dir:*)`)
- [ ] No Python version pinning (works with 3.7+ but not enforced)

### Areas Needing Human Review
- [ ] Userscript `@match` patterns may need adjustment for specific sites
- [ ] `reddit_to_redlib_redirector.user.js` relies on external Redlib instances that may change
- [ ] FFmpeg path requirements not automatically validated

### Discrepancies Found
- README.md references `reddit_to_libreddit_redirector.user.js` but actual file is `reddit_to_redlib_redirector.user.js`

---

## Changelog

### 2025-12-28 (Commit 84fcd5c)
- **Updated** CLAUDE.md to new standardized format with 8 required sections
- **Fixed** filename discrepancy: documented `reddit_to_redlib_redirector.user.js` (was incorrectly listed as `reddit_to_libreddit_redirector.user.js`)
- **Added** missing files to structure: `index.html`, `Launch Duplicate Finder Web.vbs`, `requirements.txt`, `.claude/` directories
- **Added** explicit "not specified" notes for missing CI/CD, linting, and automated testing
- **Added** TODOs & Gaps section for areas needing human review

### Previous Updates

#### December 2025
- **Duplicate Image Finder V2** - Complete rewrite with modern Flask-based web interface
  - Real-time progress streaming with Server-Sent Events (SSE)
  - Light/dark theme support with accessible focus states
  - Keyboard navigation and responsive image grid
  - Heartbeat-based auto-shutdown when browser closes
  - Undo functionality for file operations
- **Browser Userscripts** - Added six new Violentmonkey userscripts

#### November 2025
- **Multiprocessing optimization** - Added parallel processing to folder_stats.py, image_stats.py, and video_stats.py
- **Enhanced video analysis** - video_stats.py includes codec detection, HDR/SDR status, framerate, bitrate
- **Interactive features** - folder_stats.py prompts for results count when double-clicked
- **Documentation restructuring** - Simplified main README, added detailed subfolder READMEs

---

**End of CLAUDE.md**
