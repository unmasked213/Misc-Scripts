/**
 * Offscreen document entry point.
 *
 * Handles every request that needs a real DOM context: byte fetching, HLS
 * assembly, AES decryption, thumbnail generation. Reports progress back to the
 * worker over runtime messages so the UI can show something truthful.
 */

import { Off, OffEvt } from '../shared/protocol.js';
import { Fail, ok, err, isOk } from '../shared/result.js';
import { sniffSegment } from '../shared/mime.js';
import { fetchBytes, probe, pool, fetchWithRetry, cancel, track } from './fetcher.js';
import { parse, pickVariant, pickAudioRendition, codecsHaveVideo, codecsHaveAudio, ivFor, decryptSegment } from './hls.js';

/** Bytes we send back for magic-byte checks. MPEG-TS needs 189 to confirm the second sync byte. */
const HEAD_BYTES = 256;

function post(action, data) {
    chrome.runtime.sendMessage({ target: 'worker', action, data }).catch(() => {});
}

function progress(jobId, payload) {
    post(OffEvt.PROGRESS, { jobId, ...payload });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return false;

    handle(msg)
        .then(sendResponse)
        .catch((e) => sendResponse(err(Fail.NETWORK, e?.message || 'offscreen handler threw')));

    return true;   // async
});

async function handle(msg) {
    const d = msg.data || {};
    switch (msg.action) {
        case Off.PROBE_HEAD:
            return probe(d.url, { headers: d.headers });

        case Off.FETCH_BYTES: {
            const r = await fetchBytes(d.url, {
                headers: d.headers,
                jobId: d.jobId,
                expectBytes: d.expectBytes,
                maxBytes: d.maxBytes || 0,
                onProgress: (p) => progress(d.jobId, p),
            });
            if (!isOk(r)) return r;
            // Transferring a large Uint8Array through sendMessage is expensive;
            // hand back a blob URL the worker can pass to chrome.downloads.
            const blob = new Blob([r.value.bytes], { type: d.mime || r.value.contentType || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            return ok({
                blobUrl: url,
                size: r.value.bytes.length,
                contentType: r.value.contentType,
                head: Array.from(r.value.bytes.subarray(0, HEAD_BYTES)),   // for magic-byte verification
                finalUrl: r.value.finalUrl,
            });
        }

        case Off.HLS_DOWNLOAD:
            return downloadHls(d);

        case Off.MAKE_THUMB:
            return makeThumb(d);

        case Off.CANCEL:
            cancel(d.jobId);
            return ok({ cancelled: true });

        case Off.RELEASE: {
            // The worker calls this once chrome.downloads has finished with the
            // blob. Until v2.1 nothing ever revoked these, so every completed
            // download stayed resident in this document for the session.
            let n = 0;
            for (const u of d.blobUrls || []) {
                try { URL.revokeObjectURL(u); n++; } catch { /* already gone */ }
            }
            return ok({ released: n });
        }

        default:
            return err(Fail.NO_TRANSPORT, `Unknown offscreen action: ${msg.action}`);
    }
}

// ---------------------------------------------------------------------------
// HLS
// ---------------------------------------------------------------------------

async function fetchText(url, headers, signal) {
    const r = await fetchWithRetry(url, { headers, signal });
    if (!isOk(r)) return r;
    const ct = (r.value.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
        return err(Fail.MANIFEST_PARSE, 'Playlist URL returned an HTML page — expired or login-walled');
    }
    return ok({ text: await r.value.text(), finalUrl: r.value.url });
}

/** Segment verification: the expired-token case is 200 + HTML per segment. */
function checkSegment(bytes, contentType, index) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('application/json')) {
        return err(Fail.SEGMENT_FAILED, `Segment ${index + 1} is ${ct.split(';')[0]}, not media`);
    }
    const kind = sniffSegment(bytes);
    if (kind === 'notmedia') {
        return err(Fail.SEGMENT_FAILED, `Segment ${index + 1} is an HTML/JSON body, not media`);
    }
    return ok(kind);   // null = unrecognised container; accepted, per agreesWith policy
}

/**
 * Fetch, verify and (if needed) decrypt every segment of one media playlist.
 * Returns the ordered byte parts plus what we learned.
 */
async function downloadMediaPlaylist({ playlistUrl, headers, signal, jobId, label, phaseBase, preParsed = null }) {
    let parsed = preParsed;
    if (!parsed) {
        const m = await fetchText(playlistUrl, headers, signal);
        if (!isOk(m)) return m;
        parsed = parse(m.value.text, m.value.finalUrl);
        if (!isOk(parsed)) return parsed;
    }
    if (parsed.value.type === 'master') {
        return err(Fail.MANIFEST_PARSE, `${label} playlist is a master playlist, expected media`);
    }
    if (parsed.value.drm) {
        return err(Fail.DRM_PROTECTED, `DRM protected (${parsed.value.drm}) — cannot download`);
    }

    const { segments, map, isLive, duration } = parsed.value;
    if (!segments.length) return err(Fail.MANIFEST_PARSE, `${label} playlist has no segments`);

    // Keys, fetched lazily and cached per URI. v2.0 fetched the first key only,
    // so a playlist that rotated keys decrypted later segments with the wrong
    // one and reported the garbage as success.
    const keys = new Map();
    async function keyFor(uri) {
        if (keys.has(uri)) return keys.get(uri);
        const kr = await fetchBytes(uri, { headers, signal });
        if (!isOk(kr)) return err(Fail.DECRYPT_FAILED, `Could not fetch key: ${kr.message}`);
        if (kr.value.bytes.length !== 16) {
            return err(Fail.DECRYPT_FAILED, `Key is ${kr.value.bytes.length} bytes, expected 16`);
        }
        const r = ok(kr.value.bytes);   // Uint8Array, as crypto.subtle requires
        keys.set(uri, r);
        return r;
    }

    const parts = [];
    let container = null;

    // Init segment (fMP4/CMAF). Without this the output is unplayable.
    if (map) {
        const mr = await fetchBytes(map.url, {
            headers: map.byteRange ? { ...headers, Range: rangeHeader(map.byteRange) } : headers,
            signal,
        });
        if (!isOk(mr)) return err(Fail.SEGMENT_FAILED, `Init segment failed: ${mr.message}`);
        const chk = checkSegment(mr.value.bytes, mr.value.contentType, -1);
        if (!isOk(chk)) return err(Fail.SEGMENT_FAILED, `Init segment is not media: ${chk.message}`);
        container = 'mp4';
        parts.push(mr.value.bytes);
    }

    let done = 0;
    const results = await pool(
        segments,
        async (seg, i) => {
            const h = seg.byteRange ? { ...headers, Range: rangeHeader(seg.byteRange) } : headers;
            const r = await fetchBytes(seg.url, { headers: h, signal });
            if (!isOk(r)) return r;

            let bytes = r.value.bytes;
            if (seg.key?.uri) {
                const k = await keyFor(seg.key.uri);
                if (!isOk(k)) return k;
                const dec = await decryptSegment(bytes, k.value, ivFor(seg));
                if (!isOk(dec)) return dec;
                bytes = dec.value;
            }

            const chk = checkSegment(bytes, r.value.contentType, i);
            if (!isOk(chk)) return chk;

            done++;
            progress(jobId, {
                phase: phaseBase, received: done, total: segments.length,
                pct: Math.round((done / segments.length) * 100),
            });
            return ok({ bytes, container: chk.value });
        },
        { concurrency: 6, signal }
    );

    if (signal?.aborted) return err(Fail.CANCELLED, 'Cancelled');

    // Fail loudly on any gap. v1 wrote partial streams and called them success.
    const failedAt = results.findIndex((r) => !isOk(r));
    if (failedAt !== -1) {
        return err(results[failedAt].code === Fail.DRM_PROTECTED || results[failedAt].code === Fail.DECRYPT_FAILED
            ? results[failedAt].code : Fail.SEGMENT_FAILED,
            `Segment ${failedAt + 1} of ${segments.length} failed: ${results[failedAt].message}`,
            { failedIndex: failedAt, total: segments.length });
    }

    for (const r of results) {
        parts.push(r.value.bytes);
        if (!container && r.value.container) container = r.value.container;
    }

    return ok({ parts, container: container || 'ts', segments: segments.length, isLive, duration });
}

async function downloadHls({ jobId, url, headers, preferHeight, mime }) {
    const ctl = new AbortController();
    const untrack = track(jobId, ctl);
    const signal = ctl.signal;

    try {
        // 1. Whatever the URL is: a master or already a media playlist.
        const m1 = await fetchText(url, headers, signal);
        if (!isOk(m1)) return m1;

        const top = parse(m1.value.text, m1.value.finalUrl);
        if (!isOk(top)) return top;
        if (top.value.drm) {
            return err(Fail.DRM_PROTECTED, `DRM protected (${top.value.drm}) — cannot download`);
        }

        let mediaUrl = m1.value.finalUrl;
        let variant = null;
        let audioRendition = null;
        let audioOnly = false;

        if (top.value.type === 'master') {
            variant = pickVariant(top.value.variants, preferHeight);
            if (!variant) return err(Fail.MANIFEST_PARSE, 'Master playlist has no variants');
            mediaUrl = variant.url;
            audioOnly = !codecsHaveVideo(variant.codecs);
            // Demuxed audio: the variant references an AUDIO group whose renditions
            // have their own playlists. v2.0 parsed these and never fetched them,
            // producing silent video reported as success.
            audioRendition = pickAudioRendition(top.value.audio, variant.audioGroup);
            progress(jobId, {
                phase: 'manifest',
                note: `variant ${variant.resolution || variant.bandwidth}${audioRendition ? ` + audio "${audioRendition.name || audioRendition.language || 'default'}"` : ''}`,
            });
        }

        // 2. The main track. If the URL was already a media playlist, reuse the parse.
        const main = await downloadMediaPlaylist({
            playlistUrl: mediaUrl, headers, signal, jobId,
            label: 'Media', phaseBase: 'segments',
            preParsed: top.value.type === 'media' ? top : null,
        });
        if (!isOk(main)) return main;

        // 3. The separate audio track, when there is one.
        let audio = null;
        if (audioRendition) {
            audio = await downloadMediaPlaylist({
                playlistUrl: audioRendition.url, headers, signal, jobId,
                label: 'Audio', phaseBase: 'audio-segments',
            });
            if (!isOk(audio)) {
                return err(audio.code, `Audio track failed: ${audio.message}`, { ...(audio.meta || {}), stage: 'audio' });
            }
        }

        const notes = [];
        if (main.value.isLive) {
            notes.push(`Playlist had no ENDLIST (live or still being written): captured the ${main.value.segments} segments currently listed, ${Math.round(main.value.duration)} s`);
        }
        if (audio) {
            notes.push('Audio is a separate track on this stream and was saved as a second file; it needs muxing (Tier 3) to become one file');
        } else if (variant && !audioOnly && variant.audioGroup && !codecsHaveAudio(variant.codecs)) {
            notes.push('Variant declares an audio group but no rendition URI was found; the file may be silent');
        }

        const c = main.value.container;
        const mainBlob = new Blob(main.value.parts, {
            type: mime || (c === 'mp4' ? (audioOnly ? 'audio/mp4' : 'video/mp4')
                : (c === 'aac' || c === 'id3') ? 'audio/aac'
                : 'video/mp2t'),
        });
        const out = {
            blobUrl: URL.createObjectURL(mainBlob),
            size: mainBlob.size,
            segments: main.value.segments,
            duration: main.value.duration,
            head: Array.from(main.value.parts[0].subarray(0, HEAD_BYTES)),
            container: main.value.container,
            audioOnly,
            live: main.value.isLive,
            notes,
        };
        if (audio) {
            const audioBlob = new Blob(audio.value.parts, {
                type: audio.value.container === 'mp4' ? 'audio/mp4' : audio.value.container === 'ts' ? 'video/mp2t' : 'audio/aac',
            });
            out.audio = {
                blobUrl: URL.createObjectURL(audioBlob),
                size: audioBlob.size,
                segments: audio.value.segments,
                container: audio.value.container,
            };
        }
        return out.size ? ok(out) : err(Fail.ZERO_BYTES, 'Assembled stream is empty');
    } catch (e) {
        if (signal.aborted) return err(Fail.CANCELLED, 'Cancelled');
        return err(Fail.NETWORK, e?.message || 'HLS assembly threw');
    } finally {
        untrack();
    }
}

function rangeHeader(byteRange) {
    // "<length>@<offset>" — parse() has already resolved omitted offsets.
    const [lenStr, offStr] = String(byteRange).split('@');
    const len = parseInt(lenStr, 10);
    const off = parseInt(offStr || '0', 10);
    return `bytes=${off}-${off + len - 1}`;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * Generate a real downscaled thumbnail plus a dHash, from ONE fetch.
 *
 * v1 pulled every original twice — once because cross-origin tiles fell back to
 * the full-size URL as their thumbnail src, and again because the background
 * re-fetched the original to hash it. Here one fetch feeds both, and the hash is
 * computed from the already-decoded bitmap, so it costs nothing extra.
 */
async function makeThumb({ url, headers, maxEdge = 320 }) {
    const r = await fetchBytes(url, { headers });
    if (!isOk(r)) return r;

    const blob = new Blob([r.value.bytes], { type: r.value.contentType || 'image/jpeg' });
    let bmp;
    try {
        bmp = await createImageBitmap(blob);
    } catch (e) {
        return err(Fail.WRONG_MAGIC, `Not a decodable image: ${e?.message || 'decode failed'}`);
    }

    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);

    const thumbBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
    const thumbUrl = URL.createObjectURL(thumbBlob);
    const hash = dHash(ctx, canvas, bmp.width, bmp.height);

    const out = {
        thumb: thumbUrl,
        width: bmp.width,
        height: bmp.height,
        bytes: r.value.bytes.length,     // REAL size, not estimated from pixels
        contentType: r.value.contentType,
        pHash: hash,
    };
    bmp.close();
    return ok(out);
}

/**
 * 64-bit dHash on an aspect-preserving letterboxed 9x8 draw.
 *
 * v1 used a 64-bit *average* hash over a non-uniformly squashed 32x32, which
 * destroyed aspect ratio and mapped every flat or solid-colour image to the same
 * all-zero value — so flat images all falsely matched each other while genuinely
 * similar photos at different aspect ratios missed. A gradient hash has neither
 * failure mode.
 */
function dHash(_ctx, _canvas, srcW, srcH) {
    const W = 9, H = 8;
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, W, H);

    // Letterbox to preserve aspect ratio.
    const scale = Math.min(W / srcW, H / srcH);
    const dw = srcW * scale, dh = srcH * scale;
    cx.drawImage(_canvas, (W - dw) / 2, (H - dh) / 2, dw, dh);

    const { data } = cx.getImageData(0, 0, W, H);
    const lum = new Array(W * H);
    for (let i = 0; i < W * H; i++) {
        const p = i * 4;
        lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    let bits = '';
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W - 1; x++) {
            bits += lum[y * W + x] < lum[y * W + x + 1] ? '1' : '0';
        }
    }
    // 64 bits -> 16 hex chars
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
    return hex;
}

post(OffEvt.LOG, { message: 'offscreen ready' });
