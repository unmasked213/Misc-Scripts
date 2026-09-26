# Media Downloader v2

A rebuild of the Media Downloader extension. Detects images, video, audio and HLS
streams on any page and downloads them — **with verification**, so it never
reports a failure as a success.

Chrome / Brave / Edge, Manifest V3, **no build step**. Load it unpacked and it runs.

---

## Install

1. Open `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`)
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder
4. Pin it to the toolbar

No `npm install`. No build. The service worker uses native ES modules
(`"type": "module"`); the two content scripts are self-contained because
manifest-declared content scripts cannot be modules.

---

## Use

| | |
|---|---|
| **Alt+Shift+D** | Open the Library |
| **Alt+Shift+S** | Scan the current tab and open the Library |
| Toolbar icon | Launcher — scan this tab / all tabs / open Library |
| Right-click an image or video | Download it directly |

The **Library** is a full browser tab, not a popup. It survives clicking back onto
the page, has room for a real grid, and can hold the user gesture a native save
dialog needs.

**For video: press play once.** Many players only reveal the real media URL when
playback starts. The badge count and the Library list are both derived from the
same persisted store, so they can never disagree.

### Grid

- **Click** select · **Ctrl+click** toggle · **Shift+click** range (in the order
  currently displayed) · **drag on background** marquee (Shift adds, Alt subtracts)
- **Arrows** move · **Space** toggle · **Ctrl+A** select all *filtered* ·
  **Ctrl+Enter** download · **Esc** clear
- Filters **dim** rather than remove, so you can see what your filter did.
  "Hide filtered" if you'd rather they vanish.
- Near-duplicates collapse into one card with a `×N` badge. Nothing is hidden and
  your selection is never silently modified.

### Output template

Edit the template in the footer. Tokens:

```
{site} {host} {pageTitle} {jobName} {stem} {ext} {w} {h} {hash}
{index:04} {date:YYYY-MM-DD}
```

Default: `{site}/{date:YYYY-MM-DD}/{stem}-{w}x{h}.{ext}` — relative to your
Downloads folder. Segments are sanitized for Windows (reserved device names,
illegal characters, trailing dots, path length).

### Preflight

**Preflight** range-probes a sample for real `Content-Length` and `Content-Type`
before you commit. If a host is serving error pages it tells you *before* 400 of
them land on disk.

---

## What changed from v1, and why

### Video downloads work now

v1 fetched every manifest, encryption key and preview from `world: 'MAIN'` — page
script, page origin, subject to a real CORS check — then concluded from the
resulting failures that MV3 made cross-origin media download impossible. It
doesn't. With `host_permissions: <all_urls>`, fetches from extension-privileged
contexts are not CORS-bound, which is exactly why v1's *image* pipeline always
worked: it fetched from the service worker.

All byte movement now happens in an **offscreen document** (extension origin, DOM
available, no 30-second idle death). The page probe observes and reports; it never
fetches.

### Nothing is reported as success without being verified

v1 returned `{success: true}` the moment `chrome.downloads` minted an ID, before a
byte arrived, and its HTML check was a fire-and-forget `setTimeout` whose result
was discarded. A 3 KB error page counted as "1 downloaded".

Every download now passes five checks — terminal state, MIME, plausible size, no
cross-origin redirect, and magic bytes — or it fails with a named reason.
`DownloadItem` exposes no HTTP status code, so magic-byte sniffing is the only way
to catch a 200-with-error-page.

### You can see the results

v1 rendered every summary into `.action-area__progress`, which is
`visibility: hidden; height: 0` unless a download is running. It had been computing
"12 downloaded, 3 failed" and painting it into an invisible box. The transfer bar
is now always visible and segmented by outcome, and failures group by cause with a
strategy-aware retry.

### The grid scales

v1 rebuilt every tile via `innerHTML` on every filter, sort, select-all and *every
tick of the min-size slider*, and used the full-resolution original as each
thumbnail until a real one arrived. The grid is now windowed with node pooling and
stable identity; thumbnails are generated once in the offscreen document at 320px
WebP, and the perceptual hash is computed from that same decoded bitmap — so
hashing costs no extra network and happens *before* the download.

### Other fixes worth naming

- **DNR rule leak.** v1 allocated rule IDs from an in-memory counter but wrote them
  to *persistent dynamic* rules, torn down by a `setTimeout` on a worker Chrome can
  kill. One leak and the ID collided forever, skipping the download entirely.
  Now: session rules, IDs seeded from `getSessionRules()`, teardown in `finally`.
- **AES-128.** v1 passed a plain `Array` where `crypto.subtle.importKey` needs a
  `BufferSource` — a guaranteed `TypeError` whose catch block wrote the
  *ciphertext* to disk and called it success. Keys are `Uint8Array`; failure is loud.
- **`#EXT-X-MAP`** is honoured, so fMP4/CMAF output is playable.
- **Plain AES-128 is not DRM.** Gating is on `KEYFORMAT`, not `METHOD`.
- **URL identity** keeps the query string. v1 discarded it, so on any CDN that
  identifies images by query param, one download poisoned dedup for the whole site.
- **One canonical extractor**, replacing four divergent implementations that
  disagreed about the best URL for the same image.
- **`all_frames: true`** — v1 was top-frame only, so embedded players were invisible.
- **No permanent suppression.** v1's `reportedUrls` Set meant a URL first seen on
  the network could never later be reported as a play confirmation.
- **State survives worker death** (`chrome.storage.session`), and the job queue
  survives a browser restart (`chrome.storage.local`).

---

## What changed in 2.1

A review pass focused on video and audio. Images were left alone apart from
shared code they also run through.

### Audio works

- `details.type === 'media'` covers `<audio>` as well as `<video>`; it was mapped
  to video unconditionally, so every audio file was a "video" that then failed
  verification. The Content-Type now refines it.
- A DOM element's tag corrects a network-derived video/audio kind on an existing
  record; before, the probe's `audio` was discarded if the network saw it first.
- The context menu uses `info.mediaType`; the shared video/audio item always
  produced `video`.
- Container sniffing reads the ftyp brand (M4A/M4B are audio) and treats ISO
  BMFF, Matroska/WebM and Ogg as ambiguous a/v containers accepted for either
  expectation. MP3 frame-sync variants and ADTS AAC are recognised.
- `audio/x-mpegurl` is a playlist, not audio. `<audio><source>` children and
  audio-typed `<video><source>` are scanned.

### Referer actually gets sent

The DNR rule conditioned on `tabIds: [rec.tabId]`. Requests from `chrome.downloads`
and from the offscreen document have no tab (`TAB_ID_NONE`), so the rule could
never match the requests it existed for. It now matches tab-less requests
anchored to the media URL, and both tiers run inside it, since `fetch()` drops
Referer and Origin silently (forbidden header names) and v2.0 was passing them
as fetch headers. Stream jobs use a broad rule (segment hosts are unknown up
front) and are serialised one at a time so two rules cannot collide.

### The ladder stops lying by omission

- A Tier 1 download that fails verification is removed from disk before Tier 2
  runs; it used to stay, with the Tier 2 copy saved as ` (1)`.
- A cross-origin redirect only counts against a file when what came back is not
  media. Most video CDNs redirect; those all failed and re-downloaded.
- Size plausibility uses Content-Length agreement when a length was seen; the
  256 KB floor that rejected every short clip is now a 32 KB fallback for the
  blind case. Content-Range is read on 206 so range-requesting players do not
  record their last chunk as the file size.
- `awaitDownload` polls `downloads.search` every 20 s: `onChanged` does not fire
  for byte progress, so a long Tier 1 download produced nothing to keep the
  worker alive. The `downloadId` is persisted on the job item and re-attached on
  resume instead of re-downloading.
- Tier 2 refuses bodies over 1 GiB with a named `too_large` failure instead of
  growing the offscreen document until it dies.
- Blob URLs are revoked once `chrome.downloads` has consumed them. Nothing ever
  revoked them.
- A re-observed URL replaces the stored one for video/audio/streams, so a rotated
  signed URL is what gets fetched. Images keep first-seen (resize paths share a key).

### Streams

- MSE and EME signals are tab flags shown as a notice line, not records keyed on
  the page URL. Segment responses (`.ts`, `.m4s`, `video/mp2t`, `video/iso.segment`)
  are counted on the tab, not listed as hundreds of videos.
- Every segment is verified: `text/html` is rejected and the first bytes must be
  TS, an ISO BMFF fragment, ADTS or ID3-wrapped audio. An expired token gives
  200 + HTML per segment; that was concatenated and reported as success.
- Demuxed audio renditions (`EXT-X-MEDIA TYPE=AUDIO` with a URI) are downloaded
  and saved as a second file, `<name>.audio.m4a`, with a note in the ledger. Without
  a muxer that is the honest output; muxing is the Tier 3 helper's job. Audio-only
  variants are named `.m4a` / `.aac`.
- Keys are fetched per URI and cached, so rotating `EXT-X-KEY` decrypts correctly.
- `EXT-X-BYTERANGE` without `@offset` continues from the previous sub-range.
- Cancel reaches the segment pool and any `chrome.downloads` item in flight.
- A playlist without `EXT-X-ENDLIST` is downloaded as listed and noted as such.
- Streams named `master`/`index`/`playlist` take the page title as their stem.

---

## Development

```bash
node check.mjs
```

Resolves every import to a real file, verifies every named import exists, catches
duplicate bindings, and confirms the manifest points at files that exist. A bad
specifier kills an MV3 service worker at load with nothing but a red dot on the
extensions page, so run this after any refactor.

```bash
node test.mjs
```

55 fixture tests over the pure functions — URL identity, Windows filename safety,
magic-byte sniffing, classification, the DNR rule shape, and HLS parsing
(including every corruption bug listed above).

### Layout

```
manifest.json
src/
  shared/      protocol · model · result · url · mime · log   (imported everywhere)
  worker/      service worker — dispatcher only, never a downloader
    detect/    network classification (details.type first, regex last)
    transport/ the ladder, verification, DNR header injection
  offscreen/   the byte mover: fetcher, HLS parse/decrypt, thumbnails
  content/     probe.main.js (observe only) · bridge.iso.js (relay only)
  ui/          library (primary surface) · popup (launcher) · kit (tokens)
```

**Debugging:** `chrome://extensions/` → *Service Worker* for worker logs;
right-click the Library tab → Inspect for UI. The **Diagnostics** button copies a
redacted timeline to the clipboard.

---

## Known gaps

- **DASH (`.mpd`) is not implemented.** Detected and labelled, not downloadable.
- **Tier 3 (native yt-dlp helper) is a seam, not an implementation.** Sites that
  defeat both tiers report a named failure and a hint rather than silently retrying.
- **MSE reconstruction is partial.** The probe detects MSE playback and EME, but
  does not yet rebuild a stream from captured `appendBuffer` calls.
- **Two DNR behaviours are unverified at runtime.** Chrome publishes an allowlist
  for the `append` operation only and no denylist for `set`/`remove`, and no page
  says whether DNR applies to `chrome.downloads`-initiated requests. The 2.1 rule
  shape is the first one that could match those requests at all, so this is now
  a one-off `chrome://net-export` check on a Referer-checking host. If downloads
  turn out not to be covered, Tier 1 cannot carry headers and Tier 2 should be
  promoted for hosts that need them.
- **Demuxed audio is a second file, not a muxed one.** Muxing needs ffmpeg or a
  JS muxer; that is Tier 3.
- **Two stream jobs never run concurrently.** Deliberate: the broad Referer rule
  they need would collide, and one assembled video in memory at a time is the
  right ceiling for an in-memory tier.
- **Nothing here has been run in a browser.** `check.mjs` and `test.mjs` pass;
  the runtime behaviour of the transport changes is untested.
- **Closed shadow roots are invisible** to any extension. Platform limit, stated in
  the UI rather than hidden.
- **No DRM circumvention.** Detected, labelled, refused. Not a gap — a line.
