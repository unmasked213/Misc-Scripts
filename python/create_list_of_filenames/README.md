# File List Generator

## What does it do?

This script creates a text file that lists all the files in a folder and its subfolders. Think of it like creating a table of contents for a book - it shows you everything that's inside, organized by folder.

The list includes:
- Every file's name
- Which folder it's in
- How many files are in each folder
- How much space each folder takes up

This is useful when you want to:
- See what files you have without opening folders one by one
- Keep a record of your files
- Share a list of files with someone
- Organize or catalog your collection

## How to set up

### You only need Python!

1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and check "Add Python to PATH"

That's it - no extra packages needed!

## How to use it

### The simple way:

1. Copy `list_files_by_folder.py` into the folder you want to scan
2. Double-click the file
3. Wait a moment while it scans
4. Look for a new file called `file_list.txt` - that's your list!

### What's in the list:

The text file has two parts:

**Part 1 - Summary:**
- Shows each folder
- Shows how many files are in each folder
- Shows how much disk space each folder uses
- Shows the grand total at the bottom

**Part 2 - Detailed list:**
- Lists every single file
- Organized by folder
- Indented to show the folder structure

### Example:

```
=== Summary ===
[Root] – 5 files, 2.50 MB
[Photos/Vacation] – 12 files, 15.80 MB
[Photos/Family] – 8 files, 10.20 MB

Total: 25 files, 28.50 MB

[Root]
document.pdf
readme.txt
...

  [Photos/Vacation]
  beach1.jpg
  beach2.jpg
  ...
```

## Things to know

- **Scans everything:** The script looks in all subfolders, no matter how deep
- **Size format:** File sizes are shown in KB, MB, or GB automatically
- **Hidden files skipped:** Files starting with a dot (like `.hidden`) are ignored
- **Always in the same folder:** The `file_list.txt` file appears right next to the script
- **Updates each time:** Running it again will replace the old list with a new one
- **Quick:** Even large folders with thousands of files scan pretty fast

## Tips

- **Moving the script:** You can copy this script to any folder you want to scan - just double-click it there
- **Sharing lists:** The text file is plain text, so anyone can open it
- **Before/after comparison:** Run it before organizing files, then run it again after to see what changed
- **Backup record:** Keep these lists as a record of what was on an external hard drive or USB stick
