/**
 * Download verification — the five checks.
 *
 * This module is the reason the rebuild exists. v1's downloadProgressiveVideo
 * returned {success: true} the instant chrome.downloads minted an ID
 * (background.js:687-692), before a single byte arrived. Its HTML-content check
 * was a fire-and-forget setTimeout whose result was discarded (background.js:673-685).
 * A 3 KB HTML error page on disk was reported to the user as "1 downloaded".
 *
 * chrome.downloads.DownloadItem exposes state, error, mime, finalUrl,
 * bytesReceived and totalBytes — but NO HTTP status code. So a 200-with-error-page
 * is indistinguishable from success at the API level. Verification is the only
 * defence there is.
 */

import { Fail, ok, err } from '../../shared/result.js';
import { sniff, agreesWith, isMediaMime } from '../../shared/mime.js';
import { log } from '../../shared/log.js';

/**
 * Minimum plausible size, per kind, used ONLY when no Content-Length was ever
 * observed for the resource. v2.0 hard-failed anything under 256 KB as video,
 * which rejected every short clip on every social site while classify.js was
 * documenting small media as "a ranking signal, never a filter". When the server
 * told us the size and the bytes on disk agree with it, the size is plausible by
 * definition; the floor is the fallback for the blind case, and it is now set
 * where an error page cannot reach rather than where a short clip can.
 */
const MIN_BYTES = { image: 2 * 1024, video: 32 * 1024, audio: 8 * 1024, stream: 32 * 1024 };

/** Does `size` agree with a Content-Length we saw earlier? (1% or 4 KB slack for range/redirect drift.) */
function agreesWithExpected(size, expectedBytes) {
    if (!expectedBytes || !Number.isFinite(expectedBytes)) return false;
    const slack = Math.max(4096, expectedBytes * 0.01);
    return Math.abs(size - expectedBytes) <= slack;
}

function plausibleSize(size, expectedKind, expectedBytes) {
    if (agreesWithExpected(size, expectedBytes)) return null;
    const floor = MIN_BYTES[expectedKind] ?? 1024;
    if (size < floor) {
        return err(Fail.IMPLAUSIBLE_SIZE,
            `Only ${size} bytes — too small to be ${expectedKind || 'media'}`, { size, floor });
    }
    return null;
}

/**
 * How often awaitDownload re-checks the item while waiting. downloads.onChanged
 * does NOT fire for byte progress, so a long Tier 1 download produces no event
 * for minutes; without an API call in that window the MV3 idle timer expires
 * and the worker dies with the promise. Each search() call resets the timer and
 * also recovers a state change whose event was missed.
 */
const KEEPALIVE_MS = 20 * 1000;

/**
 * Wait for a chrome.downloads item to reach a terminal state.
 * Resolves with the final DownloadItem, or an Err on interruption.
 */
export function awaitDownload(downloadId, { timeoutMs = 30 * 60 * 1000 } = {}) {
    return new Promise((resolve) => {
        let done = false;

        const finish = (result) => {
            if (done) return;
            done = true;
            chrome.downloads.onChanged.removeListener(onChanged);
            clearTimeout(timer);
            clearInterval(keepalive);
            resolve(result);
        };

        const timer = setTimeout(() => finish(err(Fail.TIMEOUT, 'Download did not complete in time')), timeoutMs);
        const keepalive = setInterval(() => { settle().catch(() => {}); }, KEEPALIVE_MS);

        async function settle() {
            const [item] = await chrome.downloads.search({ id: downloadId });
            if (!item) return finish(err(Fail.DOWNLOAD_INTERRUPTED, 'Download record vanished'));
            if (item.state === 'complete') return finish(ok(item));
            if (item.state === 'interrupted') {
                const reason = item.error || 'UNKNOWN';
                const code = reason.includes('DISK_FULL') ? Fail.DISK_FULL
                    : reason.includes('FILE_NAME') || reason.includes('FILE_TOO_SHORT') ? Fail.FILENAME_REJECTED
                    : reason.includes('NETWORK') ? Fail.NETWORK
                    : reason.includes('SERVER_FORBIDDEN') ? Fail.HTTP_403
                    : reason.includes('SERVER_UNAUTHORIZED') ? Fail.HTTP_401
                    : Fail.DOWNLOAD_INTERRUPTED;
                return finish(err(code, `Interrupted: ${reason}`, { reason }));
            }
        }

        function onChanged(delta) {
            if (delta.id !== downloadId) return;
            if (delta.state || delta.error) settle();
        }

        chrome.downloads.onChanged.addListener(onChanged);
        // The download may already be finished before we attached the listener.
        settle();
    });
}

/**
 * Verify a completed DownloadItem really is the media we asked for.
 *
 * Checks 1-4 run against the DownloadItem. Check 5 (magic bytes) needs the actual
 * content; the caller supplies `headBytes` when it has them (the offscreen tier
 * always does, because it holds the bytes anyway).
 */
export function verifyItem(item, { expectedKind, expectedOrigin, expectedBytes = null, headBytes = null } = {}) {
    // 1. Terminal state
    if (item.state !== 'complete') {
        return err(Fail.DOWNLOAD_INTERRUPTED, `state=${item.state}`);
    }

    // 2. MIME is not an error document
    const mime = String(item.mime || '').toLowerCase();
    if (mime.includes('text/html') || mime.includes('application/xhtml')) {
        return err(Fail.HTML_RESPONSE, 'Server returned an HTML page instead of media');
    }
    if (mime.includes('application/json') || mime.startsWith('text/plain')) {
        return err(Fail.MIME_MISMATCH, `Unexpected content type: ${item.mime}`);
    }

    // 3. Plausible size
    const size = item.fileSize || item.totalBytes || item.bytesReceived || 0;
    if (size === 0) return err(Fail.ZERO_BYTES, 'Downloaded 0 bytes');
    const sizeProblem = plausibleSize(size, expectedKind, expectedBytes);
    if (sizeProblem) return sizeProblem;

    // 4. Did not get redirected somewhere else entirely (login walls, interstitials).
    //    A cross-origin redirect is how most video CDNs work, so it only counts
    //    against the file when what came back is not media. The text/html check
    //    above already catches the login-wall case.
    if (expectedOrigin && item.finalUrl && !isMediaMime(item.mime)) {
        try {
            const got = new URL(item.finalUrl).origin;
            if (got !== expectedOrigin) {
                return err(Fail.REDIRECTED_AWAY,
                    `Redirected from ${expectedOrigin} to ${got}`, { finalUrl: item.finalUrl });
            }
        } catch { /* unparseable finalUrl is not itself a failure */ }
    }

    // 5. The bytes are what they claim to be
    if (headBytes && headBytes.length >= 4) {
        const s = sniff(headBytes);
        if (s && s.kind === 'notmedia') {
            return err(Fail.HTML_RESPONSE, `File contents are ${s.mime}, not media`);
        }
        if (!agreesWith(s, expectedKind)) {
            return err(Fail.WRONG_MAGIC,
                `File contents look like ${s?.mime || 'unknown'}, expected ${expectedKind}`);
        }
    }

    log('verify', `ok id=${item.id} size=${size} mime=${item.mime || '?'}`);
    return ok({ size, mime: item.mime, path: item.filename, finalUrl: item.finalUrl });
}

/**
 * Verify a transfer we performed ourselves, given only the leading bytes plus the
 * true total size.
 *
 * The offscreen document holds the whole body but ships back just the head —
 * transferring a multi-hundred-MB Uint8Array through sendMessage would be absurd.
 * So size and content are checked from separate inputs: `size` is authoritative
 * for the plausibility check, `headBytes` for the magic-byte check.
 */
export function verifyHead(headBytes, size, { expectedKind, expectedBytes = null, contentType = '' } = {}) {
    if (!size) return err(Fail.ZERO_BYTES, 'Empty response body');

    const ct = String(contentType).toLowerCase();
    if (ct.includes('text/html')) {
        return err(Fail.HTML_RESPONSE, 'Server returned an HTML page instead of media');
    }

    const sizeProblem = plausibleSize(size, expectedKind, expectedBytes);
    if (sizeProblem) return sizeProblem;

    if (headBytes && headBytes.length >= 4) {
        const s = sniff(headBytes);
        if (s && s.kind === 'notmedia') {
            return err(Fail.HTML_RESPONSE, `Content is ${s.mime}, not media`);
        }
        if (!agreesWith(s, expectedKind)) {
            return err(Fail.WRONG_MAGIC,
                `Content looks like ${s?.mime || 'unknown'}, expected ${expectedKind}`);
        }
    }

    return ok({ size, sniffed: sniff(headBytes || new Uint8Array()) });
}

/**
 * Verify bytes we hold in full. Strictly stronger than verifyItem because we can
 * always sniff.
 */
export function verifyBytes(bytes, { expectedKind, expectedBytes = null, status = 200, contentType = '' } = {}) {
    if (!bytes || bytes.length === 0) return err(Fail.ZERO_BYTES, 'Empty response body');

    const ct = String(contentType).toLowerCase();
    if (ct.includes('text/html')) {
        return err(Fail.HTML_RESPONSE, 'Server returned an HTML page instead of media');
    }

    const sizeProblem = plausibleSize(bytes.length, expectedKind, expectedBytes);
    if (sizeProblem) return sizeProblem;

    const s = sniff(bytes.subarray(0, 256));
    if (s && s.kind === 'notmedia') {
        return err(Fail.HTML_RESPONSE, `Content is ${s.mime}, not media`);
    }
    if (!agreesWith(s, expectedKind)) {
        return err(Fail.WRONG_MAGIC,
            `Content looks like ${s?.mime || 'unknown'}, expected ${expectedKind}`);
    }

    return ok({ size: bytes.length, sniffed: s, status });
}
