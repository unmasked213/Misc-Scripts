/**
 * Magic-byte signature detection.
 *
 * This is load-bearing for verification: it is the only way to tell a real JPEG
 * from a 3 KB HTML error page that a CDN returned with a 200 status. v1 trusted
 * the Content-Type header and the download API's success callback, neither of
 * which can see this.
 *
 * v2.1: containers that can hold either video or audio (ISO BMFF, Matroska/WebM,
 * Ogg) no longer sniff as one or the other by fiat. ISO BMFF reads the ftyp
 * brand, so M4A/M4B sniff as audio; anything else in those containers reports
 * kind 'av' and is accepted for both video and audio expectations. Previously an
 * m4a or audio-only WebM was rejected with WRONG_MAGIC because the container was
 * assumed to be video.
 */

/** ISO BMFF brands that mean audio-only content. */
const AUDIO_BRANDS = ['M4A ', 'M4B ', 'M4P '];
/** ISO BMFF brands that mean a still image (HEIF family). */
const IMAGE_BRANDS = ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

function ascii(bytes, at, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[at + i] ?? 0);
    return s;
}

/** MPEG audio frame sync: 11 set bits, then version/layer. Layer III only. */
function isMp3Frame(bytes) {
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) === 0x02;
}
/** ADTS AAC frame sync: 12 set bits, layer 00. */
function isAdtsFrame(bytes) {
    return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
}

const SIGS = [
    // --- images ---
    { mime: 'image/jpeg', ext: 'jpg', kind: 'image', at: 0, bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', ext: 'png', kind: 'image', at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: 'image/gif', ext: 'gif', kind: 'image', at: 0, ascii: 'GIF8' },
    { mime: 'image/bmp', ext: 'bmp', kind: 'image', at: 0, ascii: 'BM' },
    { mime: 'image/tiff', ext: 'tif', kind: 'image', at: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
    { mime: 'image/tiff', ext: 'tif', kind: 'image', at: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
    { mime: 'image/vnd.microsoft.icon', ext: 'ico', kind: 'image', at: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
    // WEBP is RIFF....WEBP — needs the second check
    { mime: 'image/webp', ext: 'webp', kind: 'image', at: 0, ascii: 'RIFF', also: { at: 8, ascii: 'WEBP' } },

    // --- ISO BMFF: brand decides image / audio / av (see sniffIsoBmff) ---
    { mime: 'video/mp4', ext: 'mp4', kind: 'av', at: 4, ascii: 'ftyp', iso: true },

    // --- video-only containers ---
    { mime: 'video/x-flv', ext: 'flv', kind: 'video', at: 0, ascii: 'FLV' },
    { mime: 'video/mpeg', ext: 'mpg', kind: 'video', at: 0, bytes: [0x00, 0x00, 0x01, 0xba] },
    { mime: 'video/x-msvideo', ext: 'avi', kind: 'video', at: 0, ascii: 'RIFF', also: { at: 8, ascii: 'AVI ' } },
    // MPEG-TS: 0x47 sync byte every 188 bytes
    { mime: 'video/mp2t', ext: 'ts', kind: 'video', at: 0, bytes: [0x47], also: { at: 188, bytes: [0x47] } },

    // --- containers that carry either ---
    { mime: 'video/webm', ext: 'webm', kind: 'av', at: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
    { mime: 'audio/ogg', ext: 'ogg', kind: 'av', at: 0, ascii: 'OggS' },

    // --- audio ---
    { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', at: 0, ascii: 'ID3' },
    { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', test: isMp3Frame },
    { mime: 'audio/aac', ext: 'aac', kind: 'audio', test: isAdtsFrame },
    { mime: 'audio/flac', ext: 'flac', kind: 'audio', at: 0, ascii: 'fLaC' },
    { mime: 'audio/wav', ext: 'wav', kind: 'audio', at: 0, ascii: 'RIFF', also: { at: 8, ascii: 'WAVE' } },

    // --- the ones that mean "this is not media" ---
    { mime: 'text/html', ext: 'html', kind: 'notmedia', at: 0, ascii: '<!DOCTYPE' },
    { mime: 'text/html', ext: 'html', kind: 'notmedia', at: 0, ascii: '<!doctype' },
    { mime: 'text/html', ext: 'html', kind: 'notmedia', at: 0, ascii: '<html' },
    { mime: 'text/html', ext: 'html', kind: 'notmedia', at: 0, ascii: '<HTML' },
];

function matchAt(bytes, at, spec) {
    if (spec.ascii) {
        for (let i = 0; i < spec.ascii.length; i++) {
            if (bytes[at + i] !== spec.ascii.charCodeAt(i)) return false;
        }
        return true;
    }
    for (let i = 0; i < spec.bytes.length; i++) {
        if (bytes[at + i] !== spec.bytes[i]) return false;
    }
    return true;
}

/**
 * Read the ftyp major brand (bytes 8..11) plus compatible brands, and classify.
 * Needs at least 12 bytes; with fewer we still know it is ISO BMFF, just not which.
 */
function sniffIsoBmff(bytes) {
    if (bytes.length < 12) return { mime: 'video/mp4', ext: 'mp4', kind: 'av' };
    const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const brands = [ascii(bytes, 8, 4)];
    // Compatible brands follow the minor version, up to the end of the ftyp box.
    const end = Math.min(bytes.length, size > 16 && size < 4096 ? size : 32);
    for (let off = 16; off + 4 <= end; off += 4) brands.push(ascii(bytes, off, 4));

    if (brands.some((b) => IMAGE_BRANDS.includes(b))) {
        const avif = brands.some((b) => b.startsWith('avi'));
        return avif
            ? { mime: 'image/avif', ext: 'avif', kind: 'image' }
            : { mime: 'image/heic', ext: 'heic', kind: 'image' };
    }
    if (brands.some((b) => AUDIO_BRANDS.includes(b))) {
        return { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' };
    }
    return { mime: 'video/mp4', ext: 'mp4', kind: 'av' };
}

/**
 * Sniff the media type from leading bytes.
 * @param {Uint8Array} bytes at least the first 32 bytes (or 190 to confirm MPEG-TS)
 * @returns {{mime: string, ext: string, kind: 'image'|'video'|'audio'|'av'|'notmedia'}|null}
 *   kind 'av' means an audio/video container whose track types cannot be told
 *   from the header alone; agreesWith accepts it for either expectation.
 */
export function sniff(bytes) {
    if (!bytes || bytes.length < 4) return null;
    for (const sig of SIGS) {
        if (sig.test) {
            if (!sig.test(bytes)) continue;
            return { mime: sig.mime, ext: sig.ext, kind: sig.kind };
        }
        if (!matchAt(bytes, sig.at, sig)) continue;
        if (sig.also) {
            // If we simply don't have enough bytes to confirm, skip rather than
            // guessing — a wrong positive here writes a corrupt file to disk.
            const need = sig.also.at + (sig.also.ascii?.length || sig.also.bytes.length);
            if (bytes.length < need) continue;
            if (!matchAt(bytes, sig.also.at, sig.also)) continue;
        }
        if (sig.iso) return sniffIsoBmff(bytes);
        return { mime: sig.mime, ext: sig.ext, kind: sig.kind };
    }
    // Plain-text sniff — JSON/XML error bodies are the other common "success" lie.
    const head = String.fromCharCode(...bytes.slice(0, 16)).trim();
    if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<?xml')) {
        return { mime: 'application/json', ext: 'json', kind: 'notmedia' };
    }
    return null;
}

/** Does a sniffed result agree with what we expected to download? */
export function agreesWith(sniffed, expectedKind) {
    if (!sniffed) return true;               // unknown format — don't block on it
    if (sniffed.kind === 'notmedia') return false;
    if (!expectedKind) return true;
    const timeBased = expectedKind === 'video' || expectedKind === 'audio' || expectedKind === 'stream';
    if (sniffed.kind === 'av') return timeBased;
    if (expectedKind === 'stream') return sniffed.kind === 'video' || sniffed.kind === 'audio';
    return sniffed.kind === expectedKind;
}

/** ISO BMFF box types that legitimately open a CMAF/fMP4 media or init segment. */
const SEGMENT_BOXES = ['ftyp', 'styp', 'moof', 'moov', 'sidx', 'prft', 'emsg', 'free', 'skip', 'mdat'];

/**
 * Sniff one HLS segment. Returns the container we see, or 'notmedia' when the
 * bytes are an HTML/JSON body (the expired-token case), or null when unknown.
 * Accepts: MPEG-TS, ISO BMFF fragments, ADTS AAC, ID3-wrapped packed audio.
 * @param {Uint8Array} bytes
 * @returns {'ts'|'mp4'|'aac'|'id3'|'notmedia'|null}
 */
export function sniffSegment(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'ts';
    if (bytes.length >= 8 && SEGMENT_BOXES.includes(ascii(bytes, 4, 4))) return 'mp4';
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'id3';   // "ID3"
    if (isAdtsFrame(bytes)) return 'aac';
    // Also accept a raw WebVTT/text? No — those are subtitle playlists, never fetched here.
    const head = String.fromCharCode(...bytes.slice(0, 16)).trim().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{') || head.startsWith('[') || head.startsWith('<?xml')) {
        return 'notmedia';
    }
    return null;
}

const EXT_BY_MIME = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp', 'image/tiff': 'tif',
    'image/svg+xml': 'svg', 'image/vnd.microsoft.icon': 'ico',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-matroska': 'mkv', 'video/mp2t': 'ts', 'video/x-msvideo': 'avi', 'video/ogg': 'ogv',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/webm': 'weba', 'audio/x-m4a': 'm4a',
};

export function extForMime(mime) {
    if (!mime) return null;
    return EXT_BY_MIME[String(mime).split(';')[0].trim().toLowerCase()] || null;
}

/**
 * Coarse kind from a MIME type. Manifests are checked BEFORE the audio/ prefix
 * because `audio/x-mpegurl` and `audio/mpegurl` are HLS playlists, not audio.
 */
export function kindForMime(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (m.includes('mpegurl') || m.includes('m3u8') || m.includes('dash+xml')) return 'stream';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return null;
}

/** Is this Content-Type a media type we would knowingly save to disk? */
export function isMediaMime(mime) {
    const k = kindForMime(mime);
    if (k) return true;
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    return m === 'application/octet-stream' || m === 'binary/octet-stream';
}
