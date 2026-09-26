/**
 * Service worker entry point — a stateless dispatcher, never a downloader.
 *
 * Chrome terminates this worker after ~30s idle. Every listener therefore
 * awaits store.ensureReady() before touching state, and no long-running work
 * lives here: bytes move in the offscreen document, which has no such limit.
 */

import { Req, Evt, Off, PORT_LIBRARY, validate } from '../shared/protocol.js';
import { ok, err, Fail } from '../shared/result.js';
import { log, diagnostics } from '../shared/log.js';
import { confidence, label } from '../shared/model.js';
import { DEFAULT_TEMPLATE } from '../shared/url.js';
import * as store from './store.js';
import { installNetworkDetection, recordProbe } from './detect/network.js';
import { scanTab, scanTabs } from './scan.js';
import { createJob, getJob, listJobs, cancelJob, retryFailed, summarise, onJobEvent, resumeInterrupted } from './jobs.js';
import { callOffscreen, handleOffscreenEvent } from './offscreen-host.js';
import { sweep } from './transport/headers.js';

const SETTINGS_KEY = 'mdl:settings';
const DEFAULT_SETTINGS = {
    template: DEFAULT_TEMPLATE,
    concurrency: 4,
    preferHeight: null,          // null = highest available
    minImageEdge: 0,
    stackSimilar: true,
};

async function getSettings() {
    try {
        const g = await chrome.storage.local.get(SETTINGS_KEY);
        return { ...DEFAULT_SETTINGS, ...(g?.[SETTINGS_KEY] || {}) };
    } catch { return { ...DEFAULT_SETTINGS }; }
}

// ---------------------------------------------------------------------------
// Ports — the library subscribes for deltas
// ---------------------------------------------------------------------------

const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_LIBRARY) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(type, payload) {
    for (const p of ports) {
        try { p.postMessage({ type, payload }); } catch { ports.delete(p); }
    }
}

store.subscribe((delta) => broadcast(Evt.ITEMS_CHANGED, delta));
onJobEvent((type, payload) => {
    broadcast(type === 'done' ? Evt.JOB_DONE : Evt.JOB_PROGRESS, payload);
});

// ---------------------------------------------------------------------------
// Serialise records for the UI
// ---------------------------------------------------------------------------

function toView(rec) {
    return {
        id: rec.id,
        url: rec.url,
        key: rec.key,
        tabId: rec.tabId,
        kind: rec.kind,
        mime: rec.mime,
        bytes: rec.bytes,
        width: rec.width,
        height: rec.height,
        duration: rec.duration,
        site: rec.site,
        pageUrl: rec.pageUrl,
        pageTitle: rec.pageTitle,
        state: rec.state,
        failCode: rec.failCode,
        failMessage: rec.failMessage,
        savedPath: rec.savedPath,
        thumb: rec.thumb,
        pHash: rec.pHash,
        isDRM: rec.isDRM,
        variants: rec.variants,
        confidence: confidence(rec),
        label: label(rec),
        evidence: rec.evidence.map((e) => e.kind),
        addedAt: rec.addedAt,
    };
}

// ---------------------------------------------------------------------------
// Message router — every branch responds, always
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Offscreen -> worker events
    if (msg?.target === 'worker') {
        if (handleOffscreenEvent(msg)) return false;
    }
    // Page probe relay
    if (typeof msg?.action === 'string' && msg.action.startsWith('probe:')) {
        recordProbe(msg, sender).catch((e) => log('probe', e?.message));
        return false;
    }

    const problem = validate(msg);
    if (problem) { sendResponse(err(Fail.NO_TRANSPORT, problem)); return false; }

    route(msg, sender)
        .then((r) => sendResponse(r))
        .catch((e) => {
            log('router', `${msg.action} threw`, e?.message);
            sendResponse(err(Fail.NO_TRANSPORT, e?.message || 'handler threw'));
        });

    return true;   // async
});

async function route(msg, sender) {
    await store.ensureReady();

    switch (msg.action) {
        case Req.GET_STATE: {
            // Scope to a tab ONLY when the caller explicitly asks for one.
            //
            // This used to fall back to `sender.tab.id`, which looks harmless but
            // is not: an extension page opened in a tab DOES populate sender.tab,
            // so the Library — whose whole job is to show everything — silently
            // scoped every query to its own (permanently empty) tab. Omitting
            // tabId now unambiguously means "everything".
            const recs = msg.tabId != null ? store.forTab(msg.tabId) : store.all();
            const flags = msg.tabId != null
                ? [store.getTabFlags(msg.tabId)].filter(Boolean)
                : store.allTabFlags();
            return ok({
                items: recs.map(toView),
                tabs: flags,          // per-tab facts: MSE seen, DRM requested, segments observed
                settings: await getSettings(),
                totalKnown: store.all().length,
            });
        }

        case Req.SCAN_TAB: {
            const tabId = msg.tabId ?? sender?.tab?.id;
            if (tabId == null) return err(Fail.NO_TRANSPORT, 'No tab id');
            const r = await scanTab(tabId);
            return r.error ? err(Fail.NO_TRANSPORT, r.error, { tabId }) : ok(r);
        }

        case Req.SCAN_TABS:
            return ok(await scanTabs(msg.tabIds || []));

        case Req.DOWNLOAD: {
            const settings = await getSettings();
            const job = await createJob({
                recordIds: msg.ids || [],
                template: msg.template || settings.template,
                jobName: msg.jobName,
                concurrency: msg.concurrency || settings.concurrency,
                preferHeight: msg.preferHeight ?? settings.preferHeight,
            });
            return ok({ jobId: job.id, total: job.items.length });
        }

        case Req.GET_JOB: {
            if (msg.jobId) {
                const j = await getJob(msg.jobId);
                return j ? ok(summarise(j)) : err(Fail.NO_TRANSPORT, 'No such job');
            }
            const all = await listJobs();
            return ok({ jobs: all.map(summarise) });
        }

        case Req.CANCEL_JOB:
            await cancelJob(msg.jobId);
            return ok({ cancelled: true });

        case Req.RETRY: {
            const n = await retryFailed(msg.jobId, { codes: msg.codes || null });
            return ok({ requeued: n });
        }

        case Req.CLEAR:
            if (msg.tabId != null) store.removeTab(msg.tabId);
            else store.clearAll();
            return ok({ cleared: true });

        case Req.GET_THUMBS:
            return getThumbs(msg.ids || []);

        case Req.PROBE:
            return probeRecords(msg.ids || []);

        case Req.OPEN_LIBRARY:
            await openLibrary();
            return ok({ opened: true });

        case Req.GET_SETTINGS:
            return ok(await getSettings());

        case Req.SET_SETTINGS: {
            const next = { ...(await getSettings()), ...(msg.settings || {}) };
            await chrome.storage.local.set({ [SETTINGS_KEY]: next });
            return ok(next);
        }

        case Req.GET_DIAGNOSTICS: {
            const recs = store.all();
            return ok(await diagnostics({
                records: recs.length,
                byKind: recs.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] || 0) + 1 }), {}),
                tabs: store.allTabFlags().map((t) => ({ ...t, pageUrl: undefined })),
                jobs: (await listJobs()).map(summarise),
            }));
        }

        default:
            return err(Fail.NO_TRANSPORT, `Unknown action: ${msg.action}`);
    }
}

/**
 * Generate real thumbnails. One fetch produces both the downscaled image and the
 * perceptual hash, so hashing costs no extra network — and it happens BEFORE the
 * full download, so dedup can actually save bandwidth rather than only disk.
 */
async function getThumbs(ids) {
    const out = {};
    const todo = ids.map((id) => store.get(id)).filter((r) => r && !r.thumb && r.kind === 'image');

    for (let i = 0; i < todo.length; i += 8) {
        const batch = todo.slice(i, i + 8);
        await Promise.all(batch.map(async (rec) => {
            const r = await callOffscreen(Off.MAKE_THUMB, {
                url: rec.url,
                headers: rec.pageUrl ? { Referer: rec.pageUrl } : undefined,
            });
            if (r?.ok) {
                rec.thumb = r.value.thumb;
                rec.width = r.value.width;
                rec.height = r.value.height;
                rec.bytes = r.value.bytes;          // real bytes, not a pixel estimate
                rec.mime = rec.mime || r.value.contentType;
                rec.pHash = r.value.pHash;
                store.upsert(rec);
                out[rec.id] = { thumb: r.value.thumb, width: r.value.width, height: r.value.height, bytes: r.value.bytes, pHash: r.value.pHash };
            } else {
                // Record the failure so we never re-request it forever, which is
                // what v1 did on every single re-render.
                rec.thumb = null;
                rec.thumbFailed = (rec.thumbFailed || 0) + 1;
                store.upsert(rec);
                out[rec.id] = { error: r?.message || 'thumbnail failed' };
            }
        }));
    }
    return ok(out);
}

/** Preflight: real sizes and content types before committing to a big job. */
async function probeRecords(ids) {
    const out = {};
    const recs = ids.map((id) => store.get(id)).filter(Boolean);
    const sample = recs.slice(0, 24);

    await Promise.all(sample.map(async (rec) => {
        const r = await callOffscreen(Off.PROBE_HEAD, {
            url: rec.url,
            headers: rec.pageUrl ? { Referer: rec.pageUrl } : undefined,
        });
        if (r?.ok) {
            rec.bytes = r.value.bytes ?? rec.bytes;
            rec.mime = r.value.contentType || rec.mime;
            rec.acceptsRanges = r.value.acceptsRanges;
            store.upsert(rec);
            out[rec.id] = r.value;
        } else {
            out[rec.id] = { error: r?.message, code: r?.code };
        }
    }));

    // The disaster case, surfaced before 400 error pages hit the disk.
    const htmlCount = Object.values(out).filter((v) => v.contentType?.includes('html')).length;
    return ok({
        probed: out,
        sampled: sample.length,
        of: recs.length,
        warning: htmlCount > sample.length / 2
            ? 'Most probes returned HTML, not media. This host is serving error pages — downloads will fail.'
            : null,
    });
}

async function openLibrary() {
    const url = chrome.runtime.getURL('src/ui/library/index.html');
    const existing = await chrome.tabs.query({ url });
    if (existing.length) {
        await chrome.tabs.update(existing[0].id, { active: true });
        await chrome.windows.update(existing[0].windowId, { focused: true });
    } else {
        await chrome.tabs.create({ url });
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

installNetworkDetection();

chrome.runtime.onStartup.addListener(async () => {
    await sweep();                 // clear any DNR rules orphaned by a crash
    await store.ensureReady();
    await resumeInterrupted();
});

chrome.runtime.onInstalled.addListener(async () => {
    await sweep();
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'mdl-image', title: 'Download this image', contexts: ['image'] });
        chrome.contextMenus.create({ id: 'mdl-video', title: 'Download this media', contexts: ['video', 'audio'] });
        chrome.contextMenus.create({ id: 'mdl-library', title: 'Open Media Library', contexts: ['action', 'page'] });
    });
    log('worker', 'installed');
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    await store.ensureReady();
    if (info.menuItemId === 'mdl-library') return openLibrary();

    const url = info.srcUrl;
    if (!url || !tab) return;

    const { makeRecord, addEvidence, EV } = await import('../shared/model.js');
    const { normalizeUrl } = await import('../shared/url.js');
    const key = normalizeUrl(url);
    // info.mediaType is 'image' | 'video' | 'audio' — the element the menu was
    // opened on. v2.0 mapped the shared video/audio menu item to 'video', so a
    // right-click on an <audio> element produced a record that could not pass
    // verification.
    const kind = info.mediaType === 'audio' ? 'audio'
        : info.mediaType === 'image' || info.menuItemId === 'mdl-image' ? 'image'
        : 'video';
    let rec = store.getByKey(tab.id, key);
    if (!rec) {
        rec = makeRecord({
            url, tabId: tab.id, pageUrl: info.pageUrl || tab.url, pageTitle: tab.title, kind,
        });
        addEvidence(rec, EV.DOM_ATTACHED, { sig: 'context-menu' });
        store.upsert(rec);
    } else if ((rec.kind === 'video' || rec.kind === 'audio') && (kind === 'video' || kind === 'audio') && rec.kind !== kind) {
        rec.kind = kind;
        store.upsert(rec);
    }
    const settings = await getSettings();
    await createJob({ recordIds: [rec.id], template: settings.template, jobName: 'Context menu' });
});

chrome.commands.onCommand.addListener(async (command) => {
    await store.ensureReady();
    if (command === 'open-library') return openLibrary();
    if (command === 'scan-current-tab') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) { await scanTab(tab.id); await openLibrary(); }
    }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    await store.ensureReady();
    store.refreshBadge(tabId);
});

log('worker', 'service worker loaded');
