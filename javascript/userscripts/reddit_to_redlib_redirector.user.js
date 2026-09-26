// ==UserScript==
// @name         Reddit to Redlib Redirector
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      7.0.1
// @description  Stops Reddit immediately, rewrites outgoing Reddit links, and selects verified Redlib instances with bounded failover.
// @author       Unmasked213
// @match        *://*/*
// @noframes
// @inject-into  content
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getResourceText
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @connect      raw.githubusercontent.com
// @connect      *
// @resource     redlibInstances https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_redlib_redirector.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Stop the problematic load BEFORE storage, resource parsing, UI or promises.
    // This cannot undo JavaScript that ran before the userscript was injected.
    const initialRedditUrl = redditUrl(location.href);
    if (initialRedditUrl) window.stop();

    const CONFIG = Object.freeze({
        sourceUrl: 'https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json',
        sourceCacheTtlMs: 6 * 60 * 60 * 1000,
        sourceRetryMs: 60 * 1000,
        healthCacheTtlMs: 5 * 60 * 1000,
        sourceTimeoutMs: 3500,
        healthTimeoutMs: 2400,
        selectionTimeoutMs: 9000,
        documentTimeoutMs: 10000,
        healthConcurrency: 3,
        redirectCheckLimit: 12,
        maxNavigationAttempts: 3,
        journeyTtlMs: 2 * 60 * 1000,
        failureCooldownMs: 60 * 1000,
        maxFailureCooldownMs: 30 * 60 * 1000,
        maxInstances: 64,
        // A real, shared feed checks Reddit access without sending your target
        // post or search query to every candidate. /settings cannot test this.
        healthPath: '/r/popular/hot',
        maxHealthBytes: 2 * 1024 * 1024,
        maxSourceBytes: 128 * 1024,
        rewriteLinks: true,
    });

    const KEYS = Object.freeze({
        source: 'redlib_redirect_source_v2',
        last: 'redlib_redirect_last_working_instance_v1',
        healthPrefix: 'redlib_redirect_health_v2:',
        sourceAttempt: 'redlib_redirect_source_attempt_v2',
        legacySource: 'redlib_redirect_source_instances_v1',
    });

    const ROUTE_SEPARATOR = '&__redlib_redirect_v7=';

    const localValues = new Map();
    const rewrittenLinks = new WeakMap();
    const activeRequests = new Set();

    let catalog = loadCatalog();
    let routing = null;
    let panel = null;
    let disposed = false;
    let navigated = false;
    let cancelWatcher = () => {};
    let linkSnapshot = { until: 0, origin: null };

    window.addEventListener('pagehide', () => {
        disposed = true;
        cancelWatcher();
        routing?.abort();

        for (const abort of [...activeRequests]) {
            abort();
        }
    });

    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) {
            return;
        }

        disposed = false;
        navigated = false;
        linkSnapshot.until = 0;

        // A cancelled selection must not resurrect after Back/Forward restore.
        if (panel) {
            panel.message('Selection stopped.', false);
            panel.actions([
                {
                    label: 'Retry',
                    run: () => void route(panel.target, newJourney(), true, true),
                },
                {
                    label: 'Back',
                    run: () => history.back(),
                },
            ]);
        }
    });

    if (initialRedditUrl) {
        registerMenu(initialRedditUrl, null);
        void route(initialRedditUrl, newJourney(), false);
    } else {
        if (CONFIG.rewriteLinks) {
            installLinkRewriter();
        }

        const origin = instanceOrigin(location.origin);

        if (origin && catalog.instances.some((item) => item.url === origin)) {
            const target = new URL(location.href);
            const journey = consumeJourney(target, origin);

            registerMenu(target, origin);

            if (isReadingPath(target.pathname)) {
                watchDestination(target, origin, journey);
            }
        }
    }

    // URL handling deliberately uses an exact host allowlist. Media, outbound
    // trackers, account endpoints and credential-bearing URLs are not forwarded.
    function redditUrl(value, base) {
        try {
            const url = new URL(value, base);

            if (
                !/^https?:$/.test(url.protocol)
                || url.username
                || url.password
                || url.port
            ) {
                return null;
            }

            const host = url.hostname.toLowerCase();

            if (/^(?:www\.)?redd\.it$/.test(host)) {
                if (!/^\/[a-z0-9]+\/?$/i.test(url.pathname)) {
                    return null;
                }

                url.pathname = `/comments/${url.pathname.split('/')[1]}`;
            } else if (!/^(?:(?:www|old|new|np|m|sh)\.)?reddit\.com$/.test(host)) {
                return null;
            }

            if (/^\/gallery\/[a-z0-9]+\/?$/i.test(url.pathname)) {
                url.pathname = `/comments/${url.pathname.split('/')[2]}`;
            }

            if (!isReadingPath(url.pathname)) {
                return null;
            }

            // Redlib's route matcher distinguishes routes with a trailing slash.
            // Reddit commonly emits canonical profile/community URLs ending in '/'.
            url.pathname = normaliseRedlibPath(url.pathname);

            if (
                [...url.searchParams.keys()].some(
                    (key) => /^(?:access_token|refresh_token|id_token|token|code|state|password)$/i.test(key)
                )
            ) {
                return null;
            }

            if (
                /(?:^|[&#])(?:access_token|refresh_token|id_token)=/i.test(url.hash)
            ) {
                return null;
            }

            return url;
        } catch {
            return null;
        }
    }

    function normaliseRedlibPath(path) {
        if (typeof path !== 'string' || path === '' || path === '/') {
            return '/';
        }

        return path.replace(/\/+$/, '') || '/';
    }

    function isReadingPath(path) {
        if (/\.(?:json|rss|xml)$/i.test(path)) {
            return false;
        }

        if (/\/(?:submit|compose|modmail)(?:\/|$)/i.test(path)) {
            return false;
        }

        return path === '/'
            || /^\/(?:r|u|user|comments|duplicates|search|wiki|w)(?:\/|$)/i.test(path)
            || /^\/(?:best|hot|new|top|rising|controversial)\/?$/i.test(path);
    }

    function instanceOrigin(value) {
        if (typeof value !== 'string' || value.length > 255) {
            return null;
        }

        try {
            const url = new URL(value.trim());
            const host = url.hostname;

            if (
                url.protocol !== 'https:'
                || url.username
                || url.password
                || url.port
                || url.pathname !== '/'
                || url.search
                || url.hash
                || !host.includes('.')
                || /[\[\]:]/.test(host)
                || /^[\d.]+$/.test(host)
                || /(?:^|\.)(?:localhost|local|internal|onion|reddit\.com|redd\.it)$/.test(host)
            ) {
                return null;
            }

            return url.origin;
        } catch {
            return null;
        }
    }

    function recent(time, ttl, now = Date.now()) {
        return Number.isFinite(time)
            && time > 0
            && now >= time
            && now - time < ttl;
    }

    function read(key, fallback) {
        try {
            return GM_getValue(key, fallback);
        } catch {
            return localValues.has(key)
                ? localValues.get(key)
                : fallback;
        }
    }

    function write(key, value) {
        localValues.set(key, value);

        try {
            GM_setValue(key, value);
        } catch {
            // Keep this navigation functional without origin-local storage.
        }
    }

    function parseInstances(payload) {
        if (!payload || !Array.isArray(payload.instances)) {
            return [];
        }

        const seen = new Set();

        return payload.instances
            .slice(0, CONFIG.maxInstances * 4)
            .flatMap((item) => {
                const url = instanceOrigin(item?.url);

                if (!url || seen.has(url)) {
                    return [];
                }

                seen.add(url);

                const score = (item.cloudflare === true ? 0 : 4)
                    + (/sfw\s*only/i.test(String(item.description || '')) ? 0 : 2);

                return [{
                    url,
                    score,
                }];
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, CONFIG.maxInstances);
    }

    function cachedCatalog(value) {
        if (!value || !Array.isArray(value.instances)) {
            return null;
        }

        const seen = new Set();

        const instances = value.instances
            .slice(0, CONFIG.maxInstances)
            .flatMap((item) => {
                const url = instanceOrigin(item?.url);

                if (!url || seen.has(url)) {
                    return [];
                }

                seen.add(url);

                return [{
                    url,
                    score: Number.isFinite(item.score)
                        ? Math.max(0, Math.min(6, item.score))
                        : 0,
                }];
            });

        return instances.length
            ? {
                instances,
                updatedAt: value.updatedAt,
                sourceUpdated: value.sourceUpdated,
            }
            : null;
    }

    function loadCatalog() {
        const saved = cachedCatalog(read(KEYS.source, null));

        if (saved) {
            return saved;
        }

        // @resource is fetched by the manager at install/update, not on every page.
        try {
            const payload = JSON.parse(
                GM_getResourceText('redlibInstances')
            );

            const instances = parseInstances(payload);

            if (instances.length) {
                return {
                    instances,
                    updatedAt: 0,
                    sourceUpdated: payload.updated,
                };
            }
        } catch {
            // The old cache still provides an offline migration path.
        }

        const legacy = read(KEYS.legacySource, null);
        const urls = Array.isArray(legacy?.urls)
            ? legacy.urls
            : [];

        const instances = parseInstances({
            instances: urls.map((url) => ({ url })),
        });

        return {
            instances,
            updatedAt: 0,
            sourceUpdated: null,
        };
    }

    function health(origin) {
        const value = read(KEYS.healthPrefix + origin, null);
        const now = Date.now();

        return {
            okAt: Number.isFinite(value?.okAt) && value.okAt <= now
                ? value.okAt
                : 0,
            failedAt: Number.isFinite(value?.failedAt) && value.failedAt <= now
                ? value.failedAt
                : 0,
            failures: Number.isFinite(value?.failures)
                ? Math.max(0, Math.min(10, value.failures))
                : 0,
            retryAt:
                Number.isFinite(value?.retryAt)
                && value.retryAt <= now + CONFIG.maxFailureCooldownMs
                    ? value.retryAt
                    : 0,
        };
    }

    function markHealthy(origin, startedAt = Date.now()) {
        const previous = health(origin);

        if (previous.failedAt > startedAt) {
            return;
        }

        write(KEYS.healthPrefix + origin, {
            okAt: Date.now(),
            failedAt: 0,
            failures: 0,
            retryAt: 0,
        });

        write(KEYS.last, origin);
        linkSnapshot.until = 0;
    }

    function markFailed(origin, startedAt) {
        const previous = health(origin);

        if (
            previous.okAt > startedAt
            || previous.failedAt > startedAt
        ) {
            return;
        }

        const failures = Math.min(
            previous.failures + 1,
            10
        );

        const cooldown = Math.min(
            CONFIG.failureCooldownMs * 2 ** (failures - 1),
            CONFIG.maxFailureCooldownMs
        );

        const now = Date.now();

        write(KEYS.healthPrefix + origin, {
            okAt: 0,
            failedAt: now,
            failures,
            retryAt: now + cooldown,
        });

        linkSnapshot.until = 0;
    }

    function candidates(excluded = new Set(), ignoreCooldown = false) {
        const last = read(KEYS.last, '');
        const now = Date.now();

        return catalog.instances
            .filter((item) => !excluded.has(item.url))
            .map((item) => ({
                ...item,
                health: health(item.url),
                preferred: item.url === last,
            }))
            .filter(
                (item) => ignoreCooldown || item.health.retryAt <= now
            )
            .sort(
                (a, b) =>
                    Number(b.preferred) - Number(a.preferred)
                    || Number(
                        recent(
                            b.health.okAt,
                            CONFIG.healthCacheTtlMs,
                            now
                        )
                    ) - Number(
                        recent(
                            a.health.okAt,
                            CONFIG.healthCacheTtlMs,
                            now
                        )
                    )
                    || b.score - a.score
            );
    }

    function warmInstance(excluded = new Set()) {
        return candidates(excluded).find(
            (item) =>
                recent(
                    item.health.okAt,
                    CONFIG.healthCacheTtlMs
                )
        )?.url || null;
    }

    function installLinkRewriter() {
        const rewrite = (event) => {
            if (disposed || event.altKey) {
                return;
            }

            const anchor = event.composedPath().find(
                (node) =>
                    node?.nodeType === 1
                    && node.matches('a[href], area[href]')
            );

            if (
                !anchor
                || anchor.hasAttribute('download')
                || anchor.isContentEditable
            ) {
                return;
            }

            const href = anchor.getAttribute('href');
            const prior = rewrittenLinks.get(anchor);

            const target = redditUrl(
                prior?.written === href
                    ? prior.original
                    : href,
                document.baseURI
            );

            if (!target) {
                return;
            }

            const now = Date.now();

            if (now >= linkSnapshot.until) {
                // GM storage is shared between tabs. Re-read instead of keeping
                // an instance selected indefinitely on long-lived SPA pages.
                catalog = cachedCatalog(
                    read(KEYS.source, null)
                ) || catalog;

                linkSnapshot = {
                    until: now + 1000,
                    origin: warmInstance(),
                };
            }

            if (!linkSnapshot.origin) {
                if (prior?.written === href) {
                    anchor.setAttribute(
                        'href',
                        prior.original
                    );
                }

                rewrittenLinks.delete(anchor);
                return;
            }

            const destination = destinationUrl(
                linkSnapshot.origin,
                target
            );

            const written = destination.href;

            rewrittenLinks.set(anchor, {
                original:
                    prior?.written === href
                        ? prior.original
                        : href,
                written,
            });

            anchor.setAttribute('href', written);

            // Retain native targets, keyboard/modifier behaviour and context menus.
            // Prevent a later delegated site router from replacing this URL.
            if (
                event.type === 'click'
                || event.type === 'auxclick'
            ) {
                event.stopImmediatePropagation();
            }
        };

        for (const type of [
            'pointerover',
            'pointerdown',
            'focusin',
            'contextmenu',
            'click',
            'auxclick',
        ]) {
            window.addEventListener(
                type,
                rewrite,
                true
            );
        }
    }

    function destinationUrl(origin, target, journey) {
        const url = new URL(origin);

        // Set pathname, rather than resolve it: //evil.example must stay a path.
        url.pathname = isReadingPath(target.pathname)
            ? normaliseRedlibPath(target.pathname)
            : target.pathname;

        url.search = target.search;
        url.hash = target.hash;

        if (journey) {
            url.hash = `${target.hash || '#'}${ROUTE_SEPARATOR}${encodeURIComponent(
                JSON.stringify({
                    time: journey.time,
                    tried: [
                        ...new Set([
                            ...journey.tried,
                            origin,
                        ]),
                    ],
                })
            )}`;
        }

        return url;
    }

    function newJourney() {
        return {
            time: Date.now(),
            tried: [],
        };
    }

    function consumeJourney(target, origin) {
        let journey = newJourney();

        // The original fragment is not encoded inside the state. Even unusually
        // long anchors are preserved; only the small routing suffix is parsed.
        const index = target.hash.lastIndexOf(
            ROUTE_SEPARATOR
        );

        const suffix = index < 1
            ? ''
            : target.hash.slice(
                index + ROUTE_SEPARATOR.length
            );

        if (suffix && suffix.length < 4096) {
            try {
                const value = JSON.parse(
                    decodeURIComponent(suffix)
                );

                if (
                    Array.isArray(value.tried)
                    && value.tried.length
                        <= CONFIG.maxNavigationAttempts
                    && value.tried.every(
                        (entry) => instanceOrigin(entry)
                    )
                ) {
                    const originalHash =
                        target.hash.slice(0, index);

                    target.hash =
                        originalHash === '#'
                            ? ''
                            : originalHash;

                    history.replaceState(
                        history.state,
                        '',
                        target.href
                    );

                    if (
                        recent(
                            value.time,
                            CONFIG.journeyTtlMs
                        )
                    ) {
                        journey = {
                            time: value.time,
                            tried: [
                                ...new Set(value.tried),
                            ],
                        };
                    }
                }
            } catch {
                // Malformed fragments are ordinary page fragments.
            }
        }

        journey.tried = [
            ...new Set([
                ...journey.tried,
                origin,
            ]),
        ];

        return journey;
    }

    async function route(
        target,
        journey,
        forceProbe,
        manualRetry = false
    ) {
        if (
            disposed
            || navigated
            || routing
        ) {
            return;
        }

        cancelWatcher();

        const excluded = new Set(
            journey.tried
        );

        const warm =
            !forceProbe
            && warmInstance(excluded);

        if (warm) {
            navigate(
                warm,
                target,
                journey
            );

            return;
        }

        const controller =
            new AbortController();

        routing = controller;

        const view =
            showPanel(target);

        view.message(
            'Finding a working instance...',
            true
        );

        view.actions([
            {
                label: 'Cancel',
                run: () =>
                    controller.abort(),
            },
        ]);

        try {
            const origin =
                await selectInstance(
                    excluded,
                    controller.signal,
                    (message) =>
                        view.log(message),
                    manualRetry
                );

            if (
                disposed
                || controller.signal.aborted
            ) {
                if (!disposed) {
                    view.message(
                        'Selection stopped.',
                        false
                    );
                }
            } else if (origin) {
                view.message(
                    'Opening Redlib...',
                    true
                );

                navigate(
                    origin,
                    target,
                    journey
                );

                return;
            } else {
                view.message(
                    'No working instance found within the selection budget.',
                    false
                );
            }
        } catch (error) {
            view.message(
                'Could not select a Redlib instance.',
                false
            );

            view.log(
                error instanceof Error
                    ? error.message
                    : String(error)
            );
        } finally {
            if (routing === controller) {
                routing = null;
            }
        }

        if (
            !disposed
            && !navigated
        ) {
            view.actions([
                {
                    label: 'Retry',
                    run: () =>
                        void route(
                            target,
                            newJourney(),
                            true,
                            true
                        ),
                },
                {
                    label: 'Back',
                    run: () =>
                        history.back(),
                },
            ]);
        }
    }

    function navigate(
        origin,
        target,
        journey
    ) {
        if (
            disposed
            || navigated
        ) {
            return;
        }

        const destination =
            destinationUrl(
                origin,
                target,
                journey
            );

        navigated = true;

        try {
            location.replace(
                destination.href
            );
        } catch (error) {
            navigated = false;
            throw error;
        }
    }

    function request(
        url,
        timeout,
        signal,
        maxBytes
    ) {
        return new Promise(
            (resolve, reject) => {
                let done = false;
                let control;
                let timer;

                const finish = (
                    error,
                    value
                ) => {
                    if (done) {
                        return;
                    }

                    done = true;

                    clearTimeout(timer);

                    activeRequests.delete(
                        cancel
                    );

                    signal?.removeEventListener(
                        'abort',
                        cancel
                    );

                    if (error) {
                        reject(error);
                    } else {
                        resolve(value);
                    }
                };

                const abortWith = (
                    message
                ) => {
                    finish(
                        new Error(message)
                    );

                    try {
                        control?.abort();
                    } catch {
                        // Already closed.
                    }
                };

                const cancel = () =>
                    abortWith('Cancelled');

                if (
                    signal?.aborted
                    || disposed
                ) {
                    cancel();
                    return;
                }

                activeRequests.add(
                    cancel
                );

                signal?.addEventListener(
                    'abort',
                    cancel,
                    { once: true }
                );

                // Independent watchdog: a missing manager callback must not hang us.
                timer = setTimeout(
                    () =>
                        abortWith(
                            'Request timed out'
                        ),
                    timeout + 100
                );

                try {
                    control =
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url,
                            timeout,
                            responseType:
                                'text',
                            anonymous: true,
                            headers: {
                                Accept:
                                    url === CONFIG.sourceUrl
                                        ? 'application/json'
                                        : 'text/html',
                            },
                            onload: (
                                response
                            ) => {
                                const text =
                                    typeof response.responseText
                                        === 'string'
                                        ? response.responseText
                                        : '';

                                if (
                                    text.length
                                    > maxBytes
                                ) {
                                    finish(
                                        new Error(
                                            'Response too large'
                                        )
                                    );
                                } else {
                                    finish(
                                        null,
                                        {
                                            ...response,
                                            responseText:
                                                text,
                                        }
                                    );
                                }
                            },
                            onprogress: (
                                response
                            ) => {
                                if (
                                    response.loaded
                                        > maxBytes
                                    || response.total
                                        > maxBytes
                                ) {
                                    abortWith(
                                        'Response too large'
                                    );
                                }
                            },
                            onerror: () =>
                                finish(
                                    new Error(
                                        'Network error'
                                    )
                                ),
                            ontimeout: () =>
                                finish(
                                    new Error(
                                        'Request timed out'
                                    )
                                ),
                            onabort: () =>
                                finish(
                                    new Error(
                                        'Cancelled'
                                    )
                                ),
                        });

                    if (done) {
                        try {
                            control?.abort();
                        } catch {
                            // Synchronous completion.
                        }
                    }
                } catch (error) {
                    finish(error);
                }
            }
        );
    }

    async function refreshCatalog(
        signal,
        force = false
    ) {
        if (
            !force
            && recent(
                catalog.updatedAt,
                CONFIG.sourceCacheTtlMs
            )
        ) {
            return;
        }

        if (
            !force
            && recent(
                read(
                    KEYS.sourceAttempt,
                    0
                ),
                CONFIG.sourceRetryMs
            )
        ) {
            return;
        }

        write(
            KEYS.sourceAttempt,
            Date.now()
        );

        const response =
            await request(
                CONFIG.sourceUrl,
                CONFIG.sourceTimeoutMs,
                signal,
                CONFIG.maxSourceBytes
            );

        if (
            response.status !== 200
            || new URL(
                response.finalUrl
                    || CONFIG.sourceUrl
            ).origin
                !== new URL(
                    CONFIG.sourceUrl
                ).origin
        ) {
            throw new Error(
                `Instance list: HTTP ${response.status} or unexpected redirect`
            );
        }

        const payload =
            JSON.parse(
                response.responseText
            );

        const instances =
            parseInstances(payload);

        if (!instances.length) {
            throw new Error(
                'Instance list contains no usable public HTTPS origins'
            );
        }

        catalog = {
            instances,
            updatedAt: Date.now(),
            sourceUpdated:
                typeof payload.updated === 'string'
                    ? payload.updated
                    : null,
        };

        write(
            KEYS.source,
            catalog
        );

        linkSnapshot.until = 0;
    }

    function validFeed(
        response,
        origin
    ) {
        if (
            response.status < 200
            || response.status >= 300
        ) {
            return false;
        }

        try {
            if (
                !response.finalUrl
                || new URL(
                    response.finalUrl
                ).origin !== origin
            ) {
                return false;
            }
        } catch {
            return false;
        }

        if (
            !/^content-type:\s*text\/html\b/im.test(
                response.responseHeaders
                    || ''
            )
        ) {
            return false;
        }

        // Inspect bounded response text; never insert remote HTML or load its
        // images/scripts. These IDs come from upstream Redlib templates.
        const text =
            response.responseText.replace(
                /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
                ''
            );

        return /<a\b[^>]*\sid\s*=\s*["']redlib["']/i.test(text)
            && /<div\b[^>]*\sid\s*=\s*["']posts["']/i.test(text)
            && !/<div\b[^>]*\sid\s*=\s*["']error["']/i.test(text);
    }

    function selectInstance(
        excluded,
        signal,
        log,
        manualRetry = false
    ) {
        return new Promise(
            (resolve) => {
                const controller =
                    new AbortController();

                const attempted =
                    new Set(excluded);

                let count = 0;
                let active = 0;
                let sourcePending = true;
                let done = false;

                const finish = (
                    origin
                ) => {
                    if (done) {
                        return;
                    }

                    done = true;

                    clearTimeout(timer);

                    signal.removeEventListener(
                        'abort',
                        cancel
                    );

                    controller.abort();
                    resolve(origin);
                };

                const cancel = () =>
                    finish(null);

                const timer =
                    setTimeout(
                        () => {
                            log(
                                'Selection deadline reached.'
                            );

                            finish(null);
                        },
                        CONFIG.selectionTimeoutMs
                    );

                signal.addEventListener(
                    'abort',
                    cancel,
                    { once: true }
                );

                if (signal.aborted) {
                    cancel();
                    return;
                }

                const pump = () => {
                    if (done) {
                        return;
                    }

                    const queue =
                        candidates(
                            attempted,
                            manualRetry
                        );

                    while (
                        active
                            < CONFIG.healthConcurrency
                        && count
                            < CONFIG.redirectCheckLimit
                        && queue.length
                    ) {
                        const { url } =
                            queue.shift();

                        attempted.add(url);
                        count += 1;
                        active += 1;

                        const startedAt =
                            Date.now();

                        void request(
                            url
                                + CONFIG.healthPath,
                            CONFIG.healthTimeoutMs,
                            controller.signal,
                            CONFIG.maxHealthBytes
                        )
                            .then(
                                (
                                    response
                                ) => {
                                    if (done) {
                                        return;
                                    }

                                    if (
                                        !catalog.instances.some(
                                            (
                                                item
                                            ) =>
                                                item.url
                                                === url
                                        )
                                    ) {
                                        throw new Error(
                                            'Instance no longer listed'
                                        );
                                    }

                                    if (
                                        !validFeed(
                                            response,
                                            url
                                        )
                                    ) {
                                        throw new Error(
                                            `HTTP ${response.status}: no valid Redlib feed`
                                        );
                                    }

                                    markHealthy(
                                        url,
                                        startedAt
                                    );

                                    log(
                                        `${new URL(url).host}: verified`
                                    );

                                    finish(url);
                                }
                            )
                            .catch(
                                (
                                    error
                                ) => {
                                    if (
                                        done
                                        || controller
                                            .signal
                                            .aborted
                                    ) {
                                        return;
                                    }

                                    markFailed(
                                        url,
                                        startedAt
                                    );

                                    log(
                                        `${new URL(url).host}: ${error.message}`
                                    );
                                }
                            )
                            .finally(
                                () => {
                                    active -= 1;
                                    pump();
                                }
                            );
                    }

                    if (
                        !active
                        && (
                            !sourcePending
                            || count
                                >= CONFIG.redirectCheckLimit
                        )
                    ) {
                        finish(null);
                    }
                };

                // Catalogue fetch and probes overlap, but share one deadline and one
                // cancellation boundary. A winner stops ALL remaining requests.
                void refreshCatalog(
                    controller.signal,
                    manualRetry
                )
                    .catch(
                        (
                            error
                        ) => {
                            if (!done) {
                                log(
                                    `Using the cached instance list: ${error.message}`
                                );
                            }
                        }
                    )
                    .finally(
                        () => {
                            sourcePending =
                                false;
                            pump();
                        }
                    );

                pump();
            }
        );
    }

    function watchDestination(
        target,
        origin,
        journey
    ) {
        const startedAt =
            Date.now();

        let finished = false;

        const controller =
            new AbortController();

        const finish = () => {
            finished = true;

            clearTimeout(timer);

            document.removeEventListener(
                'DOMContentLoaded',
                check
            );
        };

        const check = () => {
            if (
                finished
                || disposed
            ) {
                return;
            }

            finish();

            const shell =
                document.querySelector(
                    'nav a#redlib'
                );

            const main =
                document.querySelector(
                    'main'
                );

            const errorContainer =
                document.querySelector(
                    'main > #error'
                );

            const error =
                errorContainer?.querySelector(
                    'h1'
                );

            const text =
                error?.textContent?.trim()
                || '';

            const terminal =
                /(?:not found|nothing here|private|banned|quarantin|deleted|removed|does not exist|post id is invalid)/i.test(
                    text
                );

            const retryable =
                /(?:failed to (?:parse|fetch)|too many requests|rate.?limit|\b(?:429|502|503|504)\b|timed? ?out|timeout|connection|unavailable|upstream|blocked|reddit error)/i.test(
                    text
                );

            if (
                shell
                && main
                && main.childElementCount
                && !errorContainer
            ) {
                markHealthy(
                    origin,
                    startedAt
                );

                restoreAnchor(
                    target.hash
                );
            } else if (
                (
                    terminal
                    && !/^failed to (?:parse|fetch)/i.test(
                        text
                    )
                )
                || (
                    shell
                    && errorContainer
                    && !retryable
                )
            ) {
                // Missing/private content or an unfamiliar error is not proof
                // that an instance is broken. Do not bounce through mirrors.
            } else {
                window.stop();

                markFailed(
                    origin,
                    startedAt
                );

                if (
                    journey.tried.length
                        < CONFIG.maxNavigationAttempts
                    && recent(
                        journey.time,
                        CONFIG.journeyTtlMs
                    )
                ) {
                    void route(
                        target,
                        journey,
                        true
                    );
                } else {
                    const view =
                        showPanel(target);

                    view.message(
                        journey.tried.length
                            >= CONFIG.maxNavigationAttempts
                            ? `Automatic failover stopped after ${journey.tried.length} instances.`
                            : 'Automatic failover time limit reached.',
                        false
                    );

                    view.log(
                        text
                        || 'The destination did not produce a usable Redlib page.'
                    );

                    view.actions([
                        {
                            label:
                                'Retry',
                            run:
                                () =>
                                    void route(
                                        target,
                                        newJourney(),
                                        true,
                                        true
                                    ),
                        },
                        {
                            label:
                                'Back',
                            run:
                                () =>
                                    history.back(),
                        },
                    ]);
                }

                return;
            }

            // Refresh only on Reddit/Redlib activity, never on unrelated pages.
            void refreshCatalog(
                controller.signal
            ).catch(() => {});
        };

        const timer =
            setTimeout(
                check,
                CONFIG.documentTimeoutMs
            );

        cancelWatcher = () => {
            finish();
            controller.abort();
        };

        if (
            document.readyState
            === 'loading'
        ) {
            document.addEventListener(
                'DOMContentLoaded',
                check,
                { once: true }
            );
        } else {
            check();
        }
    }

    function restoreAnchor(hash) {
        if (!hash) {
            return;
        }

        try {
            const id =
                decodeURIComponent(
                    hash.slice(1)
                );

            const element =
                document.getElementById(
                    id
                )
                || document.getElementsByName(
                    id
                )[0];

            element?.scrollIntoView();
        } catch {
            // An invalid percent escape is not a navigation failure.
        }
    }

    function registerMenu(
        target,
        origin
    ) {
        try {
            GM_registerMenuCommand(
                'Redlib: try another instance',
                () => {
                    if (routing) {
                        return;
                    }

                    window.stop();

                    const journey =
                        newJourney();

                    if (origin) {
                        journey.tried.push(
                            origin
                        );
                    }

                    void route(
                        target,
                        journey,
                        true
                    );
                }
            );
        } catch {
            // Redirecting does not depend on menu support.
        }
    }

    function showPanel(target) {
        if (panel) {
            return panel;
        }

        if (initialRedditUrl) {
            // Remove Reddit's visible document and queued DOM resources. Avoid
            // document.write/open, page-script injection and origin localStorage.
            const head =
                document.createElement(
                    'head'
                );

            const title =
                document.createElement(
                    'title'
                );

            title.textContent =
                'Redlib Redirector';

            head.append(title);

            document.documentElement.replaceChildren(
                head,
                document.createElement(
                    'body'
                )
            );
        }

        const host =
            document.createElement(
                'div'
            );

        host.id =
            'redlib-redirector-panel';

        const root =
            host.attachShadow({
                mode: 'open',
            });

        const element = (
            tag,
            text,
            parent
        ) => {
            const node =
                document.createElement(
                    tag
                );

            if (text) {
                node.textContent = text;
            }

            parent?.append(node);

            return node;
        };

        const screen =
            element(
                'section',
                '',
                root
            );

        screen.setAttribute(
            'role',
            'region'
        );

        screen.setAttribute(
            'aria-label',
            'Redlib Redirector'
        );

        const card =
            element(
                'div',
                '',
                screen
            );

        card.className =
            'card';

        element(
            'p',
            'REDDIT TO REDLIB',
            card
        ).className = 'eyebrow';

        const status =
            element(
                'h1',
                '',
                card
            );

        status.setAttribute(
            'aria-live',
            'polite'
        );

        const path =
            element(
                'p',
                target.pathname
                    + target.search,
                card
            );

        path.className =
            'path';

        const actions =
            element(
                'div',
                '',
                card
            );

        actions.className =
            'actions';

        const details =
            element(
                'details',
                '',
                card
            );

        element(
            'summary',
            'Connection details',
            details
        );

        const logs =
            element(
                'pre',
                '',
                details
            );

        const style = `
            :host {
                all: initial;
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                color-scheme: dark;
                font: 15px/1.55 system-ui, sans-serif;
                color: #e9e9ed;
            }

            * {
                box-sizing: border-box;
            }

            section {
                min-height: 100%;
                height: 100%;
                overflow: auto;
                display: grid;
                place-items: center;
                padding: 32px;
                background: #101114;
            }

            .card {
                width: min(100%, 650px);
            }

            .eyebrow {
                color: #91949e;
                font-size: 11px;
                letter-spacing: .15em;
                margin: 0 0 20px;
            }

            h1 {
                font-size: clamp(22px, 3vw, 30px);
                line-height: 1.3;
                font-weight: 550;
                margin: 0 0 18px;
            }

            .path {
                color: #a4a7b0;
                overflow-wrap: anywhere;
                font: 13px/1.6 ui-monospace, monospace;
            }

            .actions {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                margin: 28px 0;
            }

            button {
                font: inherit;
                color: inherit;
                background: #24262c;
                border: 1px solid #3b3e48;
                border-radius: 7px;
                padding: 9px 18px;
                cursor: pointer;
            }

            button:hover {
                background: #30333b;
            }

            button:focus-visible,
            summary:focus-visible {
                outline: 2px solid #a9b5d1;
                outline-offset: 4px;
            }

            summary {
                color: #92959f;
                cursor: pointer;
                font-size: 12px;
            }

            pre {
                color: #b1b4be;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                font: 12px/1.7 ui-monospace, monospace;
                max-height: 240px;
                overflow: auto;
            }
        `;

        document.documentElement.append(
            host
        );

        try {
            GM_addElement(
                root,
                'style',
                {
                    textContent:
                        style,
                }
            );
        } catch {
            element(
                'style',
                style,
                root
            );
        }

        const messages = [];

        panel = {
            target,

            message(
                text,
                busy
            ) {
                status.textContent =
                    text;

                status.setAttribute(
                    'aria-busy',
                    String(busy)
                );
            },

            log(text) {
                messages.push(text);

                logs.textContent =
                    messages
                        .slice(-24)
                        .join('\n');
            },

            actions(items) {
                actions.replaceChildren();

                for (
                    const item
                    of items
                ) {
                    const button =
                        element(
                            'button',
                            item.label,
                            actions
                        );

                    button.type =
                        'button';

                    button.addEventListener(
                        'click',
                        item.run
                    );
                }
            },
        };

        return panel;
    }
})();