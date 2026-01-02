# Misc-Scripts

Practical utility scripts for Windows users: automation, media processing, browser enhancements, and UI components.

---

## Quick Navigation

| Folder | Description | Details |
|--------|-------------|---------|
| [batch/](batch/) | Windows batch scripts for process management and audio conversion | [README](batch/README.md) |
| [python/](python/) | Media processing, window management, and file utilities | See subfolder READMEs |
| [browser_extensions/](browser_extensions/) | Native browser extensions for Chrome/Brave/Edge | [README](browser_extensions/README.md) |
| [javascript/](javascript/violentmonkey_userscripts/) | Browser userscripts for Violentmonkey/Tampermonkey | [README](javascript/violentmonkey_userscripts/README.md) |
| [typescript/](typescript/) | React components for markdown rendering | [README](typescript/README.md) |

---

## Highlights

### Batch
- **[clean_ghosts.bat](batch/clean_ghosts.bat)** - Kill duplicate AI assistant/browser processes
- **[any2mp3.bat](batch/mp3%20converter/)** - Convert audio to MP3

### Python
- **[Duplicate Image Finder](python/Duplicate%20image%20detection%20V2/)** - Web UI for finding similar images
- **[Media Stats](python/media_stats/)** - Analyze folders, images, and videos by size/resolution/codec
- **[Minimize Windows](python/minimize_windows/)** - Auto-minimize windows by title keywords
- **[Mimic Keystrokes](python/Mimic%20keystrokes%20%28auto%20typing%29/)** - Simulate human typing
- **[HA Dashboard Launcher](python/ha_dashboard_launcher/)** - Home Assistant in a native window
- **[List Files](python/create_list_of_filenames/)** - Generate hierarchical file listings

### Browser Extensions
- **[Media Downloader](browser_extensions/media-downloader-extension/)** - Batch download images and videos from tabs with HLS streaming support

### Browser Userscripts
- **[Auto Load-More Toggle](javascript/violentmonkey_userscripts/auto_load_more_toggle.user.js)** - Auto-click "Load More" buttons with idle detection
- **[Global Short Video Hider](javascript/violentmonkey_userscripts/global_short_video_hider.user.js)** - Hide videos under 60s
- **[Page Hopper](javascript/violentmonkey_userscripts/page_hopper.user.js)** - Navigate pages with `[` and `]`
- **[Rectangle Link Selector](javascript/violentmonkey_userscripts/rectangle_link_selector.user.js)** - Select links by drawing
- **[Reddit to Redlib](javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js)** - Privacy redirect

### TypeScript
- **[Meta Prompt Creator](typescript/meta_prompt_creator.tsx)** - Markdown-rendered prompt UI

---

## Getting Started

| Type | Setup |
|------|-------|
| **Batch** | Double-click `.bat` file. Some require [FFmpeg](https://ffmpeg.org/download.html). |
| **Python** | Install [Python 3.7+](https://www.python.org/downloads/), then `pip install` dependencies from each folder's README. |
| **Extensions** | Enable Developer mode in browser, click "Load unpacked", select extension folder. |
| **Userscripts** | Install [Violentmonkey](https://violentmonkey.github.io/), click Raw on any `.user.js` file. |
| **TypeScript** | Copy component into your React project. |

---

## Design Philosophy

- **Safety first** - Files moved to trash, never deleted directly
- **User-friendly** - Plain-language docs for non-technical users
- **Clear feedback** - Progress indicators and status messages
- **Graceful handling** - Skip errors rather than crash

---

## Contributing

See [CLAUDE.md](CLAUDE.md) for development guidelines and code conventions.
