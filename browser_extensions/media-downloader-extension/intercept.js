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

    if (window.__mediaDownloaderInjected) return;
    window.__mediaDownloaderInjected = true;

    // Track reported URLs to avoid duplicates within same page session
    const reportedUrls = new Set();

    // Track element IDs for stable identification
    let elementIdCounter = 0;
    const elementIdMap = new WeakMap();

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

    // =========================================================================
    // WATCH VIDEO ELEMENTS - Play-gated detection (key for matching CocoCut)
    // =========================================================================

    /**
     * Handle video element events
     * Only reports when video actually starts playing or loads data
     */
    function handleVideoEvent(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;

        // Get the actual playing URL
        const url = video.currentSrc || video.src;

        // Report blob URLs as a signal that MSE is in use
        // The actual stream URL should come from network interception
        if (url && url.startsWith('blob:')) {
            window.dispatchEvent(new CustomEvent('__mediaDownloaderVideo', {
                detail: {
                    url: null,
                    source: 'blob-detected',
                    tabUrl: window.location.href,
                    isBlob: true,
                    observedAt: Date.now(),
                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                    dimensions: (video.videoWidth && video.videoHeight)
                        ? `${video.videoWidth}×${video.videoHeight}` : null
                }
            }));
            return;
        }

        // Only report http(s) URLs from actual play events
        if (url && url.startsWith('http')) {
            const elementIdHash = getElementIdHash(video);

            reportVideo(url, 'video-' + event.type, {
                duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                dimensions: (video.videoWidth && video.videoHeight)
                    ? `${video.videoWidth}×${video.videoHeight}` : null,
                elementIdHash: elementIdHash,
                eventType: event.type
            });
        }
    }

    // Capture play/loadeddata events on ALL videos (capture phase)
    // These are the KEY events that indicate actual playback
    document.addEventListener('play', handleVideoEvent, true);
    document.addEventListener('playing', handleVideoEvent, true);
    document.addEventListener('loadeddata', handleVideoEvent, true);
    document.addEventListener('loadedmetadata', handleVideoEvent, true);

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

    // console.log('[MediaDownloader] Video interceptor ready (play-gated mode)');
})();
