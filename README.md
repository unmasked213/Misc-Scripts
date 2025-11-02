# Misc-Scripts

A collection of utility scripts for Windows automation, media processing, and system management. This repository contains both batch scripts and Python utilities designed to simplify common tasks.

## Scripts Overview

### Batch Scripts

| Script | Purpose | Requirements |
|--------|---------|--------------|
| [clean_ghosts.bat](batch/clean_ghosts.bat) | Kills duplicate AI assistant and browser processes. Keeps one instance of Claude, ChatGPT, and Cursor while removing duplicates. Also terminates Brave browser, Electron zombies, and LGHub ghosts. | Windows (tasklist/taskkill) |
| [any2mp3.bat](batch/mp3%20converter/any2mp3.bat) | Converts .m4a and .opus audio files to .mp3 format at 320 kbps CBR. Leaves original files untouched and skips files that already have an .mp3 version. | FFmpeg in PATH |

### Python Scripts

#### Window & Application Management

| Script | Purpose | Requirements |
|--------|---------|--------------|
| [ha_dashboard_launcher.py](python/ha_dashboard_launcher/ha_dashboard_launcher.py) | Launches a frameless Home Assistant dashboard in a webview window on the 3rd monitor (or primary if unavailable). Auto-refreshes every 5 minutes and includes a draggable top bar. | `pywebview`, `screeninfo` |
| [minimize_windows.py](python/minimize_windows/minimize_windows.py) | Selectively minimizes windows based on configurable criteria. Targets media viewers, image files, browser windows (with whitelist support), and File Explorer windows. | `pygetwindow`, `pywin32` |
| [mimic_keystrokes.py](python/Mimic%20keystrokes%20%28auto%20typing%29/mimic_keystrokes.py) | Simulates realistic human typing from a text file. Includes variable typing speed, natural pauses, and window focus detection. | `keyboard`, `pyautogui`, `pywin32` |

#### Media Analysis

| Script | Purpose | Requirements |
|--------|---------|--------------|
| [find_duplicates.py](python/Duplicate%20image%20detection/find_duplicates.py) | Finds duplicate or similar images in a folder and generates an HTML report. Features fast mode (perceptual hashing) and thorough mode (FFmpeg-based). Extracts EXIF data and organizes groups by size and similarity. | `Pillow`, `imagehash`, FFmpeg (for thorough mode) |
| [image_stats.py](python/media_stats/image_stats.py) | Recursively analyzes images in subfolders. Groups results by resolution (landscape/portrait) and file size buckets. Shows progress and generates summary statistics. | `Pillow` |
| [video_stats.py](python/media_stats/video_stats.py) | Recursively analyzes videos using ffprobe. Groups results by resolution (landscape/portrait) and duration buckets. Shows progress and handles corrupt files gracefully. | `ffprobe` (FFmpeg) |
| [video_stats_v2.py](python/media_stats/video_stats_v2.py) | Enhanced version of video_stats.py with additional features and improved analysis. | `ffprobe` (FFmpeg) |

#### File Management

| Script | Purpose | Requirements |
|--------|---------|--------------|
| [list_files_by_folder.py](python/create_list_of_filenames/list_files_by_folder.py) | Creates a comprehensive text file listing all files in subdirectories with size information. Generates organized output with formatted file sizes. | Python 3.9+ |

## Installation

### Python Scripts

Most Python scripts require external packages. Install them using pip:

```bash
# Window management scripts
pip install pywebview screeninfo
pip install pygetwindow pywin32
pip install keyboard pyautogui

# Media analysis scripts
pip install Pillow imagehash
```

### External Tools

Some scripts require external tools to be installed:

- **FFmpeg**: Required for `any2mp3.bat`, `find_duplicates.py` (thorough mode), `video_stats.py`, and `video_stats_v2.py`
  - Download from: https://ffmpeg.org/download.html
  - Ensure it's added to your system PATH

## Usage

### Batch Scripts

Simply double-click the `.bat` file to run it, or execute from the command line:

```cmd
cd batch
clean_ghosts.bat
```

### Python Scripts

Run Python scripts from the command line:

```bash
cd python/script_folder
python script_name.py
```

Some scripts (like `find_duplicates.py`) should be placed in the target folder before running.

## Project Structure

```
Misc-Scripts/
├── batch/
│   ├── clean_ghosts.bat
│   └── mp3 converter/
│       └── any2mp3.bat
└── python/
    ├── Duplicate image detection/
    ├── ha_dashboard_launcher/
    ├── media_stats/
    ├── Mimic keystrokes (auto typing)/
    ├── minimize_windows/
    └── create_list_of_filenames/
```

## Contributing

This is a personal utility collection. Feel free to fork and adapt these scripts for your own use.

## License

These scripts are provided as-is for personal use.
