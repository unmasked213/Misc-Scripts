# Duplicate Image Finder

Find and manage duplicate or similar images in your photo collection with a modern web interface.

---

## What does it do?

This tool scans a folder and finds images that are:
- **Exact duplicates** - Same photo saved multiple times
- **Resized versions** - Same photo at different sizes
- **Cropped versions** - Part of the original photo
- **Rotated/flipped copies** - Turned 90 degrees, mirrored, etc.
- **Edited versions** - Brightness changed, filters applied, etc.

The tool uses perceptual hashing (pHash) and geometric matching to detect similarities that simple file comparison would miss.

**Safety first:** Files are moved to a `_dupes` folder for review - nothing is permanently deleted without your explicit action.

---

## Quick Start

### 1. Install Python

If you don't have Python installed:
1. Download from https://www.python.org/downloads/
2. **Check "Add Python to PATH"** during installation
3. Restart any open terminals

### 2. Install Dependencies

**Option A:** Double-click `install_dependencies.bat`

**Option B:** Run manually:
```
pip install -r requirements.txt
```

Or install packages directly:
```
pip install opencv-python-headless numpy pillow flask flask-cors
```

### 3. Launch the App

**Option A (Recommended):** Double-click `Launch Duplicate Finder Web.vbs`
- Starts the server in the background (no console window)
- Opens your browser automatically

**Option B:** Run from command line:
```
python server.py
```
Then open http://localhost:5000 in your browser.

---

## How to Use

### Step 1: Select a Folder
- Click the folder input area
- A native folder picker dialog opens
- Select the folder containing images to scan

### Step 2: Configure (Optional)
- **Similarity threshold** (default 85%) - Lower = more matches, higher = stricter
- **Quick mode** - Faster scanning, uses pHash only (skips geometric verification)

### Step 3: Start Scanning
- Click **"Start Scanning"**
- Watch real-time progress as images are analyzed
- First scan is slower; subsequent scans use cached fingerprints

### Step 4: Review Results
- Images are grouped by similarity
- **Blue border** = Reference image (best quality, recommended to keep)
- **Similarity %** shown on each image
- Click any image to mark it for deletion (turns red)
- Click again to unmark

### Step 5: Use Helper Buttons
| Button | Action |
|--------|--------|
| **Keep Largest** | Mark smaller files in current group for deletion |
| **Keep Largest (All 100%)** | Batch-mark all exact duplicates across all groups |
| **Clear Marks** | Unmark all in current group |
| **Prev / Next** | Navigate between duplicate groups |

### Step 6: Delete Marked Files
- Click **"Delete Marked"**
- Files are moved to `_dupes` folder (not permanently deleted)
- Use **Undo** if you made a mistake

---

## Features

### Web Interface
- **Light/dark theme** - Toggle with the moon/sun icon
- **Responsive design** - Works on various screen sizes
- **Keyboard navigation** - Tab through elements, arrow keys for groups
- **Real-time progress** - Server-Sent Events (SSE) for live updates

### Detection Engine
- **Perceptual hashing** (8x8 pHash) for fast similarity detection
- **ORB feature matching** with RANSAC for geometric verification
- **Multiple rotation handling** - Detects rotated/flipped copies
- **Configurable thresholds** for duplicate vs. variant classification

### Safety
- Files moved to `_dupes` folder, never deleted directly
- Undo functionality for accidental deletions
- Reference image clearly marked (blue border)
- Confirmation required before deletion

### Performance
- **SQLite fingerprint cache** - Speeds up repeat scans
- **Quick mode** - Skip expensive geometric verification
- **Auto-shutdown** - Server closes when browser tab is closed

---

## Files

| File | Purpose |
|------|---------|
| `server.py` | Flask web server with REST API |
| `dupefinder.py` | Core detection engine (pHash + ORB matching) |
| `index.html` | Web UI (single-page app) |
| `requirements.txt` | Python dependencies |
| `install_dependencies.bat` | One-click dependency installer |
| `Launch Duplicate Finder Web.vbs` | Windowless launcher (no console) |

---

## Command Line Usage

The detection engine can also be used standalone:

```
python dupefinder.py "C:\Photos" --output "C:\Reports"
```

This generates:
- JSON report with all pairwise decisions
- CSV file of duplicate pairs
- HTML report with thumbnails for review

Run `python dupefinder.py --help` for all options.

---

## Tips

- **First scan is slower** - The tool analyzes each image and caches fingerprints for future scans
- **Quick mode** - Use for finding exact duplicates quickly; disable for finding edited/cropped versions
- **Lower threshold** - Finds more matches but may include false positives
- **Keep Largest** - Quick way to keep highest quality versions
- **Check _dupes folder** - Review before permanently deleting

---

## Troubleshooting

**"Python is not recognized"**
- Reinstall Python with "Add Python to PATH" checked

**"No module named cv2" / "No module named flask"**
- Run `pip install -r requirements.txt`

**Browser doesn't open automatically**
- Manually go to http://localhost:5000

**Server won't start (port in use)**
- Close other instances or change port in server.py

**No duplicates found**
- Ensure folder contains supported image files (JPG, PNG, WEBP, HEIC, etc.)
- Try lowering the similarity threshold

---

## Supported Formats

JPG, JPEG, PNG, WEBP, HEIC, AVIF, TIFF, BMP, GIF

---

## Requirements

- Python 3.9+
- opencv-python-headless >= 4.5.0
- numpy >= 1.19.0
- pillow >= 8.0.0
- flask >= 2.0.0
- flask-cors >= 3.0.0
