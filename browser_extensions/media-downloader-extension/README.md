# Media Downloader Extension

A Chrome/Brave browser extension for batch downloading images from multiple browser tabs with intelligent duplicate detection.

---

## Features

| Feature | Description |
|---------|-------------|
| **Batch Downloads** | Download images from all selected tabs at once |
| **Popup UI** | Clean interface with progress tracking and controls |
| **Perceptual Hashing** | Detects duplicate images even if renamed or resized |
| **URL Deduplication** | Skips previously downloaded URLs |
| **Smart Image Detection** | Finds the best quality version of images on pages |
| **Keyboard Shortcuts** | Quick download without opening the popup |
| **Pause/Resume** | Control batch downloads mid-operation |
| **Tab Management** | Optionally close tabs after downloading |

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
| **Download N images** | Downloads from all highlighted tabs |
| **Close tabs after download** | Toggle auto-closing tabs after download |
| **Skip duplicates** | Toggle duplicate detection |
| **Interval (ms)** | Delay between downloads (prevents rate limiting) |
| **Filename prefix** | Optional prefix for downloaded filenames |
| **Pause/Resume** | Control ongoing batch downloads |
| **Cancel** | Stop the current batch operation |

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
        enabled: true,                 // Track downloaded images
        timeframeDays: 30,             // How long to remember downloads
        ignoreQueryParams: true,       // Treat URLs with different params as same
        perceptualHash: {
            enabled: true,             // Content-based duplicate detection
            hammingThreshold: 5        // Similarity threshold (0-64, lower = stricter)
        }
    },

    closeDelayMs: 500                  // Delay before closing tab (ms)
};
```

---

## How It Works

### Image Detection

The extension injects a content script that finds the best image on each page:

1. **Direct images** - If the tab URL is an image, downloads directly
2. **Gallery overlays** - Detects common lightbox/gallery plugins
3. **Largest visible image** - Falls back to the biggest visible `<img>` element
4. **srcset parsing** - Extracts highest resolution from responsive images
5. **Data attributes** - Checks `data-src`, `data-original`, etc.
6. **Background images** - Extracts CSS background-image URLs

### Duplicate Detection

Two-stage duplicate detection prevents re-downloading the same image:

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

### Download Process

1. Query selected/highlighted tabs
2. For each tab, inject content script to find image
3. Check URL against download history
4. Fetch image data and generate perceptual hash
5. Check content hash against download history
6. Detect MIME type from magic bytes and correct extension
7. Download via Chrome downloads API
8. Add to history and optionally close tab

---

## Supported Image Formats

| Format | Extension | Detection |
|--------|-----------|-----------|
| JPEG | `.jpg` | Magic bytes `FF D8` |
| PNG | `.png` | Magic bytes `89 50 4E 47` |
| GIF | `.gif` | Magic bytes `47 49 46 38` |
| WebP | `.webp` | RIFF container with WEBP |
| AVIF | `.avif` | ftyp box with avif |
| SVG | `.svg` | XML/svg tag detection |
| BMP | `.bmp` | Magic bytes `42 4D` |

---

## Differences from the Userscript

This extension replaces the `universal_image_downloader.user.js` userscript with significant improvements:

| Aspect | Userscript | Extension |
|--------|------------|-----------|
| **Trigger** | Ctrl+double-click on image | Select tabs, click button or shortcut |
| **Batch processing** | One image at a time | All selected tabs at once |
| **Progress feedback** | Pill notification | Full progress bar with stats |
| **Pause/Resume** | Not supported | Full pause/resume control |
| **Settings** | Edit script source | UI toggles in popup |
| **Tab management** | Limited | Full close-after-download support |
| **Installation** | Userscript manager | Native browser extension |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not loading | Ensure Developer mode is enabled |
| No image found | Page may use non-standard image loading |
| Duplicate not detected | Hash threshold may need adjustment |
| Downloads failing | Check browser download permissions |
| Shortcuts not working | Check for conflicts at `chrome://extensions/shortcuts` |

---

## Privacy

- All processing happens locally in your browser
- Download history stored in `chrome.storage.local`
- No data sent to external servers
- No analytics or tracking

---

## Permissions

| Permission | Why |
|------------|-----|
| `tabs` | Query selected tabs |
| `downloads` | Save images to disk |
| `storage` | Persist download history |
| `activeTab` | Access current tab |
| `scripting` | Inject image detection script |
| `<all_urls>` | Fetch images from any site |

---

## Version History

| Version | Changes |
|---------|---------|
| 1.1 | Added filename prefix option, popup UI improvements |
| 1.0 | Initial release with batch downloads and perceptual hashing |
