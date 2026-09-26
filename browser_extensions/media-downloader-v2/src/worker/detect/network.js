/**
 * Passive network detection.
 *
 * Two fixes over v1 that matter more than they sound:
 *
 * 1. v1 listened on webRequest.onCompleted. A progressive MP4 that streams for
 *    six minutes fires onCompleted six minutes after it starts — long after the
 *    2-second play-correlation window had closed, so the strongest signal always
 *    arrived too late to be used. onHeadersReceived fires as soon as the headers
 *    land, which is when we actually learn everything useful.
 *
 * 2. v1's page-side hook kept a permanent `reportedUrls` Set (intercept.js:54),
 *    so a URL first seen as a network candidate could NEVER later be reported as
 *    a play confirmation. The most common real-world ordering therefore
 *    guaranteed a stuck, unselectable card. Nothing here is ever permanently
 *    suppressed; repeat observations are merged as additional evidence.
 *
 * v2.1:
 *  - a re-observed URL replaces the stored one for video/audio/stream, so a
 *    rotated signed URL is what gets downloaded rather than the expired first
 *    sighting (identity is the normalised key either way; images keep
 *    first-seen because CDN resize paths share a key and "latest" could be the
 *    smaller rendition);
 *  - a DOM element's tag can correct a network-derived video/audio kind;
 *  - segments and page-level MSE/EME signals go to tab flags, not records.
 */

import { log } from '../../shared/log.js';
import { makeRecord, addEvidence, EV } from '../../shared/model.js';
import { normalizeUrl } from '../../shared/url.js';
import * as store from '../store.js';
import { classify, headerValue, totalBytesFromHeaders } from './classify.js';

const FILTER = { urls: ['<all_urls>'] };

const TIME_BASED = new Set(['video', 'audio', 'stream']);

/** Latest-URL-wins for time-based media; first-seen stays for images. */
export function refreshUrl(rec, url) {
    if (!url || rec.url === url) return;
    if (TIME_BASED.has(rec.kind)) rec.url = url;
}

/**
 * A media element's tag is a better witness to video-vs-audio than the network
 * layer, which sees both as resourceType 'media'. Only flips between those two.
 */
export function refineKindFromElement(rec, elementKind) {
    if (!elementKind || elementKind === rec.kind) return;
    if (!(rec.kind === 'video' || rec.kind === 'audio') || !(elementKind === 'video' || elementKind === 'audio')) return;
    // A <video> element playing a file the server labelled audio/* is still an
    // audio file; the server's word outranks the tag in that direction.
    if (elementKind === 'video' && /^audio\//i.test(rec.mime || '')) return;
    rec.kind = elementKind;
}

export function installNetworkDetection() {
    chrome.webRequest.onHeadersReceived.addListener(
        onHeaders,
        FILTER,
        ['responseHeaders']
    );

    // Tab lifecycle — release state so records never leak across pages.
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        await store.ensureReady();
        store.removeTab(tabId);
    });

    // Real navigations clear; SPA route changes do NOT (the media is often still
    // on the page). v1 had no history-state listener at all, so SPA navigation
    // silently accumulated stale records forever.
    chrome.webNavigation.onCommitted.addListener(async (d) => {
        if (d.frameId !== 0) return;
        if (['reload', 'link', 'typed', 'form_submit', 'generated'].includes(d.transitionType)) {
            await store.ensureReady();
            store.removeTab(d.tabId);
        }
    });
}

async function onHeaders(details) {
    try {
        if (details.tabId < 0) return;                 // not attributable to a tab
        if (details.statusCode >= 400) return;         // don't record known failures as media

        const contentType = headerValue(details.responseHeaders, 'content-type');
        const { kind, signal } = classify(details, contentType);
        if (!kind) return;

        await store.ensureReady();

        // Segments are evidence that a stream is playing, not media in their own
        // right. Count them on the tab and stop; the manifest is the record.
        if (kind === 'segment') {
            store.setTabFlags(details.tabId, { segments: 1, pageUrl: details.initiator || '' });
            return;
        }

        const bytes = totalBytesFromHeaders(details.responseHeaders, details.statusCode);
        const ranges = headerValue(details.responseHeaders, 'accept-ranges');

        const key = normalizeUrl(details.url);
        let rec = store.getByKey(details.tabId, key);

        if (!rec) {
            // Skip tiny images outright — favicons and spacers are noise, and
            // unlike video there are hundreds of them per page.
            if (kind === 'image' && bytes != null && bytes < 3072) return;

            rec = makeRecord({
                url: details.url,
                tabId: details.tabId,
                frameId: details.frameId ?? 0,
                pageUrl: details.initiator || details.documentUrl || '',
                kind,
            });
        } else {
            refreshUrl(rec, details.url);
        }

        addEvidence(rec, EV.NETWORK, {
            sig: String(details.requestId),
            mime: contentType ? contentType.split(';')[0].trim() : null,
            bytes: Number.isFinite(bytes) ? bytes : undefined,
            acceptsRanges: ranges ? ranges.includes('bytes') : undefined,
            frameId: details.frameId,
        });

        if (signal === 'resource-type-media') {
            addEvidence(rec, EV.MEDIA_TYPE, { sig: 'type' });
        }
        if (signal === 'extension') {
            addEvidence(rec, EV.EXTENSION, { sig: 'ext' });
        }

        store.upsert(rec);
    } catch (e) {
        log('detect', 'onHeaders error', e?.message);
    }
}

/** Probe actions that describe the PAGE, not a fetchable media URL. */
const PAGE_LEVEL = new Set(['probe:mse-attach', 'probe:mse-append', 'probe:eme-detected']);

/**
 * Record an observation coming from the page probe (MAIN world), relayed through
 * the ISOLATED bridge. Merges into whatever the network listener already saw.
 */
export async function recordProbe(msg, sender) {
    await store.ensureReady();
    const tabId = sender?.tab?.id;
    if (tabId == null || !msg.url) return;

    // MSE and EME are facts about the tab. The URL they arrive with is
    // location.href, which is a web page, not media — v2.0 turned it into a
    // "video" record that could only ever fail with HTML_RESPONSE.
    if (PAGE_LEVEL.has(msg.action)) {
        const patch = { pageUrl: sender.tab?.url || msg.url };
        if (msg.action === 'probe:eme-detected') patch.drm = msg.drmSystem || 'unknown';
        else patch.mse = true;
        store.setTabFlags(tabId, patch);
        return;
    }

    if (!/^https?:/i.test(msg.url)) return;   // blob:/data: have no fetchable identity

    const key = normalizeUrl(msg.url);
    let rec = store.getByKey(tabId, key);
    if (!rec) {
        rec = makeRecord({
            url: msg.url,
            tabId,
            frameId: sender.frameId ?? 0,
            pageUrl: sender.tab?.url || msg.pageUrl || '',
            pageTitle: msg.pageTitle || sender.tab?.title || '',
            kind: msg.kind || 'video',
        });
    } else {
        refreshUrl(rec, msg.url);
        refineKindFromElement(rec, msg.kind);
        // The probe knows the real page URL; the network layer only had the initiator origin.
        if (sender.tab?.url && (!rec.pageUrl || !rec.pageUrl.includes('/', 8))) rec.pageUrl = sender.tab.url;
    }

    addEvidence(rec, msg.evidence || EV.DOM_ATTACHED, {
        sig: msg.elementId || 'dom',
        elementId: msg.elementId,
        width: msg.width,
        height: msg.height,
        duration: msg.duration,
        pageTitle: msg.pageTitle,
    });

    if (msg.isDRM) { rec.isDRM = true; rec.drmSystem = msg.drmSystem || 'unknown'; }

    store.upsert(rec);
}
