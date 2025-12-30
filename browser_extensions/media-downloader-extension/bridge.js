/**
 * Media Downloader - Bridge Script (ISOLATED world)
 * Listens for CustomEvents from intercept.js (MAIN world)
 * and forwards video detections to the background service worker.
 */

(function() {
    'use strict';
    
    // Listen for video detections from MAIN world
    window.addEventListener('__mediaDownloaderVideo', (event) => {
        const { url, source, tabUrl } = event.detail || {};
        
        if (!url) return;
        
        // Normalize relative URLs
        let absoluteUrl = url;
        if (!url.startsWith('http')) {
            try {
                absoluteUrl = new URL(url, tabUrl || window.location.href).href;
            } catch (e) {
                return;
            }
        }
        
        // Forward to background
        chrome.runtime.sendMessage({
            action: 'video-intercepted',
            url: absoluteUrl,
            source: source,
            tabUrl: tabUrl || window.location.href
        }).catch(() => {});
    });
    
    // Also watch for video play events directly (backup detection)
    function onVideoPlay(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        
        const url = video.currentSrc || video.src;
        if (url && url.startsWith('http')) {
            chrome.runtime.sendMessage({
                action: 'video-intercepted',
                url: url,
                source: 'play-event',
                tabUrl: window.location.href,
                duration: video.duration || null,
                dimensions: (video.videoWidth && video.videoHeight) 
                    ? `${video.videoWidth}×${video.videoHeight}` : null
            }).catch(() => {});
        }
    }
    
    // Listen for play events on all videos
    document.addEventListener('play', onVideoPlay, true);
    document.addEventListener('loadeddata', onVideoPlay, true);
    
    // console.log('[MediaDownloader] Bridge script loaded');
})();
