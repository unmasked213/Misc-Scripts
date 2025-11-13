# Audio to MP3 Converter

## What does it do?

This script converts your audio files to MP3 format. Think of it like converting a book from one language to another - the story stays the same, but it's now in a format that more devices can understand. MP3 is one of the most widely supported audio formats.

The converter handles these audio types:
- M4A files (often from Apple devices)
- OPUS files (common in online recordings)

Your original files stay safe - they won't be deleted. If you already have an MP3 version of a file, the script is smart enough to skip it so you don't waste time converting the same file twice.

## How to set up

### Step 1: Install FFmpeg

FFmpeg is a free tool that does the actual audio conversion. You need to download and install it:

1. Go to https://ffmpeg.org/download.html
2. Download the version for Windows
3. Follow the installation instructions
4. Make sure FFmpeg is added to your "PATH" (the installer usually has an option for this)

To check if FFmpeg is ready:
1. Open Command Prompt (search for "cmd" in Windows)
2. Type `ffmpeg -version` and press Enter
3. If you see version information, you're all set!

### Step 2: No additional setup needed!

Once FFmpeg is installed, the converter is ready to use.

## How to use it

### The simple way:

1. Copy the `any2mp3.bat` file into the folder where your audio files are
2. Double-click the `any2mp3.bat` file
3. Watch as it converts your files - you'll see progress messages
4. When it's done, press any key to close the window

### What you'll see:

The script will show you messages like:
- `[CONVERT]` - Currently converting this file
- `[OK]` - Successfully converted
- `[SKIP]` - Already have an MP3 version, skipping
- `[FAIL]` - Something went wrong with this file

At the end, you'll see a summary showing how many files were converted, skipped, or failed.

### Things to know:

- The converted MP3 files will appear in the same folder
- Original files stay exactly where they are
- The MP3 files are created at high quality (320 kbps - the best standard MP3 quality)
- If you run the script again, it won't re-convert files that already have MP3 versions
