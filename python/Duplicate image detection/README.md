# Duplicate Image Finder

## What does it do?

This tool helps you find duplicate and similar images in your photo collection. Imagine you have thousands of photos and some are exact copies, some are edited versions, and some are cropped differently. This tool finds all of those!

It's really smart and can detect:
- Exact duplicates (same photo saved twice)
- Photos that have been resized (made bigger or smaller)
- Cropped versions (where someone cut out part of the image)
- Rotated copies (turned 90 degrees, flipped, etc.)
- Edited versions (brightness changed, filters applied, etc.)

**NEW:** Now with a beautiful, easy-to-use graphical interface! No command line needed - just double-click and go.

The tool shows you groups of similar images side-by-side with thumbnails, making it super easy to decide which ones to keep and which to delete.

**Important:** This tool is designed to be safe. It won't delete anything unless you specifically tell it to, and even then, files go to a `_dupes` folder first so you can review them.

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

### The Easy Way (Graphical Interface - RECOMMENDED):

1. **Double-click** `Launch Duplicate Finder.bat` (or run `python dupefinder_gui.py`)
2. Click **"Browse..."** and select the folder containing your photos
3. Click **"Start Scanning"** and wait while the tool analyzes your images
4. **Review the results** - you'll see groups of similar images with thumbnails
   - The blue border shows the reference image (usually the best quality)
   - Click any image to mark it for deletion (it will get a red border)
   - Click again to unmark it
5. Use the **helper buttons**:
   - "Keep Largest" - automatically marks smaller duplicates for deletion in the current group
   - "Clear All Selections" - unmarks everything in the current group
   - Navigation buttons to browse through different duplicate groups
6. When ready, click **"Delete Selected Files"**
7. Files are safely moved to `_dupes` folder - review them before permanently deleting

**That's it!** The entire process happens in one window with no need to switch between programs or run multiple scripts.

### The Advanced Way (Command Line):

If you prefer the command line or need more control:

**Finding duplicates:**
```
python dupefinder.py "C:\Users\YourName\Pictures" --output "C:\DuplicateReports"
```

**Reviewing via HTML report:**
1. Open the generated HTML file in your web browser
2. Click images to mark for deletion
3. Export the deletion list

**Deleting marked images:**
```
python delete_marked.py
```

## Tips and tricks

- **First run is slower:** The script needs to analyze each image. After that, it remembers what it learned, so future runs are much faster
- **Quick mode:** Check the "Quick mode" option for faster scanning (less thorough but good for finding exact duplicates)
- **Use "Keep Largest":** This button automatically keeps the highest quality version and marks smaller duplicates
- **Navigate with keyboard:** Use arrow keys or scroll through duplicate groups easily
- **Review before deleting:** Always check the `_dupes` folder before permanently deleting - you can move files back if needed
- **Large collections:** If you have thousands of photos, the script might take a while the first time. That's normal!
- **The blue border:** Shows the reference image (highest quality) that the tool thinks you should keep
- **Similarity percentage:** Each image shows how similar it is to the reference (100% = identical)
