// ==UserScript==
// @name         Rectangle Link Selector
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      2.0
// @description  Select multiple links by drawing a rectangle with right-click
// @author       Unmasked213
// @match        *://*/*
// @run-at       document-end
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/rectangle_link_selector.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/rectangle_link_selector.user.js
// ==/UserScript==


(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------
    const CONFIG = {
        SELECTION_BORDER_COLOR: 'rgba(0, 158, 190, 1)',
        SELECTION_BORDER_WIDTH: '3px',
        SELECTION_BORDER_RADIUS: '12px',
        LINK_HIGHLIGHT_BACKGROUND: 'rgba(0, 195, 0, 0.4)',
        LINK_HIGHLIGHT_BORDER: '1px solid rgba(0, 195, 0, 1)',
        IMAGE_HIGHLIGHT_OVERLAY: 'rgba(0, 195, 0, 0.4)',

        DRAG_THRESHOLD: 15,           // px before a right-drag becomes a selection
        MAX_LINKS: 99,
        TAB_OPEN_DELAY: 50,           // ms stagger between GM_openInTab calls

        SAMPLE_CELL_SIZE: 40,         // px hit-test grid inside the rectangle
        SAMPLE_BUDGET_LIVE: 60,       // max hit tests per frame during drag
        SAMPLE_BUDGET_FINAL: 300,     // max hit tests on mouse release
        MAX_SHADOW_DEPTH: 3,          // recursion cap into open shadow roots

        CACHE_REBUILD_INTERVAL: 250,  // ms floor between candidate rebuilds
        FALLBACK_DESCENDANT_CAP: 10,  // descendant rects checked for zero-size anchors

        RECT_Z_INDEX: 2147483646,
        LABEL_Z_INDEX: 2147483647     // int32 max - anything above this is clamped
    };

    // ------------------------------------------------------------------
    // Injected styles
    // ------------------------------------------------------------------
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        .rls-highlight {
            background-color: ${CONFIG.LINK_HIGHLIGHT_BACKGROUND} !important;
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
        }
        .rls-image-highlight {
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
            box-shadow: inset 0 0 0 2000px ${CONFIG.IMAGE_HIGHLIGHT_OVERLAY} !important;
        }
        .rls-border-only {
            border: ${CONFIG.LINK_HIGHLIGHT_BORDER} !important;
        }
    `;
    (document.head || document.documentElement).appendChild(styleSheet);

    // ------------------------------------------------------------------
    // State - drag lifecycle, candidate cache, overlay UI, highlights
    // ------------------------------------------------------------------
    const drag = {
        active: false,               // right button held
        engaged: false,              // threshold crossed, selection UI live
        suppressContextMenu: false,
        startX: 0, startY: 0,        // page coordinates
        currentX: 0, currentY: 0,
        frameId: null
    };

    const cache = {
        candidates: [],              // [{ el, url, key, images }]
        dirty: false,
        builtAt: 0,
        observer: null
    };

    const ui = {
        rect: null,
        label: null
    };

    const highlights = {
        current: new Map()           // element -> class currently applied
    };

    // ------------------------------------------------------------------
    // URL resolution and normalisation
    // ------------------------------------------------------------------
    const SCHEME_BLOCKLIST = /^\s*(javascript|mailto|tel|data|blob|about|vbscript):/i;

    const TRACKING_PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
        'utm_content', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'
    ];

    // Anchor href is a string on HTML anchors but an SVGAnimatedString on
    // SVG <a> elements. v1.1 called toLowerCase() on it directly, which
    // threw a TypeError and killed the entire detection pass on any page
    // containing an SVG anchor.
    function rawHref(el) {
        const h = el.href;
        if (typeof h === 'string') return h;
        if (h && typeof h.baseVal === 'string') return h.baseVal;
        return (el.getAttribute && el.getAttribute('href')) || '';
    }

    // Conservative URL extraction from JS-routed elements (cards with
    // data attributes or inline location/window.open handlers)
    function jsRoutedUrl(el) {
        if (!el.getAttribute) return null;
        for (const attr of ['data-href', 'data-url', 'data-link']) {
            const v = el.getAttribute(attr);
            if (v) return v;
        }
        const onclick = el.getAttribute('onclick');
        if (onclick) {
            const m = onclick.match(/(?:location(?:\.href)?\s*=|(?:window\.)?open\()\s*(['"])([^'"]+)\1/);
            if (m) return m[2];
        }
        return null;
    }

    function resolveUrl(raw) {
        if (!raw || SCHEME_BLOCKLIST.test(raw)) return null;
        try {
            const u = new URL(raw, document.baseURI);
            return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
        } catch {
            return null;
        }
    }

    // Dedupe identity only - the original URL is what gets opened.
    // Drops fragments (except SPA-style #/ and #! routes), strips common
    // tracking params, folds trailing slashes and host case.
    function normaliseKey(u) {
        const n = new URL(u.href);
        if (n.hash && !n.hash.startsWith('#/') && !n.hash.startsWith('#!')) n.hash = '';
        TRACKING_PARAMS.forEach(p => n.searchParams.delete(p));
        n.hostname = n.hostname.toLowerCase();
        if (n.pathname.length > 1 && n.pathname.endsWith('/')) {
            n.pathname = n.pathname.slice(0, -1);
        }
        return n.href;
    }

    // Fragment links (href="#top") resolve to the current page URL via the
    // href property, so v1.1's startsWith('#') check never fired and they
    // were opened as duplicates of the page itself. Excluded by key here.
    const PAGE_KEY = (() => {
        try { return normaliseKey(new URL(location.href)); } catch { return ''; }
    })();

    // ------------------------------------------------------------------
    // Candidate collection - built once per drag, rebuilt on DOM mutation
    // ------------------------------------------------------------------
    const CANDIDATE_SELECTOR = 'a[href], area[href], [role="link"], [data-href], [data-url]';

    function candidateFromElement(el) {
        if (!el || typeof el.matches !== 'function') return null;

        let raw = el.matches('a[href], area[href]') ? rawHref(el) : null;
        if (!raw) raw = jsRoutedUrl(el);
        if (!raw) return null;

        const u = resolveUrl(raw);
        if (!u) return null;

        const key = normaliseKey(u);
        if (!key || key === PAGE_KEY) return null;

        return {
            el,
            url: u.href,
            key,
            images: el.querySelectorAll ? el.querySelectorAll('img') : []
        };
    }

    function buildCandidateCache() {
        const out = [];
        for (const el of document.querySelectorAll(CANDIDATE_SELECTOR)) {
            const c = candidateFromElement(el);
            if (c) out.push(c);
        }
        cache.candidates = out;
        cache.dirty = false;
        cache.builtAt = performance.now();
    }

    // Catches lazy-loaded / infinite-scroll content appearing mid-drag
    function startCacheObserver() {
        stopCacheObserver();
        cache.observer = new MutationObserver(() => { cache.dirty = true; });
        cache.observer.observe(document.body, { childList: true, subtree: true });
    }

    function stopCacheObserver() {
        if (cache.observer) {
            cache.observer.disconnect();
            cache.observer = null;
        }
    }

    function ensureFreshCache() {
        if (cache.dirty && performance.now() - cache.builtAt >= CONFIG.CACHE_REBUILD_INTERVAL) {
            buildCandidateCache();
        }
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------
    function getSelectionBounds() {
        return {
            left: Math.min(drag.startX, drag.currentX),
            top: Math.min(drag.startY, drag.currentY),
            right: Math.max(drag.startX, drag.currentX),
            bottom: Math.max(drag.startY, drag.currentY),
            width: Math.abs(drag.currentX - drag.startX),
            height: Math.abs(drag.currentY - drag.startY)
        };
    }

    function rectIntersects(r, bounds, sx, sy) {
        return r.left + sx <= bounds.right &&
               r.right + sx >= bounds.left &&
               r.top + sy <= bounds.bottom &&
               r.bottom + sy >= bounds.top;
    }

    // Line-fragment rects for inline anchors (getBoundingClientRect on a
    // wrapped multi-line link claims area the link doesn't occupy), with a
    // descendant fallback for zero-size wrappers (display:contents, empty
    // flex/grid anchors whose children carry the visible box)
    function effectiveRects(el) {
        const rects = [];
        if (el.getClientRects) {
            for (const r of el.getClientRects()) {
                if (r.width > 0 && r.height > 0) rects.push(r);
            }
        }
        if (rects.length) return rects;

        if (el.querySelectorAll) {
            let checked = 0;
            for (const child of el.querySelectorAll('*')) {
                if (++checked > CONFIG.FALLBACK_DESCENDANT_CAP) break;
                const r = child.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) rects.push(r);
            }
        }
        return rects;
    }

    function isRenderable(el) {
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Detection pass 1: cached candidates vs selection bounds
    // ------------------------------------------------------------------
    function collectFromCandidates(bounds, found) {
        const sx = window.scrollX;
        const sy = window.scrollY;

        for (const c of cache.candidates) {
            if (found.size >= CONFIG.MAX_LINKS) return;
            if (found.has(c.key) || !c.el.isConnected) continue;

            let hit = null;
            for (const r of effectiveRects(c.el)) {
                if (rectIntersects(r, bounds, sx, sy)) { hit = r; break; }
            }
            if (!hit || !isRenderable(c.el)) continue;

            found.set(c.key, {
                url: c.url,
                el: c.el,
                images: c.images,
                top: hit.top + sy,
                left: hit.left + sx
            });
        }
    }

    // ------------------------------------------------------------------
    // Detection pass 2: hit-test sampling inside the rectangle
    // Catches what geometry alone misses: stretched links (small anchor,
    // ::after covering the card - the pseudo hit-tests as its anchor),
    // overlay cards, JS-routed clickables, and open shadow DOM content
    // ------------------------------------------------------------------
    function samplePoints(bounds, budget) {
        const left = Math.max(bounds.left - window.scrollX, 0);
        const top = Math.max(bounds.top - window.scrollY, 0);
        const right = Math.min(bounds.right - window.scrollX, window.innerWidth);
        const bottom = Math.min(bounds.bottom - window.scrollY, window.innerHeight);

        const w = right - left;
        const h = bottom - top;
        if (w < 2 || h < 2) return [];

        let cell = CONFIG.SAMPLE_CELL_SIZE;
        if (Math.ceil(w / cell) * Math.ceil(h / cell) > budget) {
            cell = Math.sqrt((w * h) / budget);
        }

        const points = [];
        for (let y = top + cell / 2; y < bottom; y += cell) {
            for (let x = left + cell / 2; x < right; x += cell) {
                points.push([x, y]);
            }
        }
        if (!points.length) points.push([left + w / 2, top + h / 2]);
        return points;
    }

    function resolveHitElement(el) {
        if (typeof el.closest !== 'function') return null;
        const anchor = el.closest('a[href], area[href]');
        if (anchor) return candidateFromElement(anchor);
        const routed = el.closest('[role="link"], [data-href], [data-url], [onclick]');
        if (routed) return candidateFromElement(routed);
        return null;
    }

    // Topmost resolvable element wins, mirroring what a real click would
    // hit. Open shadow roots are hit-tested recursively at the same point.
    function candidateAtPoint(root, x, y, depth) {
        if (typeof root.elementsFromPoint !== 'function') return null;
        for (const el of root.elementsFromPoint(x, y)) {
            if (depth < CONFIG.MAX_SHADOW_DEPTH && el.shadowRoot) {
                const inner = candidateAtPoint(el.shadowRoot, x, y, depth + 1);
                if (inner) return inner;
            }
            const c = resolveHitElement(el);
            if (c) return c;
        }
        return null;
    }

    function collectFromSampling(bounds, found, budget) {
        for (const [x, y] of samplePoints(bounds, budget)) {
            if (found.size >= CONFIG.MAX_LINKS) return;

            const c = candidateAtPoint(document, x, y, 0);
            if (!c || found.has(c.key)) continue;

            const r = effectiveRects(c.el)[0];
            found.set(c.key, {
                url: c.url,
                el: c.el,
                images: c.images,
                top: r ? r.top + window.scrollY : y + window.scrollY,
                left: r ? r.left + window.scrollX : x + window.scrollX
            });
        }
    }

    function detectLinks(bounds, samplingBudget) {
        const found = new Map();
        collectFromCandidates(bounds, found);
        collectFromSampling(bounds, found, samplingBudget);
        return found;
    }

    // ------------------------------------------------------------------
    // Overlay UI
    // ------------------------------------------------------------------
    function createOverlay() {
        ui.rect = document.createElement('div');
        Object.assign(ui.rect.style, {
            position: 'absolute',
            border: `${CONFIG.SELECTION_BORDER_WIDTH} solid ${CONFIG.SELECTION_BORDER_COLOR}`,
            borderRadius: CONFIG.SELECTION_BORDER_RADIUS,
            pointerEvents: 'none',
            zIndex: String(CONFIG.RECT_Z_INDEX),
            backgroundColor: 'transparent'
        });

        ui.label = document.createElement('div');
        Object.assign(ui.label.style, {
            position: 'absolute',
            backgroundColor: CONFIG.SELECTION_BORDER_COLOR,
            color: 'white',
            padding: '4px 8px',
            fontSize: '14px',
            fontWeight: '600',
            lineHeight: '1',
            borderRadius: '4px',
            pointerEvents: 'none',
            zIndex: String(CONFIG.LABEL_Z_INDEX),
            whiteSpace: 'nowrap'
        });

        document.body.append(ui.rect, ui.label);
    }

    function updateOverlay(bounds, count) {
        Object.assign(ui.rect.style, {
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`
        });

        ui.label.textContent = String(count);

        const pad = 8;
        const left = drag.currentX > drag.startX
            ? bounds.right - ui.label.offsetWidth - pad
            : bounds.left + pad;
        const top = drag.currentY > drag.startY
            ? bounds.bottom - ui.label.offsetHeight - pad
            : bounds.top + pad;

        Object.assign(ui.label.style, { left: `${left}px`, top: `${top}px` });
    }

    // ------------------------------------------------------------------
    // Highlights - class diffing instead of full clear/reapply per frame
    // ------------------------------------------------------------------
    function applyHighlights(found) {
        const desired = new Map();
        for (const entry of found.values()) {
            if (entry.images.length > 0) {
                desired.set(entry.el, 'rls-border-only');
                for (const img of entry.images) desired.set(img, 'rls-image-highlight');
            } else {
                desired.set(entry.el, 'rls-highlight');
            }
        }

        for (const [el, cls] of highlights.current) {
            if (desired.get(el) !== cls) el.classList.remove(cls);
        }
        for (const [el, cls] of desired) {
            if (highlights.current.get(el) !== cls) el.classList.add(cls);
        }
        highlights.current = desired;
    }

    function clearHighlights() {
        for (const [el, cls] of highlights.current) el.classList.remove(cls);
        highlights.current = new Map();
    }

    // ------------------------------------------------------------------
    // Frame update - all reads, then all writes, to avoid layout thrash
    // ------------------------------------------------------------------
    function onFrame() {
        drag.frameId = null;
        if (!drag.engaged) return;

        ensureFreshCache();

        const bounds = getSelectionBounds();                       // reads
        const found = detectLinks(bounds, CONFIG.SAMPLE_BUDGET_LIVE);

        updateOverlay(bounds, found.size);                         // writes
        applyHighlights(found);
    }

    function scheduleFrame() {
        if (drag.frameId === null) {
            drag.frameId = requestAnimationFrame(onFrame);
        }
    }

    // ------------------------------------------------------------------
    // Tab opening - staggered, in visual reading order
    // ------------------------------------------------------------------
    function openDetectedLinks(found) {
        const entries = Array.from(found.values()).sort((a, b) =>
            // 32px row buckets so grid items on the same visual row open
            // left-to-right instead of interleaving on sub-pixel offsets
            (Math.round(a.top / 32) - Math.round(b.top / 32)) || (a.left - b.left)
        );

        entries.forEach((entry, i) => {
            setTimeout(() => {
                GM_openInTab(entry.url, { active: false, insert: true, setParent: true });
            }, i * CONFIG.TAB_OPEN_DELAY);
        });
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    function engageSelection() {
        drag.engaged = true;
        drag.suppressContextMenu = true;
        buildCandidateCache();
        startCacheObserver();
        createOverlay();
    }

    function cleanupSelection() {
        if (drag.frameId !== null) {
            cancelAnimationFrame(drag.frameId);
            drag.frameId = null;
        }
        stopCacheObserver();
        if (ui.rect) { ui.rect.remove(); ui.rect = null; }
        if (ui.label) { ui.label.remove(); ui.label = null; }
        clearHighlights();
        cache.candidates = [];
        drag.active = false;
        drag.engaged = false;
    }

    // ------------------------------------------------------------------
    // Event handlers
    // ------------------------------------------------------------------
    function handleMouseDown(e) {
        if (e.button !== 2) return;
        drag.active = true;
        drag.engaged = false;
        drag.startX = e.pageX;
        drag.startY = e.pageY;
        drag.currentX = e.pageX;
        drag.currentY = e.pageY;
    }

    function handleMouseMove(e) {
        if (!drag.active) return;

        // Right button released outside the window - mouseup never arrived
        if (!(e.buttons & 2)) {
            drag.suppressContextMenu = false;
            cleanupSelection();
            return;
        }

        drag.currentX = e.pageX;
        drag.currentY = e.pageY;

        if (!drag.engaged) {
            const dx = drag.currentX - drag.startX;
            const dy = drag.currentY - drag.startY;
            if (dx * dx + dy * dy >= CONFIG.DRAG_THRESHOLD * CONFIG.DRAG_THRESHOLD) {
                engageSelection();
            }
        }

        if (drag.engaged) scheduleFrame();
    }

    function handleMouseUp(e) {
        if (!drag.active || e.button !== 2) return;

        if (drag.engaged) {
            // Final synchronous pass at full sampling density so the opened
            // set matches the final mouse position, not the last frame
            ensureFreshCache();
            const found = detectLinks(getSelectionBounds(), CONFIG.SAMPLE_BUDGET_FINAL);
            if (found.size > 0) openDetectedLinks(found);
        }

        cleanupSelection();
    }

    function handleContextMenu(e) {
        if (drag.suppressContextMenu) {
            e.preventDefault();
            e.stopPropagation();
            drag.suppressContextMenu = false;
        }
    }

    function handleKeyDown(e) {
        if (e.key === 'Escape' && drag.active) {
            drag.suppressContextMenu = false;
            cleanupSelection();
        }
    }

    function handleWindowBlur() {
        if (drag.active) {
            drag.suppressContextMenu = false;
            cleanupSelection();
        }
    }

    // Capture phase so page handlers can't swallow the drag
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleWindowBlur);

})();