# Image Downloader Extension

Download images from selected browser tabs with a single keyboard shortcut.

## Features

- Download images from all selected tabs at once
- Perceptual hash deduplication (catches renamed/resized duplicates)
- URL-based deduplication
- Automatic MIME type detection and extension correction
- Timestamped filenames
- Automatic tab closing after download

## Installation

1. Unzip the extension folder
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `image-downloader-extension` folder

## Usage

### Download from selected tabs (Ctrl+Shift+S)

1. Open multiple image tabs
2. Select tabs by Ctrl+clicking them in the tab bar
3. Press **Ctrl+Shift+S**
4. All selected tabs download their primary image and close

### Download from current tab (Ctrl+Shift+D)

1. Navigate to a page with an image
2. Press **Ctrl+Shift+D**
3. Downloads the image without closing the tab

### Click the extension icon

Same as Ctrl+Shift+S - downloads from all selected tabs.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+S | Download from all selected tabs (closes tabs) |
| Ctrl+Shift+D | Download from current tab (stays open) |

You can customize these in `chrome://extensions/shortcuts`

## How Tab Selection Works

- **Single tab**: Click on a tab
- **Multiple tabs**: Ctrl+click to add individual tabs
- **Range of tabs**: Click first tab, Shift+click last tab
- **All tabs**: Ctrl+A (when tab bar focused)

## Configuration

Edit `background.js` to modify:

```javascript
const Config = {
    closeTabAfterDownload: true,      // Auto-close tabs after download
    useTimestampInFilename: true,     // Prefix filenames with timestamp
    
    deduplication: {
        enabled: true,                 // Track downloaded images
        timeframeDays: 30,             // How long to remember downloads
        perceptualHash: {
            enabled: true,             // Content-based duplicate detection
            hammingThreshold: 5        // Similarity threshold (0-64)
        }
    },
    
    closeDelayMs: 500                  // Delay before closing tab
};
```

## Notes

- If only one tab is selected, it won't close after download
- Duplicate images (by URL or content) are skipped automatically
- Works on direct image URLs and pages containing images
- Finds the largest/highest quality image on each page
