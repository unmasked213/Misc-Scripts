# Media Downloader Extension

A Chrome/Brave browser extension for batch downloading images and videos from multiple browser tabs with intelligent duplicate detection and HLS stream support.

---

## Features

| Feature | Description |
|---------|-------------|
| **Batch Downloads** | Download media from all selected tabs at once |
| **Image + Video Support** | Toggle between Images and Videos mode |
| **HLS Stream Capture** | Download HLS (.m3u8) streaming videos |
| **Popup UI** | Clean interface with progress tracking and controls |
| **Perceptual Hashing** | Detects duplicate images even if renamed or resized |
| **URL Deduplication** | Skips previously downloaded URLs |
| **Smart Detection** | Finds the best quality version of media on pages |
| **Video Interception** | Captures video URLs from fetch/XHR and play events |
| **Network Monitoring** | Passive capture of video requests via webRequest API |
| **Keyboard Shortcuts** | Quick download without opening the popup |
| **Pause/Resume/Cancel** | Full control over batch downloads |
| **Tab Management** | Optionally close tabs after downloading |
| **Filename Prefix** | Add custom prefix to downloaded files |

---

## Installation

### Chrome / Brave / Edge

1. Download or clone this repository
2. Open your browser and navigate to:
   - Chrome: `chrome://extensions/`
   - Brave: `brave://extensions/`
   - Edge: `edge://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `media-downloader-extension` folder

---

## Usage

### Popup UI

Click the extension icon in your browser toolbar to open the popup:

| Control | Description |
|---------|-------------|
| **Images / Videos toggle** | Switch between image and video download mode |
| **Download button** | Downloads from all highlighted tabs (Images) or opens video list (Videos) |
| **Auto-close tabs** | Toggle auto-closing tabs after download |
| **Skip dupes** | Toggle duplicate detection |
| **Interval (sec)** | Delay between downloads (prevents rate limiting) |
| **Filename prefix** | Optional prefix for downloaded filenames |
| **Pause/Resume** | Control ongoing batch downloads |
| **Cancel** | Stop the current batch operation |

### Video Mode

When in Videos mode, clicking the download button opens a video selection modal:

| Badge | Meaning |
|-------|---------|
| **DOM** | Video found in page HTML |
| **HLS** | Streaming video (m3u8 manifest detected) |
| **NET** | Video captured from network traffic |
| **Check mark** | Detected from video playback event |
| **Playing indicator** | Video currently playing |

Select videos from the list and click Download. HLS streams are automatically assembled from segments.

### Selecting Multiple Tabs

| Action | How To |
|--------|--------|
| Single tab | Click on a tab |
| Add individual tabs | Ctrl+click on each tab |
| Select range | Click first tab, Shift+click last tab |
| Select all tabs | Ctrl+A in tab bar |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+S` | Download from all selected tabs |
| `Alt+Shift+D` | Download from current tab only |

Customize shortcuts at:
- Chrome: `chrome://extensions/shortcuts`
- Brave: `brave://extensions/shortcuts`

---

## Configuration

Edit `background.js` to modify default settings:

```javascript
const Config = {
    closeTabAfterDownload: true,      // Default close behavior
    useTimestampInFilename: true,     // Prefix filenames with YYMMDDHHMMSS

    deduplication: {
        enabled: true,                 // Track downloaded media
        timeframeDays: 30,             // How long to remember downloads
        ignoreQueryParams: true,       // Treat URLs with different params as same
        perceptualHash: {
            enabled: true,             // Content-based duplicate detection (images)
            hammingThreshold: 5        // Similarity threshold (0-64, lower = stricter)
        }
    },

    closeDelayMs: 500                  // Delay before closing tab (ms)
};
```

---

## How It Works

### Architecture

The extension uses a multi-layer detection approach:

| Component | File | Purpose |
|-----------|------|---------|
| **Service Worker** | `background.js` | Coordinates downloads, manages state, handles HLS parsing |
| **Popup** | `popup.html/js` | User interface for options and progress |
| **Interceptor** | `intercept.js` | Runs in MAIN world to hook fetch/XHR and watch video events |
| **Bridge** | `bridge.js` | Runs in ISOLATED world to relay detections to service worker |
| **Offscreen** | `offscreen.html` | Handles blob assembly for HLS downloads |

### Image Detection

1. **Direct images** - If the tab URL is an image, downloads directly
2. **Gallery overlays** - Detects common lightbox/gallery plugins
3. **Largest visible image** - Falls back to the biggest visible `<img>` element
4. **srcset parsing** - Extracts highest resolution from responsive images
5. **Data attributes** - Checks `data-src`, `data-original`, etc.
6. **Background images** - Extracts CSS background-image URLs

### Video Detection

1. **DOM scanning** - Finds `<video>` elements and their sources
2. **Play event capture** - Watches for video playback events
3. **Fetch/XHR interception** - Captures video URLs from network requests
4. **Network monitoring** - Uses webRequest API to passively capture video traffic
5. **Stream detection** - Identifies HLS (.m3u8) and DASH (.mpd) manifests

### HLS Stream Download

1. **Manifest parsing** - Parses master and media playlists
2. **Quality selection** - Automatically selects highest quality variant
3. **Segment download** - Fetches all segments sequentially with page cookies
4. **Assembly** - Concatenates segments into a single .ts file
5. **DRM detection** - Reports protected content as unsupported

### Duplicate Detection (Images)

| Stage | Method | Catches |
|-------|--------|---------|
| **URL** | Normalized URL comparison | Same image at same URL |
| **Content** | Perceptual hash (aHash) | Renamed/resized copies |

The perceptual hash algorithm:
1. Scales image to 32x32 pixels
2. Converts to grayscale
3. Compares each pixel to average brightness
4. Generates 64-bit fingerprint
5. Matches if Hamming distance is below threshold

---

## Supported Formats

### Images

| Format | Extension | Detection |
|--------|-----------|-----------|
| JPEG | `.jpg` | Magic bytes `FF D8` |
| PNG | `.png` | Magic bytes `89 50 4E 47` |
| GIF | `.gif` | Magic bytes `47 49 46 38` |
| WebP | `.webp` | RIFF container with WEBP |
| AVIF | `.avif` | ftyp box with avif |
| SVG | `.svg` | XML/svg tag detection |
| BMP | `.bmp` | Magic bytes `42 4D` |

### Videos

| Format | Extension | Detection |
|--------|-----------|-----------|
| MP4 | `.mp4` | ftyp box |
| WebM | `.webm` | Matroska signature |
| MOV | `.mov` | ftyp qt box |
| AVI | `.avi` | RIFF/AVI signature |
| OGV | `.ogv` | OggS signature |
| HLS | `.m3u8` | Manifest parsing |

---

## Permissions

| Permission | Why |
|------------|-----|
| `tabs` | Query selected tabs |
| `downloads` | Save media to disk |
| `storage` | Persist download history and settings |
| `activeTab` | Access current tab |
| `scripting` | Inject detection scripts |
| `webRequest` | Passively monitor video network requests |
| `offscreen` | Assemble HLS segments outside service worker |
| `<all_urls>` | Fetch media from any site |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not loading | Ensure Developer mode is enabled |
| No image found | Page may use non-standard image loading |
| No video found | Play the video first, then scan again |
| HLS download fails | Stream may be DRM protected or require authentication |
| Duplicate not detected | Hash threshold may need adjustment |
| Downloads failing | Check browser download permissions |
| Shortcuts not working | Check for conflicts at `chrome://extensions/shortcuts` |
| Videos show as "Stream" | HLS/DASH streams are detected but may need the video to play first |

---

## Privacy

- All processing happens locally in your browser
- Download history stored in `chrome.storage.local`
- No data sent to external servers
- No analytics or tracking
- Network monitoring is passive (read-only, no modification)

---

## Current Status

The extension is under active development. Current capabilities:

| Feature | Status |
|---------|--------|
| Image batch download | Complete |
| Image perceptual hashing | Complete |
| Direct video download (MP4, WebM) | Complete |
| Video detection from DOM | Complete |
| Video detection from network | Complete |
| HLS stream download | Complete |
| DASH stream download | Not yet implemented |
| DRM protected content | Detected but not supported |

See `media-downloader-roadmap.md` for the full development plan.

---

## Version History

| Version | Changes |
|---------|---------|
| 1.3 | HLS stream download support, offscreen document for segment assembly |
| 1.2 | Video mode with DOM scanning, network interception, fetch/XHR hooks |
| 1.1 | Added filename prefix option, popup UI improvements |
| 1.0 | Initial release with batch image downloads and perceptual hashing |
