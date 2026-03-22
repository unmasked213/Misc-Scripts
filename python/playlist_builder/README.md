# Playlist Builder

Create .m3u playlists from media files in any folder with flexible sorting options.

---

## What does it do?

Drop this script into a folder containing media files and run it. It scans the folder (and subfolders) for videos, images, or audio files and creates a plain-text .m3u playlist compatible with MPV, VLC, and most media players.

If a playlist already exists, you can refresh its contents or re-sort it without starting from scratch.

---

## Quick Start

1. Copy `playlist_generator.py` into the folder with your media files
2. Double-click to run
3. Choose what to include (videos, images, audio, or all)
4. Pick a sort order (or none)
5. A `.m3u` file is saved in the same folder

Drag the playlist file onto MPV or VLC to play.

---

## Features

| Feature | Description |
|---------|-------------|
| **File types** | Videos, images, audio, or all combined |
| **Sort options** | Name, size, date, duration, bitrate |
| **ffprobe support** | Uses actual media metadata for duration/bitrate sorting (optional) |
| **Edit existing** | Detects previous playlists and offers rescan or re-sort |
| **Recursive scan** | Finds files in all subfolders |
| **Interactive menus** | Clear prompts with numbered choices |

---

## Sorting Options

| Sort | Ascending | Descending |
|------|-----------|------------|
| Name | A-Z | Z-A |
| Size | Smallest first | Largest first |
| Date | Oldest first | Newest first |
| Duration | Shortest first | Longest first |
| Bitrate | Lowest first | Highest first |

Duration and bitrate sorting use ffprobe for accurate metadata. If ffprobe isn't available, file size is used as a fallback.

---

## Requirements

- **Python 3.7+**
- **ffprobe** (optional) - Part of [FFmpeg](https://ffmpeg.org/download.html). Enables accurate duration and bitrate sorting.

No pip packages required.

---

## Supported Formats

**Videos:** MP4, MKV, AVI, MOV, WMV, FLV, WebM, M4V, TS, VOB, MPG, MPEG, 3GP, OGV

**Images:** JPG, JPEG, PNG, GIF, BMP, TIFF, WebP, HEIC, HEIF, AVIF, JXL

**Audio:** MP3, FLAC, WAV, AAC, OGG, OPUS, M4A, WMA

---

## Tips

- **No ffprobe?** Duration and bitrate sorting will fall back to file size. The script tells you at the end if ffprobe wasn't available.
- **Multiple playlists** - Each new playlist gets a timestamped filename, so you can keep several versions.
- **Edit mode** - When existing playlists are found, you can rescan (update file list) or just re-sort without rescanning.
