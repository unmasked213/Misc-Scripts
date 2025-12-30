/**
 * Media Downloader - Content Script (Video Interceptor)
 * Runs in MAIN world to intercept fetch/XHR and watch video playback.
 * Communicates via CustomEvent to bridge script in ISOLATED world.
 */

(function() {
    'use strict';
    
    const VIDEO_PATTERNS = [
        /\.mp4(\?|#|$)/i,
        /\.webm(\?|#|$)/i,
        /\.mov(\?|#|$)/i,
        /\.m4v(\?|#|$)/i,
        /\.m3u8(\?|#|$)/i,
        /\.mpd(\?|#|$)/i
    ];
    
    const VIDEO_MIMES = [
        'video/mp4',
        'video/webm',
        'video/ogg',
        'application/vnd.apple.mpegurl',
        'application/x-mpegurl',
        'application/dash+xml'
    ];
    
    if (window.__mediaDownloaderInjected) return;
    window.__mediaDownloaderInjected = true;
    
    const reportedUrls = new Set();
    
    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return VIDEO_PATTERNS.some(p => p.test(url));
    }
    
    function isVideoMime(contentType) {
        if (!contentType) return false;
        const mime = contentType.split(';')[0].trim().toLowerCase();
        return VIDEO_MIMES.some(m => mime.includes(m));
    }
    
    function reportVideo(url, source, extra = {}) {
        if (!url || reportedUrls.has(url)) return;
        reportedUrls.add(url);
        
        // Dispatch CustomEvent - bridge.js in ISOLATED world will catch this
        window.dispatchEvent(new CustomEvent('__mediaDownloaderVideo', {
            detail: { url, source, tabUrl: window.location.href, ...extra }
        }));
    }
    
    // =========================================================================
    // WATCH VIDEO ELEMENTS - This is the key detection like CocoCut
    // =========================================================================
    
    function handleVideoEvent(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        
        // Get the actual playing URL
        const url = video.currentSrc || video.src;
        
        // Skip blob URLs - these are MSE streams, need different handling
        if (!url || url.startsWith('blob:')) return;
        
        if (url.startsWith('http')) {
            reportVideo(url, 'video-' + event.type, {
                duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                dimensions: (video.videoWidth && video.videoHeight) 
                    ? `${video.videoWidth}×${video.videoHeight}` : null
            });
        }
    }
    
    // Capture play/loadeddata events on ALL videos (capture phase)
    document.addEventListener('play', handleVideoEvent, true);
    document.addEventListener('playing', handleVideoEvent, true);
    document.addEventListener('loadeddata', handleVideoEvent, true);
    document.addEventListener('loadedmetadata', handleVideoEvent, true);
    
    // Also check videos that are already playing
    function checkExistingVideos() {
        document.querySelectorAll('video').forEach(video => {
            if (video.currentSrc && video.currentSrc.startsWith('http') && !video.currentSrc.startsWith('blob:')) {
                reportVideo(video.currentSrc, 'existing-video', {
                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                    dimensions: (video.videoWidth && video.videoHeight) 
                        ? `${video.videoWidth}×${video.videoHeight}` : null
                });
            }
        });
    }
    
    // Check now and after DOM is ready
    checkExistingVideos();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkExistingVideos);
    }
    
    // Watch for new video elements
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.tagName === 'VIDEO') {
                    // Add listeners to new video
                    node.addEventListener('play', handleVideoEvent);
                    node.addEventListener('loadeddata', handleVideoEvent);
                }
                if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(v => {
                        v.addEventListener('play', handleVideoEvent);
                        v.addEventListener('loadeddata', handleVideoEvent);
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
    // INTERCEPT FETCH (secondary detection)
    // =========================================================================
    
    const originalFetch = window.fetch;
    
    window.fetch = function(input, init) {
        const url = (typeof input === 'string') ? input : input?.url;
        
        if (url && isVideoUrl(url)) {
            reportVideo(url, 'fetch');
        }
        
        return originalFetch.apply(this, arguments).then(response => {
            const contentType = response.headers?.get('content-type');
            if (contentType && isVideoMime(contentType)) {
                reportVideo(response.url || url, 'fetch-response');
            }
            return response;
        }).catch(err => { throw err; });
    };
    
    // =========================================================================
    // INTERCEPT XMLHttpRequest (secondary detection)
    // =========================================================================
    
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__mdlUrl = url;
        
        if (url && isVideoUrl(url)) {
            reportVideo(url, 'xhr');
        }
        
        this.addEventListener('load', function() {
            const contentType = this.getResponseHeader('content-type');
            if (contentType && isVideoMime(contentType)) {
                reportVideo(this.responseURL || this.__mdlUrl, 'xhr-response');
            }
        });
        
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };
    
    // console.log('[MediaDownloader] Video interceptor ready');
})();
