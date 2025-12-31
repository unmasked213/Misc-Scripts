# Video Download Problem - Context Document

## Problem Summary

A Chrome extension (Manifest V3) can detect when a user plays a video on a webpage, but **cannot download the actual video file**. Instead, downloads return an HTML error page. Preview also fails with CORS errors.

This affects both:
1. **Progressive MP4 videos** - Direct video file URLs
2. **HLS streaming videos** - `.m3u8` manifest-based streams

The browser's native `<video>` element plays both types successfully, proving the URLs and authentication are valid when the browser makes the request normally.

---

## Technical Environment

- **Extension Type**: Chrome Manifest V3 browser extension
- **Browser**: Chromium-based (Chrome, Brave, Edge)
- **Target**: Progressive MP4 videos served from CDNs (cross-origin from the page)
- **Files**: Located in `browser_extensions/media-downloader-extension/`

---

## What Works

1. **Video Detection**: The extension successfully detects when a video plays via:
   - Content script (`intercept.js`) in MAIN world monitors `<video>` element events
   - `webRequest.onCompleted` listener captures network requests with video MIME types
   - The video URL (e.g., `https://cdn.example.com/video.mp4?token=xxx`) is captured correctly

2. **Badge Update**: Extension badge shows "1" when a video is detected

3. **UI Flow**: User can open popup, see detected videos, click to preview or download

---

## What Fails

### Download Failure
- `chrome.downloads.download({ url: videoUrl })` initiates a download
- The downloaded file is HTML (an error page), not the video
- File size is small (~few KB) instead of expected video size (MB)
- The server is rejecting the request and returning an error page

### Preview Failure
- XHR/fetch from page context (MAIN world) fails with CORS error
- Error message: "Preview blocked (CORS)"
- The video CDN does not send `Access-Control-Allow-Origin` headers

### HLS Stream Download Failure
- HLS videos are now detected and shown in the UI (v1.7 fix)
- However, downloading HLS streams also fails
- The `downloadHLSStream()` function uses `fetch()` in MAIN world to get manifest
- Same CORS issue applies - the `.m3u8` manifest fetch is blocked
- Even if manifest fetch worked, each `.ts` segment would also be blocked by CORS

---

## Root Cause Analysis

### Why the `<video>` element works but programmatic download fails:

1. **Browser's `<video>` element uses "opaque" responses**: When the browser's media element requests a video, it doesn't require CORS headers. The response is "opaque" - the browser can play it but JavaScript cannot access the bytes.

2. **Cross-origin restrictions**: The video is hosted on a CDN (different domain than the page). Any JavaScript attempt to fetch this URL is blocked by CORS unless the server explicitly allows it.

3. **Missing request context**: When `chrome.downloads.download()` makes its request, it may be missing:
   - The correct `Referer` header (server may check this)
   - Session cookies for the CDN domain
   - Other headers the server expects

4. **Token/session validation**: The video URL contains query parameters (likely auth tokens). The server may validate:
   - Token hasn't expired
   - Request comes from expected referer
   - Request has valid session context

---

## Approaches Tried (All Failed)

### 1. Direct `chrome.downloads.download()`
```javascript
chrome.downloads.download({
    url: videoUrl,
    filename: 'video.mp4'
});
```
**Result**: Downloads HTML error page, not video.
**Why it fails**: The download request doesn't carry the page's authentication context.

---

### 2. XHR in MAIN World with `withCredentials`
```javascript
// Injected into page via chrome.scripting.executeScript with world: 'MAIN'
const xhr = new XMLHttpRequest();
xhr.open('GET', videoUrl, true);
xhr.responseType = 'blob';
xhr.withCredentials = true;
xhr.send();
```
**Result**: CORS error - request blocked.
**Why it fails**: Even in the page's context, cross-origin XHR requires the server to send CORS headers. Video CDNs typically don't.

---

### 3. Fetch in MAIN World with `credentials: 'include'`
```javascript
// Injected into page via chrome.scripting.executeScript with world: 'MAIN'
const response = await fetch(videoUrl, {
    credentials: 'include'
});
```
**Result**: CORS error - request blocked.
**Why it fails**: Same as XHR - fetch is also subject to CORS.

---

### 4. Anchor Element Click with `download` Attribute
```javascript
// Injected into page
const a = document.createElement('a');
a.href = videoUrl;
a.download = 'video.mp4';
document.body.appendChild(a);
a.click();
```
**Result**: Either navigates to URL (showing error page) or downloads HTML.
**Why it fails**: The `download` attribute is ignored for cross-origin URLs. Browser treats it as navigation.

---

### 5. Convert to Base64 via XHR, then Data URL Download
```javascript
// If XHR succeeded (which it doesn't due to CORS):
const blob = xhr.response;
const reader = new FileReader();
reader.readAsDataURL(blob);
// Then download via data:video/mp4;base64,...
```
**Result**: Never gets past XHR step due to CORS.
**Why it fails**: Can't get the blob in the first place.

---

### 6. `declarativeNetRequest` to Add Referer Header
```javascript
chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
        id: ruleId,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{
                header: 'Referer',
                operation: 'set',
                value: pageUrl
            }]
        },
        condition: {
            urlFilter: videoUrlPattern,
            resourceTypes: ['media', 'other']
        }
    }]
});
// Then trigger chrome.downloads.download()
```
**Result**: Still downloads HTML.
**Why it fails**: Referer header alone isn't sufficient. Server likely checks other factors (cookies, session, token validity).

---

### 7. Service Worker Fetch
```javascript
// In background.js service worker
const response = await fetch(videoUrl, {
    credentials: 'include'
});
```
**Result**: 403 Forbidden or HTML error page.
**Why it fails**: Service worker doesn't have access to the page's cookies for the CDN domain.

---

### 8. HLS Download via Fetch in MAIN World (for streaming videos)
```javascript
// In downloadHLSStream() - injected into page via chrome.scripting.executeScript
const results = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    world: 'MAIN',
    func: async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return { error: `HTTP ${response.status}` };
        return { text: await response.text(), finalUrl: response.url };
    },
    args: [manifestUrl]
});
```
**Result**: CORS error when fetching `.m3u8` manifest.
**Why it fails**: Same CORS restriction as progressive videos. The HLS manifest and all `.ts` segments are cross-origin, and the CDN doesn't send CORS headers.

**Note**: v1.7 fixed HLS videos being excluded from the actionable list (they were filtered out by `!record.isStream` checks). But even though they now appear in the UI, the actual download still fails due to CORS.

---

## Key Constraints

1. **Manifest V3 Limitations**:
   - Cannot use `webRequestBlocking` (was available in MV2)
   - Cannot intercept and modify responses
   - Service workers have limited context

2. **CORS is Server-Side**:
   - Cannot be bypassed by client-side code
   - Server must send `Access-Control-Allow-Origin` header
   - Video CDNs typically don't send these headers

3. **Cookie Isolation**:
   - Cookies are domain-specific
   - Extension context doesn't automatically share cookies with page context
   - `chrome.downloads` may not send cookies for cross-origin domains

4. **No Access to Video Bytes from `<video>` Element**:
   - Even though the video plays, JavaScript cannot access the decoded video data
   - `captureStream()` could theoretically record it, but that's real-time (slow for long videos)

---

## What Might Work (Unexplored or Partially Explored)

### 1. MediaRecorder / captureStream()
Record the video as it plays using `video.captureStream()` and `MediaRecorder`.
- **Pros**: Bypasses CORS entirely since we're recording playback
- **Cons**: Real-time only (30min video = 30min to "download"), quality loss from re-encoding

### 2. Native Messaging Host
A separate native application that the extension communicates with, which makes the HTTP request outside the browser's security model.
- **Pros**: Full control over HTTP requests
- **Cons**: Requires user to install separate software, complex setup

### 3. Proxy Server
Route requests through a proxy that adds necessary headers/cookies.
- **Pros**: Can modify requests freely
- **Cons**: Requires external server, introduces latency, may not have user's cookies

### 4. Browser's Native "Save Video As"
Right-click on video → "Save video as..." works because it uses the browser's internal download mechanism with full context.
- **Pros**: Works reliably
- **Cons**: Cannot be triggered programmatically by extension

### 5. DevTools Protocol / Debugger API
Use `chrome.debugger` API to attach to the tab and intercept network responses.
- **Pros**: Can access response bodies
- **Cons**: Requires user permission each time, shows debug banner, complex

### 6. Check if URL is Same-Origin
If the video URL happens to be same-origin with the page, XHR would work.
- **Reality**: Most video CDNs are cross-origin, so this rarely helps

### 7. Find Embedded Player API
Some video players expose download URLs through their JavaScript API.
- **Pros**: Gets URL that might work differently
- **Cons**: Site-specific, not generalizable

---

## File Structure

```
browser_extensions/media-downloader-extension/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker - download logic, message handling
├── popup.html/js/css    # Extension popup UI
├── intercept.js         # Content script (MAIN world) - monitors video events
├── bridge.js            # Content script (ISOLATED world) - relays messages
└── icons/               # Extension icons
```

---

## Relevant Code Sections

### Video Detection (intercept.js)
- Monitors `play`, `playing`, `loadeddata` events on `<video>` elements
- Polls `video.currentSrc` every 250ms after play (handles async URL assignment)
- Reports video URL to background via CustomEvent → bridge → chrome.runtime.sendMessage

### Download Function (background.js:downloadProgressiveVideo)
- Currently uses `chrome.downloads.download()` with `declarativeNetRequest` for Referer
- Location: ~line 580-710

### HLS Download Function (background.js:downloadHLSStream)
- Fetches `.m3u8` manifest via `fetch()` in MAIN world
- Parses manifest to find segments
- Downloads each `.ts` segment and concatenates
- Location: ~line 1485-1650
- **Current status**: Fails at manifest fetch due to CORS

### Preview Function (background.js:fetchPreviewSnippet)
- Injects XHR into page's MAIN world
- Location: ~line 720-850

---

## Questions for Further Investigation

1. **What exactly does the server check?** Network inspection of a successful browser request vs failed extension request would reveal header differences.

2. **Are there cookies being sent by the browser that the extension doesn't have access to?** Check `chrome://settings/cookies` for the CDN domain.

3. **Does the video URL work if opened directly in a new tab?** This would indicate if the URL itself has expired or if it's a header/cookie issue.

4. **Is there a same-origin endpoint that proxies the video?** Some sites have their own proxy to avoid CORS issues.

5. **What's the actual error page content?** Reading the downloaded HTML might reveal what check is failing.

---

## Summary

The fundamental issue is that **cross-origin video downloads require server cooperation** (CORS headers), which video CDNs don't provide. The browser's `<video>` element bypasses this through opaque responses, but there's no JavaScript API to access those bytes.

This affects both video types:
- **Progressive MP4**: Single file download blocked by CORS
- **HLS Streams**: Manifest fetch blocked by CORS (and even if it worked, each segment would be blocked too)

This is a deliberate browser security feature, not a bug. Potential solutions require either:
- Real-time recording (slow, quality loss)
- Native application (complex setup)
- Server-side changes (not possible for third-party sites)
- Browser internals access (debugger API, intrusive)

The most practical solution for users may be to document how to use the browser's built-in "Save video as..." right-click option, which works reliably.

---

## Comparison with Cococut Extension

The user reports that "Cococut" extension can download HLS videos successfully. Investigation needed:
- How does Cococut bypass CORS restrictions?
- Does it use a different approach (e.g., native messaging, debugger API)?
- Is it a Manifest V2 extension with `webRequestBlocking`?
- Does it capture video data differently (e.g., from browser cache, media source buffer)?

Understanding Cococut's approach could reveal a viable solution.
