/**
 * Detection store — write-through to chrome.storage.session.
 *
 * v1 kept every record in plain in-memory Maps (background.js:250, 402) while
 * writing the badge count to the browser, which survives. Chrome terminates an
 * MV3 service worker after ~30s idle, so the routine outcome was a badge reading
 * "1" over a popup saying "No videos detected yet". The state and the badge could
 * not agree because they lived in different places with different lifetimes.
 *
 * Here the store IS the source of truth, it is rehydrated before any listener
 * body runs, and the badge is *derived* from it. They cannot disagree.
 */

import { log } from '../shared/log.js';
import { confidence, groupKey } from '../shared/model.js';

const KEY = 'mdl:records';
const TABS_KEY = 'mdl:tabs';

/** @type {Map<string, object>} id -> record */
let records = new Map();
/**
 * Per-tab facts that are not media records: MSE playback seen, EME (DRM)
 * requested, segments observed. v2.0 stored these as records keyed on the page
 * URL, which put the page itself in the grid as a "video" that failed with
 * HTML_RESPONSE and hung the DRM badge on it rather than on the stream.
 * @type {Map<number, object>} tabId -> flags
 */
let tabs = new Map();
let ready = false;
let writeTimer = null;
const listeners = new Set();

/**
 * Must be awaited at the top of every listener. Chrome may spin up the worker
 * for any event; if we touch `records` before this resolves we read an empty map
 * and silently lose everything the user detected 40 seconds ago.
 */
export async function ensureReady() {
    if (ready) return;
    try {
        const got = await chrome.storage.session.get([KEY, TABS_KEY]);
        const arr = got?.[KEY];
        if (Array.isArray(arr)) records = new Map(arr.map((r) => [r.id, r]));
        const tarr = got?.[TABS_KEY];
        if (Array.isArray(tarr)) tabs = new Map(tarr.map((t) => [t.tabId, t]));
        log('store', `rehydrated ${records.size} records, ${tabs.size} tab flag sets`);
    } catch (e) {
        log('store', 'rehydrate failed', e?.message);
    }
    ready = true;
}

function scheduleWrite() {
    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        try {
            await chrome.storage.session.set({
                [KEY]: [...records.values()],
                [TABS_KEY]: [...tabs.values()],
            });
        } catch (e) {
            log('store', 'persist failed', e?.message);
        }
    }, 250);
}

function emit(delta) {
    for (const fn of listeners) {
        try { fn(delta); } catch { /* a bad subscriber must not break the store */ }
    }
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function get(id) {
    return records.get(id);
}

export function getByKey(tabId, key) {
    for (const r of records.values()) {
        if (r.tabId === tabId && r.key === key) return r;
    }
    return null;
}

export function upsert(rec) {
    const existed = records.has(rec.id);
    records.set(rec.id, rec);
    scheduleWrite();
    emit(existed ? { changed: [rec.id] } : { added: [rec.id] });
    if (rec.tabId != null) refreshBadge(rec.tabId);
    return rec;
}

export function touch(id) {
    const r = records.get(id);
    if (!r) return;
    scheduleWrite();
    emit({ changed: [id] });
    if (r.tabId != null) refreshBadge(r.tabId);
}

export function all() {
    return [...records.values()];
}

export function forTab(tabId) {
    return [...records.values()].filter((r) => r.tabId === tabId);
}

/**
 * Records grouped for display: one entry per logical media item, with variants
 * collapsed underneath rather than shown as N identical rows.
 */
export function groupedForTab(tabId) {
    const groups = new Map();
    for (const r of forTab(tabId)) {
        const k = groupKey(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    return [...groups.entries()].map(([k, members]) => {
        members.sort((a, b) => confidence(b) - confidence(a) || (b.bytes ?? 0) - (a.bytes ?? 0));
        return { groupId: k, primary: members[0], members };
    });
}

export function removeTab(tabId) {
    const gone = [];
    for (const [id, r] of records) {
        if (r.tabId === tabId) { records.delete(id); gone.push(id); }
    }
    const hadFlags = tabs.delete(tabId);
    if (gone.length || hadFlags) { scheduleWrite(); emit({ removed: gone, tabs: [tabId] }); }
    clearBadge(tabId);
}

export function clearAll() {
    const gone = [...records.keys()];
    records.clear();
    tabs.clear();
    scheduleWrite();
    emit({ removed: gone, tabs: [] });
}

// ---------------------------------------------------------------------------
// Tab flags
// ---------------------------------------------------------------------------

/** Merge a patch into a tab's flags. Counters in the patch are added, not set. */
export function setTabFlags(tabId, patch = {}) {
    if (tabId == null || tabId < 0) return null;
    const cur = tabs.get(tabId) || { tabId, mse: false, drm: null, segments: 0, pageUrl: '', updatedAt: 0 };
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'segments') next.segments = (cur.segments || 0) + (v || 0);
        else if (v !== undefined && v !== null && v !== '') next[k] = v;
    }
    next.updatedAt = Date.now();
    tabs.set(tabId, next);
    scheduleWrite();
    // Segments arrive several times a second while a stream plays. The Library
    // does not need a refresh per segment: notify on the first, then every 25th,
    // and always when a non-counter fact changed.
    const counterOnly = Object.keys(patch).every((k) => k === 'segments' || k === 'pageUrl');
    if (!counterOnly || next.segments === 1 || next.segments % 25 === 0) emit({ tabs: [tabId] });
    return next;
}

export function getTabFlags(tabId) {
    return tabs.get(tabId) || null;
}

export function allTabFlags() {
    return [...tabs.values()];
}

// ---------------------------------------------------------------------------
// Badge — derived from the store, never written independently
// ---------------------------------------------------------------------------

export function refreshBadge(tabId) {
    const n = forTab(tabId).filter((r) => r.state !== 'dupe').length;
    const text = n > 0 ? String(n) : '';
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    if (n > 0) {
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#1eabd0' }).catch(() => {});
    }
}

export function clearBadge(tabId) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}
