// ==UserScript==
// @name         Page Hopper WIP
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      9.2.0
// @description  Keyboard-driven pagination navigation with scoped DOM detection, ancestry grouping, caching, and URL fallback. Prefers component-level pagination when present.
// @author       Unmasked213
// @match        *://*/*
// @exclude      file:///*
// @exclude      /^https?:\/\/(?:localhost|127\.|192\.168\.|(?:[^./]+\.)+(?:local|home\.arpa))(?::\d+)?\//
// @exclude      /^https?:\/\/(?:(?:[^./]+\.)*(?:ui\.nabu\.casa|proton\.me|protonmail\.(?:com|ch)|pm\.me|chatgpt\.com|claude\.ai)|chat\.openai\.com)(?::\d+)?\//
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/page_hopper.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/page_hopper.user.js
// ==/UserScript==


(function() {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const Config = {
        bindings: {
            pageNext:        { key: ']', ctrl: false, shift: false, alt: false, meta: false },
            pagePrev:        { key: '[', ctrl: false, shift: false, alt: false, meta: false },
            historyForward:  { key: ']', ctrl: true,  shift: false, alt: false, meta: false },
            historyBack:     { key: '[', ctrl: true,  shift: false, alt: false, meta: false },
            debugInfo:       { key: '\\',ctrl: true,  shift: true,  alt: false, meta: false }
        },
        pagination: {
            stepSize: 1,
            minPageNumber: 1,
            maxPageNumber: 99999,
            keywords: [
                'page', 'p', 'pg', 'pagenumber', 'pageno', 'pagenum',
                'seite', 'pagina', 'pagine', 'strona', 'halaman',
                'sayfa', '????????', '??', '???', '???', '????'
            ]
        },
        ajax: {
            enabled: true,
            contentLoadTimeout: 2000,
            minDomChange: 100,
            scrollIntoView: false
        },
        detection: {
            maxScopes: 12,
            maxStage2PerScope: 250,
            maxStage2Global: 600,
            maxAncestorLevels: 8,
            maxContainerDescendantsHard: 800,
            broadRectMinDescendants: 320,
            broadRectAreaRatio: 0.60
        },
        feedback: { enabled: true, timeout: 1000 },
        debug: false
    };

    const STORAGE = {
        CONFIG: 'pageHopperConfig',
        SITE_OVERRIDES: 'pageHopperSiteOverrides',
        GROUP_CHOICES: 'pageHopperGroupChoices'
    };

    // =========================================================================
    // TEXT PATTERNS
    // =========================================================================

    const TEXT_PATTERNS = {
        next: [
            /^next$/i, /^next\s*page$/i, /^›$/, /^»$/, /^>$/, /^?$/, /^?$/,
            /^\s*chevron_right\s*$/i, /^\s*arrow_forward\s*$/i,
            /^siguiente$/i, /^weiter$/i, /^suivant$/i, /^??$/, /^???$/, /^??$/,
            /^next\s*?$/i, /^?\s*next$/i, /newer/i, /^forward$/i
        ],
        prev: [
            /^prev(?:ious)?$/i, /^prev(?:ious)?\s*page$/i, /^‹$/, /^«$/, /^<$/, /^?$/, /^?$/,
            /^\s*chevron_left\s*$/i, /^\s*arrow_back\s*$/i,
            /^anterior$/i, /^zurück$/i, /^précédent$/i, /^??$/, /^???$/, /^??$/,
            /^?\s*prev$/i, /^prev\s*?$/i, /older/i, /^back$/i
        ],
        numbered: /^\d+$/
    };

    // =========================================================================
    // STATE
    // =========================================================================

    const DetectionCache = {
        url: '',
        dirty: true,
        candidates: null,
        groups: null,
        lastPromptUrl: ''
    };

    const expensiveTextCache = new WeakMap();

    let feedbackElement = null;
    let feedbackTimeout = null;
    let mutationObserver = null;
    let mutationScheduled = false;

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function debugLog(...args) {
        if (Config.debug) console.log('[PageHop]', ...args);
    }

    function safeJsonParse(raw, fallback) {
        try { return JSON.parse(raw); } catch { return fallback; }
    }

    function loadConfig() {
        try {
            const saved = GM_getValue(STORAGE.CONFIG);
            if (!saved) return;

            const parsed = safeJsonParse(saved, null);
            if (!parsed) return;

            if (parsed.bindings) {
                for (const [action, binding] of Object.entries(parsed.bindings)) {
                    if (Config.bindings[action]) Object.assign(Config.bindings[action], binding);
                }
            }
            if (parsed.pagination) Object.assign(Config.pagination, parsed.pagination);
            if (parsed.ajax) Object.assign(Config.ajax, parsed.ajax);
            if (parsed.detection) Object.assign(Config.detection, parsed.detection);
            if (parsed.feedback) Object.assign(Config.feedback, parsed.feedback);
            if (typeof parsed.debug === 'boolean') Config.debug = parsed.debug;
        } catch (e) {
            console.error('[PageHop] Error loading config:', e);
        }
    }

    // =========================================================================
    // SITE OVERRIDES (ENABLE/DISABLE)
    // =========================================================================

    function getSiteOverrides() {
        const raw = GM_getValue(STORAGE.SITE_OVERRIDES);
        return raw ? safeJsonParse(raw, {}) : {};
    }

    function saveSiteOverride(domain, override) {
        const overrides = getSiteOverrides();
        overrides[domain] = override;
        GM_setValue(STORAGE.SITE_OVERRIDES, JSON.stringify(overrides));
        debugLog('Saved site override for', domain, override);
    }

    function getSiteOverride() {
        return getSiteOverrides()[window.location.hostname] || null;
    }

    function disableSite() {
        saveSiteOverride(window.location.hostname, { disabled: true });
        showFeedback('Disabled on this site', true);
    }

    function enableSite() {
        saveSiteOverride(window.location.hostname, { disabled: false });
        showFeedback('Enabled on this site', true);
    }

    // =========================================================================
    // GROUP CHOICE PERSISTENCE
    // =========================================================================

    function getGroupChoices() {
        const raw = GM_getValue(STORAGE.GROUP_CHOICES);
        return raw ? safeJsonParse(raw, {}) : {};
    }

    function saveGroupChoice(domain, signature) {
        const choices = getGroupChoices();
        choices[domain] = { signature, savedAt: Date.now() };
        GM_setValue(STORAGE.GROUP_CHOICES, JSON.stringify(choices));
        debugLog('Saved group choice for', domain);
    }

    function loadGroupChoice(domain) {
        const choices = getGroupChoices();
        return choices[domain]?.signature || null;
    }

    function clearGroupChoice(domain) {
        const choices = getGroupChoices();
        delete choices[domain];
        GM_setValue(STORAGE.GROUP_CHOICES, JSON.stringify(choices));
        showFeedback('Saved target cleared', true);
    }

    // =========================================================================
    // CACHE INVALIDATION
    // =========================================================================

    function invalidateCache(reason) {
        DetectionCache.dirty = true;
        DetectionCache.candidates = null;
        DetectionCache.groups = null;
        debugLog('Cache invalidated:', reason);
    }

    function onUrlChanged(reason) {
        DetectionCache.url = window.location.href;
        DetectionCache.lastPromptUrl = '';
        invalidateCache(reason);
    }

    function installUrlChangeHooks() {
        const wrap = (fnName) => {
            const original = history[fnName];
            if (typeof original !== 'function') return;
            history[fnName] = function(...args) {
                const before = window.location.href;
                const ret = original.apply(this, args);
                if (window.location.href !== before) onUrlChanged(fnName);
                return ret;
            };
        };
        wrap('pushState');
        wrap('replaceState');

        window.addEventListener('popstate', () => onUrlChanged('popstate'), true);
        window.addEventListener('hashchange', () => onUrlChanged('hashchange'), true);
    }

    function installMutationObserver() {
        if (mutationObserver || !document.body) return;
        mutationObserver = new MutationObserver(() => {
            if (mutationScheduled) return;
            mutationScheduled = true;
            setTimeout(() => {
                mutationScheduled = false;
                invalidateCache('mutation');
            }, 250);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // VISIBILITY & CLICKABILITY
    // =========================================================================

    function isVisible(el) {
        if (!el || el.nodeType !== 1 || el.getClientRects().length === 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function isClickable(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return !!(el.getAttribute('href') || el.href);
        if (tag === 'button') return true;
        if (el.getAttribute('role') === 'button') return true;
        if (el.hasAttribute('onclick') || el.hasAttribute('data-action')) return true;
        return false;
    }

    function getHref(el) {
        if (!el) return '';
        return el.getAttribute('href') || el.href || '';
    }

    function isUsableHref(href) {
        if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('#')) return false;
        return true;
    }

    function isSameSection(href) {
        if (!href) return false;
        try {
            const target = new URL(href, window.location.origin);
            const current = new URL(window.location.href);

            if (target.origin !== current.origin) return false;
            if (target.pathname === current.pathname) return true;

            const currentBase = current.pathname.replace(/\/$/, '');
            if (currentBase && target.pathname.startsWith(currentBase + '/')) return true;

            const targetBase = target.pathname.replace(/\/$/, '');
            if (targetBase && current.pathname.startsWith(targetBase + '/')) return true;

            const currentParts = current.pathname.split('/').filter(Boolean);
            const targetParts = target.pathname.split('/').filter(Boolean);

            if (currentParts.length === targetParts.length && currentParts.length > 0) {
                let diffCount = 0, diffIdx = -1;
                for (let i = 0; i < currentParts.length; i++) {
                    if (currentParts[i] !== targetParts[i]) { diffCount++; diffIdx = i; }
                }
                if (diffCount === 1 && /^\d+$/.test(targetParts[diffIdx])) return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    function hrefLooksLikePagination(href) {
        if (!href) return false;
        return /[?&](page|p|pg)=\d+/i.test(href) ||
               /\/(page|p|pg)\/\d+/i.test(href) ||
               /-page[-/]\d+/i.test(href) ||
               /offset=\d+/i.test(href) ||
               /start=\d+/i.test(href);
    }

    // =========================================================================
    // TEXT EXTRACTION
    // =========================================================================

    function getTextCheap(el) {
        return el?.textContent?.trim() || '';
    }

    function getTextExpensiveCached(el) {
        if (!el || el.nodeType !== 1) return '';
        const cached = expensiveTextCache.get(el);
        if (typeof cached === 'string') return cached;

        const clone = el.cloneNode(true);
        clone.querySelectorAll('svg, img, i, span.icon, [class*="icon"], [aria-hidden="true"]').forEach(n => n.remove());

        const text = clone.textContent?.trim() || '';
        expensiveTextCache.set(el, text);
        return text;
    }

    function classifyByText(text) {
        if (!text) return null;
        const norm = text.toLowerCase();
        for (const p of TEXT_PATTERNS.next) if (p.test(norm)) return 'next';
        for (const p of TEXT_PATTERNS.prev) if (p.test(norm)) return 'prev';
        if (TEXT_PATTERNS.numbered.test(norm)) return 'numbered';
        return null;
    }

    // =========================================================================
    // SCOPE PRIORITISATION
    // =========================================================================

    function isPaginationLikeContainer(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'nav') return true;

        const role = (el.getAttribute('role') || '').toLowerCase();
        if (role === 'navigation') return true;

        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('pagination') || aria.includes('page')) return true;

        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if (cls.includes('pagination') || cls.includes('pager') || cls.includes('page-nav')) return true;

        const id = (el.id || '').toLowerCase();
        if (id.includes('pagination') || id.includes('pager')) return true;

        const ds = el.dataset || {};
        const tokens = [
            (ds.testid || '').toLowerCase(),
            (ds.test || '').toLowerCase(),
            (ds.role || '').toLowerCase(),
            (ds.component || '').toLowerCase()
        ].join(' ');
        if (tokens.includes('pagination') || tokens.includes('pager')) return true;

        return false;
    }

    function getPriorityScopes() {
        const scopes = [];
        const seen = new Set();

        const addScope = (el) => {
            if (!el || el === document.body) return;
            if (!isVisible(el)) return;
            if (seen.has(el)) return;
            seen.add(el);
            scopes.push(el);
        };

        const candidates = document.querySelectorAll(
            'nav, [role="navigation"], [class*="pagination"], [class*="pager"], [id*="pagination"], [id*="pager"], [data-testid], [data-test], [data-role]'
        );

        for (const el of candidates) {
            if (scopes.length >= Config.detection.maxScopes) break;
            if (!isPaginationLikeContainer(el)) continue;
            addScope(el);
        }

        // If nothing obvious, try nearest containers around rel=next/prev anchors (still cheap)
        if (scopes.length === 0) {
            const relLinks = document.querySelectorAll('a[rel~="next"], a[rel~="prev"], a[rel~="previous"]');
            for (const a of relLinks) {
                if (scopes.length >= Config.detection.maxScopes) break;
                const container = a.closest('nav, [role="navigation"], [class*="pagination"], [class*="pager"], [id*="pagination"], [id*="pager"]');
                if (container) addScope(container);
            }
        }

        // Always include body as last resort
        if (document.body) scopes.push(document.body);

        return scopes;
    }

    // =========================================================================
    // TWO-STAGE DETECTION (SCOPED + CAPPED)
    // =========================================================================

    function findPaginationCandidates() {
        const candidates = { next: [], prev: [], numbered: [], seoNext: [], seoPrev: [] };
        const seen = new WeakSet();

        function add(el, role, confidence, source) {
            if (!el || seen.has(el)) return;
            if (role !== 'seoNext' && role !== 'seoPrev') {
                if (!isVisible(el)) return;
                if (!isClickable(el)) return;
            }
            seen.add(el);
            candidates[role].push({ el, confidence, source });
        }

        // SEO <link rel="next/prev"> (fallback only)
        document.querySelectorAll('link[rel="next"]').forEach(el => {
            if (el?.href) candidates.seoNext.push({ el, confidence: 100, source: 'seo' });
        });
        document.querySelectorAll('link[rel="prev"], link[rel="previous"]').forEach(el => {
            if (el?.href) candidates.seoPrev.push({ el, confidence: 100, source: 'seo' });
        });

        const scopes = getPriorityScopes();

        // Stage 1: cheap signals, scoped
        for (const scope of scopes) {
            // rel on anchors
            scope.querySelectorAll('a[rel~="next"]').forEach(el => add(el, 'next', 100, 'rel'));
            scope.querySelectorAll('a[rel~="prev"], a[rel~="previous"]').forEach(el => add(el, 'prev', 100, 'rel'));

            // aria-label on clickables
            scope.querySelectorAll('a[aria-label], button[aria-label], [role="button"][aria-label]').forEach(el => {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (!label) return;
                if (/\bnext\b/.test(label) && !/\bprev/.test(label)) add(el, 'next', 90, 'aria');
                else if (/\bprev(ious)?\b/.test(label) && !/\bnext\b/.test(label)) add(el, 'prev', 90, 'aria');
            });

            // data-page on clickables
            scope.querySelectorAll('a[data-page], button[data-page], [role="button"][data-page]').forEach(el => {
                const val = (el.getAttribute('data-page') || '').toLowerCase();
                if (val === 'next') add(el, 'next', 85, 'data');
                else if (val === 'prev' || val === 'previous') add(el, 'prev', 85, 'data');
            });

            // class tokens on clickables
            scope.querySelectorAll('a[class*="next"], button[class*="next"], [role="button"][class*="next"]').forEach(el => {
                const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                if (cls.includes('prev')) return;
                add(el, 'next', 70, 'class');
            });
            scope.querySelectorAll('a[class*="prev"], button[class*="prev"], [role="button"][class*="prev"]').forEach(el => {
                const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                if (cls.includes('next')) return;
                add(el, 'prev', 70, 'class');
            });
        }

        // Numbered controls: only inside pagination-like scopes (avoid body-wide number scanning)
        for (const scope of scopes) {
            if (scope === document.body) continue;
            if (!isPaginationLikeContainer(scope)) continue;
            scope.querySelectorAll('a[href], button, [role="button"]').forEach(el => {
                if (seen.has(el) || !isVisible(el) || !isClickable(el)) return;
                const text = getTextCheap(el);
                if (TEXT_PATTERNS.numbered.test(text)) add(el, 'numbered', 60, 'text');
            });
        }

        // Stage 2: expensive-ish text confirmation, scoped + capped, only if needed
        if (candidates.next.length < 2 || candidates.prev.length < 2) {
            let globalScanned = 0;

            for (const scope of scopes) {
                if (globalScanned >= Config.detection.maxStage2Global) break;

                // On body scope, only proceed if we truly have no good scoped containers
                if (scope === document.body && scopes.length > 1) continue;

                const clickables = scope.querySelectorAll('a[href], button, [role="button"]');
                let perScopeScanned = 0;

                for (const el of clickables) {
                    if (globalScanned >= Config.detection.maxStage2Global) break;
                    if (perScopeScanned >= Config.detection.maxStage2PerScope) break;
                    if (seen.has(el) || !isVisible(el) || !isClickable(el)) continue;

                    perScopeScanned++;
                    globalScanned++;

                    let text = getTextCheap(el);

                    // Only go expensive if empty/mostly icon/oddly long
                    if (!text || text.length > 50 || /^[\s\u200b]*$/.test(text)) {
                        text = getTextExpensiveCached(el);
                    }

                    const role = classifyByText(text);
                    if (role && role !== 'numbered') add(el, role, 50, 'text');
                }
            }
        }

        debugLog(
            'Candidates:',
            candidates.next.length, 'next,',
            candidates.prev.length, 'prev,',
            candidates.numbered.length, 'numbered,',
            candidates.seoNext.length, 'seoNext,',
            candidates.seoPrev.length, 'seoPrev'
        );

        return candidates;
    }

    // =========================================================================
    // ANCESTRY-BASED GROUPING (WITH "TOO BROAD" HEURISTIC)
    // =========================================================================

    function getDepth(el) {
        let d = 0;
        while (el && el !== document.body) { d++; el = el.parentElement; }
        return d;
    }

    function isTooBroadContainer(el, descendantCount) {
        if (!el || el === document.body) return true;

        if (descendantCount >= Config.detection.maxContainerDescendantsHard) return true;
        if (descendantCount < Config.detection.broadRectMinDescendants) return false;

        // Avoid rejecting true pagination navs even if they're wide
        if (isPaginationLikeContainer(el)) return false;

        // Rect-area heuristic: only used for mid-large containers
        try {
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;

            const viewportArea = Math.max(1, window.innerWidth) * Math.max(1, window.innerHeight);
            const rectArea = rect.width * rect.height;
            const ratio = rectArea / viewportArea;

            return ratio >= Config.detection.broadRectAreaRatio;
        } catch {
            return false;
        }
    }

    function groupCandidates(candidates) {
        const all = [
            ...candidates.next.map(c => ({ ...c, role: 'next' })),
            ...candidates.prev.map(c => ({ ...c, role: 'prev' })),
            ...candidates.numbered.map(c => ({ ...c, role: 'numbered' }))
        ];

        if (all.length === 0) return [];

        const ancestorCounts = new Map();
        const maxLevels = Config.detection.maxAncestorLevels;

        all.forEach((c, idx) => {
            let node = c.el.parentElement;
            let level = 0;
            while (node && node !== document.body && level < maxLevels) {
                if (!ancestorCounts.has(node)) ancestorCounts.set(node, new Set());
                ancestorCounts.get(node).add(idx);
                node = node.parentElement;
                level++;
            }
        });

        const qualifying = [];
        for (const [ancestor, indices] of ancestorCounts) {
            if (indices.size < 2) continue;

            // Quick descendant check (querySelectorAll('*') is pricey but ok at this scale)
            const descendantCount = ancestor.querySelectorAll('*').length;
            if (isTooBroadContainer(ancestor, descendantCount)) continue;

            qualifying.push({
                el: ancestor,
                depth: getDepth(ancestor),
                indices
            });
        }

        qualifying.sort((a, b) => b.depth - a.depth);

        const assigned = new Set();
        const groups = [];

        for (const anc of qualifying) {
            const members = [];
            for (const idx of anc.indices) {
                if (!assigned.has(idx)) {
                    assigned.add(idx);
                    members.push(all[idx]);
                }
            }
            if (members.length >= 2) {
                groups.push({
                    container: anc.el,
                    candidates: members,
                    hasNext: members.some(x => x.role === 'next'),
                    hasPrev: members.some(x => x.role === 'prev'),
                    hasNumbered: members.some(x => x.role === 'numbered')
                });
            }
        }

        // Singletons become own groups
        for (let i = 0; i < all.length; i++) {
            if (!assigned.has(i)) {
                const c = all[i];
                groups.push({
                    container: null,
                    candidates: [c],
                    hasNext: c.role === 'next',
                    hasPrev: c.role === 'prev',
                    hasNumbered: c.role === 'numbered'
                });
            }
        }

        debugLog('Groups formed:', groups.length);
        return groups;
    }

    // =========================================================================
    // GROUP SCORING
    // =========================================================================

    function looksLikePostNav(group) {
        if (group.hasNumbered) return false;

        const nextCandidates = group.candidates.filter(c => c.role === 'next');
        const prevCandidates = group.candidates.filter(c => c.role === 'prev');
        if (nextCandidates.length !== 1 || prevCandidates.length !== 1) return false;

        const nextHref = getHref(nextCandidates[0].el);
        const prevHref = getHref(prevCandidates[0].el);

        if (!isUsableHref(nextHref) || !isUsableHref(prevHref)) return false;
        if (isSameSection(nextHref) || isSameSection(prevHref)) return false;
        if (hrefLooksLikePagination(nextHref) || hrefLooksLikePagination(prevHref)) return false;

        return true;
    }

    function scoreGroup(group) {
        let score = 0;

        if (group.hasNext && group.hasPrev) score += 30;
        if (group.hasNumbered) score += 25;

        const hasCurrent = group.candidates.some(c =>
            c.el.getAttribute('aria-current') === 'page' ||
            c.el.classList.contains('current') ||
            c.el.classList.contains('active')
        );
        if (hasCurrent) score += 20;

        const hasAjax = group.candidates.some(c => {
            const tag = c.el.tagName.toLowerCase();
            if (tag === 'button' || c.el.getAttribute('role') === 'button') return true;
            const href = getHref(c.el);
            return !href || href === '#' || href.startsWith('javascript:');
        });
        if (hasAjax) score += 15;

        if (group.container) {
            const nav = group.container.closest('nav, [role="navigation"]');
            if (nav) {
                const label = (nav.getAttribute('aria-label') || '').toLowerCase();
                if (label.includes('page') || label.includes('pagination')) score += 10;
            }
            if (isPaginationLikeContainer(group.container)) score += 10;
        }

        const avg = group.candidates.reduce((s, c) => s + c.confidence, 0) / Math.max(1, group.candidates.length);
        score += avg * 0.2;

        if (looksLikePostNav(group)) score -= 20;
        if (group.container === document.body) score -= 15;

        return score;
    }

    function selectBestGroup(groups) {
        if (groups.length === 0) return null;
        if (groups.length === 1) return groups[0];

        const scored = groups.map(g => ({ group: g, score: scoreGroup(g) }));
        scored.sort((a, b) => b.score - a.score);

        if (scored.length > 1 && (scored[0].score - scored[1].score) < 15) {
            return { ambiguous: true, options: scored.slice(0, 9) };
        }

        return scored[0].group;
    }

    // =========================================================================
    // GROUP SIGNATURES (RICHER ATTR MATCHING)
    // =========================================================================

    function extractStableClasses(el) {
        if (!el || typeof el.className !== 'string') return [];
        return el.className.split(/\s+/)
            .filter(Boolean)
            .filter(c => !/^(active|current|selected|open|visible|show|hide|disabled)$/i.test(c))
            .filter(c => !/^[a-z]+-[a-f0-9]{4,}$/i.test(c)) // hash-like tokens
            .slice(0, 6);
    }

    function pickStableAttrs(el) {
        if (!el || el.nodeType !== 1) return {};
        const ds = el.dataset || {};

        const stableData = {};
        const keys = ['testid', 'test', 'role', 'action', 'page', 'nav', 'component', 'cy'];
        for (const k of keys) {
            const v = ds[k];
            if (typeof v === 'string' && v.length > 0 && v.length <= 80) stableData[`data-${k}`] = v;
        }

        const ariaLabel = el.getAttribute('aria-label') || null;
        const role = el.getAttribute('role') || null;

        return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            role,
            ariaLabel,
            classes: extractStableClasses(el),
            data: stableData
        };
    }

    function getAncestorSketch(el, levels) {
        const sketch = [];
        let node = el?.parentElement;
        let level = 0;
        while (node && node !== document.body && level < levels) {
            sketch.push({
                tag: node.tagName.toLowerCase(),
                classes: extractStableClasses(node).slice(0, 3)
            });
            node = node.parentElement;
            level++;
        }
        return sketch;
    }

    function createGroupSignature(group) {
        return {
            hasNext: group.hasNext,
            hasPrev: group.hasPrev,
            hasNumbered: group.hasNumbered,
            candidateCount: group.candidates.length,
            container: group.container ? {
                ...pickStableAttrs(group.container),
                ancestors: getAncestorSketch(group.container, 3)
            } : null,
            candidateSample: group.candidates.slice(0, 3).map(c => ({
                role: c.role,
                ...pickStableAttrs(c.el)
            }))
        };
    }

    function matchGroupToSignature(groups, sig) {
        for (const group of groups) {
            let score = 0;

            // Shape match
            if (group.hasNext === sig.hasNext) score += 10;
            if (group.hasPrev === sig.hasPrev) score += 10;
            if (group.hasNumbered === sig.hasNumbered) score += 10;

            // Container match
            if (sig.container && group.container) {
                const g = pickStableAttrs(group.container);

                if (sig.container.id && g.id === sig.container.id) score += 50;
                if (sig.container.ariaLabel && g.ariaLabel === sig.container.ariaLabel) score += 25;
                if (sig.container.role && g.role === sig.container.role) score += 8;

                // Data attrs
                const sigData = sig.container.data || {};
                const gData = g.data || {};
                for (const [k, v] of Object.entries(sigData)) {
                    if (gData[k] === v) score += 12;
                }

                // Class overlap
                const overlap = (sig.container.classes || []).filter(c => (g.classes || []).includes(c));
                score += overlap.length * 3;

                // Ancestor sketch light check (avoid heavy work)
                const sigAnc = sig.container.ancestors || [];
                const gAnc = getAncestorSketch(group.container, 2);
                for (let i = 0; i < Math.min(sigAnc.length, gAnc.length, 2); i++) {
                    if (sigAnc[i].tag === gAnc[i].tag) score += 2;
                    const ancOverlap = (sigAnc[i].classes || []).filter(c => (gAnc[i].classes || []).includes(c));
                    score += ancOverlap.length * 1;
                }
            } else if (!sig.container && !group.container) {
                score += 15;
            }

            if (score >= 35) return group;
        }
        return null;
    }

    // =========================================================================
    // CACHE ACCESS
    // =========================================================================

    function ensureCache() {
        if (!document.body) return false;

        if (DetectionCache.url !== window.location.href) {
            DetectionCache.url = window.location.href;
            DetectionCache.dirty = true;
        }
        if (!DetectionCache.dirty && DetectionCache.groups) return true;

        DetectionCache.candidates = findPaginationCandidates();
        DetectionCache.groups = groupCandidates(DetectionCache.candidates);
        DetectionCache.dirty = false;

        return true;
    }

    function getCandidatesAndGroups() {
        if (!ensureCache()) return { candidates: null, groups: [] };
        return { candidates: DetectionCache.candidates, groups: DetectionCache.groups || [] };
    }

    // =========================================================================
    // SELECTION UI
    // =========================================================================

    function findNearestContext(el) {
        if (!el) return null;

        // Check the container itself for aria-label
        const ownLabel = el.getAttribute?.('aria-label');
        if (ownLabel) return ownLabel;

        // Walk previous siblings and ancestors looking for headings or labelled landmarks
        const maxWalk = 12;
        let walked = 0;

        // Scan backwards through previous siblings first
        let sibling = el.previousElementSibling;
        while (sibling && walked < maxWalk) {
            walked++;
            // Check if sibling is a heading
            if (/^H[1-6]$/.test(sibling.tagName)) {
                const text = sibling.textContent?.trim();
                if (text && text.length <= 80) return text;
            }
            // Check for heading inside sibling
            const heading = sibling.querySelector('h1, h2, h3, h4, h5, h6');
            if (heading) {
                const text = heading.textContent?.trim();
                if (text && text.length <= 80) return text;
            }
            sibling = sibling.previousElementSibling;
        }

        // Walk up ancestors, checking each level's previous siblings
        let ancestor = el.parentElement;
        let level = 0;
        while (ancestor && ancestor !== document.body && level < 5) {
            level++;

            const ancestorLabel = ancestor.getAttribute?.('aria-label');
            if (ancestorLabel && ancestorLabel.length <= 80) return ancestorLabel;

            sibling = ancestor.previousElementSibling;
            walked = 0;
            while (sibling && walked < 6) {
                walked++;
                if (/^H[1-6]$/.test(sibling.tagName)) {
                    const text = sibling.textContent?.trim();
                    if (text && text.length <= 80) return text;
                }
                const heading = sibling.querySelector('h1, h2, h3, h4, h5, h6');
                if (heading) {
                    const text = heading.textContent?.trim();
                    if (text && text.length <= 80) return text;
                }
                sibling = sibling.previousElementSibling;
            }

            ancestor = ancestor.parentElement;
        }

        return null;
    }

    const HIGHLIGHT_ATTR = 'data-pagehop-highlight';

    function ensureHighlightStyle() {
        if (document.getElementById('pagehop-highlight-style')) return;
        const style = document.createElement('style');
        style.id = 'pagehop-highlight-style';
        style.textContent = `
            @keyframes pagehop-pulse {
                0%, 100% { outline-color: #ff2e92; }
                50% { outline-color: rgba(255, 46, 146, 0.3); }
            }
            [${HIGHLIGHT_ATTR}] { outline-style: solid !important; outline-width: 3px !important; outline-color: #ff2e92; outline-offset: 2px !important; border-radius: 3px !important; position: relative !important; z-index: 1000000 !important; animation: pagehop-pulse 1.2s ease-in-out infinite !important; }
        `;
        document.head.appendChild(style);
    }

    function highlightGroup(group) {
        ensureHighlightStyle();
        for (const c of group.candidates) {
            if (c.el && c.el.nodeType === 1) {
                c.el.setAttribute(HIGHLIGHT_ATTR, '');
            }
        }

        // Scroll the first candidate into view if off-screen
        const first = group.candidates[0]?.el;
        if (first) {
            const rect = first.getBoundingClientRect();
            const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
            if (!inView) {
                const targetY = window.scrollY + rect.top - (window.innerHeight * 0.25);
                window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }
        }
    }

    function unhighlightAll() {
        const highlighted = document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`);
        for (const el of highlighted) {
            el.removeAttribute(HIGHLIGHT_ATTR);
        }
    }

    function describeGroup(group) {
        const parts = [];
        if (group.hasNext && group.hasPrev) parts.push('Next/Prev');
        else if (group.hasNext) parts.push('Next only');
        else if (group.hasPrev) parts.push('Prev only');
        if (group.hasNumbered) parts.push('numbered');

        const context = findNearestContext(group.container);
        if (context) {
            parts.push(`near '${context}'`);
        } else if (group.container) {
            const desc = group.container.getAttribute('aria-label') ||
                         extractStableClasses(group.container)[0] ||
                         group.container.tagName.toLowerCase();
            parts.push(`in ${desc}`);
        } else {
            parts.push('page-level');
        }

        return parts.join(', ');
    }

    function showGroupSelector(options, onSelect) {
        const overlay = document.createElement('div');
        overlay.id = 'pagehop-selector';
        overlay.innerHTML = `
            <style>
                #pagehop-selector, #pagehop-selector *, #pagehop-selector *::before, #pagehop-selector *::after {
                    box-sizing: border-box; margin: 0; padding: 0;
                }
                #pagehop-selector {
                    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px;
                    --rs: 8px; --rm: 12px; --rl: 18px;
                    --fs: 14px; --fxs: 11px;
                    --wm: 400; --wl: 500;
                    --fast: 120ms cubic-bezier(0.2, 0, 0.2, 1);
                    --surface: rgb(11, 14, 23);
                    --e1: rgb(28, 31, 41);
                    --e2: rgb(40, 43, 54);
                    --e3: rgb(56, 60, 72);
                    --text: rgb(228, 228, 242);
                    --mute: rgb(145, 147, 159);
                    --strong: rgb(240, 240, 252);
                    --accent: rgb(30, 171, 208);
                    --bl: rgba(228, 228, 242, 0.10);
                    --bm: rgba(228, 228, 242, 0.22);
                    --shadow: 0 4px 12px rgba(0, 0, 0, 0.78);

                    position: fixed; inset: 0;
                    background: rgba(0, 0, 0, 0.6);
                    display: flex; align-items: center; justify-content: center;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    line-height: 1.4;
                }
                #pagehop-selector .ph-panel {
                    background: var(--surface); border: 1px solid var(--bl);
                    border-radius: var(--rl); box-shadow: var(--shadow);
                    padding: var(--s4); display: flex; flex-direction: column;
                    gap: var(--s3); width: 320px; color: var(--text);
                }
                #pagehop-selector .ph-title {
                    font-size: var(--fs); font-weight: var(--wl); color: var(--strong);
                    padding: 0 var(--s1);
                }
                #pagehop-selector .ph-options {
                    display: flex; flex-direction: column; gap: var(--s1);
                    max-height: calc((44px * 4) + (var(--s1) * 3));
                    overflow-y: auto;
                }
                #pagehop-selector .ph-options::-webkit-scrollbar { width: 4px; }
                #pagehop-selector .ph-options::-webkit-scrollbar-track { background: transparent; }
                #pagehop-selector .ph-options::-webkit-scrollbar-thumb {
                    background: var(--e3); border-radius: 2px;
                }
                #pagehop-selector .ph-option {
                    display: flex; align-items: center; min-height: 44px;
                    padding: var(--s2) var(--s3);
                    background: var(--e1); border: 1px solid var(--bl);
                    border-radius: var(--rs); cursor: pointer;
                    transition: all var(--fast); flex-shrink: 0;
                }
                #pagehop-selector .ph-option:hover {
                    background: var(--e2); border-color: var(--bm);
                }
                #pagehop-selector .ph-option:active { transform: scale(0.97); }
                #pagehop-selector .ph-option-key {
                    font-size: var(--fxs); font-weight: var(--wl); color: var(--accent);
                    width: 20px; flex-shrink: 0;
                }
                #pagehop-selector .ph-option-label {
                    font-size: var(--fs); font-weight: var(--wm); color: var(--text);
                    letter-spacing: 0.3px;
                }
                #pagehop-selector .ph-footer {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 0 var(--s1);
                }
                #pagehop-selector .ph-hint {
                    font-size: var(--fxs); font-weight: var(--wm); color: var(--mute);
                    letter-spacing: 0.3px;
                }
            </style>
            <div class="ph-panel">
                <div class="ph-title">Multiple pagination controls</div>
                <div class="ph-options"></div>
                <div class="ph-footer">
                    <span class="ph-hint">1-9 select · Esc cancel · Hover to preview</span>
                </div>
            </div>
        `;

        const cleanup = () => {
            unhighlightAll();
            overlay.remove();
            document.removeEventListener('keydown', handleKey, true);
        };

        const container = overlay.querySelector('.ph-options');
        options.forEach((opt, idx) => {
            const div = document.createElement('div');
            div.className = 'ph-option';
            div.innerHTML = `
                <span class="ph-option-key">${idx + 1}</span>
                <span class="ph-option-label">${describeGroup(opt.group)}</span>
            `;
            div.addEventListener('mouseenter', () => {
                unhighlightAll();
                highlightGroup(opt.group);
            });
            div.addEventListener('mouseleave', () => {
                unhighlightAll();
            });
            div.addEventListener('click', () => { cleanup(); onSelect(opt.group); });
            container.appendChild(div);
        });

        const handleKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                cleanup(); onSelect(null);
            } else if (e.key >= '1' && e.key <= '9') {
                const idx = parseInt(e.key, 10) - 1;
                if (idx < options.length) {
                    e.preventDefault(); e.stopPropagation();
                    cleanup(); onSelect(options[idx].group);
                }
            }
        };
        document.addEventListener('keydown', handleKey, true);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { cleanup(); onSelect(null); }
        });

        document.body.appendChild(overlay);
    }

    // =========================================================================
    // VISUAL FEEDBACK
    // =========================================================================

    function showFeedback(message, success = true) {
        if (!Config.feedback.enabled || !document.body) return;
        if (feedbackTimeout) clearTimeout(feedbackTimeout);

        if (!feedbackElement) {
            feedbackElement = document.createElement('div');
            feedbackElement.id = 'pagehop-indicator';
            feedbackElement.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                padding: 8px 16px; border-radius: 12px;
                border: 1px solid rgba(228, 228, 242, 0.10);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.78);
                font-size: 14px; font-weight: 500; letter-spacing: 0.3px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                z-index: 999999; transition: opacity 240ms cubic-bezier(0.2, 0, 0.2, 1);
                pointer-events: none; background: rgb(11, 14, 23);
                color: rgb(228, 228, 242);
            `;
            document.body.appendChild(feedbackElement);
        }

        feedbackElement.textContent = message;
        feedbackElement.style.borderColor = success ? 'rgba(0, 162, 103, 0.5)' : 'rgba(255, 113, 100, 0.5)';
        feedbackElement.style.opacity = '1';

        feedbackTimeout = setTimeout(() => {
            if (feedbackElement) feedbackElement.style.opacity = '0';
        }, Config.feedback.timeout);
    }

    // =========================================================================
    // AJAX CLICK HANDLING
    // =========================================================================

    function getDomMetric(scope = document.body) {
        const text = scope?.innerText?.length || 0;
        const els = scope?.querySelectorAll('*').length || 0;
        return text + els * 10;
    }

    async function clickPaginationElement(el, increment) {
        if (!el || !isVisible(el)) return false;

        const contentSelectors = ['main', '[role="main"]', '#content', '#main', '.content', 'article', '.results'];
        let container = null;
        for (const sel of contentSelectors) {
            const found = document.querySelector(sel);
            if (found && isVisible(found)) { container = found; break; }
        }
        if (!container) container = document.body;

        const beforeMetric = getDomMetric(container);
        const beforeUrl = window.location.href;

        if (Config.ajax.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 250));
        }

        showFeedback('Loading...', true);

        try { el.click(); }
        catch { showFeedback('Click failed', false); return false; }

        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (window.location.href !== beforeUrl) { resolve(true); return; }

                const change = Math.abs(getDomMetric(container) - beforeMetric);
                if (change >= Config.ajax.minDomChange) {
                    invalidateCache('ajax-success');
                    showFeedback(increment ? 'Next' : 'Previous', true);
                    resolve(true);
                    return;
                }

                if (Date.now() - start >= Config.ajax.contentLoadTimeout) {
                    showFeedback(increment ? 'Next' : 'Previous', true);
                    resolve(true);
                    return;
                }

                setTimeout(check, 100);
            };
            setTimeout(check, 50);
        });
    }

    // =========================================================================
    // URL-BASED PAGINATION (FALLBACK)
    // =========================================================================

    function identifyPageNumber(url) {
        let urlObj;
        try { urlObj = new URL(url); } catch { return null; }

        const candidates = [];

        for (const [key, value] of urlObj.searchParams.entries()) {
            const k = key.toLowerCase();
            if (Config.pagination.keywords.includes(k) || k.includes('page') || ['offset', 'start', 'p'].includes(k)) {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= Config.pagination.minPageNumber && num <= Config.pagination.maxPageNumber) {
                    candidates.push({
                        type: 'query',
                        value: num,
                        paramName: key,
                        leadingZeros: value.length - num.toString().length,
                        score: 200
                    });
                }
            }
        }

        const patterns = [
            { regex: /\/(page|pagina|seite)\/(\d+)(\/|$)/i, score: 180 },
            { regex: /\/(p|pg)\/(\d+)(\/|$)/i, score: 175 },
            { regex: /-page[/-](\d+)(\/|$)/, score: 170 },
            { regex: /\/(\d+)\/?$/, score: 145 }
        ];

        for (const p of patterns) {
            const m = url.match(p.regex);
            if (!m) continue;

            let digitStr = '';
            for (let i = 1; i < m.length; i++) {
                if (m[i] && /^\d+$/.test(m[i])) { digitStr = m[i]; break; }
            }
            if (!digitStr) continue;

            const num = parseInt(digitStr, 10);
            if (num < Config.pagination.minPageNumber || num > Config.pagination.maxPageNumber) continue;

            candidates.push({
                type: 'path',
                value: num,
                leadingZeros: digitStr.length - num.toString().length,
                score: p.score,
                matchedString: m[0],
                matchPosition: url.indexOf(m[0]),
                digitPosition: m[0].indexOf(digitStr),
                digitStr
            });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0];
    }

    function inferPaginationStyle() {
        const checks = [
            { sel: 'a[href*="/page/"]', style: 'path-page' },
            { sel: 'a[href*="/p/"]', style: 'path-p' },
            { sel: 'a[href*="-page-"]', style: 'dash-page' }
        ];
        for (const c of checks) {
            if (document.querySelector(c.sel)) return c.style;
        }
        return 'query';
    }

    function adjustPageByUrl(increment) {
        const { stepSize, minPageNumber, maxPageNumber } = Config.pagination;
        const url = new URL(window.location.href);
        const fragment = url.hash;
        const pageInfo = identifyPageNumber(url.href);

        if (!pageInfo) {
            if (increment) {
                const style = inferPaginationStyle();
                switch (style) {
                    case 'path-page': url.pathname = url.pathname.replace(/\/$/, '') + '/page/2/'; break;
                    case 'path-p':    url.pathname = url.pathname.replace(/\/$/, '') + '/p/2/'; break;
                    case 'dash-page': url.pathname = url.pathname.replace(/\/$/, '') + '-page-2'; break;
                    default:          url.searchParams.set('page', '2');
                }
                let newUrl = url.toString();
                if (fragment && !newUrl.includes('#')) newUrl += fragment;
                showFeedback('Page 2');
                window.location.href = newUrl;
            } else {
                showFeedback('No pagination detected', false);
            }
            return;
        }

        const newPage = pageInfo.value + (increment ? stepSize : -stepSize);
        if (newPage < minPageNumber) { showFeedback('Already at first page', false); return; }
        if (newPage > maxPageNumber) { showFeedback('Page limit reached', false); return; }

        const pad = pageInfo.leadingZeros > 0 ? pageInfo.value.toString().length + pageInfo.leadingZeros : 0;
        const newPageStr = pad > 0 ? newPage.toString().padStart(pad, '0') : newPage.toString();

        let newUrl;
        if (pageInfo.type === 'query') {
            url.searchParams.set(pageInfo.paramName, newPageStr);
            newUrl = url.toString();
        } else {
            const before = pageInfo.matchedString.slice(0, pageInfo.digitPosition);
            const after = pageInfo.matchedString.slice(pageInfo.digitPosition + pageInfo.digitStr.length);
            newUrl = url.href.slice(0, pageInfo.matchPosition) + before + newPageStr + after +
                     url.href.slice(pageInfo.matchPosition + pageInfo.matchedString.length);
        }

        if (fragment && !newUrl.includes('#')) newUrl += fragment;

        if (newUrl !== window.location.href) {
            showFeedback(`Page ${newPage}`);
            window.location.href = newUrl;
        }
    }

    // =========================================================================
    // RESOLUTION FLOW
    // =========================================================================

    async function resolvePaginationTarget(increment, allowPrompt) {
        const override = getSiteOverride();
        if (override?.disabled) {
            showFeedback('Disabled on this site', false);
            return { type: 'disabled' };
        }

        const domain = window.location.hostname;
        const savedSig = loadGroupChoice(domain);
        const { candidates, groups } = getCandidatesAndGroups();

        const usable = groups.filter(g => increment ? g.hasNext : g.hasPrev);

        // If DOM groups fail, use SEO rel=next/prev href as a clean URL jump, else URL fallback.
        if (usable.length === 0) {
            const seoEl = increment ? candidates?.seoNext?.[0]?.el : candidates?.seoPrev?.[0]?.el;
            const seoHref = seoEl?.href || '';
            if (seoHref) return { type: 'url', value: seoHref };
            return { type: 'url-fallback' };
        }

        let chosenGroup = null;

        if (savedSig) {
            chosenGroup = matchGroupToSignature(usable, savedSig);
            if (!chosenGroup) {
                debugLog('Saved target not found');
                showFeedback('Saved target not found', false);
            }
        }

        if (!chosenGroup) {
            const selection = selectBestGroup(usable);

            if (selection && selection.ambiguous && allowPrompt && DetectionCache.lastPromptUrl !== window.location.href) {
                DetectionCache.lastPromptUrl = window.location.href;
                return new Promise(resolve => {
                    showGroupSelector(selection.options, (group) => {
                        if (group) {
                            saveGroupChoice(domain, createGroupSignature(group));
                            showFeedback('Target saved', true);
                            resolve(extractTarget(group, increment));
                        } else {
                            resolve({ type: 'url-fallback' });
                        }
                    });
                });
            }

            chosenGroup = selection && !selection.ambiguous ? selection : (selection?.options?.[0]?.group || null);
        }

        if (!chosenGroup) return { type: 'url-fallback' };

        return extractTarget(chosenGroup, increment);
    }

    function extractTarget(group, increment) {
        const candidates = group.candidates.filter(c => c.role === (increment ? 'next' : 'prev'));
        if (candidates.length === 0) return { type: 'url-fallback' };

        candidates.sort((a, b) => b.confidence - a.confidence);
        const el = candidates[0].el;

        const href = getHref(el);
        if (isUsableHref(href) && isSameSection(href)) {
            try { return { type: 'url', value: new URL(href, location.origin).href }; } catch {}
        }

        if (Config.ajax.enabled) return { type: 'click', value: el };

        return { type: 'url-fallback' };
    }

    // =========================================================================
    // ACTION EXECUTION
    // =========================================================================

    async function adjustPage(increment) {
        debugLog('adjustPage:', increment ? 'next' : 'prev');

        const target = await resolvePaginationTarget(increment, true);

        if (target.type === 'disabled') return;

        if (target.type === 'url') {
            const pageNum = identifyPageNumber(target.value)?.value;
            showFeedback(pageNum ? `Page ${pageNum}` : (increment ? 'Next' : 'Previous'));
            window.location.href = target.value;
            return;
        }

        if (target.type === 'click') {
            await clickPaginationElement(target.value, increment);
            return;
        }

        adjustPageByUrl(increment);
    }

    function navigateHistory(forward) {
        debugLog('History:', forward ? 'forward' : 'back');
        if (forward) history.forward();
        else history.back();
        showFeedback(forward ? 'Forward' : 'Back', true);
    }

    // =========================================================================
    // DEBUG INFO
    // =========================================================================

    function showDebugInfo() {
        const { candidates, groups } = getCandidatesAndGroups();
        const urlPageInfo = identifyPageNumber(window.location.href);
        const domain = window.location.hostname;
        const savedSig = loadGroupChoice(domain);
        const override = getSiteOverride();

        const info = [
            '=== Page Hopper v9.2.0 Debug ===',
            `URL: ${window.location.href}`,
            `URL Page: ${urlPageInfo ? `${urlPageInfo.value} (${urlPageInfo.type}, score: ${urlPageInfo.score})` : 'not detected'}`,
            `Site override: ${override ? JSON.stringify(override) : 'none'}`,
            `Saved signature: ${savedSig ? 'yes' : 'no'}`,
            '',
            'Candidates:',
            `  Next: ${candidates?.next?.length || 0}`,
            `  Prev: ${candidates?.prev?.length || 0}`,
            `  Numbered: ${candidates?.numbered?.length || 0}`,
            `  SEO Next: ${candidates?.seoNext?.length || 0}`,
            `  SEO Prev: ${candidates?.seoPrev?.length || 0}`,
            '',
            `Groups: ${groups?.length || 0}`
        ];

        groups?.forEach((g, i) => {
            info.push(`  ${i + 1}. ${describeGroup(g)} (score: ${scoreGroup(g).toFixed(0)})`);
        });

        console.log(info.join('\n'));
        showFeedback(`${groups?.length || 0} groups, ${candidates?.next?.length || 0}N/${candidates?.prev?.length || 0}P`, true);
    }

    // =========================================================================
    // INPUT HANDLING
    // =========================================================================

    function eventMatchesBinding(event, binding) {
        if (event.key !== binding.key) return false;
        if (!!binding.ctrl  !== event.ctrlKey)  return false;
        if (!!binding.shift !== event.shiftKey) return false;
        if (!!binding.alt   !== event.altKey)   return false;
        if (!!binding.meta  !== event.metaKey)  return false;
        return true;
    }

    function resolveAction(event) {
        const entries = Object.entries(Config.bindings);
        entries.sort((a, b) => {
            const countMods = x => (x.ctrl ? 1 : 0) + (x.shift ? 1 : 0) + (x.alt ? 1 : 0) + (x.meta ? 1 : 0);
            return countMods(b[1]) - countMods(a[1]);
        });

        for (const [action, binding] of entries) {
            if (eventMatchesBinding(event, binding)) return action;
        }
        return null;
    }

    function isEditableTarget() {
        const el = document.activeElement;
        if (!el) return false;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
        if (el.isContentEditable) return true;
        return false;
    }

    async function handleKeyDown(event) {
        if (isEditableTarget()) return;

        const action = resolveAction(event);
        if (!action) return;

        event.preventDefault();
        event.stopPropagation();

        switch (action) {
            case 'pageNext':        await adjustPage(true);  break;
            case 'pagePrev':        await adjustPage(false); break;
            case 'historyForward':  navigateHistory(true);   break;
            case 'historyBack':     navigateHistory(false);  break;
            case 'debugInfo':       showDebugInfo();         break;
        }
    }

    // =========================================================================
    // MENU COMMANDS
    // =========================================================================

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand('Select pagination target', () => {
            const { groups } = getCandidatesAndGroups();
            if (groups.length === 0) {
                showFeedback('No pagination found', false);
                return;
            }
            const scored = groups.map(g => ({ group: g, score: scoreGroup(g) }));
            scored.sort((a, b) => b.score - a.score);

            showGroupSelector(scored.slice(0, 9), (group) => {
                if (group) {
                    saveGroupChoice(window.location.hostname, createGroupSignature(group));
                    showFeedback('Target saved', true);
                }
            });
        });

        GM_registerMenuCommand('Clear saved target', () => {
            clearGroupChoice(window.location.hostname);
        });

        GM_registerMenuCommand('Disable on this site', disableSite);
        GM_registerMenuCommand('Enable on this site', enableSite);
        GM_registerMenuCommand('Show debug info', showDebugInfo);
    }

    // =========================================================================
    // INIT
    // =========================================================================

    function init() {
        loadConfig();
        DetectionCache.url = window.location.href;
        installUrlChangeHooks();
        installMutationObserver();
        registerMenuCommands();
        debugLog('Page Hopper v9.2.0 initialized');
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();