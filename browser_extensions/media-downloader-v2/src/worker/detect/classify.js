/**
 * Media classification, most reliable signal first.
 *
 * v1 never once read `details.type` (background.js:835-922) — the platform's own
 * answer to "is this media" — and instead led with a URL regex containing
 * /\/chunk/i, which discarded any URL whose path merely contained the word
 * "chunk". Order matters here: the regex is the last resort, not the first.
 *
 * v2.1: `details.type === 'media'` is the resource type for BOTH <video> and
 * <audio> loads, so it no longer means "video" by fiat — the Content-Type
 * refines it. Stream segments (.ts / .m4s / video/mp2t / video/iso.segment) are
 * classified as 'segment' so the caller can fold them into the stream they
 * belong to instead of surfacing hundreds of four-second "videos".
 */

import { kindForMime } from '../../shared/mime.js';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|svg|ico)(?:$|[?#])/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|ogv|flv|3gp|m2ts)(?:$|[?#])/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|wma|weba)(?:$|[?#])/i;
const MANIFEST_EXT = /\.(m3u8|mpd)(?:$|[?#])/i;
/** HLS/DASH segment shapes. `.ts` lives here now, not in VIDEO_EXT. */
const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|cmft)(?:$|[?#])/i;
const SEGMENT_MIME = /^(video\/mp2t|video\/iso\.segment|audio\/iso\.segment|video\/vnd\.dlna\.mpeg-tts)$/i;

/** Tiny tracking pixels and sprite chrome we never want to surface. */
const JUNK = /\/(?:pixel|beacon|spacer|blank|1x1|tracking)[.\-_]/i;

function baseMime(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/** Is this response a stream segment rather than a standalone file? */
export function isSegment(url, contentType) {
    if (SEGMENT_MIME.test(baseMime(contentType))) return true;
    return SEGMENT_EXT.test(url || '');
}

/**
 * @param {object} d webRequest details (or a synthetic equivalent)
 * @param {string|null} contentType
 * @returns {{kind: string|null, signal: string}} signal names which rule fired
 *   kind is one of image | video | audio | stream | segment | null
 */
export function classify(d, contentType) {
    const url = d.url || '';
    if (!/^https?:/i.test(url)) return { kind: null, signal: 'non-http' };
    if (JUNK.test(url)) return { kind: null, signal: 'junk' };

    // 0. Manifests and segments are identified before anything else, because a
    //    player fetches both as 'xmlhttprequest' with video/* Content-Types.
    if (isManifestUrl(url, contentType)) return { kind: 'stream', signal: 'manifest' };
    if (isSegment(url, contentType)) return { kind: 'segment', signal: 'segment' };

    const ctKind = contentType ? kindForMime(contentType) : null;

    // 1. The platform told us it is a media element load. This is the strongest
    //    free signal available; the Content-Type says which sort of media.
    if (d.type === 'media') {
        const kind = ctKind === 'audio' ? 'audio' : 'video';
        return { kind, signal: 'resource-type-media' };
    }
    if (d.type === 'image') return { kind: 'image', signal: 'resource-type-image' };

    // 2. The server told us.
    if (ctKind) return { kind: ctKind, signal: 'content-type' };
    // application/octet-stream is ambiguous — fall through to the URL.

    // 3. The URL looks like it. Least reliable; used only when nothing else spoke.
    if (VIDEO_EXT.test(url)) return { kind: 'video', signal: 'extension' };
    if (AUDIO_EXT.test(url)) return { kind: 'audio', signal: 'extension' };
    if (IMAGE_EXT.test(url)) return { kind: 'image', signal: 'extension' };

    return { kind: null, signal: 'unclassified' };
}

export function isManifestUrl(url, contentType) {
    if (MANIFEST_EXT.test(url || '')) return true;
    const ct = baseMime(contentType);
    return ct.includes('mpegurl') || ct.includes('dash+xml');
}

/**
 * Below this, a "video" is almost certainly an ad bumper or a sprite. Applied as
 * a ranking signal, never as a filter — the user can always still see it.
 */
export const SMALL_MEDIA_BYTES = 200 * 1024;

export function headerValue(headers, name) {
    if (!headers) return null;
    const want = name.toLowerCase();
    for (const h of headers) {
        if (h.name && h.name.toLowerCase() === want) return h.value;
    }
    return null;
}

/**
 * Total size from response headers: Content-Range's total on a 206, otherwise
 * Content-Length. v2.0 read Content-Length on every response, so a player doing
 * range requests recorded the size of its last 1 MB chunk as the file size.
 */
export function totalBytesFromHeaders(headers, statusCode) {
    if (statusCode === 206) {
        const cr = headerValue(headers, 'content-range');
        const m = cr && cr.match(/\/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : null;
    }
    const cl = headerValue(headers, 'content-length');
    const n = cl ? parseInt(cl, 10) : NaN;
    return Number.isFinite(n) ? n : null;
}
