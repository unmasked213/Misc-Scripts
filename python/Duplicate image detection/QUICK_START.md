# Quick Start Guide - Duplicate Image Finder

## Installation (One-Time Setup)

1. **Install Python** (if not already installed)
   - Download from https://www.python.org/downloads/
   - During installation, check "Add Python to PATH"

2. **Install Required Packages**
   - Open Command Prompt (search for "cmd" in Windows)
   - Type: `pip install opencv-python-headless numpy pillow`
   - Press Enter and wait for installation to complete

## Using the App (Every Time)

### Method 1: Double-Click (Easiest)
1. Double-click `Launch Duplicate Finder.bat`
2. The app window will open

### Method 2: Direct Launch
1. Double-click `dupefinder_gui.py`
2. The app window will open

## The Workflow (4 Simple Steps)

### Step 1: Select Your Folder
- Click the **"Browse..."** button
- Choose the folder with photos you want to scan
- Click **"Start Scanning"**

### Step 2: Wait for Scanning
- The app will show progress as it works
- First time is slower, future scans are faster
- You'll see status updates as it processes

### Step 3: Review Duplicates
- You'll see groups of similar images
- **Blue border** = reference image (keep this one)
- **Click any image** to mark it for deletion (turns red)
- **Click again** to unmark it

**Helper Buttons:**
- **← Previous / Next →** - Navigate between duplicate groups
- **Keep Largest** - Auto-select smaller duplicates (keeps largest)
- **Clear All Selections** - Unmark everything in current group

### Step 4: Delete Marked Files
- Click **"Delete Selected Files"**
- Confirm you want to proceed
- Files move to `_dupes` folder (not permanently deleted!)
- Review `_dupes` folder before permanently deleting

## Safety Features

✅ **Files go to _dupes folder first** - not deleted immediately
✅ **You choose what to delete** - nothing automatic
✅ **Reference image marked** - shows best quality version
✅ **Undo by moving back** - files can be recovered from `_dupes`
✅ **Confirmation required** - no accidental deletions

## Pro Tips

💡 **Quick Mode** - Enable for faster scanning (slightly less thorough)
💡 **Keep Largest** - Quick way to keep highest quality versions
💡 **First run slower** - The app learns your images and speeds up next time
💡 **Review _dupes folder** - Always check `_dupes` folder before permanent deletion
💡 **Blue = Keep** - The blue-bordered image is usually the best one to keep

## Common Issues

**"Python is not recognized"**
- Reinstall Python with "Add Python to PATH" checked

**"No module named cv2"**
- Run: `pip install opencv-python-headless numpy pillow`

**Window closes immediately**
- Right-click `dupefinder_gui.py` → "Edit with IDLE" → Run from there
- Or run from Command Prompt: `python dupefinder_gui.py`

**No duplicates found**
- Make sure the folder contains image files (JPG, PNG, etc.)
- Try scanning a parent folder with more images

## Support

For detailed information, see the main README.md file.

For bugs or feature requests, create an issue at the project repository.

---

**Made with ❤️ to help you organize your photo collection**
