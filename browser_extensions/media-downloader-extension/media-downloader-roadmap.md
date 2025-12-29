# Media Downloader Extension — Video Support Roadmap

## Project Overview

Expand the existing Image Downloader Extension into a unified Media Downloader with video capture capabilities. The goal is to achieve feature parity with commercial tools like CocoCut on unencrypted content while maintaining full control, security, and UI consistency.

### Core Principles

- **Incremental delivery** — Each phase produces usable functionality
- **Shared infrastructure** — Video and image paths share UI, progress, history, and tab management
- **Legal boundaries** — No DRM circumvention; work up to but not beyond the line
- **Windows-first** — FFmpeg integration assumes local installation, not bundled WASM
- **Capture vs Download** — Images are downloaded; streams are captured and assembled. This distinction is maintained throughout the codebase.

---

## Current State

### Existing Capabilities (Image Downloader v1.1)

| Component | Status | Reusable for Video |
|-----------|--------|-------------------|
| Multi-tab batch processing | ✓ | Yes — direct reuse |
| Progress tracking (popup UI) | ✓ | Yes — extend for segments |
| Pause/Resume/Cancel | ✓ | Yes — direct reuse |
| Duplicate detection (URL) | ✓ | Yes — direct reuse |
| Duplicate detection (perceptual hash) | ✓ | No — video hashing differs |
| Download history with expiry | ✓ | Yes — direct reuse |
| Content script injection | ✓ | Yes — extend detection logic |
| MIME detection from magic bytes | ✓ | Yes — add video signatures |
| Keyboard shortcuts | ✓ | Yes — add video-specific |
| Shared UI system | ✓ | Yes — apply to new controls |

### Architecture Strengths

- Modular service worker structure (Config, State, Utils, Manager pattern)
- Clean separation between detection (content script) and download (background)
- Storage abstraction ready for video-specific metadata
- Manifest V3 compliant

### Gaps to Address

| Gap | Impact | Phase |
|-----|--------|-------|
| No video element detection | Cannot find basic videos | 1 |
| No late-bound source detection | Misses JS-assigned video sources | 1 |
| No stream manifest parsing | Cannot handle HLS/DASH | 2 |
| No segment assembly | Cannot produce playable files from streams | 2 |
| No streaming disk writes | Memory exhaustion on large files | 2 |
| No network interception | Cannot capture blob/MSE streams | 3 |
| No video-specific deduplication | May re-download same content | 4 |

---

## Architectural Distinction: Download vs Capture

This separation must be maintained throughout the codebase to prevent complexity leakage.

| Aspect | Download (Images, Direct Video) | Capture (Streams) |
|--------|--------------------------------|-------------------|
| Data source | Single URL | Manifest + segments |
| Fetch model | Single request | Parallel segment fetches |
| Progress unit | Bytes | Segments |
| Assembly | None | Concatenation or remux |
| Storage | Direct to downloads folder | Temp segments → assembly → final |
| Failure mode | Request fails | Partial capture, assembly fails |
| State complexity | Minimal | Segment map, retry queue, assembly status |

### Module Separation

```
modules/
├── download/           # Images and direct video files
│   ├── image-detector.js
│   ├── video-detector.js
│   └── download-manager.js
├── capture/            # Stream interception and assembly
│   ├── hls-parser.js
│   ├── dash-parser.js
│   ├── segment-manager.js
│   ├── network-monitor.js
│   └── assembly-pipeline.js
└── shared/             # Common infrastructure
    ├── history.js
    ├── progress.js
    └── utils.js
```

---

## Phase 1: Direct Video Detection

**Goal:** Download videos that exist as direct file URLs, matching current image capability.

**Duration:** 1-2 weeks

**Complexity:** Low — mirrors existing image logic

### Deliverables

1. **VideoDetector module** in content script
   - Scan for `<video>` elements with `src` attribute
   - Extract from `<source>` children
   - Check `data-src`, `data-video-src` attributes
   - Handle video background elements
   - Return array of {url, type, quality} candidates

2. **Late-bound source detection**
   - MutationObserver watching `video.src` attribute changes
   - Observer on `<source>` element insertion
   - Configurable settle delay (500ms default) before declaring "no video"
   - Handle dynamically created video elements

3. **Video MIME detection** in Utils
   - Add magic byte signatures for MP4, WebM, MKV, AVI, MOV
   - Extend `detectMimeType()` function

4. **Media type toggle** in popup UI
   - Radio/toggle: Images | Videos | Both
   - Persisted in chrome.storage.local
   - Filters detection results accordingly

5. **Filename handling** for videos
   - Preserve original extensions
   - Apply same timestamp prefix logic
   - Handle query string stripping

### Technical Implementation

```javascript
// Content script addition
const VideoDetector = {
  observer: null,
  pendingVideos: new Map(),
  settleDelayMs: 500,
  
  findVideos() {
    const candidates = [];
    
    // Direct video elements
    document.querySelectorAll('video').forEach(video => {
      if (video.src && this.isDirectUrl(video.src)) {
        candidates.push({ url: video.src, type: 'direct' });
      }
      video.querySelectorAll('source').forEach(source => {
        if (source.src && this.isDirectUrl(source.src)) {
          candidates.push({ url: source.src, type: 'source' });
        }
      });
    });
    
    // Data attributes
    document.querySelectorAll('[data-video-src], [data-src]').forEach(el => {
      const url = el.dataset.videoSrc || el.dataset.src;
      if (url && this.looksLikeVideo(url)) {
        candidates.push({ url, type: 'data-attr' });
      }
    });
    
    return this.deduplicate(candidates);
  },
  
  // Watch for late-bound sources
  startObserving() {
    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        // Attribute changes on video elements
        if (mutation.type === 'attributes' && 
            mutation.target.tagName === 'VIDEO' &&
            mutation.attributeName === 'src') {
          this.handleSourceChange(mutation.target);
        }
        
        // New video or source elements added
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          if (node.tagName === 'VIDEO') {
            this.handleSourceChange(node);
          } else if (node.tagName === 'SOURCE' && 
                     node.parentElement?.tagName === 'VIDEO') {
            this.handleSourceChange(node.parentElement);
          }
          
          // Check descendants
          node.querySelectorAll?.('video').forEach(v => {
            this.handleSourceChange(v);
          });
        }
      }
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  },
  
  handleSourceChange(video) {
    // Debounce rapid changes
    const existing = this.pendingVideos.get(video);
    if (existing) clearTimeout(existing);
    
    this.pendingVideos.set(video, setTimeout(() => {
      this.pendingVideos.delete(video);
      // Notify background of new source
      this.reportVideo(video);
    }, this.settleDelayMs));
  },
  
  isDirectUrl(url) {
    // Exclude blob:, data:, and streaming manifests
    return url && 
           !url.startsWith('blob:') && 
           !url.startsWith('data:') &&
           !url.endsWith('.m3u8') &&
           !url.endsWith('.mpd');
  },
  
  looksLikeVideo(url) {
    return /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(url);
  }
};
```

### Video Magic Bytes

| Format | Signature | Offset |
|--------|-----------|--------|
| MP4/M4V | `ftyp` | 4 |
| WebM | `1A 45 DF A3` | 0 |
| MKV | `1A 45 DF A3` | 0 |
| AVI | `RIFF` + `AVI ` | 0, 8 |
| MOV | `ftyp` (qt) | 4 |
| OGV | `OggS` | 0 |

### Success Criteria

- Downloads direct .mp4/.webm files from any tab
- Detects videos with JS-assigned sources (not just static markup)
- Correctly identifies video MIME types
- Integrates with existing batch/progress UI
- History tracks video downloads separately

---

## Phase 2: Stream Capture (HLS/DASH)

**Goal:** Parse streaming manifests and assemble segments into playable files.

**Duration:** 4-6 weeks

**Complexity:** High — requires manifest parsing, segment management, streaming assembly

### Deliverables

1. **Manifest detection** in content script
   - Identify HLS (.m3u8) and DASH (.mpd) URLs in page source
   - Extract from video player configurations (data attributes, inline scripts)
   - Handle relative URL resolution

2. **HLS parser module**
   - Parse master playlist (quality variants)
   - Parse media playlist (segment list)
   - Handle encryption detection (report as unsupported, not fail silently)
   - Extract segment URLs and byte ranges

3. **DASH parser module**
   - Parse MPD manifests (XML)
   - Extract adaptation sets and representations
   - Handle SegmentTemplate and SegmentList patterns
   - Calculate segment URLs from templates

4. **Quality selection UI**
   - Modal/dropdown showing available qualities
   - Display resolution, bitrate, codec info
   - Remember preference per-site or globally

5. **Segment download manager**
   - Parallel segment fetching (configurable concurrency)
   - Progress tracking per-segment and overall
   - Retry logic for failed segments with exponential backoff
   - Memory-aware buffering (threshold-based disk streaming)

6. **Native messaging host** (required, not optional)
   - FFmpeg wrapper for segment assembly
   - Streaming write support for large files
   - Status reporting back to extension

7. **Assembly pipeline**
   - In-memory concatenation for small assets (<100MB)
   - Streaming write via native host for larger files
   - TS → MP4 conversion when FFmpeg available
   - Raw concatenation fallback when FFmpeg unavailable

### Memory Management Strategy

```javascript
const AssemblyPipeline = {
  MEMORY_THRESHOLD_MB: 100,
  
  async assemble(segments, totalSize, outputPath) {
    if (totalSize < this.MEMORY_THRESHOLD_MB * 1024 * 1024) {
      return this.assembleInMemory(segments);
    } else {
      return this.assembleStreaming(segments, outputPath);
    }
  },
  
  async assembleInMemory(segments) {
    const buffers = await Promise.all(
      segments.map(s => fetch(s.url).then(r => r.arrayBuffer()))
    );
    return this.concatenate(buffers);
  },
  
  async assembleStreaming(segments, outputPath) {
    // Stream segments to native host for disk assembly
    const port = chrome.runtime.connectNative('com.misc_scripts.media_host');
    
    port.postMessage({ 
      action: 'start_assembly', 
      outputPath,
      totalSegments: segments.length 
    });
    
    for (let i = 0; i < segments.length; i++) {
      const response = await fetch(segments[i].url);
      const reader = response.body.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Send chunk to native host
        port.postMessage({ 
          action: 'write_chunk', 
          segmentIndex: i,
          data: Array.from(value) // Uint8Array → Array for JSON
        });
      }
      
      port.postMessage({ action: 'segment_complete', segmentIndex: i });
    }
    
    return new Promise((resolve, reject) => {
      port.onMessage.addListener(msg => {
        if (msg.action === 'assembly_complete') resolve(msg.outputPath);
        if (msg.action === 'error') reject(new Error(msg.message));
      });
      port.postMessage({ action: 'finalize' });
    });
  }
};
```

### Native Messaging Host

```python
#!/usr/bin/env python3
"""
media_host.py - Native messaging host for Media Downloader
Handles streaming assembly and FFmpeg integration.
"""

import sys
import json
import struct
import subprocess
import tempfile
from pathlib import Path

class MediaHost:
    def __init__(self):
        self.temp_dir = None
        self.segment_files = []
        self.output_path = None
        
    def read_message(self):
        raw_length = sys.stdin.buffer.read(4)
        if not raw_length:
            return None
        length = struct.unpack('I', raw_length)[0]
        message = sys.stdin.buffer.read(length).decode('utf-8')
        return json.loads(message)
    
    def send_message(self, message):
        encoded = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    
    def handle_start_assembly(self, msg):
        self.temp_dir = Path(tempfile.mkdtemp(prefix='media_dl_'))
        self.output_path = msg['outputPath']
        self.segment_files = []
        self.send_message({'action': 'ready'})
    
    def handle_write_chunk(self, msg):
        segment_idx = msg['segmentIndex']
        data = bytes(msg['data'])
        
        # Ensure segment file exists
        while len(self.segment_files) <= segment_idx:
            seg_path = self.temp_dir / f'segment_{len(self.segment_files):05d}.ts'
            self.segment_files.append(open(seg_path, 'wb'))
        
        self.segment_files[segment_idx].write(data)
    
    def handle_segment_complete(self, msg):
        segment_idx = msg['segmentIndex']
        if segment_idx < len(self.segment_files):
            self.segment_files[segment_idx].close()
    
    def handle_finalize(self, msg):
        # Close any remaining open files
        for f in self.segment_files:
            if not f.closed:
                f.close()
        
        # Try FFmpeg first, fall back to raw concatenation
        try:
            self.assemble_with_ffmpeg()
        except FileNotFoundError:
            self.assemble_raw()
        
        # Cleanup temp files
        for f in self.segment_files:
            Path(f.name).unlink(missing_ok=True)
        self.temp_dir.rmdir()
        
        self.send_message({
            'action': 'assembly_complete',
            'outputPath': self.output_path
        })
    
    def assemble_with_ffmpeg(self):
        # Create concat file
        concat_path = self.temp_dir / 'concat.txt'
        with open(concat_path, 'w') as f:
            for seg_file in self.segment_files:
                f.write(f"file '{seg_file.name}'\n")
        
        subprocess.run([
            'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
            '-i', str(concat_path),
            '-c', 'copy',
            self.output_path
        ], check=True, capture_output=True)
    
    def assemble_raw(self):
        with open(self.output_path, 'wb') as out:
            for seg_file in self.segment_files:
                with open(seg_file.name, 'rb') as seg:
                    while chunk := seg.read(65536):
                        out.write(chunk)
    
    def run(self):
        handlers = {
            'start_assembly': self.handle_start_assembly,
            'write_chunk': self.handle_write_chunk,
            'segment_complete': self.handle_segment_complete,
            'finalize': self.handle_finalize,
        }
        
        while True:
            msg = self.read_message()
            if msg is None:
                break
            
            action = msg.get('action')
            if action in handlers:
                try:
                    handlers[action](msg)
                except Exception as e:
                    self.send_message({'action': 'error', 'message': str(e)})

if __name__ == '__main__':
    MediaHost().run()
```

### Success Criteria

- Downloads HLS streams from major platforms (non-DRM)
- Downloads DASH streams from major platforms (non-DRM)
- Quality selection works and persists
- Progress accurately reflects segment download status
- Large files (>1GB) don't crash the browser
- Output files play correctly in VLC/browser

### Known Limitations (Phase 2)

- Encrypted streams (AES-128 with rotating keys) may not work
- DRM streams will be detected and reported as unsupported
- Blob URLs still not captured (Phase 3)
- Live streams not supported (VOD only)

---

## Phase 2 Failure Taxonomy

These are the specific ways HLS/DASH parsing and capture break in practice. Build error handling for each category from the start.

### Manifest Failures

| Failure | Cause | Detection | Handling |
|---------|-------|-----------|----------|
| Manifest 404/403 | Auth required, expired URL | HTTP status | Report "manifest inaccessible" |
| Malformed manifest | Non-standard formatting | Parse exception | Attempt recovery, report if unrecoverable |
| Relative URL resolution | Missing base URL context | Segments 404 | Try multiple base URL strategies |
| Redirect chains | CDN routing | Final URL differs | Follow redirects, update base URL |
| CORS blocking | Manifest on different origin | Fetch fails | Note: extension fetch bypasses CORS |

### Segment Failures

| Failure | Cause | Detection | Handling |
|---------|-------|-----------|----------|
| Segment 404 mid-stream | CDN cache expiry | HTTP 404 | Retry with fresh manifest |
| Segment timeout | Slow CDN, rate limiting | Fetch timeout | Exponential backoff, max 3 retries |
| Partial segment | Connection dropped | Content-Length mismatch | Discard, retry |
| Out-of-order delivery | Parallel fetch race | Segment index mismatch | Reorder buffer before assembly |
| Rate limiting | Too aggressive concurrency | 429 response | Reduce concurrency, add delay |

### Encryption Failures

| Failure | Cause | Detection | Handling |
|---------|-------|-----------|----------|
| AES-128 static key | Encryption but key accessible | `#EXT-X-KEY` with URI | Fetch key, decrypt segments |
| AES-128 rotating keys | Key changes per segment | Multiple `#EXT-X-KEY` | Fetch each key, track per segment |
| Key server auth | Key requires cookies/tokens | Key fetch 403 | Report "encrypted, key inaccessible" |
| Widevine/FairPlay | Full DRM | `#EXT-X-KEY:METHOD=SAMPLE-AES` or manifest signals | Report "DRM protected, not supported" |

### Assembly Failures

| Failure | Cause | Detection | Handling |
|---------|-------|-----------|----------|
| Discontinuity | Ad insertion, quality switch | `#EXT-X-DISCONTINUITY` | Handle timestamp reset |
| Container mismatch | Mixed TS/fMP4 segments | Magic byte check | Separate assembly paths |
| Corrupt segment | CDN error, incomplete download | FFmpeg decode error | Skip segment, note gap |
| Disk full | Large file, limited space | Write error | Report, cleanup temps |
| FFmpeg missing | Not installed | Subprocess error | Fall back to raw concat |

### Timing Failures

| Failure | Cause | Detection | Handling |
|---------|-------|-----------|----------|
| Manifest expiry | Time-limited URLs | Segments start failing | Re-fetch manifest, restart |
| Live stream confusion | VOD with live-like manifest | `#EXT-X-ENDLIST` missing | Treat as VOD if segments stable |
| Stale playlist | Cached manifest | Segment count unchanged | Force refresh, no-cache headers |

---

## Phase 3: Network Interception

**Goal:** Capture video content delivered via blob URLs and MediaSource extensions.

**Duration:** 3-4 weeks

**Complexity:** High — requires webRequest API and careful state management

### Core Principle

**Network capture is authoritative; blob interception is opportunistic.**

MediaSource internals are increasingly opaque. Many players create blobs in isolated contexts or use opaque handles that cannot be hooked from content scripts. The reliable signal is network traffic — the actual segment requests that must occur regardless of player implementation.

### Deliverables

1. **Network monitor module** (primary)
   - Use `chrome.webRequest.onBeforeRequest` to intercept media requests
   - Pattern match for video segment URLs
   - Build stream map per tab (associate segments with streams)
   - Correlate segments with manifests when possible

2. **Blob URL interception** (opportunistic)
   - Inject content script to hook `URL.createObjectURL` where possible
   - Map blob URLs to underlying data when accessible
   - Fall back gracefully when hooks don't fire

3. **Stream reconstruction**
   - Collect segments as they're requested
   - Detect stream completion (no new segments for N seconds)
   - Trigger assembly when stream ends or user requests
   - Handle interleaved audio/video tracks

4. **Permission handling**
   - Request `webRequest` permission
   - Explain to users why monitoring is needed
   - Graceful degradation if not available

### Technical Approach

```javascript
// Background script network monitoring
const NetworkMonitor = {
  streams: new Map(), // tabId -> stream data
  
  start() {
    chrome.webRequest.onCompleted.addListener(
      this.onRequestComplete.bind(this),
      { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest'] }
    );
  },
  
  onRequestComplete(details) {
    const { url, tabId, type } = details;
    
    // Skip if not a video segment
    if (!this.isVideoSegment(url)) return;
    
    // Initialize stream tracker for tab
    if (!this.streams.has(tabId)) {
      this.streams.set(tabId, { 
        segments: [], 
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        manifestUrl: null
      });
    }
    
    const stream = this.streams.get(tabId);
    stream.segments.push({
      url,
      timestamp: Date.now(),
      index: stream.segments.length
    });
    stream.lastSeen = Date.now();
    
    // Notify popup of activity
    this.broadcastUpdate(tabId, stream);
  },
  
  isVideoSegment(url) {
    // Segment file patterns
    if (/\.(ts|m4s|mp4|m4v|m4a)(\?|$)/i.test(url)) return true;
    
    // Common segment URL patterns
    if (/\/segment\d+/i.test(url)) return true;
    if (/\/chunk[-_]/i.test(url)) return true;
    if (/\/frag\(\d+\)/i.test(url)) return true;
    if (/\/range\/\d+-\d+/i.test(url)) return true;
    
    return false;
  },
  
  isManifest(url) {
    return /\.(m3u8|mpd)(\?|$)/i.test(url);
  },
  
  getStreamForTab(tabId) {
    return this.streams.get(tabId);
  },
  
  // Detect when stream appears complete
  isStreamComplete(tabId, idleThresholdMs = 5000) {
    const stream = this.streams.get(tabId);
    if (!stream) return false;
    
    const idle = Date.now() - stream.lastSeen;
    return idle > idleThresholdMs && stream.segments.length > 0;
  }
};
```

### Blob Interception (Best-Effort)

```javascript
// Content script - injected early
const BlobInterceptor = {
  blobMap: new Map(),
  
  install() {
    // This may not fire in all contexts
    const originalCreateObjectURL = URL.createObjectURL;
    
    URL.createObjectURL = (obj) => {
      const url = originalCreateObjectURL.call(URL, obj);
      
      if (obj instanceof Blob && obj.type.startsWith('video/')) {
        this.blobMap.set(url, {
          size: obj.size,
          type: obj.type,
          created: Date.now()
        });
        
        // Notify background
        chrome.runtime.sendMessage({
          type: 'blob_created',
          url,
          size: obj.size,
          mimeType: obj.type
        });
      }
      
      return url;
    };
  }
};

// Note: This hook may not fire if the player:
// - Uses a Web Worker
// - Uses an iframe with different origin
// - Creates blobs before our script runs
// Network monitoring is the reliable fallback.
```

### Manifest Permissions Update

```json
{
  "permissions": [
    "tabs",
    "downloads",
    "storage",
    "activeTab",
    "scripting",
    "webRequest",
    "nativeMessaging"
  ],
  "host_permissions": [
    "<all_urls>"
  ]
}
```

### Success Criteria

- Captures videos from sites using blob URLs (where network visible)
- Captures videos from MSE-based players
- Does not interfere with normal browsing
- Clearly reports when capture isn't possible (DRM, no segments detected)
- Network monitor has minimal performance impact

---

## Phase 4: Polish and Optimization

**Goal:** Production-ready quality, performance optimization, edge case handling.

**Duration:** 2-3 weeks

**Complexity:** Medium — refinement rather than new features

### Deliverables

1. **Video-specific deduplication**
   - Fuzzy identity based on: duration ± tolerance, resolution, codec, byte signature samples
   - Multiple sample windows to handle intro variation
   - Explicit "probably same" vs "definitely same" confidence levels
   - Defer perfect deduplication — this will iterate beyond Phase 4

2. **Resume interrupted downloads**
   - Persist segment progress to storage
   - Resume from last successful segment
   - Handle browser restart gracefully

3. **Bandwidth management**
   - Configurable download speed limit
   - Pause when on metered connection (navigator.connection API)
   - Queue management for large batches

4. **Error handling improvements**
   - Categorized error types (see failure taxonomy)
   - User-friendly messages for each category
   - Automatic retry with exponential backoff
   - Detailed logging for debugging (toggleable)

5. **UI refinements**
   - Video thumbnail previews in popup
   - Estimated time remaining
   - Download speed indicator
   - History view with video metadata (duration, resolution)
   - Clear indication of capture vs download mode

6. **Site-specific handlers**
   - Modular system for site-specific detection logic
   - Handler registry with pattern matching
   - Community-contributed handler support (future)

### Success Criteria

- Reliable operation across diverse sites
- Graceful handling of all error conditions
- Performance suitable for batch operations
- UI matches shared design system

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| DRM prevalence higher than expected | Medium | High | Clear messaging about limitations; focus on unencrypted sources |
| Memory exhaustion on large files | High | High | Streaming assembly via native host (Phase 2 requirement) |
| Manifest format variations | High | Medium | Robust parsing with fallbacks; site-specific handlers |
| Blob interception unreliable | High | Medium | Network capture as primary; blob hooks as bonus |
| Browser API changes | Low | High | Stay current with Manifest V3; abstract browser APIs |
| FFmpeg integration complexity | Medium | Medium | Python host wrapper; graceful fallback to raw concat |
| User confusion about capabilities | Medium | Low | Clear UI indication of what can/cannot be downloaded |

---

## Timeline Summary

| Phase | Duration | Cumulative | Key Milestone |
|-------|----------|------------|---------------|
| Phase 1 | 1-2 weeks | 1-2 weeks | Direct video downloads working |
| Phase 2 | 4-6 weeks | 5-8 weeks | HLS/DASH streams capturable |
| Phase 3 | 3-4 weeks | 8-12 weeks | Blob/MSE capture operational |
| Phase 4 | 2-3 weeks | 10-15 weeks | Production-ready release |

**Total estimated duration: 10-15 weeks**

This assumes part-time development. Full-time focus could compress to 6-10 weeks.

---

## Immediate Next Steps

1. **Rename extension** from image-downloader to media-downloader
2. **Create video detection branch** in repository
3. **Implement VideoDetector module** with MutationObserver (Phase 1 core)
4. **Add video MIME signatures** to Utils
5. **Extend popup UI** with media type toggle
6. **Test on 10+ sites** with direct video files
7. **Document Phase 1 completion** before starting Phase 2

---

## File Structure (Projected)

```
media-downloader-extension/
├── manifest.json               # Updated permissions
├── background.js               # Core coordinator
├── popup.html                  # Media type controls
├── popup.js                    # Extended state handling
├── content.js                  # Unified content script
├── modules/
│   ├── download/
│   │   ├── image-detector.js   # Existing logic extracted
│   │   ├── video-detector.js   # Phase 1
│   │   └── download-manager.js # Direct file downloads
│   ├── capture/
│   │   ├── hls-parser.js       # Phase 2
│   │   ├── dash-parser.js      # Phase 2
│   │   ├── segment-manager.js  # Phase 2
│   │   ├── network-monitor.js  # Phase 3
│   │   └── assembly-pipeline.js # Phase 2
│   └── shared/
│       ├── history.js          # Unified download/capture history
│       ├── progress.js         # Progress tracking
│       ├── deduplication.js    # URL + content dedup
│       └── utils.js            # MIME detection, filename handling
├── native-host/
│   ├── com.misc_scripts.media_host.json  # Native messaging manifest
│   ├── media_host.py           # Python host for FFmpeg
│   └── install.bat             # Windows registry setup
├── icons/
└── README.md
```

---

## Reference: Sites by Difficulty

### Phase 1 (Direct URLs)
- Archive.org
- Direct .mp4 links
- Many adult sites
- Self-hosted video
- Some news sites

### Phase 2 (HLS/DASH)
- Twitter/X (non-DRM)
- Reddit video
- Twitch VODs (non-sub)
- Many news sites
- Educational platforms
- Vimeo (some content)

### Phase 3 (Network Interception)
- Instagram
- Facebook (some)
- TikTok
- Sites using custom MSE players

### Not Supported (DRM)
- Netflix
- Disney+
- Amazon Prime Video
- HBO Max
- Hulu
- Spotify (audio)
- Most paid streaming services
