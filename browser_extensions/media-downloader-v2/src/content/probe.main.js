/**
 * MAIN-world page probe.
 *
 * IMPORTANT: this file observes and reports. It NEVER fetches media bytes.
 * That distinction is the entire bug in v1 — it fetched manifests, keys and
 * previews from here, which runs as page script under the page's origin and gets
 * a real CORS check, then concluded from the failures that MV3 forbade the whole
 * operation. Bytes move in the offscreen document; this file only tells the
 * extension what exists.
 *
 * Self-contained by necessity: manifest-declared content scripts cannot be ES
 * modules, so there are no imports here.
 */

(() => {
    'use strict';

    const EVENT = '__mdl_probe_v2';
    let seq = 0;

    /**
     * Report an observation. Unlike v1 there is NO permanent suppression set —
     * v1's `reportedUrls` Set meant a URL first seen as a network candidate could
     * never later be reported as a play confirmation, which is the most common
     * real-world ordering and guaranteed a stuck, unselectable card. We dedupe by
     * (url + evidence kind) only, so each distinct KIND of observation still lands.
     */
    const reported = new Set();
    function report(evidence, url, detail = {}) {
        if (!url) return;
        const sig = evidence + '|' + url;
        if (reported.has(sig)) return;
        reported.add(sig);
        try {
            document.dispatchEvent(new CustomEvent(EVENT, {
                detail: { evidence, url, seq: seq++, pageTitle: document.title, ...detail },
            }));
        } catch { /* page may have locked down CustomEvent */ }
    }

    // -----------------------------------------------------------------------
    // Media elements
    // -----------------------------------------------------------------------

    function describe(el) {
        return {
            elementId: el.id || el.getAttribute('data-testid') || cssPath(el),
            width: el.videoWidth || el.naturalWidth || null,
            height: el.videoHeight || el.naturalHeight || null,
            duration: Number.isFinite(el.duration) ? el.duration : null,
            kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
        };
    }

    function cssPath(el) {
        // Cheap structural identity, stable enough to group variants of one player.
        const parts = [];
        let n = el;
        for (let i = 0; n && i < 4; i++, n = n.parentElement) {
            let s = n.tagName?.toLowerCase() || '';
            if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
            const sib = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
            parts.unshift(s + ':' + sib);
        }
        return parts.join('>');
    }

    function watch(el) {
        if (el.__mdlWatched) return;
        el.__mdlWatched = true;

        const emit = (evidence) => {
            const src = el.currentSrc || el.src || '';
            if (src && !/^blob:/i.test(src)) report(evidence, src, describe(el));
            else if (src) report('probe:mse-attach', location.href, { ...describe(el), blobSrc: true });
        };

        // Media events do NOT compose out of shadow roots, so we bind per element
        // rather than relying on a document-level listener — v1 missed every
        // shadow-DOM player for exactly this reason.
        el.addEventListener('loadedmetadata', () => emit('probe:media-element'), { passive: true });
        el.addEventListener('play', () => emit('probe:media-play'), { passive: true });
        el.addEventListener('playing', () => emit('probe:media-play'), { passive: true });

        if (el.readyState >= 1) emit('probe:media-element');

        // Late-bound sources: players commonly set src after insertion.
        try {
            new MutationObserver(() => emit('probe:media-element'))
                .observe(el, { attributes: true, attributeFilter: ['src'] });
        } catch { /* ignore */ }
    }

    function sweep(root = document) {
        try {
            for (const el of root.querySelectorAll('video, audio')) watch(el);
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) sweep(el.shadowRoot);
            }
        } catch { /* ignore */ }
    }

    // -----------------------------------------------------------------------
    // MSE — where the real URL lives when currentSrc is a blob:
    // -----------------------------------------------------------------------

    try {
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
            const url = origCreate.call(this, obj);
            if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
                obj.__mdlBlobUrl = url;
                report('probe:mse-attach', location.href, { blobUrl: url });
            }
            return url;
        };
    } catch { /* ignore */ }

    try {
        if (typeof MediaSource !== 'undefined') {
            const origAdd = MediaSource.prototype.addSourceBuffer;
            MediaSource.prototype.addSourceBuffer = function (mime) {
                const sb = origAdd.call(this, mime);
                let total = 0;
                try {
                    const origAppend = sb.appendBuffer.bind(sb);
                    sb.appendBuffer = (data) => {
                        total += data?.byteLength || 0;
                        // Report once we've seen enough to be confident it's real
                        // playback rather than an init probe.
                        if (total > 512 * 1024) {
                            report('probe:mse-append', location.href, { codec: mime, bytes: total });
                        }
                        return origAppend(data);
                    };
                } catch { /* ignore */ }
                return sb;
            };
        }
    } catch { /* ignore */ }

    // EME means the bytes reaching appendBuffer are encrypted by a CDM we cannot
    // and will not touch. Detect it so the UI can say so honestly instead of
    // producing a large corrupt file.
    try {
        if (navigator.requestMediaKeySystemAccess) {
            const orig = navigator.requestMediaKeySystemAccess.bind(navigator);
            navigator.requestMediaKeySystemAccess = function (system, configs) {
                report('probe:eme-detected', location.href, { drmSystem: system, isDRM: true });
                return orig(system, configs);
            };
        }
    } catch { /* ignore */ }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    const start = () => {
        sweep();
        try {
            new MutationObserver((muts) => {
                for (const m of muts) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') watch(n);
                        else if (n.querySelectorAll) sweep(n);
                    }
                }
            }).observe(document.documentElement, { childList: true, subtree: true });
        } catch { /* ignore */ }
    };

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
