/**
 * Offscreen document lifecycle + request/response plumbing.
 *
 * Chrome permits exactly one offscreen document per profile, so this module owns
 * it: creation is serialised behind a single promise (concurrent callers would
 * otherwise race and one would throw), and progress events are routed back to
 * whichever job is waiting on them.
 */

import { Off, OffEvt } from '../shared/protocol.js';
import { Fail, err, ok } from '../shared/result.js';
import { log } from '../shared/log.js';

const PATH = 'src/offscreen/index.html';

let creating = null;
const progressHandlers = new Map();   // jobId -> fn

export async function ensureOffscreen() {
    try {
        const existing = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(PATH)],
        });
        if (existing && existing.length) return true;
    } catch {
        // getContexts is Chrome 116+. If it's missing we fall through and let
        // createDocument throw its "already exists" error, which we swallow.
    }

    if (creating) { await creating; return true; }

    creating = chrome.offscreen.createDocument({
        url: PATH,
        reasons: ['BLOBS', 'DOM_PARSER'],
        justification:
            'Fetch media bytes from an extension-privileged context, assemble HLS segments, ' +
            'decrypt AES-128, and generate thumbnails — none of which a service worker can do.',
    }).catch((e) => {
        if (!/already/i.test(e?.message || '')) throw e;
    });

    try {
        await creating;
        return true;
    } finally {
        creating = null;
    }
}

/**
 * Send a request to the offscreen document and await its Result.
 * @param {string} action one of Off.*
 * @param {object} data
 * @param {{onProgress?: Function}} opts
 */
export async function callOffscreen(action, data, { onProgress } = {}) {
    try {
        await ensureOffscreen();
    } catch (e) {
        return err(Fail.OFFSCREEN_UNAVAILABLE, e?.message || 'Could not create offscreen document');
    }

    if (onProgress && data?.jobId) progressHandlers.set(data.jobId, onProgress);

    try {
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', action, data });
        if (!res) return err(Fail.OFFSCREEN_UNAVAILABLE, 'No response from offscreen document');
        return res;
    } catch (e) {
        return err(Fail.OFFSCREEN_UNAVAILABLE, e?.message || 'Offscreen message failed');
    } finally {
        if (data?.jobId) progressHandlers.delete(data.jobId);
    }
}

export function cancelOffscreen(jobId) {
    return callOffscreen(Off.CANCEL, { jobId });
}

/** Called by the worker's message router for OffEvt.* messages. */
export function handleOffscreenEvent(msg) {
    if (msg.action === OffEvt.PROGRESS) {
        const fn = progressHandlers.get(msg.data?.jobId);
        if (fn) { try { fn(msg.data); } catch { /* ignore */ } }
        return true;
    }
    if (msg.action === OffEvt.LOG) {
        log('offscreen', msg.data?.message || '');
        return true;
    }
    return false;
}
