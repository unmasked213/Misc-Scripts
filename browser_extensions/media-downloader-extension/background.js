/**
 * Image Downloader Extension - Background Service Worker
 * Handles tab selection, download coordination, and deduplication.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const Config = {
    closeTabAfterDownload: true,
    useTimestampInFilename: true,
    
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
    closeDelayMs: 500
};

// =============================================================================
// VIDEO CAPTURE (passive network interception)
// =============================================================================

const CapturedVideos = {
    byTab: new Map(),
    
    videoMimeTypes: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
    videoExtensions: /\.(mp4|webm|mkv|avi|mov|m4v)(\?|#|$)/i,
    excludePatterns: [/\.m3u8/i, /\.mpd/i, /\/seg-/i, /\/fragment/i, /\.ts(\?|$)/i],
    
    add(tabId, url, contentType, contentLength, extra = {}) {
        if (this.excludePatterns.some(p => p.test(url))) return;
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        
        if (!this.byTab.has(tabId)) {
            this.byTab.set(tabId, []);
        }
        
        const videos = this.byTab.get(tabId);
        const existing = videos.find(v => v.url === url);
        
        if (existing) {
            // Update existing entry with better metadata
            if (extra.fromPlayEvent) existing.fromPlayEvent = true;
            if (extra.duration && !existing.duration) existing.duration = extra.duration;
            if (extra.dimensions && !existing.dimensions) existing.dimensions = extra.dimensions;
            return;
        }
        
        videos.push({
            url,
            contentType: contentType || null,
            filesize: contentLength ? parseInt(contentLength) : null,
            capturedAt: Date.now(),
            fromPlayEvent: extra.fromPlayEvent || false,
            duration: extra.duration || null,
            dimensions: extra.dimensions || null
        });
        
        Utils.log(`Captured video on tab ${tabId}: ${url.substring(0, 60)}...`);
    },
    
    getForTab(tabId) {
        return this.byTab.get(tabId) || [];
    },
    
    clearTab(tabId) {
        this.byTab.delete(tabId);
    },
    
    isVideoRequest(url, contentType) {
        if (contentType) {
            const mime = contentType.split(';')[0].trim().toLowerCase();
            if (this.videoMimeTypes.includes(mime)) return true;
        }
        return this.videoExtensions.test(url);
    }
};

// Listen for video network requests
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

// Handle intercepted videos from content script
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
            const isFromPlayEvent = message.source?.includes('video-') || 
                                    message.source === 'play-event' ||
                                    message.source === 'existing-video';
            
            CapturedVideos.add(tabId, absoluteUrl, null, null, {
                fromPlayEvent: isFromPlayEvent,
                duration: message.duration,
                dimensions: message.dimensions
            });
            
            Utils.log(`Intercepted [${message.source}]: ${absoluteUrl.substring(0, 60)}...`);
        }
    }
    
    if (message.action === 'mse-detected' && sender.tab?.id) {
        Utils.log(`MSE detected on tab ${sender.tab.id} - blob streaming in use`);
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

const Utils = {
    log(...args) {
        console.log('[ImageDownloader]', ...args);
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
        // Create a filename from a URL. Preserve extension if possible.
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

        // Determine if filename has an extension. If not, attempt to infer from URL.
        if (!filename.includes('.')) {
            // Include common image and video extensions.
            const extensions = [
                '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif',
                '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv'
            ];
            const lowerUrl = mediaUrl.toLowerCase();
            const foundExt = extensions.find(ext => lowerUrl.includes(ext));
            // Default to .jpg for images and .mp4 for videos if none found
            if (foundExt) {
                filename += foundExt;
            } else {
                // Guess based on URL or fallback to .jpg
                filename += '.jpg';
            }
        }

        // Ensure filename has a base name (prevent names like ".jpg")
        const basePart = filename.replace(/\.[^/.]+$/, '');
        if (!filename || filename === '.' || basePart.length < 1) {
            filename = `file_${Math.floor(Math.random() * 10000)}.jpg`;
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
        // Attempt to detect common image and video MIME types based on magic numbers.
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
            { bytes: [0x1A, 0x45, 0xDF, 0xA3], mime: 'video/webm' }, // Matroska/WebM
            { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x41, 0x56, 0x49, 0x20], mime: 'video/avi' },
            { bytes: [0x4F, 0x67, 0x67, 0x53], mime: 'video/ogg' },
            { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x71, 0x74, 0x20, 0x20], mime: 'video/quicktime' }
        ];

        for (const sig of signatures) {
            const offset = sig.offset || 0;
            const matchBytes = sig.match || sig.bytes;

            if (bytes.length >= offset + matchBytes.length) {
                const matches = matchBytes.every((byte, i) => bytes[offset + i] === byte);
                // If an additional leading signature is provided, verify it as well
                if (matches && (!sig.offset || sig.bytes.every((byte, i) => bytes[i] === byte))) {
                    return sig.mime;
                }
            }
        }

        // Default to generic binary if unknown; fallback can be refined by caller.
        return 'application/octet-stream';
    },

    updateExtension(filename, mimeType) {
        // Map MIME types to appropriate file extensions. Includes images and videos.
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
// PERCEPTUAL HASH
// =============================================================================

const PerceptualHash = {
    /**
     * Generate perceptual hash from image data.
     * Uses average hash algorithm.
     */
    async generate(arrayBuffer) {
        if (!Config.deduplication.perceptualHash.enabled) {
            return null;
        }

        try {
            const hashSize = 8;
            const sampleSize = 32;

            // Create ImageBitmap from array buffer
            const blob = new Blob([arrayBuffer]);
            const imageBitmap = await createImageBitmap(blob);

            // Create OffscreenCanvas for processing
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
// CONTENT SCRIPT - IMAGE FINDER
// Injected into pages to find the best image source.
// =============================================================================

const contentScript = `
(function() {
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

    // Helpers for video detection
    function looksLikeVideo(url) {
        return /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(url);
    }

    function isDirectUrl(url) {
        return url && !url.startsWith('blob:') && !url.startsWith('data:') && !/\.(m3u8|mpd)(\?|$)/i.test(url);
    }

    function findBestVideo() {
        // Direct video page
        if (document.contentType?.startsWith('video/') || document.contentType === 'application/octet-stream') {
            return window.location.href;
        }

        const candidates = [];
        // Video tags
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

        // Data attributes that might contain video URLs
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

        // Check if page is a direct image
        if (document.contentType?.startsWith('image/')) {
            return window.location.href;
        }

        // Check for single large image (common for image viewer tabs)
        const allImages = Array.from(document.querySelectorAll('img'));
        const visibleImages = allImages.filter(img => 
            isVisible(img) && 
            img.naturalWidth > Config.minImageDimension && 
            img.naturalHeight > Config.minImageDimension
        );

        // Sort by area descending
        visibleImages.sort((a, b) => 
            (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)
        );

        for (const img of visibleImages) {
            const url = getBestImageVersion(img);
            if (url) {
                potentialSources.push({ url, priority: 100, area: img.naturalWidth * img.naturalHeight });
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
                    potentialSources.push({ url, priority: 150 });
                }
            }
        }

        // Check background images on body/main elements
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

        // Sort by priority and return best
        potentialSources.sort((a, b) => b.priority - a.priority);

        // Deduplicate
        const seen = new Set();
        for (const source of potentialSources) {
            if (!seen.has(source.url)) {
                seen.add(source.url);
                return source.url;
            }
        }

        return null;
    }

    function findBestMedia() {
        const videoUrl = findBestVideo();
        if (videoUrl) {
            return videoUrl;
        }
        return findBestImage();
    }

    return findBestMedia();
})();
`;

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================

const DownloadManager = {
    /**
     * Download image from a specific tab.
     * @param {number} tabId - Tab ID
     * @param {boolean} closeTab - Whether to close tab after download
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async downloadFromTab(tabId, options = {}) {
        const closeTab = options.closeTabs !== undefined ? options.closeTabs : true;
        const skipDuplicates = options.skipDuplicates !== undefined ? options.skipDuplicates : true;
        const prefix = options.prefix || '';
        try {
            // Inject content script to find media (image or video)
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    // This is the media finder script inlined, supports videos and images.
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

                    // Helpers for video detection
                    function looksLikeVideo(url) {
                        return /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(url);
                    }

                    function isDirectUrl(url) {
                        return url && !url.startsWith('blob:') && !url.startsWith('data:') && !/\.(m3u8|mpd)(\?|$)/i.test(url);
                    }

                    function findBestVideo() {
                        // Direct video page
                        if (document.contentType?.startsWith('video/') || document.contentType === 'application/octet-stream') {
                            return window.location.href;
                        }

                        const candidates = [];
                        // Video tags
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

                        // Data attributes that might contain video URLs
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

                        // Check if page is a direct image
                        if (document.contentType?.startsWith('image/')) {
                            return window.location.href;
                        }

                        // Check for single large image (common for image viewer tabs)
                        const allImages = Array.from(document.querySelectorAll('img'));
                        const visibleImages = allImages.filter(img => 
                            isVisible(img) && 
                            img.naturalWidth > Config.minImageDimension && 
                            img.naturalHeight > Config.minImageDimension
                        );

                        // Sort by area descending
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
                Utils.log(`No media found in tab ${tabId}`);
                // Use existing reason code for missing media to maintain compatibility
                return { success: false, reason: 'no_image' };
            }

            Utils.log(`Found media in tab ${tabId}:`, mediaUrl);

            // Check URL duplicate before fetching/downloading
            await DownloadHistory.load();
            if (skipDuplicates && DownloadHistory.isDuplicateUrl(mediaUrl)) {
                Utils.log(`Duplicate URL skipped: ${mediaUrl}`);
                if (closeTab) {
                    await chrome.tabs.remove(tabId);
                }
                return { success: false, reason: 'duplicate_url' };
            }

            // Determine if the URL is a direct video based on extension
            const isVideo = /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|$)/i.test(mediaUrl);

            if (isVideo) {
                // Video download: do not fetch contents; download directly via URL
                let filename = Utils.createFilename(mediaUrl);
                // Ensure filename has a video extension
                if (!/\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i.test(filename)) {
                    filename = filename.replace(/\.[^/.]+$/, '') + '.mp4';
                }
                // Apply prefix if specified
                if (prefix) {
                    filename = prefix + '_' + filename;
                }
                const downloadId = await chrome.downloads.download({
                    url: mediaUrl,
                    filename: filename,
                    saveAs: false
                });
                Utils.log(`Video download started: ${filename} (ID: ${downloadId})`);
                // Add to history (without perceptual hash)
                await DownloadHistory.add(mediaUrl, filename, null);
                // Close tab after delay
                if (closeTab) {
                    setTimeout(async () => {
                        try {
                            await chrome.tabs.remove(tabId);
                            Utils.log(`Closed tab ${tabId}`);
                        } catch (error) {
                            Utils.log(`Failed to close tab ${tabId}:`, error);
                        }
                    }, Config.closeDelayMs);
                }
                return { success: true };
            }

            // Otherwise treat as image: fetch for verification and deduplication
            const response = await fetch(mediaUrl);
            if (!response.ok) {
                Utils.log(`Fetch failed for ${mediaUrl}: ${response.status}`);
                return { success: false, reason: 'fetch_failed' };
            }

            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            const mimeType = Utils.detectMimeType(bytes);

            // Generate perceptual hash
            const perceptualHash = await PerceptualHash.generate(arrayBuffer);

            // Check content duplicate for images
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
            let filename = Utils.createFilename(mediaUrl);
            filename = Utils.updateExtension(filename, mimeType);
            // Apply prefix if specified
            if (prefix) {
                filename = prefix + '_' + filename;
            }

            // Convert to base64 data URL (service workers don't have URL.createObjectURL)
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, i + chunkSize);
                binary += String.fromCharCode.apply(null, chunk);
            }
            const base64 = btoa(binary);
            const dataUrl = `data:${mimeType};base64,${base64}`;

            // Download image
            const downloadId = await chrome.downloads.download({
                url: dataUrl,
                filename: filename,
                saveAs: false
            });
            Utils.log(`Image download started: ${filename} (ID: ${downloadId})`);
            // Add to history
            await DownloadHistory.add(mediaUrl, filename, perceptualHash);
            // Close tab after delay
            if (closeTab) {
                setTimeout(async () => {
                    try {
                        await chrome.tabs.remove(tabId);
                        Utils.log(`Closed tab ${tabId}`);
                    } catch (error) {
                        Utils.log(`Failed to close tab ${tabId}:`, error);
                    }
                }, Config.closeDelayMs);
            }
            return { success: true };

        } catch (error) {
            Utils.log(`Error downloading from tab ${tabId}:`, error);
            return { success: false, reason: 'error', error: error.message };
        }
    },

    /**
     * Download from all selected (highlighted) tabs.
     * @param {Object} options - Download options
     */
    async downloadFromSelectedTabs(options = {}) {
        try {
            const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
            
            Utils.log(`Processing ${tabs.length} selected tab(s)`);

            if (tabs.length === 0) {
                return { processed: 0, success: 0, skipped: 0 };
            }

            // Initialize state
            DownloadState.reset();
            DownloadState.isRunning = true;
            DownloadState.total = tabs.length;

            // If only one tab selected and closeTabs is true, still don't auto-close single tab
            const effectiveOptions = {
                ...options,
                closeTabs: tabs.length > 1 ? options.closeTabs : false
            };

            const interval = options.interval || 100;

            // Process tabs sequentially with interval to prevent freezing
            for (let i = 0; i < tabs.length; i++) {
                // Check if paused - wait until resumed or cancelled
                while (DownloadState.isPaused && DownloadState.isRunning) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                // Check if cancelled
                if (!DownloadState.isRunning) {
                    Utils.log('Download cancelled');
                    break;
                }

                const result = await this.downloadFromTab(tabs[i].id, effectiveOptions);
                
                // Update state
                DownloadState.processed++;
                if (result.success) {
                    DownloadState.success++;
                } else {
                    DownloadState.skipped++;
                    if (result.reason?.startsWith('duplicate')) {
                        DownloadState.duplicates++;
                    }
                }

                // Wait before next download (but not after the last one)
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
            Utils.log('Batch complete:', stats);
            return stats;

        } catch (error) {
            DownloadState.reset();
            Utils.log('Error processing selected tabs:', error);
            return { processed: 0, success: 0, skipped: 0, error: error.message };
        }
    },

    /**
     * Download from current active tab only.
     * @param {Object} options - Download options
     */
    async downloadFromCurrentTab(options = {}) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) {
                Utils.log('No active tab found');
                return { success: false, reason: 'no_tab' };
            }

            // For current tab, default to not closing
            const effectiveOptions = {
                ...options,
                closeTabs: false
            };

            return await this.downloadFromTab(tab.id, effectiveOptions);

        } catch (error) {
            Utils.log('Error downloading from current tab:', error);
            return { success: false, reason: 'error', error: error.message };
        }
    }
};

// =============================================================================
// EVENT LISTENERS
// =============================================================================

// Helper to get options from storage
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

// =============================================================================
// VIDEO FUNCTIONS
// =============================================================================

async function scanVideosFromTabs(tabIds) {
    const videos = [];
    const seenUrls = new Set();
    
    for (const tabId of tabIds) {
        try {
            const tab = await chrome.tabs.get(tabId);
            const hostname = tab.url ? new URL(tab.url).hostname : 'unknown';
            
            // 1. Get DOM-derived URLs (high confidence - currently on page)
            try {
                const domResults = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: () => {
                        const found = [];
                        const videoElements = document.querySelectorAll('video');
                        
                        for (const video of videoElements) {
                            let url = video.currentSrc || video.src;
                            if (!url) {
                                const source = video.querySelector('source[src]');
                                if (source) url = source.src;
                            }
                            
                            // Skip blob URLs - these are MSE streams
                            if (url && url.startsWith('http')) {
                                found.push({
                                    url,
                                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                                    dimensions: (video.videoWidth && video.videoHeight) 
                                        ? `${video.videoWidth}×${video.videoHeight}` : null,
                                    isPlaying: !video.paused && !video.ended
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
                            verified: true,
                            duration: v.duration,
                            dimensions: v.dimensions,
                            filesize: null,
                            isPlaying: v.isPlaying
                        });
                    }
                }
            } catch (e) {
                Utils.log(`DOM scan failed for tab ${tabId}:`, e.message);
            }
            
            // 2. Add network-captured URLs (prioritize those from play events)
            const networkVideos = CapturedVideos.getForTab(tabId);
            for (const v of networkVideos) {
                if (!seenUrls.has(v.url)) {
                    seenUrls.add(v.url);
                    videos.push({
                        url: v.url,
                        source: hostname,
                        origin: v.fromPlayEvent ? 'play' : 'network',
                        verified: v.fromPlayEvent,
                        duration: v.duration,
                        dimensions: v.dimensions,
                        filesize: v.filesize
                    });
                }
            }
            
        } catch (error) {
            Utils.log(`Error scanning tab ${tabId}:`, error);
        }
    }
    
    // Sort: playing first, then play events, then DOM, then network
    videos.sort((a, b) => {
        if (a.isPlaying !== b.isPlaying) return a.isPlaying ? -1 : 1;
        if (a.origin !== b.origin) {
            const order = { dom: 0, play: 1, network: 2 };
            return (order[a.origin] ?? 3) - (order[b.origin] ?? 3);
        }
        return 0;
    });
    
    Utils.log(`Found ${videos.length} videos`);
    return { videos };
}

async function downloadSpecificVideos(urls, options = {}) {
    const interval = options.interval || 500;
    const prefix = options.prefix || '';
    
    DownloadState.reset();
    DownloadState.isRunning = true;
    DownloadState.total = urls.length;
    
    Utils.log(`Starting download of ${urls.length} videos`);
    
    // Get active tab for MAIN world fetch (has page cookies)
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
        DownloadState.reset();
        return { error: 'No active tab' };
    }
    
    for (const videoUrl of urls) {
        if (!DownloadState.isRunning) break;
        
        while (DownloadState.isPaused && DownloadState.isRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!DownloadState.isRunning) break;
        
        try {
            let filename = Utils.createFilename(videoUrl);
            if (prefix) filename = prefix + '_' + filename;
            
            Utils.log(`Downloading: ${filename}`);
            
            // Fetch in MAIN world - has page cookies and proper referer
            const results = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                world: 'MAIN',
                func: async (url) => {
                    try {
                        const response = await fetch(url, {
                            credentials: 'include',
                            headers: {
                                'Accept': 'video/*,*/*'
                            }
                        });
                        
                        if (!response.ok) {
                            return { error: `HTTP ${response.status}` };
                        }
                        
                        const contentType = response.headers.get('content-type') || '';
                        if (contentType.includes('text/html')) {
                            return { error: 'Received HTML (auth required?)' };
                        }
                        
                        const blob = await response.blob();
                        
                        // Convert to base64 for transfer to service worker
                        const base64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = () => reject(new Error('FileReader failed'));
                            reader.readAsDataURL(blob);
                        });
                        
                        return {
                            base64,
                            size: blob.size,
                            type: blob.type || contentType
                        };
                    } catch (err) {
                        return { error: err.message };
                    }
                },
                args: [videoUrl]
            });
            
            const result = results?.[0]?.result;
            
            if (!result || result.error) {
                Utils.log(`Fetch failed: ${result?.error || 'Unknown error'}`);
                DownloadState.processed++;
                DownloadState.skipped++;
                continue;
            }
            
            // Download via chrome.downloads API with base64 data URL
            try {
                await chrome.downloads.download({
                    url: result.base64,
                    filename: filename,
                    saveAs: false
                });
                
                Utils.log(`Download started: ${filename} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
                DownloadState.processed++;
                DownloadState.success++;
            } catch (downloadError) {
                Utils.log(`Download API failed: ${downloadError.message}`);
                DownloadState.processed++;
                DownloadState.skipped++;
            }
            
        } catch (error) {
            Utils.log(`Error downloading ${videoUrl}:`, error.message);
            DownloadState.processed++;
            DownloadState.skipped++;
        }
        
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
            } else if (message.action === 'scan-videos') {
                const result = await scanVideosFromTabs(message.tabIds);
                sendResponse(result);
            } else if (message.action === 'download-specific-videos') {
                const result = await downloadSpecificVideos(message.urls, message.options);
                sendResponse(result);
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

Utils.log('Image Downloader extension loaded');
