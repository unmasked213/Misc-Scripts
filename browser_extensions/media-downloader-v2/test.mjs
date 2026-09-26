/**
 * Fixture tests for the pure functions.
 *
 * These are the places where a bug writes a corrupt file to disk and calls it a
 * success — URL identity, filename safety, magic bytes, and manifest parsing.
 * Every case below is either a v1 defect being pinned down or an RFC 8216
 * requirement v1 ignored.
 *
 * Run: node test.mjs
 */

import { normalizeUrl, sanitizeSegment, clampPath, renderTemplate, stemFromUrl, siteOf } from './src/shared/url.js';
import { sniff, agreesWith, extForMime, kindForMime, sniffSegment, isMediaMime } from './src/shared/mime.js';
import { parse, ivFor, pickVariant, pickAudioRendition, codecsHaveVideo, codecsHaveAudio } from './src/offscreen/hls.js';
import { hamming } from './src/ui/library/selection.js';
import { classify, isSegment, totalBytesFromHeaders } from './src/worker/detect/classify.js';
import { buildRefererRule } from './src/worker/transport/headers.js';

let pass = 0, fail = 0;
const results = [];

function t(name, fn) {
    try { fn(); pass++; results.push(['ok  ', name]); }
    catch (e) { fail++; results.push(['FAIL', `${name}\n       ${e.message}`]); }
}
function eq(a, b, msg = '') {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${msg}\n       expected: ${B}\n       actual:   ${A}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

// ---------------------------------------------------------------------------
// URL identity — v1 discarded the entire query string (background.js:1128)
// ---------------------------------------------------------------------------

t('normalizeUrl KEEPS identity-bearing query params', () => {
    const a = normalizeUrl('https://cdn.example.com/img?id=123');
    const b = normalizeUrl('https://cdn.example.com/img?id=456');
    ok(a !== b, 'two different images collapsed to the same key — this is the v1 bug');
});

t('normalizeUrl strips signing/expiry params', () => {
    eq(
        normalizeUrl('https://cdn.x.com/a.jpg?id=7&X-Amz-Signature=deadbeef&Expires=99999'),
        normalizeUrl('https://cdn.x.com/a.jpg?id=7')
    );
});

t('normalizeUrl is order-insensitive', () => {
    eq(normalizeUrl('https://x.com/a?b=2&a=1'), normalizeUrl('https://x.com/a?a=1&b=2'));
});

t('normalizeUrl collapses CDN resize paths', () => {
    eq(
        normalizeUrl('https://x.com/resize/300x200/photo.jpg'),
        normalizeUrl('https://x.com/photo.jpg')
    );
});

t('normalizeUrl unifies http and https', () => {
    eq(normalizeUrl('http://x.com/a.jpg'), normalizeUrl('https://x.com/a.jpg'));
});

t('siteOf handles two-part TLDs', () => {
    eq(siteOf('https://images.bbc.co.uk/x'), 'bbc.co.uk');
    eq(siteOf('https://cdn.example.com/x'), 'example.com');
});

// ---------------------------------------------------------------------------
// Filenames — Windows will silently refuse several of these
// ---------------------------------------------------------------------------

t('sanitizeSegment strips characters illegal on Windows', () => {
    eq(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
});

t('sanitizeSegment guards reserved device names', () => {
    eq(sanitizeSegment('CON'), '_CON');
    eq(sanitizeSegment('com1.jpg'), '_com1.jpg');
    eq(sanitizeSegment('console.jpg'), 'console.jpg');   // not reserved
});

t('sanitizeSegment removes trailing dots and spaces', () => {
    eq(sanitizeSegment('name.  '), 'name');
    eq(sanitizeSegment('  spaced  '), 'spaced');
});

t('sanitizeSegment falls back on empty input', () => {
    eq(sanitizeSegment('', 'fallback'), 'fallback');
    eq(sanitizeSegment('///'), '___');
});

t('clampPath shortens the longest segment and keeps the extension', () => {
    const long = 'site/' + 'x'.repeat(400) + '.jpg';
    const out = clampPath(long, 100);
    ok(out.length <= 100, `still ${out.length} chars`);
    ok(out.endsWith('.jpg'), 'extension was truncated off: ' + out.slice(-12));
    ok(out.startsWith('site/'), 'folder segment was damaged');
});

t('clampPath leaves short paths untouched', () => {
    eq(clampPath('a/b/c.jpg', 220), 'a/b/c.jpg');
});

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

t('renderTemplate fills tokens and pads the index', () => {
    const out = renderTemplate('{site}/{date:YYYY}/{stem}-{w}x{h}.{ext}', {
        site: 'example.com', stem: 'photo', ext: 'jpg',
        width: 1920, height: 1080, date: new Date('2026-07-25T00:00:00Z'),
    });
    eq(out, 'example.com/2026/photo-1920x1080.jpg');
});

t('renderTemplate cleans up artefacts from unknown dimensions', () => {
    const out = renderTemplate('{stem}-{w}x{h}.{ext}', { stem: 'clip', ext: 'mp4' });
    eq(out, 'clip.mp4', 'left a dangling "-x" when dimensions were unknown');
});

t('renderTemplate sanitizes every segment independently', () => {
    const out = renderTemplate('{pageTitle}/{stem}.{ext}', {
        pageTitle: 'My: Gallery? <2026>', stem: 'a/b', ext: 'jpg',
    });
    ok(!/[<>:"|?*]/.test(out), 'illegal characters survived: ' + out);
    eq(out.split('/').length, 3, 'a slash inside a token created an extra folder level');
});

t('renderTemplate never produces an absolute path', () => {
    const out = renderTemplate('/{site}/{stem}.{ext}', { site: 'x.com', stem: 'a', ext: 'jpg' });
    ok(!out.startsWith('/'), 'leading slash would be rejected by chrome.downloads');
});

// ---------------------------------------------------------------------------
// Magic bytes — the only defence against a 200-with-error-page
// ---------------------------------------------------------------------------

const bytes = (...b) => new Uint8Array(b);
const ascii = (s, pad = 0) => {
    const a = new Uint8Array(s.length + pad);
    for (let i = 0; i < s.length; i++) a[i + pad] = s.charCodeAt(i);
    return a;
};

t('sniff identifies JPEG / PNG / GIF', () => {
    eq(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg');
    eq(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).mime, 'image/png');
    eq(sniff(ascii('GIF89a')).mime, 'image/gif');
});

t('sniff distinguishes WEBP from other RIFF containers', () => {
    const webp = ascii('RIFF____WEBPVP8 ');
    const wav = ascii('RIFF____WAVEfmt ');
    eq(sniff(webp).mime, 'image/webp');
    eq(sniff(wav).mime, 'audio/wav');
});

t('sniff identifies MP4 via the ftyp box at offset 4, as an ambiguous a/v container', () => {
    const r = sniff(ascii('ftypisom', 4));
    eq(r.mime, 'video/mp4');
    eq(r.kind, 'av', 'ISO BMFF may hold video or audio; the header alone cannot say');
    ok(agreesWith(r, 'video') && agreesWith(r, 'audio') && agreesWith(r, 'stream'), 'av must satisfy every time-based expectation');
    ok(!agreesWith(r, 'image'));
});

t('sniff reads the ftyp brand: M4A is audio, avif/heic are images', () => {
    const iso = (brand, compat = '') => {
        const body = 'ftyp' + brand + '\0\0\0\0' + compat;
        const a = new Uint8Array(4 + body.length);
        a[3] = a.length;
        for (let i = 0; i < body.length; i++) a[4 + i] = body.charCodeAt(i);
        return a;
    };
    eq(sniff(iso('M4A ')).kind, 'audio');
    eq(sniff(iso('M4A ')).mime, 'audio/mp4');
    eq(sniff(iso('isom', 'M4A ')).kind, 'audio', 'compatible brands count too');
    eq(sniff(iso('avif')).mime, 'image/avif');
    eq(sniff(iso('heic')).mime, 'image/heic');
    eq(sniff(iso('mp42', 'isomavc1')).kind, 'av');
    ok(!agreesWith(sniff(iso('M4A ')), 'video'), 'an m4a offered as video is still a mismatch');
});

t('sniff accepts MP3 frame-sync variants and ADTS AAC, not just ID3 and 0xFFFB', () => {
    eq(sniff(bytes(0xff, 0xfb, 0x90, 0x00)).mime, 'audio/mpeg');
    eq(sniff(bytes(0xff, 0xfa, 0x90, 0x00)).mime, 'audio/mpeg', 'MPEG-1 Layer III with CRC');
    eq(sniff(bytes(0xff, 0xf3, 0x90, 0x00)).mime, 'audio/mpeg', 'MPEG-2 Layer III');
    eq(sniff(bytes(0xff, 0xf1, 0x50, 0x80)).mime, 'audio/aac', 'ADTS, MPEG-4');
    eq(sniff(bytes(0xff, 0xf9, 0x50, 0x80)).mime, 'audio/aac', 'ADTS, MPEG-2');
    eq(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg', 'JPEG must not be caught by the frame-sync test');
});

t('sniff treats WebM/Matroska and Ogg as ambiguous a/v containers', () => {
    eq(sniff(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01)).kind, 'av', 'audio/webm exists');
    eq(sniff(ascii('OggS')).kind, 'av', 'video/ogg (Theora) exists');
    ok(agreesWith(sniff(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01)), 'audio'));
});

t('kindForMime classifies HLS MIME types as stream before the audio/ prefix', () => {
    eq(kindForMime('audio/x-mpegurl'), 'stream');
    eq(kindForMime('audio/mpegurl'), 'stream');
    eq(kindForMime('application/vnd.apple.mpegurl; charset=utf-8'), 'stream');
    eq(kindForMime('application/dash+xml'), 'stream');
    eq(kindForMime('audio/mpeg'), 'audio');
    eq(kindForMime('video/mp4'), 'video');
});

t('isMediaMime accepts media and octet-stream, rejects documents', () => {
    ok(isMediaMime('video/mp4') && isMediaMime('audio/mpeg') && isMediaMime('application/octet-stream'));
    ok(!isMediaMime('text/html') && !isMediaMime('application/json') && !isMediaMime(''));
});

t('sniffSegment recognises TS, fMP4 fragments, ADTS and ID3-wrapped audio; flags HTML', () => {
    const ts = new Uint8Array(400); ts[0] = 0x47; ts[188] = 0x47;
    eq(sniffSegment(ts), 'ts');
    const tsBad = new Uint8Array(400); tsBad[0] = 0x47; tsBad[188] = 0x00;
    eq(sniffSegment(tsBad), null, 'sync at 0 without sync at 188 is not confirmed TS');
    eq(sniffSegment(ascii('styp', 4)), 'mp4');
    eq(sniffSegment(ascii('moof', 4)), 'mp4');
    eq(sniffSegment(ascii('sidx', 4)), 'mp4');
    eq(sniffSegment(bytes(0xff, 0xf1, 0x50, 0x80)), 'aac');
    eq(sniffSegment(ascii('ID3\x04\x00')), 'id3');
    eq(sniffSegment(ascii('<!DOCTYPE html>')), 'notmedia');
    eq(sniffSegment(ascii('{"error":"expired"}')), 'notmedia');
});

// ---------------------------------------------------------------------------
// Classification — resourceType 'media' covers <audio> too
// ---------------------------------------------------------------------------

t('classify refines resourceType media with the Content-Type', () => {
    eq(classify({ url: 'https://x.com/a', type: 'media' }, 'audio/mpeg').kind, 'audio');
    eq(classify({ url: 'https://x.com/a', type: 'media' }, 'video/mp4').kind, 'video');
    eq(classify({ url: 'https://x.com/a', type: 'media' }, null).kind, 'video', 'no Content-Type: video is the safer default');
    eq(classify({ url: 'https://x.com/a', type: 'media' }, 'application/octet-stream').kind, 'video');
    eq(classify({ url: 'https://x.com/a', type: 'media' }, 'audio/mpeg').signal, 'resource-type-media');
});

t('classify recognises manifests and segments before anything else', () => {
    eq(classify({ url: 'https://x.com/p/master.m3u8?tok=1', type: 'xmlhttprequest' }, 'application/octet-stream').kind, 'stream');
    eq(classify({ url: 'https://x.com/p/index', type: 'xmlhttprequest' }, 'audio/x-mpegurl').kind, 'stream');
    eq(classify({ url: 'https://x.com/p/seg-00042.ts', type: 'xmlhttprequest' }, 'video/mp2t').kind, 'segment');
    eq(classify({ url: 'https://x.com/p/seg-00042.m4s', type: 'xmlhttprequest' }, 'video/mp4').kind, 'segment');
    eq(classify({ url: 'https://x.com/p/chunk?n=3', type: 'xmlhttprequest' }, 'video/iso.segment').kind, 'segment');
    eq(classify({ url: 'https://x.com/p/full.mp4', type: 'xmlhttprequest' }, 'video/mp4').kind, 'video', 'a whole mp4 is not a segment');
    eq(classify({ url: 'https://x.com/song.aac', type: 'media' }, 'audio/aac').kind, 'audio', '.aac is audio, not a segment shape');
});

t('isSegment matches by MIME or by extension', () => {
    ok(isSegment('https://x.com/a.ts', null) && isSegment('https://x.com/a.m4s?x=1', null) && isSegment('https://x.com/a', 'video/mp2t'));
    ok(!isSegment('https://x.com/a.mp4', 'video/mp4'));
});

t('totalBytesFromHeaders reads Content-Range on 206, Content-Length otherwise', () => {
    eq(totalBytesFromHeaders([{ name: 'Content-Range', value: 'bytes 0-1048575/734003200' }, { name: 'Content-Length', value: '1048576' }], 206), 734003200);
    eq(totalBytesFromHeaders([{ name: 'Content-Length', value: '1048576' }], 200), 1048576);
    eq(totalBytesFromHeaders([{ name: 'Content-Length', value: '1048576' }], 206), null, 'a 206 without Content-Range has no known total');
    eq(totalBytesFromHeaders([], 200), null);
});

// ---------------------------------------------------------------------------
// DNR rule shape — the rule must be able to match a request with no tab
// ---------------------------------------------------------------------------

t('buildRefererRule targets tab-less requests and anchors to the media URL', () => {
    const r = buildRefererRule(9001, { url: 'https://cdn.x.com/v/1.mp4?sig=abc', pageUrl: 'https://site.com/watch/1' }, -1);
    eq(r.condition.tabIds, [-1], 'downloads and offscreen fetches have tabId TAB_ID_NONE; v2.0 scoped to the page tab and never matched');
    eq(r.condition.urlFilter, '|https://cdn.x.com/v/1.mp4');
    ok(r.condition.resourceTypes.includes('main_frame') && r.condition.resourceTypes.includes('other') && r.condition.resourceTypes.includes('xmlhttprequest'));
    eq(r.action.requestHeaders, [
        { header: 'Referer', operation: 'set', value: 'https://site.com/watch/1' },
        { header: 'Origin', operation: 'set', value: 'https://site.com' },
    ]);
    ok(!('initiatorDomains' in r.condition));
});

t('buildRefererRule broad mode drops the URL anchor for stream jobs', () => {
    const r = buildRefererRule(9002, { url: 'https://cdn.x.com/m.m3u8', pageUrl: 'https://site.com/w', broad: true }, -1);
    ok(!('urlFilter' in r.condition));
    eq(r.condition.tabIds, [-1]);
});

t('buildRefererRule returns null when there is nothing valid to spoof with', () => {
    eq(buildRefererRule(1, { url: 'https://x.com/a', pageUrl: 'not a url' }), null);
    eq(buildRefererRule(1, { url: 'garbage', pageUrl: 'https://x.com/' }), null);
});

t('sniff flags HTML as notmedia — the error-page case', () => {
    const html = sniff(ascii('<!DOCTYPE html><html>'));
    eq(html.kind, 'notmedia');
    eq(agreesWith(html, 'image'), false, 'an HTML error page passed verification');
    eq(agreesWith(html, 'video'), false);
});

t('sniff flags JSON error bodies as notmedia', () => {
    eq(sniff(ascii('{"error":"forbidden"}')).kind, 'notmedia');
});

t('agreesWith tolerates unknown formats rather than blocking them', () => {
    eq(agreesWith(null, 'image'), true, 'unknown format should not fail verification');
});

t('extForMime maps common types', () => {
    eq(extForMime('image/jpeg'), 'jpg');
    eq(extForMime('video/mp4; codecs="avc1"'), 'mp4');
    eq(extForMime('application/octet-stream'), null);
});

// ---------------------------------------------------------------------------
// HLS — every one of these was a v1 corruption bug
// ---------------------------------------------------------------------------

t('parse reads a master playlist and sorts variants by bandwidth', () => {
    const m = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
high.m3u8`;
    const r = parse(m, 'https://x.com/v/master.m3u8');
    ok(r.ok, 'parse failed');
    eq(r.value.type, 'master');
    eq(r.value.variants[0].resolution, '1920x1080', 'variants not sorted best-first');
    eq(r.value.variants[0].url, 'https://x.com/v/high.m3u8', 'relative URL not resolved');
});

t('parse extracts EXT-X-MEDIA audio renditions', () => {
    const m = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",DEFAULT=YES,URI="audio_en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a1"
v.m3u8`;
    const r = parse(m, 'https://x.com/');
    eq(r.value.audio.length, 1, 'audio rendition dropped — output would be silent');
    eq(r.value.audio[0].language, undefined);
    eq(r.value.audio[0].name, 'English');
});

t('parse handles quoted commas in attribute lists', () => {
    const m = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720
v.m3u8`;
    const r = parse(m, 'https://x.com/');
    eq(r.value.variants[0].codecs, 'avc1.4d401f,mp4a.40.2', 'comma inside quotes split the attribute');
    eq(r.value.variants[0].resolution, '1280x720');
});

t('parse reads a media playlist with durations', () => {
    const m = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.9,
s0.ts
#EXTINF:10.0,
s1.ts
#EXT-X-ENDLIST`;
    const r = parse(m, 'https://x.com/v/');
    eq(r.value.type, 'media');
    eq(r.value.segments.length, 2);
    eq(Math.round(r.value.duration * 10) / 10, 19.9);
    eq(r.value.isLive, false);
});

t('parse captures EXT-X-MAP — without it fMP4 output is unplayable', () => {
    const m = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
s0.m4s
#EXT-X-ENDLIST`;
    const r = parse(m, 'https://x.com/v/');
    ok(r.value.map, 'EXT-X-MAP ignored — this is the v1 headerless-fragment bug');
    eq(r.value.map.url, 'https://x.com/v/init.mp4');
});

t('parse resolves an omitted BYTERANGE offset from the previous sub-range (RFC 8216 §4.3.2.2)', () => {
    const r = parse([
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10,', '#EXT-X-BYTERANGE:1000@0', 'one.ts',
        '#EXTINF:10,', '#EXT-X-BYTERANGE:2000', 'one.ts',
        '#EXTINF:10,', '#EXT-X-BYTERANGE:300', 'one.ts',
        '#EXTINF:10,', '#EXT-X-BYTERANGE:50@9000', 'one.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'), 'https://x.com/p/m.m3u8');
    eq(r.value.segments.map((x) => x.byteRange), ['1000@0', '2000@1000', '300@3000', '50@9000'],
        'v2.0 used offset 0 whenever @offset was omitted, fetching the first bytes for every segment');
});

t('parse keeps a distinct key per segment when EXT-X-KEY rotates', () => {
    const r = parse([
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXT-X-KEY:METHOD=AES-128,URI="k1.key"', '#EXTINF:10,', 'a.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="k2.key"', '#EXTINF:10,', 'b.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'), 'https://x.com/p/m.m3u8');
    eq(r.value.segments.map((x) => x.key.uri), ['https://x.com/p/k1.key', 'https://x.com/p/k2.key']);
});

t('pickAudioRendition resolves a demuxed audio group; muxed groups yield null', () => {
    const audio = [
        { url: 'https://x.com/a/en.m3u8', groupId: 'aud', name: 'English', isDefault: false },
        { url: 'https://x.com/a/es.m3u8', groupId: 'aud', name: 'Spanish', isDefault: true },
        { url: null, groupId: 'muxed', name: 'in-band', isDefault: true },
    ];
    eq(pickAudioRendition(audio, 'aud').name, 'Spanish', 'DEFAULT=YES wins');
    eq(pickAudioRendition(audio, 'muxed'), null, 'a rendition with no URI means audio is in the variant');
    eq(pickAudioRendition(audio, null), null);
    eq(pickAudioRendition([], 'aud'), null);
});

t('codecs helpers tell audio-only variants from video ones', () => {
    ok(!codecsHaveVideo('mp4a.40.2'));
    ok(codecsHaveVideo('avc1.64001f,mp4a.40.2') && codecsHaveVideo('hvc1.1.6.L93.B0') && codecsHaveVideo('av01.0.08M.08'));
    ok(codecsHaveVideo(null), 'absent CODECS is treated as video');
    ok(codecsHaveAudio('avc1.64001f,mp4a.40.2') && !codecsHaveAudio('avc1.64001f'));
});

t('parse handles EXT-X-BYTERANGE', () => {
    const m = `#EXTM3U
#EXTINF:4,
#EXT-X-BYTERANGE:1000@2000
all.ts
#EXT-X-ENDLIST`;
    const r = parse(m, 'https://x.com/v/');
    eq(r.value.segments[0].byteRange, '1000@2000');
});

t('plain AES-128 is treated as downloadable, NOT as DRM', () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
s0.ts
#EXT-X-ENDLIST`;
    const r = parse(m, 'https://x.com/v/');
    eq(r.value.drm, null, 'v1 wrongly reported plain AES-128 as DRM and refused it');
    eq(r.value.segments[0].key.method, 'AES-128');
    eq(r.value.segments[0].key.uri, 'https://x.com/v/key.bin');
});

t('Widevine / FairPlay / SAMPLE-AES are correctly gated as DRM', () => {
    const wv = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="k"
#EXTINF:4,
s.ts`;
    eq(parse(wv, 'https://x.com/').value.drm, 'Widevine');

    const fp = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="k"
#EXTINF:4,
s.ts`;
    eq(parse(fp, 'https://x.com/').value.drm, 'FairPlay');

    const sa = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"
#EXTINF:4,
s.ts`;
    eq(parse(sa, 'https://x.com/').value.drm, 'SAMPLE-AES');
});

t('DRM is detected from the master playlist before any variant is fetched', () => {
    const m = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="k"
#EXT-X-STREAM-INF:BANDWIDTH=1
v.m3u8`;
    eq(parse(m, 'https://x.com/').value.drm, 'Widevine');
});

t('parse rejects non-M3U8 input instead of returning empty', () => {
    const r = parse('<html>not a playlist</html>', 'https://x.com/');
    eq(r.ok, false);
});

t('ivFor derives the IV from the media sequence number when absent', () => {
    // RFC 8216 section 5.2 — v1 had no IV derivation at all.
    const iv = ivFor({ seq: 7, key: { method: 'AES-128' } });
    eq(iv.length, 16);
    eq([...iv.slice(12)], [0, 0, 0, 7], 'sequence number not big-endian in the low 4 bytes');
});

t('ivFor parses an explicit hex IV', () => {
    const iv = ivFor({ seq: 0, key: { iv: '0x000102030405060708090a0b0c0d0e0f' } });
    eq([...iv.slice(0, 4)], [0, 1, 2, 3]);
    eq(iv[15], 15);
});

t('pickVariant honours a height preference without overshooting', () => {
    const vs = [
        { resolution: '1920x1080', bandwidth: 5 },
        { resolution: '1280x720', bandwidth: 3 },
        { resolution: '640x360', bandwidth: 1 },
    ];
    eq(pickVariant(vs, 720).resolution, '1280x720');
    eq(pickVariant(vs, null).resolution, '1920x1080');
    eq(pickVariant(vs, 240).resolution, '640x360', 'should fall back to the smallest available');
});

// ---------------------------------------------------------------------------
// Perceptual hashing
// ---------------------------------------------------------------------------

t('hamming distance is symmetric and zero for identical hashes', () => {
    eq(hamming('0f0f0f0f0f0f0f0f', '0f0f0f0f0f0f0f0f'), 0);
    eq(hamming('ffffffffffffffff', '0000000000000000'), 64);
    eq(hamming('0f0f0f0f0f0f0f0f', '0e0f0f0f0f0f0f0f'), 1);
});

t('hamming treats malformed input as maximally distant, never as a match', () => {
    eq(hamming(null, 'ffffffffffffffff'), 64, 'a null hash must not read as similar');
    eq(hamming('abc', 'abcdef0123456789'), 64);
});

// ---------------------------------------------------------------------------

console.log('');
for (const [tag, name] of results) console.log(`  ${tag} ${name}`);
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
