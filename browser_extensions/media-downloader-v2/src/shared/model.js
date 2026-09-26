/**
 * The media record and its evidence model.
 *
 * v1 used a five-state machine (candidate -> confirmed -> validated -> actionable
 * -> failed) that both live code paths bypassed by assigning `record.state`
 * directly, stranding validate(), computeDedupeKey() and makeActionable() as dead
 * code. Worse, FAILED was terminal: one bad probe and a perfectly downloadable
 * video became permanently unselectable.
 *
 * Here there is no state machine. A record accumulates *evidence*, and confidence
 * is derived from the evidence set. Nothing is ever deleted for lacking evidence —
 * it just ranks lower. Everything remains downloadable, always.
 */

import { normalizeUrl, siteOf, stemFromUrl, shortHash } from './url.js';
import { kindForMime } from './mime.js';

/** Evidence kinds, with the weight each contributes to confidence. */
export const EV = {
    NETWORK: 'network',              // seen in webRequest
    MEDIA_TYPE: 'media-type',        // details.type === 'media' — strongest free signal
    DOM_ATTACHED: 'dom-attached',    // found as a real element in the DOM
    PLAYED: 'played',                // user pressed play on it
    MSE_APPENDED: 'mse-appended',    // bytes were fed to a SourceBuffer
    MANIFEST_CHILD: 'manifest-child',// parsed out of a manifest we fetched
    PROBED: 'probed',                // we HEAD/Range-probed it and got media headers
    EXTENSION: 'extension',          // URL just looks like media
    PROBE_FAILED: 'probe-failed',    // negative evidence — lowers rank, never removes
};

const WEIGHT = {
    [EV.MEDIA_TYPE]: 40,
    [EV.PROBED]: 35,
    [EV.MANIFEST_CHILD]: 30,
    [EV.PLAYED]: 25,
    [EV.DOM_ATTACHED]: 20,
    [EV.MSE_APPENDED]: 20,
    [EV.NETWORK]: 10,
    [EV.EXTENSION]: 5,
    [EV.PROBE_FAILED]: -30,
};

export function makeRecord({ url, tabId, frameId = 0, pageUrl = '', pageTitle = '', kind = null }) {
    const key = normalizeUrl(url);
    return {
        id: shortHash(key + '|' + tabId),
        url,
        key,
        tabId,
        frameId,
        pageUrl,
        pageTitle,
        site: siteOf(pageUrl || url),
        kind,                    // 'image' | 'video' | 'audio' | 'stream'
        evidence: [],            // {kind, at, ...detail}
        // Facts learned by probing. Null means unknown, never "assume zero".
        mime: null,
        bytes: null,             // real Content-Length — never estimated from pixels
        width: null,
        height: null,
        duration: null,
        acceptsRanges: null,
        // Stream specifics
        variants: null,          // [{url, bandwidth, resolution, codecs}]
        isDRM: false,
        drmSystem: null,
        // Grouping
        groupId: null,
        parentId: null,
        // Download outcome
        state: 'detected',       // detected | queued | fetching | done | failed | dupe
        failCode: null,
        failMessage: null,
        savedPath: null,
        thumb: null,
        pHash: null,
        addedAt: Date.now(),
    };
}

/** Add evidence. Idempotent per kind+detail so repeated observations don't inflate rank. */
export function addEvidence(rec, kind, detail = {}) {
    const sig = kind + ':' + (detail.sig ?? '');
    if (rec.evidence.some((e) => e.sig === sig)) return rec;
    rec.evidence.push({ kind, sig, at: Date.now(), ...detail });

    // Evidence can teach us facts. Apply them, preferring more reliable sources.
    if (detail.mime && !rec.mime) {
        rec.mime = detail.mime;
        rec.kind = rec.kind || kindForMime(detail.mime);
    }
    if (typeof detail.bytes === 'number' && detail.bytes > 0) rec.bytes = detail.bytes;
    if (detail.width) rec.width = detail.width;
    if (detail.height) rec.height = detail.height;
    if (detail.duration) rec.duration = detail.duration;
    if (typeof detail.acceptsRanges === 'boolean') rec.acceptsRanges = detail.acceptsRanges;
    if (detail.pageTitle && !rec.pageTitle) rec.pageTitle = detail.pageTitle;
    return rec;
}

/** 0-100. Derived, never assigned. */
export function confidence(rec) {
    let score = 0;
    const seen = new Set();
    for (const e of rec.evidence) {
        if (seen.has(e.kind)) continue;   // each KIND counts once
        seen.add(e.kind);
        score += WEIGHT[e.kind] ?? 0;
    }
    return Math.max(0, Math.min(100, score));
}

export function hasEvidence(rec, kind) {
    return rec.evidence.some((e) => e.kind === kind);
}

/**
 * A human-meaningful label. v1 titled every video card with the tab hostname,
 * so five quality variants of one video rendered as five identical rows reading
 * "example.com".
 */
export function label(rec) {
    const bits = [];
    if (rec.width && rec.height) bits.push(`${rec.width}x${rec.height}`);
    else if (rec.variants?.length) bits.push(`${rec.variants.length} qualities`);
    if (rec.duration) bits.push(fmtDuration(rec.duration));
    if (rec.bytes) bits.push(fmtBytes(rec.bytes));
    const stem = stemFromUrl(rec.url);
    return bits.length ? `${stem} — ${bits.join(' · ')}` : stem;
}

export function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}

export function fmtDuration(s) {
    if (s == null) return '';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    if (m < 60) return `${m}:${String(sec).padStart(2, '0')}`;
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Grouping, most reliable signal first:
 *   1. explicit manifest parentage (knowledge, not heuristics)
 *   2. same frame + same DOM element
 *   3. normalised URL identity
 *
 * v1 fell back to raw string equality because its dedupeKey was always null,
 * so the same video at five bitrates appeared five times.
 */
export function groupKey(rec) {
    if (rec.parentId) return 'parent:' + rec.parentId;
    const el = rec.evidence.find((e) => e.kind === EV.DOM_ATTACHED && e.elementId);
    if (el) return `el:${rec.tabId}:${rec.frameId}:${el.elementId}`;
    return 'url:' + rec.key;
}
