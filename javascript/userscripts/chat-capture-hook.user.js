// ==UserScript==
// @name         Chat Capture - claude.ai hook
// @namespace    cam.ai-stack
// @version      0.1.0
// @description  Page-context observer. Reads completion streams already delivered to this browser and hands raw turns to the courier over postMessage. Originates no requests.
// @author       Cam
// @match        https://claude.ai/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

/* Manager-agnostic by construction: no GM APIs, no unsafeWindow, no sandbox.
   @grant none puts this in page context in both Tampermonkey and Violentmonkey,
   which is the only place a window.fetch patch is guaranteed to bind to the
   fetch the application actually calls. */

(function () {
  'use strict';

  var CHANNEL = 'cam-chat-capture';
  var SOURCE = 'claude';
  var MAX_BYTES = 8 * 1024 * 1024;

  var origFetch = window.fetch;
  if (typeof origFetch !== 'function' || origFetch.__camCapture) return;

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) { /* fall through */ }
    return '';
  }

  function methodOf(input, init) {
    var m = (init && init.method) || (input && input.method) || 'GET';
    return String(m).toUpperCase();
  }

  function conversationIdOf(url) {
    var m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url || '');
    return m ? m[1] : null;
  }

  function newId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function requestBodyPromise(input, init) {
    var b = init && init.body;
    if (typeof b === 'string') return Promise.resolve(b);
    try {
      if (input && typeof input.clone === 'function' && input.body) {
        return input.clone().text().catch(function () { return null; });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(null);
  }

  function emit(record) {
    try {
      window.postMessage(
        { channel: CHANNEL, record: JSON.stringify(record) },
        window.location.origin
      );
    } catch (e) { /* a failed emit must never surface to the page */ }
  }

  function drain(stream, meta) {
    var reader = stream.getReader();
    var decoder = new TextDecoder();
    var out = '';
    var bytes = 0;
    var truncated = false;

    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          out += decoder.decode();
          return;
        }
        bytes += r.value.byteLength;
        if (bytes > MAX_BYTES) {
          truncated = true;
        } else {
          out += decoder.decode(r.value, { stream: true });
        }
        return step();
      });
    }

    return step().catch(function (err) {
      meta.error = String((err && err.message) || err);
    }).then(function () {
      meta.finished_at = new Date().toISOString();
      meta.truncated = truncated;
      meta.bytes = bytes;
      meta.response_raw = out;
      emit(meta);
    });
  }

  var wrapped = function (input, init) {
    var method = methodOf(input, init);
    var url = urlOf(input);
    var reqBody = method === 'POST' ? requestBodyPromise(input, init) : null;

    return origFetch.apply(this, arguments).then(function (res) {
      try {
        if (method !== 'POST' || !res || !res.ok || !res.body || res.bodyUsed) return res;
        var ctype = res.headers.get('content-type') || '';
        if (ctype.toLowerCase().indexOf('text/event-stream') === -1) return res;

        // clone() rather than tee() so the application keeps the original
        // Response object, with its url, type and redirected flags intact.
        var copy = res.clone();
        var meta = {
          v: 1,
          capture_id: newId(),
          source: SOURCE,
          url: url,
          conversation_id: conversationIdOf(url) || conversationIdOf(window.location.pathname),
          started_at: new Date().toISOString(),
          request_body: null
        };

        (reqBody || Promise.resolve(null)).then(function (body) {
          meta.request_body = body;
          return drain(copy.body, meta);
        });
      } catch (e) { /* never let capture affect the application path */ }
      return res;
    });
  };

  wrapped.__camCapture = true;
  try {
    Object.defineProperty(wrapped, 'name', { value: 'fetch' });
    Object.defineProperty(wrapped, 'length', { value: origFetch.length });
  } catch (e) { /* cosmetic only */ }

  window.fetch = wrapped;
})();
