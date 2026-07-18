// ==UserScript==
// @name         Reddit to Redlib Redirector
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      6.0
// @description  Redirects Reddit URLs to healthy Redlib instances from the upstream instance list
// @author       Unmasked213
// @match        https://reddit.com/*
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @match        https://np.reddit.com/*
// @match        https://m.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// ==/UserScript==


(function () {
    'use strict';

    const CONFIG = Object.freeze({
        sourceUrl: 'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
        sourceCacheTtlMs: 6 * 60 * 60 * 1000,
        healthCacheTtlMs: 30 * 60 * 1000,
        sourceTimeoutMs: 3500,
        healthTimeoutMs: 1800,
        healthConcurrency: 4,
        redirectCheckLimit: 12,
        healthPath: '/settings',
    });

    const STORAGE_KEYS = Object.freeze({
        sourceInstances: 'redlib_redirect_source_instances_v1',
        workingInstances: 'redlib_redirect_working_instances_v1',
        lastWorkingInstance: 'redlib_redirect_last_working_instance_v1',
    });

    const REDDIT_HOST_PATTERN = /^(?:www\.|old\.|new\.|np\.|m\.)?reddit\.com$/i;

    let redirectStarted = false;

    main().catch((error) => {
        console.error('[Redlib Redirector]', error);
    });

    async function main() {
        if (!REDDIT_HOST_PATTERN.test(window.location.hostname)) {
            return;
        }

        const redirectPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const sourceCache = await getCache(STORAGE_KEYS.sourceInstances);
        const workingCache = await getCache(STORAGE_KEYS.workingInstances);
        const lastWorkingInstance = normaliseInstanceUrl(
            await getStoredValue(STORAGE_KEYS.lastWorkingInstance, '')
        );

        const sourceCacheIsFresh = isFreshCache(sourceCache, CONFIG.sourceCacheTtlMs);
        const workingCacheIsFresh = isFreshCache(workingCache, CONFIG.healthCacheTtlMs);

        const sourceRefreshPromise = sourceCacheIsFresh
            ? Promise.resolve(sourceCache.urls)
            : fetchSourceInstances().catch(() => sourceCache?.urls || []);

        const cachedCandidates = uniqueUrls([
            lastWorkingInstance,
            ...(workingCacheIsFresh ? workingCache.urls : []),
            ...(sourceCache?.urls || []),
        ]);

        let selectedInstance = null;

        if (cachedCandidates.length > 0) {
            selectedInstance = await findHealthyInstance(
                cachedCandidates.slice(0, CONFIG.redirectCheckLimit)
            );
        }

        if (!selectedInstance) {
            const sourceInstances = await sourceRefreshPromise;

            selectedInstance = await findHealthyInstance(
                sourceInstances.slice(0, CONFIG.redirectCheckLimit)
            );
        }

        if (!selectedInstance) {
            console.error('[Redlib Redirector] No healthy Redlib instance found.');
            return;
        }

        await rememberWorkingInstance(selectedInstance);
        redirectToInstance(selectedInstance, redirectPath);
    }

    async function fetchSourceInstances() {
        const response = await request({
            method: 'GET',
            url: CONFIG.sourceUrl,
            timeout: CONFIG.sourceTimeoutMs,
            responseType: 'json',
            headers: {
                Accept: 'application/json',
            },
        });

        if (!isSuccessfulStatus(response.status)) {
            throw new Error(`Instance source returned HTTP ${response.status}`);
        }

        const payload = parseJsonResponse(response);
        const urls = extractSourceUrls(payload);

        if (urls.length === 0) {
            throw new Error('Instance source returned no usable HTTPS instances');
        }

        await setCache(STORAGE_KEYS.sourceInstances, {
            updatedAt: Date.now(),
            sourceUpdated: typeof payload.updated === 'string' ? payload.updated : null,
            urls,
        });

        return urls;
    }

    function extractSourceUrls(payload) {
        if (!payload || !Array.isArray(payload.instances)) {
            return [];
        }

        return payload.instances
            .map((instance, index) => ({
                index,
                url: normaliseInstanceUrl(instance?.url),
                score: getInstanceScore(instance),
            }))
            .filter((instance) => instance.url)
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }

                return left.index - right.index;
            })
            .map((instance) => instance.url)
            .filter((url, index, urls) => urls.indexOf(url) === index);
    }

    function getInstanceScore(instance) {
        const description = String(instance?.description || '').toLowerCase();

        let score = 0;

        if (instance?.cloudflare !== true) {
            score += 4;
        }

        if (!description.includes('sfw only')) {
            score += 2;
        }

        return score;
    }

    async function findHealthyInstance(instances) {
        const candidates = uniqueUrls(instances);
        let nextIndex = 0;
        let activeChecks = 0;

        return new Promise((resolve) => {
            const launchNext = () => {
                if (redirectStarted) {
                    resolve(null);
                    return;
                }

                while (activeChecks < CONFIG.healthConcurrency && nextIndex < candidates.length) {
                    const instance = candidates[nextIndex];

                    nextIndex += 1;
                    activeChecks += 1;

                    isHealthyInstance(instance)
                        .then((isHealthy) => {
                            activeChecks -= 1;

                            if (isHealthy && !redirectStarted) {
                                resolve(instance);
                                return;
                            }

                            if (nextIndex >= candidates.length && activeChecks === 0) {
                                resolve(null);
                                return;
                            }

                            launchNext();
                        })
                        .catch(() => {
                            activeChecks -= 1;

                            if (nextIndex >= candidates.length && activeChecks === 0) {
                                resolve(null);
                                return;
                            }

                            launchNext();
                        });
                }

                if (candidates.length === 0) {
                    resolve(null);
                }
            };

            launchNext();
        });
    }

    async function isHealthyInstance(instance) {
        const healthUrl = `${instance}${CONFIG.healthPath}`;

        try {
            const response = await request({
                method: 'GET',
                url: healthUrl,
                timeout: CONFIG.healthTimeoutMs,
                headers: {
                    Accept: 'text/html,application/xhtml+xml',
                },
            });

            return isSuccessfulStatus(response.status);
        } catch {
            return false;
        }
    }

    async function rememberWorkingInstance(instance) {
        const workingCache = await getCache(STORAGE_KEYS.workingInstances);
        const urls = uniqueUrls([instance, ...(workingCache?.urls || [])]);

        await setStoredValue(STORAGE_KEYS.lastWorkingInstance, instance);
        await setCache(STORAGE_KEYS.workingInstances, {
            updatedAt: Date.now(),
            urls,
        });
    }

    function redirectToInstance(instance, redirectPath) {
        redirectStarted = true;
        window.location.replace(`${instance}${redirectPath}`);
    }

    function request(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method,
                url: options.url,
                timeout: options.timeout,
                responseType: options.responseType,
                headers: options.headers,
                anonymous: true,
                onload: resolve,
                onerror: reject,
                ontimeout: reject,
                onabort: reject,
            });
        });
    }

    function parseJsonResponse(response) {
        if (response.response && typeof response.response === 'object') {
            return response.response;
        }

        return JSON.parse(response.responseText || '{}');
    }

    function normaliseInstanceUrl(value) {
        if (typeof value !== 'string' || value.trim() === '') {
            return null;
        }

        try {
            const url = new URL(value.trim());

            if (url.protocol !== 'https:') {
                return null;
            }

            url.pathname = url.pathname.replace(/\/+$/, '');
            url.search = '';
            url.hash = '';

            return url.toString().replace(/\/$/, '');
        } catch {
            return null;
        }
    }

    function uniqueUrls(urls) {
        const seenUrls = new Set();
        const unique = [];

        for (const url of urls) {
            const normalisedUrl = normaliseInstanceUrl(url);

            if (!normalisedUrl || seenUrls.has(normalisedUrl)) {
                continue;
            }

            seenUrls.add(normalisedUrl);
            unique.push(normalisedUrl);
        }

        return unique;
    }

    function isSuccessfulStatus(status) {
        return status >= 200 && status < 400;
    }

    async function getCache(key) {
        const cache = await getStoredValue(key, null);

        if (!cache || !Array.isArray(cache.urls)) {
            return null;
        }

        return {
            ...cache,
            urls: uniqueUrls(cache.urls),
        };
    }

    async function setCache(key, cache) {
        await setStoredValue(key, {
            ...cache,
            urls: uniqueUrls(cache.urls),
        });
    }

    function isFreshCache(cache, ttlMs) {
        return Boolean(
            cache
            && Number.isFinite(cache.updatedAt)
            && Date.now() - cache.updatedAt < ttlMs
            && Array.isArray(cache.urls)
            && cache.urls.length > 0
        );
    }

    async function getStoredValue(key, fallbackValue) {
        try {
            return GM_getValue(key, fallbackValue);
        } catch {
            const rawValue = localStorage.getItem(key);

            if (rawValue === null) {
                return fallbackValue;
            }

            try {
                return JSON.parse(rawValue);
            } catch {
                return fallbackValue;
            }
        }
    }

    async function setStoredValue(key, value) {
        try {
            GM_setValue(key, value);
            return;
        } catch {
            localStorage.setItem(key, JSON.stringify(value));
        }
    }
})();