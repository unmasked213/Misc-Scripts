// ==UserScript==
// @name         Universal Image Downloader
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      7.1
// @description  Downloads images with Ctrl + double-click or Ctrl + Shift + click (macro-safe). Features perceptual hashing for duplicate detection, verified downloads, intelligent error handling, and optimized performance.
// @author       Unmasked213
// @match        *://*/*
// @run-at       document-start
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_listValues
// @grant        GM_deleteValue
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/universal_image_downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/universal_image_downloader.user.js
// ==/UserScript==

(() => {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // All magic numbers and user-configurable options centralized here.
    // =========================================================================

    const Config = {
        // Core behavior
        debug: false,
        closeTabAfterDownload: false,
        useTimestampInFilename: true,
        useOriginalFilename: false,
        showNotifications: false,
        
        // Download settings
        downloadMethod: 'gm',  // 'gm' (recommended), 'fetch', or 'direct' (unverified)
        maxParallelDownloads: 1,
        autoCloseThreshold: 5,
        showQueueStatus: true,
        fixContentType: true,

        // Timeouts (milliseconds)
        timeouts: {
            directDownload: 3000,      // Wait before marking direct download as initiated
            blobSave: 2000,            // Wait for browser save dialog
            fetchRequest: 30000,       // Network request timeout
            gmDownload: 60000,         // GM_download timeout
            anchorCleanup: 1000,       // DOM cleanup delay
            notificationFade: 2000,    // Notification display duration
            pillFade: 3000,            // Pill auto-fade delay
            processQueue: 100,         // Queue processing interval
            initNotification: 1000     // Startup notification delay
        },

        // Retry settings
        retry: {
            maxAttempts: 2,
            delayMs: 500
        },

        // Image detection
        detection: {
            trackMousePosition: true,
            mouseTrackDebounceMs: 16,  // ~60fps
            addDebugHotkey: true,
            lookForHiddenImages: true,
            handleBackgroundImages: true,
            minImageDimension: 50,     // Minimum px to consider as real image
            parentTraversalDepth: 5,   // Max levels to search for images
            visibilityCache: {
                enabled: true,
                maxSize: 500,
                ttlMs: 1000
            }
        },

        // Deduplication
        deduplication: {
            enabled: true,
            storageKeyPrefix: 'img_dl_',
            timeframeDays: 30,
            notifyOnDuplicate: true,
            skipDuplicates: true,
            ignoreQueryParams: true,
            clearCacheHotkey: true,
            // Perceptual hashing for content-based deduplication
            perceptualHash: {
                enabled: true,
                hashSize: 8,           // 8x8 = 64-bit hash
                sampleSize: 32,        // Downscale to 32x32 before hashing
                hammingThreshold: 5    // Max bit difference to consider duplicate
            }
        },

        // Error classification
        errors: {
            showDetails: true,
            logToConsole: true
        },

        // Trigger debounce (prevents double-firing on manual Ctrl+double-click)
        triggerDebounceMs: 300
    };

    // =========================================================================
    // ERROR TYPES
    // Structured error handling with categorization.
    // =========================================================================

    /**
     * Custom error class for download failures with categorization.
     */
    class DownloadError extends Error {
        /**
         * @param {string} message - Human-readable error message
         * @param {string} category - Error category: 'network', 'cors', 'http', 'timeout', 'filesystem', 'unknown'
         * @param {number|null} httpStatus - HTTP status code if applicable
         * @param {Error|null} cause - Original error that caused this
         */
        constructor(message, category, httpStatus = null, cause = null) {
            super(message);
            this.name = 'DownloadError';
            this.category = category;
            this.httpStatus = httpStatus;
            this.cause = cause;
            this.timestamp = Date.now();
        }

        /**
         * Create error from fetch Response object.
         * @param {Response} response - Fetch Response
         * @returns {DownloadError}
         */
        static fromResponse(response) {
            const category = response.status === 0 ? 'cors' : 'http';
            const message = `HTTP ${response.status}: ${response.statusText || 'Request failed'}`;
            return new DownloadError(message, category, response.status);
        }

        /**
         * Create error from caught exception.
         * @param {Error} error - Original error
         * @returns {DownloadError}
         */
        static fromException(error) {
            const message = error.message || 'Unknown error';
            let category = 'unknown';

            if (message.includes('NetworkError') || message.includes('Failed to fetch')) {
                category = 'network';
            } else if (message.includes('CORS') || message.includes('cross-origin')) {
                category = 'cors';
            } else if (message.includes('timeout') || message.includes('Timeout')) {
                category = 'timeout';
            } else if (message.includes('abort') || message.includes('Abort')) {
                category = 'aborted';
            }

            return new DownloadError(message, category, null, error);
        }

        /**
         * Get user-friendly error message.
         * @returns {string}
         */
        toUserMessage() {
            const messages = {
                'cors': 'Blocked by website security (CORS)',
                'network': 'Network connection failed',
                'timeout': 'Request timed out',
                'http': `Server error (${this.httpStatus})`,
                'filesystem': 'Could not save file',
                'aborted': 'Download cancelled',
                'unknown': 'Download failed'
            };
            return messages[this.category] || messages.unknown;
        }
    }

    // =========================================================================
    // UTILITIES
    // Pure functions with no side effects.
    // =========================================================================

    const Utils = {
        /**
         * Log message to console if debug mode enabled.
         * @param {...any} args - Arguments to log
         */
        log(...args) {
            if (Config.debug) {
                console.log('[ImageDownloader]', ...args);
            }
        },

        /**
         * Log error with optional details.
         * @param {string} context - Where the error occurred
         * @param {Error|DownloadError} error - The error object
         */
        logError(context, error) {
            if (Config.errors.logToConsole) {
                console.error(`[ImageDownloader] ${context}:`, error);
                if (error.cause) {
                    console.error('[ImageDownloader] Caused by:', error.cause);
                }
            }
        },

        /**
         * Normalize URL for comparison by removing query params if configured.
         * @param {string} url - URL to normalize
         * @returns {string} Normalized URL
         */
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

        /**
         * Create storage-safe key from URL.
         * @param {string} url - URL to hash
         * @returns {string} Safe key string
         */
        hashUrl(url) {
            return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        },

        /**
         * Detect MIME type from file signature bytes.
         * @param {Uint8Array} bytes - First bytes of file
         * @returns {string} MIME type
         */
        detectMimeType(bytes) {
            const signatures = [
                { bytes: [0xFF, 0xD8], mime: 'image/jpeg' },
                { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: 'image/png' },
                { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
                { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], mime: 'image/webp' },
                { bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C], mime: 'image/svg+xml' },
                { bytes: [0x3C, 0x73, 0x76, 0x67], mime: 'image/svg+xml' },
                { bytes: [0x00, 0x00, 0x00], offset: 4, match: [0x66, 0x74, 0x79, 0x70], mime: 'image/avif' },
                { bytes: [0x42, 0x4D], mime: 'image/bmp' }
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

            return 'image/jpeg';
        },

        /**
         * Update filename extension based on MIME type.
         * @param {string} filename - Original filename
         * @param {string} mimeType - Detected MIME type
         * @returns {string} Filename with correct extension
         */
        updateExtension(filename, mimeType) {
            const extensionMap = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp',
                'image/svg+xml': '.svg',
                'image/avif': '.avif',
                'image/bmp': '.bmp'
            };

            const extension = extensionMap[mimeType] || '.jpg';
            const baseName = filename.replace(/\.[^/.]+$/, '');
            return baseName + extension;
        },

        /**
         * Generate filename from URL with optional timestamp.
         * @param {string} imgUrl - Image URL
         * @returns {string} Generated filename
         */
        createFilename(imgUrl) {
            let filename = '';

            try {
                const url = new URL(imgUrl);
                const pathParts = url.pathname.split('/');
                filename = pathParts[pathParts.length - 1].split('?')[0];
            } catch {
                filename = imgUrl.split('/').pop().split('?')[0];
            }

            filename = filename.replace(/[/\\?%*:|"<>]/g, '_');

            if (!filename.includes('.')) {
                const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
                const foundExt = extensions.find(ext => imgUrl.toLowerCase().includes(ext));
                filename += foundExt || '.jpg';
            }

            if (!filename || filename === '.' || filename.length < 3) {
                filename = `image_${Math.floor(Math.random() * 10000)}.jpg`;
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

        /**
         * Create debounced version of function.
         * @param {Function} fn - Function to debounce
         * @param {number} delay - Delay in milliseconds
         * @returns {Function} Debounced function
         */
        debounce(fn, delay) {
            let timeoutId = null;
            return function(...args) {
                if (timeoutId) clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn.apply(this, args), delay);
            };
        }
    };

    // =========================================================================
    // PERCEPTUAL HASH
    // Content-based image fingerprinting for duplicate detection.
    // =========================================================================

    /**
     * Perceptual hash generator using average hash algorithm.
     * Creates fingerprints that survive resizing, compression, and minor edits.
     */
    class PerceptualHash {
        /**
         * Generate perceptual hash from image data.
         * @param {Blob} blob - Image blob
         * @returns {Promise<string|null>} 64-bit hash as hex string, or null on failure
         */
        static async generate(blob) {
            if (!Config.deduplication.perceptualHash.enabled) {
                return null;
            }

            try {
                const imageBitmap = await createImageBitmap(blob);
                const { hashSize, sampleSize } = Config.deduplication.perceptualHash;

                // Create canvas for processing
                const canvas = new OffscreenCanvas(sampleSize, sampleSize);
                const ctx = canvas.getContext('2d');

                // Draw and downscale image
                ctx.drawImage(imageBitmap, 0, 0, sampleSize, sampleSize);
                imageBitmap.close();

                // Get grayscale pixel data
                const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
                const pixels = imageData.data;
                const grayscale = [];

                for (let i = 0; i < pixels.length; i += 4) {
                    // Standard grayscale conversion
                    const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
                    grayscale.push(gray);
                }

                // Further downscale to hash size using block averaging
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

                // Calculate average
                const average = hashPixels.reduce((a, b) => a + b, 0) / hashPixels.length;

                // Generate hash: 1 if pixel > average, 0 otherwise
                let hash = '';
                for (const pixel of hashPixels) {
                    hash += pixel > average ? '1' : '0';
                }

                // Convert binary string to hex
                const hexHash = BigInt('0b' + hash).toString(16).padStart(hashSize * hashSize / 4, '0');

                Utils.log('Generated perceptual hash:', hexHash);
                return hexHash;

            } catch (error) {
                Utils.logError('Perceptual hash generation', error);
                return null;
            }
        }

        /**
         * Calculate Hamming distance between two hashes.
         * @param {string} hash1 - First hash (hex)
         * @param {string} hash2 - Second hash (hex)
         * @returns {number} Number of differing bits
         */
        static hammingDistance(hash1, hash2) {
            if (!hash1 || !hash2 || hash1.length !== hash2.length) {
                return Infinity;
            }

            try {
                const bin1 = BigInt('0x' + hash1);
                const bin2 = BigInt('0x' + hash2);
                const xor = bin1 ^ bin2;

                // Count set bits
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
        }

        /**
         * Check if two hashes represent similar images.
         * @param {string} hash1 - First hash
         * @param {string} hash2 - Second hash
         * @returns {boolean} True if images are perceptually similar
         */
        static isSimilar(hash1, hash2) {
            const distance = this.hammingDistance(hash1, hash2);
            return distance <= Config.deduplication.perceptualHash.hammingThreshold;
        }
    }

    // =========================================================================
    // VISIBILITY OBSERVER
    // Efficient element visibility checking using IntersectionObserver.
    // =========================================================================

    /**
     * Caches element visibility using IntersectionObserver for performance.
     */
    class VisibilityObserver {
        constructor() {
            /** @type {Map<Element, boolean>} */
            this.visibilityCache = new Map();
            /** @type {Map<Element, number>} */
            this.cacheTimestamps = new Map();
            /** @type {Set<Element>} */
            this.pendingElements = new Set();

            this.observer = new IntersectionObserver(
                (entries) => this.handleIntersection(entries),
                { threshold: 0.01 }
            );
        }

        /**
         * Handle intersection observer callback.
         * @param {IntersectionObserverEntry[]} entries
         */
        handleIntersection(entries) {
            const now = Date.now();
            for (const entry of entries) {
                this.visibilityCache.set(entry.target, entry.isIntersecting);
                this.cacheTimestamps.set(entry.target, now);
                this.pendingElements.delete(entry.target);
            }
        }

        /**
         * Check if element is visible, using cache when available.
         * @param {Element} element - Element to check
         * @returns {boolean} Visibility status
         */
        isVisible(element) {
            if (!element) return false;

            // Check cache validity
            if (Config.detection.visibilityCache.enabled) {
                const cached = this.visibilityCache.get(element);
                const timestamp = this.cacheTimestamps.get(element);

                if (cached !== undefined && timestamp) {
                    const age = Date.now() - timestamp;
                    if (age < Config.detection.visibilityCache.ttlMs) {
                        return cached;
                    }
                }

                // Limit cache size
                if (this.visibilityCache.size > Config.detection.visibilityCache.maxSize) {
                    this.pruneCache();
                }
            }

            // Start observing if not already
            if (!this.pendingElements.has(element)) {
                this.pendingElements.add(element);
                this.observer.observe(element);
            }

            // Fallback to synchronous check for immediate result
            return this.checkVisibilitySync(element);
        }

        /**
         * Synchronous visibility check fallback.
         * @param {Element} element
         * @returns {boolean}
         */
        checkVisibilitySync(element) {
            if (!element) return false;

            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return false;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        /**
         * Remove oldest entries from cache.
         */
        pruneCache() {
            const entries = Array.from(this.cacheTimestamps.entries());
            entries.sort((a, b) => a[1] - b[1]);

            const toRemove = entries.slice(0, Math.floor(entries.length / 2));
            for (const [element] of toRemove) {
                this.visibilityCache.delete(element);
                this.cacheTimestamps.delete(element);
                this.observer.unobserve(element);
            }
        }

        /**
         * Clean up observer.
         */
        destroy() {
            this.observer.disconnect();
            this.visibilityCache.clear();
            this.cacheTimestamps.clear();
            this.pendingElements.clear();
        }
    }

    // =========================================================================
    // DOWNLOAD HISTORY
    // Persistent storage for duplicate tracking with URL and perceptual hash.
    // =========================================================================

    /**
     * Manages download history with URL-based and perceptual hash deduplication.
     */
    class DownloadHistory {
        constructor() {
            /** @type {Map<string, Object>} URL hash -> entry data */
            this.urlHistory = new Map();
            /** @type {Map<string, Object>} Perceptual hash -> entry data */
            this.perceptualHistory = new Map();
            this.load();
        }

        /**
         * Load history from persistent storage.
         */
        load() {
            if (!Config.deduplication.enabled) return;

            try {
                if (typeof GM_listValues === 'undefined' || typeof GM_getValue === 'undefined') {
                    return;
                }

                const keys = GM_listValues();
                const prefix = Config.deduplication.storageKeyPrefix;

                keys.filter(key => key.startsWith(prefix))
                    .forEach(key => {
                        const value = GM_getValue(key);
                        if (value) {
                            try {
                                const data = JSON.parse(value);
                                const urlKey = key.substring(prefix.length);
                                this.urlHistory.set(urlKey, data);

                                // Also index by perceptual hash if available
                                if (data.perceptualHash) {
                                    this.perceptualHistory.set(data.perceptualHash, data);
                                }
                            } catch { /* Ignore corrupt entries */ }
                        }
                    });

                this.cleanup();
                Utils.log(`Loaded ${this.urlHistory.size} items in download history`);

            } catch (error) {
                Utils.logError('Loading download history', error);
            }
        }

        /**
         * Remove expired entries.
         */
        cleanup() {
            if (this.urlHistory.size === 0) return;

            const cutoffTime = Date.now() - (Config.deduplication.timeframeDays * 24 * 60 * 60 * 1000);
            let deleted = 0;

            for (const [key, data] of this.urlHistory.entries()) {
                if (data.timestamp < cutoffTime) {
                    this.urlHistory.delete(key);
                    if (data.perceptualHash) {
                        this.perceptualHistory.delete(data.perceptualHash);
                    }
                    if (typeof GM_deleteValue !== 'undefined') {
                        GM_deleteValue(Config.deduplication.storageKeyPrefix + key);
                    }
                    deleted++;
                }
            }

            if (deleted > 0) {
                Utils.log(`Cleaned up ${deleted} old entries from download history`);
            }
        }

        /**
         * Clear all history.
         */
        clear() {
            try {
                this.urlHistory.clear();
                this.perceptualHistory.clear();

                if (typeof GM_listValues !== 'undefined' && typeof GM_deleteValue !== 'undefined') {
                    const keys = GM_listValues();
                    const prefix = Config.deduplication.storageKeyPrefix;
                    let deleted = 0;

                    keys.filter(key => key.startsWith(prefix))
                        .forEach(key => {
                            GM_deleteValue(key);
                            deleted++;
                        });

                    Utils.log(`Cleared ${deleted} entries from persistent storage`);
                }

                if (Config.showNotifications) {
                    NotificationManager.show('Download history cleared');
                }
            } catch (error) {
                Utils.logError('Clearing download history', error);
            }
        }

        /**
         * Check if URL is duplicate.
         * @param {string} url - URL to check
         * @returns {boolean}
         */
        isDuplicateUrl(url) {
            if (!Config.deduplication.enabled || !url) return false;

            const normalizedUrl = Utils.normalizeUrl(url);
            const urlKey = Utils.hashUrl(normalizedUrl);
            return this.urlHistory.has(urlKey);
        }

        /**
         * Check if perceptual hash is duplicate.
         * @param {string} pHash - Perceptual hash to check
         * @returns {Object|null} Matching entry or null
         */
        findPerceptualDuplicate(pHash) {
            if (!Config.deduplication.perceptualHash.enabled || !pHash) {
                return null;
            }

            // Exact match
            if (this.perceptualHistory.has(pHash)) {
                return this.perceptualHistory.get(pHash);
            }

            // Similar match within threshold
            for (const [hash, data] of this.perceptualHistory.entries()) {
                if (PerceptualHash.isSimilar(pHash, hash)) {
                    return data;
                }
            }

            return null;
        }

        /**
         * Check if image is duplicate by URL or content.
         * @param {string} url - Image URL
         * @param {string|null} perceptualHash - Optional perceptual hash
         * @returns {{isDuplicate: boolean, reason: string|null, previousEntry: Object|null}}
         */
        checkDuplicate(url, perceptualHash = null) {
            if (!Config.deduplication.enabled) {
                return { isDuplicate: false, reason: null, previousEntry: null };
            }

            // Check URL first (fast)
            if (this.isDuplicateUrl(url)) {
                const urlKey = Utils.hashUrl(Utils.normalizeUrl(url));
                const entry = this.urlHistory.get(urlKey);
                return { isDuplicate: true, reason: 'url', previousEntry: entry };
            }

            // Check perceptual hash (catches renamed/resized duplicates)
            if (perceptualHash) {
                const entry = this.findPerceptualDuplicate(perceptualHash);
                if (entry) {
                    return { isDuplicate: true, reason: 'content', previousEntry: entry };
                }
            }

            return { isDuplicate: false, reason: null, previousEntry: null };
        }

        /**
         * Add entry to history.
         * @param {string} url - Image URL
         * @param {string} filename - Saved filename
         * @param {string|null} perceptualHash - Optional perceptual hash
         */
        add(url, filename, perceptualHash = null) {
            if (!Config.deduplication.enabled || !url) return;

            const normalizedUrl = Utils.normalizeUrl(url);
            const urlKey = Utils.hashUrl(normalizedUrl);

            const entry = {
                originalUrl: url,
                filename: filename,
                timestamp: Date.now(),
                perceptualHash: perceptualHash
            };

            this.urlHistory.set(urlKey, entry);

            if (perceptualHash) {
                this.perceptualHistory.set(perceptualHash, entry);
            }

            if (typeof GM_setValue !== 'undefined') {
                try {
                    GM_setValue(Config.deduplication.storageKeyPrefix + urlKey, JSON.stringify(entry));
                } catch (error) {
                    Utils.logError('Saving to GM storage', error);
                }
            }
        }
    }

    // =========================================================================
    // IMAGE FINDER
    // Intelligent image source detection with caching.
    // =========================================================================

    /**
     * Finds the best image source from a clicked element and its context.
     */
    class ImageFinder {
        /** @type {Map<Element, {url: string, timestamp: number}>} */
        static cache = new Map();
        static CACHE_TTL = 500;

        /**
         * Find best image URL from element context.
         * @param {Element} element - Clicked element
         * @returns {string|null} Best image URL or null
         */
        static find(element) {
            if (!element) return null;

            // Check cache
            const cached = this.cache.get(element);
            if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                return cached.url;
            }

            Utils.log('Searching for image source from element:', element);

            const potentialSources = [
                ...this.fromImgElement(element),
                ...this.fromContainedImages(element),
                ...this.fromLinks(element),
                ...this.fromBackgroundImage(element),
                ...this.fromDataAttributes(element),
                ...this.fromGalleries(),
                ...this.fromParentElements(element),
                ...this.fromNearbyImages()
            ];

            const uniqueSources = this.deduplicateSources(potentialSources);
            uniqueSources.sort((a, b) => b.priority - a.priority);

            if (Config.debug && uniqueSources.length > 0) {
                Utils.log('Potential image sources (in priority order):');
                uniqueSources.slice(0, 5).forEach((source, index) => {
                    const truncated = source.url.substring(0, 80);
                    Utils.log(`${index + 1}. Priority ${source.priority}: ${truncated}...`);
                });
            }

            const result = uniqueSources.length > 0 ? uniqueSources[0].url : null;

            // Cache result
            this.cache.set(element, { url: result, timestamp: Date.now() });

            // Prune cache if too large
            if (this.cache.size > 100) {
                const entries = Array.from(this.cache.entries());
                entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
                entries.slice(0, 50).forEach(([key]) => this.cache.delete(key));
            }

            return result;
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromImgElement(element) {
            if (element.tagName?.toLowerCase() !== 'img') return [];
            const url = this.getBestImageVersion(element);
            return url ? [{ url, priority: 100 }] : [];
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromContainedImages(element) {
            const images = element.querySelectorAll?.('img') || [];
            return Array.from(images)
                .filter(img => visibilityObserver.isVisible(img))
                .map(img => ({ url: this.getBestImageVersion(img), priority: 90 }))
                .filter(item => item.url);
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromLinks(element) {
            if (element.tagName?.toLowerCase() !== 'a') return [];
            const href = element.href;
            if (href && /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(href)) {
                return [{ url: href, priority: 85 }];
            }
            return [];
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromBackgroundImage(element) {
            if (!Config.detection.handleBackgroundImages) return [];
            const bgImage = this.getBackgroundImage(element);
            return bgImage ? [{ url: bgImage, priority: 80 }] : [];
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromDataAttributes(element) {
            const dataUrlAttributes = [
                'data-src', 'data-original', 'data-orig-file', 'data-large-file',
                'data-full-src', 'data-zoom-src', 'data-large', 'data-1000px',
                'data-image', 'data-zoom-image', 'data-srcset', 'data-full'
            ];

            return dataUrlAttributes
                .map(attr => {
                    const val = element.getAttribute?.(attr);
                    if (val?.trim() && (val.startsWith('http') || val.startsWith('/'))) {
                        return { url: this.ensureAbsoluteUrl(val), priority: 75 };
                    }
                    return null;
                })
                .filter(Boolean);
        }

        /**
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromGalleries() {
            const gallerySelectors = [
                '.pswp__item:not([aria-hidden="true"]) img',
                '.pswp__zoom-wrap img',
                '.pswp__img',
                '.lg-current img',
                '.lg-img-wrap img',
                '.fancybox-image',
                '.mfp-img'
            ];

            return gallerySelectors
                .map(selector => {
                    const img = document.querySelector(selector);
                    return img ? { url: this.getBestImageVersion(img), priority: 95 } : null;
                })
                .filter(item => item?.url);
        }

        /**
         * @param {Element} element
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromParentElements(element) {
            const sources = [];
            let currentElem = element;
            const maxLevels = Config.detection.parentTraversalDepth;
            let level = 0;

            while (currentElem && currentElem !== document.body && level < maxLevels) {
                const imgs = currentElem.querySelectorAll?.('img') || [];
                for (const img of imgs) {
                    if (visibilityObserver.isVisible(img)) {
                        const url = this.getBestImageVersion(img);
                        if (url) {
                            sources.push({ url, priority: 70 - level * 5 });
                        }
                    }
                }

                if (Config.detection.handleBackgroundImages) {
                    const bgImage = this.getBackgroundImage(currentElem);
                    if (bgImage) {
                        sources.push({ url: bgImage, priority: 65 - level * 5 });
                    }
                }

                currentElem = currentElem.parentElement;
                level++;
            }

            return sources;
        }

        /**
         * @returns {Array<{url: string, priority: number}>}
         */
        static fromNearbyImages() {
            if (!Config.detection.lookForHiddenImages || !mouseTracker.x || !mouseTracker.y) {
                return [];
            }

            const nearbyImg = this.findNearestVisibleImage(mouseTracker.x, mouseTracker.y);
            if (nearbyImg) {
                const url = this.getBestImageVersion(nearbyImg);
                return url ? [{ url, priority: 60 }] : [];
            }
            return [];
        }

        /**
         * Get highest quality version of an image.
         * @param {HTMLImageElement} imgElement
         * @returns {string|null}
         */
        static getBestImageVersion(imgElement) {
            if (!imgElement?.src) return null;

            let bestSrc = imgElement.src;
            let bestWidth = imgElement.naturalWidth || 0;

            // Check srcset for highest resolution
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

            // Check high-quality data attributes
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

            // Check parent link for full-size version
            const parentLink = imgElement.closest('a');
            if (parentLink?.href && /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(parentLink.href)) {
                bestSrc = parentLink.href;
            }

            return this.ensureAbsoluteUrl(bestSrc);
        }

        /**
         * Extract background image URL from element.
         * @param {Element} element
         * @returns {string|null}
         */
        static getBackgroundImage(element) {
            if (!element) return null;

            try {
                const style = getComputedStyle(element);
                if (style.backgroundImage && style.backgroundImage !== 'none') {
                    const match = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match?.[1]) {
                        return this.ensureAbsoluteUrl(match[1]);
                    }
                }
            } catch { /* Ignore cross-origin errors */ }

            return null;
        }

        /**
         * Find nearest visible image to coordinates.
         * @param {number} x - Client X coordinate
         * @param {number} y - Client Y coordinate
         * @returns {HTMLImageElement|null}
         */
        static findNearestVisibleImage(x, y) {
            const minDim = Config.detection.minImageDimension;
            const images = Array.from(document.querySelectorAll('img'))
                .filter(img => {
                    return visibilityObserver.isVisible(img) &&
                           img.naturalWidth > minDim &&
                           img.naturalHeight > minDim;
                });

            if (images.length === 0) return null;

            let nearestImage = null;
            let shortestDistance = Infinity;

            for (const img of images) {
                const rect = img.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const distance = Math.hypot(centerX - x, centerY - y);

                if (distance < shortestDistance) {
                    shortestDistance = distance;
                    nearestImage = img;
                }
            }

            return nearestImage;
        }

        /**
         * Convert relative URL to absolute.
         * @param {string} url
         * @returns {string}
         */
        static ensureAbsoluteUrl(url) {
            if (!url) return url;
            if (url.startsWith('//')) {
                return window.location.protocol + url;
            }
            if (url.startsWith('/')) {
                return window.location.origin + url;
            }
            return url;
        }

        /**
         * Remove duplicate URLs from source list.
         * @param {Array<{url: string, priority: number}>} sources
         * @returns {Array<{url: string, priority: number}>}
         */
        static deduplicateSources(sources) {
            const seen = new Set();
            return sources.filter(source => {
                if (!source?.url || seen.has(source.url)) return false;
                seen.add(source.url);
                return true;
            });
        }
    }

    // =========================================================================
    // DOWNLOAD QUEUE
    // Manages download queue with retry logic and error handling.
    // =========================================================================

    /**
     * Download item status types.
     * @typedef {'queued'|'downloading'|'complete'|'initiated'|'failed'} DownloadStatus
     */

    /**
     * @typedef {Object} DownloadItem
     * @property {string} url - Image URL
     * @property {string} filename - Target filename
     * @property {DownloadStatus} status - Current status
     * @property {Date} addedTime - When item was queued
     * @property {Date|null} startTime - When download started
     * @property {Date|null} endTime - When download completed
     * @property {number} retries - Number of retry attempts
     * @property {string} method - Download method used
     * @property {number|null} timeoutId - Pending timeout ID
     * @property {DownloadError|null} lastError - Last error encountered
     * @property {string|null} perceptualHash - Content hash for deduplication
     * @property {Blob|null} blob - Downloaded blob data (for hash generation)
     */

    /**
     * Manages the download queue with verified completion tracking.
     */
    class DownloadQueue {
        constructor() {
            /** @type {DownloadItem[]} */
            this.queue = [];
            this.activeDownloads = 0;
            this.isProcessing = false;
            this.startTime = null;
        }

        /**
         * Add image to download queue.
         * @param {string} imgUrl - URL to download
         * @returns {'queued'|'already_in_queue'|'duplicate'}
         */
        add(imgUrl) {
            if (!imgUrl) return false;

            if (this.isInQueue(imgUrl)) {
                Utils.log('Image already in queue, skipping:', imgUrl);
                return 'already_in_queue';
            }

            // Check URL-based duplicate (fast check before downloading)
            if (Config.deduplication.enabled && downloadHistory.isDuplicateUrl(imgUrl)) {
                if (Config.deduplication.skipDuplicates) {
                    if (Config.deduplication.notifyOnDuplicate) {
                        NotificationManager.show('Duplicate image (URL match)');
                    }
                    Utils.log('Duplicate image detected, skipping:', imgUrl);
                    return 'duplicate';
                }
            }

            const filename = Utils.createFilename(imgUrl);

            /** @type {DownloadItem} */
            const downloadItem = {
                url: imgUrl,
                filename: filename,
                status: 'queued',
                addedTime: new Date(),
                startTime: null,
                endTime: null,
                retries: 0,
                method: 'pending',
                timeoutId: null,
                lastError: null,
                perceptualHash: null,
                blob: null
            };

            this.queue.push(downloadItem);
            Utils.log(`Added to queue: ${imgUrl} (${this.queue.length} items in queue)`);

            if (!this.isProcessing) {
                if (!this.startTime) this.startTime = new Date();
                setTimeout(() => this.process(), Config.timeouts.processQueue);
            }

            return 'queued';
        }

        /**
         * Check if URL is already in queue.
         * @param {string} url
         * @returns {boolean}
         */
        isInQueue(url) {
            if (!url) return false;
            const normalizedUrl = Utils.normalizeUrl(url);
            return this.queue.some(item =>
                Utils.normalizeUrl(item.url) === normalizedUrl &&
                !['failed', 'complete'].includes(item.status)
            );
        }

        /**
         * Process next items in queue.
         */
        process() {
            if (this.queue.length === 0 && this.activeDownloads === 0) {
                this.isProcessing = false;

                if (Config.closeTabAfterDownload) {
                    const completedCount = this.queue.filter(item => item.status === 'complete').length;
                    if (completedCount <= Config.autoCloseThreshold) {
                        setTimeout(() => window.close(), 500);
                    }
                }

                return;
            }

            this.isProcessing = true;

            while (this.activeDownloads < Config.maxParallelDownloads) {
                const nextItemIndex = this.queue.findIndex(item => item.status === 'queued');
                if (nextItemIndex === -1) break;

                const item = this.queue[nextItemIndex];
                item.status = 'downloading';
                item.startTime = new Date();
                this.activeDownloads++;

                Utils.log(`Starting download for: ${item.url} (${this.activeDownloads} active)`);

                this.startDownload(item);
            }
        }

        /**
         * Start download using configured method.
         * @param {DownloadItem} item
         */
        startDownload(item) {
            const methods = {
                'gm': () => this.downloadWithGM(item),
                'fetch': () => this.downloadWithFetch(item),
                'direct': () => this.downloadDirect(item)
            };

            const method = methods[Config.downloadMethod] || methods.gm;
            method();
        }

        /**
         * Download using GM_download API (preferred - has callbacks).
         * @param {DownloadItem} item
         */
        downloadWithGM(item) {
            if (typeof GM_download === 'undefined') {
                Utils.log('GM_download unavailable, falling back to fetch');
                this.downloadWithFetch(item);
                return;
            }

            item.method = 'gm';

            try {
                const downloadConfig = {
                    url: item.url,
                    name: item.filename,
                    timeout: Config.timeouts.gmDownload,
                    onload: () => {
                        Utils.log('Download successful via GM_download');
                        // GM_download doesn't give us the blob, so we can't generate perceptual hash
                        // This is a tradeoff for simplicity - URL-based dedup still works
                        this.completeDownload(item, 'complete');
                    },
                    onerror: (error) => {
                        const downloadError = new DownloadError(
                            error.error || 'GM_download failed',
                            error.error === 'not_whitelisted' ? 'cors' : 'unknown'
                        );
                        Utils.logError('GM_download', downloadError);
                        item.lastError = downloadError;
                        this.clearItemTimeout(item);
                        this.downloadWithFetch(item);
                    },
                    ontimeout: () => {
                        const downloadError = new DownloadError('GM_download timed out', 'timeout');
                        Utils.logError('GM_download', downloadError);
                        item.lastError = downloadError;
                        this.clearItemTimeout(item);
                        this.downloadWithFetch(item);
                    }
                };

                GM_download(downloadConfig);

            } catch (error) {
                const downloadError = DownloadError.fromException(error);
                Utils.logError('GM_download exception', downloadError);
                item.lastError = downloadError;
                this.clearItemTimeout(item);
                this.downloadWithFetch(item);
            }
        }

        /**
         * Download using Fetch API (verified - we get the data).
         * @param {DownloadItem} item
         */
        downloadWithFetch(item) {
            this.clearItemTimeout(item);
            item.method = 'fetch';

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), Config.timeouts.fetchRequest);

            // Cache-bust URL to avoid stale responses
            const cacheBustUrl = item.url.includes('?')
                ? `${item.url}&_cb=${Date.now()}`
                : `${item.url}?_cb=${Date.now()}`;

            fetch(cacheBustUrl, {
                method: 'GET',
                mode: 'cors',
                credentials: 'include',
                headers: { 'Accept': 'image/*, */*' },
                signal: controller.signal
            })
            .then(response => {
                clearTimeout(timeoutId);
                if (!response.ok) {
                    throw DownloadError.fromResponse(response);
                }
                return response.arrayBuffer();
            })
            .then(async arrayBuffer => {
                const bytes = new Uint8Array(arrayBuffer);
                const mimeType = Utils.detectMimeType(bytes);
                Utils.log('Detected MIME type:', mimeType);

                const blob = new Blob([arrayBuffer], { type: mimeType });
                item.blob = blob;

                if (Config.fixContentType) {
                    item.filename = Utils.updateExtension(item.filename, mimeType);
                }

                // Generate perceptual hash for content-based deduplication
                if (Config.deduplication.perceptualHash.enabled) {
                    try {
                        item.perceptualHash = await PerceptualHash.generate(blob);

                        // Check for content duplicate before saving
                        if (item.perceptualHash) {
                            const dupCheck = downloadHistory.checkDuplicate(item.url, item.perceptualHash);
                            if (dupCheck.isDuplicate && dupCheck.reason === 'content') {
                                Utils.log('Content duplicate detected via perceptual hash');
                                if (Config.deduplication.skipDuplicates) {
                                    if (Config.deduplication.notifyOnDuplicate) {
                                        NotificationManager.show('Duplicate image (content match)');
                                    }
                                    this.completeDownload(item, 'duplicate');
                                    return;
                                }
                            }
                        }
                    } catch (hashError) {
                        Utils.logError('Perceptual hash generation', hashError);
                        // Continue without hash - URL dedup still works
                    }
                }

                this.saveBlobAsFile(item, blob);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                
                let downloadError;
                if (error instanceof DownloadError) {
                    downloadError = error;
                } else if (error.name === 'AbortError') {
                    downloadError = new DownloadError('Request timed out', 'timeout');
                } else {
                    downloadError = DownloadError.fromException(error);
                }

                Utils.logError('Fetch download', downloadError);
                item.lastError = downloadError;
                this.clearItemTimeout(item);

                if (item.retries < Config.retry.maxAttempts) {
                    item.retries++;
                    Utils.log(`Retrying download (attempt ${item.retries + 1})`);
                    setTimeout(() => this.downloadDirect(item), Config.retry.delayMs);
                } else {
                    this.completeDownload(item, 'failed');
                }
            });
        }

        /**
         * Download using anchor click (unverified - last resort).
         * @param {DownloadItem} item
         */
        downloadDirect(item) {
            this.clearItemTimeout(item);
            item.method = 'direct';

            const anchor = document.createElement('a');
            anchor.href = item.url;
            anchor.download = item.filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);

            try {
                anchor.click();

                // Direct downloads cannot verify completion (browser limitation).
                // Mark as 'initiated' to avoid corrupting duplicate tracking.
                item.timeoutId = setTimeout(() => {
                    this.completeDownload(item, 'initiated');
                }, Config.timeouts.directDownload);

            } catch (error) {
                const downloadError = DownloadError.fromException(error);
                Utils.logError('Direct download', downloadError);
                item.lastError = downloadError;

                // Clean up anchor immediately on error
                if (document.body.contains(anchor)) {
                    document.body.removeChild(anchor);
                }

                this.completeDownload(item, 'failed');
                return;
            }

            // Clean up anchor after delay
            setTimeout(() => {
                if (document.body.contains(anchor)) {
                    document.body.removeChild(anchor);
                }
            }, Config.timeouts.anchorCleanup);
        }

        /**
         * Save blob data as file download.
         * @param {DownloadItem} item
         * @param {Blob} blob
         */
        saveBlobAsFile(item, blob) {
            this.clearItemTimeout(item);

            let objectURL = null;

            try {
                objectURL = URL.createObjectURL(blob);
            } catch (error) {
                const downloadError = new DownloadError('Failed to create object URL', 'filesystem', null, error);
                Utils.logError('Blob URL creation', downloadError);
                item.lastError = downloadError;
                this.completeDownload(item, 'failed');
                return;
            }

            const anchor = document.createElement('a');
            anchor.href = objectURL;
            anchor.download = item.filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);

            try {
                anchor.click();

                // Fetch-based blob downloads are verified (we have the data),
                // so we can confidently mark as complete after browser processes it.
                item.timeoutId = setTimeout(() => {
                    this.completeDownload(item, 'complete');
                }, Config.timeouts.blobSave);

            } catch (error) {
                const downloadError = DownloadError.fromException(error);
                Utils.logError('Blob save', downloadError);
                item.lastError = downloadError;
                this.completeDownload(item, 'failed');
            }

            // Clean up DOM and revoke URL
            setTimeout(() => {
                if (document.body.contains(anchor)) {
                    document.body.removeChild(anchor);
                }
                if (objectURL) {
                    try {
                        URL.revokeObjectURL(objectURL);
                    } catch { /* Ignore revocation errors */ }
                }
            }, Config.timeouts.anchorCleanup);
        }

        /**
         * Mark download as complete with given status.
         * @param {DownloadItem} item
         * @param {'complete'|'initiated'|'failed'|'duplicate'} status
         */
        completeDownload(item, status) {
            // Guard against duplicate completion calls
            if (['complete', 'failed', 'initiated', 'duplicate'].includes(item.status)) {
                return;
            }

            this.clearItemTimeout(item);

            item.status = status;
            item.endTime = new Date();
            this.activeDownloads = Math.max(0, this.activeDownloads - 1);

            const duration = item.startTime ? 
                ((item.endTime - item.startTime) / 1000).toFixed(2) : '?';
            Utils.log(`Download ${status}: ${item.filename} (${duration}s, ${this.activeDownloads} active)`);

            // Only add to duplicate history for VERIFIED completions
            if (status === 'complete') {
                downloadHistory.add(item.url, item.filename, item.perceptualHash);
            }

            // Clean up blob reference
            item.blob = null;

            // Show notification with appropriate message
            if (Config.showNotifications || (status === 'failed' && Config.errors.showDetails)) {
                const statusMessages = {
                    'complete': 'Download complete',
                    'initiated': 'Download sent (unverified)',
                    'failed': item.lastError ? item.lastError.toUserMessage() : 'Download failed',
                    'duplicate': 'Duplicate skipped'
                };
                NotificationManager.show(`${item.filename}: ${statusMessages[status]}`);
            }

            setTimeout(() => this.process(), Config.timeouts.processQueue);
        }

        /**
         * Clear pending timeout for item.
         * @param {DownloadItem} item
         */
        clearItemTimeout(item) {
            if (item.timeoutId) {
                clearTimeout(item.timeoutId);
                item.timeoutId = null;
            }
        }

        /**
         * Retry failed and unverified downloads.
         */
        retryFailed() {
            let retryCount = 0;

            for (const item of this.queue) {
                if (item.status === 'failed' || item.status === 'initiated') {
                    item.status = 'queued';
                    item.retries = 0;
                    item.timeoutId = null;
                    item.lastError = null;
                    retryCount++;
                }
            }

            if (retryCount > 0) {
                NotificationManager.show(`Retrying ${retryCount} download(s)`);
                this.process();
            } else {
                NotificationManager.show('No failed downloads to retry');
            }
        }

        /**
         * Get queue statistics.
         * @returns {{total: number, complete: number, failed: number, pending: number}}
         */
        getStats() {
            return {
                total: this.queue.length,
                complete: this.queue.filter(i => i.status === 'complete').length,
                failed: this.queue.filter(i => i.status === 'failed').length,
                pending: this.queue.filter(i => ['queued', 'downloading'].includes(i.status)).length
            };
        }

        /**
         * Clean up all pending operations.
         */
        cleanup() {
            for (const item of this.queue) {
                this.clearItemTimeout(item);
                item.blob = null;
            }
        }
    }

    // =========================================================================
    // UI COMPONENTS
    // Visual feedback for download status.
    // =========================================================================

    /**
     * Draggable pill notification for download status.
     */
    class PillNotification {
        constructor() {
            this.element = null;
            this.fadeTimeout = null;
            this.isDragging = false;
            this.dragState = {};
        }

        /**
         * Show pill with given state.
         * @param {'success'|'info'|'warning'|'error'} state
         */
        show(state) {
            if (!Config.showQueueStatus) return;

            this.remove();

            const states = {
                success: { color: '#4CAF50', icon: '?' },
                info: { color: '#2196F3', icon: '–' },
                warning: { color: '#FF9800', icon: '–' },
                error: { color: '#F44336', icon: '!' }
            };

            const currentState = states[state] || states.success;

            this.element = document.createElement('div');
            this.element.className = 'image-downloader-pill';
            this.element.style.cssText = `
                position: fixed;
                bottom: 30px;
                left: 50%;
                transform: translateX(-50%) scale(0.8);
                background: ${currentState.color};
                color: white;
                padding: 16px 32px;
                border-radius: 50px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 28px;
                font-weight: bold;
                z-index: 2147483647;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
                border: none;
                min-width: 80px;
                min-height: 56px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: grab;
                user-select: none;
                opacity: 0;
                transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
            `;

            this.element.textContent = currentState.icon;

            this.element.addEventListener('mousedown', e => this.handleMouseDown(e));
            this.element.addEventListener('mouseenter', () => this.resetFadeTimer());
            this.element.addEventListener('mouseleave', () => this.resetFadeTimer());

            document.body.appendChild(this.element);

            // Animate in
            requestAnimationFrame(() => {
                if (this.element) {
                    this.element.style.opacity = '1';
                    this.element.style.transform = 'translateX(-50%) scale(1)';
                    setTimeout(() => this.resetFadeTimer(), 300);
                }
            });
        }

        /**
         * Remove pill from DOM.
         */
        remove() {
            if (this.fadeTimeout) {
                clearTimeout(this.fadeTimeout);
                this.fadeTimeout = null;
            }

            if (this.element?.parentNode) {
                this.element.parentNode.removeChild(this.element);
                this.element = null;
            }
        }

        /**
         * Reset fade timer.
         */
        resetFadeTimer() {
            if (!this.element) return;

            if (this.fadeTimeout) {
                clearTimeout(this.fadeTimeout);
                this.fadeTimeout = null;
            }

            this.element.style.opacity = '1';

            this.fadeTimeout = setTimeout(() => {
                if (this.element && !this.isDragging) {
                    this.element.style.transition = 'opacity 0.8s ease';
                    this.element.style.opacity = '0.4';
                }
            }, Config.timeouts.pillFade);
        }

        /**
         * Handle mouse down for dragging.
         * @param {MouseEvent} event
         */
        handleMouseDown(event) {
            event.preventDefault();
            event.stopPropagation();

            this.resetFadeTimer();

            this.isDragging = false;
            this.dragState = {
                startTime: Date.now(),
                startX: event.clientX,
                startY: event.clientY,
                pillStartX: this.element.getBoundingClientRect().left + 
                            this.element.getBoundingClientRect().width / 2,
                pillStartY: this.element.getBoundingClientRect().top + 
                            this.element.getBoundingClientRect().height / 2
            };

            document.addEventListener('mousemove', this.handleMouseMove);
            document.addEventListener('mouseup', this.handleMouseUp);
        }

        handleMouseMove = (event) => {
            event.preventDefault();

            const deltaX = event.clientX - this.dragState.startX;
            const deltaY = event.clientY - this.dragState.startY;
            const distance = Math.hypot(deltaX, deltaY);

            if (distance > 5) {
                this.isDragging = true;

                const newX = this.dragState.pillStartX + deltaX;
                const newY = this.dragState.pillStartY + deltaY;

                this.element.style.left = newX + 'px';
                this.element.style.top = newY + 'px';
                this.element.style.transform = 'translate(-50%, -50%)';
                this.element.style.cursor = 'grabbing';
            }
        };

        handleMouseUp = (event) => {
            event.preventDefault();
            event.stopPropagation();

            document.removeEventListener('mousemove', this.handleMouseMove);
            document.removeEventListener('mouseup', this.handleMouseUp);

            const clickDuration = Date.now() - this.dragState.startTime;

            if (!this.isDragging && clickDuration < 200) {
                this.remove();
            } else if (this.isDragging && this.element) {
                this.element.style.cursor = 'grab';
                this.resetFadeTimer();
            }

            this.isDragging = false;
        };
    }

    /**
     * Simple notification manager for text messages.
     */
    class NotificationManager {
        /**
         * Show notification message.
         * @param {string} message
         */
        static show(message) {
            if (!Config.showNotifications && !Config.errors.showDetails) return;

            if (typeof GM_notification !== 'undefined') {
                try {
                    GM_notification({
                        text: message,
                        title: 'Image Downloader',
                        timeout: Config.timeouts.notificationFade
                    });
                    return;
                } catch { /* Fall through to DOM notification */ }
            }

            const notification = document.createElement('div');
            notification.textContent = message;
            notification.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 10px 16px;
                border-radius: 6px;
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 14px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                max-width: 300px;
                word-wrap: break-word;
                opacity: 0;
                transform: translateY(-10px);
                transition: all 0.3s ease;
            `;

            document.body.appendChild(notification);

            // Animate in
            requestAnimationFrame(() => {
                notification.style.opacity = '1';
                notification.style.transform = 'translateY(0)';
            });

            // Fade out and remove
            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transform = 'translateY(-10px)';

                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }, Config.timeouts.notificationFade);
        }
    }

    // =========================================================================
    // MOUSE TRACKER
    // Debounced mouse position tracking.
    // =========================================================================

    /**
     * Tracks mouse position with debouncing for performance.
     */
    const mouseTracker = {
        x: 0,
        y: 0,
        _handler: null,

        /**
         * Initialize mouse tracking.
         */
        init() {
            if (!Config.detection.trackMousePosition) return;

            this._handler = Utils.debounce((event) => {
                this.x = event.clientX;
                this.y = event.clientY;
            }, Config.detection.mouseTrackDebounceMs);

            document.addEventListener('mousemove', this._handler, { passive: true });
        },

        /**
         * Clean up event listener.
         */
        destroy() {
            if (this._handler) {
                document.removeEventListener('mousemove', this._handler);
                this._handler = null;
            }
        }
    };

    // =========================================================================
    // EVENT HANDLERS
    // User interaction handling.
    // =========================================================================

    let lastDownloadTime = 0;

    /**
     * Unified download trigger with debounce protection.
     * @param {Event} event - Mouse event
     * @returns {boolean} True if download was triggered
     */
    function triggerDownload(event) {
        const now = Date.now();
        if (now - lastDownloadTime < Config.triggerDebounceMs) {
            return false;
        }

        const imgSrc = ImageFinder.find(event.target);
        if (!imgSrc) {
            pillNotification.show('error');
            Utils.log('No image found at click location');
            return false;
        }

        lastDownloadTime = now;

        const queueResult = downloadQueue.add(imgSrc);
        const stateMap = {
            'queued': 'success',
            'already_in_queue': 'info',
            'duplicate': 'warning'
        };
        pillNotification.show(stateMap[queueResult] || 'error');

        return true;
    }

    const EventHandlers = {
        /**
         * Handle Ctrl + double-click for image download.
         * @param {MouseEvent} event
         */
        handleDoubleClick(event) {
            if (!event.ctrlKey) return;

            if (triggerDownload(event)) {
                event.preventDefault();
                event.stopPropagation();
            }
        },

        /**
         * Handle Ctrl + Shift + click for macro-safe image download.
         * @param {MouseEvent} event
         */
        handleMacroClick(event) {
            if (!event.ctrlKey || !event.shiftKey) return;
            if (event.detail !== 1) return;

            if (triggerDownload(event)) {
                event.preventDefault();
                event.stopPropagation();
            }
        },

        /**
         * Handle debug hotkeys.
         * @param {KeyboardEvent} event
         */
        handleDebugHotkey(event) {
            if (!event.altKey) return;

            const key = event.key.toLowerCase();

            // Alt+D: Debug element under cursor
            if (key === 'd') {
                const element = document.elementFromPoint(mouseTracker.x, mouseTracker.y);
                Utils.log('Debug element under cursor:', element);

                const imgSrc = ImageFinder.find(element);
                Utils.log('Image source found:', imgSrc);

                if (imgSrc) {
                    const dupCheck = downloadHistory.checkDuplicate(imgSrc, null);
                    const dupStatus = dupCheck.isDuplicate ? `(DUPLICATE: ${dupCheck.reason})` : '';
                    NotificationManager.show(`Found: ${imgSrc.substring(0, 30)}... ${dupStatus}`);
                } else {
                    NotificationManager.show('No image found at cursor');
                }
            }

            // Alt+Q: Toggle pill visibility
            if (key === 'q') {
                if (pillNotification.element?.style.opacity !== '0') {
                    pillNotification.remove();
                } else {
                    pillNotification.show('success');
                }
            }

            // Alt+X: Clear download history
            if (key === 'x' && Config.deduplication.clearCacheHotkey) {
                downloadHistory.clear();
            }

            // Alt+R: Retry failed downloads
            if (key === 'r') {
                downloadQueue.retryFailed();
            }

            // Alt+S: Show queue statistics
            if (key === 's') {
                const stats = downloadQueue.getStats();
                NotificationManager.show(
                    `Queue: ${stats.complete}? ${stats.failed}? ${stats.pending}?`
                );
            }
        }
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    // Module instances
    let visibilityObserver;
    let downloadHistory;
    let downloadQueue;
    let pillNotification;

    /**
     * Initialize the image downloader.
     */
    function initialize() {
        // Create instances
        visibilityObserver = new VisibilityObserver();
        downloadHistory = new DownloadHistory();
        downloadQueue = new DownloadQueue();
        pillNotification = new PillNotification();

        // Set up event listeners
        // Primary: Ctrl + Double Click (manual input)
        document.addEventListener('dblclick', EventHandlers.handleDoubleClick, true);

        // Macro fallback: Ctrl + Shift + Click (single click, macro-safe)
        document.addEventListener('click', EventHandlers.handleMacroClick, true);

        mouseTracker.init();

        if (Config.detection.addDebugHotkey) {
            document.addEventListener('keydown', EventHandlers.handleDebugHotkey);
        }

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            downloadQueue.cleanup();
            visibilityObserver.destroy();
            mouseTracker.destroy();
        });

        Utils.log('Universal Image Downloader v7.1 initialized');
        Utils.log('Triggers: Ctrl+DblClick (manual) or Ctrl+Shift+Click (macro-safe)');
        Utils.log('Config:', Config);

        // Show startup notification in debug mode
        if (Config.debug) {
            setTimeout(() => {
                NotificationManager.show('Image Downloader active (Ctrl+DblClick or Ctrl+Shift+Click)');
            }, Config.timeouts.initNotification);
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();