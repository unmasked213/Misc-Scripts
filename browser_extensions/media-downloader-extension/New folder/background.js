/**
 * Media Downloader Extension - Background Service Worker
 * 
 * v1.8 - Download Manager Tab Pattern
 * 
 * Key change: Video downloads now open a dedicated extension tab that
 * handles the actual fetching. This bypasses CORS because the tab runs
 * with extension host permissions, not page context restrictions.
 * 
 * VIDEO RECORD STATE MACHINE:
 * - candidate: URL seen via webRequest but not confirmed playing
 * - confirmed: Play event observed with stable currentSrc
 * - validated: Header probe confirmed accessible
 * - actionable: Ready for UI with preview/download
 * - failed: Validation failed or unsupported
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const Config = {
    closeTabAfterDownload: true,
    useTimestampInFilename: true,
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

    closeDelayMs: 500,

    preview: {
        defaultBytes: 2 * 1024 * 1024,
        maxBytes: 5 * 1024 * 1024
    },

    validation: {
        timeoutMs: 10000,
        minRangeBytes: 1024
    }
};

function debugLog(...args) {
    if (Config.debugLogging) {
        console.log('[MediaDownloader]', ...args);
    }
}

// =============================================================================
// VIDEO STATE MACHINE
// =============================================================================

const VideoState = {
    CANDIDATE: 'candidate',
    CONFIRMED: 'confirmed',
    VALIDATED: 'validated',
    ACTIONABLE: 'actionable',
    FAILED: 'failed'
};

class VideoRecord {
    constructor(url, tabId, source = 'network') {
        this.id = this.generateId(url, tabId);
        this.url = url;
        this.tabId = tabId;
        this.pageUrl = null;
        this.state = VideoState.CANDIDATE;
        this.source = source;
        this.contentType = null;
        this.filesize = null;
        this.duration = null;
        this.dimensions = null;
        this.isStream = /\.m3u8(\?|#|$)/i.test(url);
        this.failureReason = null;
        this.dedupeKey = null;
        this.capturedAt = Date.now();
        this.confirmedAt = null;
        this.acceptRanges = null;
    }

    generateId(url, tabId) {
        const urlPart = url.replace(/[^a-z0-9]/gi, '').substring(0, 32);
        return `${tabId}_${urlPart}_${Date.now()}`;
    }

    confirm(playEventData = {}) {
        if (this.state !== VideoState.CANDIDATE) return false;
        this.state = VideoState.CONFIRMED;
        this.confirmedAt = Date.now();
        if (playEventData.duration) this.duration = playEventData.duration;
        if (playEventData.dimensions) this.dimensions = playEventData.dimensions;
        debugLog(`Video confirmed: ${this.url.substring(0, 60)}...`);
        return true;
    }

    validate(headerData = {}) {
        if (this.state !== VideoState.CONFIRMED) return false;
        this.state = VideoState.VALIDATED;
        if (headerData.contentType) this.contentType = headerData.contentType;
        if (headerData.contentLength) this.filesize = headerData.contentLength;
        if (headerData.acceptRanges) this.acceptRanges = headerData.acceptRanges;
        return true;
    }

    makeActionable() {
        if (this.state !== VideoState.VALIDATED) return false;
        this.state = VideoState.ACTIONABLE;
        debugLog(`Video actionable: ${this.url.substring(0, 60)}...`);
        return true;
    }

    fail(reason) {
        this.state = VideoState.FAILED;
        this.failureReason = reason;
        debugLog(`Video failed: ${this.url.substring(0, 60)}... (${reason})`);
    }

    toObject() {
        return {
            id: this.id,
            url: this.url,
            tabId: this.tabId,
            pageUrl: this.pageUrl,
            state: this.state,
            source: this.source,
            contentType: this.contentType,
            filesize: this.filesize,
            duration: this.duration,
            dimensions: this.dimensions,
            isStream: this.isStream,
            failureReason: this.failureReason,
            capturedAt: this.capturedAt,
            confirmedAt: this.confirmedAt
        };
    }
}

// =============================================================================
// VIDEO CAPTURE STORAGE
// =============================================================================

const CapturedVideos = {
    byTab: new Map(),

    videoMimeTypes: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    videoExtensions: /\.(mp4|webm|mkv|avi|mov|m4v)(\?|#|$)/i,
    streamMimeTypes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml'],
    streamExtensions: /\.(m3u8|mpd)(\?|#|$)/i,

    isVideoRequest(url, contentType) {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return false;
        
        const ct = contentType?.toLowerCase() || '';
        if (this.videoMimeTypes.some(m => ct.includes(m))) return true;
        if (this.streamMimeTypes.some(m => ct.includes(m))) return true;
        if (this.videoExtensions.test(url)) return true;
        if (this.streamExtensions.test(url)) return true;
        
        return false;
    },

    addCandidate(tabId, url, source = 'network', metadata = {}) {
        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, new Map());
        }
        
        const tabVideos = this.byTab.get(tabId);
        
        // Check for existing record with same URL
        for (const record of tabVideos.values()) {
            if (record.url === url) {
                return record;
            }
        }
        
        const record = new VideoRecord(url, tabId, source);
        if (metadata.contentType) record.contentType = metadata.contentType;
        if (metadata.contentLength) record.filesize = parseInt(metadata.contentLength);
        if (metadata.isStream !== undefined) record.isStream = metadata.isStream;
        
        tabVideos.set(record.id, record);
        debugLog(`Candidate added: ${url.substring(0, 60)}... [${source}]`);
        
        this.updateBadge(tabId);
        return record;
    },

    confirmVideo(tabId, url, playEventData = {}) {
        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, new Map());
        }
        
        const tabVideos = this.byTab.get(tabId);
        
        // Find existing record or create new one
        let record = null;
        for (const r of tabVideos.values()) {
            if (r.url === url) {
                record = r;
                break;
            }
        }
        
        if (!record) {
            record = new VideoRecord(url, tabId, playEventData.source || 'play-event');
            tabVideos.set(record.id, record);
        }
        
        // Promote to confirmed
        if (record.state === VideoState.CANDIDATE) {
            record.confirm(playEventData);
        }
        
        this.updateBadge(tabId);
        return record;
    },

    getActionableVideos(tabId) {
        const tabVideos = this.byTab.get(tabId);
        if (!tabVideos) return [];
        
        return Array.from(tabVideos.values())
            .filter(r => r.state === VideoState.ACTIONABLE)
            .map(r => r.toObject());
    },

    getAllVideos(tabId) {
        const tabVideos = this.byTab.get(tabId);
        if (!tabVideos) return [];
        return Array.from(tabVideos.values()).map(r => r.toObject());
    },

    clearTab(tabId) {
        this.byTab.delete(tabId);
        this.updateBadge(tabId);
    },

    updateBadge(tabId) {
        const tabVideos = this.byTab.get(tabId);
        const count = tabVideos ? 
            Array.from(tabVideos.values()).filter(r => 
                r.state === VideoState.ACTIONABLE || r.state === VideoState.CONFIRMED
            ).length : 0;
        
        chrome.action.setBadgeText({
            text: count > 0 ? String(count) : '',
            tabId: tabId
        }).catch(() => {});
        
        chrome.action.setBadgeBackgroundColor({
            color: '#e94560',
            tabId: tabId
        }).catch(() => {});
    }
};

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

    createFilename(mediaUrl, mediaType = 'video') {
        let filename = '';
        
        try {
            const url = new URL(mediaUrl);
            const pathParts = url.pathname.split('/');
            filename = pathParts[pathParts.length - 1].split('?')[0];
        } catch {
            filename = mediaUrl.split('/').pop()?.split('?')[0] || '';
        }

        if (!filename || filename.length < 3) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            filename = `${mediaType}_${timestamp}`;
        }

        // Clean filename
        filename = filename.replace(/[<>:"/\\|?*]/g, '_');
        
        // Ensure extension
        if (!/\.(mp4|webm|mkv|avi|mov|m4v|ts|m3u8|jpg|png|gif|webp)$/i.test(filename)) {
            filename += mediaType === 'video' ? '.mp4' : '.jpg';
        }

        if (Config.useTimestampInFilename && filename.length < 50) {
            const ts = Date.now().toString(36);
            const ext = filename.match(/\.[^.]+$/)?.[0] || '';
            const base = filename.replace(/\.[^.]+$/, '');
            filename = `${base}_${ts}${ext}`;
        }

        return filename;
    },

    detectMimeType(bytes) {
        if (!bytes || bytes.length < 12) return 'application/octet-stream';

        const signatures = [
            { bytes: [0x00, 0x00, 0x00], offset: 0, check: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70, mime: 'video/mp4' },
            { bytes: [0x1A, 0x45, 0xDF, 0xA3], offset: 0, mime: 'video/webm' },
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: 'video/avi' },
            { bytes: [0x47], offset: 0, check: (b) => b[188] === 0x47, mime: 'video/mp2t' },
            { bytes: [0xFF, 0xD8, 0xFF], offset: 0, mime: 'image/jpeg' },
            { bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0, mime: 'image/png' },
            { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: 'image/gif' },
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, check: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, mime: 'image/webp' }
        ];

        for (const sig of signatures) {
            let matches = true;
            for (let i = 0; i < sig.bytes.length; i++) {
                if (bytes[sig.offset + i] !== sig.bytes[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches && (!sig.check || sig.check(bytes))) {
                return sig.mime;
            }
        }

        return 'application/octet-stream';
    }
};

// =============================================================================
// DOWNLOAD HISTORY
// =============================================================================

const DownloadHistory = {
    data: {},
    loaded: false,

    async load() {
        if (this.loaded) return;
        try {
            const result = await chrome.storage.local.get('downloadHistory');
            this.data = result.downloadHistory || {};
            this.loaded = true;
            this.cleanup();
        } catch (error) {
            debugLog('Failed to load download history:', error);
            this.data = {};
            this.loaded = true;
        }
    },

    async save() {
        try {
            await chrome.storage.local.set({ downloadHistory: this.data });
        } catch (error) {
            debugLog('Failed to save download history:', error);
        }
    },

    cleanup() {
        const cutoff = Date.now() - (Config.deduplication.timeframeDays * 24 * 60 * 60 * 1000);
        let cleaned = 0;
        for (const key of Object.keys(this.data)) {
            if (this.data[key].timestamp < cutoff) {
                delete this.data[key];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            debugLog(`Cleaned ${cleaned} expired history entries`);
            this.save();
        }
    },

    isDuplicateUrl(url) {
        const normalized = Utils.normalizeUrl(url);
        const key = `url_${normalized}`;
        return !!this.data[key];
    },

    async add(url, filename, hash = null, mediaType = 'image') {
        const normalized = Utils.normalizeUrl(url);
        const entry = {
            url: normalized,
            filename,
            hash,
            mediaType,
            timestamp: Date.now()
        };
        
        this.data[`url_${normalized}`] = entry;
        if (hash) {
            this.data[`hash_${hash}`] = entry;
        }
        
        await this.save();
    }
};

// =============================================================================
// DOWNLOAD VIA MANAGER TAB (CocoCut-style pattern)
// =============================================================================

/**
 * Open the download manager tab and start a video download.
 * The download manager tab runs with extension permissions, bypassing CORS.
 */
async function downloadViaManagerTab(video, options = {}) {
    const videoUrl = typeof video === 'object' ? video.url : video;
    const isStream = typeof video === 'object' && (video.isStream || /\.m3u8(\?|#|$)/i.test(videoUrl));
    const pageUrl = typeof video === 'object' ? video.pageUrl : null;
    
    let filename = Utils.createFilename(videoUrl);
    if (options.prefix) {
        filename = options.prefix + '_' + filename;
    }
    
    debugLog(`Opening download manager for: ${filename}`);
    debugLog(`URL: ${videoUrl.substring(0, 80)}...`);
    debugLog(`Is HLS: ${isStream}`);
    
    // Build the download manager URL with parameters
    const managerUrl = chrome.runtime.getURL('download-manager.html');
    const params = new URLSearchParams({
        taskId: Date.now().toString(),
        url: videoUrl,
        filename: filename,
        isHLS: isStream.toString()
    });
    
    if (pageUrl) {
        params.set('pageUrl', pageUrl);
    }
    
    const fullUrl = `${managerUrl}?${params.toString()}`;
    
    try {
        const tab = await chrome.tabs.create({
            url: fullUrl,
            active: true
        });
        
        debugLog(`Download manager opened in tab ${tab.id}`);
        
        return {
            success: true,
            method: 'manager-tab',
            tabId: tab.id,
            filename: filename
        };
    } catch (error) {
        debugLog(`Failed to open download manager: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Download multiple videos using the manager tab pattern.
 */
async function downloadVideosViaManager(videos, options = {}) {
    const interval = options.interval || 1000;
    const results = [];
    
    for (let i = 0; i < videos.length; i++) {
        if (!DownloadState.isRunning) break;
        
        while (DownloadState.isPaused && DownloadState.isRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!DownloadState.isRunning) break;
        
        const video = videos[i];
        const result = await downloadViaManagerTab(video, options);
        results.push(result);
        
        DownloadState.processed++;
        if (result.success) {
            DownloadState.success++;
        } else {
            DownloadState.skipped++;
        }
        
        // Delay between opening tabs
        if (i < videos.length - 1) {
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }
    
    return results;
}

// =============================================================================
// OPTIONS STORAGE
// =============================================================================

async function getStoredOptions() {
    try {
        const result = await chrome.storage.local.get('mediaDownloaderOptions');
        return result.mediaDownloaderOptions || {
            closeTabs: false,
            skipDuplicates: true,
            interval: 1,
            prefix: ''
        };
    } catch {
        return {
            closeTabs: false,
            skipDuplicates: true,
            interval: 1,
            prefix: ''
        };
    }
}

// =============================================================================
// NETWORK REQUEST LISTENER
// =============================================================================

chrome.webRequest.onCompleted.addListener(
    async (details) => {
        if (details.tabId < 0) return;
        if (details.statusCode !== 200 && details.statusCode !== 206) return;

        const contentType = details.responseHeaders?.find(
            h => h.name.toLowerCase() === 'content-type'
        )?.value;

        const contentLength = details.responseHeaders?.find(
            h => h.name.toLowerCase() === 'content-length'
        )?.value;

        if (CapturedVideos.isVideoRequest(details.url, contentType)) {
            const isStream = /\.(m3u8|mpd)(\?|#|$)/i.test(details.url) ||
                            contentType?.includes('mpegurl') ||
                            contentType?.includes('dash+xml');
            
            CapturedVideos.addCandidate(details.tabId, details.url, 'network', {
                contentType,
                contentLength,
                isStream
            });
        }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

// Clear captured videos on navigation
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        CapturedVideos.clearTab(details.tabId);
    }
});

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            switch (message.action) {
                case 'video-intercepted': {
                    if (!sender.tab?.id) break;
                    const tabId = sender.tab.id;
                    const url = message.url;
                    
                    if (!url || url.startsWith('blob:')) break;
                    
                    let absoluteUrl = url;
                    if (!url.startsWith('http')) {
                        try {
                            absoluteUrl = new URL(url, message.tabUrl).href;
                        } catch {
                            break;
                        }
                    }
                    
                    const isVideo = CapturedVideos.isVideoRequest(absoluteUrl, null);
                    if (!isVideo) break;
                    
                    const isPlayEvent = message.source?.includes('play') ||
                                       message.source?.includes('loadeddata') ||
                                       message.source?.includes('src-set');
                    
                    if (isPlayEvent) {
                        const record = CapturedVideos.confirmVideo(tabId, absoluteUrl, {
                            source: message.source,
                            duration: message.duration,
                            dimensions: message.dimensions
                        });
                        
                        if (record) {
                            record.pageUrl = sender.tab?.url || message.tabUrl || null;
                            
                            // For confirmed videos, mark actionable directly
                            // (skip validation which often fails due to CORS)
                            if (record.state === VideoState.CONFIRMED) {
                                record.state = VideoState.VALIDATED;
                                record.makeActionable();
                            }
                        }
                    } else {
                        CapturedVideos.addCandidate(tabId, absoluteUrl, message.source || 'intercept', {
                            isStream: message.isStream
                        });
                    }
                    break;
                }

                case 'scan-videos': {
                    const tabIds = message.tabIds || [];
                    const allVideos = [];
                    
                    for (const tabId of tabIds) {
                        const videos = CapturedVideos.getAllVideos(tabId);
                        allVideos.push(...videos);
                    }
                    
                    sendResponse({ videos: allVideos });
                    break;
                }

                case 'download-specific-videos': {
                    const videos = message.videos || [];
                    const dlOptions = message.options || {};
                    
                    debugLog(`Download ${videos.length} videos via manager tabs`);
                    
                    DownloadState.reset();
                    DownloadState.isRunning = true;
                    DownloadState.total = videos.length;
                    
                    const results = await downloadVideosViaManager(videos, dlOptions);
                    
                    DownloadState.isRunning = false;
                    
                    sendResponse({
                        success: true,
                        processed: DownloadState.processed,
                        downloaded: DownloadState.success,
                        skipped: DownloadState.skipped,
                        results
                    });
                    break;
                }

                case 'get-status': {
                    sendResponse(DownloadState.getStatus());
                    break;
                }

                case 'pause': {
                    DownloadState.isPaused = true;
                    sendResponse({ paused: true });
                    break;
                }

                case 'resume': {
                    DownloadState.isPaused = false;
                    sendResponse({ resumed: true });
                    break;
                }

                case 'cancel': {
                    DownloadState.isRunning = false;
                    DownloadState.isPaused = false;
                    sendResponse({ cancelled: true });
                    break;
                }

                case 'download-complete': {
                    // Notification from download manager tab
                    debugLog(`Download complete: ${message.filename} (${message.size} bytes)`);
                    break;
                }

                default:
                    sendResponse({ error: 'Unknown action' });
            }
        } catch (error) {
            debugLog('Message handler error:', error);
            sendResponse({ error: error.message });
        }
    })();

    return true;
});

// =============================================================================
// INITIALIZATION
// =============================================================================

chrome.runtime.onInstalled.addListener(async () => {
    debugLog('Extension installed/updated - v1.8 (Manager Tab Pattern)');
    await DownloadHistory.load();
});

chrome.runtime.onStartup.addListener(async () => {
    debugLog('Extension started');
    await DownloadHistory.load();
});

debugLog('Media Downloader v1.8 loaded - Download Manager Tab Pattern');
