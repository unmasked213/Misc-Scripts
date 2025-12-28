// ==UserScript==
// @name         Reddit to Redlib Redirector
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      5.0
// @description  Automatically redirects Reddit URLs to working Redlib instances with hybrid auto-discovery, caching, and smart fallback
// @author       Unmasked213
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ===============================
       CONFIGURATION
       =============================== */

    const CONFIG = {
        // Absolute fallback if all else fails
        defaultInstance: 'https://redlib.seasi.dev',

        // Static fallbacks when cache is empty
        fallbackInstances: [
            'https://redlib.seasi.dev',
            'https://rl.bloat.cat',
            'https://redlib.freedit.eu',
            'https://redlib.perennialte.ch',
        ],

        // Canonical instance list maintained by Redlib project
        instanceSourceUrl: 'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',

        // Timing
        cacheTtlMs: 60 * 60 * 1000,     // 1 hour
        redirectTimeoutMs: 700,          // Health check timeout for redirects
        discoveryTimeoutMs: 2000,        // Health check timeout for background discovery
        fetchTimeoutMs: 5000,            // Instance list fetch timeout

        // Limits
        maxCachedInstances: 10,
    };

    const STORAGE_KEYS = {
        workingInstances: 'redlib_working_instances',
        lastWorking: 'redlib_last_working',
        lastCheck: 'redlib_last_check',
        redirectAttempts: 'redlib_redirect_attempts',
    };

    /* ===============================
       ENTRY POINT
       =============================== */

    redirect();
    refreshInstancesInBackground();

    /* ===============================
       REDIRECT LOGIC
       =============================== */

    function redirect() {
        const path = location.href.replace(/^https?:\/\/(www\.|old\.)?reddit\.com/, '');
        const candidates = getCachedInstances() || CONFIG.fallbackInstances;
        const preferred = getPreferredInstance(candidates);

        redirectWithHealthCheck(preferred, path);
    }

    function getPreferredInstance(instances) {
        const lastWorking = localStorage.getItem(STORAGE_KEYS.lastWorking);
        return (lastWorking && instances.includes(lastWorking)) ? lastWorking : instances[0];
    }

    function redirectWithHealthCheck(instance, path) {
        const attempts = getAttempts();

        if (attempts.includes(instance)) {
            tryNextInstance(path, attempts);
            return;
        }

        recordAttempt(instance, attempts);

        const fallbackTimer = setTimeout(() => tryNextInstance(path, attempts), CONFIG.redirectTimeoutMs + 100);

        const handleFailure = () => {
            clearTimeout(fallbackTimer);
            tryNextInstance(path, attempts);
        };

        GM_xmlhttpRequest({
            method: 'HEAD',
            url: instance,
            timeout: CONFIG.redirectTimeoutMs,
            onload: response => {
                clearTimeout(fallbackTimer);
                if (isSuccessStatus(response.status)) {
                    localStorage.setItem(STORAGE_KEYS.lastWorking, instance);
                    location.replace(instance + path);
                } else {
                    tryNextInstance(path, attempts);
                }
            },
            onerror: handleFailure,
            ontimeout: handleFailure,
        });
    }

    function tryNextInstance(path, attempts) {
        const pool = getCachedInstances() || CONFIG.fallbackInstances;
        const next = pool.find(i => !attempts.includes(i));

        if (next) {
            redirectWithHealthCheck(next, path);
        } else {
            location.replace((pool[0] || CONFIG.defaultInstance) + path);
        }
    }

    /* ===============================
       INSTANCE DISCOVERY
       =============================== */

    function refreshInstancesInBackground() {
        const lastCheck = Number(localStorage.getItem(STORAGE_KEYS.lastCheck) || 0);
        if (Date.now() - lastCheck < CONFIG.cacheTtlMs) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: CONFIG.instanceSourceUrl,
            timeout: CONFIG.fetchTimeoutMs,
            onload: response => {
                try {
                    const urls = parseInstanceUrls(JSON.parse(response.responseText));
                    if (urls.length) validateAndCacheInstances(urls);
                } catch {
                    // Malformed response; skip this refresh cycle
                }
            },
        });
    }

    function parseInstanceUrls(json) {
        const clearnet = json?.instances?.clearnet;
        if (!Array.isArray(clearnet)) return [];

        return clearnet
            .map(entry => entry.url)
            .filter(url => typeof url === 'string' && url.startsWith('https://'))
            .map(url => url.replace(/\/$/, ''));
    }

    function validateAndCacheInstances(instances) {
        const results = [];
        let pending = instances.length;
        let saved = false;

        const save = () => {
            if (saved || !results.length) return;
            saved = true;

            const lastWorking = localStorage.getItem(STORAGE_KEYS.lastWorking);

            const sorted = results
                .sort((a, b) => a.time - b.time)
                .map(r => r.instance)
                .slice(0, CONFIG.maxCachedInstances);

            // Boost last-working instance to top if present
            if (lastWorking && sorted.includes(lastWorking)) {
                const idx = sorted.indexOf(lastWorking);
                sorted.splice(idx, 1);
                sorted.unshift(lastWorking);
            }

            localStorage.setItem(STORAGE_KEYS.workingInstances, JSON.stringify(sorted));
            localStorage.setItem(STORAGE_KEYS.lastCheck, Date.now().toString());
        };

        const handleResult = (instance, success, time) => {
            if (saved) return;
            if (success) results.push({ instance, time });
            if (--pending === 0) save();
        };

        instances.forEach(instance => {
            const start = performance.now();

            GM_xmlhttpRequest({
                method: 'HEAD',
                url: instance,
                timeout: CONFIG.discoveryTimeoutMs,
                onload: r => handleResult(instance, isSuccessStatus(r.status), performance.now() - start),
                onerror: () => handleResult(instance, false, 0),
                ontimeout: () => handleResult(instance, false, 0),
            });
        });
    }

    /* ===============================
       UTILITIES
       =============================== */

    function isSuccessStatus(status) {
        return status >= 200 && status < 400;
    }

    function getCachedInstances() {
        try {
            const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.workingInstances) || '[]');
            return cached.length ? cached : null;
        } catch {
            return null;
        }
    }

    function getAttempts() {
        try {
            return JSON.parse(sessionStorage.getItem(STORAGE_KEYS.redirectAttempts) || '[]');
        } catch {
            return [];
        }
    }

    function recordAttempt(instance, attempts) {
        attempts.push(instance);
        sessionStorage.setItem(STORAGE_KEYS.redirectAttempts, JSON.stringify(attempts));
    }

})();