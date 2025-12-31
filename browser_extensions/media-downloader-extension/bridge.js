/**
 * Media Downloader - Bridge Script (ISOLATED world)
 * Listens for CustomEvents from intercept.js (MAIN world)
 * and forwards video detections to the background service worker.
 *
 * This script runs in the ISOLATED world and has access to chrome.runtime
 * for communicating with the background service worker.
 */

(function() {
    'use strict';

    // Check if extension context is still valid
    function isExtensionValid() {
        try {
            return chrome.runtime && !!chrome.runtime.id;
        } catch (e) {
            return false;
        }
    }

    // Safe message sender that handles invalidated context
    function safeSendMessage(message) {
        if (!isExtensionValid()) return;

        try {
            chrome.runtime.sendMessage(message).catch(() => {
                // Extension was reloaded - silently ignore
            });
        } catch (e) {
            // Extension context invalidated - silently ignore
        }
    }

    // Listen for video detections from MAIN world
    window.addEventListener('__mediaDownloaderVideo', (event) => {
        const detail = event.detail || {};
        const {
            url,
            source,
            tabUrl,
            isStream,
            isBlob,
            isCandidate,
            duration,
            dimensions,
            elementIdHash,
            observedAt,
            eventType
        } = detail;

        // Handle blob detection (MSE in use)
        if (isBlob) {
            safeSendMessage({
                action: 'mse-detected',
                tabUrl: tabUrl || window.location.href,
                duration,
                dimensions,
                observedAt: observedAt || Date.now()
            });
            return;
        }

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

        // Forward to background with all metadata
        safeSendMessage({
            action: 'video-intercepted',
            url: absoluteUrl,
            source: source,
            tabUrl: tabUrl || window.location.href,
            isStream: isStream || false,
            isCandidate: isCandidate || false,
            duration: duration,
            dimensions: dimensions,
            elementIdHash: elementIdHash,
            observedAt: observedAt || Date.now(),
            eventType: eventType
        });
    });

    // Also watch for video play events directly (backup detection)
    // This catches cases where intercept.js might miss something
    function onVideoPlay(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;

        const url = video.currentSrc || video.src;

        // Report blob URLs separately
        if (url && url.startsWith('blob:')) {
            safeSendMessage({
                action: 'mse-detected',
                tabUrl: window.location.href,
                duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                dimensions: (video.videoWidth && video.videoHeight)
                    ? `${video.videoWidth}×${video.videoHeight}` : null,
                observedAt: Date.now()
            });
            return;
        }

        if (url && url.startsWith('http')) {
            safeSendMessage({
                action: 'video-intercepted',
                url: url,
                source: 'play-event',
                tabUrl: window.location.href,
                isStream: false,
                isCandidate: false,  // Play events are confirmed, not candidates
                duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                dimensions: (video.videoWidth && video.videoHeight)
                    ? `${video.videoWidth}×${video.videoHeight}` : null,
                observedAt: Date.now(),
                eventType: event.type
            });
        }
    }

    // Listen for play events on all videos (capture phase)
    document.addEventListener('play', onVideoPlay, true);
    document.addEventListener('playing', onVideoPlay, true);
    document.addEventListener('loadeddata', onVideoPlay, true);
    document.addEventListener('loadedmetadata', onVideoPlay, true);

    // console.log('[MediaDownloader] Bridge script loaded');
})();
