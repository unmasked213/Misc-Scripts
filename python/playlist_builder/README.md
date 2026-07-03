# Playlist Generator

Create fixed `.m3u` playlists from media files in the folder where the script is run.

---

## What does it do?

Drop `playlist_generator.py` into a folder containing media files and run it. The script scans that folder and all subfolders for one selected media type, sorts the results, and writes one or more `.m3u` playlists in the same folder.

Existing output playlists from previous runs are overwritten. Stale playlist outputs from other modes are removed so the folder only keeps the playlists produced by the current run.

The playlists are plain-text `.m3u` files compatible with MPV, VLC, and most media players.

---

## Quick Start

1. Copy `playlist_generator.py` into the folder with your media files.
2. Double-click it or run it with Python.
3. Choose a file type: videos, images, or audio.
4. Choose a sort option.
5. Use the generated `.m3u` playlist file in MPV, VLC, or another compatible player.

---

## Output Files

Output filenames are fixed.

| File type | Output |
|-----------|--------|
| Videos with `ffprobe` | `Horz.m3u` and/or `Vert.m3u`, split by orientation |
| Videos without `ffprobe` | `Horz.m3u`, containing all matched videos |
| Images | `Images.m3u` |
| Audio | `Audio.m3u` |

For videos with `ffprobe`, landscape videos go into `Horz.m3u`, portrait videos go into `Vert.m3u`, and square videos go into both. Unreadable files or files without a video stream are skipped.

---

## Features

| Feature | Description |
|---------|-------------|
| **File types** | Videos, images, or audio |
| **Recursive scan** | Finds matching files in all subfolders |
| **Fixed outputs** | Writes predictable filenames and overwrites previous runs |
| **Stale cleanup** | Removes old playlist outputs not produced by the current run |
| **Sort options** | Name, size, date modified, duration, or quality |
| **ffprobe support** | Enables video orientation splitting plus duration and quality metadata |
| **Fallback behaviour** | Uses file size when `ffprobe` is unavailable for duration or quality sorting |
| **Interactive menus** | Console prompts with numbered choices |

---

## Sorting Options

| Sort | Order |
|------|-------|
| Name | A-Z |
| Size | Largest first |
| Date modified | Newest first |
| Duration | Longest first |
| Quality | Highest first |

Duration uses media duration from `ffprobe` when available. Quality uses bitrate per pixel with a codec-efficiency weighting. If the required metadata is unavailable, the script falls back to file size.

---

## ffprobe Behaviour

`ffprobe` is optional. It is part of FFmpeg.

When `ffprobe` is available, the script can:

- split videos by orientation;
- detect rotated video dimensions correctly;
- sort by real media duration;
- calculate quality using bitrate, resolution, and codec.

When `ffprobe` is not available:

- videos are not split by orientation;
- video output is written to `Horz.m3u`;
- duration and quality sorting fall back to file size;
- the script shows an `ffprobe not found` warning in the console.

---

## Requirements

- Python 3.7+
- `ffprobe` optional, from FFmpeg

No pip packages are required.

---

## Supported Formats

**Videos:** MP4, MKV, AVI, MOV, WMV, FLV, WebM, M4V, TS, VOB, MPG, MPEG, 3GP, OGV

**Images:** JPG, JPEG, PNG, GIF, BMP, TIFF, TIF, WebP, HEIC, HEIF, AVIF, JXL

**Audio:** MP3, FLAC, WAV, AAC, OGG, OPUS, M4A, WMA

---

## Notes

- The script only scans from the folder it is placed in.
- It does not create timestamped playlists.
- It does not provide an edit or re-sort mode for existing playlists.
- It does not have an “all media types” mode.
