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
| [dupefinder.py](python/Duplicate%20image%20detection/dupefinder.py) | Advanced duplicate and near-duplicate image detector using perceptual hashing and ORB feature matching with RANSAC. Detects exact duplicates, crops, resizes, rotations, and edits. Generates interactive HTML reports with thumbnails for review. Includes persistent SQLite cache for fast subsequent runs. Double-click friendly with interactive mode. | `opencv-python-headless`, `numpy`, `Pillow` |
| [delete_marked.py](python/Duplicate%20image%20detection/delete_marked.py) | Helper script for dupefinder reports. Reads `to_delete.json` file (created by marking images in the HTML report) and safely moves files to a `_trash` directory for review before permanent deletion. Double-click friendly. | Python 3.9+ |
| [folder_stats.py](python/media_stats/folder_stats.py) | Scans folders recursively and generates top 10 leaderboards by storage size and file count. Shows total size/count per subfolder including all descendants. Double-click friendly. | Python 3.9+ |
| [image_stats.py](python/media_stats/image_stats.py) | Recursively analyzes images in subfolders. Groups results by resolution (landscape/portrait) and file size buckets. Shows progress and generates summary statistics. | `Pillow` |
| [video_stats_v2.py](python/media_stats/video_stats_v2.py) | Recursively analyzes videos using ffprobe. Groups results by resolution (landscape/portrait) and duration buckets. Shows progress and handles corrupt files gracefully. | `ffprobe` (FFmpeg) |

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
pip install opencv-python-headless numpy Pillow
```

### External Tools

Some scripts require external tools to be installed:

- **FFmpeg**: Required for `any2mp3.bat` and `video_stats_v2.py`
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

Many scripts are **double-click friendly** and will prompt for input or use interactive mode when run without arguments:

- `dupefinder.py` - Interactive mode prompts for input/output directories
- `delete_marked.py` - Processes `to_delete.json` in current directory
- `folder_stats.py` - Analyzes the folder it's located in

Scripts can also be run with command-line arguments for automation:

```bash
python dupefinder.py INPUT_DIR --output OUTPUT_DIR
python folder_stats.py --path "X:/Media" --limit 10
```

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

## Featured Workflows

### Duplicate Image Detection

The duplicate image detection workflow uses advanced computer vision to find similar images:

1. **Run dupefinder.py** on your image directory:
   ```bash
   python dupefinder.py "D:\Photos" --output "D:\Photos\dupes_report"
   ```

2. **Review the HTML report**: Open the generated HTML file to see clusters of similar images with thumbnails

3. **Mark images for deletion**: Click images in the report to mark them (they'll be outlined in red). Click "Export deletion list" to save `to_delete.json`

4. **Run delete_marked.py**: Double-click or run in the same directory as `to_delete.json` to move marked files to `_trash`

5. **Review and confirm**: Check the `_trash` folder and permanently delete when satisfied

**Key Features:**
- Detects exact duplicates, crops, resizes, and rotated images
- Persistent cache makes subsequent runs extremely fast
- Safe two-step deletion process with manual review
- Interactive HTML reports with similarity scoring

## Contributing

This is a personal utility collection. Feel free to fork and adapt these scripts for your own use.

## License

These scripts are provided as-is for personal use.
