/**
 * The byte mover. Runs in the offscreen document (extension origin, host
 * permissions apply, no CORS check).
 *
 * Capabilities v1 had nowhere: range-parallel transfer, bounded concurrency,
 * per-attempt retry with backoff, Retry-After handling, cancellation, and
 * progress that is actually reported rather than dropped into a debugLog.
 */

import { Fail, ok, err, failFromStatus } from '../shared/result.js';

const DEFAULT_TIMEOUT = 45_000;

/** In-flight jobs, so CANCEL can abort them. */
const inflight = new Map();

export function cancel(jobId) {
    const c = inflight.get(jobId);
    if (c) c.abort();
}

/**
 * Register a controller for a multi-request job (HLS assembly) so CANCEL reaches
 * every segment fetch, not just the request that happened to carry the jobId.
 * Returns an unregister function.
 */
export function track(jobId, ctl) {
    if (!jobId) return () => {};
    inflight.set(jobId, ctl);
    return () => { if (inflight.get(jobId) === ctl) inflight.delete(jobId); };
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
}

/**
 * One fetch attempt with a deadline. Returns the Response or throws.
 */
async function fetchOnce(url, { headers, signal, timeoutMs = DEFAULT_TIMEOUT, method = 'GET' }) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method,
            headers,
            signal: ctl.signal,
            credentials: 'include',   // extension-origin request; host perms apply
            redirect: 'follow',
        });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Fetch with retry/backoff. Honours Retry-After on 429/503.
 * @returns {Promise<{ok: true, value: Response}|{ok: false, code: string, message: string}>}
 */
export async function fetchWithRetry(url, { headers, signal, attempts = 3, timeoutMs } = {}) {
    let lastCode = Fail.NETWORK;
    let lastMsg = 'unknown';

    for (let i = 0; i < attempts; i++) {
        if (signal?.aborted) return err(Fail.CANCELLED, 'Cancelled');
        try {
            const res = await fetchOnce(url, { headers, signal, timeoutMs });

            if (res.ok || res.status === 206) return ok(res);

            lastCode = failFromStatus(res.status);
            lastMsg = `HTTP ${res.status}`;

            // 4xx other than 408/429 will not improve on retry.
            if (res.status < 500 && res.status !== 408 && res.status !== 429) {
                return err(lastCode, lastMsg, { status: res.status });
            }

            const ra = res.headers.get('retry-after');
            const waitMs = ra && /^\d+$/.test(ra)
                ? Math.min(parseInt(ra, 10) * 1000, 30_000)
                : Math.min(500 * 2 ** i, 8000);
            await sleep(waitMs, signal);
        } catch (e) {
            if (e?.name === 'AbortError') {
                lastCode = signal?.aborted ? Fail.CANCELLED : Fail.TIMEOUT;
                lastMsg = signal?.aborted ? 'Cancelled' : 'Request timed out';
                if (lastCode === Fail.CANCELLED) return err(lastCode, lastMsg);
            } else {
                lastCode = Fail.NETWORK;
                lastMsg = e?.message || 'Network error';
            }
            if (i < attempts - 1) await sleep(Math.min(500 * 2 ** i, 8000), signal);
        }
    }
    return err(lastCode, lastMsg);
}

/** HEAD, falling back to a 1-byte Range GET for servers that refuse HEAD. */
export async function probe(url, { headers, signal } = {}) {
    let res = null;
    try {
        res = await fetchOnce(url, { headers, signal, method: 'HEAD', timeoutMs: 15_000 });
    } catch { /* fall through */ }

    if (!res || !res.ok) {
        const r = await fetchWithRetry(url, {
            headers: { ...(headers || {}), Range: 'bytes=0-0' },
            signal, attempts: 2, timeoutMs: 15_000,
        });
        if (!r.ok) return r;
        res = r.value;
    }

    const contentType = res.headers.get('content-type') || '';
    const cr = res.headers.get('content-range');
    let bytes = null;
    if (cr) {
        const m = cr.match(/\/(\d+)\s*$/);
        if (m) bytes = parseInt(m[1], 10);
    } else {
        const cl = res.headers.get('content-length');
        if (cl) bytes = parseInt(cl, 10);
    }

    // Don't leave a Range GET body streaming.
    try { res.body?.cancel(); } catch { /* ignore */ }

    return ok({
        contentType: contentType.split(';')[0].trim(),
        bytes: Number.isFinite(bytes) ? bytes : null,
        acceptsRanges: (res.headers.get('accept-ranges') || '').includes('bytes') || !!cr,
        status: res.status,
        finalUrl: res.url,
    });
}

/**
 * Download a whole resource into memory, reporting progress.
 *
 * Used for images and for anything we must inspect before writing. Large video
 * goes through chrome.downloads (Tier 1) or segment assembly instead — never
 * build a multi-GB Blob.
 */
export async function fetchBytes(url, { headers, jobId, onProgress, signal, expectBytes, maxBytes = 0 } = {}) {
    const ctl = new AbortController();
    if (jobId && !signal) inflight.set(jobId, ctl);
    const sig = signal || ctl.signal;

    try {
        const r = await fetchWithRetry(url, { headers, signal: sig });
        if (!r.ok) return r;
        const res = r.value;

        const declared = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        const total = expectBytes || declared;
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();

        // This tier holds the whole body in memory (chunks, then a copy, then a
        // Blob). Refuse up front when the server tells us it will not fit, and
        // bail mid-stream when it lied.
        if (maxBytes && declared > maxBytes) {
            try { res.body?.cancel(); } catch { /* ignore */ }
            return err(Fail.TOO_LARGE, `${declared} bytes exceeds the in-memory limit of ${maxBytes}`);
        }

        if (!res.body) {
            const buf = new Uint8Array(await res.arrayBuffer());
            return ok({ bytes: buf, contentType, status: res.status, finalUrl: res.url });
        }

        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        let lastTick = 0;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (maxBytes && received > maxBytes) {
                try { await reader.cancel(); } catch { /* ignore */ }
                return err(Fail.TOO_LARGE, `Body exceeded the in-memory limit of ${maxBytes} bytes`);
            }
            const now = Date.now();
            if (onProgress && now - lastTick > 120) {
                lastTick = now;
                onProgress({ received, total });
            }
        }

        const out = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        onProgress?.({ received, total: total || received });

        return ok({ bytes: out, contentType, status: res.status, finalUrl: res.url });
    } finally {
        if (jobId && inflight.get(jobId) === ctl) inflight.delete(jobId);
    }
}

/**
 * Bounded-concurrency map. Used for segments and thumbnail batches.
 * v1 downloaded HLS segments in a strictly serial for-loop and images serially
 * with a fixed 500ms sleep between each.
 */
export async function pool(items, worker, { concurrency = 6, signal } = {}) {
    const results = new Array(items.length);
    let cursor = 0;

    async function lane() {
        for (;;) {
            if (signal?.aborted) return;
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await worker(items[i], i);
            } catch (e) {
                results[i] = err(Fail.NETWORK, e?.message || 'worker threw');
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, lane)
    );
    return results;
}
