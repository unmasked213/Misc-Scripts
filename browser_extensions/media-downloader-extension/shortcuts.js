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

    // Get the image currently under the cursor
    function getHoveredImage() {
        // Get element under cursor using document.elementFromPoint isn't reliable
        // Instead, we track the last hovered image
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
                console.log('[MediaDownloader:shortcuts] Download hovered image:', hoveredImage.src.substring(0, 60));
                safeSendMessage({
                    action: 'download-single-image',
                    url: hoveredImage.src,
                    options: { useStoredPrefix: true }
                });
            } else {
                console.log('[MediaDownloader:shortcuts] No valid image under cursor');
            }
            return;
        }

        // Check open-image-modal shortcut
        // Note: This can't directly open the popup, but could trigger a notification
        // or inject a modal into the page. For now, we'll just log it.
        if (matchesShortcut(e, customShortcuts['open-image-modal'])) {
            e.preventDefault();
            e.stopPropagation();

            // We can't open the extension popup programmatically in MV3
            // But we can send a message that could trigger a desktop notification
            // or inject a modal. For now, just log and user can use Alt+Shift+S.
            console.log('[MediaDownloader:shortcuts] Open image picker requested - use extension popup');

            // Could potentially inject a modal here in the future
            // For now, try to open the popup via action API (won't work from content script)
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
