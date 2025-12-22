// ==UserScript==
// @name         Global Short Video Hider
// @namespace    global-short-video
// @version      2.2
// @description  Hide short videos globally. Protects containers with confirmed long videos from future hide attempts.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const MIN_SECONDS = 59;

    const DURATION_RE = /^(\d{1,2}):(\d{2})$/;
    const MEDIA_HINT_RE = /(video|thumb|thumbnail|card|tile|result|entry|grid|feed|preview|item|watch)/i;

    const hiddenContainers = new WeakSet();
    const protectedContainers = new WeakSet();

    function parseTime(text) {
        const m = text.trim().match(DURATION_RE);
        if (!m) return null;
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        if (secs > 59) return null;
        return mins * 60 + secs;
    }

    function isTooLarge(el) {
        const { clientWidth: w, clientHeight: h } = el;
        return w > window.innerWidth * 0.7 || h > window.innerHeight * 0.7;
    }

    function isReasonableCardSize(el) {
        const { clientWidth: w, clientHeight: h } = el;
        if (w === 0 && h === 0) return false;
        if (w < 50 && h < 50) return false;
        return !isTooLarge(el);
    }

    function hasVideoAncestor(el) {
        let node = el.parentElement;
        while (node && node !== document.body) {
            if (node.tagName === "VIDEO") return true;
            if (node.querySelector?.("video")) return true;
            node = node.parentElement;
        }
        return false;
    }

    function hasProtectedAncestor(el) {
        let node = el;
        while (node && node !== document.body) {
            if (protectedContainers.has(node)) return true;
            node = node.parentElement;
        }
        return false;
    }

    function findCardContainer(el, mustHaveImage = false) {
        let node = el.parentElement;
        let depth = 0;

        while (node && node !== document.body && depth < 10) {
            const style = getComputedStyle(node);
            if (style.display === "inline" || style.display === "contents") {
                node = node.parentElement;
                depth++;
                continue;
            }

            const hint = MEDIA_HINT_RE.test(`${node.id} ${node.className}`);
            const hasImage = !mustHaveImage || node.querySelector("img, picture");

            if (hint && hasImage && isReasonableCardSize(node)) {
                return node;
            }

            node = node.parentElement;
            depth++;
        }
        return null;
    }

    function hide(container) {
        if (!container) return;
        if (hiddenContainers.has(container)) return;
        if (container === document.body || container === document.documentElement) return;
        if (isTooLarge(container)) return;
        if (protectedContainers.has(container)) return;
        if (hasProtectedAncestor(container)) return;

        hiddenContainers.add(container);
        container.style.display = "none";
    }

    function protect(container) {
        if (!container) return;
        protectedContainers.add(container);
    }

    // --- Video handler ---

    function handleVideo(video) {
        if (video._gsvhProcessed) return;
        video._gsvhProcessed = true;

        const evaluate = () => {
            if (!isFinite(video.duration)) return;

            const container = findCardContainer(video, false);

            if (video.duration >= MIN_SECONDS) {
                protect(container);
                return;
            }

            if (container) hide(container);
        };

        if (isFinite(video.duration) && video.duration > 0) {
            evaluate();
        } else {
            video.addEventListener("loadedmetadata", evaluate, { once: true });
        }
    }

    // --- Timestamp handler ---

    function handleTimestamp(el) {
        if (el._gsvhProcessed) return;
        el._gsvhProcessed = true;

        const text = el.textContent?.trim();
        if (!text || text === "0:00" || text.includes("/")) return;

        const secs = parseTime(text);
        if (secs === null) return;

        if (hasVideoAncestor(el)) return;
        if (hasProtectedAncestor(el)) return;

        const container = findCardContainer(el, true);
        if (!container) return;
        if (container.querySelector("video")) return;
        if (protectedContainers.has(container)) return;

        // Long timestamp: protect container instead of hiding
        if (secs >= MIN_SECONDS) {
            protect(container);
            return;
        }

        hide(container);
    }

    // --- Scanning ---

    function scan(root) {
        const base = root instanceof Element ? root : document.documentElement;

        // Process videos first
        base.querySelectorAll("video").forEach(handleVideo);

        // Gather all timestamp elements
        const elements = base.querySelectorAll("span, div, time, a, p");

        // Two-pass: protect long timestamps first, then hide short ones
        const longTimestamps = [];
        const shortTimestamps = [];

        for (const el of elements) {
            if (el._gsvhProcessed) continue;

            const text = el.textContent?.trim();
            if (!text || text === "0:00" || text.includes("/")) continue;

            const secs = parseTime(text);
            if (secs === null) continue;

            if (secs >= MIN_SECONDS) {
                longTimestamps.push(el);
            } else {
                shortTimestamps.push(el);
            }
        }

        // First pass: protect containers with long timestamps
        for (const el of longTimestamps) {
            handleTimestamp(el);
        }

        // Second pass: hide containers with short timestamps (unless now protected)
        for (const el of shortTimestamps) {
            handleTimestamp(el);
        }
    }

    const observer = new MutationObserver(records => {
        for (const r of records) {
            for (const n of r.addedNodes) {
                if (n.nodeType === Node.ELEMENT_NODE) scan(n);
            }
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan(document);

})();