/**
 * Persistent download queue.
 *
 * Every item's state lives in chrome.storage.local, so a job survives the popup
 * closing, the library tab closing, and the service worker being killed
 * mid-flight. v1 held everything in memory and had no notion of a job at all —
 * closing the popup silently abandoned the batch.
 *
 * The ledger is the point: when a 400-item job finishes you get a real accounting
 * of what landed and what didn't, grouped by cause, with a retry that changes
 * strategy rather than replaying the identical failing request.
 */

import { Fail, isOk, FAIL_TEXT } from '../shared/result.js';
import { log } from '../shared/log.js';
import { acquire } from './transport/ladder.js';
import { cancelOffscreen } from './offscreen-host.js';
import * as store from './store.js';

const JOBS_KEY = 'mdl:jobs';
const MAX_KEPT = 20;

let jobs = new Map();
let loaded = false;
let running = false;
const subscribers = new Set();

export function onJobEvent(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

function emit(type, payload) {
    for (const fn of subscribers) {
        try { fn(type, payload); } catch { /* ignore */ }
    }
}

async function load() {
    if (loaded) return;
    try {
        const g = await chrome.storage.local.get(JOBS_KEY);
        const arr = g?.[JOBS_KEY];
        if (Array.isArray(arr)) jobs = new Map(arr.map((j) => [j.id, j]));
    } catch { /* start empty */ }
    loaded = true;

    // Anything left "fetching" was interrupted by a worker death. Requeue it —
    // but keep its downloadId, so runItem re-attaches to the download Chrome is
    // (or was) still running rather than starting a second copy. v2.0 dropped
    // the id and re-downloaded, which is how " (1)" duplicates appeared.
    for (const job of jobs.values()) {
        let requeued = 0;
        for (const item of job.items) {
            if (item.state === 'fetching') { item.state = 'queued'; requeued++; }
        }
        if (requeued) log('jobs', `requeued ${requeued} interrupted items in ${job.id}`);
    }
}

let saveTimer = null;
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            const keep = [...jobs.values()]
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, MAX_KEPT);
            jobs = new Map(keep.map((j) => [j.id, j]));
            await chrome.storage.local.set({ [JOBS_KEY]: keep });
        } catch (e) {
            log('jobs', 'save failed', e?.message);
        }
    }, 300);
}

export async function createJob({ recordIds, template, jobName, concurrency = 4, preferHeight }) {
    await load();
    await store.ensureReady();

    const id = 'job_' + Date.now().toString(36);
    const items = recordIds
        .map((rid, i) => {
            const rec = store.get(rid);
            if (!rec) return null;
            return {
                recordId: rid,
                url: rec.url,
                kind: rec.kind,
                index: i + 1,
                state: 'queued',
                attempts: 0,
                bytes: null,
                path: null,
                extraPaths: [],
                notes: [],
                failCode: null,
                failMessage: null,
                hint: null,
                tier: null,
                downloadId: null,     // chrome.downloads id, persisted so a restart re-attaches
            };
        })
        .filter(Boolean);

    const job = {
        id,
        name: jobName || 'Download',
        template,
        concurrency,
        preferHeight,
        createdAt: Date.now(),
        finishedAt: null,
        cancelled: false,
        items,
    };
    jobs.set(id, job);
    save();
    emit('created', job);

    pump();
    return job;
}

export async function getJob(id) {
    await load();
    return jobs.get(id) || null;
}

export async function listJobs() {
    await load();
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function cancelJob(id) {
    await load();
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    for (const item of job.items) {
        if (item.state === 'queued') {
            item.state = 'failed';
            item.failCode = Fail.CANCELLED;
            item.failMessage = FAIL_TEXT[Fail.CANCELLED];
        } else if (item.state === 'fetching') {
            // Reach the work in flight. v2.0 only stopped the queue from advancing,
            // so a wrongly chosen 2 GB variant ran to completion after Cancel.
            cancelOffscreen(item.recordId).catch(() => {});
            if (item.downloadId != null) {
                try { chrome.downloads.cancel(item.downloadId).catch(() => {}); } catch { /* ignore */ }
            }
        }
    }
    save();
    emit('cancelled', job);
}

/**
 * Retry failed items. `strategy` changes HOW we retry rather than replaying the
 * identical request — a timeout gets a longer deadline, a 403 gets header
 * injection, a filename rejection gets a fallback template.
 */
export async function retryFailed(jobId, { codes = null } = {}) {
    await load();
    const job = jobs.get(jobId);
    if (!job) return null;

    let n = 0;
    for (const item of job.items) {
        if (item.state !== 'failed') continue;
        if (codes && !codes.includes(item.failCode)) continue;
        if (item.failCode === Fail.DRM_PROTECTED) continue;   // never going to work
        item.state = 'queued';
        item.failCode = null;
        item.failMessage = null;
        item.downloadId = null;
        n++;
    }
    job.cancelled = false;
    job.finishedAt = null;
    save();
    emit('retry', { job, count: n });
    pump();
    return n;
}

/** Drain the queue with bounded concurrency. Safe to call repeatedly. */
async function pump() {
    if (running) return;
    running = true;
    try {
        await load();
        // The detection store must be rehydrated before runItem() looks records up.
        // Without this, a queue resumed after a service-worker restart finds every
        // record undefined and fails the entire job.
        await store.ensureReady();
        for (;;) {
            const job = [...jobs.values()].find(
                (j) => !j.cancelled && j.items.some((i) => i.state === 'queued')
            );
            if (!job) break;

            const queued = job.items.filter((i) => i.state === 'queued');
            const lanes = Math.max(1, Math.min(job.concurrency, queued.length));
            let cursor = 0;

            await Promise.all(
                Array.from({ length: lanes }, async () => {
                    for (;;) {
                        if (job.cancelled) return;
                        const item = queued[cursor++];
                        if (!item) return;
                        await runItem(job, item);
                    }
                })
            );

            job.finishedAt = Date.now();
            save();
            emit('done', summarise(job));
        }
    } finally {
        running = false;
    }
}

async function runItem(job, item) {
    const rec = store.get(item.recordId);
    if (!rec) {
        item.state = 'failed';
        item.failCode = Fail.NO_TRANSPORT;
        item.failMessage = 'Record no longer exists';
        save();
        return;
    }

    item.state = 'fetching';
    item.attempts++;
    save();
    emit('progress', { jobId: job.id, recordId: item.recordId, state: 'fetching' });

    const result = await acquire(rec, {
        template: job.template,
        jobName: job.name,
        index: item.index,
        preferHeight: job.preferHeight,
        resumeDownloadId: item.downloadId,
        onDownloadStarted: (downloadId) => { item.downloadId = downloadId; save(); },
        onProgress: (p) => emit('progress', { jobId: job.id, recordId: item.recordId, ...p }),
    });

    if (isOk(result)) {
        item.state = 'done';
        item.bytes = result.value.size;
        item.path = result.value.path;
        item.extraPaths = result.value.extraPaths || [];
        item.notes = result.value.notes || [];
        item.tier = result.value.tier;
        rec.state = 'done';
        rec.savedPath = result.value.path;
        rec.bytes = result.value.size;
    } else {
        item.state = 'failed';
        item.failCode = result.code;
        item.failMessage = result.message;
        item.hint = result.meta?.hint || null;
        rec.state = 'failed';
        rec.failCode = result.code;
        rec.failMessage = result.message;
        log('jobs', `FAILED ${item.url.slice(0, 80)} — ${result.code}: ${result.message}`);
    }

    store.touch(item.recordId);
    save();
    emit('progress', { jobId: job.id, recordId: item.recordId, state: item.state });
}

/** The ledger view: counts plus failures grouped by cause. */
export function summarise(job) {
    const counts = { done: 0, failed: 0, queued: 0, fetching: 0 };
    const byCause = new Map();
    const notes = [];
    let bytes = 0;
    let files = 0;

    for (const item of job.items) {
        counts[item.state] = (counts[item.state] || 0) + 1;
        if (item.state === 'done') {
            bytes += item.bytes || 0;
            files += 1 + (item.extraPaths?.length || 0);
            for (const n of item.notes || []) {
                if (notes.length < 8) notes.push({ url: item.url, path: item.path, note: n });
            }
        }
        if (item.state === 'failed') {
            const c = item.failCode || 'unknown';
            if (!byCause.has(c)) {
                byCause.set(c, { code: c, text: FAIL_TEXT[c] || c, count: 0, hint: item.hint, samples: [] });
            }
            const g = byCause.get(c);
            g.count++;
            if (g.samples.length < 3) g.samples.push(item.url);
        }
    }

    return {
        jobId: job.id,
        name: job.name,
        total: job.items.length,
        counts,
        bytes,
        files,
        notes,
        finished: !!job.finishedAt,
        failures: [...byCause.values()].sort((a, b) => b.count - a.count),
    };
}

/** Called on worker startup — resume anything the last worker death interrupted. */
export async function resumeInterrupted() {
    await load();
    const pending = [...jobs.values()].some((j) => !j.cancelled && j.items.some((i) => i.state === 'queued'));
    if (pending) { log('jobs', 'resuming interrupted queue'); pump(); }
}
