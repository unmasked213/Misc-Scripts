// ==UserScript==
// @name         Page Hopper
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      7.1
// @description  Navigate paginated websites with advanced detection and minimal false positives. Handles high page numbers and embedded digits correctly.
// @author       Unmasked213
// @match        *://*/*
// @exclude      *://chatgpt.com/*
// @exclude      *://mail.google.com/*
// @exclude      *://docs.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/page_hopper.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/page_hopper.user.js
// ==/UserScript==


(function() {
    'use strict';

    const config = {
        keyIncrement: ']',
        keyDecrement: '[',
        stepSize: 1,
        minPageNumber: 1,
        paginationKeywords: [
            'page', 'p', 'pg', 'pagenumber', 'pageno', 'pagenum',
            'seite', 'pagina', 'pagine', 'strona', 'halaman',
            'sayfa', '????', '????', '???', '???', '??'
        ],
        maxPageNumber: 99999,
        debugMode: false,
        showVisualIndicator: true,
        indicatorTimeout: 1000
    };

    const loadConfig = () => {
        try {
            const savedConfig = typeof GM_getValue === 'function' ?
                GM_getValue('pagehopConfig') :
                localStorage.getItem('pagehopConfig');

            if (savedConfig) {
                const parsed = JSON.parse(savedConfig);
                return {...config, ...parsed};
            }
        } catch (e) {
            console.error('[PageHop] Error loading config:', e);
        }
        return config;
    };

    const cfg = loadConfig();

    function debugLog(...args) {
        if (cfg.debugMode) {
            console.log('[PageHop]', ...args);
        }
    }

    let navigationIndicator = null;
    let indicatorTimeout = null;

    function showNavigationFeedback(message, success = true) {
        if (!cfg.showVisualIndicator) return;

        if (indicatorTimeout) {
            clearTimeout(indicatorTimeout);
        }

        if (!navigationIndicator) {
            navigationIndicator = document.createElement('div');
            navigationIndicator.id = 'pagehop-indicator';
            navigationIndicator.style.position = 'fixed';
            navigationIndicator.style.bottom = '20px';
            navigationIndicator.style.right = '20px';
            navigationIndicator.style.padding = '8px 12px';
            navigationIndicator.style.borderRadius = '4px';
            navigationIndicator.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
            navigationIndicator.style.fontSize = '14px';
            navigationIndicator.style.fontFamily = 'system-ui, -apple-system, sans-serif';
            navigationIndicator.style.zIndex = '999999';
            navigationIndicator.style.transition = 'opacity 0.3s ease';
            document.body.appendChild(navigationIndicator);
        }

        navigationIndicator.textContent = message;
        navigationIndicator.style.backgroundColor = success ? 'rgba(33, 150, 83, 0.9)' : 'rgba(209, 87, 87, 0.9)';
        navigationIndicator.style.color = '#FFFFFF';
        navigationIndicator.style.opacity = '1';

        indicatorTimeout = setTimeout(() => {
            navigationIndicator.style.opacity = '0';
        }, cfg.indicatorTimeout);
    }

    function isLikelyPageNumber(num, strLength) {
        const MIN_PAGE = cfg.minPageNumber;
        const MAX_PAGE = cfg.maxPageNumber;

        const currentYear = new Date().getFullYear();
        const yearRange = [currentYear - 5, currentYear + 5];

        if (strLength === 4 && num >= yearRange[0] && num <= yearRange[1]) {
            return false;
        }

        return num >= MIN_PAGE && num <= MAX_PAGE;
    }

    function isStandaloneDigit(matchedStr, digitStr, fullUrl) {
        const exclusionPatterns = [
            /\/v\d+\//i,
            /model-?\d+/i,
            /sku-?\d+/i,
            /\d{4}-\d{2}-\d{2}/,
            /item-?\d+/i,
            /product-?\d+/i,
            /id-?\d+/i,
            /art-?\d+/i,
            /ref-?\d+/i
        ];

        for (const pattern of exclusionPatterns) {
            if (pattern.test(matchedStr)) {
                debugLog('Excluded by pattern:', pattern, matchedStr);
                return false;
            }
        }

        const digitIndex = matchedStr.indexOf(digitStr);
        const before = digitIndex > 0 ? matchedStr[digitIndex - 1] : '';
        const after = digitIndex + digitStr.length < matchedStr.length ? matchedStr[digitIndex + digitStr.length] : '';

        const hasAlphaPrefix = /[a-zA-Z]/.test(before);
        const hasAlphaSuffix = /[a-zA-Z]/.test(after);

        if (hasAlphaPrefix && hasAlphaSuffix) {
            debugLog('Digit surrounded by letters, likely not pagination:', matchedStr);
            return false;
        }

        for (const keyword of cfg.paginationKeywords) {
            if (matchedStr.toLowerCase().includes(keyword)) {
                return true;
            }
        }

        if (matchedStr.includes('?') || matchedStr.includes('&')) {
            return true;
        }

        if (!hasAlphaPrefix || !hasAlphaSuffix) {
            return true;
        }

        return false;
    }

    function identifyPageNumber(url) {
        const candidates = [];
        const urlObj = new URL(url);

        debugLog('Analyzing URL:', url);

        const paginationPatterns = [
            { regex: /forum-\d+-page-(\d+)\.html$/, score: 200 },
            { regex: /thread-\d+-(\d+)-\d+\.html$/, score: 200 },
            { regex: /forum\/.*?\/(\d+)$/, score: 190 },
            { regex: /\.(\d+)\.html?$/, score: 190 },
            { regex: /\/(\d+)\.html?$/, score: 190 },
            { regex: /\/(page|pagina|seite)\/(\d+)(\/|$)/i, score: 180 },
            { regex: /\/(p|pg)\/(\d+)(\/|$)/i, score: 175 },
            { regex: /\/paged?[/-](\d+)(\/|$)/i, score: 175 },
            { regex: /-pg-(\d+)(\/|$)/, score: 170 },
            { regex: /\/(\d+)-pg(\/|$)/, score: 170 },
            { regex: /-page[/-](\d+)(\/|$)/, score: 170 },
            { regex: /\/(\d+)\/(page|p|pg)\/?$/, score: 165 },
            { regex: /[?&](?:p|page|pg)=(\d+)/i, score: 160 },
            { regex: /[?&]offset=(\d+)/i, score: 155 },
            { regex: /[?&]start=(\d+)/i, score: 155 },
            { regex: /\/(\d+)\/[^\/]*$/, score: 150 },
            { regex: /[/-](\d+)\/?$/, score: 145 },
            { regex: /\/page\/(\d+)\/?/, score: 140 },
            { regex: /\/paged?\/(\d+)\/?/, score: 140 },
            { regex: /[?&]p=(\d+)/i, score: 130 },
            { regex: /\/(page|p|pg)[/-]?(\d+)(\/|$)/i, score: 120 }
        ];

        for (let [key, value] of urlObj.searchParams.entries()) {
            const keyLower = key.toLowerCase();
            debugLog('Checking query param:', key, value);

            if (cfg.paginationKeywords.includes(keyLower) ||
                keyLower.includes('page') ||
                ['offset', 'start', 'p'].includes(keyLower)) {
                const number = parseInt(value, 10);
                if (!isNaN(number) && isLikelyPageNumber(number, value.length)) {
                    debugLog('Found page number in query param:', key, number);
                    candidates.push({
                        type: 'query',
                        value: number,
                        paramName: key,
                        leadingZeros: value.length - number.toString().length,
                        score: 200
                    });
                }
            }
        }

        for (const pattern of paginationPatterns) {
            const match = url.match(pattern.regex);
            if (match) {
                debugLog('Pattern match:', pattern.regex, match);
                let number = null;
                let digitStr = '';

                for (let i = 1; i < match.length; i++) {
                    if (match[i] && /^\d+$/.test(match[i])) {
                        digitStr = match[i];
                        number = parseInt(digitStr, 10);
                        break;
                    }
                }

                if (number !== null && isLikelyPageNumber(number, digitStr.length)) {
                    if (!isStandaloneDigit(match[0], digitStr, url)) {
                        debugLog('Skipping non-standalone number:', digitStr, 'in', match[0]);
                        continue;
                    }

                    const matchPosition = url.indexOf(match[0]);
                    const digitPosition = match[0].indexOf(digitStr);

                    candidates.push({
                        type: 'path',
                        value: number,
                        leadingZeros: digitStr.length - number.toString().length,
                        score: pattern.score,
                        matchedString: match[0],
                        matchPosition: matchPosition,
                        digitPosition: digitPosition,
                        digitStr: digitStr
                    });
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                if (a.type === 'path' && b.type === 'path') {
                    return b.matchPosition - a.matchPosition;
                }
                return 0;
            });
            debugLog('Selected candidate:', candidates[0]);
            return candidates[0];
        }
        debugLog('No page number identified');
        return null;
    }

    function inferPaginationStyle() {
        const paginationLinks = document.querySelectorAll('a[href*="/page/"], a[href*="/p/"], a[href*="-page-"], a[href*="?page="], a[href*="&page="]');

        if (paginationLinks.length > 0) {
            const sampleHref = paginationLinks[0].href;
            debugLog('Inferred pagination from link:', sampleHref);

            if (sampleHref.includes('/page/')) {
                return 'path-page';
            } else if (sampleHref.includes('/p/')) {
                return 'path-p';
            } else if (sampleHref.includes('-page-')) {
                return 'dash-page';
            }
        }

        return 'query';
    }

    function adjustPage(increment) {
        const step = cfg.stepSize;
        const minPage = cfg.minPageNumber;

        debugLog('Adjusting page, increment:', increment, 'step:', step);

        const url = new URL(window.location.href);
        const fragment = url.hash;
        const pageInfo = identifyPageNumber(url.href);

        let newUrl = url.href;

        if (!pageInfo) {
            if (increment) {
                const style = inferPaginationStyle();
                debugLog('No page info found, inferred style:', style);

                if (style === 'path-page') {
                    url.pathname = url.pathname.replace(/\/$/, '') + '/page/2/';
                    newUrl = url.toString();
                } else if (style === 'path-p') {
                    url.pathname = url.pathname.replace(/\/$/, '') + '/p/2/';
                    newUrl = url.toString();
                } else if (style === 'dash-page') {
                    url.pathname = url.pathname.replace(/\/$/, '') + '-page-2';
                    newUrl = url.toString();
                } else {
                    url.searchParams.set('page', '2');
                    newUrl = url.toString();
                }

                if (fragment && !newUrl.includes('#')) {
                    newUrl += fragment;
                }

                debugLog('Going to:', newUrl);
                window.location.href = newUrl;
            } else {
                debugLog('No page info found and not incrementing, do nothing');
                showNavigationFeedback('No pagination detected', false);
            }
            return;
        }

        if (pageInfo) {
            debugLog('Found page info:', pageInfo);
            let newPage = pageInfo.value + (increment ? step : -step);

            if (newPage < minPage) {
                debugLog('New page below minimum:', newPage);
                showNavigationFeedback('Already at first page', false);
                return;
            }

            if (newPage > cfg.maxPageNumber) {
                debugLog('New page above maximum:', newPage);
                showNavigationFeedback('Page limit reached', false);
                return;
            }

            debugLog('Calculated new page:', newPage);

            const currentFormat = pageInfo.value.toString().padStart(pageInfo.value.toString().length + pageInfo.leadingZeros, '0');
            const hasLeadingZeros = currentFormat[0] === '0';

            let newPageStr;
            if (hasLeadingZeros && newPage < Math.pow(10, currentFormat.length - 1)) {
                newPageStr = newPage.toString().padStart(currentFormat.length, '0');
            } else {
                newPageStr = newPage.toString();
            }

            if (pageInfo.type === 'query') {
                const params = new URLSearchParams(url.search);
                params.set(pageInfo.paramName, newPageStr);
                url.search = params.toString();
                newUrl = url.toString();
                debugLog('New URL (query):', newUrl);
            } else if (pageInfo.type === 'path') {
                const before = pageInfo.matchedString.slice(0, pageInfo.digitPosition);
                const after = pageInfo.matchedString.slice(pageInfo.digitPosition + pageInfo.digitStr.length);
                const replacement = before + newPageStr + after;

                newUrl = url.href.slice(0, pageInfo.matchPosition) +
                         replacement +
                         url.href.slice(pageInfo.matchPosition + pageInfo.matchedString.length);

                debugLog('New URL (path):', newUrl);
            }

            if (fragment && !newUrl.includes('#')) {
                newUrl += fragment;
            }
        }

        if (newUrl !== window.location.href) {
            debugLog('Navigating to:', newUrl);

            showNavigationFeedback(increment ?
                `Page ${pageInfo.value + step}` :
                `Page ${pageInfo.value - step}`);

            window.location.href = newUrl;
        } else {
            debugLog('URL unchanged, not navigating');
            showNavigationFeedback('No change in URL', false);
        }
    }

    function handleKeyDown(event) {
        const tagName = document.activeElement.tagName;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)) {
            return;
        }

        if (event.key === cfg.keyIncrement) {
            event.preventDefault();
            event.stopPropagation();
            debugLog('Increment key pressed');
            adjustPage(true);
        } else if (event.key === cfg.keyDecrement) {
            event.preventDefault();
            event.stopPropagation();
            debugLog('Decrement key pressed');
            adjustPage(false);
        }
    }

    function init() {
        document.addEventListener('keydown', handleKeyDown, { capture: true });

        if (cfg.debugMode) {
            const createDebugDisplay = () => {
                const container = document.createElement('div');
                container.style.position = 'fixed';
                container.style.bottom = '10px';
                container.style.right = '10px';
                container.style.backgroundColor = 'rgba(0,0,0,0.7)';
                container.style.color = 'white';
                container.style.padding = '5px';
                container.style.borderRadius = '5px';
                container.style.zIndex = '9999';
                container.style.fontSize = '12px';
                container.style.fontFamily = 'monospace';
                container.id = 'page-hop-debug';

                const pageInfo = identifyPageNumber(location.href);
                if (pageInfo) {
                    container.textContent = `PageHop: Page ${pageInfo.value} (${pageInfo.type})`;
                } else {
                    container.textContent = 'PageHop: No page detected';
                }

                document.body.appendChild(container);
            };

            if (document.readyState === 'complete') {
                createDebugDisplay();
            } else {
                window.addEventListener('load', createDebugDisplay);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();