/**
 * Media Downloader Extension - Background Service Worker
 * Handles tab selection, download coordination, and deduplication.
 * Supports both images and videos (Phase 1: direct URLs only).
 */

// =============================================================================
// VIDEO CAPTURE (passive interception via webRequest)
// =============================================================================

const CapturedVideos = {
    // Map of tabId -> array of video objects
    byTab: new Map(),
    
    // Video MIME types to capture
    videoMimeTypes: [
        'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
        'video/x-msvideo', 'video/x-matroska', 'video/x-flv'
    ],
    
    // Video file extensions
    videoExtensions: /\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv|ogv)(\?|#|$)/i,
    
    // Patterns to exclude (streams, segments, manifests)
    excludePatterns: [
        /\.m3u8/i,
        /\.mpd/i,
        /\/seg-\d+/i,
        /\/fragment/i,
        /\/chunk/i,
        /init\.mp4/i,
        /\.ts(\?|$)/i
    ],
    
    add(tabId, url, contentType, contentLength) {
        // Skip stream segments and manifests
        if (this.excludePatterns.some(p => p.test(url))) return;
        
        // Skip blob/data URLs
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        
        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, []);
        }
        
        const videos = this.byTab.get(tabId);
        
        // Avoid duplicates
        if (videos.some(v => v.url === url)) return;
        
        videos.push({
            url,
            contentType: contentType || null,
            filesize: contentLength ? parseInt(contentLength) : null,
            source: 'network',
            verified: false,
            capturedAt: Date.now()
        });
        
        Utils.log(`Captured video on tab ${tabId}: ${url.substring(0, 80)}...`);
    },
    
    getForTab(tabId) {
        return this.byTab.get(tabId) || [];
    },
    
    clearTab(tabId) {
        this.byTab.delete(tabId);
    },
    
    isVideoRequest(url, contentType) {
        // Check MIME type first (but not octet-stream, too generic)
        if (contentType) {
            const mime = contentType.split(';')[0].trim().toLowerCase();
            if (this.videoMimeTypes.includes(mime)) return true;
        }
        
        // Fallback: check URL extension
        if (this.videoExtensions.test(url)) return true;
        
        return false;
    }
};

// Listen for completed requests and capture video URLs
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
            CapturedVideos.add(details.tabId, details.url, contentType, contentLength);
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
// CONFIGURATION
// =============================================================================

const Config = {
    closeTabAfterDownload: true,
    useTimestampInFilename: true,
    
    deduplication: {
        enabled: true,
        storageKeyPrefix: 'media_dl_',
        timeframeDays: 30,
        ignoreQueryParams: true,
        perceptualHash: {
            enabled: true,
            hammingThreshold: 5
        }
    },
    
    // Delay before closing tab (allows download to initiate)
    closeDelayMs: 500
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

    hashUrl(url) {
        return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    },

    createFilename(mediaUrl, mediaType = 'image') {
        let filename = '';

        try {
            const url = new URL(mediaUrl);
            const pathParts = url.pathname.split('/');
            filename = pathParts[pathParts.length - 1].split('?')[0];
        } catch {
            filename = mediaUrl.split('/').pop().split('?')[0];
        }

        filename = filename.replace(/[/\\?%*:|"<>]/g, '_');

        if (!filename.includes('.')) {
            if (mediaType === 'video') {
                const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv'];
                const foundExt = videoExtensions.find(ext => mediaUrl.toLowerCase().includes(ext));
                filename += foundExt || '.mp4';
            } else {
                const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
                const foundExt = imageExtensions.find(ext => mediaUrl.toLowerCase().includes(ext));
                filename += foundExt || '.jpg';
            }
        }

        if (!filename || filename === '.' || filename.length < 3) {
            const prefix = mediaType === 'video' ? 'video' : 'image';
            const ext = mediaType === 'video' ? '.mp4' : '.jpg';
            filename = `${prefix}_${Math.floor(Math.random() * 10000)}${ext}`;
        }

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
            // Image signatures
            { bytes: [0xFF, 0xD8], mime: 'image/jpeg' },
            { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: 'image/png' },
            { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], mime: 'image/webp' },
            { bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C], mime: 'image/svg+xml' },
            { bytes: [0x3C, 0x73, 0x76, 0x67], mime: 'image/svg+xml' },
            { bytes: [0x42, 0x4D], mime: 'image/bmp' },
            
            // Video signatures
            // MP4/M4V/MOV - ftyp box at offset 4
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
            // WebM/MKV - EBML header
            { bytes: [0x1A, 0x45, 0xDF, 0xA3], mime: 'video/webm' },
            // AVI - RIFF....AVI
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x41, 0x56, 0x49, 0x20], mime: 'video/avi' },
            // OGV - OggS
            { bytes: [0x4F, 0x67, 0x67, 0x53], mime: 'video/ogg' },
            // FLV
            { bytes: [0x46, 0x4C, 0x56], mime: 'video/x-flv' },
            
            // AVIF (after video to avoid false positives with ftyp)
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], mime: 'image/avif' },
        ];

        for (const sig of signatures) {
            const offset = sig.offset || 0;
            const matchBytes = sig.match || sig.bytes;

            if (bytes.length >= offset + matchBytes.length) {
                let matches = true;
                
                // Check initial bytes if offset is specified
                if (sig.offset && sig.bytes) {
                    matches = sig.bytes.every((byte, i) => bytes[i] === byte);
                }
                
                // Check match bytes at offset
                if (matches) {
                    matches = matchBytes.every((byte, i) => bytes[offset + i] === byte);
                }
                
                if (matches) {
                    return sig.mime;
                }
            }
        }

        return 'application/octet-stream';
    },

    getMediaTypeFromMime(mimeType) {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        return 'unknown';
    },

    updateExtension(filename, mimeType) {
        const extensionMap = {
            // Images
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
            'image/avif': '.avif',
            'image/bmp': '.bmp',
            // Videos
            'video/mp4': '.mp4',
            'video/webm': '.webm',
            'video/avi': '.avi',
            'video/ogg': '.ogv',
            'video/x-flv': '.flv',
            'video/quicktime': '.mov',
            'video/x-matroska': '.mkv'
        };

        const extension = extensionMap[mimeType];
        if (!extension) return filename;
        
        const baseName = filename.replace(/\.[^/.]+$/, '');
        return baseName + extension;
    }
};

// =============================================================================
// PERCEPTUAL HASH (Images only)
// =============================================================================

const PerceptualHash = {
    async generate(arrayBuffer, mimeType) {
        // Only generate perceptual hash for images
        if (!mimeType || !mimeType.startsWith('image/')) {
            return null;
        }
        
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
            Utils.log('Perceptual hash error:', error);
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
// DOWNLOAD HISTORY
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
                Utils.log(`Cleaned up ${toDelete.length} old entries`);
            }

            this.loaded = true;
            Utils.log(`Loaded ${this.cache.size} items in download history`);

        } catch (error) {
            Utils.log('Error loading history:', error);
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

    async add(url, filename, perceptualHash = null, mediaType = 'image') {
        if (!Config.deduplication.enabled || !url) return;

        const normalizedUrl = Utils.normalizeUrl(url);
        const urlKey = Utils.hashUrl(normalizedUrl);

        const entry = {
            originalUrl: url,
            filename: filename,
            timestamp: Date.now(),
            perceptualHash: perceptualHash,
            mediaType: mediaType
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
            Utils.log('Error saving to storage:', error);
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
            
            Utils.log(`Cleared ${toDelete.length} entries`);
        } catch (error) {
            Utils.log('Error clearing history:', error);
        }
    }
};

// =============================================================================
// CONTENT SCRIPT - MEDIA FINDER
// Injected into pages to find the best media source.
// =============================================================================

const contentScript = `
(function() {
    const Config = {
        minImageDimension: 50,
        parentTraversalDepth: 5,
        handleBackgroundImages: true,
        videoSettleDelayMs: 500
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
        if (!url.startsWith('http')) {
            try {
                return new URL(url, window.location.href).href;
            } catch {
                return url;
            }
        }
        return url;
    }

    // =========================================================================
    // VIDEO DETECTION
    // =========================================================================

    function isDirectVideoUrl(url) {
        if (!url) return false;
        // Exclude blob:, data:, and streaming manifests
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        if (url.endsWith('.m3u8') || url.endsWith('.mpd')) return false;
        return true;
    }

    function looksLikeVideoUrl(url) {
        if (!url) return false;
        return /\\.(mp4|webm|mkv|avi|mov|m4v|ogv|flv)(\\?|$)/i.test(url);
    }

    function getVideoSource(video) {
        // Check direct src
        if (video.src && isDirectVideoUrl(video.src)) {
            return video.src;
        }
        
        // Check source elements
        const sources = video.querySelectorAll('source');
        for (const source of sources) {
            if (source.src && isDirectVideoUrl(source.src)) {
                return source.src;
            }
        }
        
        // Check data attributes
        const videoAttrs = ['data-src', 'data-video-src', 'data-video', 'data-mp4'];
        for (const attr of videoAttrs) {
            const val = video.getAttribute(attr);
            if (val && isDirectVideoUrl(val)) {
                return ensureAbsoluteUrl(val);
            }
        }
        
        return null;
    }

    function findBestVideo() {
        const candidates = [];
        
        // Check if page is a direct video file
        if (document.contentType?.startsWith('video/')) {
            return { url: window.location.href, type: 'video' };
        }
        
        // Find all video elements
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            const url = getVideoSource(video);
            if (url) {
                // Prioritize visible, playing, or larger videos
                let priority = 100;
                if (isVisible(video)) priority += 50;
                if (!video.paused) priority += 30;
                if (video.videoWidth > 0) priority += Math.min(video.videoWidth / 10, 100);
                
                candidates.push({ url: ensureAbsoluteUrl(url), priority, type: 'video' });
            }
        }
        
        // Check for video URLs in data attributes on other elements
        const videoDataElements = document.querySelectorAll('[data-video-src], [data-video], [data-mp4]');
        for (const el of videoDataElements) {
            const url = el.dataset.videoSrc || el.dataset.video || el.dataset.mp4;
            if (url && looksLikeVideoUrl(url)) {
                candidates.push({ url: ensureAbsoluteUrl(url), priority: 50, type: 'video' });
            }
        }
        
        // Sort by priority and return best
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.priority - a.priority);
            return candidates[0];
        }
        
        return null;
    }

    // =========================================================================
    // IMAGE DETECTION
    // =========================================================================

    function getBestImageVersion(imgElement) {
        if (!imgElement?.src) return null;

        let bestSrc = imgElement.src;
        let bestWidth = imgElement.naturalWidth || 0;

        if (imgElement.srcset) {
            const srcsetItems = imgElement.srcset.split(',');
            for (const item of srcsetItems) {
                const parts = item.trim().split(/\\s+/);
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
        if (parentLink?.href && /\\.(jpe?g|png|gif|webp|svg|avif)(\\?.*)?$/i.test(parentLink.href)) {
            bestSrc = parentLink.href;
        }

        return ensureAbsoluteUrl(bestSrc);
    }

    function getBackgroundImage(element) {
        if (!element) return null;
        try {
            const style = getComputedStyle(element);
            if (style.backgroundImage && style.backgroundImage !== 'none') {
                const match = style.backgroundImage.match(/url\\(['"]?(.*?)['"]?\\)/);
                if (match?.[1]) {
                    return ensureAbsoluteUrl(match[1]);
                }
            }
        } catch {}
        return null;
    }

    function findBestImage() {
        // Check if page is a direct image
        if (document.contentType?.startsWith('image/')) {
            return { url: window.location.href, type: 'image' };
        }

        const potentialSources = [];

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
                potentialSources.push({ url, priority: 100, type: 'image' });
            }
        }

        // Check gallery overlays
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
                    potentialSources.push({ url, priority: 150, type: 'image' });
                }
            }
        }

        // Check background images
        if (Config.handleBackgroundImages) {
            const bgElements = [document.body, document.querySelector('main'), document.querySelector('#content')];
            for (const el of bgElements) {
                if (el) {
                    const bgUrl = getBackgroundImage(el);
                    if (bgUrl) {
                        potentialSources.push({ url: bgUrl, priority: 50, type: 'image' });
                    }
                }
            }
        }

        // Sort by priority and return best
        if (potentialSources.length > 0) {
            potentialSources.sort((a, b) => b.priority - a.priority);
            return potentialSources[0];
        }

        return null;
    }

    // =========================================================================
    // UNIFIED MEDIA FINDER
    // =========================================================================

    function findBestMedia(mediaMode) {
        // mediaMode: 'images', 'videos', 'auto'
        
        if (mediaMode === 'videos') {
            return findBestVideo();
        }
        
        if (mediaMode === 'images') {
            return findBestImage();
        }
        
        // 'auto' mode - prefer video if found, otherwise image
        const video = findBestVideo();
        if (video) return video;
        
        return findBestImage();
    }

    // Return the function for use
    return findBestMedia;
})();
`;

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================

const DownloadManager = {
    /**
     * Download media from a specific tab.
     * @param {number} tabId - Tab ID
     * @param {Object} options - Download options
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async downloadFromTab(tabId, options = {}) {
        const closeTab = options.closeTabs !== undefined ? options.closeTabs : true;
        const skipDuplicates = options.skipDuplicates !== undefined ? options.skipDuplicates : true;
        const prefix = options.prefix || '';
        const mediaMode = options.mediaMode || 'images';
        
        try {
            // Inject content script to find media
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: (mode) => {
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
                        if (!url.startsWith('http')) {
                            try {
                                return new URL(url, window.location.href).href;
                            } catch {
                                return url;
                            }
                        }
                        return url;
                    }

                    // Video detection
                    function isDirectVideoUrl(url) {
                        if (!url) return false;
                        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
                        if (url.endsWith('.m3u8') || url.endsWith('.mpd')) return false;
                        return true;
                    }

                    function looksLikeVideoUrl(url) {
                        if (!url) return false;
                        return /\.(mp4|webm|mkv|avi|mov|m4v|ogv|flv)(\?|$)/i.test(url);
                    }

                    function getVideoSource(video) {
                        if (video.src && isDirectVideoUrl(video.src)) {
                            return video.src;
                        }
                        const sources = video.querySelectorAll('source');
                        for (const source of sources) {
                            if (source.src && isDirectVideoUrl(source.src)) {
                                return source.src;
                            }
                        }
                        const videoAttrs = ['data-src', 'data-video-src', 'data-video', 'data-mp4'];
                        for (const attr of videoAttrs) {
                            const val = video.getAttribute(attr);
                            if (val && isDirectVideoUrl(val)) {
                                return ensureAbsoluteUrl(val);
                            }
                        }
                        return null;
                    }

                    function findBestVideo() {
                        const candidates = [];
                        
                        if (document.contentType?.startsWith('video/')) {
                            return { url: window.location.href, type: 'video' };
                        }
                        
                        const videos = document.querySelectorAll('video');
                        for (const video of videos) {
                            const url = getVideoSource(video);
                            if (url) {
                                let priority = 100;
                                if (isVisible(video)) priority += 50;
                                if (!video.paused) priority += 30;
                                if (video.videoWidth > 0) priority += Math.min(video.videoWidth / 10, 100);
                                candidates.push({ url: ensureAbsoluteUrl(url), priority, type: 'video' });
                            }
                        }
                        
                        const videoDataElements = document.querySelectorAll('[data-video-src], [data-video], [data-mp4]');
                        for (const el of videoDataElements) {
                            const url = el.dataset.videoSrc || el.dataset.video || el.dataset.mp4;
                            if (url && looksLikeVideoUrl(url)) {
                                candidates.push({ url: ensureAbsoluteUrl(url), priority: 50, type: 'video' });
                            }
                        }
                        
                        if (candidates.length > 0) {
                            candidates.sort((a, b) => b.priority - a.priority);
                            return candidates[0];
                        }
                        
                        return null;
                    }

                    // Image detection
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

                    function findBestImage() {
                        if (document.contentType?.startsWith('image/')) {
                            return { url: window.location.href, type: 'image' };
                        }

                        const potentialSources = [];

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
                                potentialSources.push({ url, priority: 100, type: 'image' });
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
                                    potentialSources.push({ url, priority: 150, type: 'image' });
                                }
                            }
                        }

                        if (Config.handleBackgroundImages) {
                            const bgElements = [document.body, document.querySelector('main'), document.querySelector('#content')];
                            for (const el of bgElements) {
                                if (el) {
                                    const bgUrl = getBackgroundImage(el);
                                    if (bgUrl) {
                                        potentialSources.push({ url: bgUrl, priority: 50, type: 'image' });
                                    }
                                }
                            }
                        }

                        if (potentialSources.length > 0) {
                            potentialSources.sort((a, b) => b.priority - a.priority);
                            return potentialSources[0];
                        }

                        return null;
                    }

                    // Unified finder
                    if (mode === 'videos') {
                        return findBestVideo();
                    }
                    if (mode === 'images') {
                        return findBestImage();
                    }
                    // 'auto' mode - prefer video if found, otherwise image
                    const video = findBestVideo();
                    if (video) return video;
                    return findBestImage();
                },
                args: [mediaMode]
            });

            const mediaResult = results?.[0]?.result;
            
            if (!mediaResult || !mediaResult.url) {
                Utils.log(`No media found in tab ${tabId}`);
                return { success: false, reason: 'no_media' };
            }

            const mediaUrl = mediaResult.url;
            const mediaType = mediaResult.type || 'image';

            Utils.log(`Found ${mediaType} in tab ${tabId}:`, mediaUrl);

            // Check URL duplicate before fetching
            await DownloadHistory.load();
            if (skipDuplicates && DownloadHistory.isDuplicateUrl(mediaUrl)) {
                Utils.log(`Duplicate URL skipped: ${mediaUrl}`);
                if (closeTab) {
                    await chrome.tabs.remove(tabId);
                }
                return { success: false, reason: 'duplicate_url' };
            }

            // Fetch media for content verification and download
            const response = await fetch(mediaUrl);
            if (!response.ok) {
                Utils.log(`Fetch failed for ${mediaUrl}: ${response.status}`);
                return { success: false, reason: 'fetch_failed' };
            }

            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            const mimeType = Utils.detectMimeType(bytes);
            const detectedMediaType = Utils.getMediaTypeFromMime(mimeType);

            // Generate perceptual hash (images only)
            const perceptualHash = await PerceptualHash.generate(arrayBuffer, mimeType);

            // Check content duplicate (images only)
            if (skipDuplicates && perceptualHash) {
                const dupCheck = DownloadHistory.checkDuplicate(mediaUrl, perceptualHash);
                if (dupCheck.isDuplicate && dupCheck.reason === 'content') {
                    Utils.log(`Duplicate content skipped: ${mediaUrl}`);
                    if (closeTab) {
                        await chrome.tabs.remove(tabId);
                    }
                    return { success: false, reason: 'duplicate_content' };
                }
            }

            // Create filename
            let filename = Utils.createFilename(mediaUrl, detectedMediaType);
            filename = Utils.updateExtension(filename, mimeType);
            
            // Apply prefix if specified
            if (prefix) {
                filename = prefix + '_' + filename;
            }

            // Convert to base64 data URL
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, i + chunkSize);
                binary += String.fromCharCode.apply(null, chunk);
            }
            const base64 = btoa(binary);
            const dataUrl = `data:${mimeType};base64,${base64}`;

            // Download
            await chrome.downloads.download({
                url: dataUrl,
                filename: filename,
                saveAs: false
            });

            // Add to history
            await DownloadHistory.add(mediaUrl, filename, perceptualHash, detectedMediaType);

            Utils.log(`Downloaded: ${filename}`);

            // Close tab if requested
            if (closeTab) {
                setTimeout(async () => {
                    try {
                        await chrome.tabs.remove(tabId);
                    } catch (e) {
                        Utils.log('Tab already closed or error:', e);
                    }
                }, Config.closeDelayMs);
            }

            return { success: true };

        } catch (error) {
            Utils.log(`Error downloading from tab ${tabId}:`, error);
            return { success: false, reason: 'error', message: error.message };
        }
    },

    /**
     * Download from all selected/highlighted tabs.
     */
    async downloadFromSelectedTabs(options = {}) {
        const interval = options.interval || 500;
        const mediaMode = options.mediaMode || 'images';
        
        try {
            const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
            
            if (tabs.length === 0) {
                return { error: 'No tabs selected' };
            }

            DownloadState.reset();
            DownloadState.isRunning = true;
            DownloadState.total = tabs.length;

            Utils.log(`Starting batch download of ${tabs.length} tabs (mode: ${mediaMode})`);

            for (const tab of tabs) {
                if (!DownloadState.isRunning) {
                    Utils.log('Download cancelled');
                    break;
                }

                while (DownloadState.isPaused && DownloadState.isRunning) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                if (!DownloadState.isRunning) break;

                const result = await this.downloadFromTab(tab.id, { ...options, mediaMode });
                
                DownloadState.processed++;
                
                if (result.success) {
                    DownloadState.success++;
                } else {
                    DownloadState.skipped++;
                    if (result.reason === 'duplicate_url' || result.reason === 'duplicate_content') {
                        DownloadState.duplicates++;
                    }
                }

                // Wait between downloads to avoid rate limiting
                if (DownloadState.isRunning && DownloadState.processed < tabs.length) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                }
            }

            const result = {
                success: DownloadState.success,
                skipped: DownloadState.skipped,
                duplicates: DownloadState.duplicates,
                total: DownloadState.total,
                cancelled: !DownloadState.isRunning
            };

            DownloadState.reset();
            return result;

        } catch (error) {
            Utils.log('Batch download error:', error);
            DownloadState.reset();
            return { error: error.message };
        }
    },

    /**
     * Download from the current active tab only.
     */
    async downloadFromCurrentTab(options = {}) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (!tab) {
                return { error: 'No active tab' };
            }

            DownloadState.reset();
            DownloadState.isRunning = true;
            DownloadState.total = 1;

            const result = await this.downloadFromTab(tab.id, options);
            
            DownloadState.processed = 1;
            if (result.success) {
                DownloadState.success = 1;
            } else {
                DownloadState.skipped = 1;
                if (result.reason === 'duplicate_url' || result.reason === 'duplicate_content') {
                    DownloadState.duplicates = 1;
                }
            }

            const returnVal = {
                success: DownloadState.success,
                skipped: DownloadState.skipped,
                duplicates: DownloadState.duplicates,
                total: 1
            };

            DownloadState.reset();
            return returnVal;

        } catch (error) {
            Utils.log('Current tab download error:', error);
            DownloadState.reset();
            return { error: error.message };
        }
    },

    /**
     * Get videos for tabs - combines DOM sources (reliable) with network capture (supplementary).
     * DOM-derived URLs from playing videos are prioritized as they're known-working.
     */
    async scanVideosFromTabs(tabIds) {
        const videos = [];
        const seenUrls = new Set();
        
        for (const tabId of tabIds) {
            try {
                const tab = await chrome.tabs.get(tabId);
                const hostname = tab.url ? new URL(tab.url).hostname : 'unknown';
                
                // 1. First, get DOM-derived URLs (high confidence - these are playing)
                try {
                    const domResults = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: 'MAIN',
                        func: () => {
                            const found = [];
                            const videoElements = document.querySelectorAll('video');
                            
                            for (const video of videoElements) {
                                // currentSrc is what's actually playing - most reliable
                                let url = video.currentSrc || video.src;
                                
                                // Check source elements as fallback
                                if (!url) {
                                    const source = video.querySelector('source[src]');
                                    if (source) url = source.src;
                                }
                                
                                if (url && url.startsWith('http')) {
                                    found.push({
                                        url,
                                        duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                                        dimensions: (video.videoWidth && video.videoHeight) 
                                            ? `${video.videoWidth}×${video.videoHeight}` 
                                            : null
                                    });
                                }
                            }
                            return found;
                        }
                    });
                    
                    const domVideos = domResults?.[0]?.result || [];
                    for (const v of domVideos) {
                        if (!seenUrls.has(v.url)) {
                            seenUrls.add(v.url);
                            videos.push({
                                url: v.url,
                                source: hostname,
                                origin: 'dom',
                                verified: true, // DOM sources are known-working
                                duration: v.duration,
                                dimensions: v.dimensions,
                                filesize: null
                            });
                        }
                    }
                } catch (e) {
                    Utils.log(`DOM scan failed for tab ${tabId}:`, e.message);
                }
                
                // 2. Add network-captured URLs (lower confidence, needs verification)
                const networkVideos = CapturedVideos.getForTab(tabId);
                for (const v of networkVideos) {
                    if (!seenUrls.has(v.url)) {
                        seenUrls.add(v.url);
                        videos.push({
                            url: v.url,
                            source: hostname,
                            origin: 'network',
                            verified: false, // Needs probe
                            duration: null,
                            dimensions: null,
                            filesize: v.filesize
                        });
                    }
                }
                
            } catch (error) {
                Utils.log(`Error scanning tab ${tabId}:`, error);
            }
        }
        
        // 3. Verify network-captured URLs with a quick probe
        for (const video of videos) {
            if (video.origin === 'network' && !video.verified) {
                video.verified = await this.probeVideoUrl(video.url);
                if (!video.verified) {
                    video.status = 'stream'; // Mark as Phase 2 material
                }
            }
        }
        
        Utils.log(`Found ${videos.length} videos (${videos.filter(v => v.verified).length} verified)`);
        return { videos };
    },
    
    /**
     * Quick probe to check if URL is a directly downloadable video file.
     * Returns true if it looks like a complete file, false if stream/protected.
     */
    async probeVideoUrl(url) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            
            const response = await fetch(url, {
                method: 'HEAD',
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) return false;
            
            const contentType = response.headers.get('content-type') || '';
            const contentLength = response.headers.get('content-length');
            const acceptRanges = response.headers.get('accept-ranges');
            
            // Check for video MIME type
            const isVideoMime = /video\/(mp4|webm|ogg|quicktime)/i.test(contentType);
            
            // Check for reasonable file size (> 100KB, not a tiny segment)
            const hasReasonableSize = contentLength && parseInt(contentLength) > 100000;
            
            // If we got HTML, it's probably an error page or redirect
            if (contentType.includes('text/html')) return false;
            
            return isVideoMime || hasReasonableSize;
            
        } catch (error) {
            // Network error, CORS block, or timeout - treat as unverified
            return false;
        }
    },

    /**
     * Download specific video URLs.
     * Uses anchor-click in MAIN world to leverage page cookies/session.
     */
    async downloadSpecificVideos(urls, options = {}) {
        const interval = options.interval || 500;
        const skipDuplicates = options.skipDuplicates !== undefined ? options.skipDuplicates : true;
        const prefix = options.prefix || '';
        
        try {
            DownloadState.reset();
            DownloadState.isRunning = true;
            DownloadState.total = urls.length;
            
            Utils.log(`Starting download of ${urls.length} videos`);
            
            // Get active tab for MAIN world injection
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab) {
                return { error: 'No active tab' };
            }
            
            for (const videoUrl of urls) {
                if (!DownloadState.isRunning) {
                    Utils.log('Download cancelled');
                    break;
                }
                
                while (DownloadState.isPaused && DownloadState.isRunning) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                if (!DownloadState.isRunning) break;
                
                try {
                    // Check URL duplicate before downloading
                    await DownloadHistory.load();
                    if (skipDuplicates && DownloadHistory.isDuplicateUrl(videoUrl)) {
                        Utils.log(`Duplicate URL skipped: ${videoUrl}`);
                        DownloadState.processed++;
                        DownloadState.skipped++;
                        DownloadState.duplicates++;
                        continue;
                    }
                    
                    // Create filename from URL
                    let filename = Utils.createFilename(videoUrl, 'video');
                    
                    if (prefix) {
                        filename = prefix + '_' + filename;
                    }
                    
                    Utils.log(`Downloading: ${filename}`);
                    
                    // Download via anchor-click in MAIN world (has page cookies)
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: activeTab.id },
                        world: 'MAIN',
                        func: (url, downloadFilename) => {
                            return new Promise((resolve) => {
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = downloadFilename;
                                a.style.display = 'none';
                                a.rel = 'noopener';
                                document.body.appendChild(a);
                                a.click();
                                
                                setTimeout(() => {
                                    document.body.removeChild(a);
                                    resolve({ success: true });
                                }, 200);
                            });
                        },
                        args: [videoUrl, filename]
                    });
                    
                    const result = results?.[0]?.result;
                    
                    if (result?.success) {
                        await DownloadHistory.add(videoUrl, filename, null, 'video');
                        Utils.log(`Download triggered: ${filename}`);
                        DownloadState.processed++;
                        DownloadState.success++;
                    } else {
                        Utils.log(`Download failed: ${filename}`);
                        DownloadState.processed++;
                        DownloadState.skipped++;
                    }
                    
                } catch (error) {
                    Utils.log(`Error downloading ${videoUrl}:`, error);
                    DownloadState.processed++;
                    DownloadState.skipped++;
                }
                
                // Wait between downloads
                if (DownloadState.isRunning && DownloadState.processed < urls.length) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                }
            }
            
            const result = {
                success: DownloadState.success,
                skipped: DownloadState.skipped,
                duplicates: DownloadState.duplicates,
                total: DownloadState.total,
                cancelled: !DownloadState.isRunning
            };
            
            DownloadState.reset();
            return result;
            
        } catch (error) {
            Utils.log('Video download error:', error);
            DownloadState.reset();
            return { error: error.message };
        }
    }
};

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

async function getStoredOptions() {
    try {
        const result = await chrome.storage.local.get(['closeTabs', 'skipDuplicates', 'interval', 'prefix', 'mediaMode']);
        return {
            closeTabs: result.closeTabs !== undefined ? result.closeTabs : true,
            skipDuplicates: result.skipDuplicates !== undefined ? result.skipDuplicates : true,
            interval: result.interval !== undefined ? result.interval : 500,
            prefix: result.prefix || '',
            mediaMode: result.mediaMode || 'auto'
        };
    } catch {
        return { closeTabs: true, skipDuplicates: true, interval: 500, prefix: '', mediaMode: 'auto' };
    }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Utils.log('Message received:', message.action);

    (async () => {
        try {
            if (message.action === 'download-selected-tabs') {
                const result = await DownloadManager.downloadFromSelectedTabs(message.options);
                sendResponse(result);
            } else if (message.action === 'download-current-tab') {
                const result = await DownloadManager.downloadFromCurrentTab(message.options);
                sendResponse(result);
            } else if (message.action === 'scan-videos') {
                const result = await DownloadManager.scanVideosFromTabs(message.tabIds);
                sendResponse(result);
            } else if (message.action === 'download-specific-videos') {
                const result = await DownloadManager.downloadSpecificVideos(message.urls, message.options);
                sendResponse(result);
            } else if (message.action === 'pause') {
                DownloadState.isPaused = true;
                Utils.log('Download paused');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'resume') {
                DownloadState.isPaused = false;
                Utils.log('Download resumed');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'cancel') {
                DownloadState.isRunning = false;
                DownloadState.isPaused = false;
                Utils.log('Download cancelled');
                sendResponse({ success: true, status: DownloadState.getStatus() });
            } else if (message.action === 'get-status') {
                sendResponse(DownloadState.getStatus());
            } else {
                sendResponse({ error: 'Unknown action' });
            }
        } catch (error) {
            Utils.log('Message handler error:', error);
            sendResponse({ error: error.message });
        }
    })();

    return true; // Keep channel open for async response
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
    Utils.log(`Command received: ${command}`);

    const options = await getStoredOptions();

    if (command === 'download-selected-tabs') {
        await DownloadManager.downloadFromSelectedTabs(options);
    } else if (command === 'download-current-tab') {
        await DownloadManager.downloadFromCurrentTab(options);
    }
});

// Initialize on install/update
chrome.runtime.onInstalled.addListener(async () => {
    Utils.log('Extension installed/updated');
    await DownloadHistory.load();
});

// Load history on startup
chrome.runtime.onStartup.addListener(async () => {
    Utils.log('Extension started');
    await DownloadHistory.load();
});

Utils.log('Media Downloader extension loaded');