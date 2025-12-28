// ==UserScript==
// @name         Universal Image Downloader
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      6.1
// @description  Downloads images with Ctrl + double-click, prevents duplicates, ensures working downloads
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

    // ===== Configuration Module =====
    const Config = {
        debug: true,
        closeTabAfterDownload: false,
        useTimestampInFilename: true,
        trackMousePosition: true,
        addDebugHotkey: true,
        lookForHiddenImages: true,
        handleBackgroundImages: true,
        fixContentType: true,
        useOriginalFilename: false,
        showNotifications: false,
        maxParallelDownloads: 1,
        autoCloseThreshold: 5,
        showQueueStatus: true,
        downloadMethod: 'direct', // 'gm', 'fetch', or 'direct'

        deduplication: {
            enabled: true,
            storageKeyPrefix: 'img_dl_',
            hashAlgorithm: 'url',
            timeframeDays: 30,
            notifyOnDuplicate: true,
            skipDuplicates: true,
            ignoreQueryParams: true,
            clearCacheHotkey: true
        }
    };

    // ===== Utility Functions =====
    const Utils = {
        log(...args) {
            if (Config.debug) {
                console.log('[ImageDownloader]', ...args);
            }
        },

        normalizeUrl(url) {
            if (!url) return '';

            if (Config.deduplication.ignoreQueryParams) {
                try {
                    const parsedUrl = new URL(url);
                    return parsedUrl.origin + parsedUrl.pathname;
                } catch {
                    return url;
                }
            }
            return url;
        },

        hashUrl(url) {
            return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        },

        isElementVisible(element) {
            if (!element) return false;

            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   element.offsetWidth > 0 &&
                   element.offsetHeight > 0;
        },

        detectMimeType(bytes) {
            const signatures = [
                { bytes: [0xFF, 0xD8], mime: 'image/jpeg' },
                { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: 'image/png' },
                { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
                { bytes: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], mime: 'image/webp' },
                { bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C], mime: 'image/svg+xml' },
                { bytes: [0x3C, 0x73, 0x76, 0x67], mime: 'image/svg+xml' }
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

        updateExtension(filename, mimeType) {
            const extensionMap = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp',
                'image/svg+xml': '.svg'
            };

            const extension = extensionMap[mimeType] || '.jpg';
            const baseName = filename.replace(/\.[^/.]+$/, '');
            return baseName + extension;
        },

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
                const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
                const foundExt = extensions.find(ext => imgUrl.includes(ext));
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
        }
    };

    // ===== Download History Module =====
    class DownloadHistory {
        constructor() {
            this.history = new Map();
            this.load();
        }

        load() {
            if (!Config.deduplication.enabled) return;

            try {
                if (typeof GM_listValues !== 'undefined' && typeof GM_getValue !== 'undefined') {
                    const keys = GM_listValues();
                    const prefix = Config.deduplication.storageKeyPrefix;

                    keys.filter(key => key.startsWith(prefix))
                        .forEach(key => {
                            const value = GM_getValue(key);
                            if (value) {
                                try {
                                    const data = JSON.parse(value);
                                    this.history.set(key.substring(prefix.length), data);
                                } catch {}
                            }
                        });

                    this.cleanup();
                    Utils.log(`Loaded ${this.history.size} items in download history`);
                }
            } catch (e) {
                Utils.log('Error loading download history:', e);
            }
        }

        cleanup() {
            if (this.history.size === 0) return;

            const cutoffTime = Date.now() - (Config.deduplication.timeframeDays * 24 * 60 * 60 * 1000);
            let deleted = 0;

            for (const [key, data] of this.history.entries()) {
                if (data.timestamp < cutoffTime) {
                    this.history.delete(key);
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

        clear() {
            try {
                this.history.clear();

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
            } catch (e) {
                Utils.log('Error clearing download history:', e);
            }
        }

        isDuplicate(url) {
            if (!Config.deduplication.enabled || !url) return false;

            const normalizedUrl = Utils.normalizeUrl(url);
            const urlKey = Utils.hashUrl(normalizedUrl);
            const isInHistory = this.history.has(urlKey);

            if (isInHistory && Config.deduplication.notifyOnDuplicate) {
                const data = this.history.get(urlKey);
                const date = new Date(data.timestamp);
                const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
                NotificationManager.show(`Duplicate image (downloaded on ${dateStr})`);
            }

            return isInHistory;
        }

        add(url, filename) {
            if (!Config.deduplication.enabled || !url) return;

            const normalizedUrl = Utils.normalizeUrl(url);
            const urlKey = Utils.hashUrl(normalizedUrl);

            const entry = {
                originalUrl: url,
                filename: filename,
                timestamp: Date.now()
            };

            this.history.set(urlKey, entry);

            if (typeof GM_setValue !== 'undefined') {
                try {
                    GM_setValue(Config.deduplication.storageKeyPrefix + urlKey, JSON.stringify(entry));
                } catch (e) {
                    Utils.log('Error saving to GM storage:', e);
                }
            }
        }
    }

    // ===== Image Finder Module =====
    class ImageFinder {
        static find(element) {
            if (!element) return null;

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
                uniqueSources.forEach((source, index) => {
                    const truncated = source.url.substring(0, 100);
                    Utils.log(`${index + 1}. Priority ${source.priority}: ${truncated}${source.url.length > 100 ? '...' : ''}`);
                });
            }

            return uniqueSources.length > 0 ? uniqueSources[0].url : null;
        }

        static fromImgElement(element) {
            if (element.tagName.toLowerCase() !== 'img') return [];
            return [{ url: this.getBestImageVersion(element), priority: 100 }];
        }

        static fromContainedImages(element) {
            const images = element.querySelectorAll('img');
            return Array.from(images)
                .filter(img => Utils.isElementVisible(img))
                .map(img => ({ url: this.getBestImageVersion(img), priority: 90 }));
        }

        static fromLinks(element) {
            if (element.tagName.toLowerCase() !== 'a') return [];
            const href = element.href;
            if (href && /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i.test(href)) {
                return [{ url: href, priority: 85 }];
            }
            return [];
        }

        static fromBackgroundImage(element) {
            if (!Config.handleBackgroundImages) return [];
            const bgImage = this.getBackgroundImage(element);
            return bgImage ? [{ url: bgImage, priority: 80 }] : [];
        }

        static fromDataAttributes(element) {
            const dataUrlAttributes = [
                'data-src', 'data-original', 'data-orig-file', 'data-large-file',
                'data-full-src', 'data-zoom-src', 'data-large', 'data-1000px',
                'data-image', 'data-zoom-image', 'data-srcset', 'data-full'
            ];

            return dataUrlAttributes
                .map(attr => {
                    const val = element.getAttribute(attr);
                    if (val?.trim() && (val.startsWith('http') || val.startsWith('/'))) {
                        return { url: val, priority: 75 };
                    }
                    return null;
                })
                .filter(Boolean);
        }

        static fromGalleries() {
            const gallerySelectors = [
                '.pswp__item:not([aria-hidden="true"]) img',
                '.pswp__zoom-wrap img',
                '.pswp__img',
                '.lg-current img',
                '.lg-img-wrap img'
            ];

            return gallerySelectors
                .map(selector => {
                    const img = document.querySelector(selector);
                    return img ? { url: this.getBestImageVersion(img), priority: 95 } : null;
                })
                .filter(Boolean);
        }

        static fromParentElements(element) {
            const sources = [];
            let currentElem = element;
            const maxLevels = 5;
            let level = 0;

            while (currentElem && currentElem !== document.body && level < maxLevels) {
                const imgs = currentElem.querySelectorAll('img');
                imgs.forEach(img => {
                    if (Utils.isElementVisible(img)) {
                        sources.push({
                            url: this.getBestImageVersion(img),
                            priority: 70 - level * 5
                        });
                    }
                });

                if (Config.handleBackgroundImages) {
                    const bgImage = this.getBackgroundImage(currentElem);
                    if (bgImage) {
                        sources.push({
                            url: bgImage,
                            priority: 65 - level * 5
                        });
                    }
                }

                currentElem = currentElem.parentElement;
                level++;
            }

            return sources;
        }

        static fromNearbyImages() {
            if (!Config.lookForHiddenImages || !MouseTracker.x || !MouseTracker.y) return [];

            const nearbyImg = this.findNearestVisibleImage(MouseTracker.x, MouseTracker.y);
            return nearbyImg ? [{ url: this.getBestImageVersion(nearbyImg), priority: 60 }] : [];
        }

        static getBestImageVersion(imgElement) {
            if (!imgElement?.src) return null;

            let bestSrc = imgElement.src;

            // Check srcset for highest resolution
            if (imgElement.srcset) {
                const srcsetItems = imgElement.srcset.split(',');
                let highestWidth = 0;

                srcsetItems.forEach(item => {
                    const parts = item.trim().split(' ');
                    if (parts.length >= 2) {
                        const itemUrl = parts[0];
                        const widthStr = parts[parts.length - 1];

                        if (widthStr?.includes('w')) {
                            const width = parseInt(widthStr.replace('w', ''));
                            if (width > highestWidth) {
                                highestWidth = width;
                                bestSrc = itemUrl;
                            }
                        }
                    }
                });
            }

            // Check high-quality attributes
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

            // Check parent link
            const parentLink = imgElement.closest('a');
            if (parentLink?.href && /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i.test(parentLink.href)) {
                bestSrc = parentLink.href;
            }

            // Ensure absolute URL
            if (bestSrc.startsWith('/')) {
                bestSrc = window.location.origin + bestSrc;
            }

            return bestSrc;
        }

        static getBackgroundImage(element) {
            if (!element) return null;

            const style = window.getComputedStyle(element);
            if (style.backgroundImage && style.backgroundImage !== 'none') {
                const match = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                if (match?.[1]) {
                    return match[1];
                }
            }

            return null;
        }

        static findNearestVisibleImage(x, y) {
            const images = Array.from(document.querySelectorAll('img'))
                .filter(img => Utils.isElementVisible(img) && img.naturalWidth > 50 && img.naturalHeight > 50);

            if (images.length === 0) return null;

            let nearestImage = null;
            let shortestDistance = Infinity;

            images.forEach(img => {
                const rect = img.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const distance = Math.sqrt(Math.pow(centerX - x, 2) + Math.pow(centerY - y, 2));

                if (distance < shortestDistance) {
                    shortestDistance = distance;
                    nearestImage = img;
                }
            });

            return nearestImage;
        }

        static deduplicateSources(sources) {
            const uniqueSources = [];
            const seenUrls = new Set();

            sources.filter(source => source?.url).forEach(source => {
                if (!seenUrls.has(source.url)) {
                    seenUrls.add(source.url);
                    uniqueSources.push(source);
                }
            });

            return uniqueSources;
        }
    }

    // ===== Download Queue Module =====
    class DownloadQueue {
        constructor() {
            this.queue = [];
            this.activeDownloads = 0;
            this.isProcessing = false;
            this.startTime = null;
            this.timeoutIds = [];
        }

        add(imgUrl) {
            if (!imgUrl) return false;

            if (this.isInQueue(imgUrl)) {
                Utils.log('Image already in queue, skipping:', imgUrl);
                return 'already_in_queue';
            }

            if (Config.deduplication.enabled && downloadHistory.isDuplicate(imgUrl)) {
                if (Config.deduplication.skipDuplicates) {
                    Utils.log('Duplicate image detected, skipping:', imgUrl);
                    return 'duplicate';
                }
            }

            const filename = Utils.createFilename(imgUrl);

            const downloadItem = {
                url: imgUrl,
                filename: filename,
                status: 'queued',
                addedTime: new Date(),
                startTime: null,
                endTime: null,
                retries: 0,
                method: 'pending'
            };

            this.queue.push(downloadItem);
            Utils.log(`Added to queue: ${imgUrl} (${this.queue.length} items in queue)`);

            if (!this.isProcessing) {
                if (!this.startTime) this.startTime = new Date();
                setTimeout(() => this.process(), 100);
            }

            return 'queued';
        }

        isInQueue(url) {
            if (!url) return false;
            const normalizedUrl = Utils.normalizeUrl(url);
            return this.queue.some(item =>
                Utils.normalizeUrl(item.url) === normalizedUrl &&
                item.status !== 'failed'
            );
        }

        process() {
            if (this.queue.length === 0 && this.activeDownloads === 0) {
                this.isProcessing = false;

                if (Config.closeTabAfterDownload &&
                    this.queue.filter(item => item.status === 'complete').length <= Config.autoCloseThreshold) {
                    setTimeout(() => window.close(), 500);
                }

                return;
            }

            this.isProcessing = true;

            while (this.activeDownloads < Config.maxParallelDownloads && this.queue.length > 0) {
                const nextItemIndex = this.queue.findIndex(item => item.status === 'queued');
                if (nextItemIndex === -1) break;

                const item = this.queue[nextItemIndex];
                item.status = 'downloading';
                item.startTime = new Date();
                this.activeDownloads++;

                Utils.log(`Starting download for: ${item.url} (${this.activeDownloads} active, ${this.queue.length} total)`);

                this.startDownload(item);
            }
        }

        startDownload(item) {
            const methods = {
                'gm': () => this.downloadWithGM(item),
                'fetch': () => this.downloadWithFetch(item),
                'direct': () => this.downloadDirect(item)
            };

            const method = methods[Config.downloadMethod] || methods.direct;
            method();
        }

        downloadWithGM(item) {
            if (typeof GM_download === 'undefined') {
                this.downloadDirect(item);
                return;
            }

            try {
                GM_download({
                    url: item.url,
                    name: item.filename,
                    onload: () => {
                        Utils.log('Download successful via GM_download');
                        this.completeDownload(item, 'complete');
                    },
                    onerror: (error) => {
                        Utils.log('GM_download failed:', error);
                        this.downloadDirect(item);
                    }
                });
                item.method = 'gm';
            } catch (e) {
                Utils.log('GM_download error:', e);
                this.downloadDirect(item);
            }
        }

        downloadDirect(item) {
            const anchor = document.createElement('a');
            anchor.href = item.url;
            anchor.download = item.filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);

            try {
                anchor.click();
                item.method = 'direct';

                const timeoutId = setTimeout(() => {
                    this.completeDownload(item, 'complete');
                }, 3000);

                this.timeoutIds.push(timeoutId);
            } catch (e) {
                Utils.log('Error in direct download:', e);
                document.body.removeChild(anchor);

                if (item.retries < 2) {
                    item.retries++;
                    this.downloadWithFetch(item);
                } else {
                    this.completeDownload(item, 'failed');
                }
            }

            setTimeout(() => {
                if (document.body.contains(anchor)) {
                    document.body.removeChild(anchor);
                }
            }, 1000);
        }

        downloadWithFetch(item) {
            const cacheBustUrl = item.url.includes('?')
                ? `${item.url}&_=${Date.now()}`
                : `${item.url}?_=${Date.now()}`;

            item.method = 'fetch';

            fetch(cacheBustUrl, {
                method: 'GET',
                mode: 'cors',
                credentials: 'include',
                headers: { 'Accept': 'image/*, */*' }
            })
            .then(response => {
                if (!response.ok) throw new Error(`Fetch error: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(arrayBuffer => {
                const mimeType = Utils.detectMimeType(new Uint8Array(arrayBuffer));
                Utils.log('Detected MIME type (fetch):', mimeType);

                const blob = new Blob([arrayBuffer], { type: mimeType });

                if (Config.fixContentType) {
                    item.filename = Utils.updateExtension(item.filename, mimeType);
                }

                this.saveBlobAsFile(item, blob);
            })
            .catch(err => {
                Utils.log('Fetch failed:', err);
                if (item.retries < 2) {
                    item.retries++;
                    this.downloadDirect(item);
                } else {
                    this.completeDownload(item, 'failed');
                }
            });
        }

        saveBlobAsFile(item, blob) {
            const objectURL = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectURL;
            anchor.download = item.filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);

            try {
                anchor.click();

                const timeoutId = setTimeout(() => {
                    this.completeDownload(item, 'complete');
                }, 2000);

                this.timeoutIds.push(timeoutId);
            } catch (e) {
                Utils.log('Error in blob download:', e);
                this.completeDownload(item, 'failed');
            }

            setTimeout(() => {
                if (document.body.contains(anchor)) {
                    document.body.removeChild(anchor);
                }
                URL.revokeObjectURL(objectURL);
            }, 1000);
        }

        completeDownload(item, status) {
            if (item.status === 'complete' || item.status === 'failed') {
                return;
            }

            item.status = status;
            item.endTime = new Date();
            this.activeDownloads--;

            Utils.log(`Download ${status}: ${item.filename} (${this.activeDownloads} active, ${this.queue.length} total)`);

            if (status === 'complete') {
                downloadHistory.add(item.url, item.filename);
            }

            if (Config.showNotifications) {
                NotificationManager.show(`${item.filename} download ${status === 'complete' ? 'complete' : 'failed'}`);
            }

            setTimeout(() => this.process(), 100);
        }

        retryFailed() {
            let retryCount = 0;

            this.queue.forEach(item => {
                if (item.status === 'failed') {
                    item.status = 'queued';
                    item.retries = 0;
                    retryCount++;
                }
            });

            if (retryCount > 0) {
                NotificationManager.show(`Retrying ${retryCount} failed downloads`);
                this.process();
            } else {
                NotificationManager.show('No failed downloads to retry');
            }
        }

        cleanup() {
            this.timeoutIds.forEach(id => clearTimeout(id));
            this.timeoutIds = [];
        }
    }

    // ===== UI Components =====
    class PillNotification {
        constructor() {
            this.element = null;
            this.fadeTimeout = null;
            this.isDragging = false;
            this.dragState = {};
        }

        show(state) {
            if (!Config.showQueueStatus) return;

            this.remove();

            const states = {
                success: { color: '#4CAF50', icon: '?' },
                info: { color: '#2196F3', icon: '-' },
                warning: { color: '#FF9800', icon: '-' },
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

            this.element.innerHTML = currentState.icon;

            this.element.addEventListener('mousedown', e => this.handleMouseDown(e));
            this.element.addEventListener('mouseenter', () => this.resetFadeTimer());
            this.element.addEventListener('mouseleave', () => this.resetFadeTimer());

            document.body.appendChild(this.element);

            setTimeout(() => {
                this.element.style.opacity = '1';
                this.element.style.transform = 'translateX(-50%) scale(1)';

                setTimeout(() => this.resetFadeTimer(), 300);
            }, 10);
        }

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
            }, 3000);
        }

        handleMouseDown(event) {
            event.preventDefault();
            event.stopPropagation();

            this.resetFadeTimer();

            this.isDragging = false;
            this.dragState = {
                startTime: Date.now(),
                startX: event.clientX,
                startY: event.clientY,
                elementRect: this.element.getBoundingClientRect(),
                pillStartX: this.element.getBoundingClientRect().left + this.element.getBoundingClientRect().width / 2,
                pillStartY: this.element.getBoundingClientRect().top + this.element.getBoundingClientRect().height / 2
            };

            document.addEventListener('mousemove', this.handleMouseMove);
            document.addEventListener('mouseup', this.handleMouseUp);
        }

        handleMouseMove = (event) => {
            event.preventDefault();

            const deltaX = event.clientX - this.dragState.startX;
            const deltaY = event.clientY - this.dragState.startY;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            if (distance > 5) {
                this.isDragging = true;

                const newX = this.dragState.pillStartX + deltaX;
                const newY = this.dragState.pillStartY + deltaY;

                this.element.style.left = newX + 'px';
                this.element.style.top = newY + 'px';
                this.element.style.transform = 'translate(-50%, -50%)';
                this.element.style.cursor = 'grabbing';
            }
        }

        handleMouseUp = (event) => {
            event.preventDefault();
            event.stopPropagation();

            document.removeEventListener('mousemove', this.handleMouseMove);
            document.removeEventListener('mouseup', this.handleMouseUp);

            const clickDuration = Date.now() - this.dragState.startTime;

            if (!this.isDragging && clickDuration < 200) {
                this.remove();
            } else if (this.isDragging) {
                this.element.style.cursor = 'grab';
                this.resetFadeTimer();
            }

            this.isDragging = false;
        }
    }

    class NotificationManager {
        static show(message) {
            if (!Config.showNotifications) return;

            if (typeof GM_notification !== 'undefined') {
                GM_notification({
                    text: message,
                    title: 'Image Downloader',
                    timeout: 2000
                });
            } else {
                const notification = document.createElement('div');
                notification.textContent = message;
                notification.style.cssText = `
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    background: rgba(0, 0, 0, 0.7);
                    color: white;
                    padding: 8px 12px;
                    border-radius: 4px;
                    z-index: 9999;
                    font-family: Arial, sans-serif;
                    font-size: 14px;
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
                `;

                document.body.appendChild(notification);

                setTimeout(() => {
                    notification.style.opacity = '0';
                    notification.style.transition = 'opacity 0.5s';

                    setTimeout(() => {
                        if (notification.parentNode) {
                            document.body.removeChild(notification);
                        }
                    }, 500);
                }, 2000);
            }
        }
    }

    // ===== Mouse Tracker =====
    const MouseTracker = {
        x: 0,
        y: 0,

        init() {
            if (Config.trackMousePosition) {
                document.addEventListener('mousemove', this.track, { passive: true });
            }
        },

        track(event) {
            MouseTracker.x = event.clientX;
            MouseTracker.y = event.clientY;
        }
    };

    // ===== Event Handlers =====
    const EventHandlers = {
        handleDoubleClick(event) {
            // Require Ctrl + Double Click
            if (!event.ctrlKey) return;

            const target = event.target;
            const imgSrc = ImageFinder.find(target);

            if (imgSrc) {
                event.preventDefault();
                event.stopPropagation();

                const queueResult = downloadQueue.add(imgSrc);

                const stateMap = {
                    'queued': 'success',
                    'already_in_queue': 'info',
                    'duplicate': 'warning'
                };

                pillNotification.show(stateMap[queueResult] || 'error');
            } else {
                pillNotification.show('error');
            }
        },

        handleDebugHotkey(event) {
            if (event.altKey && event.key.toLowerCase() === 'd') {
                const element = document.elementFromPoint(MouseTracker.x, MouseTracker.y);
                Utils.log('Debug element under cursor:', element);

                const imgSrc = ImageFinder.find(element);
                Utils.log('Image source found:', imgSrc);

                if (imgSrc) {
                    const isDup = downloadHistory.isDuplicate(imgSrc);
                    NotificationManager.show(`Image found: ${imgSrc.substring(0, 20)}... ${isDup ? '(DUPLICATE)' : ''}`);
                } else {
                    NotificationManager.show('No image found at cursor position');
                }
            }

            if (event.altKey && event.key.toLowerCase() === 'q') {
                if (pillNotification.element?.style.opacity === '1') {
                    pillNotification.element.style.opacity = '0';
                } else {
                    pillNotification.show('success');
                }
            }

            if (Config.deduplication.clearCacheHotkey && event.altKey && event.key.toLowerCase() === 'x') {
                downloadHistory.clear();
                NotificationManager.show('Download history cleared');
            }

            if (event.altKey && event.key.toLowerCase() === 'r') {
                downloadQueue.retryFailed();
            }
        }
    };

    // ===== Main Application =====
    const downloadHistory = new DownloadHistory();
    const downloadQueue = new DownloadQueue();
    const pillNotification = new PillNotification();

    function initialize() {
        document.addEventListener('dblclick', EventHandlers.handleDoubleClick, true);

        MouseTracker.init();

        if (Config.addDebugHotkey) {
            document.addEventListener('keydown', EventHandlers.handleDebugHotkey);
        }

        window.addEventListener('beforeunload', () => downloadQueue.cleanup());

        Utils.log('Universal Image Downloader Refactored initialized');

        if (Config.debug) {
            setTimeout(() => {
                NotificationManager.show('Image Downloader active (Alt+D to debug)');
            }, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
