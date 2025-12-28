# Misc-Scripts

A collection of practical utility scripts for Windows users, organized into four main categories: batch automation, Python utilities, browser userscripts, and TypeScript/React components.

---

## Batch Scripts

Located in `batch/`

### [clean_ghosts.bat](batch/clean_ghosts.bat)
Cleans up duplicate AI assistant and browser processes that can accumulate during development work.

### [any2mp3.bat](batch/mp3%20converter/)
Converts audio files (M4A, OPUS) to MP3 format using FFmpeg. Smart enough to skip files already converted.

---

## Python Scripts

Located in `python/`

### [Duplicate Image Detection V2](python/Duplicate%20image%20detection%20V2/)
Find and manage duplicate or similar images with a modern web interface. Detects exact duplicates, resized versions, cropped images, rotations, and edited versions using perceptual hashing. Features real-time progress tracking, light/dark themes, and safe file operations (moves to trash, never deletes directly).

**Key features:**
- Modern Flask-based web interface with Server-Sent Events
- Detects duplicates across resizing, cropping, rotation, and edits
- Real-time scan progress and responsive image grid
- Keyboard navigation and accessible design
- Safe operations: files moved to `_dupes` folder for review

### [Media Statistics Tools](python/media_stats/)
Three powerful analysis tools for understanding your media collections:

- **folder_stats.py** - Discover which folders use the most space and contain the most files. Uses multiprocessing for fast scanning of large directories.
- **image_stats.py** - Categorize images by resolution (480p, 720p, 1080p, 4K, etc.) and file size with detailed format breakdown.
- **video_stats.py** - Comprehensive video analysis including resolution, length, codec detection, HDR/SDR status, framerate, and bitrate metrics.

### [Minimize Windows](python/minimize_windows/)
Automatically minimize windows based on configurable rules (keywords in window titles). Great for managing cluttered desktops or auto-hiding background applications.

### [Mimic Keystrokes](python/Mimic%20keystrokes%20%28auto%20typing%29/)
Simulate realistic human typing from a text file. Useful for testing, demonstrations, or bypassing paste restrictions on websites.

### [Home Assistant Dashboard Launcher](python/ha_dashboard_launcher/)
Display your Home Assistant dashboard in a standalone, always-on-top window with automatic refresh. Perfect for dedicated dashboard displays or kiosks.

### [List Files by Folder](python/create_list_of_filenames/)
Generate organized, hierarchical lists of files in your directories. Export to text files for documentation, backup planning, or sharing collection inventories.

---

## JavaScript Browser Userscripts

Located in `javascript/violentmonkey_userscripts/`

These scripts enhance your web browsing experience and require [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/) browser extension.

### [global_short_video_hider.user.js](javascript/violentmonkey_userscripts/global_short_video_hider.user.js)
Hide short videos globally across any website. Smart detection protects containers with confirmed long videos from being hidden.

### [page_hopper.user.js](javascript/violentmonkey_userscripts/page_hopper.user.js)
Navigate paginated websites using keyboard shortcuts `[` and `]`. Advanced pagination detection handles high page numbers and minimizes false positives.

### [rectangle_link_selector.user.js](javascript/violentmonkey_userscripts/rectangle_link_selector.user.js)
Select multiple links by drawing a rectangle with right-click drag. Opens all selected links in new tabs instantly.

### [universal_image_downloader.user.js](javascript/violentmonkey_userscripts/universal_image_downloader.user.js)
Download images from any website with a simple double-click. Prevents duplicates and ensures reliable downloads.

### [reddit_to_redlib_redirector.user.js](javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js)
Automatically redirects Reddit URLs to privacy-friendly Redlib instances with hybrid auto-discovery, caching, and smart fallback.

### [video_management_examplesite.user.js](javascript/violentmonkey_userscripts/video_management_examplesite.user.js)
Video management utilities for a specific website - play/pause control, jump to midpoint, hide short videos, toggle images. Template for creating site-specific video management scripts.

---

## TypeScript/React Components

Located in `typescript/`

### [meta_prompt_creator.tsx](typescript/meta_prompt_creator.tsx)
Advanced React component for creating and managing meta prompts with sophisticated markdown rendering. Features dark-themed UI with syntax highlighting, formatted code blocks, and clean typography.

### [meta_prompt_creator_simplified.tsx](typescript/meta_prompt_creator_simplified.tsx)
Simplified version of the meta prompt creator with streamlined functionality for basic use cases.

---

## Getting Started

1. **For Batch Scripts**: Double-click the `.bat` file or run from Command Prompt. Check individual README files for prerequisites (e.g., FFmpeg).

2. **For Python Scripts**:
   - Install Python 3.7+ from [python.org](https://www.python.org/downloads/)
   - Navigate to the script folder and check the README for required packages
   - Install dependencies: `pip install [package-names]`
   - Run: `python script_name.py` or double-click the script

3. **For Browser Userscripts**:
   - Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)
   - Click on the script links above or navigate to the files
   - Open the `.user.js` file in a text editor, copy contents
   - Create new script in Violentmonkey/Tampermonkey and paste

4. **For TypeScript Components**:
   - Copy component code into your React project
   - Ensure TypeScript and React dependencies are installed

---

## Documentation

Each script folder contains:
- **README.md** - Detailed setup instructions, usage guide, and troubleshooting
- **Code comments** - In-file documentation explaining functionality

For comprehensive development guidelines, see [CLAUDE.md](CLAUDE.md).

---

## Safety & Design Philosophy

All scripts follow these principles:
- **Safety first** - Files moved to trash folders, never deleted directly
- **User-friendly** - Designed for non-technical Windows users with plain-language documentation
- **Clear feedback** - Progress indicators, status messages, and summary statistics
- **Graceful handling** - Skip problematic files rather than crashing

---

## Contributing

This is a personal utility collection focused on practical Windows automation. When contributing:
- Follow established code conventions (see [CLAUDE.md](CLAUDE.md))
- Maintain safety-first approach
- Write clear, user-friendly documentation
- Test scripts by double-clicking on Windows

---

*Each script is self-contained with its own documentation. Start by exploring the folder for the tool you need!*
