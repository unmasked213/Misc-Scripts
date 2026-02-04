/**
 * Media Downloader - Content Script (Video Interceptor)
 * Runs in MAIN world to intercept fetch/XHR and watch video playback.
 * Communicates via CustomEvent to bridge script in ISOLATED world.
 *
 * PLAY-GATED DETECTION:
 * This script observes video element events (play, playing, loadeddata, loadedmetadata)
 * and reports confirmed playback with stable identity keys. Only videos that have
 * actually started playing are promoted to the extension's actionable list.
 *
 * Network interception (fetch/XHR) captures candidates only - these are NOT shown
 * in the UI until confirmed by a play event.
 */

(function() {
    'use strict';

    console.log('[MediaDownloader:intercept] Script loading at', new Date().toISOString());

    // Progressive video patterns
    const VIDEO_PATTERNS = [
        /\.mp4(\?|#|$)/i,
        /\.webm(\?|#|$)/i,
        /\.mov(\?|#|$)/i,
        /\.m4v(\?|#|$)/i
    ];

    // Streaming manifest patterns (detect these too!)
    const STREAM_PATTERNS = [
        /\.m3u8(\?|#|$)/i,
        /\.mpd(\?|#|$)/i
    ];

    const VIDEO_MIMES = [
        'video/mp4',
        'video/webm',
        'video/ogg'
    ];

    const STREAM_MIMES = [
        'application/vnd.apple.mpegurl',
        'application/x-mpegurl',
        'application/dash+xml'
    ];

    if (window.__mediaDownloaderInjected) {
        console.log('[MediaDownloader:intercept] Already injected, skipping');
        return;
    }
    window.__mediaDownloaderInjected = true;
    console.log('[MediaDownloader:intercept] First injection, setting up...');

    // Track reported URLs to avoid duplicates within same page session
    const reportedUrls = new Set();

    // Track element IDs for stable identification
    let elementIdCounter = 0;
    const elementIdMap = new WeakMap();

    // Track elements with pending delayed confirmation polls
    const pendingDelayedPolls = new WeakSet();

    /**
     * Generate stable element ID hash based on DOM position or dataset
     */
    function getElementIdHash(element) {
        // Check if we already assigned an ID
        if (elementIdMap.has(element)) {
            return elementIdMap.get(element);
        }

        let idHash;

        // Try to use existing stable identifiers
        if (element.id) {
            idHash = `id:${element.id}`;
        } else if (element.dataset?.videoId) {
            idHash = `data:${element.dataset.videoId}`;
        } else if (element.dataset?.src) {
            idHash = `datasrc:${hashString(element.dataset.src)}`;
        } else {
            // Generate position-based ID
            const path = getElementPath(element);
            idHash = `pos:${hashString(path)}_${elementIdCounter++}`;
        }

        elementIdMap.set(element, idHash);
        return idHash;
    }

    /**
     * Get DOM path for element (for position-based ID)
     */
    function getElementPath(element) {
        const parts = [];
        let current = element;
        while (current && current !== document.body && parts.length < 5) {
            let selector = current.tagName.toLowerCase();
            if (current.className) {
                selector += '.' + current.className.split(' ').slice(0, 2).join('.');
            }
            parts.unshift(selector);
            current = current.parentElement;
        }
        return parts.join('>');
    }

    /**
     * Simple hash function for strings
     */
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return VIDEO_PATTERNS.some(p => p.test(url));
    }

    function isStreamUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return STREAM_PATTERNS.some(p => p.test(url));
    }

    function isVideoMime(contentType) {
        if (!contentType) return false;
        const mime = contentType.split(';')[0].trim().toLowerCase();
        return VIDEO_MIMES.some(m => mime.includes(m));
    }

    function isStreamMime(contentType) {
        if (!contentType) return false;
        const mime = contentType.split(';')[0].trim().toLowerCase();
        return STREAM_MIMES.some(m => mime.includes(m));
    }

    // Debug logging helper - enabled for troubleshooting play-gated detection
    const DEBUG_ENABLED = true;
    function debugLog(...args) {
        if (DEBUG_ENABLED) {
            console.log('[MediaDownloader:intercept]', ...args);
        }
    }

    /**
     * Report video detection to bridge script
     * @param {string} url - Video URL
     * @param {string} source - Detection source (e.g., 'video-play', 'fetch')
     * @param {object} extra - Additional metadata
     */
    function reportVideo(url, source, extra = {}) {
        if (!url || reportedUrls.has(url)) return;
        reportedUrls.add(url);

        const isStream = isStreamUrl(url) || extra.isStream;

        // Dispatch CustomEvent - bridge.js in ISOLATED world will catch this
        window.dispatchEvent(new CustomEvent('__mediaDownloaderVideo', {
            detail: {
                url,
                source,
                tabUrl: window.location.href,
                isStream,
                observedAt: Date.now(),
                ...extra
            }
        }));
    }

    /**
     * Check if a URL is a valid HTTP(S) video URL (not blob, not empty)
     */
    function isValidHttpUrl(url) {
        return url && typeof url === 'string' && url.startsWith('http');
    }

    /**
     * Start delayed polling for currentSrc on a video element.
     * This handles cases where currentSrc is not populated synchronously on play.
     * Polls every 250ms for up to 1.5 seconds.
     *
     * KEY FIX: On many modern players, HTMLVideoElement.play/playing/loaded* events
     * fire BEFORE video.currentSrc is populated. The real MP4 URL is assigned
     * asynchronously shortly after playback begins. This polling catches that.
     */
    function startDelayedConfirmation(video, eventType) {
        // Only one poll per element at a time
        if (pendingDelayedPolls.has(video)) {
            debugLog('Delayed poll already running for element');
            return;
        }

        pendingDelayedPolls.add(video);

        const elementIdHash = getElementIdHash(video);
        const startTime = Date.now();
        const maxDuration = 1500; // 1.5 seconds
        const pollInterval = 250; // 250ms
        let pollCount = 0;

        debugLog('Starting delayed confirmation poll for', eventType, 'elementId:', elementIdHash);

        // Signal that a play event occurred (for network-after-play fallback)
        // This allows background.js to correlate network requests that occur after play
        window.dispatchEvent(new CustomEvent('__mediaDownloaderVideo', {
            detail: {
                url: null,
                source: 'play-event-signal',
                tabUrl: window.location.href,
                observedAt: Date.now(),
                elementIdHash: elementIdHash,
                eventType: eventType
            }
        }));

        function poll() {
            pollCount++;

            // Check multiple URL sources
            const currentSrc = video.currentSrc;
            const src = video.src;
            const url = currentSrc || src;

            debugLog(`Delayed poll #${pollCount}: currentSrc=${currentSrc ? currentSrc.substring(0, 40) + '...' : 'empty'}, src=${src ? src.substring(0, 40) + '...' : 'empty'}`);

            // Success: found a valid HTTP URL
            if (isValidHttpUrl(url)) {
                pendingDelayedPolls.delete(video);
                const delayMs = Date.now() - startTime;
                debugLog('Delayed confirmation SUCCESS after', delayMs, 'ms:', url.substring(0, 80));

                reportVideo(url, 'video-delayed-confirm', {
                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                    dimensions: (video.videoWidth && video.videoHeight)
                        ? `${video.videoWidth}×${video.videoHeight}` : null,
                    elementIdHash: elementIdHash,
                    eventType: eventType,
                    delayedMs: delayMs
                });
                return;
            }

            // Also check <source> elements inside the video
            const sources = video.querySelectorAll('source');
            for (const source of sources) {
                const sourceSrc = source.src || source.getAttribute('src');
                if (isValidHttpUrl(sourceSrc)) {
                    pendingDelayedPolls.delete(video);
                    const delayMs = Date.now() - startTime;
                    debugLog('Delayed confirmation SUCCESS (from <source>) after', delayMs, 'ms:', sourceSrc.substring(0, 80));

                    reportVideo(sourceSrc, 'video-delayed-confirm-source', {
                        duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                        dimensions: (video.videoWidth && video.videoHeight)
                            ? `${video.videoWidth}×${video.videoHeight}` : null,
                        elementIdHash: elementIdHash,
                        eventType: eventType,
                        delayedMs: delayMs
                    });
                    return;
                }
            }

            // Timeout: stop polling
            if (Date.now() - startTime >= maxDuration) {
                pendingDelayedPolls.delete(video);
                debugLog('Delayed confirmation TIMEOUT after', maxDuration, 'ms (', pollCount, 'polls) - relying on network-after-play fallback');
                return;
            }

            // Continue polling
            setTimeout(poll, pollInterval);
        }

        // Start first poll after interval (immediate check already done in handleVideoEvent)
        setTimeout(poll, pollInterval);
    }

    // =========================================================================
    // WATCH VIDEO ELEMENTS - Play-gated detection (key for matching CocoCut)
    // =========================================================================

    /**
     * Handle video element events
     * Only reports when video actually starts playing or loads data.
     * If currentSrc is not available synchronously, starts delayed polling.
     *
     * KEY BEHAVIOR: Always attempt immediate detection, but ALSO start delayed
     * polling for async URL assignment (common in modern video players).
     */
    function handleVideoEvent(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;

        const elementIdHash = getElementIdHash(video);

        // Get the actual playing URL (check multiple sources)
        const currentSrc = video.currentSrc;
        const src = video.src;
        const url = currentSrc || src;

        debugLog(`Video event: ${event.type}, currentSrc=${currentSrc ? 'set' : 'empty'}, src=${src ? 'set' : 'empty'}, elementId=${elementIdHash}`);

        // Report blob URLs as a signal that MSE is in use
        // The actual stream URL should come from network interception
        if (url && url.startsWith('blob:')) {
            debugLog('Blob URL detected - MSE/streaming in use');
            window.dispatchEvent(new CustomEvent('__mediaDownloaderVideo', {
                detail: {
                    url: null,
                    source: 'blob-detected',
                    tabUrl: window.location.href,
                    isBlob: true,
                    observedAt: Date.now(),
                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                    dimensions: (video.videoWidth && video.videoHeight)
                        ? `${video.videoWidth}×${video.videoHeight}` : null,
                    elementIdHash: elementIdHash
                }
            }));
            // Still start delayed confirmation - the real URL might appear later
            startDelayedConfirmation(video, event.type);
            return;
        }

        // If we have a valid HTTP URL, report immediately
        if (isValidHttpUrl(url)) {
            debugLog('Immediate detection success:', url.substring(0, 80));

            reportVideo(url, 'video-' + event.type, {
                duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                dimensions: (video.videoWidth && video.videoHeight)
                    ? `${video.videoWidth}×${video.videoHeight}` : null,
                elementIdHash: elementIdHash,
                eventType: event.type
            });
        } else {
            // No valid URL yet - start delayed confirmation polling
            // This handles players that assign currentSrc asynchronously after play
            debugLog('Play event with no HTTP URL, starting delayed confirmation');
            startDelayedConfirmation(video, event.type);
        }
    }

    // Capture play/loadeddata events on ALL videos (capture phase)
    // These are the KEY events that indicate actual playback
    document.addEventListener('play', handleVideoEvent, true);
    document.addEventListener('playing', handleVideoEvent, true);
    document.addEventListener('loadeddata', handleVideoEvent, true);
    document.addEventListener('loadedmetadata', handleVideoEvent, true);
    document.addEventListener('canplay', handleVideoEvent, true);
    document.addEventListener('canplaythrough', handleVideoEvent, true);

    // Also listen on window for bubbling events (some frameworks dispatch here)
    window.addEventListener('play', handleVideoEvent, true);
    window.addEventListener('playing', handleVideoEvent, true);

    debugLog('Event listeners attached to document and window');

    // =========================================================================
    // MONKEY-PATCH HTMLMediaElement.prototype.play
    // This catches programmatic play() calls that might not fire events properly
    // =========================================================================

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
        const video = this;
        debugLog('play() method called on video element');

        // Create a synthetic event-like object
        const syntheticEvent = {
            type: 'play-method',
            target: video
        };

        // Try immediate detection
        handleVideoEvent(syntheticEvent);

        // Call original play and also monitor after it resolves
        const result = originalPlay.apply(this, arguments);

        if (result && typeof result.then === 'function') {
            result.then(() => {
                debugLog('play() promise resolved');
                // Check again after play promise resolves
                const url = video.currentSrc || video.src;
                if (isValidHttpUrl(url)) {
                    const elementIdHash = getElementIdHash(video);
                    reportVideo(url, 'video-play-resolved', {
                        duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                        dimensions: (video.videoWidth && video.videoHeight)
                            ? `${video.videoWidth}×${video.videoHeight}` : null,
                        elementIdHash: elementIdHash,
                        eventType: 'play-resolved'
                    });
                }
            }).catch(() => {
                // Play was rejected (autoplay blocked, etc.)
                debugLog('play() promise rejected');
            });
        }

        return result;
    };

    debugLog('HTMLMediaElement.prototype.play patched');

    // =========================================================================
    // MONITOR video.src PROPERTY SETTER
    // Catches when src is assigned programmatically after play
    // =========================================================================

    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDescriptor && srcDescriptor.set) {
        const originalSrcSetter = srcDescriptor.set;
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            ...srcDescriptor,
            set: function(value) {
                debugLog('src property set:', value ? value.substring(0, 60) : 'empty');
                const result = originalSrcSetter.call(this, value);

                // If video is not paused (playing), report this as a play event
                if (value && !this.paused && isValidHttpUrl(value)) {
                    const elementIdHash = getElementIdHash(this);
                    reportVideo(value, 'video-src-set-playing', {
                        duration: (this.duration && isFinite(this.duration)) ? this.duration : null,
                        dimensions: (this.videoWidth && this.videoHeight)
                            ? `${this.videoWidth}×${this.videoHeight}` : null,
                        elementIdHash: elementIdHash,
                        eventType: 'src-set'
                    });
                }

                return result;
            }
        });
        debugLog('HTMLMediaElement.prototype.src setter patched');
    }

    /**
     * Check existing videos that are already playing
     * NOTE: This is now more conservative - only reports if video has currentSrc
     * and is not paused (i.e., actually playing)
     */
    function checkExistingVideos() {
        document.querySelectorAll('video').forEach(video => {
            const url = video.currentSrc || video.src;

            // Only report if video is currently playing (not just has a src)
            // This prevents pre-play detection
            if (url && url.startsWith('http') && !url.startsWith('blob:')) {
                // Check if video is actually playing or has loaded significant data
                if (!video.paused || video.readyState >= 3) {
                    const elementIdHash = getElementIdHash(video);

                    reportVideo(url, 'existing-video', {
                        duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                        dimensions: (video.videoWidth && video.videoHeight)
                            ? `${video.videoWidth}×${video.videoHeight}` : null,
                        elementIdHash: elementIdHash,
                        isPlaying: !video.paused
                    });
                }
                // If paused with low readyState, do NOT report - it hasn't played yet
            }
        });
    }

    // Check now and after DOM is ready
    // Slightly delayed to allow page to settle
    setTimeout(checkExistingVideos, 500);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(checkExistingVideos, 500);
        });
    }

    // Watch for new video elements
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.tagName === 'VIDEO') {
                    // Add event listeners for play detection
                    node.addEventListener('play', handleVideoEvent);
                    node.addEventListener('playing', handleVideoEvent);
                    node.addEventListener('loadeddata', handleVideoEvent);
                    node.addEventListener('loadedmetadata', handleVideoEvent);
                }
                if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(v => {
                        v.addEventListener('play', handleVideoEvent);
                        v.addEventListener('playing', handleVideoEvent);
                        v.addEventListener('loadeddata', handleVideoEvent);
                        v.addEventListener('loadedmetadata', handleVideoEvent);
                    });
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // =========================================================================
    // INTERCEPT FETCH (captures candidates only - not confirmed until play)
    // =========================================================================

    const originalFetch = window.fetch;

    window.fetch = function(input, init) {
        const url = (typeof input === 'string') ? input : input?.url;

        // Note: These are captured as CANDIDATES only
        // They will NOT appear in UI until a play event confirms them
        if (url) {
            if (isVideoUrl(url)) {
                reportVideo(url, 'fetch-candidate', { isCandidate: true });
            } else if (isStreamUrl(url)) {
                reportVideo(url, 'fetch-stream-candidate', { isStream: true, isCandidate: true });
            }
        }

        return originalFetch.apply(this, arguments).then(response => {
            const contentType = response.headers?.get('content-type');
            if (contentType) {
                if (isVideoMime(contentType)) {
                    reportVideo(response.url || url, 'fetch-response-candidate', { isCandidate: true });
                } else if (isStreamMime(contentType)) {
                    reportVideo(response.url || url, 'fetch-response-stream-candidate', {
                        isStream: true,
                        isCandidate: true
                    });
                }
            }
            return response;
        }).catch(err => { throw err; });
    };

    // =========================================================================
    // INTERCEPT XMLHttpRequest (captures candidates only)
    // =========================================================================

    const originalXhrOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__mdlUrl = url;

        // Note: These are captured as CANDIDATES only
        if (url) {
            if (isVideoUrl(url)) {
                reportVideo(url, 'xhr-candidate', { isCandidate: true });
            } else if (isStreamUrl(url)) {
                reportVideo(url, 'xhr-stream-candidate', { isStream: true, isCandidate: true });
            }
        }

        this.addEventListener('load', function() {
            const contentType = this.getResponseHeader('content-type');
            if (contentType) {
                if (isVideoMime(contentType)) {
                    reportVideo(this.responseURL || this.__mdlUrl, 'xhr-response-candidate', {
                        isCandidate: true
                    });
                } else if (isStreamMime(contentType)) {
                    reportVideo(this.responseURL || this.__mdlUrl, 'xhr-response-stream-candidate', {
                        isStream: true,
                        isCandidate: true
                    });
                }
            }
        });

        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    console.log('[MediaDownloader:intercept] ✓ Video interceptor ready (play-gated mode)');
    console.log('[MediaDownloader:intercept] Patches applied: play(), src setter, fetch, XHR');

    // =========================================================================
    // HOVER DOWNLOAD ICON FOR IMAGES
    // Shows a floating download button when hovering over large images (300x300+)
    // =========================================================================

    (function initHoverIcon() {
        const MIN_SIZE = 300;
        const ICON_SIZE = 36;
        let currentIcon = null;
        let currentImage = null;
        let currentImageUrl = null;  // Store URL separately for reliability
        let iconVisible = false;

        // Create icon element with inline styles to avoid CSS conflicts
        function createIcon() {
            const icon = document.createElement('div');
            icon.id = '__mediaDownloaderHoverIcon';
            icon.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 15c0 2.828 0 4.243.879 5.121C4.757 21 6.172 21 9 21h6c2.828 0 4.243 0 5.121-.879C21 19.243 21 17.828 21 15"/>
                    <path d="M12 3v13m0 0l4-4.375M12 16l-4-4.375"/>
                </svg>
            `;

            // Apply all styles inline to avoid site CSS conflicts
            Object.assign(icon.style, {
                position: 'absolute',
                width: ICON_SIZE + 'px',
                height: ICON_SIZE + 'px',
                backgroundColor: 'rgba(30, 171, 208, 0.95)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: '2147483647',
                opacity: '0',
                transition: 'opacity 150ms ease, transform 100ms ease',
                pointerEvents: 'none',
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                transform: 'scale(0.9)'
            });

            const svg = icon.querySelector('svg');
            Object.assign(svg.style, {
                width: '20px',
                height: '20px',
                color: 'white',
                pointerEvents: 'none'  // Ensure clicks pass through to parent
            });

            // Handle click to download
            icon.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                // Use stored URL (more reliable than currentImage.src)
                const urlToDownload = currentImageUrl || (currentImage && currentImage.src);

                debugLog('Hover icon clicked, URL:', urlToDownload ? urlToDownload.substring(0, 60) : 'none');

                if (urlToDownload) {
                    // Visual feedback - turn green
                    icon.style.backgroundColor = 'rgba(0, 162, 103, 0.95)';
                    icon.style.transform = 'scale(1.1)';

                    // Dispatch download event to bridge
                    const event = new CustomEvent('__mediaDownloaderImageDownload', {
                        detail: { url: urlToDownload }
                    });
                    console.log('[MediaDownloader:intercept] Dispatching download event with URL:', urlToDownload.substring(0, 80));
                    window.dispatchEvent(event);

                    // Reset after animation
                    setTimeout(() => {
                        icon.style.backgroundColor = 'rgba(30, 171, 208, 0.95)';
                        icon.style.transform = 'scale(1)';
                    }, 300);
                } else {
                    console.warn('[MediaDownloader:intercept] Hover icon clicked but no URL available! currentImage:', currentImage, 'currentImageUrl:', currentImageUrl);
                }
            }, true);

            // Prevent click from propagating
            icon.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, true);

            document.body.appendChild(icon);
            return icon;
        }

        /**
         * Find the best (largest) version of an image by checking:
         * 1. Parent <a> tag href (if it links to an image)
         * 2. data-* attributes for full-size URLs
         * 3. srcset for highest resolution
         * 4. Fall back to img.src
         */
        function getBestImageUrl(img) {
            const candidates = [];
            const imgSrc = img.src;

            // Helper to check if URL looks like an image
            function isImageUrl(url) {
                if (!url) return false;
                // Check extension
                if (/\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(url)) return true;
                // Check common image path patterns
                if (/\/(images?|photos?|pics?|media|uploads?|static)\//i.test(url)) return true;
                return false;
            }

            // 1. Check parent <a> tag for link to full-size image
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                // Only use if it looks like an image URL (not a page)
                if (isImageUrl(href) && href !== imgSrc) {
                    candidates.push({ url: href, source: 'parent-link', priority: 10 });
                }
            }

            // 2. Check data attributes for full-size URLs
            const dataAttrs = [
                'data-src', 'data-original', 'data-full', 'data-large',
                'data-zoom-src', 'data-zoom', 'data-hires', 'data-highres',
                'data-full-src', 'data-large-src', 'data-original-src',
                'data-lazy-src', 'data-srcset-full', 'data-image',
                'data-big', 'data-big-src', 'data-max-src'
            ];
            for (const attr of dataAttrs) {
                const val = img.getAttribute(attr);
                if (val && val !== imgSrc && (val.startsWith('http') || val.startsWith('/'))) {
                    let url = val;
                    if (!url.startsWith('http')) {
                        try {
                            url = new URL(url, window.location.href).href;
                        } catch (e) {
                            continue;
                        }
                    }
                    // Prioritize attrs that explicitly mention "full", "large", "original"
                    const priority = /full|large|original|hires|highres|big|max/i.test(attr) ? 9 : 7;
                    candidates.push({ url, source: attr, priority });
                }
            }

            // 3. Check srcset for highest resolution
            if (img.srcset) {
                const items = img.srcset.split(',');
                let maxWidth = 0;
                let bestSrcsetUrl = null;

                for (const item of items) {
                    const parts = item.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const url = parts[0];
                        const descriptor = parts[1];

                        // Handle width descriptors (e.g., "800w")
                        if (descriptor.endsWith('w')) {
                            const w = parseInt(descriptor);
                            if (w > maxWidth) {
                                maxWidth = w;
                                bestSrcsetUrl = url;
                            }
                        }
                        // Handle pixel density descriptors (e.g., "2x")
                        else if (descriptor.endsWith('x')) {
                            const density = parseFloat(descriptor);
                            const estimatedWidth = density * 1000; // Rough estimate
                            if (estimatedWidth > maxWidth) {
                                maxWidth = estimatedWidth;
                                bestSrcsetUrl = url;
                            }
                        }
                    }
                }

                if (bestSrcsetUrl && bestSrcsetUrl !== imgSrc) {
                    let url = bestSrcsetUrl;
                    if (!url.startsWith('http')) {
                        try {
                            url = new URL(url, window.location.href).href;
                        } catch (e) {
                            url = null;
                        }
                    }
                    if (url) {
                        candidates.push({ url, source: 'srcset', priority: 8 });
                    }
                }
            }

            // 4. Try URL manipulation for common thumbnail patterns
            if (imgSrc) {
                // Remove common thumbnail suffixes/patterns
                const patterns = [
                    // Size suffixes: image-150x150.jpg -> image.jpg
                    { regex: /-\d+x\d+(\.[a-z]+)$/i, replace: '$1' },
                    // Thumbnail folders: /thumbs/image.jpg -> /images/image.jpg
                    { regex: /\/thumb(nail)?s?\//i, replace: '/images/' },
                    { regex: /\/th\//i, replace: '/full/' },
                    { regex: /\/small\//i, replace: '/large/' },
                    { regex: /\/sm\//i, replace: '/lg/' },
                    // Size query params: ?w=200 -> remove
                    { regex: /[?&](w|h|width|height|size|s)=\d+/gi, replace: '' },
                    // Resize services patterns
                    { regex: /\/resize\/\d+x\d+\//i, replace: '/' },
                    { regex: /_thumb(\.[a-z]+)$/i, replace: '$1' },
                    { regex: /_small(\.[a-z]+)$/i, replace: '$1' },
                    { regex: /_medium(\.[a-z]+)$/i, replace: '_large$1' },
                ];

                for (const pattern of patterns) {
                    if (pattern.regex.test(imgSrc)) {
                        const modifiedUrl = imgSrc.replace(pattern.regex, pattern.replace);
                        if (modifiedUrl !== imgSrc) {
                            candidates.push({ url: modifiedUrl, source: 'url-pattern', priority: 5 });
                        }
                    }
                }
            }

            // Sort by priority (highest first) and return best candidate
            candidates.sort((a, b) => b.priority - a.priority);

            if (candidates.length > 0) {
                debugLog('Best image candidates:', candidates.map(c => `${c.source}: ${c.url.substring(0, 50)}`));
                return candidates[0].url;
            }

            // Fallback to original src
            return imgSrc;
        }

        function showIcon(img, rect) {
            if (!currentIcon) {
                currentIcon = createIcon();
            }

            currentImage = img;
            currentImageUrl = getBestImageUrl(img);  // Get best quality URL

            debugLog('Hover icon shown, best URL:', currentImageUrl ? currentImageUrl.substring(0, 60) : 'none');

            // Position in top-right corner with padding
            const padding = 8;
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;

            currentIcon.style.left = (rect.right + scrollX - ICON_SIZE - padding) + 'px';
            currentIcon.style.top = (rect.top + scrollY + padding) + 'px';
            currentIcon.style.opacity = '1';
            currentIcon.style.pointerEvents = 'auto';
            currentIcon.style.transform = 'scale(1)';
            iconVisible = true;
        }

        function hideIcon(clearReferences = true) {
            if (currentIcon && iconVisible) {
                currentIcon.style.opacity = '0';
                currentIcon.style.pointerEvents = 'none';
                currentIcon.style.transform = 'scale(0.9)';
                iconVisible = false;
                // Only clear references if requested (not when transitioning to icon)
                if (clearReferences) {
                    currentImage = null;
                    currentImageUrl = null;
                }
            }
        }

        function isLargeImage(img) {
            // Check natural dimensions (actual image size)
            const naturalOk = img.naturalWidth >= MIN_SIZE && img.naturalHeight >= MIN_SIZE;
            // Also check display dimensions as fallback
            const displayOk = img.offsetWidth >= MIN_SIZE && img.offsetHeight >= MIN_SIZE;
            return naturalOk || displayOk;
        }

        function isValidImageSrc(src) {
            if (!src) return false;
            // Skip data URLs, blob URLs, and tracking pixels
            if (src.startsWith('data:')) return false;
            if (src.startsWith('blob:')) return false;
            if (src.includes('pixel') || src.includes('beacon') || src.includes('tracking')) return false;
            return true;
        }

        // Mouse tracking for images
        document.addEventListener('mouseover', (e) => {
            const img = e.target.closest('img');

            if (img && isLargeImage(img) && isValidImageSrc(img.src)) {
                const rect = img.getBoundingClientRect();
                showIcon(img, rect);
            }
        }, true);

        document.addEventListener('mouseout', (e) => {
            const img = e.target.closest('img');
            const relatedTarget = e.relatedTarget;

            // Check if moving to the icon itself
            const movingToIcon = relatedTarget && (
                relatedTarget.id === '__mediaDownloaderHoverIcon' ||
                relatedTarget.closest('#__mediaDownloaderHoverIcon')
            );

            // Don't hide at all if moving to the icon - preserve URL!
            if (movingToIcon) {
                return;
            }

            // Don't hide if staying within the same image
            if (relatedTarget && relatedTarget.closest('img') === currentImage) {
                return;
            }

            if (img || (currentIcon && !currentIcon.contains(relatedTarget))) {
                hideIcon(true);  // Clear references when truly leaving
            }
        }, true);

        // Keep icon visible when hovering the icon itself
        document.addEventListener('mouseover', (e) => {
            if (e.target.id === '__mediaDownloaderHoverIcon' ||
                e.target.closest('#__mediaDownloaderHoverIcon')) {
                if (currentIcon) {
                    currentIcon.style.opacity = '1';
                    currentIcon.style.pointerEvents = 'auto';
                    iconVisible = true;
                    // currentImageUrl should still be set from when we hovered the image
                    debugLog('Mouse over icon, URL preserved:', currentImageUrl ? currentImageUrl.substring(0, 40) : 'NONE');
                }
            }
        }, true);

        // Hide icon when leaving the icon (and not going back to the image)
        document.addEventListener('mouseout', (e) => {
            const isFromIcon = e.target.id === '__mediaDownloaderHoverIcon' ||
                e.target.closest('#__mediaDownloaderHoverIcon');

            if (!isFromIcon) return;

            const relatedTarget = e.relatedTarget;

            // Check if moving back to the current image
            if (relatedTarget && relatedTarget.closest('img') === currentImage) {
                return;  // Stay visible, don't clear
            }

            // Truly leaving - hide and clear
            hideIcon(true);
        }, true);

        // Hide icon when scrolling (position becomes stale)
        let scrollTimeout = null;
        window.addEventListener('scroll', () => {
            if (iconVisible) {
                hideIcon();
            }
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                // Could re-show if still hovering, but simpler to just hide
            }, 100);
        }, true);

        console.log('[MediaDownloader:intercept] ✓ Hover icon handler initialized (min size:', MIN_SIZE, 'px)');
    })();
})();
