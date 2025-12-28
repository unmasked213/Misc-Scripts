# Quick Start - Duplicate Image Finder

## One-Time Setup

### 1. Install Python
- Download from https://www.python.org/downloads/
- **Check "Add Python to PATH"** during installation

### 2. Install Packages
Double-click `install_dependencies.bat`

Or run: `pip install -r requirements.txt`

---

## Launch the App

**Double-click** `Launch Duplicate Finder Web.vbs`

Your browser opens automatically to http://localhost:5000

---

## The Workflow

### Step 1: Select Folder
Click the folder input area → Pick your photo folder

### Step 2: Scan
Click **"Start Scanning"** → Watch real-time progress

### Step 3: Review
- **Blue border** = Reference image (keep this one)
- **Click image** = Mark for deletion (turns red)
- **Click again** = Unmark

### Step 4: Delete
Click **"Delete Marked"** → Files move to `_dupes` folder

---

## Helper Buttons

| Button | Action |
|--------|--------|
| **Keep Largest** | Auto-marks smaller duplicates in current group |
| **Keep Largest (All 100%)** | Batch-mark all exact duplicates |
| **Clear Marks** | Unmark all in current group |
| **Undo** | Restore last deleted files |

---

## Safety Features

- Files go to `_dupes` folder first (not permanently deleted)
- You choose what to delete (nothing automatic)
- Reference image clearly marked (blue border)
- Undo available for accidental deletions
- Server auto-closes when you close the browser tab

---

## Tips

- **Quick Mode** - Faster scanning (good for exact duplicates)
- **Lower threshold** - Finds more matches (may include false positives)
- **First scan slower** - Subsequent scans use cached fingerprints
- **Theme toggle** - Click moon/sun icon for light/dark mode

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Python not recognized" | Reinstall Python with "Add Python to PATH" |
| "No module named..." | Run `pip install -r requirements.txt` |
| Browser doesn't open | Go to http://localhost:5000 manually |
| No duplicates found | Check folder has images; try lower threshold |

---

For full documentation, see [README.md](README.md)
