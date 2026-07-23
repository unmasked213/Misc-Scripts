// ==UserScript==
// @name         Play Visible Videos
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @author       Unmasked213
// @version      1.6.2
// @description  Toggle button auto-plays/pauses videos as they enter/leave view. Per-video download buttons on hover with duplicate prevention. Button immune to browser and pinch zoom.
// @match        *://*/*
// @noframes
// @exclude      file:///*
// @exclude      /^https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|(?:[^./]+\.)+(?:local|home\.arpa))(?::\d+)?(?:[/?#]|$)/
// @exclude      /^https?:\/\/(?:(?:[^./]+\.)*(?:ui\.nabu\.casa|proton\.me|protonmail\.(?:com|ch)|pm\.me|chatgpt\.com|claude\.ai)|chat\.openai\.com)(?::\d+)?\//
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/play_visible_videos.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/play_visible_videos.user.js
// @connect      *
// ==/UserScript==

// EDIT the @match line above to restrict this to your target site(s). Runs on
// http(s) pages only; localhost, private-range IPs (10/172.16-31/192.168) and
// *.local / *.home.arpa are excluded so LAN devices are left alone.
//
// Button behaviour:
//   - Neutral = feature off. Pink = feature on.
//   - Toggling on plays currently visible videos and tracks visibility from then on.
//   - The toggle click is also the user interaction browsers require before
//     programmatic playback is permitted, so autoplay works from that point.
//     WebKit (Safari/iOS) may still reject audible playback started from the async
//     IntersectionObserver callback rather than directly in the click; rejections
//     are swallowed. Keyboard: the toggle is focusable and Enter/Space activates it.
//
// Visibility uses IntersectionObserver (threshold 0, i.e. any intersection counts,
// not strict pixel visibility), so browser zoom (Ctrl +/-) and scroll are handled
// natively. New videos are picked up and removed ones released via MutationObserver.
//
// Not covered: pinch-zoom pan, videos injected into existing shadow roots after
// load, cross-origin iframe videos, closed shadow roots. One download button per
// parent element (multiple videos sharing a parent get a single button).
//
// Downloads: hover any light-DOM video for a download button. Only genuine user
// clicks act (synthetic page-dispatched clicks are ignored), since a download can
// reach any host. By default HTTP(S) media uses an in-page chunked
// GM_xmlhttpRequest engine: amber ring, click to pause/resume, buffered in memory
// (so capped at 2 GiB), transient chunk errors (network/timeout/429/5xx) retried
// once, and it dies if the tab closes. Set PREFER_NATIVE = true (below) to use
// browser-managed GM_download instead: pink ring, survives tab close/refresh,
// streams to disk, pause via the browser's own downloads UI, URL recorded as
// downloaded optimistically at start (rolled back if failure is seen while the
// page lives), falling back to the in-page engine on error. Native requires the
// manager's download mode set to Browser API / native downloads. The
// downloaded-URL ledger is userscript-global (GM storage) so dedup spans sites and
// the page cannot read or clear it. Ordinary blob: and data: sources are
// supported; MediaSource/MSE blob URLs and .m3u8 / .mpd manifests are not files.

(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (document.getElementById('vvp-play-btn')) return;

  var BASE = 72;
  var MARGIN = 16;
  var refDPR = window.devicePixelRatio || 1;
  var enabled = false;

  // Download path. false = in-page engine (works everywhere GM_xmlhttpRequest
  // does; pausable via the ring; buffers in memory; dies with the tab). true =
  // browser-managed GM_download (survives tab close/refresh, streams to disk,
  // pause via the browser's own downloads UI) - REQUIRES the userscript manager's
  // download mode set to "Browser API" (Tampermonkey) / native downloads
  // (Violentmonkey). If native silently produces nothing, leave this false.
  var PREFER_NATIVE = false;

  // --- styles (foreign page: inline injection with !important is required) ---
  var style = document.createElement('style');
  style.textContent =
    '#vvp-play-btn{' +
      'position:fixed !important;left:0 !important;top:0 !important;' +
      'width:' + BASE + 'px !important;height:' + BASE + 'px !important;' +
      'margin:0 !important;padding:0 !important;box-sizing:border-box !important;' +
      'transform-origin:0 0 !important;z-index:2147483647 !important;' +
      'display:flex !important;align-items:center !important;justify-content:center !important;' +
      'border-radius:999px !important;background:rgba(18,18,22,0.92) !important;' +
      'border:1px solid rgba(255,255,255,0.14) !important;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.45) !important;' +
      'cursor:pointer !important;pointer-events:auto !important;' +
      '-webkit-tap-highlight-color:transparent !important;' +
      'transition:background 120ms cubic-bezier(0.2,0,0.2,1),' +
        'border-color 120ms cubic-bezier(0.2,0,0.2,1),' +
        'box-shadow 120ms cubic-bezier(0.2,0,0.2,1) !important;' +
    '}' +
    '#vvp-play-btn:hover{background:rgba(28,28,34,0.96) !important;' +
      'border-color:rgba(255,255,255,0.22) !important;}' +
    '#vvp-play-btn svg{width:30px !important;height:30px !important;display:block !important;}' +
    '#vvp-play-btn svg path{fill:rgba(255,255,255,0.92) !important;}' +
    '#vvp-play-btn.vvp-on{border-color:rgb(255,46,146) !important;' +
      'box-shadow:0 0 0 3px rgba(255,46,146,0.30),0 6px 20px rgba(0,0,0,0.45) !important;}' +
    '#vvp-play-btn.vvp-on svg path{fill:rgb(255,46,146) !important;}';
  (document.head || document.documentElement).appendChild(style);

  // --- button ---
  var btn = document.createElement('div');
  btn.id = 'vvp-play-btn';
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', 'Auto-play visible videos');
  btn.setAttribute('title', 'Auto-play visible videos');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8 5v14l11-7z"/></svg>';
  document.documentElement.appendChild(btn);

  // --- button position + zoom correction (independent of video tracking) ---
  function update() {
    var dpr = window.devicePixelRatio || 1;
    var vv = window.visualViewport;
    var scale = vv ? vv.scale : 1;
    var offX = vv ? vv.offsetLeft : 0;
    var offY = vv ? vv.offsetTop : 0;
    var vw = vv ? vv.width : window.innerWidth;
    var vh = vv ? vv.height : window.innerHeight;

    var s = (refDPR / dpr) / scale;
    var x = offX + vw - s * (BASE + MARGIN);
    var y = offY + vh - s * (BASE + MARGIN);
    btn.style.setProperty(
      'transform',
      'translate(' + x + 'px,' + y + 'px) scale(' + s + ')',
      'important'
    );
  }

  var ticking = false;
  function schedule() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      update();
    });
  }

  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule, { passive: true });
    window.visualViewport.addEventListener('scroll', schedule, { passive: true });
  }
  update();

  // --- collect videos across light DOM and open shadow roots ---
  function collectVideos(root, out) {
    var nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch (e) {
      return;
    }

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.tagName === 'VIDEO') out.push(el);
      if (el.shadowRoot) collectVideos(el.shadowRoot, out);
    }
  }

  // --- play on enter view, pause on leave ---
  function onIntersect(entries) {
    if (!enabled) return;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var video = entry.target;

      if (entry.isIntersecting) {
        var playResult = video.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(function () {});
        }
      } else if (document.pictureInPictureElement !== video) {
        video.pause();
      }
    }
  }

  var io = new IntersectionObserver(onIntersect, { threshold: 0 });

  function scanAndObserve(node) {
    if (node.tagName === 'VIDEO') io.observe(node);

    var found = [];
    collectVideos(node, found);
    for (var i = 0; i < found.length; i++) io.observe(found[i]);
  }

  function scanAndUnobserve(node) {
    if (node.tagName === 'VIDEO') io.unobserve(node);

    var found = [];
    collectVideos(node, found);
    for (var i = 0; i < found.length; i++) io.unobserve(found[i]);
  }

  // --- pick up videos added after load (lazy feeds, infinite scroll) and
  //     release ones removed, so detached elements are not retained ---
  var mo = new MutationObserver(function (records) {
    if (!enabled) return;

    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) scanAndObserve(added[j]);
      }

      var removed = records[i].removedNodes;
      for (var k = 0; k < removed.length; k++) {
        if (removed[k].nodeType === 1) scanAndUnobserve(removed[k]);
      }
    }
  });

  function enable() {
    var videos = [];
    collectVideos(document, videos);
    for (var i = 0; i < videos.length; i++) io.observe(videos[i]);

    mo.observe(document.documentElement, { childList: true, subtree: true });
    btn.classList.add('vvp-on');
    btn.setAttribute('aria-pressed', 'true');
  }

  function disable() {
    io.disconnect();
    mo.disconnect();
    btn.classList.remove('vvp-on');
    btn.setAttribute('aria-pressed', 'false');
  }

  function toggleFeature() {
    enabled = !enabled;
    if (enabled) enable();
    else disable();
  }

  // --- toggle (trusted input only: block synthetic page-driven activation) ---
  btn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    toggleFeature();
  });

  btn.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    toggleFeature();
  });

  // ===================== Download buttons (always on) =====================

  var dlStyle = document.createElement('style');
  dlStyle.textContent =
    '.vvp-fab-positioned{position:relative !important;}' +
    '.vvp-fab{' +
      'position:absolute !important;top:8px !important;right:8px !important;' +
      'width:54px !important;height:54px !important;border-radius:50% !important;' +
      'border:0 !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;' +
      'display:flex !important;align-items:center !important;justify-content:center !important;' +
      'font:600 24px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;' +
      'cursor:pointer !important;z-index:2147483646 !important;overflow:hidden !important;' +
      'opacity:0 !important;pointer-events:none !important;touch-action:manipulation !important;' +
      'background:rgb(255,46,146) !important;color:rgb(28,8,18) !important;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.6) !important;' +
      'transition:opacity 120ms cubic-bezier(0.2,0,0.2,1),' +
        'transform 120ms cubic-bezier(0.2,0,0.2,1) !important;' +
    '}' +
    '.vvp-fab-host:hover>.vvp-fab{opacity:1 !important;pointer-events:auto !important;}' +
    '.vvp-fab:hover{transform:scale(1.1) !important;}' +
    '.vvp-fab:active{transform:scale(0.92) !important;}' +
    '.vvp-fab[data-st="downloading"],.vvp-fab[data-st="paused"],.vvp-fab[data-st="done"],.vvp-fab[data-st="error"]{' +
      'opacity:1 !important;pointer-events:auto !important;' +
    '}' +
    '.vvp-fab[data-st="downloading"]{' +
      'background:conic-gradient(' +
        'rgb(255,46,146) var(--vvp-prog,0%),' +
        'rgba(255,255,255,0.14) var(--vvp-prog,0%)' +
      ') !important;' +
    '}' +
    '.vvp-fab[data-st="paused"]{' +
      'background:conic-gradient(' +
        'rgba(255,46,146,0.45) var(--vvp-prog,0%),' +
        'rgba(255,255,255,0.10) var(--vvp-prog,0%)' +
      ') !important;' +
    '}' +
    '.vvp-fab-page[data-st="downloading"]{' +
      'background:conic-gradient(' +
        'rgb(255,178,54) var(--vvp-prog,0%),' +
        'rgba(255,255,255,0.14) var(--vvp-prog,0%)' +
      ') !important;' +
    '}' +
    '.vvp-fab-page[data-st="paused"]{' +
      'background:conic-gradient(' +
        'rgba(255,178,54,0.45) var(--vvp-prog,0%),' +
        'rgba(255,255,255,0.10) var(--vvp-prog,0%)' +
      ') !important;' +
    '}' +
    '.vvp-fab[data-st="downloading"]::after,.vvp-fab[data-st="paused"]::after{' +
      'content:"" !important;position:absolute !important;' +
      'inset:6px !important;border-radius:50% !important;' +
      'background:rgb(18,18,22) !important;' +
    '}' +
    '.vvp-fab .vvp-pct{' +
      'position:relative !important;z-index:1 !important;' +
      'font:700 13.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;' +
      'color:rgb(240,240,246) !important;' +
    '}' +
    '.vvp-fab[data-st="done"]{' +
      'background:rgb(0,162,103) !important;color:rgb(240,240,246) !important;' +
    '}' +
    '.vvp-fab[data-st="error"]{' +
      'background:rgb(255,113,100) !important;color:rgb(240,240,246) !important;' +
    '}';
  (document.head || document.documentElement).appendChild(dlStyle);

  var DL_KEY = 'vvp_downloaded';
  var DL_MAX = 500;
  var dlDone;
  var activeDownloads = new Map();

  var hasGMStore =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function loadDone() {
    var raw;
    try {
      raw = hasGMStore
        ? GM_getValue(DL_KEY, '[]')
        : localStorage.getItem(DL_KEY) || '[]';
      var parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (e) {
      return new Set();
    }
  }

  dlDone = loadDone();

  function saveDone() {
    var values = Array.from(dlDone);
    if (values.length > DL_MAX) {
      values = values.slice(values.length - DL_MAX);
      dlDone = new Set(values);
    }

    try {
      var raw = JSON.stringify(values);
      if (hasGMStore) GM_setValue(DL_KEY, raw);
      else localStorage.setItem(DL_KEY, raw);
    } catch (e) {}
  }

  function isHttp(url) {
    return /^https?:\/\//i.test(url || '');
  }

  function isLocalUrl(url) {
    return /^(?:blob:|data:)/i.test(url || '');
  }

  function absoluteUrl(rawUrl) {
    if (!rawUrl) return '';

    try {
      return new URL(rawUrl, location.href).href;
    } catch (e) {
      return '';
    }
  }

  function videoUrl(video) {
    var candidates = [];

    var current = video.currentSrc || '';
    if (current) candidates.push(current);

    var attr = absoluteUrl(video.getAttribute('src'));
    if (attr) candidates.push(attr);

    var sources = video.querySelectorAll('source[src]');
    for (var i = 0; i < sources.length; i++) {
      var src = absoluteUrl(sources[i].getAttribute('src'));
      if (src) candidates.push(src);
    }

    // Downloadable network URLs win over blob:/data: (MSE blobs are not files).
    for (var h = 0; h < candidates.length; h++) {
      if (isHttp(candidates[h])) return candidates[h];
    }
    for (var l = 0; l < candidates.length; l++) {
      if (isLocalUrl(candidates[l])) return candidates[l];
    }

    return '';
  }

  function headerValue(headers, name) {
    var match = String(headers || '').match(
      new RegExp('^' + name + ':\\s*(.+)$', 'im')
    );
    return match ? match[1].trim() : '';
  }

  function filenameFromDisposition(disposition) {
    if (!disposition) return '';

    var match = disposition.match(
      /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i
    );

    if (match) {
      var encoded = match[1].trim().replace(/^"|"$/g, '');
      try {
        return decodeURIComponent(encoded);
      } catch (e) {
        return encoded;
      }
    }

    match =
      disposition.match(/filename\s*=\s*"([^"]+)"/i) ||
      disposition.match(/filename\s*=\s*([^;]+)/i);

    return match ? match[1].trim() : '';
  }

  function extensionFromMime(mimeType) {
    var mime = String(mimeType || '')
      .toLowerCase()
      .split(';')[0]
      .trim();

    var extensions = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/ogg': 'ogv',
      'application/ogg': 'ogg',
      'video/quicktime': 'mov',
      'video/x-m4v': 'm4v',
      'video/x-matroska': 'mkv',
      'video/mp2t': 'ts',
      'application/vnd.apple.mpegurl': 'm3u8',
      'application/x-mpegurl': 'm3u8',
      'application/dash+xml': 'mpd'
    };

    return extensions[mime] || '';
  }

  function videoMime(video, url) {
    try {
      var parsed = new URL(url);
      var queryMime =
        parsed.searchParams.get('mime') ||
        parsed.searchParams.get('type');

      if (queryMime) return queryMime;
    } catch (e) {}

    var sources = video.querySelectorAll('source');
    for (var i = 0; i < sources.length; i++) {
      if (absoluteUrl(sources[i].getAttribute('src')) === url) {
        return sources[i].getAttribute('type') || '';
      }
    }

    return '';
  }

  function safeFilename(value) {
    var safe = String(value || 'video')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();

    return safe || 'video';
  }

  function mediaFilename(url, video, mimeType, disposition) {
    var name = filenameFromDisposition(disposition);

    if (!name && isHttp(url)) {
      try {
        var path = new URL(url).pathname;
        name = decodeURIComponent(
          path.substring(path.lastIndexOf('/') + 1)
        );
      } catch (e) {}
    }

    name = safeFilename(name || 'video');

    if (
      !/\.(?:mp4|m4v|webm|mov|ogv|ogg|mkv|avi|flv|ts|m3u8|mpd)$/i.test(
        name
      )
    ) {
      name +=
        '.' +
        (
          extensionFromMime(mimeType || videoMime(video, url)) ||
          'mp4'
        );
    }

    return safeFilename(name);
  }

  function saveBlob(blob, filename) {
    var objectUrl = URL.createObjectURL(blob);
    var anchor = document.createElement('a');

    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';

    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();

    setTimeout(function () {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    }, 60000);
  }

  function setReady(fab) {
    fab.classList.remove('vvp-fab-page');
    fab.style.removeProperty('--vvp-prog');
    fab.textContent = '\u2193';
    fab.setAttribute('data-st', 'ready');
    fab.setAttribute('title', 'Download video');
    fab._vvpPercent = null;
  }

  function setDownloading(fab, indeterminate) {
    fab.setAttribute('data-st', 'downloading');
    fab.setAttribute('title', 'Downloading video');
    fab.textContent = '';
    fab.style.setProperty(
      '--vvp-prog',
      indeterminate ? '100%' : '0%'
    );

    var percent = document.createElement('span');
    percent.className = 'vvp-pct';
    percent.textContent = indeterminate ? '\u2026' : '0%';

    fab.appendChild(percent);
    fab._vvpPercent = percent;
  }

  function setDone(fab) {
    fab.classList.remove('vvp-fab-page');
    fab.style.removeProperty('--vvp-prog');
    fab.textContent = '\u2713';
    fab.setAttribute('data-st', 'done');
    fab.setAttribute('title', 'Downloaded');
    fab._vvpPercent = null;
  }

  function setError(fab, message) {
    fab.classList.remove('vvp-fab-page');
    fab.style.removeProperty('--vvp-prog');
    fab.textContent = '!';
    fab.setAttribute('data-st', 'error');
    fab.setAttribute(
      'title',
      message || 'Download failed. Click to retry.'
    );
    fab._vvpPercent = null;
  }

  function updateProgress(fab, url, progress) {
    if (fab._vvpUrl !== url || !fab._vvpPercent) return;

    var loaded = Number(progress && progress.loaded) || 0;
    var total = Number(progress && progress.total) || 0;

    if (!total) {
      fab._vvpPercent.textContent = '\u2026';
      return;
    }

    var value = Math.max(
      0,
      Math.min(100, Math.round(loaded / total * 100))
    );

    fab.style.setProperty('--vvp-prog', value + '%');
    fab._vvpPercent.textContent = value + '%';
  }

  function complete(fab, url) {
    activeDownloads.delete(url);
    dlDone.add(url);
    saveDone();

    if (fab._vvpUrl === url) setDone(fab);
  }

  function fail(fab, url, message, error) {
    activeDownloads.delete(url);

    if (fab._vvpUrl === url) setError(fab, message);

    console.warn(
      '[VVP] ' + message,
      error || '',
      url
    );
  }

  var CHUNK_SIZE = 4 * 1024 * 1024;
  var CHUNK_TIMEOUT = 120000;
  // In-page transfers buffer the whole file in memory before saving, so cap the
  // size this path will attempt. Native downloads (the primary path) stream to
  // disk and are not subject to this.
  var MAX_INPAGE_BYTES = 2 * 1024 * 1024 * 1024;

  function formatBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + 'M';
    if (n >= 1024) return Math.round(n / 1024) + 'K';
    return (n || 0) + 'B';
  }

  function updateChunkProgress(fab, chunkLoaded) {
    if (!fab._vvpActive || fab._vvpPaused || !fab._vvpPercent) return;

    var total = fab._vvpTotal;
    var loaded = fab._vvpOffset + (Number(chunkLoaded) || 0);

    if (!total) {
      // No Content-Range from the server: show downloaded size so a live
      // transfer is visibly distinct from a stalled one.
      fab.style.setProperty('--vvp-prog', '0%');
      fab._vvpPercent.textContent = formatBytes(loaded);
      return;
    }

    var value = Math.max(0, Math.min(100, Math.round(loaded / total * 100)));
    fab.style.setProperty('--vvp-prog', value + '%');
    fab._vvpPercent.textContent = value + '%';
  }

  function setPaused(fab) {
    fab.setAttribute('data-st', 'paused');
    fab.setAttribute('title', 'Paused - click to resume');
    fab.textContent = '';

    var glyph = document.createElement('span');
    glyph.className = 'vvp-pct';
    glyph.textContent = '\u275A\u275A';

    fab.appendChild(glyph);
    fab._vvpPercent = glyph;
  }

  function finalizeStream(fab, url) {
    fab._vvpActive = false;
    fab._vvpXhr = null;

    try {
      var blob = new Blob(
        fab._vvpChunks,
        { type: fab._vvpType || 'application/octet-stream' }
      );

      saveBlob(
        blob,
        mediaFilename(
          fab._vvpFinalUrl || url,
          fab._vvpVideo,
          fab._vvpType,
          fab._vvpDisposition
        )
      );

      fab._vvpChunks = null;
      complete(fab, url);
    } catch (error) {
      fab._vvpChunks = null;
      fail(fab, url, 'Could not save the downloaded media.', error);
    }
  }

  // Terminal failure with buffer/handle release and no retry.
  function hardStop(fab, url, message, error) {
    fab._vvpActive = false;
    fab._vvpChunks = null;
    fab._vvpXhr = null;
    fail(fab, url, message, error);
  }

  function streamChunk(fab, url) {
    if (!fab._vvpActive || fab._vvpPaused) return;

    var start = fab._vvpOffset;

    if (fab._vvpTotal && start >= fab._vvpTotal) {
      finalizeStream(fab, url);
      return;
    }

    var end = fab._vvpTotal
      ? Math.min(start + CHUNK_SIZE, fab._vvpTotal) - 1
      : start + CHUNK_SIZE - 1;

    var token = ++fab._vvpToken;
    var done = false;

    function stale() {
      return token !== fab._vvpToken || !fab._vvpActive || fab._vvpPaused;
    }

    function chunkFail(message, error, status) {
      if (done) return;
      done = true;

      // Auth-ish rejection before any data: retry once without Referer.
      if (
        fab._vvpReferer &&
        fab._vvpOffset === 0 &&
        (!status || status === 400 || status === 401 || status === 403)
      ) {
        fab._vvpReferer = false;
        streamChunk(fab, url);
        return;
      }

      // Transient failure (network drop, timeout, 429, or 5xx): retry once.
      if (
        (!status || status === 429 || (status >= 500 && status < 600)) &&
        !fab._vvpRetried
      ) {
        fab._vvpRetried = true;
        streamChunk(fab, url);
        return;
      }

      hardStop(fab, url, message, error);
    }

    var details = {
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: CHUNK_TIMEOUT,
      headers: { Range: 'bytes=' + start + '-' + end },

      onprogress: function (progress) {
        if (token !== fab._vvpToken) return;
        updateChunkProgress(fab, progress && progress.loaded);
      },

      onload: function (response) {
        if (done || stale()) {
          done = true;
          return;
        }

        var status = Number(response.status) || 0;
        var data = response.response;
        var bytes = data && typeof data.byteLength === 'number' ? data.byteLength : 0;
        var contentType = headerValue(response.responseHeaders, 'content-type');
        var disposition = headerValue(response.responseHeaders, 'content-disposition');
        var errorDocument =
          /^(?:text\/html|application\/(?:json|xml)|text\/xml)/i.test(contentType);

        // 416: only legitimate when we already hold the whole file. Confirm the
        // server's reported total matches our byte count before finalising;
        // otherwise this is a genuine rejection, not EOF.
        if (status === 416) {
          var satisfiedRange = headerValue(response.responseHeaders, 'content-range');
          var satisfiedTotal = satisfiedRange.match(/\/\s*(\d+)\s*$/);

          if (
            fab._vvpChunks &&
            fab._vvpChunks.length &&
            satisfiedTotal &&
            Number(satisfiedTotal[1]) === fab._vvpOffset
          ) {
            done = true;
            finalizeStream(fab, url);
          } else {
            chunkFail('Requested range not satisfiable.', { status: status }, status);
          }
          return;
        }

        var ok =
          (status === 206 || status === 200 || status === 0) &&
          bytes > 0 &&
          !errorDocument;

        if (!ok) {
          chunkFail(
            'Media request rejected.',
            { status: status, contentType: contentType },
            status
          );
          return;
        }

        if (status === 206) {
          var range = headerValue(response.responseHeaders, 'content-range');
          var rangeMatch = range.match(/bytes\s+(\d+)-\d+\/(\d+|\*)/i);

          if (rangeMatch) {
            if (Number(rangeMatch[1]) !== start) {
              chunkFail(
                'Server returned the wrong byte range.',
                { expected: start, range: range },
                status
              );
              return;
            }

            if (!fab._vvpTotal && rangeMatch[2] !== '*') {
              fab._vvpTotal = Number(rangeMatch[2]);
            }
          }

          if (fab._vvpTotal > MAX_INPAGE_BYTES) {
            done = true;
            hardStop(
              fab,
              url,
              'File is too large for in-page download; use the browser download.',
              { total: fab._vvpTotal }
            );
            return;
          }
        }

        done = true;
        fab._vvpRetried = false;

        if (!fab._vvpType) fab._vvpType = contentType;
        if (!fab._vvpDisposition) fab._vvpDisposition = disposition;
        if (!fab._vvpFinalUrl) fab._vvpFinalUrl = response.finalUrl || url;

        fab._vvpChunks.push(data);
        fab._vvpOffset += bytes;

        if (fab._vvpOffset > MAX_INPAGE_BYTES) {
          hardStop(
            fab,
            url,
            'File is too large for in-page download; use the browser download.',
            { received: fab._vvpOffset }
          );
          return;
        }

        // Non-partial success: the server ignored Range and sent the whole file.
        if (status !== 206) {
          finalizeStream(fab, url);
          return;
        }

        updateChunkProgress(fab, 0);

        var reachedEnd =
          (fab._vvpTotal && fab._vvpOffset >= fab._vvpTotal) ||
          bytes < (end - start + 1);

        if (reachedEnd) finalizeStream(fab, url);
        else streamChunk(fab, url);
      },

      onerror: function (error) {
        if (stale()) {
          done = true;
          return;
        }
        chunkFail('Media request failed.', error, Number(error && error.status) || 0);
      },

      ontimeout: function (error) {
        if (stale()) {
          done = true;
          return;
        }
        chunkFail('Media request timed out.', error, Number(error && error.status) || 0);
      }
    };

    if (fab._vvpReferer && /^https?:/i.test(location.href)) {
      details.headers.Referer = location.href.split('#')[0];
    }

    try {
      fab._vvpXhr = GM_xmlhttpRequest(details);
    } catch (error) {
      chunkFail('Media request could not be started.', error, 0);
    }
  }

  // In-page engine: default path and native's fallback. Pausable, buffered in
  // memory, dies with the tab.
  function streamDownload(url, video, fab) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      fail(
        fab,
        url,
        'No download API available in this userscript manager.'
      );
      return;
    }

    fab._vvpVideo = video;
    fab._vvpChunks = [];
    fab._vvpOffset = 0;
    fab._vvpTotal = 0;
    fab._vvpPaused = false;
    fab._vvpActive = true;
    fab._vvpReferer = true;
    fab._vvpRetried = false;
    fab._vvpPausable = true;
    fab._vvpToken = 0;
    fab._vvpXhr = null;
    fab._vvpType = '';
    fab._vvpDisposition = '';
    fab._vvpFinalUrl = '';

    fab.classList.add('vvp-fab-page');
    setDownloading(fab, false);
    fab.setAttribute(
      'title',
      'Downloading in page - click to pause. Keep this tab open.'
    );
    streamChunk(fab, url);
  }

  function pauseDownload(fab) {
    if (!fab._vvpActive || fab._vvpPaused) return;

    fab._vvpPaused = true;
    fab._vvpToken++;

    var xhr = fab._vvpXhr;
    if (xhr && typeof xhr.abort === 'function') {
      try {
        xhr.abort();
      } catch (e) {}
    }
    fab._vvpXhr = null;

    setPaused(fab);
  }

  function resumeDownload(fab, url) {
    if (!fab._vvpActive || !fab._vvpPaused) return;

    fab._vvpPaused = false;
    setDownloading(fab, false);
    fab.setAttribute(
      'title',
      'Downloading in page - click to pause. Keep this tab open.'
    );
    updateChunkProgress(fab, 0);
    streamChunk(fab, url);
  }

  // Primary path: browser-managed download. Survives tab close/refresh and
  // streams to disk. The URL is recorded as done at start so duplicate
  // prevention holds even when the tab closes mid-transfer; rolled back only
  // if failure is witnessed while the page is still alive.
  function nativeDownload(url, video, fab) {
    fab._vvpPausable = false;
    fab.classList.remove('vvp-fab-page');
    setDownloading(fab, false);
    fab.setAttribute(
      'title',
      'Downloading via browser - safe to close this tab.'
    );

    if (typeof GM_download !== 'function') {
      streamDownload(url, video, fab);
      return;
    }

    var finished = false;
    var fallbackStarted = false;

    function rollback() {
      if (dlDone.delete(url)) saveDone();
    }

    function fallback(error) {
      if (finished || fallbackStarted) return;

      fallbackStarted = true;
      rollback();

      console.warn(
        '[VVP] Native download failed; falling back to in-page transfer.',
        error || '',
        url
      );

      streamDownload(url, video, fab);
    }

    var details = {
      url: url,
      name: mediaFilename(url, video, '', ''),

      onprogress: function (progress) {
        if (!finished && !fallbackStarted) {
          updateProgress(fab, url, progress);
        }
      },

      onload: function () {
        if (finished || fallbackStarted) return;

        finished = true;
        complete(fab, url);
      },

      onerror: fallback,
      ontimeout: fallback
    };

    if (/^https?:/i.test(location.href)) {
      details.headers = {
        Referer: location.href.split('#')[0]
      };
    }

    dlDone.add(url);
    saveDone();

    try {
      GM_download(details);
    } catch (error) {
      fallback(error);
    }
  }

  function localDownload(url, video, fab) {
    var settled = false;

    var guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      fail(
        fab,
        url,
        'Blob did not resolve to a file; it is likely a MediaSource stream.',
        null
      );
    }, 15000);

    fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }

        return response.blob();
      })
      .then(function (blob) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);

        if (!blob.size) {
          fail(fab, url, 'Blob source is empty or not a downloadable file.', null);
          return;
        }

        saveBlob(
          blob,
          mediaFilename(url, video, blob.type, '')
        );

        complete(fab, url);
      })
      .catch(function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);

        fail(
          fab,
          url,
          'Blob source is not downloadable. It may be a MediaSource stream.',
          error
        );
      });
  }

  function startDownload(url, video, fab) {
    if (dlDone.has(url)) {
      setDone(fab);
      return;
    }

    var owner = activeDownloads.get(url);

    if (owner && owner !== fab) {
      var ownerState = owner.getAttribute('data-st');
      var ownerLive =
        owner.isConnected &&
        (ownerState === 'downloading' || ownerState === 'paused');

      if (ownerLive) return;

      // Owner fab left the DOM (SPA navigation): strand its callbacks
      // and release the URL so it can be downloaded again.
      owner._vvpActive = false;
      owner._vvpPaused = false;
      owner._vvpChunks = null;
      if (owner._vvpToken) owner._vvpToken++;
    }

    activeDownloads.set(url, fab);
    fab._vvpUrl = url;

    if (isHttp(url)) {
      if (PREFER_NATIVE) nativeDownload(url, video, fab);
      else streamDownload(url, video, fab);
    } else if (isLocalUrl(url)) {
      fab._vvpPausable = false;
      setDownloading(fab, true);
      localDownload(url, video, fab);
    } else {
      fail(
        fab,
        url,
        'No downloadable media URL found.'
      );
    }
  }

  function buildFab(video) {
    var fab = document.createElement('button');

    fab.className = 'vvp-fab';
    fab.type = 'button';
    fab._vvpUrl = videoUrl(video);
    fab._vvpVideoEl = video;
    fab._vvpPercent = null;

    if (fab._vvpUrl && dlDone.has(fab._vvpUrl)) {
      setDone(fab);
    } else {
      setReady(fab);
    }

    fab.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
    });

    fab.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();

      // Block synthetic page-driven activation of a privileged download.
      if (!event.isTrusted) return;

      var state = fab.getAttribute('data-st');

      // Active transfers own their URL; the click toggles pause/resume.
      if (state === 'downloading') {
        if (fab._vvpPausable) pauseDownload(fab);
        return;
      }

      if (state === 'paused') {
        resumeDownload(fab, fab._vvpUrl);
        return;
      }

      // Idle states: re-evaluate the element's current source. A reused <video>
      // (SPA/feed) or an externally-changed ledger must not strand the button.
      var url = videoUrl(video);

      if (url !== fab._vvpUrl) {
        fab._vvpUrl = url;

        if (url && dlDone.has(url)) {
          setDone(fab);
          return;
        }

        setReady(fab);
      } else if (state === 'done') {
        if (url && dlDone.has(url)) return;
        setReady(fab);
      }

      if (!url) {
        setError(
          fab,
          'No downloadable media URL found.'
        );

        console.warn(
          '[VVP] No media URL found.',
          {
            currentSrc: video.currentSrc,
            src: video.getAttribute('src')
          }
        );

        return;
      }

      startDownload(url, video, fab);
    });

    return fab;
  }

  function directFab(host) {
    for (
      var child = host.firstElementChild;
      child;
      child = child.nextElementSibling
    ) {
      if (
        child.classList &&
        child.classList.contains('vvp-fab')
      ) {
        return child;
      }
    }

    return null;
  }

  function attachFabTo(video) {
    var host = video.parentElement;
    if (!host || directFab(host)) return;

    if (getComputedStyle(host).position === 'static') {
      host.classList.add('vvp-fab-positioned');
    }

    host.classList.add('vvp-fab-host');

    var fab = buildFab(video);
    video._vvpFab = fab;
    host.appendChild(fab);
  }

  function attachFabsIn(node) {
    if (node.tagName === 'VIDEO') attachFabTo(node);

    var found = [];
    collectVideos(node, found);
    for (var i = 0; i < found.length; i++) attachFabTo(found[i]);
  }

  // Remove a FAB whose <video> has left the DOM, aborting any transfer it owned,
  // so a later video reusing the same host does not inherit stale state. Reached
  // via the video's own back-reference, since a detached node has no parent.
  function detachFabsIn(node) {
    var videos = [];
    if (node.tagName === 'VIDEO') videos.push(node);
    collectVideos(node, videos);

    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var fab = video._vvpFab;
      if (!fab || fab._vvpVideoEl !== video) continue;

      fab._vvpActive = false;
      if (fab._vvpXhr && typeof fab._vvpXhr.abort === 'function') {
        try {
          fab._vvpXhr.abort();
        } catch (e) {}
      }

      if (fab._vvpUrl && activeDownloads.get(fab._vvpUrl) === fab) {
        activeDownloads.delete(fab._vvpUrl);
      }

      fab._vvpChunks = null;
      fab._vvpVideoEl = null;
      video._vvpFab = null;

      var host = fab.parentNode;
      if (host) {
        host.removeChild(fab);
        if (host.classList) {
          host.classList.remove('vvp-fab-host', 'vvp-fab-positioned');
        }
      }
    }
  }

  function initialFabScan() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) attachFabTo(videos[i]);
  }

  // Incremental: act on added/removed subtrees only. No full-document rescan, so
  // a continuously mutating feed neither triggers repeated scans nor starves a
  // debounce that never fires.
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var target = record.target;

      // Ignore our own button's internal mutations (progress text, etc.).
      if (target.nodeType === 1 && target.closest && target.closest('.vvp-fab')) {
        continue;
      }

      var added = record.addedNodes;
      for (var a = 0; a < added.length; a++) {
        if (added[a].nodeType === 1) attachFabsIn(added[a]);
      }

      var removed = record.removedNodes;
      for (var r = 0; r < removed.length; r++) {
        if (removed[r].nodeType === 1) detachFabsIn(removed[r]);
      }
    }
  }).observe(
    document.documentElement,
    {
      childList: true,
      subtree: true
    }
  );

  initialFabScan();
})();