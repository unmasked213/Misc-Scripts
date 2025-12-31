/**
 * Media Downloader Extension - Background Service Worker
 * Handles tab selection, download coordination, and deduplication.
 *
 * VIDEO RECORD STATE MACHINE:
 * - candidate: URL seen via webRequest or fetch/XHR but not tied to actual play event
 * - confirmed: Observed video element event (play/playing/loadeddata) with stable currentSrc
 * - validated: Passed header probe confirming it's accessible video with proper headers
 * - actionable: Safe to show in UI with preview/download enabled
 * - failed: Validation failed, blob/MSE without manifest, or stream manifest
 *
 * Only "actionable" videos appear in the main UI list by default.
 * "candidate" videos are shown in a separate section with actions disabled.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const Config = {
    closeTabAfterDownload: true,
    useTimestampInFilename: true,

    // Debug logging - set to true for verbose output
    debugLogging: true,

    deduplication: {
        enabled: true,
        storageKeyPrefix: 'img_dl_',
        timeframeDays: 30,
        ignoreQueryParams: true,
        perceptualHash: {
            enabled: true,
            hammingThreshold: 5
        }
    },

    // Delay before closing tab (allows download to initiate)
    closeDelayMs: 500,

    // Preview snippet size limits
    preview: {
        defaultBytes: 2 * 1024 * 1024,  // 2 MB default
        maxBytes: 5 * 1024 * 1024       // 5 MB hard cap
    },

    // Validation settings
    validation: {
        timeoutMs: 10000,               // 10 second timeout for validation probes
        minRangeBytes: 1024             // Minimum bytes for range probe
    }
};

// =============================================================================
// VIDEO RECORD STATE MACHINE
// =============================================================================

/**
 * Video states following play-gated promotion model
 * @enum {string}
 */
const VideoState = {
    CANDIDATE: 'candidate',     // Seen via network but not played
    CONFIRMED: 'confirmed',     // Play event observed with stable URL
    VALIDATED: 'validated',     // Headers probed and confirmed accessible
    ACTIONABLE: 'actionable',   // Ready for UI with preview/download
    FAILED: 'failed'            // Validation failed or unsupported type
};

/**
 * VideoRecord represents a single video with its lifecycle state
 */
class VideoRecord {
    constructor(url, tabId, source = 'network') {
        this.id = this.generateId(url, tabId);
        this.url = url;
        this.tabId = tabId;
        this.state = VideoState.CANDIDATE;
        this.source = source;
        this.capturedAt = Date.now();
        this.confirmedAt = null;
        this.validatedAt = null;

        // Metadata (populated during confirmation/validation)
        this.contentType = null;
        this.filesize = null;           // Total size in bytes
        this.duration = null;
        this.dimensions = null;
        this.acceptRanges = null;
        this.etag = null;
        this.lastModified = null;

        // Play event data
        this.playEventTimestamp = null;
        this.elementIdHash = null;

        // Flags
        this.isStream = false;
        this.isBlob = false;
        this.failureReason = null;

        // For deduplication - compound key
        this.dedupeKey = null;
    }

    generateId(url, tabId) {
        // Create stable ID from URL pathname + tabId
        try {
            const parsed = new URL(url);
            const pathHash = this.hashString(parsed.pathname);
            return `${tabId}_${pathHash}_${Date.now()}`;
        } catch {
            return `${tabId}_${this.hashString(url)}_${Date.now()}`;
        }
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Generate dedupe key for grouping similar videos
     * Prefers: etag + pathname, or pathname + size + lastModified
     * Does NOT strip query params from actual URL (needed for tokens)
     */
    computeDedupeKey() {
        try {
            const parsed = new URL(this.url);
            const pathname = parsed.pathname;

            if (this.etag) {
                this.dedupeKey = `${this.etag}:${pathname}`;
            } else if (this.filesize && this.lastModified) {
                this.dedupeKey = `${pathname}:${this.filesize}:${this.lastModified}`;
            } else if (this.filesize) {
                this.dedupeKey = `${pathname}:${this.filesize}`;
            } else {
                // Fallback: pathname only (less reliable)
                this.dedupeKey = pathname;
            }
        } catch {
            this.dedupeKey = this.url;
        }
        return this.dedupeKey;
    }

    /**
     * Transition to confirmed state after play event
     */
    confirm(playEventData) {
        if (this.state === VideoState.FAILED) return false;

        this.state = VideoState.CONFIRMED;
        this.confirmedAt = Date.now();
        this.playEventTimestamp = playEventData.timestamp || Date.now();
        this.elementIdHash = playEventData.elementIdHash || null;

        if (playEventData.duration) this.duration = playEventData.duration;
        if (playEventData.dimensions) this.dimensions = playEventData.dimensions;

        debugLog(`Video confirmed: ${this.url.substring(0, 60)}... (state: ${this.state})`);
        return true;
    }

    /**
     * Transition to validated state after header probe
     */
    validate(headerData) {
        if (this.state === VideoState.FAILED) return false;

        this.state = VideoState.VALIDATED;
        this.validatedAt = Date.now();

        if (headerData.contentType) this.contentType = headerData.contentType;
        if (headerData.contentLength) this.filesize = headerData.contentLength;
        if (headerData.acceptRanges) this.acceptRanges = headerData.acceptRanges;
        if (headerData.etag) this.etag = headerData.etag;
        if (headerData.lastModified) this.lastModified = headerData.lastModified;

        this.computeDedupeKey();
        debugLog(`Video validated: ${this.url.substring(0, 60)}... (size: ${this.filesize}, ranges: ${this.acceptRanges})`);
        return true;
    }

    /**
     * Transition to actionable state - ready for UI
     */
    makeActionable() {
        if (this.state !== VideoState.VALIDATED) return false;
        this.state = VideoState.ACTIONABLE;
        debugLog(`Video actionable: ${this.url.substring(0, 60)}...`);
        return true;
    }

    /**
     * Mark as failed with reason
     */
    fail(reason) {
        this.state = VideoState.FAILED;
        this.failureReason = reason;
        debugLog(`Video failed: ${this.url.substring(0, 60)}... (reason: ${reason})`);
    }

    /**
     * Get display-friendly filename
     */
    getFilename() {
        return Utils.createFilename(this.url);
    }

    /**
     * Convert to plain object for messaging
     */
    toObject() {
        return {
            id: this.id,
            url: this.url,
            state: this.state,
            source: this.source,
            contentType: this.contentType,
            filesize: this.filesize,
            duration: this.duration,
            dimensions: this.dimensions,
            isStream: this.isStream,
            failureReason: this.failureReason,
            dedupeKey: this.dedupeKey,
            capturedAt: this.capturedAt,
            confirmedAt: this.confirmedAt
        };
    }
}

// =============================================================================
// VIDEO CAPTURE STORAGE (refactored for state machine)
// =============================================================================

const CapturedVideos = {
    // Map<tabId, Map<url, VideoRecord>>
    byTab: new Map(),

    // Progressive video types we can download directly
    videoMimeTypes: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    videoExtensions: /\.(mp4|webm|mkv|avi|mov|m4v)(\?|#|$)/i,

    // Streaming manifest types
    streamMimeTypes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml'],
    streamExtensions: /\.(m3u8|mpd)(\?|#|$)/i,

    // Segment patterns - these are parts of streams, not standalone
    segmentPatterns: [/\/seg-/i, /\/fragment/i, /\/chunk/i, /\.ts(\?|$)/i, /\.m4s(\?|$)/i],

    /**
     * Add a candidate video from network interception
     * Does NOT show in UI until confirmed by play event
     */
    addCandidate(tabId, url, contentType, contentLength) {
        // Skip segments and invalid URLs
        if (this.segmentPatterns.some(p => p.test(url))) return null;
        if (url.startsWith('blob:') || url.startsWith('data:')) return null;

        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, new Map());
        }

        const videos = this.byTab.get(tabId);

        // Check if we already have this URL
        if (videos.has(url)) {
            const existing = videos.get(url);
            // Update metadata if we have new info
            if (contentType && !existing.contentType) existing.contentType = contentType;
            if (contentLength && !existing.filesize) existing.filesize = parseInt(contentLength);
            return existing;
        }

        // Create new candidate record
        const record = new VideoRecord(url, tabId, 'network');
        if (contentType) record.contentType = contentType;
        if (contentLength) record.filesize = parseInt(contentLength);
        record.isStream = this.isStreamManifest(url, contentType);

        videos.set(url, record);
        debugLog(`Candidate added (tab ${tabId}): ${url.substring(0, 60)}... [${record.isStream ? 'stream' : 'progressive'}]`);

        return record;
    },

    /**
     * Confirm a video after play event with stable URL
     * This promotes candidate to confirmed, or creates new confirmed record
     */
    confirmVideo(tabId, url, playEventData) {
        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, new Map());
        }

        const videos = this.byTab.get(tabId);
        let record = videos.get(url);

        if (!record) {
            // Create directly as confirmed (play event without prior network detection)
            record = new VideoRecord(url, tabId, playEventData.source || 'play-event');
            record.isStream = this.isStreamManifest(url, null);
            videos.set(url, record);
        }

        // Transition to confirmed
        record.confirm(playEventData);

        // If it's a stream, mark as such but don't fail yet (HLS support exists)
        if (record.isStream) {
            debugLog(`Stream confirmed: ${url.substring(0, 60)}... (HLS/DASH)`);
        }

        return record;
    },

    /**
     * Get all videos for a tab, optionally filtered by state
     */
    getForTab(tabId, states = null) {
        const videos = this.byTab.get(tabId);
        if (!videos) return [];

        const records = Array.from(videos.values());

        if (states) {
            const stateSet = new Set(Array.isArray(states) ? states : [states]);
            return records.filter(r => stateSet.has(r.state));
        }

        return records;
    },

    /**
     * Get only actionable videos (for main UI display)
     */
    getActionableForTab(tabId) {
        return this.getForTab(tabId, VideoState.ACTIONABLE);
    },

    /**
     * Get candidate videos (for "unconfirmed" section if shown)
     */
    getCandidatesForTab(tabId) {
        return this.getForTab(tabId, VideoState.CANDIDATE);
    },

    /**
     * Get a specific video by URL
     */
    getByUrl(tabId, url) {
        const videos = this.byTab.get(tabId);
        return videos ? videos.get(url) : null;
    },

    clearTab(tabId) {
        this.byTab.delete(tabId);
        debugLog(`Cleared video records for tab ${tabId}`);
    },

    isVideoRequest(url, contentType) {
        if (contentType) {
            const mime = contentType.split(';')[0].trim().toLowerCase();
            if (this.videoMimeTypes.includes(mime)) return true;
        }
        if (this.videoExtensions.test(url)) return true;
        if (this.isStreamManifest(url, contentType)) return true;
        return false;
    },

    isStreamManifest(url, contentType) {
        if (contentType) {
            const mime = contentType.split(';')[0].trim().toLowerCase();
            if (this.streamMimeTypes.includes(mime)) return true;
        }
        return this.streamExtensions.test(url);
    }
};

// =============================================================================
// VALIDATION - Header probing for progressive MP4
// =============================================================================

/**
 * Validate a video URL by probing headers
 * Confirms it's a real video, checks for range support, gets accurate size
 */
async function validateProgressiveVideo(record) {
    const url = record.url;
    debugLog(`Validating video: ${url.substring(0, 60)}...`);

    try {
        // First try HEAD request
        let response;
        let method = 'HEAD';

        try {
            response = await fetch(url, {
                method: 'HEAD',
                credentials: 'include',
                signal: AbortSignal.timeout(Config.validation.timeoutMs)
            });
        } catch (headError) {
            // HEAD might be blocked (405), try Range GET instead
            debugLog(`HEAD failed, trying Range GET: ${headError.message}`);
            method = 'GET-RANGE';

            response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Range': 'bytes=0-1023'  // First 1KB only
                },
                signal: AbortSignal.timeout(Config.validation.timeoutMs)
            });

            // Abort body reading - we only need headers
            if (response.body) {
                const reader = response.body.getReader();
                // Read minimal bytes to confirm video signature
                const { value } = await reader.read();
                reader.cancel();

                // Optional: verify MP4 signature (ftyp box)
                if (value && value.length >= 8) {
                    const sig = String.fromCharCode(...value.slice(4, 8));
                    if (sig === 'ftyp') {
                        debugLog(`Verified MP4 ftyp signature`);
                    }
                }
            }
        }

        // Check response status
        if (!response.ok && response.status !== 206) {
            record.fail(`HTTP ${response.status}`);
            return false;
        }

        // Parse headers
        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');
        const contentRange = response.headers.get('content-range');
        const acceptRanges = response.headers.get('accept-ranges');
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');

        // Verify it's video content
        const mime = contentType.split(';')[0].trim().toLowerCase();
        const isVideo = mime.startsWith('video/') ||
                        mime === 'application/octet-stream' ||
                        CapturedVideos.videoExtensions.test(url);

        if (!isVideo) {
            record.fail(`Not video content: ${mime}`);
            return false;
        }

        // Calculate total size
        let totalSize = null;
        if (response.status === 206 && contentRange) {
            // For 206, total size is in Content-Range: bytes 0-1023/12345678
            const match = contentRange.match(/\/(\d+)$/);
            if (match) {
                totalSize = parseInt(match[1]);
            }
        } else if (contentLength) {
            totalSize = parseInt(contentLength);
        }

        // Build validation data
        const headerData = {
            contentType: mime,
            contentLength: totalSize,
            acceptRanges: acceptRanges || (response.status === 206 ? 'bytes' : null),
            etag: etag,
            lastModified: lastModified
        };

        record.validate(headerData);
        record.makeActionable();

        debugLog(`Validation success (${method}): size=${totalSize}, ranges=${headerData.acceptRanges}`);
        return true;

    } catch (error) {
        record.fail(error.message);
        debugLog(`Validation failed: ${error.message}`);
        return false;
    }
}

// =============================================================================
// DOWNLOAD IMPLEMENTATION - Browser-native for progressive MP4
// =============================================================================

/**
 * Download progressive MP4 using chrome.downloads.download
 * This preserves cookies, referer, and handles Range requests properly
 *
 * IMPORTANT: We use the original URL, NOT a blob, to leverage browser's
 * native download handling which preserves HTTP semantics.
 */
async function downloadProgressiveVideo(record, options = {}) {
    const url = record.url;
    const prefix = options.prefix || '';

    let filename = record.getFilename();
    if (prefix) {
        filename = prefix + '_' + filename;
    }

    debugLog(`Downloading progressive video: ${filename}`);
    debugLog(`URL: ${url.substring(0, 100)}...`);

    try {
        // Primary method: chrome.downloads.download with original URL
        // This preserves cookies and allows proper streaming/range behavior
        const downloadId = await chrome.downloads.download({
            url: url,
            filename: filename,
            conflictAction: 'uniquify',
            saveAs: false
        });

        debugLog(`Download started via chrome.downloads: ID=${downloadId}, filename=${filename}`);

        return {
            success: true,
            downloadId: downloadId,
            method: 'chrome.downloads'
        };

    } catch (downloadError) {
        debugLog(`chrome.downloads.download failed: ${downloadError.message}`);

        // Check if it's a permission/access error
        if (downloadError.message.includes('not allowed') ||
            downloadError.message.includes('permission')) {

            // Fallback: Open in new tab for manual save
            // User can right-click > Save video as...
            debugLog('Attempting fallback: open in new tab');

            return {
                success: false,
                method: 'fallback_needed',
                error: downloadError.message,
                fallbackUrl: url,
                message: 'Extension cannot download directly. Open the URL in a new tab and use right-click > Save video as...'
            };
        }

        // For other errors, report failure
        return {
            success: false,
            method: 'failed',
            error: downloadError.message
        };
    }
}

// =============================================================================
// PREVIEW SNIPPET - Fetch partial content for popup preview
// =============================================================================

/**
 * Fetch a preview snippet of video for popup playback
 * Uses Range header to get first N bytes, creates blob URL via offscreen doc
 */
async function fetchPreviewSnippet(url, maxBytes = Config.preview.defaultBytes) {
    debugLog(`Fetching preview snippet: ${maxBytes} bytes from ${url.substring(0, 60)}...`);

    // Cap at maximum
    const bytes = Math.min(maxBytes, Config.preview.maxBytes);

    try {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Range': `bytes=0-${bytes - 1}`
            },
            signal: AbortSignal.timeout(30000)  // 30 second timeout
        });

        if (!response.ok && response.status !== 206) {
            return { error: `HTTP ${response.status}` };
        }

        const contentType = response.headers.get('content-type') || 'video/mp4';
        const buffer = await response.arrayBuffer();

        debugLog(`Preview snippet fetched: ${buffer.byteLength} bytes`);

        // Return buffer and type - popup will create blob URL
        return {
            success: true,
            buffer: buffer,
            contentType: contentType,
            size: buffer.byteLength
        };

    } catch (error) {
        debugLog(`Preview snippet fetch failed: ${error.message}`);
        return { error: error.message };
    }
}

// =============================================================================
// NETWORK REQUEST LISTENER - Capture candidates only
// =============================================================================

chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.tabId < 0) return;
        if (details.statusCode !== 200 && details.statusCode !== 206) return;

        const contentType = details.responseHeaders?.find(
            h => h.name.toLowerCase() === 'content-type'
        )?.value;

        const contentLength = details.responseHeaders?.find(
            h => h.name.toLowerCase() === 'content-length'
        )?.value;

        if (CapturedVideos.isVideoRequest(details.url, contentType)) {
            // Only add as candidate - won't show in UI until play event confirms it
            CapturedVideos.addCandidate(details.tabId, details.url, contentType, contentLength);
        }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
    CapturedVideos.clearTab(tabId);
});

// =============================================================================
// MESSAGE HANDLERS - From content scripts and popup
// =============================================================================

// Handle intercepted videos and play events from content scripts
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === 'video-intercepted' && sender.tab?.id) {
        const tabId = sender.tab.id;
        const url = message.url;

        if (!url || url.startsWith('blob:')) return;

        // Normalize relative URLs
        let absoluteUrl = url;
        if (!url.startsWith('http')) {
            try {
                absoluteUrl = new URL(url, message.tabUrl).href;
            } catch (e) {
                return;
            }
        }

        if (absoluteUrl && CapturedVideos.isVideoRequest(absoluteUrl, null)) {
            // Determine if this is from a play event
            const isPlayEvent = message.source?.includes('video-') ||
                                message.source === 'play-event' ||
                                message.source?.includes('loadeddata') ||
                                message.source?.includes('playing');

            if (isPlayEvent) {
                // This is a confirmed play event - promote to confirmed and validate
                const playEventData = {
                    source: message.source,
                    timestamp: message.observedAt || Date.now(),
                    elementIdHash: message.elementIdHash,
                    duration: message.duration,
                    dimensions: message.dimensions
                };

                const record = CapturedVideos.confirmVideo(tabId, absoluteUrl, playEventData);

                // Validate progressive videos immediately
                if (record && !record.isStream && record.state === VideoState.CONFIRMED) {
                    validateProgressiveVideo(record).catch(err => {
                        debugLog(`Background validation error: ${err.message}`);
                    });
                }
            } else {
                // Just a network interception - add as candidate only
                CapturedVideos.addCandidate(tabId, absoluteUrl, null, null);
            }
        }
    }

    if (message.action === 'mse-detected' && sender.tab?.id) {
        debugLog(`MSE/blob detected on tab ${sender.tab.id} - streaming in use (duration: ${message.duration}, dims: ${message.dimensions})`);
        // The actual stream URL should come from network interception (m3u8/mpd)
    }
});

// =============================================================================
// DOWNLOAD STATE
// =============================================================================

const DownloadState = {
    isRunning: false,
    isPaused: false,
    processed: 0,
    total: 0,
    success: 0,
    skipped: 0,
    duplicates: 0,

    reset() {
        this.isRunning = false;
        this.isPaused = false;
        this.processed = 0;
        this.total = 0;
        this.success = 0;
        this.skipped = 0;
        this.duplicates = 0;
    },

    getStatus() {
        return {
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            processed: this.processed,
            total: this.total,
            success: this.success,
            skipped: this.skipped,
            duplicates: this.duplicates
        };
    }
};

// =============================================================================
// UTILITIES
// =============================================================================

function debugLog(...args) {
    if (Config.debugLogging) {
        console.log('[MediaDownloader]', ...args);
    }
}

const Utils = {
    log(...args) {
        console.log('[MediaDownloader]', ...args);
    },

    normalizeUrl(url) {
        if (!url) return '';
        if (Config.deduplication.ignoreQueryParams) {
            try {
                const parsed = new URL(url);
                return parsed.origin + parsed.pathname;
            } catch {
                return url;
            }
        }
        return url;
    },

    hashUrl(url) {
        return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    },

    createFilename(mediaUrl) {
        let filename = '';

        try {
            const url = new URL(mediaUrl);
            const pathParts = url.pathname.split('/');
            filename = pathParts[pathParts.length - 1].split('?')[0];
        } catch {
            filename = mediaUrl.split('/').pop().split('?')[0];
        }

        // Replace invalid filesystem characters
        filename = filename.replace(/[\/\\?%*:|"<>]/g, '_');

        // Determine if filename has an extension
        if (!filename.includes('.')) {
            const extensions = [
                '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif',
                '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv'
            ];
            const lowerUrl = mediaUrl.toLowerCase();
            const foundExt = extensions.find(ext => lowerUrl.includes(ext));
            if (foundExt) {
                filename += foundExt;
            } else {
                filename += '.mp4';  // Default to mp4 for video
            }
        }

        // Ensure filename has a base name
        const basePart = filename.replace(/\.[^/.]+$/, '');
        if (!filename || filename === '.' || basePart.length < 1) {
            filename = `video_${Math.floor(Math.random() * 10000)}.mp4`;
        }

        // Prepend timestamp if enabled
        if (Config.useTimestampInFilename) {
            const now = new Date();
            const timestamp = [
                now.getFullYear().toString().slice(2),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0'),
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join('');

            filename = `${timestamp}_${filename}`;
        }

        return filename;
    },

    detectMimeType(bytes) {
        const signatures = [
            // Images
            { bytes: [0xFF, 0xD8], mime: 'image/jpeg' },
            { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: 'image/png' },
            { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], mime: 'image/webp' },
            { bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C], mime: 'image/svg+xml' },
            { bytes: [0x3C, 0x73, 0x76, 0x67], mime: 'image/svg+xml' },
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x66, 0x74, 0x79, 0x70], mime: 'image/avif' },
            { bytes: [0x42, 0x4D], mime: 'image/bmp' },
            // Videos
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
            { bytes: [0x1A, 0x45, 0xDF, 0xA3], mime: 'video/webm' },
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x41, 0x56, 0x49, 0x20], mime: 'video/avi' },
            { bytes: [0x4F, 0x67, 0x67, 0x53], mime: 'video/ogg' },
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x71, 0x74, 0x20, 0x20], mime: 'video/quicktime' }
        ];

        for (const sig of signatures) {
            const offset = sig.offset || 0;
            const matchBytes = sig.match || sig.bytes;

            if (bytes.length >= offset + matchBytes.length) {
                const matches = matchBytes.every((byte, i) => bytes[offset + i] === byte);
                if (matches && (!sig.offset || sig.bytes.every((byte, i) => bytes[i] === byte))) {
                    return sig.mime;
                }
            }
        }

        return 'application/octet-stream';
    },

    updateExtension(filename, mimeType) {
        const extensionMap = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
            'image/avif': '.avif',
            'image/bmp': '.bmp',
            'video/mp4': '.mp4',
            'video/webm': '.webm',
            'video/x-matroska': '.mkv',
            'video/mkv': '.mkv',
            'video/avi': '.avi',
            'video/x-msvideo': '.avi',
            'video/ogg': '.ogv',
            'video/quicktime': '.mov'
        };

        const extension = extensionMap[mimeType] || (mimeType?.startsWith('video/') ? '.mp4' : '.jpg');
        const baseName = filename.replace(/\.[^/.]+$/, '');
        return baseName + extension;
    }
};

// =============================================================================
// HLS PARSER AND DOWNLOADER (preserved from original)
// =============================================================================

const HLS = {
    parseManifest(manifestText, baseUrl) {
        const lines = manifestText.split('\n').map(l => l.trim()).filter(Boolean);
        const result = {
            isValid: lines[0]?.includes('#EXTM3U'),
            isMaster: false,
            isDRM: false,
            isAES128: false,
            drmMethod: null,
            keyUri: null,
            keyIv: null,
            segments: [],
            variants: [],
            totalDuration: 0
        };

        if (!result.isValid) return result;

        let currentKeyUri = null;
        let currentKeyIv = null;
        let currentKeyMethod = null;

        for (const line of lines) {
            if (line.includes('#EXT-X-KEY:')) {
                const methodMatch = line.match(/METHOD=([^,]+)/);
                if (methodMatch) {
                    const method = methodMatch[1].toUpperCase();

                    if (method === 'NONE') {
                        currentKeyUri = null;
                        currentKeyIv = null;
                        currentKeyMethod = null;
                    } else if (method === 'AES-128') {
                        result.isAES128 = true;
                        currentKeyMethod = method;

                        const uriMatch = line.match(/URI="([^"]+)"/);
                        if (uriMatch) {
                            currentKeyUri = this.resolveUrl(uriMatch[1], baseUrl);
                            result.keyUri = currentKeyUri;
                        }

                        const ivMatch = line.match(/IV=([^,\s]+)/);
                        if (ivMatch) {
                            currentKeyIv = ivMatch[1];
                            result.keyIv = currentKeyIv;
                        }
                    } else {
                        result.isDRM = true;
                        result.drmMethod = method;
                    }
                }
            }
        }

        const hasMasterTags = lines.some(l => l.includes('#EXT-X-STREAM-INF:'));

        if (hasMasterTags) {
            result.isMaster = true;
            result.variants = this.parseMasterPlaylist(lines, baseUrl);
            return result;
        }

        let currentDuration = 0;
        let segmentIndex = 0;

        currentKeyUri = result.keyUri;
        currentKeyIv = result.keyIv;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.includes('#EXT-X-KEY:')) {
                const methodMatch = line.match(/METHOD=([^,]+)/);
                if (methodMatch) {
                    const method = methodMatch[1].toUpperCase();
                    if (method === 'NONE') {
                        currentKeyUri = null;
                        currentKeyIv = null;
                    } else if (method === 'AES-128') {
                        const uriMatch = line.match(/URI="([^"]+)"/);
                        if (uriMatch) {
                            currentKeyUri = this.resolveUrl(uriMatch[1], baseUrl);
                        }
                        const ivMatch = line.match(/IV=([^,\s]+)/);
                        currentKeyIv = ivMatch ? ivMatch[1] : null;
                    }
                }
            }

            if (line.startsWith('#EXTINF:')) {
                currentDuration = parseFloat(line.split(':')[1].split(',')[0]) || 0;
                result.totalDuration += currentDuration;
            }

            if (!line.startsWith('#') && currentDuration > 0) {
                const segmentUrl = this.resolveUrl(line, baseUrl);
                result.segments.push({
                    url: segmentUrl,
                    duration: currentDuration,
                    index: segmentIndex,
                    encrypted: !!currentKeyUri,
                    keyUri: currentKeyUri,
                    iv: currentKeyIv || `0x${segmentIndex.toString(16).padStart(32, '0')}`
                });
                currentDuration = 0;
                segmentIndex++;
            }
        }

        return result;
    },

    parseMasterPlaylist(lines, baseUrl) {
        const variants = [];
        let currentVariant = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                currentVariant = { bandwidth: 0, resolution: null, url: null };

                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                if (bwMatch) currentVariant.bandwidth = parseInt(bwMatch[1]);

                const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                if (resMatch) currentVariant.resolution = resMatch[1];
            } else if (currentVariant && !line.startsWith('#')) {
                currentVariant.url = this.resolveUrl(line, baseUrl);
                variants.push(currentVariant);
                currentVariant = null;
            }
        }

        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return variants;
    },

    resolveUrl(url, baseUrl) {
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        try {
            return new URL(url, baseUrl).href;
        } catch {
            return url;
        }
    },

    estimateSize(manifest) {
        if (manifest.isMaster && manifest.variants.length > 0) {
            const bitrate = manifest.variants[0].bandwidth;
            return Math.round((bitrate / 8) * manifest.totalDuration);
        }
        return Math.round((1000000 / 8) * manifest.totalDuration);
    },

    formatBitrate(bps) {
        if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
        return Math.round(bps / 1000) + ' Kbps';
    }
};

// Offscreen document management
let offscreenCreating = null;

async function ensureOffscreenDocument() {
    const offscreenUrl = 'offscreen.html';

    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(offscreenUrl)]
    });

    if (existingContexts.length > 0) {
        return;
    }

    if (offscreenCreating) {
        await offscreenCreating;
        return;
    }

    offscreenCreating = chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: ['BLOBS', 'DOM_SCRAPING'],
        justification: 'Download and assemble HLS video segments, create preview blobs'
    });

    await offscreenCreating;
    offscreenCreating = null;
}

async function fetchEncryptionKey(keyUri, tabId) {
    try {
        const result = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (url) => {
                try {
                    const response = await fetch(url, { credentials: 'include' });
                    if (!response.ok) return { error: `HTTP ${response.status}` };
                    const buffer = await response.arrayBuffer();
                    return { key: Array.from(new Uint8Array(buffer)) };
                } catch (err) {
                    return { error: err.message };
                }
            },
            args: [keyUri]
        });

        const data = result?.[0]?.result;
        if (data?.error) {
            return { error: data.error };
        }
        if (data?.key) {
            return { key: new Uint8Array(data.key) };
        }
        return { error: 'Failed to fetch key' };
    } catch (err) {
        return { error: err.message };
    }
}

async function downloadHLSStream(manifestUrl, filename, tabId) {
    debugLog(`Downloading HLS stream: ${manifestUrl}`);

    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
            return { error: 'No active tab' };
        }

        const manifestResult = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            world: 'MAIN',
            func: async (url) => {
                try {
                    const response = await fetch(url, { credentials: 'include' });
                    if (!response.ok) return { error: `HTTP ${response.status}` };
                    return { text: await response.text(), finalUrl: response.url };
                } catch (err) {
                    return { error: err.message };
                }
            },
            args: [manifestUrl]
        });

        const manifestData = manifestResult?.[0]?.result;
        if (!manifestData || manifestData.error) {
            return { error: `Failed to fetch manifest: ${manifestData?.error || 'Unknown'}` };
        }

        let manifest = HLS.parseManifest(manifestData.text, manifestData.finalUrl);

        if (manifest.isDRM) {
            return { error: `Protected content (${manifest.drmMethod}) - cannot download` };
        }

        if (manifest.isMaster && manifest.variants.length > 0) {
            const bestVariant = manifest.variants[0];
            debugLog(`Master playlist detected, selecting: ${bestVariant.resolution || 'best'} @ ${HLS.formatBitrate(bestVariant.bandwidth)}`);

            const variantResult = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                world: 'MAIN',
                func: async (url) => {
                    try {
                        const response = await fetch(url, { credentials: 'include' });
                        if (!response.ok) return { error: `HTTP ${response.status}` };
                        return { text: await response.text(), finalUrl: response.url };
                    } catch (err) {
                        return { error: err.message };
                    }
                },
                args: [bestVariant.url]
            });

            const variantData = variantResult?.[0]?.result;
            if (!variantData || variantData.error) {
                return { error: `Failed to fetch variant: ${variantData?.error || 'Unknown'}` };
            }

            manifest = HLS.parseManifest(variantData.text, variantData.finalUrl);
        }

        if (manifest.segments.length === 0) {
            return { error: 'No segments found in manifest' };
        }

        debugLog(`Found ${manifest.segments.length} segments, total duration: ${manifest.totalDuration.toFixed(1)}s`);

        let decryptionKey = null;
        if (manifest.isAES128 && manifest.keyUri) {
            debugLog(`Stream is AES-128 encrypted, fetching key from: ${manifest.keyUri}`);
            const keyResult = await fetchEncryptionKey(manifest.keyUri, activeTab.id);

            if (keyResult.error) {
                debugLog(`Failed to fetch encryption key: ${keyResult.error}`);
                return { error: `Encrypted stream - key not accessible (${keyResult.error})` };
            }

            decryptionKey = keyResult.key;
            debugLog('Encryption key fetched successfully');
        }

        await ensureOffscreenDocument();

        const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'download-hls',
            data: {
                segments: manifest.segments,
                filename: filename,
                tabId: tabId,
                decryptionKey: decryptionKey ? Array.from(decryptionKey) : null
            }
        });

        if (!result || result.error) {
            return { error: result?.error || 'Download failed' };
        }

        debugLog(`HLS download complete: ${result.segments} segments, ${(result.size / 1024 / 1024).toFixed(1)} MB${result.failed ? `, ${result.failed} failed` : ''}`);
        return result;

    } catch (err) {
        debugLog('HLS download error:', err);
        return { error: err.message };
    }
}

// =============================================================================
// PERCEPTUAL HASH (preserved)
// =============================================================================

const PerceptualHash = {
    async generate(arrayBuffer) {
        if (!Config.deduplication.perceptualHash.enabled) {
            return null;
        }

        try {
            const hashSize = 8;
            const sampleSize = 32;

            const blob = new Blob([arrayBuffer]);
            const imageBitmap = await createImageBitmap(blob);

            const canvas = new OffscreenCanvas(sampleSize, sampleSize);
            const ctx = canvas.getContext('2d');

            ctx.drawImage(imageBitmap, 0, 0, sampleSize, sampleSize);
            imageBitmap.close();

            const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
            const pixels = imageData.data;
            const grayscale = [];

            for (let i = 0; i < pixels.length; i += 4) {
                const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
                grayscale.push(gray);
            }

            const blockSize = sampleSize / hashSize;
            const hashPixels = [];

            for (let y = 0; y < hashSize; y++) {
                for (let x = 0; x < hashSize; x++) {
                    let sum = 0;
                    let count = 0;
                    for (let by = 0; by < blockSize; by++) {
                        for (let bx = 0; bx < blockSize; bx++) {
                            const idx = (y * blockSize + by) * sampleSize + (x * blockSize + bx);
                            sum += grayscale[idx];
                            count++;
                        }
                    }
                    hashPixels.push(sum / count);
                }
            }

            const average = hashPixels.reduce((a, b) => a + b, 0) / hashPixels.length;

            let hash = '';
            for (const pixel of hashPixels) {
                hash += pixel > average ? '1' : '0';
            }

            const hexHash = BigInt('0b' + hash).toString(16).padStart(16, '0');
            return hexHash;

        } catch (error) {
            debugLog('Perceptual hash error:', error);
            return null;
        }
    },

    hammingDistance(hash1, hash2) {
        if (!hash1 || !hash2 || hash1.length !== hash2.length) {
            return Infinity;
        }

        try {
            const bin1 = BigInt('0x' + hash1);
            const bin2 = BigInt('0x' + hash2);
            const xor = bin1 ^ bin2;

            let distance = 0;
            let val = xor;
            while (val > 0n) {
                distance += Number(val & 1n);
                val >>= 1n;
            }
            return distance;
        } catch {
            return Infinity;
        }
    },

    isSimilar(hash1, hash2) {
        const distance = this.hammingDistance(hash1, hash2);
        return distance <= Config.deduplication.perceptualHash.hammingThreshold;
    }
};

// =============================================================================
// DOWNLOAD HISTORY (preserved)
// =============================================================================

const DownloadHistory = {
    cache: new Map(),
    perceptualCache: new Map(),
    loaded: false,

    async load() {
        if (this.loaded) return;

        try {
            const result = await chrome.storage.local.get(null);
            const prefix = Config.deduplication.storageKeyPrefix;
            const cutoffTime = Date.now() - (Config.deduplication.timeframeDays * 24 * 60 * 60 * 1000);
            const toDelete = [];

            for (const [key, value] of Object.entries(result)) {
                if (!key.startsWith(prefix)) continue;

                try {
                    const data = typeof value === 'string' ? JSON.parse(value) : value;

                    if (data.timestamp < cutoffTime) {
                        toDelete.push(key);
                        continue;
                    }

                    const urlKey = key.substring(prefix.length);
                    this.cache.set(urlKey, data);

                    if (data.perceptualHash) {
                        this.perceptualCache.set(data.perceptualHash, data);
                    }
                } catch { /* Ignore corrupt entries */ }
            }

            if (toDelete.length > 0) {
                await chrome.storage.local.remove(toDelete);
                debugLog(`Cleaned up ${toDelete.length} old entries`);
            }

            this.loaded = true;
            debugLog(`Loaded ${this.cache.size} items in download history`);

        } catch (error) {
            debugLog('Error loading history:', error);
        }
    },

    isDuplicateUrl(url) {
        if (!Config.deduplication.enabled || !url) return false;
        const normalizedUrl = Utils.normalizeUrl(url);
        const urlKey = Utils.hashUrl(normalizedUrl);
        return this.cache.has(urlKey);
    },

    findPerceptualDuplicate(pHash) {
        if (!Config.deduplication.perceptualHash.enabled || !pHash) {
            return null;
        }

        if (this.perceptualCache.has(pHash)) {
            return this.perceptualCache.get(pHash);
        }

        for (const [hash, data] of this.perceptualCache.entries()) {
            if (PerceptualHash.isSimilar(pHash, hash)) {
                return data;
            }
        }

        return null;
    },

    checkDuplicate(url, perceptualHash = null) {
        if (!Config.deduplication.enabled) {
            return { isDuplicate: false, reason: null };
        }

        if (this.isDuplicateUrl(url)) {
            return { isDuplicate: true, reason: 'url' };
        }

        if (perceptualHash) {
            const entry = this.findPerceptualDuplicate(perceptualHash);
            if (entry) {
                return { isDuplicate: true, reason: 'content' };
            }
        }

        return { isDuplicate: false, reason: null };
    },

    async add(url, filename, perceptualHash = null) {
        if (!Config.deduplication.enabled || !url) return;

        const normalizedUrl = Utils.normalizeUrl(url);
        const urlKey = Utils.hashUrl(normalizedUrl);

        const entry = {
            originalUrl: url,
            filename: filename,
            timestamp: Date.now(),
            perceptualHash: perceptualHash
        };

        this.cache.set(urlKey, entry);

        if (perceptualHash) {
            this.perceptualCache.set(perceptualHash, entry);
        }

        try {
            await chrome.storage.local.set({
                [Config.deduplication.storageKeyPrefix + urlKey]: entry
            });
        } catch (error) {
            debugLog('Error saving to storage:', error);
        }
    },

    async clear() {
        try {
            const result = await chrome.storage.local.get(null);
            const prefix = Config.deduplication.storageKeyPrefix;
            const toDelete = Object.keys(result).filter(key => key.startsWith(prefix));

            await chrome.storage.local.remove(toDelete);
            this.cache.clear();
            this.perceptualCache.clear();

            debugLog(`Cleared ${toDelete.length} entries`);
        } catch (error) {
            debugLog('Error clearing history:', error);
        }
    }
};

// =============================================================================
// DOWNLOAD MANAGER (preserved for images, enhanced for videos)
// =============================================================================

const DownloadManager = {
    async downloadFromTab(tabId, options = {}) {
        const closeTab = options.closeTabs !== undefined ? options.closeTabs : true;
        const skipDuplicates = options.skipDuplicates !== undefined ? options.skipDuplicates : true;
        const prefix = options.prefix || '';
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const Config = {
                        minImageDimension: 50,
                        parentTraversalDepth: 5,
                        handleBackgroundImages: true
                    };

                    function isVisible(element) {
                        if (!element) return false;
                        const style = getComputedStyle(element);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                            return false;
                        }
                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }

                    function ensureAbsoluteUrl(url) {
                        if (!url) return url;
                        if (url.startsWith('//')) return window.location.protocol + url;
                        if (url.startsWith('/')) return window.location.origin + url;
                        return url;
                    }

                    function getBestImageVersion(imgElement) {
                        if (!imgElement?.src) return null;

                        let bestSrc = imgElement.src;
                        let bestWidth = imgElement.naturalWidth || 0;

                        if (imgElement.srcset) {
                            const srcsetItems = imgElement.srcset.split(',');
                            for (const item of srcsetItems) {
                                const parts = item.trim().split(/\s+/);
                                if (parts.length >= 2) {
                                    const itemUrl = parts[0];
                                    const descriptor = parts[parts.length - 1];

                                    if (descriptor.endsWith('w')) {
                                        const width = parseInt(descriptor);
                                        if (width > bestWidth) {
                                            bestWidth = width;
                                            bestSrc = itemUrl;
                                        }
                                    } else if (descriptor.endsWith('x')) {
                                        const density = parseFloat(descriptor);
                                        const effectiveWidth = (imgElement.naturalWidth || 100) * density;
                                        if (effectiveWidth > bestWidth) {
                                            bestWidth = effectiveWidth;
                                            bestSrc = itemUrl;
                                        }
                                    }
                                }
                            }
                        }

                        const highQualityAttrs = [
                            'data-src', 'data-original', 'data-orig-file', 'data-large-file',
                            'data-full-src', 'data-zoom-src', 'data-large', 'data-1000px'
                        ];

                        for (const attr of highQualityAttrs) {
                            const val = imgElement.getAttribute(attr);
                            if (val?.trim() && (val.startsWith('http') || val.startsWith('/'))) {
                                bestSrc = val;
                                break;
                            }
                        }

                        const parentLink = imgElement.closest('a');
                        if (parentLink?.href && /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(parentLink.href)) {
                            bestSrc = parentLink.href;
                        }

                        return ensureAbsoluteUrl(bestSrc);
                    }

                    function getBackgroundImage(element) {
                        if (!element) return null;
                        try {
                            const style = getComputedStyle(element);
                            if (style.backgroundImage && style.backgroundImage !== 'none') {
                                const match = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                                if (match?.[1]) {
                                    return ensureAbsoluteUrl(match[1]);
                                }
                            }
                        } catch {}
                        return null;
                    }

                    function looksLikeVideo(url) {
                        return /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(url);
                    }

                    function isDirectUrl(url) {
                        return url && !url.startsWith('blob:') && !url.startsWith('data:') && !/\.(m3u8|mpd)(\?|$)/i.test(url);
                    }

                    function findBestVideo() {
                        if (document.contentType?.startsWith('video/') || document.contentType === 'application/octet-stream') {
                            return window.location.href;
                        }

                        const candidates = [];
                        const videos = Array.from(document.querySelectorAll('video'));
                        for (const video of videos) {
                            const src = video.getAttribute('src');
                            if (src && isDirectUrl(src) && looksLikeVideo(src)) {
                                candidates.push(src);
                            }
                            video.querySelectorAll('source').forEach(source => {
                                const ssrc = source.getAttribute('src');
                                if (ssrc && isDirectUrl(ssrc) && looksLikeVideo(ssrc)) {
                                    candidates.push(ssrc);
                                }
                            });
                        }

                        document.querySelectorAll('[data-video-src], [data-src]').forEach(el => {
                            const url = el.getAttribute('data-video-src') || el.getAttribute('data-src');
                            if (url && looksLikeVideo(url) && isDirectUrl(url)) {
                                candidates.push(url);
                            }
                        });

                        for (const url of candidates) {
                            return ensureAbsoluteUrl(url);
                        }
                        return null;
                    }

                    function findBestImage() {
                        const potentialSources = [];

                        if (document.contentType?.startsWith('image/')) {
                            return window.location.href;
                        }

                        const allImages = Array.from(document.querySelectorAll('img'));
                        const visibleImages = allImages.filter(img =>
                            isVisible(img) &&
                            img.naturalWidth > Config.minImageDimension &&
                            img.naturalHeight > Config.minImageDimension
                        );

                        visibleImages.sort((a, b) =>
                            (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)
                        );

                        for (const img of visibleImages) {
                            const url = getBestImageVersion(img);
                            if (url) {
                                potentialSources.push({ url, priority: 100 });
                            }
                        }

                        const gallerySelectors = [
                            '.pswp__item:not([aria-hidden="true"]) img',
                            '.pswp__zoom-wrap img',
                            '.pswp__img',
                            '.lg-current img',
                            '.lg-img-wrap img',
                            '.fancybox-image',
                            '.mfp-img'
                        ];

                        for (const selector of gallerySelectors) {
                            const img = document.querySelector(selector);
                            if (img) {
                                const url = getBestImageVersion(img);
                                if (url) {
                                    potentialSources.push({ url, priority: 150 });
                                }
                            }
                        }

                        if (Config.handleBackgroundImages) {
                            const bgElements = [document.body, document.querySelector('main'), document.querySelector('#content')];
                            for (const el of bgElements) {
                                if (el) {
                                    const bgUrl = getBackgroundImage(el);
                                    if (bgUrl) {
                                        potentialSources.push({ url: bgUrl, priority: 50 });
                                    }
                                }
                            }
                        }

                        potentialSources.sort((a, b) => b.priority - a.priority);

                        const seen = new Set();
                        for (const source of potentialSources) {
                            if (!seen.has(source.url)) {
                                return source.url;
                            }
                        }

                        return null;
                    }

                    function findBestMedia() {
                        const videoUrl = findBestVideo();
                        if (videoUrl) return videoUrl;
                        return findBestImage();
                    }

                    return findBestMedia();
                }
            });

            const mediaUrl = results?.[0]?.result;

            if (!mediaUrl) {
                debugLog(`No media found in tab ${tabId}`);
                return { success: false, reason: 'no_image' };
            }

            debugLog(`Found media in tab ${tabId}:`, mediaUrl);

            await DownloadHistory.load();
            if (skipDuplicates && DownloadHistory.isDuplicateUrl(mediaUrl)) {
                debugLog(`Duplicate URL skipped: ${mediaUrl}`);
                if (closeTab) {
                    await chrome.tabs.remove(tabId);
                }
                return { success: false, reason: 'duplicate_url' };
            }

            const isVideo = /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(mediaUrl);

            if (isVideo) {
                let filename = Utils.createFilename(mediaUrl);
                if (!/\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i.test(filename)) {
                    filename = filename.replace(/\.[^/.]+$/, '') + '.mp4';
                }
                if (prefix) {
                    filename = prefix + '_' + filename;
                }

                // Use browser-native download
                const downloadId = await chrome.downloads.download({
                    url: mediaUrl,
                    filename: filename,
                    saveAs: false
                });
                debugLog(`Video download started: ${filename} (ID: ${downloadId})`);
                await DownloadHistory.add(mediaUrl, filename, null);

                if (closeTab) {
                    setTimeout(async () => {
                        try {
                            await chrome.tabs.remove(tabId);
                            debugLog(`Closed tab ${tabId}`);
                        } catch (error) {
                            debugLog(`Failed to close tab ${tabId}:`, error);
                        }
                    }, Config.closeDelayMs);
                }
                return { success: true };
            }

            // Image download
            const response = await fetch(mediaUrl);
            if (!response.ok) {
                debugLog(`Fetch failed for ${mediaUrl}: ${response.status}`);
                return { success: false, reason: 'fetch_failed' };
            }

            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            const mimeType = Utils.detectMimeType(bytes);

            const perceptualHash = await PerceptualHash.generate(arrayBuffer);

            if (skipDuplicates && perceptualHash) {
                const dupCheck = DownloadHistory.checkDuplicate(mediaUrl, perceptualHash);
                if (dupCheck.isDuplicate && dupCheck.reason === 'content') {
                    debugLog(`Duplicate content skipped: ${mediaUrl}`);
                    if (closeTab) {
                        await chrome.tabs.remove(tabId);
                    }
                    return { success: false, reason: 'duplicate_content' };
                }
            }

            let filename = Utils.createFilename(mediaUrl);
            filename = Utils.updateExtension(filename, mimeType);
            if (prefix) {
                filename = prefix + '_' + filename;
            }

            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, i + chunkSize);
                binary += String.fromCharCode.apply(null, chunk);
            }
            const base64 = btoa(binary);
            const dataUrl = `data:${mimeType};base64,${base64}`;

            const downloadId = await chrome.downloads.download({
                url: dataUrl,
                filename: filename,
                saveAs: false
            });
            debugLog(`Image download started: ${filename} (ID: ${downloadId})`);
            await DownloadHistory.add(mediaUrl, filename, perceptualHash);

            if (closeTab) {
                setTimeout(async () => {
                    try {
                        await chrome.tabs.remove(tabId);
                        debugLog(`Closed tab ${tabId}`);
                    } catch (error) {
                        debugLog(`Failed to close tab ${tabId}:`, error);
                    }
                }, Config.closeDelayMs);
            }
            return { success: true };

        } catch (error) {
            debugLog(`Error downloading from tab ${tabId}:`, error);
            return { success: false, reason: 'error', error: error.message };
        }
    },

    async downloadFromSelectedTabs(options = {}) {
        try {
            const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });

            debugLog(`Processing ${tabs.length} selected tab(s)`);

            if (tabs.length === 0) {
                return { processed: 0, success: 0, skipped: 0 };
            }

            DownloadState.reset();
            DownloadState.isRunning = true;
            DownloadState.total = tabs.length;

            const effectiveOptions = {
                ...options,
                closeTabs: tabs.length > 1 ? options.closeTabs : false
            };

            const interval = options.interval || 100;

            for (let i = 0; i < tabs.length; i++) {
                while (DownloadState.isPaused && DownloadState.isRunning) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                if (!DownloadState.isRunning) {
                    debugLog('Download cancelled');
                    break;
                }

                const result = await this.downloadFromTab(tabs[i].id, effectiveOptions);

                DownloadState.processed++;
                if (result.success) {
                    DownloadState.success++;
                } else {
                    DownloadState.skipped++;
                    if (result.reason?.startsWith('duplicate')) {
                        DownloadState.duplicates++;
                    }
                }

                if (interval > 0 && i < tabs.length - 1 && DownloadState.isRunning) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                }
            }

            const stats = {
                processed: DownloadState.processed,
                success: DownloadState.success,
                skipped: DownloadState.skipped,
                duplicates: DownloadState.duplicates,
                cancelled: !DownloadState.isRunning && DownloadState.processed < DownloadState.total
            };

            DownloadState.reset();
            debugLog('Batch complete:', stats);
            return stats;

        } catch (error) {
            DownloadState.reset();
            debugLog('Error processing selected tabs:', error);
            return { processed: 0, success: 0, skipped: 0, error: error.message };
        }
    },

    async downloadFromCurrentTab(options = {}) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) {
                debugLog('No active tab found');
                return { success: false, reason: 'no_tab' };
            }

            const effectiveOptions = {
                ...options,
                closeTabs: false
            };

            return await this.downloadFromTab(tab.id, effectiveOptions);

        } catch (error) {
            debugLog('Error downloading from current tab:', error);
            return { success: false, reason: 'error', error: error.message };
        }
    }
};

// =============================================================================
// VIDEO SCAN AND DOWNLOAD FUNCTIONS
// =============================================================================

/**
 * Scan for videos from specified tabs
 * Returns only actionable videos by default
 */
async function scanVideosFromTabs(tabIds, includeUnconfirmed = false) {
    const actionableVideos = [];
    const candidateVideos = [];
    const seenDedupeKeys = new Set();

    for (const tabId of tabIds) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const hostname = tab.url ? new URL(tab.url).hostname : 'unknown';

            // Get actionable videos (confirmed + validated)
            const actionable = CapturedVideos.getActionableForTab(tabId);
            for (const record of actionable) {
                // Dedupe by compound key
                const key = record.dedupeKey || record.url;
                if (!seenDedupeKeys.has(key)) {
                    seenDedupeKeys.add(key);
                    actionableVideos.push({
                        ...record.toObject(),
                        source: hostname,
                        origin: 'actionable',
                        verified: true
                    });
                }
            }

            // Optionally include candidates (unconfirmed)
            if (includeUnconfirmed) {
                const candidates = CapturedVideos.getCandidatesForTab(tabId);
                for (const record of candidates) {
                    const key = record.url;
                    if (!seenDedupeKeys.has(key)) {
                        seenDedupeKeys.add(key);
                        candidateVideos.push({
                            ...record.toObject(),
                            source: hostname,
                            origin: 'candidate',
                            verified: false
                        });
                    }
                }
            }

        } catch (error) {
            debugLog(`Error scanning tab ${tabId}:`, error);
        }
    }

    // Sort: actionable first, then by capture time
    actionableVideos.sort((a, b) => (b.confirmedAt || b.capturedAt) - (a.confirmedAt || a.capturedAt));

    debugLog(`Scan complete: ${actionableVideos.length} actionable, ${candidateVideos.length} candidates`);

    return {
        videos: actionableVideos,
        candidates: candidateVideos
    };
}

/**
 * Download specific videos by URL
 * Uses browser-native download for progressive, offscreen for HLS
 */
async function downloadSpecificVideos(videos, options = {}) {
    const interval = options.interval || 500;
    const prefix = options.prefix || '';

    DownloadState.reset();
    DownloadState.isRunning = true;
    DownloadState.total = videos.length;

    let streamCount = 0;

    debugLog(`Starting download of ${videos.length} videos`);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
        DownloadState.reset();
        return { error: 'No active tab' };
    }

    for (const video of videos) {
        if (!DownloadState.isRunning) break;

        while (DownloadState.isPaused && DownloadState.isRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!DownloadState.isRunning) break;

        const videoUrl = typeof video === 'string' ? video : video.url;
        const isStream = typeof video === 'object' && video.isStream;

        try {
            let filename = Utils.createFilename(videoUrl);
            if (prefix) filename = prefix + '_' + filename;

            if (isStream || /\.m3u8(\?|#|$)/i.test(videoUrl)) {
                debugLog(`Downloading HLS stream: ${filename}`);

                const hlsResult = await downloadHLSStream(videoUrl, filename, activeTab.id);

                if (hlsResult.error) {
                    debugLog(`HLS download failed: ${hlsResult.error}`);
                    DownloadState.processed++;
                    DownloadState.skipped++;
                } else {
                    debugLog(`HLS download complete: ${hlsResult.segments} segments, ${(hlsResult.size / 1024 / 1024).toFixed(1)} MB`);
                    DownloadState.processed++;
                    DownloadState.success++;
                    streamCount++;
                }
            } else {
                // Progressive video - use browser-native download
                debugLog(`Downloading progressive: ${filename}`);

                const downloadResult = await downloadProgressiveVideo(
                    { url: videoUrl, getFilename: () => filename },
                    { prefix }
                );

                if (downloadResult.success) {
                    debugLog(`Download started: ${filename}`);
                    DownloadState.processed++;
                    DownloadState.success++;
                } else {
                    debugLog(`Download failed: ${downloadResult.error}`);
                    DownloadState.processed++;
                    DownloadState.skipped++;
                }
            }

        } catch (error) {
            debugLog(`Error downloading ${videoUrl}:`, error.message);
            DownloadState.processed++;
            DownloadState.skipped++;
        }

        if (DownloadState.isRunning && DownloadState.processed < videos.length) {
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }

    const result = {
        success: DownloadState.success,
        skipped: DownloadState.skipped,
        duplicates: DownloadState.duplicates,
        streams: streamCount,
        total: DownloadState.total,
        cancelled: !DownloadState.isRunning
    };

    DownloadState.reset();
    return result;
}

/**
 * Manually validate a candidate video (for "Validate candidates" button)
 */
async function validateCandidateVideo(tabId, url) {
    const record = CapturedVideos.getByUrl(tabId, url);
    if (!record) {
        return { error: 'Video not found' };
    }

    if (record.state === VideoState.ACTIONABLE) {
        return { success: true, already: true };
    }

    // First confirm it (treat manual validation as confirming)
    if (record.state === VideoState.CANDIDATE) {
        record.confirm({
            source: 'manual-validation',
            timestamp: Date.now()
        });
    }

    // Then validate
    const success = await validateProgressiveVideo(record);

    return {
        success: success,
        state: record.state,
        failureReason: record.failureReason
    };
}

// =============================================================================
// MESSAGE HANDLERS FROM POPUP
// =============================================================================

async function getStoredOptions() {
    try {
        const result = await chrome.storage.local.get(['closeTabs', 'skipDuplicates', 'interval', 'prefix']);
        return {
            closeTabs: result.closeTabs !== undefined ? result.closeTabs : true,
            skipDuplicates: result.skipDuplicates !== undefined ? result.skipDuplicates : true,
            interval: result.interval !== undefined ? result.interval : 500,
            prefix: result.prefix || ''
        };
    } catch {
        return { closeTabs: true, skipDuplicates: true, interval: 500, prefix: '' };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    debugLog('Message received:', message.action);

    (async () => {
        try {
            if (message.action === 'download-selected-tabs') {
                const result = await DownloadManager.downloadFromSelectedTabs(message.options);
                sendResponse(result);
            } else if (message.action === 'download-current-tab') {
                const result = await DownloadManager.downloadFromCurrentTab(message.options);
                sendResponse(result);
            } else if (message.action === 'pause') {
                DownloadState.isPaused = true;
                debugLog('Download paused');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'resume') {
                DownloadState.isPaused = false;
                debugLog('Download resumed');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'cancel') {
                DownloadState.isRunning = false;
                DownloadState.isPaused = false;
                debugLog('Download cancelled');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'get-status') {
                sendResponse(DownloadState.getStatus());
            } else if (message.action === 'scan-videos') {
                // Enhanced scan with state machine
                const includeUnconfirmed = message.includeUnconfirmed || false;
                const result = await scanVideosFromTabs(message.tabIds, includeUnconfirmed);
                sendResponse(result);
            } else if (message.action === 'download-specific-videos') {
                const videos = message.videos || message.urls?.map(url => ({ url, isStream: false }));
                const result = await downloadSpecificVideos(videos, message.options);
                sendResponse(result);
            } else if (message.action === 'validate-candidate') {
                const result = await validateCandidateVideo(message.tabId, message.url);
                sendResponse(result);
            } else if (message.action === 'fetch-preview-snippet') {
                const result = await fetchPreviewSnippet(message.url, message.maxBytes);
                // Convert ArrayBuffer to array for messaging
                if (result.buffer) {
                    result.buffer = Array.from(new Uint8Array(result.buffer));
                }
                sendResponse(result);
            } else if (message.action === 'hls-progress') {
                debugLog(`HLS progress: ${message.status} - ${message.current}/${message.total}`);
            } else {
                sendResponse({ error: 'Unknown action' });
            }
        } catch (error) {
            debugLog('Message handler error:', error);
            sendResponse({ error: error.message });
        }
    })();

    return true; // Keep channel open for async response
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
    debugLog(`Command received: ${command}`);

    const options = await getStoredOptions();

    if (command === 'download-selected-tabs') {
        await DownloadManager.downloadFromSelectedTabs(options);
    } else if (command === 'download-current-tab') {
        await DownloadManager.downloadFromCurrentTab(options);
    }
});

// Initialize on install/update
chrome.runtime.onInstalled.addListener(async () => {
    debugLog('Extension installed/updated');
    await DownloadHistory.load();
});

// Load history on startup
chrome.runtime.onStartup.addListener(async () => {
    debugLog('Extension started');
    await DownloadHistory.load();
});

debugLog('Media Downloader extension loaded');

// =============================================================================
// MANUAL TEST PLAN
// =============================================================================
/*
 * TEST PLAN: Play-Gated Video Detection and Download
 *
 * Test Environment:
 * - Use a page that lists multiple videos but only loads each after clicking play
 *   (e.g., a video gallery, social media feed, or video hosting site)
 * - Enable debug logging: Config.debugLogging = true (already enabled by default)
 *
 * Test Steps:
 *
 * 1. CANDIDATE DETECTION
 *    - Navigate to a page with multiple unplayed videos
 *    - Open extension popup and click "Videos" mode, then "List videos"
 *    - EXPECTED: Video list should be empty or show only "unconfirmed" section
 *    - Check console logs: Should see "[MediaDownloader] Candidate added..." for network requests
 *    - NO videos should appear in main actionable list yet
 *
 * 2. PLAY-GATED PROMOTION
 *    - Click play on one video on the page
 *    - Wait 2-3 seconds for detection and validation
 *    - Check console logs for:
 *      - "[MediaDownloader] Video confirmed: ..."
 *      - "[MediaDownloader] Validating video: ..."
 *      - "[MediaDownloader] Validation success..."
 *      - "[MediaDownloader] Video actionable: ..."
 *    - Refresh the extension popup and list videos again
 *    - EXPECTED: The played video should now appear with "actionable" state
 *
 * 3. PREVIEW TEST
 *    - Click the preview (play) button on an actionable video
 *    - EXPECTED: Preview should load within popup (2MB snippet)
 *    - If CORS blocks popup playback, should see graceful failure message
 *    - Check logs for: "[MediaDownloader] Fetching preview snippet..."
 *
 * 4. DOWNLOAD TEST
 *    - Select an actionable video
 *    - Click Download
 *    - EXPECTED: Browser's native download manager should show download
 *    - Check logs for: "[MediaDownloader] Downloading progressive video..."
 *    - File should complete successfully
 *    - Compare with right-click > Save video as: should produce identical file
 *
 * 5. MULTIPLE VIDEOS TEST
 *    - Play a second video on the same page
 *    - Refresh popup and list videos
 *    - EXPECTED: Both videos should appear, no duplicates
 *    - Check that dedupe keys are properly computed (logs show dedupeKey)
 *
 * 6. STREAM DETECTION TEST
 *    - Navigate to a page using HLS streams
 *    - Play a video
 *    - EXPECTED: Video should be detected as stream (isStream: true)
 *    - Stream badge should appear in UI
 *    - HLS download path should be used
 *
 * 7. FAILURE HANDLING TEST
 *    - Try to download a video that requires authentication
 *    - EXPECTED: Should fail gracefully with clear error message
 *    - Check logs for: "[MediaDownloader] Video failed: ..."
 *
 * Debug Commands (run in service worker console):
 * - CapturedVideos.byTab - View all captured video records by tab
 * - CapturedVideos.getActionableForTab(tabId) - Get actionable videos for a tab
 * - Config.debugLogging = true/false - Toggle verbose logging
 */
