/**
 * The transport ladder.
 *
 * Tier 1  chrome.downloads.download({url})   — zero memory, streams to disk,
 *                                              carries all cookies for the host
 * Tier 2  offscreen fetch -> blob -> downloads — extension origin, no CORS,
 *                                              header injection (via DNR, see
 *                                              headers.js), full verification
 * Tier 2s offscreen HLS assembly
 * Tier 3  native messaging -> yt-dlp/ffmpeg    — seam only; not implemented
 *
 * We start at the cheapest rung that can work and escalate ONLY on verified
 * failure. Per-origin memory records which rung won, so the second visit to a
 * host skips the rungs that failed the first time.
 *
 * v2.1 changes worth knowing when reading this file:
 *  - Both tiers run inside withRefererRule. fetch() cannot set Referer/Origin
 *    (forbidden header names), so passing them as fetch headers was a no-op.
 *  - A Tier 1 download that fails verification is removed from disk before we
 *    escalate; v2.0 left it there and then saved the Tier 2 copy as " (1)".
 *  - Tier 1 hands back its downloadId as soon as it has one so the job can
 *    persist it and re-attach after a worker restart instead of re-downloading.
 *  - Tier 2 refuses bodies over MAX_TIER2_BYTES with a named failure instead of
 *    growing the offscreen document until it dies.
 *  - Blob URLs are released once chrome.downloads has consumed them.
 *  - Stream assemblies are serialised: one at a time. The broad Referer rule a
 *    stream needs (segment hosts are unknown up front) would otherwise collide
 *    between concurrent jobs, and one assembled video in memory at a time is a
 *    ceiling this tier needs anyway.
 */

import { Fail, ok, err, isOk, shouldEscalate, FAIL_TEXT } from '../../shared/result.js';
import { log } from '../../shared/log.js';
import { renderTemplate, stemFromUrl, siteOf, shortHash, sanitizeSegment } from '../../shared/url.js';
import { extForMime } from '../../shared/mime.js';
import { Off } from '../../shared/protocol.js';
import { awaitDownload, verifyItem, verifyHead } from './verify.js';
import { withRefererRule } from './headers.js';
import { callOffscreen } from '../offscreen-host.js';

const MEMORY_KEY = 'mdl:strategy';

/** Largest body the in-memory tier will hold. Above this the answer is Tier 3, not a bigger Blob. */
export const MAX_TIER2_BYTES = 1024 * 1024 * 1024;

async function loadMemory() {
    try {
        const g = await chrome.storage.local.get(MEMORY_KEY);
        return g?.[MEMORY_KEY] || {};
    } catch { return {}; }
}

async function rememberWinner(origin, tier) {
    try {
        const mem = await loadMemory();
        if (mem[origin] === tier) return;
        mem[origin] = tier;
        await chrome.storage.local.set({ [MEMORY_KEY]: mem });
        log('ladder', `origin ${origin} -> tier ${tier}`);
    } catch { /* memory is an optimisation, never required */ }
}

function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
}

/** Playlist filenames that say nothing about the content. */
const GENERIC_STEM = /^(master|index|playlist|manifest|prog_index|chunklist|media|stream|video|audio|main|hls|live|out|play|\d+)$/i;

/**
 * Compute the output path for a record.
 */
export function outputPath(rec, { template, jobName, index } = {}) {
    const ext =
        extForMime(rec.mime) ||
        (rec.kind === 'stream' ? 'mp4' : null) ||
        guessExtFromUrl(rec.url) ||
        (rec.kind === 'image' ? 'jpg' : rec.kind === 'audio' ? 'm4a' : 'mp4');

    let stem = stemFromUrl(rec.url);
    // Every HLS stream is called master.m3u8 or index.m3u8; the page title is the
    // only name that distinguishes them. Streams only — image and file stems are
    // real names and stay as they are.
    if (rec.kind === 'stream' && GENERIC_STEM.test(stem) && rec.pageTitle) {
        const t = sanitizeSegment(rec.pageTitle, '').slice(0, 80).trim();
        if (t) stem = t;
    }

    return renderTemplate(template, {
        site: siteOf(rec.pageUrl || rec.url),
        host: (() => { try { return new URL(rec.url).hostname; } catch { return 'unknown'; } })(),
        pageTitle: rec.pageTitle,
        jobName,
        stem,
        ext,
        width: rec.width,
        height: rec.height,
        hash: shortHash(rec.key),
        index,
    });
}

function guessExtFromUrl(url) {
    const m = String(url).match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Download one record, escalating tiers until one produces a VERIFIED file.
 *
 * @param {object} rec
 * @param {object} opts
 *   template, jobName, index, onProgress, preferHeight,
 *   resumeDownloadId  — a chrome.downloads id persisted by a previous worker
 *                       incarnation; re-attach to it instead of downloading again
 *   onDownloadStarted — called with the downloadId as soon as Tier 1 has one
 * @returns {Promise<Ok|Err>} ok({path, size, tier, notes?, extraPaths?}) or err(code, message)
 */
export async function acquire(rec, opts = {}) {
    const { template, jobName, index, onProgress, preferHeight, resumeDownloadId, onDownloadStarted } = opts;
    const filename = outputPath(rec, { template, jobName, index });
    const origin = originOf(rec.url);
    const attempts = [];

    if (rec.isDRM) {
        return err(Fail.DRM_PROTECTED,
            `DRM protected (${rec.drmSystem || 'unknown'}) — cannot be downloaded`);
    }

    // Streams never go through Tier 1 — there is no single URL to hand the
    // browser. They start at the assembly tier.
    const startTier = rec.kind === 'stream' ? 2 : (await loadMemory())[origin] || 1;

    // ---- Tier 1: browser-native ----
    if ((startTier <= 1 || resumeDownloadId) && rec.kind !== 'stream') {
        onProgress?.({ phase: 'tier1' });
        const r = await tier1(rec, filename, { resumeDownloadId, onDownloadStarted });
        attempts.push({ tier: 1, ...(isOk(r) ? { ok: true } : { code: r.code, message: r.message }) });
        if (isOk(r)) {
            await rememberWinner(origin, 1);
            return ok({ ...r.value, tier: 1, attempts });
        }
        if (!shouldEscalate(r.code)) return { ...r, meta: { ...(r.meta || {}), attempts } };
        log('ladder', `tier1 failed (${r.code}), escalating`);
    }

    // ---- Tier 2: offscreen fetch, header injection, full verification ----
    if (rec.kind !== 'stream' && rec.bytes && rec.bytes > MAX_TIER2_BYTES) {
        return err(Fail.TOO_LARGE,
            `${rec.bytes} bytes is beyond the in-memory tier (${MAX_TIER2_BYTES})`,
            { attempts, hint: nextStepHint(Fail.TOO_LARGE) });
    }

    onProgress?.({ phase: 'tier2' });
    const r2 = rec.kind === 'stream'
        ? await withStreamLock(() => tier2Stream(rec, filename, { onProgress, preferHeight }))
        : await tier2(rec, filename, { onProgress });

    attempts.push({ tier: 2, ...(isOk(r2) ? { ok: true } : { code: r2.code, message: r2.message }) });
    if (isOk(r2)) {
        await rememberWinner(origin, 2);
        return ok({ ...r2.value, tier: 2, attempts });
    }

    // ---- Tier 3: native host. Seam only — see proposal Q2. ----
    return err(r2.code, r2.message, {
        ...(r2.meta || {}),
        attempts,
        hint: nextStepHint(r2.code),
    });
}

function nextStepHint(code) {
    switch (code) {
        case Fail.HTTP_403:
        case Fail.HTTP_401:
            return 'The server rejected the request even with Referer and cookies. This host likely needs a native yt-dlp helper (proposal Q2).';
        case Fail.HTML_RESPONSE:
        case Fail.WRONG_MAGIC:
            return 'The URL returns a page, not media. The real media URL is probably delivered via MSE — try playing the video first, then rescan.';
        case Fail.DRM_PROTECTED:
            return 'Protected content. Not supported and not planned.';
        case Fail.TOO_LARGE:
            return 'Too large to assemble in memory. This is what the native helper tier (Tier 3) is for.';
        case Fail.SEGMENT_FAILED:
            return 'A segment returned an error body. Signed segment URLs expire quickly — replay the video and rescan, then retry promptly.';
        default:
            return FAIL_TEXT[code] || null;
    }
}

// ---------------------------------------------------------------------------
// Blob release — after chrome.downloads has consumed an offscreen blob URL
// ---------------------------------------------------------------------------

async function release(...blobUrls) {
    const list = blobUrls.filter(Boolean);
    if (!list.length) return;
    try { await callOffscreen(Off.RELEASE, { blobUrls: list }); } catch { /* best effort */ }
}

/** Save an offscreen blob via chrome.downloads and wait for it. Always releases the blob. */
async function saveBlob(blobUrl, filename) {
    try {
        let downloadId;
        try {
            downloadId = await chrome.downloads.download({
                url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false,
            });
        } catch (e) {
            return err(Fail.FILENAME_REJECTED, e?.message || 'Could not write file');
        }
        const settled = await awaitDownload(downloadId);
        if (!isOk(settled)) return settled;
        return ok({ path: settled.value.filename, downloadId });
    } finally {
        await release(blobUrl);
    }
}

// ---------------------------------------------------------------------------
// Tier 1 — chrome.downloads
// ---------------------------------------------------------------------------

/** Remove a completed-but-rejected file so the disk does not fill with error pages and duplicates. */
async function discard(downloadId) {
    try { await chrome.downloads.removeFile(downloadId); } catch { /* may already be gone */ }
    try { await chrome.downloads.erase({ id: downloadId }); } catch { /* best effort */ }
}

async function tier1(rec, filename, { resumeDownloadId, onDownloadStarted } = {}) {
    // Re-attach to a download a previous worker incarnation started. If Chrome no
    // longer knows it, fall through to a fresh download.
    if (resumeDownloadId != null) {
        try {
            const [item] = await chrome.downloads.search({ id: resumeDownloadId });
            if (item) {
                log('ladder', `re-attaching to download ${resumeDownloadId} (${item.state})`);
                const settled = await awaitDownload(resumeDownloadId);
                if (!isOk(settled)) return settled;
                const v = verifyItem(settled.value, {
                    expectedKind: rec.kind, expectedOrigin: originOf(rec.url), expectedBytes: rec.bytes,
                });
                if (!isOk(v)) await discard(resumeDownloadId);
                return v;
            }
        } catch { /* fall through */ }
    }

    return withRefererRule({ url: rec.url, pageUrl: rec.pageUrl }, async () => {
        let downloadId;
        try {
            downloadId = await chrome.downloads.download({
                url: rec.url,
                filename,
                conflictAction: 'uniquify',
                saveAs: false,
            });
        } catch (e) {
            const msg = e?.message || String(e);
            return err(/filename/i.test(msg) ? Fail.FILENAME_REJECTED : Fail.NETWORK, msg);
        }
        try { onDownloadStarted?.(downloadId); } catch { /* ignore */ }

        // Actually wait for it, instead of declaring victory on the ID.
        const settled = await awaitDownload(downloadId);
        if (!isOk(settled)) return settled;

        const v = verifyItem(settled.value, {
            expectedKind: rec.kind,
            expectedOrigin: originOf(rec.url),
            expectedBytes: rec.bytes,
        });
        if (!isOk(v)) {
            // The file completed but is not what we asked for. Leaving it means an
            // error page called video.mp4 in Downloads and a " (1)" copy from Tier 2.
            await discard(downloadId);
        }
        return v;
    });
}

// ---------------------------------------------------------------------------
// Tier 2 — offscreen fetch
// ---------------------------------------------------------------------------

async function tier2(rec, filename, { onProgress }) {
    const jobId = rec.id;

    // The Referer/Origin rule is the only way these headers get set; fetch()
    // drops them silently. Passing them as fetch headers (v2.0) did nothing.
    const r = await withRefererRule({ url: rec.url, pageUrl: rec.pageUrl }, () =>
        callOffscreen(Off.FETCH_BYTES, {
            jobId, url: rec.url, mime: rec.mime, expectBytes: rec.bytes, maxBytes: MAX_TIER2_BYTES,
        }, { onProgress })
    );
    if (!isOk(r)) return r;

    const { blobUrl, size, contentType, head } = r.value;
    const headBytes = new Uint8Array(head || []);

    // Verify BEFORE writing anything to disk. Size and content come from separate
    // inputs because we only shipped the head back across the message boundary.
    const v = verifyHead(headBytes, size, { expectedKind: rec.kind, expectedBytes: rec.bytes, contentType });
    if (!isOk(v)) { await release(blobUrl); return v; }

    const saved = await saveBlob(blobUrl, filename);
    if (!isOk(saved)) return saved;
    return ok({ size, path: saved.value.path, mime: contentType });
}

// ---------------------------------------------------------------------------
// Tier 2s — HLS assembly (one at a time)
// ---------------------------------------------------------------------------

let streamLock = Promise.resolve();
function withStreamLock(fn) {
    const run = streamLock.then(fn, fn);
    streamLock = run.then(() => {}, () => {});
    return run;
}

function withExt(filename, ext) {
    return filename.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
}

async function tier2Stream(rec, filename, { onProgress, preferHeight }) {
    // Segment hosts are unknown until the playlists are parsed and are often not
    // the manifest host, so the rule cannot be URL-anchored; it is scoped to
    // requests with no tab (ours) for the duration of this one assembly.
    const r = await withRefererRule({ url: rec.url, pageUrl: rec.pageUrl, broad: true }, () =>
        callOffscreen(Off.HLS_DOWNLOAD, {
            jobId: rec.id, url: rec.url, preferHeight, mime: null,
        }, { onProgress })
    );
    if (!isOk(r)) return r;

    const { blobUrl, size, container, segments, head, audioOnly, audio, notes = [] } = r.value;

    // Streams assemble to .ts unless the playlist had an EXT-X-MAP init segment
    // (fMP4) or the segments were packed audio (ADTS / ID3-wrapped AAC).
    const mainExt = container === 'mp4' ? (audioOnly ? 'm4a' : 'mp4')
        : (container === 'aac' || container === 'id3') ? 'aac'
        : 'ts';
    const finalName = withExt(filename, mainExt);

    const v = verifyHead(new Uint8Array(head || []), size, { expectedKind: 'stream' });
    if (!isOk(v)) { await release(blobUrl, audio?.blobUrl); return v; }

    const saved = await saveBlob(blobUrl, finalName);
    if (!isOk(saved)) { await release(audio?.blobUrl); return saved; }

    const extraPaths = [];
    if (audio?.blobUrl) {
        const audioName = withExt(filename, 'audio.' + (audio.container === 'mp4' ? 'm4a' : audio.container === 'ts' ? 'ts' : 'aac'));
        const a = await saveBlob(audio.blobUrl, audioName);
        if (!isOk(a)) {
            return err(a.code, `Video saved to ${saved.value.path}, but the separate audio track could not be written: ${a.message}`,
                { path: saved.value.path });
        }
        extraPaths.push(a.value.path);
    }

    return ok({
        size: size + (audio?.size || 0),
        path: saved.value.path,
        segments,
        extraPaths,
        notes,
    });
}
