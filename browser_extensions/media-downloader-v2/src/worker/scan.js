/**
 * Active page scanning — the injected DOM walk.
 *
 * One canonical extractor. v1 had FOUR divergent implementations of "find the
 * best version of this image" (background.js:1922, background.js:2972,
 * intercept.js:688, shortcuts.js:74) with different attribute lists and different
 * srcset handling, so the same image yielded a different URL depending on whether
 * you used the hover icon, the grid, the keyboard shortcut or the batch path.
 *
 * Also fixed here: v1 returned early on `data:` placeholders before ever reading
 * data-src (background.js:2968), so lazy-loaded galleries — i.e. most galleries —
 * silently produced nothing.
 */

import { makeRecord, addEvidence, EV } from '../shared/model.js';
import { normalizeUrl } from '../shared/url.js';
import * as store from './store.js';
import { log } from '../shared/log.js';
import { refreshUrl, refineKindFromElement } from './detect/network.js';

/**
 * Injected into every frame. Must be fully self-contained — it is serialised
 * and evaluated in the page, so it can close over nothing.
 */
function extractFromPage() {
    const out = [];
    const seen = new Set();

    const push = (url, kind, extra) => {
        if (!url || typeof url !== 'string') return;
        if (/^(data|blob|javascript|about):/i.test(url)) return;
        let abs;
        try { abs = new URL(url, location.href).href; } catch { return; }
        if (!/^https?:/i.test(abs)) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        out.push({ url: abs, kind, ...extra });
    };

    /** Widest candidate from a srcset, honouring both w and x descriptors. */
    const bestFromSrcset = (srcset) => {
        if (!srcset) return null;
        let best = null, bestScore = -1;
        for (const part of srcset.split(',')) {
            const bits = part.trim().split(/\s+/);
            if (!bits[0]) continue;
            const d = bits[1] || '';
            let score = 1;
            if (d.endsWith('w')) score = parseFloat(d) || 1;
            else if (d.endsWith('x')) score = (parseFloat(d) || 1) * 1000;
            if (score > bestScore) { bestScore = score; best = bits[0]; }
        }
        return best;
    };

    /** Ordered full-resolution candidates. First hit wins. */
    const FULL_ATTRS = [
        'data-original', 'data-src-large', 'data-large', 'data-large-file',
        'data-full', 'data-full-src', 'data-hi-res', 'data-highres',
        'data-zoom-image', 'data-image', 'data-lazy-src', 'data-lazy',
        'data-src', 'data-srcset',
    ];

    const resolveImg = (img) => {
        // 1. An explicit full-resolution attribute beats everything.
        for (const a of FULL_ATTRS) {
            const v = img.getAttribute(a);
            if (!v) continue;
            if (a === 'data-srcset') { const b = bestFromSrcset(v); if (b) return b; continue; }
            if (!/^data:/i.test(v)) return v;
        }
        // 2. A <picture><source> sibling may carry a wider candidate.
        const pic = img.closest('picture');
        if (pic) {
            for (const s of pic.querySelectorAll('source[srcset]')) {
                const b = bestFromSrcset(s.getAttribute('srcset'));
                if (b) return b;
            }
        }
        // 3. The element's own srcset.
        const ss = bestFromSrcset(img.getAttribute('srcset'));
        if (ss) return ss;
        // 4. A parent <a> pointing at an image file is usually the original.
        const a = img.closest('a[href]');
        if (a && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(a.getAttribute('href') || '')) {
            return a.getAttribute('href');
        }
        // 5. currentSrc reflects what the browser actually chose.
        return img.currentSrc || img.src || null;
    };

    // --- walk, piercing open shadow roots ---
    const roots = [document];
    const walkShadow = (node) => {
        const all = node.querySelectorAll('*');
        for (const el of all) if (el.shadowRoot) { roots.push(el.shadowRoot); walkShadow(el.shadowRoot); }
    };
    try { walkShadow(document); } catch { /* deep trees can be expensive; best effort */ }

    for (const root of roots) {
        for (const img of root.querySelectorAll('img')) {
            const url = resolveImg(img);
            if (!url) continue;
            push(url, 'image', {
                width: img.naturalWidth || null,
                height: img.naturalHeight || null,
                alt: img.alt || null,
                upgraded: url !== (img.currentSrc || img.src),
            });
        }

        for (const v of root.querySelectorAll('video')) {
            const src = v.currentSrc || v.src;
            if (src && !/^blob:/i.test(src)) {
                push(src, 'video', {
                    width: v.videoWidth || null,
                    height: v.videoHeight || null,
                    duration: Number.isFinite(v.duration) ? v.duration : null,
                    poster: v.poster || null,
                });
            }
            for (const s of v.querySelectorAll('source[src]')) {
                const type = s.getAttribute('type') || '';
                // A <video> element can legitimately carry an audio-only source.
                push(s.getAttribute('src'), /^audio\//i.test(type) ? 'audio' : 'video', { type: type || null });
            }
        }

        for (const a of root.querySelectorAll('audio')) {
            const src = a.currentSrc || a.src;
            if (src && !/^blob:/i.test(src)) {
                push(src, 'audio', { duration: Number.isFinite(a.duration) ? a.duration : null });
            }
            // preload="none" players have no currentSrc until play; the
            // <source> children are the only place the URL exists.
            for (const s of a.querySelectorAll('source[src]')) {
                push(s.getAttribute('src'), 'audio', { type: s.getAttribute('type') || null });
            }
        }

        // Computed background-image, not just the inline style attribute — v1
        // only read el.style.backgroundImage, missing every CSS-class background.
        for (const el of root.querySelectorAll('[style*="background"], .hero, .banner, figure, [class*="thumb"], [class*="image"]')) {
            let bg = '';
            try { bg = getComputedStyle(el).backgroundImage; } catch { continue; }
            if (!bg || bg === 'none') continue;
            const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m) push(m[1], 'image', { fromCss: true });
        }
    }

    return {
        items: out,
        pageTitle: document.title,
        pageUrl: location.href,
        closedShadowRootsPossible: roots.length > 1,
    };
}

/**
 * Scan one tab, all frames. Returns the number of newly-added records.
 */
export async function scanTab(tabId) {
    await store.ensureReady();

    // Refuse pages no extension can inject into, with a message that says why.
    // Without this the caller gets Chrome's raw "Cannot access contents of url"
    // error, which is baffling when the URL in it is the extension's own Library.
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { /* gone */ }
    if (!tab) return { added: 0, error: 'That tab no longer exists.' };
    if (!/^https?:/i.test(tab.url || '')) {
        return {
            added: 0,
            error: `Cannot scan ${describeScheme(tab.url)} — extensions may only read http(s) pages. ` +
                   `Switch to the page you want to scan, then try again.`,
        };
    }

    let frames;
    try {
        frames = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },     // v1 was top-frame only
            func: extractFromPage,
        });
    } catch (e) {
        log('scan', `tab ${tabId} injection failed: ${e?.message}`);
        return { added: 0, error: e?.message };
    }

    let added = 0;
    for (const frame of frames) {
        const res = frame?.result;
        if (!res?.items) continue;

        for (const it of res.items) {
            const key = normalizeUrl(it.url);
            let rec = store.getByKey(tabId, key);
            const isNew = !rec;
            if (!rec) {
                rec = makeRecord({
                    url: it.url,
                    tabId,
                    frameId: frame.frameId ?? 0,
                    pageUrl: res.pageUrl,
                    pageTitle: res.pageTitle,
                    kind: it.kind,
                });
            } else {
                refreshUrl(rec, it.url);
                refineKindFromElement(rec, it.kind);
                if (!rec.pageUrl || !rec.pageUrl.includes('/', 8)) rec.pageUrl = res.pageUrl;
            }
            addEvidence(rec, EV.DOM_ATTACHED, {
                sig: 'dom',
                width: it.width || undefined,
                height: it.height || undefined,
                duration: it.duration || undefined,
                pageTitle: res.pageTitle,
                upgraded: it.upgraded,
                fromCss: it.fromCss,
            });
            store.upsert(rec);
            if (isNew) added++;
        }
    }

    log('scan', `tab ${tabId}: +${added} across ${frames.length} frame(s)`);
    return { added, frames: frames.length };
}

function describeScheme(url) {
    const s = String(url || '');
    if (s.startsWith('chrome-extension://')) return 'an extension page';
    if (s.startsWith('chrome://')) return 'a browser settings page';
    if (s.startsWith('about:')) return 'a blank tab';
    if (s.startsWith('file://')) return 'a local file (enable "Allow access to file URLs")';
    return 'this page';
}

export async function scanTabs(tabIds) {
    let total = 0;
    let scanned = 0;
    const skipped = [];
    for (const id of tabIds) {
        const r = await scanTab(id);
        if (r.error) skipped.push(r.error);
        else { scanned++; total += r.added || 0; }
    }
    return { added: total, scanned, skipped: skipped.length };
}
