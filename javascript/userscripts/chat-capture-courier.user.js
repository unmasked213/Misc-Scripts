// ==UserScript==
// @name         Chat Capture - courier
// @namespace    cam.ai-stack
// @version      0.1.0
// @description  Receives captured turns from the page-context hook and delivers them to the Home Assistant chat_capture endpoint, with a durable retry queue.
// @author       Cam
// @match        https://claude.ai/*
// @run-at       document-start
// @noframes
// @connect      192.168.4.101
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/* Split from the hook deliberately. GM_xmlhttpRequest runs in the extension
   context, which is what lets an HTTPS page POST to a plain-HTTP LAN address
   without tripping Chrome's mixed-content block, and it sidesteps CORS. The
   cost of a grant is a sandbox, which is why the fetch patch lives in the
   other file. Every GM call here is feature-detected so Tampermonkey and
   Violentmonkey both satisfy it. */

(function () {
  'use strict';

  // ---- constants -------------------------------------------------------
  var ENDPOINT = 'http://192.168.4.101:8123/api/chat_capture';
  var TOKEN = 'CHANGE-ME';
  var CHANNEL = 'cam-chat-capture';
  var QUEUE_KEY = 'cam-chat-capture-queue';
  var QUEUE_MAX = 200;
  var BACKOFF_MIN = 3000;
  var BACKOFF_MAX = 300000;
  // ----------------------------------------------------------------------

  var xhr =
    (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
    (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest :
    null;

  if (!xhr) {
    console.warn('[chat-capture] no GM_xmlhttpRequest available; courier idle');
    return;
  }

  function readStore(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (e) { /* fall through */ }
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
    } catch (e) { /* fall through */ }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* queue is best effort */ }
  }

  var queue = readStore(QUEUE_KEY, []);
  if (!Array.isArray(queue)) queue = [];

  var sending = false;
  var backoff = BACKOFF_MIN;
  var timer = null;

  function persist() {
    if (queue.length > QUEUE_MAX) {
      var dropped = queue.length - QUEUE_MAX;
      queue = queue.slice(-QUEUE_MAX);
      console.warn('[chat-capture] queue full, dropped ' + dropped + ' oldest record(s)');
    }
    writeStore(QUEUE_KEY, queue);
  }

  function send(recordJson) {
    return new Promise(function (resolve, reject) {
      xhr({
        method: 'POST',
        url: ENDPOINT,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + TOKEN
        },
        data: recordJson,
        timeout: 30000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) resolve();
          else if (r.status === 400 || r.status === 401 || r.status === 413) reject({ fatal: true, why: 'HTTP ' + r.status });
          else reject({ fatal: false, why: 'HTTP ' + r.status });
        },
        onerror: function () { reject({ fatal: false, why: 'network' }); },
        ontimeout: function () { reject({ fatal: false, why: 'timeout' }); }
      });
    });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; flush(); }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  function flush() {
    if (sending || queue.length === 0) return;
    sending = true;

    send(queue[0]).then(function () {
      queue.shift();
      persist();
      sending = false;
      backoff = BACKOFF_MIN;
      if (queue.length) flush();
    }).catch(function (err) {
      sending = false;
      if (err && err.fatal) {
        console.error('[chat-capture] dropping unsendable record: ' + err.why);
        queue.shift();
        persist();
        flush();
        return;
      }
      console.warn('[chat-capture] delivery failed (' + (err && err.why) + '), retrying');
      schedule();
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.channel !== CHANNEL || typeof d.record !== 'string') return;
    queue.push(d.record);
    persist();
    flush();
  }, false);

  window.addEventListener('online', function () { backoff = BACKOFF_MIN; flush(); }, false);

  flush();
})();
