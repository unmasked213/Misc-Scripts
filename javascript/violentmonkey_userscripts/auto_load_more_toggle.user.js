// ==UserScript==
// @name         Auto Load-More Toggle
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      2.4.0
// @description  Toggle-based auto-clicker for "Load More" buttons with idle detection
// @author       Unmasked213
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/auto_load_more_toggle.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/auto_load_more_toggle.user.js
// ==/UserScript==

// Automated "Load More" button clicker with idle detection and navigation safety.
// Platform: Violentmonkey/Tampermonkey on Chromium-based browsers.
// Trigger: Floating toggle button (bottom-right) or Violentmonkey menu command.
// Self-contained; no external dependencies beyond GM_* APIs.

(function () {
    'use strict';

    // cycleDelay persists across sessions; other CONFIG values are intentionally non-persistent
    // to avoid stale state causing unexpected behaviour on sites that change structure.
    const CONFIG = {
        cycleDelay: GM_getValue('cycleDelay', 1500),
        scrollDelay: 300,
        scrollAmount: 400,
        maxIdleCycles: 5,
        // Word-boundary patterns to catch variants like "Load more videos", "Show more comments".
        // Anchoring to start (^) would miss these common forms.
        patterns: [
            /\bload\s*more\b/i,
            /\bshow\s*more\b/i,
            /\bsee\s*more\b/i,
            /\bview\s*more\b/i,
            /\bmore\s*results\b/i,
            /\bload\s*additional\b/i
        ],
        // Exclude patterns run before positive match to prevent clicking pagination controls.
        // These are handled by a separate userscript per user requirement.
        excludePatterns: [
            /next/i,
            /prev/i,
            /previous/i,
            /page\s*\d+/i,
            /^\d+$/,
            /^[<>«»]$/,
            /older/i,
            /newer/i
        ]
    };

    // State is session-scoped intentionally. Persisting signature/navigationMode across reloads
    // would cause incorrect behaviour when sites change DOM structure or button behaviour.
    let state = {
        running: false,
        paused: false,
        // Signature is an object, not a CSS selector. Selector synthesis was rejected because
        // selectors break on DOM reflows, SPA rerenders, and A/B tests. Signature-based
        // re-resolution against fresh candidates each cycle is more robust.
        signature: null,
        idleCycles: 0,
        lastDomMetric: 0,
        // appendContainer enables scoped MutationObserver when data-append-items-to is present.
        // Falls back to document.body.innerHTML.length when null.
        appendContainer: null,
        observer: null,
        visibilityObserver: null,
        // Latch: once true, toggle button stays visible for session even if buttons disappear.
        // Prevents "vanishing control" UX issue after auto-stop.
        everHadButtons: false,
        // First click establishes mode. If 'ajax', subsequent navigation attempts stop the script.
        // If 'navigate', navigation is permitted throughout. Prevents accidental page changes
        // when user expects in-page loading.
        navigationMode: null
    };

    let toggleButton = null;
    let selectionOverlay = null;

    // Strips icon elements before extracting text. Many sites use icon fonts or SVGs
    // alongside text; including these pollutes the label with icon ligature characters.
    function getTextContent(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('svg, img, i, span.icon, [class*="icon"]').forEach(c => c.remove());
        return clone.textContent.trim();
    }

    // Aggressive normalisation: lowercase, collapse whitespace, strip bracketed content and digits.
    // This ensures "Load more (12 remaining)" matches "Load more (11 remaining)" after click.
    // Used consistently in matchesLoadMore, createSignature, and matchSignature to prevent
    // detection/resolution mismatch bugs.
    function normaliseText(text) {
        return text.toLowerCase().replace(/\s+/g, ' ').replace(/[(\[{].*?[)\]}]/g, '').replace(/\d+/g, '').trim();
    }

    // Combines visible text, aria-label, and title to catch icon-only buttons.
    // Example: <button aria-label="Load more results"><svg>...</svg></button>
    function getLabel(el) {
        const text = getTextContent(el);
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        return [text, aria, title].filter(Boolean).join(' ');
    }

    function matchesLoadMore(label) {
        if (!label) return false;
        const normalised = normaliseText(label);
        if (CONFIG.excludePatterns.some(p => p.test(normalised))) return false;
        return CONFIG.patterns.some(p => p.test(normalised));
    }

    // Visibility check uses getClientRects() instead of offsetParent/offsetWidth/offsetHeight.
    // getClientRects handles edge cases with clipped elements more reliably.
    function findLoadMoreButtons() {
        const candidates = document.querySelectorAll(
            'a, button, div[role="button"], span[role="button"], [data-action], [onclick]'
        );
        const matches = [];

        candidates.forEach(el => {
            if (el.getClientRects().length === 0) return;
            const label = getLabel(el);
            if (matchesLoadMore(label)) matches.push(el);
        });

        return matches;
    }

    // Signature creation prioritises stable identifiers over text:
    // 1. id (most stable)
    // 2. data-action, data-block-id, data-container-id, data-append-items-to (common in AJAX systems)
    // 3. Normalised text prefix (fallback, 20 chars to balance uniqueness vs dynamic content)
    function createSignature(el) {
        const sig = { tag: el.tagName.toLowerCase() };

        if (el.id) sig.id = el.id;

        const dataAttrs = ['data-action', 'data-block-id', 'data-container-id', 'data-append-items-to'];
        for (const attr of dataAttrs) {
            if (el.hasAttribute(attr)) {
                sig[attr] = el.getAttribute(attr);
            }
        }

        // Side effect: when data-append-items-to exists, capture the container for scoped observation.
        // This enables precise idle detection instead of full-document innerHTML comparison.
        if (el.hasAttribute('data-append-items-to')) {
            state.appendContainer = document.getElementById(el.getAttribute('data-append-items-to'));
        }

        const label = getLabel(el);
        if (label) sig.textPrefix = normaliseText(label).substring(0, 20);

        return sig;
    }

    // Matches signature against element using same priority as createSignature.
    // Returns true on first match; does not require all fields to match.
    function matchSignature(el, sig) {
        if (sig.id && el.id === sig.id) return true;

        const dataAttrs = ['data-action', 'data-block-id', 'data-container-id', 'data-append-items-to'];
        for (const attr of dataAttrs) {
            if (sig[attr] && el.getAttribute(attr) === sig[attr]) return true;
        }

        if (sig.textPrefix) {
            const elLabel = normaliseText(getLabel(el));
            if (elLabel.startsWith(sig.textPrefix)) return true;
        }

        return false;
    }

    // Determines if clicking an anchor would navigate away from current page.
    // Returns false for non-anchors, hash links, javascript: hrefs, and elements with
    // AJAX-indicating attributes. Used to enforce navigationMode consistency.
    function willNavigate(el) {
        if (el.tagName.toLowerCase() !== 'a') return false;

        const href = el.getAttribute('href');
        if (!href) return false;
        if (href.startsWith('#') || href.startsWith('javascript:')) return false;

        // data-action="ajax" and similar attributes indicate AJAX loading despite href presence.
        if (el.hasAttribute('data-action')) {
            const action = el.getAttribute('data-action').toLowerCase();
            if (action === 'ajax' || action.includes('load')) return false;
        }

        // These attributes strongly indicate in-page content insertion.
        if (el.hasAttribute('data-append-items-to') || el.hasAttribute('data-container-id')) {
            return false;
        }

        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) return true;
            if (url.pathname !== window.location.pathname) return true;
        } catch (e) {
            return false;
        }

        return false;
    }

    // Re-resolves element each cycle instead of caching DOM reference.
    // DOM references go stale after AJAX updates; re-resolution ensures click targets valid element.
    function resolveElement() {
        if (!state.signature) return null;

        const candidates = findLoadMoreButtons();
        for (const el of candidates) {
            if (matchSignature(el, state.signature)) return el;
        }

        return null;
    }

    // Returns child count for scoped container, innerHTML length for full document.
    // Child count is cheaper and more accurate when append container is known.
    function getDomMetric() {
        if (state.appendContainer) {
            return state.appendContainer.childElementCount;
        }
        return document.body.innerHTML.length;
    }

    // Scoped observer only watches the append container, not full document.
    // Full-document observation is expensive on ad-heavy pages with constant mutations.
    // Observer counts childList additions; count is read and reset via getMutationCount closure.
    function setupObserver() {
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }

        if (!state.appendContainer) return;

        let mutationCount = 0;
        state.observer = new MutationObserver(mutations => {
            mutations.forEach(m => {
                if (m.type === 'childList') mutationCount += m.addedNodes.length;
            });
        });

        state.observer.observe(state.appendContainer, { childList: true, subtree: false });

        // Closure captures mutationCount; resets on read to track inter-cycle changes only.
        state.getMutationCount = () => {
            const count = mutationCount;
            mutationCount = 0;
            return count;
        };
    }

    function notify(message, title = 'Auto Load-More Toggle') {
        GM_notification({ text: message, title, timeout: 3000 });
    }

    function createToggleButton() {
        const btn = document.createElement('div');
        btn.id = 'lm-toggle-btn';
        btn.innerHTML = '?';
        // z-index 999999 chosen to sit above most site content but below browser UI.
        // display: none initially; visibility controlled by updateButtonVisibility.
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: #2a2a2a;
            color: #888;
            font-size: 24px;
            display: none;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 999999;
            border: 2px solid #444;
            transition: all 0.2s ease;
            user-select: none;
            font-family: system-ui, sans-serif;
        `;

        btn.addEventListener('click', toggle);
        btn.addEventListener('mouseenter', () => btn.style.borderColor = '#666');
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = state.paused ? '#a94' : state.running ? '#4a9' : '#444';
        });

        document.body.appendChild(btn);
        toggleButton = btn;
    }

    // Latches everHadButtons on first detection, then disconnects visibility observer.
    // Observer serves only as bootstrapping aid; once latched, toggle stays visible for session.
    function updateButtonVisibility() {
        if (!toggleButton) return;
        const hasButtons = findLoadMoreButtons().length > 0;
        if (hasButtons) {
            state.everHadButtons = true;
            if (state.visibilityObserver) {
                state.visibilityObserver.disconnect();
                state.visibilityObserver = null;
            }
        }
        toggleButton.style.display = (state.everHadButtons || state.running) ? 'flex' : 'none';
    }

    // Debounced to avoid excessive findLoadMoreButtons calls on mutation-heavy pages.
    // 200ms debounce balances responsiveness with performance.
    function startVisibilityObserver() {
        let debounceTimer = null;
        const checkVisibility = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(updateButtonVisibility, 200);
        };

        state.visibilityObserver = new MutationObserver(checkVisibility);
        state.visibilityObserver.observe(document.body, { childList: true, subtree: true });

        updateButtonVisibility();
    }

    // Three visual states: inactive (grey), running (green), paused (amber).
    function updateButtonState() {
        if (!toggleButton) return;
        if (state.paused) {
            toggleButton.style.background = '#3a3a1a';
            toggleButton.style.color = '#a94';
            toggleButton.style.borderColor = '#a94';
        } else if (state.running) {
            toggleButton.style.background = '#1a3a2a';
            toggleButton.style.color = '#4a9';
            toggleButton.style.borderColor = '#4a9';
        } else {
            toggleButton.style.background = '#2a2a2a';
            toggleButton.style.color = '#888';
            toggleButton.style.borderColor = '#444';
        }
    }

    // Selection overlay shown when multiple candidates exist.
    // Hover highlights both the overlay option and the actual DOM element to aid identification.
    function createSelectionOverlay(buttons) {
        if (selectionOverlay) selectionOverlay.remove();

        const overlay = document.createElement('div');
        overlay.id = 'lm-selection-overlay';
        // z-index higher than toggle button to ensure overlay captures clicks.
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            z-index: 9999999;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-family: system-ui, sans-serif;
        `;

        const container = document.createElement('div');
        container.style.cssText = `
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 24px;
            max-width: 500px;
            width: 90%;
            max-height: 70vh;
            overflow-y: auto;
        `;

        const title = document.createElement('div');
        title.textContent = 'Multiple "Load More" buttons found';
        title.style.cssText = 'color: #eee; font-size: 16px; margin-bottom: 16px; font-weight: 500;';
        container.appendChild(title);

        const subtitle = document.createElement('div');
        subtitle.textContent = 'Select the one to use for this session:';
        subtitle.style.cssText = 'color: #888; font-size: 13px; margin-bottom: 16px;';
        container.appendChild(subtitle);

        buttons.forEach((btn, index) => {
            const option = document.createElement('div');
            option.style.cssText = `
                background: #252525;
                border: 1px solid #333;
                border-radius: 4px;
                padding: 12px;
                margin-bottom: 8px;
                cursor: pointer;
                transition: all 0.15s ease;
            `;

            const text = getTextContent(btn);
            const tag = btn.tagName.toLowerCase();
            const classes = btn.className ? `.${btn.className.split(' ').slice(0, 2).join('.')}` : '';

            option.innerHTML = `
                <div style="color: #ccc; font-size: 14px; margin-bottom: 4px;">${index + 1}. "${text}"</div>
                <div style="color: #666; font-size: 11px; font-family: monospace;">&lt;${tag}${classes}&gt;</div>
            `;

            // Hover highlights actual DOM element with outline for visual confirmation.
            option.addEventListener('mouseenter', () => {
                option.style.borderColor = '#4a9';
                option.style.background = '#2a2a2a';
                btn.style.outline = '3px solid #4a9';
                btn.style.outlineOffset = '2px';
            });

            option.addEventListener('mouseleave', () => {
                option.style.borderColor = '#333';
                option.style.background = '#252525';
                btn.style.outline = '';
            });

            option.addEventListener('click', () => {
                state.signature = createSignature(btn);
                btn.style.outline = '';
                overlay.remove();
                selectionOverlay = null;
                setupObserver();
                startCycle();
            });

            container.appendChild(option);
        });

        const cancel = document.createElement('div');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'color: #888; font-size: 13px; margin-top: 12px; cursor: pointer; text-align: center;';
        cancel.addEventListener('click', () => {
            overlay.remove();
            selectionOverlay = null;
            stop();
        });
        container.appendChild(cancel);

        overlay.appendChild(container);
        document.body.appendChild(overlay);
        selectionOverlay = overlay;
    }

    // Main execution loop. Async to allow smooth scrolling and content load delays.
    // Re-resolves element each cycle; does not cache DOM references.
    async function cycle() {
        if (!state.running || state.paused) return;

        let target = resolveElement();

        if (!target) {
            const buttons = findLoadMoreButtons();

            if (buttons.length === 0) {
                notify('No more "Load More" buttons found.');
                stop();
                return;
            }

            if (buttons.length === 1) {
                target = buttons[0];
                state.signature = createSignature(target);
                setupObserver();
            } else {
                createSelectionOverlay(buttons);
                return;
            }
        }

        if (target && target.getClientRects().length > 0) {
            const wouldNavigate = willNavigate(target);

            // First click establishes navigation mode for session.
            // Subsequent clicks must match mode; 'ajax' mode rejects navigation attempts.
            if (state.navigationMode === null) {
                state.navigationMode = wouldNavigate ? 'navigate' : 'ajax';
            } else if (state.navigationMode === 'ajax' && wouldNavigate) {
                notify('Button would navigate away, stopping.');
                stop();
                return;
            }

            // scrollIntoView before click increases reliability on lazy-bound handlers
            // and intersection-observer-gated buttons that ignore clicks when offscreen.
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await new Promise(r => setTimeout(r, 150));

            target.click();

            window.scrollBy({ top: CONFIG.scrollAmount, behavior: 'smooth' });
            await new Promise(r => setTimeout(r, CONFIG.scrollDelay));

            await new Promise(r => setTimeout(r, CONFIG.cycleDelay));

            // Idle detection: compare DOM metric and mutation count to detect stalled content.
            // Both signals must show no change; prevents false positives from unrelated DOM activity.
            const newMetric = getDomMetric();
            const mutationDelta = state.getMutationCount ? state.getMutationCount() : 0;

            if (newMetric === state.lastDomMetric && mutationDelta === 0) {
                state.idleCycles++;
            } else {
                state.idleCycles = 0;
                state.lastDomMetric = newMetric;
            }

            // maxIdleCycles consecutive idle cycles indicates content exhaustion.
            // More reliable than attempt counting; adapts to variable backend response times.
            if (state.idleCycles >= CONFIG.maxIdleCycles) {
                notify('No new content detected, stopping.');
                stop();
                return;
            }

            cycle();
        } else {
            notify('Target element no longer visible, stopping.');
            stop();
        }
    }

    function startCycle() {
        state.idleCycles = 0;
        state.lastDomMetric = getDomMetric();
        cycle();
    }

    function start() {
        state.running = true;
        updateButtonState();

        const buttons = findLoadMoreButtons();

        if (buttons.length === 0) {
            notify('No "Load More" buttons found on this page.');
            stop();
            return;
        }

        if (buttons.length === 1) {
            state.signature = createSignature(buttons[0]);
            setupObserver();
            startCycle();
        } else {
            createSelectionOverlay(buttons);
        }
    }

    // Full state reset. Does not reset everHadButtons (latch persists for session).
    function stop() {
        state.running = false;
        state.paused = false;
        state.signature = null;
        state.appendContainer = null;
        state.navigationMode = null;
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }
        state.getMutationCount = null;
        updateButtonState();
    }

    // Toggle behaviour depends on current state:
    // - Not running: start
    // - Running and not paused: pause (preserves signature, observer, navigationMode)
    // - Running and paused: resume from where left off
    function toggle() {
        if (state.running) {
            if (state.paused) {
                state.paused = false;
                updateButtonState();
                cycle();
            } else {
                state.paused = true;
                updateButtonState();
            }
        } else {
            start();
        }
    }

    GM_registerMenuCommand('Toggle Auto Load-More', toggle);
    GM_registerMenuCommand('Set Cycle Delay', () => {
        const current = CONFIG.cycleDelay;
        const input = prompt('Cycle delay in milliseconds:', current);
        if (input !== null) {
            const val = parseInt(input, 10);
            if (!isNaN(val) && val >= 100) {
                CONFIG.cycleDelay = val;
                GM_setValue('cycleDelay', val);
                notify(`Cycle delay set to ${val}ms`);
            }
        }
    });

    createToggleButton();
    startVisibilityObserver();
})();