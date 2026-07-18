// ==UserScript==
// @name         Play Visible Videos
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      1.3.0
// @description  Toggle button auto-plays/pauses videos as they enter/leave view. Per-video download buttons on hover with duplicate prevention. Button immune to browser and pinch zoom.
// @author       Unmasked213
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/play_visible_videos.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/play_visible_videos.user.js
// ==/UserScript==

// EDIT the @match line above to restrict this to your target site(s).
//
// Button behaviour:
//   - Neutral = feature off. Pink = feature on.
//   - Toggling on plays currently visible videos and tracks visibility from then on.
//   - The toggle click is also the user interaction browsers require before
//     programmatic playback is permitted, so autoplay works from that point.
//
// Visibility uses IntersectionObserver, so browser zoom (Ctrl +/-) and scroll
// are handled natively and cheaply. New videos (lazy-loaded feeds) are picked up
// via MutationObserver.
//
// Not covered: pinch-zoom pan (IntersectionObserver tracks the layout viewport,
// not the visual one), videos injected into existing shadow roots after load,
// cross-origin iframe videos, closed shadow roots.
//
// Downloads: hover any light-DOM video for a download button. HTTP(S) media uses
// GM_download first and a binary GM_xmlhttpRequest fallback. Ordinary blob: and
// data: sources are supported. MediaSource/MSE blob URLs are not complete files.

(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (document.getElementById('vvp-play-btn')) return;

  var BASE = 144;
  var MARGIN = 16;
  var refDPR = window.devicePixelRatio || 1;
  var enabled = false;

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
    '#vvp-play-btn svg{width:60px !important;height:60px !important;display:block !important;}' +
    '#vvp-play-btn svg path{fill:rgba(255,255,255,0.92) !important;}' +
    '#vvp-play-btn.vvp-on{border-color:rgb(255,46,146) !important;' +
      'box-shadow:0 0 0 3px rgba(255,46,146,0.30),0 6px 20px rgba(0,0,0,0.45) !important;}' +
    '#vvp-play-btn.vvp-on svg path{fill:rgb(255,46,146) !important;}';
  (document.head || document.documentElement).appendChild(style);

  // --- button ---
  var btn = document.createElement('div');
  btn.id = 'vvp-play-btn';
  btn.setAttribute('role', 'button');
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

  // --- pick up videos added after load (lazy feeds, infinite scroll) ---
  var mo = new MutationObserver(function (records) {
    if (!enabled) return;

    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType === 1) scanAndObserve(node);
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

  // --- toggle ---
  btn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    enabled = !enabled;
    if (enabled) enable();
    else disable();
  });

  // ===================== Download buttons (always on) =====================

  var dlStyle = document.createElement('style');
  dlStyle.textContent =
    '.vvp-fab-positioned{position:relative !important;}' +
    '.vvp-fab{' +
      'position:absolute !important;top:8px !important;right:8px !important;' +
      'width:108px !important;height:108px !important;border-radius:50% !important;' +
      'border:0 !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;' +
      'display:flex !important;align-items:center !important;justify-content:center !important;' +
      'font:600 48px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;' +
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
    '.vvp-fab[data-st="downloading"],.vvp-fab[data-st="done"],.vvp-fab[data-st="error"]{' +
      'opacity:1 !important;pointer-events:auto !important;' +
    '}' +
    '.vvp-fab[data-st="downloading"]{' +
      'pointer-events:none !important;color:rgb(240,240,246) !important;' +
      'background:conic-gradient(' +
        'rgb(255,46,146) var(--vvp-prog,0%),' +
        'rgba(255,255,255,0.14) var(--vvp-prog,0%)' +
      ') !important;' +
    '}' +
    '.vvp-fab[data-st="downloading"]::after{' +
      'content:"" !important;position:absolute !important;' +
      'inset:12px !important;border-radius:50% !important;' +
      'background:rgb(18,18,22) !important;' +
    '}' +
    '.vvp-fab .vvp-pct{' +
      'position:relative !important;z-index:1 !important;' +
      'font:700 27px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;' +
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
  var activeDownloads = new Set();

  try {
    var stored = JSON.parse(localStorage.getItem(DL_KEY) || '[]');
    dlDone = new Set(Array.isArray(stored) ? stored : []);
  } catch (e) {
    dlDone = new Set();
  }

  function saveDone() {
    var values = Array.from(dlDone);
    if (values.length > DL_MAX) {
      values = values.slice(values.length - DL_MAX);
      dlDone = new Set(values);
    }

    try {
      localStorage.setItem(DL_KEY, JSON.stringify(values));
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
    var current = video.currentSrc || '';
    if (isHttp(current) || isLocalUrl(current)) return current;

    var direct = absoluteUrl(video.getAttribute('src'));
    if (isHttp(direct) || isLocalUrl(direct)) return direct;

    var sources = video.querySelectorAll('source[src]');
    for (var i = 0; i < sources.length; i++) {
      direct = absoluteUrl(sources[i].getAttribute('src'));
      if (isHttp(direct) || isLocalUrl(direct)) return direct;
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
    fab.style.removeProperty('--vvp-prog');
    fab.textContent = '\u2713';
    fab.setAttribute('data-st', 'done');
    fab.setAttribute('title', 'Downloaded');
    fab._vvpPercent = null;
  }

  function setError(fab, message) {
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

  function xhrDownload(url, video, fab, withReferer) {
    var finished = false;

    function retryOrFail(message, error, status) {
      if (finished) return;
      finished = true;

      if (
        withReferer &&
        (!status || status === 400 || status === 401 || status === 403)
      ) {
        xhrDownload(url, video, fab, false);
      } else {
        fail(fab, url, message, error);
      }
    }

    var details = {
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',

      onprogress: function (progress) {
        updateProgress(fab, url, progress);
      },

      onload: function (response) {
        if (finished) return;

        var status = Number(response.status) || 0;
        var data = response.response;
        var responseIsBlob =
          data &&
          typeof data.size === 'number' &&
          typeof data.slice === 'function';

        var size = responseIsBlob
          ? data.size
          : (
            data && typeof data.byteLength === 'number'
              ? data.byteLength
              : 0
          );

        var contentType = headerValue(
          response.responseHeaders,
          'content-type'
        );

        var disposition = headerValue(
          response.responseHeaders,
          'content-disposition'
        );

        var accepted =
          (
            (status >= 200 && status < 300) ||
            status === 0
          ) &&
          size > 0;

        var errorDocument =
          /^(?:text\/html|application\/(?:json|xml)|text\/xml)/i.test(
            contentType
          );

        if (!accepted || errorDocument) {
          retryOrFail(
            'Media request rejected.',
            {
              status: status,
              contentType: contentType
            },
            status
          );
          return;
        }

        finished = true;

        try {
          var blob = responseIsBlob
            ? data
            : new Blob(
              [data],
              {
                type: contentType || 'application/octet-stream'
              }
            );

          saveBlob(
            blob,
            mediaFilename(
              response.finalUrl || url,
              video,
              contentType,
              disposition
            )
          );

          complete(fab, url);
        } catch (error) {
          fail(
            fab,
            url,
            'Could not save the downloaded media.',
            error
          );
        }
      },

      onerror: function (error) {
        retryOrFail(
          'Media request failed.',
          error,
          Number(error && error.status) || 0
        );
      },

      ontimeout: function (error) {
        retryOrFail(
          'Media request timed out.',
          error,
          Number(error && error.status) || 0
        );
      }
    };

    if (withReferer && /^https?:/i.test(location.href)) {
      details.headers = {
        Referer: location.href.split('#')[0]
      };
    }

    try {
      GM_xmlhttpRequest(details);
    } catch (error) {
      retryOrFail(
        'Media request could not be started.',
        error,
        0
      );
    }
  }

  function httpDownload(url, video, fab) {
    var fallbackStarted = false;
    var finished = false;

    function fallback(error) {
      if (fallbackStarted || finished) return;

      fallbackStarted = true;

      if (error) {
        console.warn(
          '[VVP] GM_download failed; using XHR fallback.',
          error
        );
      }

      xhrDownload(url, video, fab, true);
    }

    if (typeof GM_download !== 'function') {
      fallback();
      return;
    }

    var details = {
      url: url,
      name: mediaFilename(url, video, '', ''),

      onprogress: function (progress) {
        if (!fallbackStarted) {
          updateProgress(fab, url, progress);
        }
      },

      onload: function () {
        if (fallbackStarted || finished) return;

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

    try {
      GM_download(details);
    } catch (error) {
      fallback(error);
    }
  }

  function localDownload(url, video, fab) {
    fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }

        return response.blob();
      })
      .then(function (blob) {
        if (!blob.size) {
          throw new Error('Empty media blob');
        }

        saveBlob(
          blob,
          mediaFilename(url, video, blob.type, '')
        );

        complete(fab, url);
      })
      .catch(function (error) {
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

    if (activeDownloads.has(url)) return;

    activeDownloads.add(url);
    fab._vvpUrl = url;

    if (isHttp(url)) {
      setDownloading(fab, false);
      httpDownload(url, video, fab);
    } else if (isLocalUrl(url)) {
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

      var url = videoUrl(video);

      if (url !== fab._vvpUrl) {
        fab._vvpUrl = url;

        if (url && dlDone.has(url)) {
          setDone(fab);
        } else {
          setReady(fab);
        }
      }

      var state = fab.getAttribute('data-st');

      if (state === 'downloading' || state === 'done') {
        return;
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

  function attachFabs() {
    var videos = document.querySelectorAll('video');

    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var host = video.parentElement;

      if (!host || directFab(host)) continue;

      if (getComputedStyle(host).position === 'static') {
        host.classList.add('vvp-fab-positioned');
      }

      host.classList.add('vvp-fab-host');
      host.appendChild(buildFab(video));
    }
  }

  var fabTimer;

  new MutationObserver(function () {
    clearTimeout(fabTimer);
    fabTimer = setTimeout(attachFabs, 300);
  }).observe(
    document.documentElement,
    {
      childList: true,
      subtree: true
    }
  );

  attachFabs();
})();