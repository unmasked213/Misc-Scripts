# Image Downloader Extension

Download images from selected browser tabs with keyboard shortcuts or a popup UI.

## Features

- Download images from all selected tabs at once
- Popup UI with options for close behavior and duplicate handling
- Perceptual hash deduplication (catches renamed/resized duplicates)
- URL-based deduplication
- Automatic MIME type detection and extension correction
- Timestamped filenames
- Configurable tab closing after download

## Installation

1. Unzip the extension folder
2. Open Chrome/Brave and go to `chrome://extensions/` or `brave://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `image-downloader-extension` folder

## Usage

### Popup UI (click extension icon)

Click the extension icon to open the popup with:

- **Download Selected Tabs** - Downloads images from all highlighted tabs
- **Download Current Tab** - Downloads image from the active tab only
- **Close tabs after download** - Toggle whether to close tabs after downloading
- **Skip duplicates** - Toggle duplicate detection

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt+Shift+S | Download from all selected tabs |
| Alt+Shift+D | Download from current tab |

Customize shortcuts at `chrome://extensions/shortcuts` or `brave://extensions/shortcuts`

### Tab Selection

- **Single tab**: Click on a tab
- **Multiple tabs**: Ctrl+click to add individual tabs
- **Range of tabs**: Click first tab, Shift+click last tab

## Macro Setup (GHUB etc.)

The keyboard shortcuts are designed to avoid conflicts with browser defaults. Set your macro to send:

- `Alt+Shift+S` for batch download of selected tabs
- `Alt+Shift+D` for single tab download

## Configuration

Edit `background.js` to modify default behavior:

```javascript
const Config = {
    closeTabAfterDownload: true,      // Default close behavior
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

- Single tab selection won't auto-close (prevents closing your only tab)
- Duplicate images (by URL or content) are skipped when enabled
- Works on direct image URLs and pages containing images
- Finds the largest/highest quality image on each page
