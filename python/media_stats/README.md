# Media Statistics Tools

This folder contains three tools that help you understand your media collection - photos, videos, and general files. Think of them as your collection's report card, showing you what you have and how it's organized.

## The Tools

### 1. Folder Stats (`folder_stats.py`)

**What it does:**
Shows you which folders are taking up the most space and which have the most files. It's like seeing a leaderboard of your biggest folders.

**Best for:**
- Finding out where all your disk space went
- Discovering which folders have the most files
- Planning what to back up or clean up

### 2. Image Stats (`image_stats.py`)

**What it does:**
Analyzes all your images and groups them by quality (480p, 720p, 1080p, 4K, etc.) and file size. Perfect for understanding your photo collection.

**Best for:**
- Seeing how many high-resolution photos you have
- Finding out the typical size of your images
- Understanding your collection before organizing it

### 3. Video Stats (`video_stats.py`)

**What it does:**
Analyzes all your videos, showing you their quality, length, codec, HDR/SDR status, and file sizes. Like a comprehensive report on your video library.

**Best for:**
- Finding out how many HD or 4K videos you have
- Seeing how long your videos typically are
- Understanding storage needs for videos

---

## How to set up

### All three tools need Python

1. Go to https://www.python.org/downloads/
2. Download Python 3.9 or newer
3. Run the installer and check "Add Python to PATH"

### Extra requirements for each tool:

**For image_stats.py:**
```
pip install pillow
```

**For video_stats.py:**
You need FFmpeg installed:
1. Go to https://ffmpeg.org/download.html
2. Download and install for Windows
3. Make sure it's added to your system PATH

**For folder_stats.py:**
No extra packages needed!

**Optional (for even faster scanning on very large folders):**
```
pip install cython
cd python/media_stats
python setup_scanner.py build_ext --inplace
```
This builds an optional speed extension that can make scans 10-40x faster on huge folder trees.

---

## How to use each tool

### Folder Stats

**Easy way:**
1. Copy `folder_stats.py` into the folder you want to analyze
2. Double-click it
3. Enter how many results you want to see (or press Enter for default 10)
4. Read the comprehensive report

**Advanced way (command line):**
```
python folder_stats.py --path "C:\Users\YourName\Documents" --limit 10
```

**What you'll see:**
- **Top folders by storage:** Which folders use the most disk space
- **Top folders by file count:** Which folders have the most files
- **Color-coded file counts:** Folders with unusually large average file sizes are highlighted in orange or red
- **Top largest files:** Biggest individual files across the entire tree
- Sizes shown in KB, MB, GB, or TB automatically

**Performance note:**
- This tool uses multiprocessing to scan folders in parallel
- Automatically utilizes all your CPU cores for faster scanning
- Optimized for large folder trees with millions of files

### Image Stats

**Easy way:**
1. Copy `image_stats.py` into your photos folder
2. Double-click it
3. Wait while it scans (you'll see progress)
4. Read the summary at the end

**What you'll see:**
- **Resolution breakdown:** How many 720p, 1080p, 4K images you have
- **File format breakdown:** Distribution of JPG, PNG, WebP, and other formats
- **Size breakdown:** How many images in each file size range
- **Portrait vs Landscape:** Separate counts for vertical and horizontal photos
- Uses multiprocessing for faster scanning of large collections
- A list of any files that couldn't be read

### Video Stats

**Easy way:**
1. Copy `video_stats.py` into your videos folder
2. Double-click it
3. Wait while it analyzes (faster with multiprocessing!)
4. Read the comprehensive summary at the end

**What you'll see:**
- **Resolution breakdown:** How many 480p, 720p, 1080p, 4K videos (with portrait/landscape)
- **Codec breakdown:** Distribution of H264, H265, VP9, and other codecs
- **HDR/SDR status:** How many SDR, HDR10, HLG, or Dolby Vision videos
- **Framerate breakdown:** 24fps, 30fps, 60fps distribution
- **Duration breakdown:** How many short, medium, and long videos
- **File size breakdown:** Videos grouped by size ranges
- **Bitrate analysis:** Median bitrate for each resolution category
- Uses multiprocessing for parallel analysis of multiple videos
- Skips corrupt or unreadable files automatically

---

## Understanding the results

### Resolution categories:
- **480p** - Standard definition (older videos/photos)
- **720p** - HD (high definition)
- **1080p** - Full HD (very common)
- **1440p** - 2K (high quality)
- **4K** - Ultra HD (very high quality)
- **8K** - Extreme quality (rare)
- **Vertical versions** - Same but rotated (like phone videos/photos)

### File size categories:

Images:
- Small: Under 500 KB
- Medium: 500 KB to 5 MB
- Large: 5 MB to 50 MB
- Very large: Over 50 MB

Videos:
- Small: Under 50 MB
- Medium: 50 MB to 500 MB
- Large: 500 MB to 5 GB
- Very large: Over 5 GB

---

## Tips and tricks

**Starting point:**
- Run folder_stats first to find your biggest folders
- Then run image_stats or video_stats on those folders
- This helps you focus on what matters most

**Progress tracking:**
- All tools show progress as they work
- Large collections take longer - be patient!
- You can close the tools by pressing Ctrl+C if needed

**Safety:**
- These tools only READ your files - they never change or delete anything
- It's completely safe to run them on any folder
- If a file can't be read, it's just skipped

**Organization help:**
- Use these reports before organizing your collection
- They help you decide what to keep, what to compress, and what to delete
- Run them again after organizing to see the difference!
