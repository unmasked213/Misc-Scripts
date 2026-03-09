/**
 * Media Downloader - Custom Keyboard Shortcuts Handler
 * Runs in ISOLATED world, listens for custom shortcuts configured in the popup.
 *
 * Shortcuts are stored in chrome.storage.local under 'customShortcuts' key.
 * The popup broadcasts updates via 'update-shortcuts' message.
 */

(function() {
    'use strict';

    console.log('[MediaDownloader:shortcuts] Script loading at', new Date().toISOString());

    let customShortcuts = {};

    // Check if extension context is still valid
    function isExtensionValid() {
        try {
            return chrome.runtime && !!chrome.runtime.id;
        } catch (e) {
            return false;
        }
    }

    // Safe message sender
    function safeSendMessage(message) {
        if (!isExtensionValid()) return;

        try {
            chrome.runtime.sendMessage(message).catch(() => {
                // Extension was reloaded - silently ignore
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // Load shortcuts from storage
    async function loadShortcuts() {
        try {
            if (!isExtensionValid()) return;

            const result = await chrome.storage.local.get(['customShortcuts']);
            customShortcuts = result.customShortcuts || {};
            console.log('[MediaDownloader:shortcuts] Loaded shortcuts:', Object.keys(customShortcuts).length);
        } catch (e) {
            console.error('[MediaDownloader:shortcuts] Error loading shortcuts:', e);
        }
    }

    // Handle shortcut update messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'update-shortcuts') {
            customShortcuts = message.shortcuts || {};
            console.log('[MediaDownloader:shortcuts] Shortcuts updated:', Object.keys(customShortcuts).length);
        }
    });

    // Check if a key event matches a shortcut configuration
    function matchesShortcut(e, shortcut) {
        if (!shortcut || !shortcut.enabled || !shortcut.key) return false;

        const modifiers = shortcut.modifiers || [];

        const modifiersMatch =
            (modifiers.includes('ctrl') === e.ctrlKey) &&
            (modifiers.includes('alt') === e.altKey) &&
            (modifiers.includes('shift') === e.shiftKey);

        return modifiersMatch && e.code === shortcut.key;
    }

    // Resolve the best (highest quality) URL for an image element
    function getBestImageUrl(img) {
        let bestSrc = img.currentSrc || img.src;
        let srcUpgraded = false;

        // Check srcset for highest resolution
        if (img.srcset) {
            const items = img.srcset.split(',');
            let maxWidth = img.naturalWidth || 0;
            for (const item of items) {
                const parts = item.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const descriptor = parts[parts.length - 1];
                    if (descriptor.endsWith('w')) {
                        const w = parseInt(descriptor);
                        if (w > maxWidth) {
                            maxWidth = w;
                            bestSrc = parts[0];
                            srcUpgraded = true;
                        }
                    } else if (descriptor.endsWith('x')) {
                        const density = parseFloat(descriptor);
                        const effectiveWidth = (img.naturalWidth || 100) * density;
                        if (effectiveWidth > maxWidth) {
                            maxWidth = effectiveWidth;
                            bestSrc = parts[0];
                            srcUpgraded = true;
                        }
                    }
                }
            }
        }

        // Explicit high-quality data attrs always win
        const highQualityAttrs = ['data-large-file', 'data-full-src', 'data-zoom-src',
                                   'data-orig-file', 'data-large', 'data-hires', 'data-highres'];
        for (const attr of highQualityAttrs) {
            const val = img.getAttribute(attr);
            if (val?.trim() && (val.startsWith('http') || val.startsWith('/'))) {
                bestSrc = val;
                srcUpgraded = true;
                break;
            }
        }
        // Lazy-load attrs only when srcset didn't find something better
        if (!srcUpgraded) {
            const lazyAttrs = ['data-src', 'data-original'];
            for (const attr of lazyAttrs) {
                const val = img.getAttribute(attr);
                if (val?.trim() && (val.startsWith('http') || val.startsWith('/'))) {
                    bestSrc = val;
                    break;
                }
            }
        }

        // Check parent <a> link to full-size image
        const parentLink = img.closest('a');
        if (parentLink?.href && /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(parentLink.href)) {
            bestSrc = parentLink.href;
        }

        // Convert to absolute URL
        if (bestSrc && !bestSrc.startsWith('http')) {
            try { bestSrc = new URL(bestSrc, window.location.href).href; }
            catch (e) { /* keep as-is */ }
        }

        return bestSrc;
    }

    // Get the image currently under the cursor
    function getHoveredImage() {
        const hovered = document.querySelector('img:hover');
        if (hovered && hovered.src && hovered.src.startsWith('http')) {
            return hovered;
        }
        return null;
    }

    // Handle keydown events
    document.addEventListener('keydown', async (e) => {
        // Skip if typing in an input field
        const activeTag = document.activeElement?.tagName?.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
            return;
        }

        // Also skip if element is contenteditable
        if (document.activeElement?.isContentEditable) {
            return;
        }

        // Check download-hovered shortcut
        if (matchesShortcut(e, customShortcuts['download-hovered'])) {
            e.preventDefault();
            e.stopPropagation();

            const hoveredImage = getHoveredImage();
            if (hoveredImage) {
                const bestUrl = getBestImageUrl(hoveredImage);
                console.log('[MediaDownloader:shortcuts] Download hovered image:', bestUrl.substring(0, 60));
                safeSendMessage({
                    action: 'download-single-image',
                    url: bestUrl,
                    options: { useStoredPrefix: true }
                });
            } else {
                console.log('[MediaDownloader:shortcuts] No valid image under cursor');
            }
            return;
        }

        // Check open-image-modal shortcut — opens the image picker as a detached window
        if (matchesShortcut(e, customShortcuts['open-image-modal'])) {
            e.preventDefault();
            e.stopPropagation();

            console.log('[MediaDownloader:shortcuts] Opening image picker window');
            safeSendMessage({
                action: 'open-image-modal-requested'
            });
            return;
        }
    }, true);

    // Initial load
    loadShortcuts();

    // Also reload when storage changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.customShortcuts) {
            customShortcuts = changes.customShortcuts.newValue || {};
            console.log('[MediaDownloader:shortcuts] Shortcuts changed via storage event');
        }
    });

    console.log('[MediaDownloader:shortcuts] ✓ Custom shortcut handler initialized');
})();
