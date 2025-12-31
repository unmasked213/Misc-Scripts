# Media Downloader Extension - Development Roadmap

## Project Overview

Expand the existing Image Downloader Extension into a unified Media Downloader with video capture capabilities. The goal is to achieve feature parity with commercial tools like CocoCut on unencrypted content while maintaining full control, security, and UI consistency.

### Core Principles

- **Incremental delivery** - Each phase produces usable functionality
- **Shared infrastructure** - Video and image paths share UI, progress, history, and tab management
- **Legal boundaries** - No DRM circumvention; work up to but not beyond the line
- **Windows-first** - FFmpeg integration assumes local installation, not bundled WASM
- **Capture vs Download** - Images are downloaded; streams are captured and assembled

---

## Current Implementation Status

### Completed Features (v1.3)

| Component | Status | Notes |
|-----------|--------|-------|
| Multi-tab batch processing | Complete | Direct reuse for video |
| Progress tracking (popup UI) | Complete | Extended for HLS segments |
| Pause/Resume/Cancel | Complete | Works for all media types |
| Duplicate detection (URL) | Complete | Used for images and videos |
| Duplicate detection (perceptual hash) | Complete | Images only |
| Download history with expiry | Complete | 30-day retention |
| Image detection (DOM, srcset, data-attrs) | Complete | Best quality selection |
| MIME detection from magic bytes | Complete | Images and videos |
| Keyboard shortcuts | Complete | Alt+Shift+S/D |
| Media type toggle (Images/Videos) | Complete | In popup UI |
| Video detection from DOM | Complete | `<video>` elements |
| Video detection via fetch/XHR hooks | Complete | intercept.js in MAIN world |
| Video detection via webRequest API | Complete | Passive network monitoring |
| HLS manifest parsing | Complete | Master and media playlists |
| HLS segment download | Complete | Sequential with page cookies |
| HLS stream assembly | Complete | In-page concatenation to .ts |
| DRM detection | Complete | Reports as unsupported |
| Offscreen document | Complete | For blob operations |

### Architecture Achieved

```
media-downloader-extension/
├── manifest.json           # Manifest V3 with offscreen permission
├── background.js           # Service worker with HLS parser
├── popup.html/js           # Images/Videos toggle, video selection modal
├── intercept.js            # MAIN world - fetch/XHR hooks, video events
├── bridge.js               # ISOLATED world - message relay
├── offscreen.html          # Blob assembly (alternative HLS path)
└── icons/
```

---

## Phase Status

### Phase 1: Direct Video Detection - COMPLETE

All deliverables achieved:

- [x] VideoDetector module in content script
- [x] Late-bound source detection (MutationObserver)
- [x] Video MIME detection in Utils
- [x] Media type toggle in popup UI
- [x] Filename handling for videos
- [x] Integration with existing batch/progress UI

### Phase 2: Stream Capture (HLS) - LARGELY COMPLETE

Current capabilities:

- [x] HLS manifest detection (m3u8)
- [x] HLS parser (master and media playlists)
- [x] Quality variant selection (auto-highest)
- [x] Segment download with authentication (page context cookies)
- [x] In-memory segment assembly
- [x] DRM/encryption detection
- [x] Progress tracking per-segment

**Not yet implemented:**
- [ ] DASH manifest parsing (.mpd)
- [ ] Native messaging host for FFmpeg
- [ ] Streaming disk writes (large files)
- [ ] Quality selection UI (currently auto-selects highest)
- [ ] AES-128 decryption (static key streams)

### Phase 3: Network Interception - PARTIALLY COMPLETE

Current capabilities:

- [x] webRequest.onCompleted monitoring
- [x] Segment pattern detection
- [x] Per-tab video URL collection
- [x] fetch/XHR interception in page context

**Not yet implemented:**
- [ ] Blob URL interception (limited by browser security)
- [ ] Stream reconstruction from captured segments
- [ ] Manifest correlation with segments

### Phase 4: Polish and Optimization - NOT STARTED

Remaining work:

- [ ] Video deduplication (fuzzy matching)
- [ ] Resume interrupted downloads
- [ ] Bandwidth management
- [ ] Error handling improvements
- [ ] Video thumbnail previews
- [ ] Site-specific handlers

---

## Remaining Work

### Priority 1: DASH Support

Add DASH (.mpd) manifest parsing alongside existing HLS:

```javascript
// In background.js
const DASH = {
    parseManifest(mpdText, baseUrl) {
        // Parse XML MPD
        // Extract AdaptationSets
        // Build segment URLs from templates
        // Return same format as HLS.parseManifest()
    }
};
```

Deliverables:
- [ ] DASH manifest detection in CapturedVideos
- [ ] MPD XML parser
- [ ] SegmentTemplate URL generation
- [ ] SegmentList handling
- [ ] Integration with existing download flow

### Priority 2: Quality Selection UI

Add user-facing quality picker:

- [ ] Modal showing available qualities (resolution, bitrate)
- [ ] Persist preference per-site or globally
- [ ] Default to highest quality

### Priority 3: Large File Handling

Current limitation: All segments held in memory before assembly.

Options:
1. **Streaming writes via offscreen document** - Write chunks to IndexedDB, assemble at end
2. **Native messaging host** - Stream to Python/FFmpeg for disk assembly
3. **Download each segment separately** - Let browser handle, user concatenates

Recommended: Native messaging host (Phase 2 original plan)

### Priority 4: AES-128 Decryption

Some HLS streams use AES-128 encryption with accessible keys:

```
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
```

Implementation:
- [ ] Detect #EXT-X-KEY in manifest
- [ ] Fetch key from URI
- [ ] Decrypt segments using Web Crypto API
- [ ] Distinguish from DRM (which uses protected key servers)

### Priority 5: Video Deduplication

Unlike images, video fingerprinting is complex:

Approach:
- Compare duration (±2 seconds tolerance)
- Compare resolution
- Sample first/middle/last frames for image hash
- Store lightweight metadata, not full hash

---

## Technical Debt

| Issue | Impact | Fix |
|-------|--------|-----|
| HLS assembly in page context | Exposes to page JS | Move to offscreen document |
| All segments in memory | Memory pressure on large files | Streaming writes |
| Hardcoded highest quality | User can't choose | Add quality picker |
| `[ImageDownloader]` log prefix | Confusing for video | Rename to `[MediaDownloader]` |
| offscreen.html + hls.js unused | Dead code | Remove or integrate |

---

## Failure Modes to Handle

### Manifest Failures

| Failure | Detection | Current Handling | Improvement |
|---------|-----------|------------------|-------------|
| 404/403 | HTTP status | Reports error | Add retry with fresh manifest |
| Malformed | Parse exception | Returns empty | Graceful partial parse |
| Relative URLs | Segments 404 | Uses manifest URL as base | Try multiple strategies |

### Segment Failures

| Failure | Detection | Current Handling | Improvement |
|---------|-----------|------------------|-------------|
| 404 mid-stream | HTTP status | Skips segment | Retry, refresh manifest |
| Timeout | Fetch timeout | Skips | Exponential backoff |
| Rate limiting | 429 | Fails | Reduce concurrency, add delay |

### Encryption

| Type | Detection | Current Handling |
|------|-----------|------------------|
| AES-128 static | #EXT-X-KEY | Reports as DRM (incorrect) |
| AES-128 rotating | Multiple #EXT-X-KEY | Reports as DRM |
| Widevine/FairPlay | SAMPLE-AES method | Correctly reports DRM |

---

## File Structure (Current vs Planned)

### Current
```
media-downloader-extension/
├── manifest.json
├── background.js           # Monolithic - all logic
├── popup.html
├── popup.js
├── intercept.js
├── bridge.js
├── offscreen.html
├── hls.js                  # Unused
└── icons/
```

### Planned (Modular)
```
media-downloader-extension/
├── manifest.json
├── background.js           # Slim coordinator
├── popup.html
├── popup.js
├── intercept.js
├── bridge.js
├── offscreen.html
├── modules/
│   ├── download/
│   │   ├── image-detector.js
│   │   ├── video-detector.js
│   │   └── download-manager.js
│   ├── capture/
│   │   ├── hls-parser.js
│   │   ├── dash-parser.js
│   │   ├── segment-manager.js
│   │   └── assembly-pipeline.js
│   └── shared/
│       ├── history.js
│       ├── progress.js
│       ├── deduplication.js
│       └── utils.js
├── native-host/            # Future: FFmpeg integration
│   ├── manifest.json
│   ├── media_host.py
│   └── install.bat
└── icons/
```

---

## Sites by Difficulty

### Working Now (v1.3)

| Site Type | Method | Notes |
|-----------|--------|-------|
| Direct .mp4/.webm links | Direct download | Full support |
| Archive.org | Direct + HLS | Works well |
| Many adult sites | Direct video | Works well |
| Twitter/X (some) | HLS | Non-DRM content |
| Reddit video | HLS | Works when playing |
| Self-hosted video | Direct | Works well |
| News sites | HLS/Direct | Varies by site |

### Needs DASH Support

| Site | Format | Status |
|------|--------|--------|
| YouTube | DASH | Not yet supported |
| Vimeo (some) | DASH | Not yet supported |

### Not Supported (DRM)

| Site | Protection |
|------|------------|
| Netflix | Widevine |
| Disney+ | Widevine |
| Amazon Prime Video | Widevine |
| HBO Max | Widevine |
| Hulu | Widevine |
| Spotify (audio) | Widevine |

---

## Next Steps (Recommended Order)

1. **Clean up technical debt**
   - Remove unused hls.js
   - Rename log prefix to [MediaDownloader]
   - Move HLS assembly to offscreen document

2. **Add DASH parser**
   - Parse MPD XML
   - Generate segment URLs
   - Integrate with existing flow

3. **Add quality selection UI**
   - Show available variants
   - Let user choose
   - Persist preference

4. **Handle AES-128 encryption**
   - Detect accessible keys
   - Implement decryption
   - Distinguish from true DRM

5. **Native messaging host**
   - Python script for FFmpeg
   - Streaming segment writes
   - TS → MP4 remuxing

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.3 | 2024-12 | HLS stream download, offscreen document, DRM detection |
| 1.2 | 2024-12 | Video mode, DOM scanning, fetch/XHR interception, network monitoring |
| 1.1 | 2024-12 | Filename prefix, popup UI improvements |
| 1.0 | 2024-12 | Initial release - batch image downloads, perceptual hashing |
