# Duplicate Image Finder

## What does it do?

This tool helps you find duplicate and similar images in your photo collection. Imagine you have thousands of photos and some are exact copies, some are edited versions, and some are cropped differently. This tool finds all of those!

It's really smart and can detect:
- Exact duplicates (same photo saved twice)
- Photos that have been resized (made bigger or smaller)
- Cropped versions (where someone cut out part of the image)
- Rotated copies (turned 90 degrees, flipped, etc.)
- Edited versions (brightness changed, filters applied, etc.)

The tool creates a visual report that shows you groups of similar images side-by-side, making it super easy to decide which ones to keep and which to delete.

**Important:** This tool is designed to be safe. It won't delete anything unless you specifically tell it to, and even then, files go to a trash folder first so you can review them.

## How to set up

### Step 1: Install Python

If you don't have Python installed:
1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and make sure to check "Add Python to PATH"

### Step 2: Install required packages

Open Command Prompt (search for "cmd" in Windows) and type:

```
pip install opencv-python-headless numpy pillow
```

This installs three helper tools that the script needs to analyze images.

## How to use it

### Finding duplicates:

**Easy way (just double-click):**
1. Double-click `dupefinder.py`
2. When asked, type the path to your photos folder (like `C:\Users\YourName\Pictures`)
3. Press Enter
4. When asked for output folder, type where you want the report saved
5. Wait while it scans your photos - you'll see progress updates

**Command line way:**
```
python dupefinder.py "C:\Users\YourName\Pictures" --output "C:\DuplicateReports"
```

### What happens next:

The script will:
1. Look through all your photos
2. Remember details about each one (it saves this info so next time is faster)
3. Compare photos to find similar ones
4. Create an HTML report file you can open in your web browser

### Reviewing the report:

1. Open the HTML file in your web browser (Chrome, Firefox, Edge, etc.)
2. You'll see groups of similar images
3. Click on images you want to delete - they'll get a red border
4. When you're done marking, click "Export deletion list" at the bottom
5. This creates a file called `to_delete.json`

### Deleting marked images:

**IMPORTANT:** Files aren't deleted yet! Follow these steps:

1. Make sure `to_delete.json` is in the same folder as `delete_marked.py`
2. Double-click `delete_marked.py`
3. Your marked files will be moved to a folder called `_trash`
4. Check the `_trash` folder to make sure you marked the right files
5. If everything looks good, you can permanently delete the `_trash` folder
6. If you made a mistake, just move files back out of `_trash`

## Tips and tricks

- **First run is slower:** The script needs to analyze each image. After that, it remembers what it learned, so future runs are much faster
- **Be careful with marking:** Always review the `_trash` folder before permanently deleting
- **Large collections:** If you have thousands of photos, the script might take a while the first time. That's normal!
- **Save your reports:** Keep the HTML report file - you can always go back and review it later
