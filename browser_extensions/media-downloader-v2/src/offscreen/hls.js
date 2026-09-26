/**
 * HLS parsing and decryption, per RFC 8216.
 *
 * Fixes over v1, each of which independently produced a corrupt file reported as
 * a success:
 *
 *  - AES-128: v1 passed `Array.from(key)` across a message boundary into
 *    crypto.subtle.importKey, which requires a BufferSource. That is a guaranteed
 *    TypeError, and the catch block returned the *ciphertext*, which was written
 *    to disk and reported as a successful download. Keys are Uint8Array here.
 *  - IV: when #EXT-X-KEY has no IV attribute, RFC 8216 §5.2 says the media
 *    sequence number is the IV. v1 had no IV derivation at all.
 *  - #EXT-X-MAP: fMP4/CMAF streams need the init segment prepended or the output
 *    is headerless fragments that no player will open. v1 ignored the tag.
 *  - #EXT-X-BYTERANGE: single-file streams were unsupported.
 *  - DRM gating on KEYFORMAT, not METHOD. v1 reported plain AES-128 as DRM
 *    (wrongly refusing downloadable content) while SAMPLE-AES could slip through.
 */

import { Fail, ok, err } from '../shared/result.js';

const WIDEVINE = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY = 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95';
const FAIRPLAY = 'com.apple.streamingkeydelivery';

function resolve(url, base) {
    try { return new URL(url, base).href; } catch { return url; }
}

function attrs(line) {
    // Parse KEY=VALUE,KEY="quoted,value" — commas inside quotes must not split.
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
}

/**
 * Parse a playlist. Returns either a master (with variants) or a media playlist
 * (with segments).
 */
export function parse(text, baseUrl) {
    if (!text || !text.trim().startsWith('#EXTM3U')) {
        return err(Fail.MANIFEST_PARSE, 'Not an M3U8 playlist');
    }

    const lines = text.split(/\r?\n/);
    const isMaster = /#EXT-X-STREAM-INF/.test(text);

    if (isMaster) {
        const variants = [];
        const audio = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('#EXT-X-MEDIA:')) {
                const a = attrs(line.slice(13));
                if (a.TYPE === 'AUDIO' && a.URI) {
                    audio.push({
                        url: resolve(a.URI, baseUrl),
                        groupId: a['GROUP-ID'],
                        name: a.NAME,
                        language: a.LANGUAGE,
                        isDefault: a.DEFAULT === 'YES',
                    });
                }
                continue;
            }

            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
            const a = attrs(line.slice(18));
            // The URI is the next non-comment line.
            let uri = null;
            for (let j = i + 1; j < lines.length; j++) {
                const nxt = lines[j].trim();
                if (!nxt || nxt.startsWith('#')) continue;
                uri = nxt; break;
            }
            if (!uri) continue;
            variants.push({
                url: resolve(uri, baseUrl),
                bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
                resolution: a.RESOLUTION || null,
                codecs: a.CODECS || null,
                audioGroup: a.AUDIO || null,
            });
        }

        // Detect DRM declared up-front, before we fetch any variant.
        const sessionKey = text.match(/#EXT-X-SESSION-KEY:(.*)/);
        const drm = sessionKey ? drmFrom(attrs(sessionKey[1])) : null;

        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return ok({ type: 'master', variants, audio, drm });
    }

    // --- media playlist ---
    const segments = [];
    let key = null;
    let map = null;
    let seq = 0;
    let duration = 0;
    let pendingDuration = 0;
    let pendingByteRange = null;
    let drm = null;
    let isLive = !/#EXT-X-ENDLIST/.test(text);
    // RFC 8216 §4.3.2.2: when EXT-X-BYTERANGE omits the offset, the sub-range
    // starts at the byte after the previous sub-range of the same URI. v2.0 used
    // 0, which fetched the first segment's bytes for every segment.
    const rangeEnd = new Map();   // resolved URI -> next byte offset

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            seq = parseInt(line.split(':')[1], 10) || 0;
            continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) {
            const a = attrs(line.slice(11));
            const d = drmFrom(a);
            if (d) { drm = d; key = null; }
            else if (a.METHOD === 'NONE') key = null;
            else key = { method: a.METHOD, uri: a.URI ? resolve(a.URI, baseUrl) : null, iv: a.IV || null };
            continue;
        }
        if (line.startsWith('#EXT-X-MAP:')) {
            const a = attrs(line.slice(11));
            if (a.URI) map = { url: resolve(a.URI, baseUrl), byteRange: a.BYTERANGE || null };
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
            continue;
        }
        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            pendingByteRange = line.slice(17);
            continue;
        }
        if (line.startsWith('#')) continue;

        const index = segments.length;
        const url = resolve(line, baseUrl);
        let byteRange = null;
        if (pendingByteRange) {
            const [lenStr, offStr] = String(pendingByteRange).split('@');
            const len = parseInt(lenStr, 10) || 0;
            const off = offStr !== undefined && offStr !== '' ? parseInt(offStr, 10) || 0 : (rangeEnd.get(url) || 0);
            byteRange = `${len}@${off}`;
            rangeEnd.set(url, off + len);
        }
        segments.push({
            url,
            duration: pendingDuration,
            seq: seq + index,
            key,
            byteRange,
        });
        duration += pendingDuration;
        pendingDuration = 0;
        pendingByteRange = null;
    }

    if (!segments.length && !drm) return err(Fail.MANIFEST_PARSE, 'No segments in playlist');

    return ok({ type: 'media', segments, map, duration, isLive, drm });
}

function drmFrom(a) {
    const kf = String(a.KEYFORMAT || '').toLowerCase();
    const method = String(a.METHOD || '').toUpperCase();
    if (kf.includes(WIDEVINE)) return 'Widevine';
    if (kf.includes(PLAYREADY)) return 'PlayReady';
    if (kf.includes(FAIRPLAY)) return 'FairPlay';
    if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') return 'SAMPLE-AES';
    // METHOD=AES-128 with KEYFORMAT absent or "identity" is a plain 16-byte key
    // over standard CBC. That is NOT DRM and we can and should handle it.
    return null;
}

/**
 * Convert a hex IV attribute, or derive one from the media sequence number when
 * the playlist omits it (RFC 8216 §5.2).
 */
export function ivFor(segment) {
    if (segment.key?.iv) {
        const hex = segment.key.iv.replace(/^0x/i, '');
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
        return out;
    }
    // Big-endian sequence number in the low 8 bytes.
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, segment.seq >>> 0, false);
    return iv;
}

/**
 * Decrypt one AES-128-CBC segment.
 * @param {Uint8Array} data ciphertext
 * @param {Uint8Array} keyBytes MUST be a Uint8Array — this is the v1 bug
 * @param {Uint8Array} iv
 */
export async function decryptSegment(data, keyBytes, iv) {
    if (!(keyBytes instanceof Uint8Array)) {
        // Fail loudly rather than returning ciphertext, which is what v1 did.
        return err(Fail.DECRYPT_FAILED, 'Key is not a Uint8Array — refusing to write ciphertext');
    }
    try {
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
        return ok(new Uint8Array(plain));
    } catch (e) {
        return err(Fail.DECRYPT_FAILED, e?.message || 'AES-CBC decrypt failed');
    }
}

/** Does a CODECS attribute declare a video track? Absent CODECS is treated as "probably video". */
export function codecsHaveVideo(codecs) {
    if (!codecs) return true;
    return /\b(avc1|avc3|hvc1|hev1|hev2|vp09|vp8|vp9|av01|dvh1|dvhe|mp4v|theora)/i.test(codecs);
}

/** Does a CODECS attribute declare an audio track? Absent CODECS is treated as "unknown" (true). */
export function codecsHaveAudio(codecs) {
    if (!codecs) return true;
    return /\b(mp4a|ac-3|ec-3|opus|vorbis|flac|alac|mp3|ac-4)/i.test(codecs);
}

/**
 * Choose the audio rendition a variant references through its AUDIO group.
 * Returns null when the variant carries its own audio (no group, or the group's
 * renditions have no URI, which per spec means "muxed into the variant").
 */
export function pickAudioRendition(audio, groupId) {
    if (!groupId || !audio?.length) return null;
    const group = audio.filter((a) => a.groupId === groupId && a.url);
    if (!group.length) return null;
    return group.find((a) => a.isDefault) || group[0];
}

/** Pick the best variant, or one matching a requested height. */
export function pickVariant(variants, preferHeight = null) {
    if (!variants?.length) return null;
    if (!preferHeight) return variants[0];              // already sorted desc by bandwidth
    const withH = variants
        .map((v) => ({ v, h: v.resolution ? parseInt(v.resolution.split('x')[1], 10) : 0 }))
        .filter((x) => x.h > 0);
    if (!withH.length) return variants[0];
    const atOrBelow = withH.filter((x) => x.h <= preferHeight);
    return (atOrBelow.length ? atOrBelow[0] : withH[withH.length - 1]).v;
}
