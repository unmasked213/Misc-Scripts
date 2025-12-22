// ==UserScript==
// @name         Rectangle Link Selector
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Select multiple links by drawing a rectangle with right-click
// @author       Unmasked213
// @match        *://*/*
// @grant        GM_openInTab
// @run-at       document-end
// @updateURL   https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/rectangle_link_selector.user.js
// @downloadURL https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/rectangle_link_selector.user.js
// ==/UserScript==

(function() {
    'use strict';

    // Configuration constants - customize these values as needed
    const CONFIG = {
        SELECTION_BORDER_COLOR: 'rgba(0, 158, 190, 1)',
        SELECTION_BORDER_WIDTH: '3px',
        SELECTION_BORDER_RADIUS: '12px',
        LINK_HIGHLIGHT_BACKGROUND: 'rgba(0, 195, 0, 0.4)',
        LINK_HIGHLIGHT_BORDER: '1px solid rgba(0, 195, 0, 1)',
        IMAGE_HIGHLIGHT_OVERLAY: 'rgba(0, 195, 0, 0.4)',
        DRAG_THRESHOLD: 15,
        MAX_LINKS: 99,
        TAB_OPEN_DELAY: 1000,
        LABEL_Z_INDEX: 2147483648,
        RECT_Z_INDEX: 2147483647
    };

    // Inject CSS styles once for better performance
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        .link-selector-highlight {
            background-color: ${CONFIG.LINK_HIGHLIGHT_BACKGROUND} !important;
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
        }
        .link-selector-image-highlight {
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
            box-shadow: inset 0 0 0 2000px ${CONFIG.IMAGE_HIGHLIGHT_OVERLAY} !important;
        }
        .link-selector-border-only {
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
        }
    `;
    document.head.appendChild(styleSheet);

    // State management
    const state = {
        isSelecting: false,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        hasDraggedBeyondThreshold: false,
        shouldSuppressContextMenu: false,
        animationFrameId: null
    };

    // DOM element references
    const elements = {
        selectionRect: null,
        countLabel: null,
        highlightedLinks: new Set(),
        highlightedImages: new Set()
    };

    // Create selection rectangle with optimized styles
    function createSelectionRectangle() {
        const rect = document.createElement('div');
        Object.assign(rect.style, {
            position: 'absolute',
            border: `${CONFIG.SELECTION_BORDER_WIDTH} solid ${CONFIG.SELECTION_BORDER_COLOR}`,
            borderRadius: CONFIG.SELECTION_BORDER_RADIUS,
            pointerEvents: 'none',
            zIndex: CONFIG.RECT_Z_INDEX,
            backgroundColor: 'transparent'
        });
        document.body.appendChild(rect);
        return rect;
    }

    // Create count label with optimized styles
    function createCountLabel() {
        const label = document.createElement('div');
        Object.assign(label.style, {
            position: 'absolute',
            backgroundColor: CONFIG.SELECTION_BORDER_COLOR,
            color: 'white',
            padding: '4px 8px',
            fontSize: '14px',
            fontWeight: '600',
            lineHeight: '1',
            borderRadius: '4px',
            pointerEvents: 'none',
            zIndex: CONFIG.LABEL_Z_INDEX,
            whiteSpace: 'nowrap'
        });
        document.body.appendChild(label);
        return label;
    }

    // Calculate rectangle bounds once per frame
    function getRectangleBounds() {
        return {
            left: Math.min(state.startX, state.currentX),
            top: Math.min(state.startY, state.currentY),
            right: Math.max(state.startX, state.currentX),
            bottom: Math.max(state.startY, state.currentY),
            width: Math.abs(state.currentX - state.startX),
            height: Math.abs(state.currentY - state.startY)
        };
    }

    // Update rectangle position with batched style changes
    function updateSelectionRectangle() {
        if (!elements.selectionRect) return null;

        const bounds = getRectangleBounds();
        Object.assign(elements.selectionRect.style, {
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`
        });

        return bounds;
    }

    // Position label in furthest corner with optimized calculation
    function updateCountLabel(rectBounds, count) {
        if (!elements.countLabel || !rectBounds) return;

        elements.countLabel.textContent = count;

        const offsetX = 8;
        const offsetY = 8;
        const isRightSide = state.currentX > state.startX;
        const isBottomSide = state.currentY > state.startY;

        const left = isRightSide
            ? rectBounds.left + rectBounds.width - elements.countLabel.offsetWidth - offsetX
            : rectBounds.left + offsetX;

        const top = isBottomSide
            ? rectBounds.top + rectBounds.height - elements.countLabel.offsetHeight - offsetY
            : rectBounds.top + offsetY;

        Object.assign(elements.countLabel.style, {
            left: `${left}px`,
            top: `${top}px`
        });
    }

    // Validate URL with optimized checks
    function isValidUrl(href) {
        if (!href) return false;

        const lower = href.toLowerCase();
        return (lower.startsWith('http://') ||
                lower.startsWith('https://') ||
                lower.startsWith('//')) &&
               !lower.startsWith('javascript:') &&
               !lower.startsWith('mailto:') &&
               !lower.startsWith('tel:') &&
               !lower.startsWith('data:') &&
               !lower.startsWith('#');
    }

    // Check if element intersects with rectangle bounds
    function elementIntersectsRect(rect, bounds) {
        const elemLeft = rect.left + window.pageXOffset;
        const elemTop = rect.top + window.pageYOffset;
        const elemRight = elemLeft + rect.width;
        const elemBottom = elemTop + rect.height;

        return !(elemRight < bounds.left ||
                elemLeft > bounds.right ||
                elemBottom < bounds.top ||
                elemTop > bounds.bottom);
    }

    // Detect and highlight links with optimized DOM manipulation
    function detectAndHighlightLinks() {
        // Clear previous highlights using CSS classes
        elements.highlightedLinks.forEach(link => {
            link.classList.remove('link-selector-highlight', 'link-selector-border-only');
        });
        elements.highlightedLinks.clear();

        elements.highlightedImages.forEach(img => {
            img.classList.remove('link-selector-image-highlight');
        });
        elements.highlightedImages.clear();

        const bounds = getRectangleBounds();
        const links = document.querySelectorAll('a[href]');
        const detectedUrls = new Set();

        for (const link of links) {
            if (detectedUrls.size >= CONFIG.MAX_LINKS) break;
            if (!isValidUrl(link.href)) continue;

            const rect = link.getBoundingClientRect();
            if (!elementIntersectsRect(rect, bounds)) continue;
            if (detectedUrls.has(link.href)) continue;

            detectedUrls.add(link.href);

            const images = link.querySelectorAll('img');
            if (images.length > 0) {
                images.forEach(img => {
                    img.classList.add('link-selector-image-highlight');
                    elements.highlightedImages.add(img);
                });
                link.classList.add('link-selector-border-only');
            } else {
                link.classList.add('link-selector-highlight');
            }

            elements.highlightedLinks.add(link);
        }

        return detectedUrls;
    }

    // Open links using GM API
    function openLinksInTabs(urls) {
        Array.from(urls).forEach(url => {
            GM_openInTab(url, { active: false, insert: true, setParent: true });
        });
    }

    // Clean up all selection state and UI
    function cleanupSelection() {
        if (state.animationFrameId) {
            cancelAnimationFrame(state.animationFrameId);
            state.animationFrameId = null;
        }

        if (elements.selectionRect) {
            elements.selectionRect.remove();
            elements.selectionRect = null;
        }

        if (elements.countLabel) {
            elements.countLabel.remove();
            elements.countLabel = null;
        }

        elements.highlightedLinks.forEach(link => {
            link.classList.remove('link-selector-highlight', 'link-selector-border-only');
        });
        elements.highlightedLinks.clear();

        elements.highlightedImages.forEach(img => {
            img.classList.remove('link-selector-image-highlight');
        });
        elements.highlightedImages.clear();

        Object.assign(state, {
            isSelecting: false,
            hasDraggedBeyondThreshold: false
        });
    }

    // Update UI using requestAnimationFrame for smooth rendering
    function updateUI() {
        const rectBounds = updateSelectionRectangle();
        const detectedUrls = detectAndHighlightLinks();
        updateCountLabel(rectBounds, detectedUrls.size);
    }

    // Event handlers
    function handleMouseDown(e) {
        if (e.button !== 2) return;

        Object.assign(state, {
            startX: e.pageX,
            startY: e.pageY,
            currentX: e.pageX,
            currentY: e.pageY,
            isSelecting: true,
            hasDraggedBeyondThreshold: false
        });
    }

    function handleMouseMove(e) {
        if (!state.isSelecting) return;

        state.currentX = e.pageX;
        state.currentY = e.pageY;

        const deltaX = state.currentX - state.startX;
        const deltaY = state.currentY - state.startY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (!state.hasDraggedBeyondThreshold && distance >= CONFIG.DRAG_THRESHOLD) {
            state.hasDraggedBeyondThreshold = true;
            state.shouldSuppressContextMenu = true;
            elements.selectionRect = createSelectionRectangle();
            elements.countLabel = createCountLabel();
        }

        if (state.hasDraggedBeyondThreshold) {
            if (state.animationFrameId) {
                cancelAnimationFrame(state.animationFrameId);
            }
            state.animationFrameId = requestAnimationFrame(updateUI);
        }
    }

    function handleMouseUp(e) {
        if (!state.isSelecting || e.button !== 2) return;

        if (state.hasDraggedBeyondThreshold) {
            const detectedUrls = detectAndHighlightLinks();
            if (detectedUrls.size > 0) {
                openLinksInTabs(detectedUrls);
            }
        }

        cleanupSelection();
    }

    function handleContextMenu(e) {
        if (state.shouldSuppressContextMenu) {
            e.preventDefault();
            e.stopPropagation();
            state.shouldSuppressContextMenu = false;
            return false;
        }
    }

    function handleKeyDown(e) {
        if (e.key === 'Escape' && state.isSelecting) {
            state.shouldSuppressContextMenu = false;
            cleanupSelection();
        }
    }

    // Register event listeners with capture phase for better control
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('keydown', handleKeyDown, true);

})();