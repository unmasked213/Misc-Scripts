# CLAUDE.md - Media Downloader Extension

Development guidelines and context for AI assistants working on this browser extension.

---

## Summary

A Manifest V3 Chrome extension for batch downloading images and videos from browser tabs. Supports direct media files, HLS streaming video, and includes perceptual hash deduplication for images.

---

## Architecture

```
media-downloader-extension/
├── manifest.json       # Extension manifest (Manifest V3)
├── background.js       # Service worker - core coordinator
├── popup.html          # Popup UI markup
├── popup.js            # Popup logic and state management
├── intercept.js        # Content script (MAIN world) - fetch/XHR hooks
├── bridge.js           # Content script (ISOLATED world) - message relay
├── offscreen.html      # Offscreen document for HLS segment assembly
├── hls.js              # HLS.js library (unused - kept for reference)
├── icons/              # Extension icons (16, 48, 128px)
└── docs/
    ├── README.md       # User documentation
    └── media-downloader-roadmap.md  # Development roadmap
```

### Component Roles

| File | World/Context | Purpose |
|------|---------------|---------|
| `background.js` | Service Worker | Download management, state, HLS parsing, webRequest monitoring |
| `popup.js` | Extension Popup | UI interactions, settings persistence, progress display |
| `intercept.js` | MAIN (page context) | Hook fetch/XHR, watch video play events |
| `bridge.js` | ISOLATED (extension context) | Relay CustomEvents from intercept.js to background |
| `offscreen.html` | Offscreen Document | Blob assembly, DOM operations unavailable in SW |

### Content Script Architecture

The extension uses a two-world content script pattern:

```
[Page JavaScript] ←→ [intercept.js (MAIN)] ←→ [bridge.js (ISOLATED)] ←→ [background.js]
                        CustomEvent            chrome.runtime.sendMessage
```

**Why two scripts?**
- `intercept.js` must run in MAIN world to hook `fetch()` and `XMLHttpRequest`
- MAIN world cannot use `chrome.runtime` APIs
- `bridge.js` in ISOLATED world receives CustomEvents and forwards to service worker

---

## Key Modules in background.js

| Module | Lines | Purpose |
|--------|-------|---------|
| `Config` | 10-27 | Configuration constants |
| `CapturedVideos` | 33-113 | Video URL storage by tab, stream detection |
| `DownloadState` | 188-218 | Global download progress state |
| `Utils` | 224-364 | URL normalization, filename creation, MIME detection |
| `HLS` | 370-482 | HLS manifest parsing (master + media playlists) |
| `PerceptualHash` | 694-788 | Image fingerprinting for deduplication |
| `DownloadHistory` | 794-928 | Persistent download tracking with expiry |
| `DownloadManager` | 1165-1630 | Core download orchestration |

---

## Message Protocol

### Content Script → Background

```javascript
// Video detected (from intercept.js via bridge.js)
{ action: 'video-intercepted', url, source, tabUrl, isStream, duration, dimensions }

// MSE/blob detected (streaming video in use)
{ action: 'mse-detected', tabUrl, duration, dimensions }
```

### Popup → Background

```javascript
// Download actions
{ action: 'download-selected-tabs', options: { closeTabs, skipDuplicates, interval, prefix } }
{ action: 'download-current-tab', options: {...} }

// Video actions
{ action: 'scan-videos', tabIds: [...] }
{ action: 'download-specific-videos', videos: [...], options: {...} }

// Control actions
{ action: 'pause' }
{ action: 'resume' }
{ action: 'cancel' }
{ action: 'get-status' }
```

### Background → Popup (response)

```javascript
// Status response
{ isRunning, isPaused, processed, total, success, skipped, duplicates }

// Download result
{ processed, success, skipped, duplicates, cancelled }
```

---

## Development Patterns

### Adding New Detection Sources

1. Add detection in `intercept.js` (MAIN world)
2. Dispatch CustomEvent with `__mediaDownloaderVideo` type
3. Bridge automatically forwards to background
4. Background stores in `CapturedVideos.byTab`

```javascript
// In intercept.js
reportVideo(url, 'my-source', { isStream: false, duration: null });
```

### Adding New Download Types

1. Extend `DownloadManager.downloadFromTab()` with format detection
2. Add MIME signatures to `Utils.detectMimeType()` if needed
3. Update `Utils.updateExtension()` for filename handling

### HLS Stream Flow

```
1. User clicks "Download" on HLS video
2. downloadSpecificVideos() detects .m3u8 URL
3. downloadHLSStream() fetches manifest in page context (for cookies)
4. HLS.parseManifest() extracts segment URLs
5. All segments fetched sequentially in page context
6. Segments concatenated into Uint8Array
7. Blob created and download triggered via anchor click
8. Output is .ts file (raw MPEG-TS container)
```

---

## Testing Checklist

### Image Downloads
- [ ] Single tab with direct image URL
- [ ] Tab with `<img>` elements (select largest)
- [ ] Gallery page with lightbox
- [ ] Page with lazy-loaded images (data-src)
- [ ] Duplicate detection (same URL)
- [ ] Duplicate detection (same content, different URL)

### Video Downloads
- [ ] Direct .mp4/.webm URLs
- [ ] Video element with static src
- [ ] Video with dynamically assigned src
- [ ] HLS stream (non-DRM)
- [ ] HLS with master playlist (quality variants)
- [ ] DRM stream (should report as unsupported)

### Batch Operations
- [ ] Multiple tabs selected
- [ ] Pause/Resume during batch
- [ ] Cancel during batch
- [ ] Auto-close tabs option

### Edge Cases
- [ ] Tab with no media
- [ ] Network error during download
- [ ] Extension reloaded while content script active
- [ ] Very large video file (memory handling)

---

## Known Limitations

| Limitation | Reason | Workaround |
|------------|--------|------------|
| No DASH support | Not yet implemented | Use HLS where available |
| DRM content fails | By design - no circumvention | None |
| Blob URLs can't be downloaded | MediaSource opaque | Network interception captures source |
| HLS outputs .ts not .mp4 | No remuxing without FFmpeg | Play in VLC, convert externally |
| Large HLS causes memory pressure | All segments in memory | Future: streaming assembly |

---

## Debugging

### Console Logging

All logs prefixed with `[ImageDownloader]` (legacy name, applies to all media):

```javascript
Utils.log('Message here');  // → [ImageDownloader] Message here
```

### Service Worker Inspection

1. Go to `chrome://extensions/`
2. Find Media Downloader
3. Click "Inspect views: service worker"

### Content Script Inspection

1. Open DevTools on target page
2. Console shows `intercept.js` logs from MAIN world
3. Check for `[MediaDownloader]` prefix

### Offscreen Document

1. Go to `chrome://extensions/`
2. Click "Details" on extension
3. Look for "Offscreen documents" section

---

## Code Style

### General
- Use descriptive names, avoid abbreviations
- Group related functions into object modules
- Document public functions with JSDoc-style comments

### Naming Conventions
- `camelCase` for functions and variables
- `PascalCase` for module objects (Config, Utils, HLS, etc.)
- `UPPER_CASE` only for true constants

### Error Handling
- Wrap async operations in try/catch
- Log errors with `Utils.log('Error:', error)`
- Return error objects rather than throwing where practical

### UI Updates
- Use CSS transitions for smooth state changes
- Batch DOM updates to prevent layout thrashing
- Keep popup responsive during long operations

---

## Security Considerations

- No eval() or dynamic code execution
- URLs validated before fetch
- Content script isolation via ISOLATED/MAIN world split
- No credential storage or transmission
- Passive network monitoring (read-only)

---

## Future Development

See `media-downloader-roadmap.md` for:
- DASH stream support (Phase 2)
- Native messaging host for FFmpeg integration
- Video deduplication
- Resume interrupted downloads
- Site-specific handlers

---

## Quick Reference

### Manifest Permissions
```json
["tabs", "downloads", "storage", "activeTab", "scripting", "webRequest", "offscreen"]
```

### Key Storage Keys
- `closeTabs` - boolean - Auto-close tabs setting
- `skipDuplicates` - boolean - Deduplication setting
- `interval` - number - Delay between downloads (ms)
- `prefix` - string - Filename prefix
- `img_dl_*` - Download history entries

### Keyboard Shortcuts
- `Alt+Shift+S` - Download from selected tabs
- `Alt+Shift+D` - Download from current tab
