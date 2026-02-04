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

    console.log('[MediaDownloader:bridge] Script loading at', new Date().toISOString());

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

        // Handle play-event-signal (no URL, just signals that play occurred)
        // This enables network-after-play correlation in background.js
        if (source === 'play-event-signal') {
            safeSendMessage({
                action: 'video-intercepted',
                url: null,
                source: 'play-event-signal',
                tabUrl: tabUrl || window.location.href,
                elementIdHash: elementIdHash,
                eventType: eventType,
                observedAt: observedAt || Date.now()
            });
            return;
        }

        // Handle blob detection (MSE in use)
        if (isBlob) {
            safeSendMessage({
                action: 'mse-detected',
                tabUrl: tabUrl || window.location.href,
                duration,
                dimensions,
                elementIdHash: elementIdHash,
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

    // Track elements with pending delayed polls in bridge (backup for intercept.js)
    const pendingBridgePolls = new WeakSet();

    /**
     * Start delayed polling for currentSrc in bridge.js (backup detection)
     * This is a secondary fallback if intercept.js doesn't fire for some reason.
     */
    function startBridgeDelayedConfirmation(video, eventType) {
        if (pendingBridgePolls.has(video)) return;
        pendingBridgePolls.add(video);

        const startTime = Date.now();
        const maxDuration = 1500;
        const pollInterval = 250;

        // Send play-event-signal for network-after-play correlation
        safeSendMessage({
            action: 'video-intercepted',
            url: null,
            source: 'play-event-signal',
            tabUrl: window.location.href,
            observedAt: Date.now(),
            eventType: eventType
        });

        function poll() {
            const url = video.currentSrc || video.src;

            if (url && url.startsWith('http')) {
                pendingBridgePolls.delete(video);
                safeSendMessage({
                    action: 'video-intercepted',
                    url: url,
                    source: 'bridge-delayed-confirm',
                    tabUrl: window.location.href,
                    isStream: false,
                    isCandidate: false,
                    duration: (video.duration && isFinite(video.duration)) ? video.duration : null,
                    dimensions: (video.videoWidth && video.videoHeight)
                        ? `${video.videoWidth}×${video.videoHeight}` : null,
                    observedAt: Date.now(),
                    eventType: eventType,
                    delayedMs: Date.now() - startTime
                });
                return;
            }

            if (Date.now() - startTime >= maxDuration) {
                pendingBridgePolls.delete(video);
                return;
            }

            setTimeout(poll, pollInterval);
        }

        setTimeout(poll, pollInterval);
    }

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
            // Still try delayed confirmation - real URL might appear
            startBridgeDelayedConfirmation(video, event.type);
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
        } else {
            // No valid URL yet - start delayed confirmation
            startBridgeDelayedConfirmation(video, event.type);
        }
    }

    // Listen for play events on all videos (capture phase)
    document.addEventListener('play', onVideoPlay, true);
    document.addEventListener('playing', onVideoPlay, true);
    document.addEventListener('loadeddata', onVideoPlay, true);
    document.addEventListener('loadedmetadata', onVideoPlay, true);
    document.addEventListener('canplay', onVideoPlay, true);

    // =========================================================================
    // HOVER ICON DOWNLOAD LISTENER
    // Listen for download requests from the hover icon in intercept.js (MAIN world)
    // =========================================================================

    window.addEventListener('__mediaDownloaderImageDownload', (event) => {
        const url = event.detail?.url;
        console.log('[MediaDownloader:bridge] Received __mediaDownloaderImageDownload event, url:', url ? url.substring(0, 80) : 'NONE');

        if (!url) {
            console.warn('[MediaDownloader:bridge] No URL in event detail');
            return;
        }

        if (!isExtensionValid()) {
            console.warn('[MediaDownloader:bridge] Extension context invalid, cannot send message');
            return;
        }

        try {
            chrome.runtime.sendMessage({
                action: 'download-single-image',
                url: url,
                options: { useStoredPrefix: true }
            }).then(response => {
                console.log('[MediaDownloader:bridge] Download response:', response);
            }).catch(err => {
                console.error('[MediaDownloader:bridge] Message send error:', err);
            });
        } catch (e) {
            console.error('[MediaDownloader:bridge] Exception sending message:', e);
        }
    });

    console.log('[MediaDownloader:bridge] ✓ Bridge script loaded and listening');
})();
