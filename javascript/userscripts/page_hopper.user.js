// ==UserScript==
// @name         Page Hopper WIP
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      10.0.0
// @description  Keyboard-driven pagination navigation with scoped DOM detection, ancestry grouping, caching, and URL fallback. Prefers component-level pagination when present.
// @author       Unmasked213
// @match        *://*/*
// @exclude      *://chatgpt.com/*
// @exclude      *://claude.ai/*
// @exclude      *://*.nabu.casa/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    DISABLED
// @downloadURL  DISABLED
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
        GROUP_CHOICES: 'pageHopperGroupChoices',
        MEMORY: 'pageHopperMemory',
        TRANSITION: 'pageHopperTransition'
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
        taught: new Map()
    };

    // Reset whenever detection is invalidated, so text changed in place is
    // never read from a stale entry.
    let expensiveTextCache = new WeakMap();

    // Page Hopper's own interface: one host element whose shadow root holds
    // the preview marks, the chooser, the teaching prompt and the feedback
    // toast (see SHARED UI).
    const UI = {
        host: null, root: null, marks: null, toasts: null,
        toast: null, toastTimer: 0, chooser: null,
        marked: [], markBoxes: [], markFrame: 0
    };
    let mutationObserver = null;
    let mutationScheduled = false;
    let pagerObserver = null;
    // When page nodes last changed on their own (see noteChange), and
    // whether a click is awaiting evidence.
    const changeTimes = new WeakMap();
    let awaitingMove = false;

    // One pagination action at a time. Held while resolving, while the
    // chooser is open, while a click awaits evidence, and from the start of a
    // navigation until the page unloads. Presses in that window are ignored,
    // so they cannot start the same move twice; it is released as soon as an
    // action completes. `release` is the timer that frees a navigation that
    // never unloaded the page, and `pending` names the move it started.
    const Action = { busy: false, release: 0, pending: '' };

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
        showFeedback('Disabled on this site', 'success');
    }

    function enableSite() {
        saveSiteOverride(window.location.hostname, { disabled: false });
        showFeedback('Enabled on this site', 'success');
    }

    // =========================================================================
    // SITE MEMORY (CHOSEN PAGERS, TAUGHT CONTROLS AND URL RULES)
    // =========================================================================
    //
    // One pagination memory per site with two entry points that write the
    // same entries: choosing a detected pager, and pointing to a Next or
    // Previous control that detection missed. An entry records the section of
    // the site it was made in (never a URL), a reusable locator, and the
    // method seen when it was saved. Evidenced URL rules are kept per section
    // with the page-size values they hold for. Entries hold no destinations,
    // cursors, page numbers or browsing history; text that could identify
    // content (a heading beside a chosen pager) is kept only as a hash.
    //
    // pageHopperMemory = { v: 2, hosts: { [hostname]: { t, legacy, entries } } }
    //
    // Migration: v9.2.0's pageHopperGroupChoices record for a site is imported
    // on first use (and again if v9.2.0 saved a newer one after a rollback).
    // It is never rewritten, so rolling back still finds it; forgetting a site
    // removes the site from both keys.

    // Within a site, chosen and taught targets and learned rules are capped
    // separately, so a learned rule can never evict a choice I made. Across
    // sites, sites holding a choice are kept before sites holding only rules.
    const MEMORY_LIMITS = { hosts: 200, choicesPerHost: 6, rulesPerHost: 4 };

    // Session state for this document: the pager chosen or matched here, and
    // the section it was chosen in. It lasts as long as the document within
    // that section, so an address changed in place (an SPA route, pushState)
    // keeps it while the pager is still present, but a route into another
    // section does not carry it there.
    const Session = { group: null, scope: '' };

    // Parsed stored values, reused only while the stored text is unchanged,
    // so every read and every read-modify-write sees what other tabs have
    // saved meanwhile (a manager keeps each tab's copy of a value current).
    let memoryCache = { raw: null, mem: null };
    let legacyCache = { raw: null, choices: null };

    function getGroupChoices() {
        const raw = GM_getValue(STORAGE.GROUP_CHOICES) || '';
        if (legacyCache.choices && raw === legacyCache.raw) return legacyCache.choices;
        const parsed = raw ? safeJsonParse(raw, {}) : {};
        legacyCache = { raw, choices: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} };
        return legacyCache.choices;
    }

    // Stored records are rebuilt field by field: anything of the wrong type
    // is dropped, and over-long page text is not kept at all.
    const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
    const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 200) : []);
    const strMap = v => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' && x.length <= 200)) : {});
    const sketch = v => (Array.isArray(v) ? v.filter(a => a && typeof a === 'object' && typeof a.tag === 'string')
        .slice(0, 3).map(a => ({ tag: a.tag, classes: strList(a.classes) })) : []);

    function cleanAttrs(o) {
        return { tag: str(o.tag, 40), id: str(o.id), role: str(o.role, 40), ariaLabel: str(o.ariaLabel), classes: strList(o.classes), data: strMap(o.data) };
    }

    function cleanSignature(sig) {
        if (!sig || typeof sig !== 'object' || typeof sig.hasNext !== 'boolean' || typeof sig.hasPrev !== 'boolean') return null;
        const c = sig.container;
        if (c !== null && c !== undefined && (typeof c !== 'object' || Array.isArray(c))) return null;
        const out = {
            hasNext: sig.hasNext, hasPrev: sig.hasPrev, hasNumbered: !!sig.hasNumbered,
            candidateCount: Number.isInteger(sig.candidateCount) ? sig.candidateCount : 0,
            container: c ? { ...cleanAttrs(c), ancestors: sketch(c.ancestors) } : null
        };
        if (str(sig.context, 16)) out.context = sig.context;
        if (str(sig.key, 80)) out.key = sig.key;
        if (sig.lookalike === true) out.lookalike = true;
        if (Number.isInteger(sig.ordinal) && Number.isInteger(sig.peers) && sig.ordinal >= 0 && sig.ordinal < sig.peers) {
            out.ordinal = sig.ordinal;
            out.peers = sig.peers;
        }
        return out;
    }

    function cleanLocator(l) {
        if (!l || typeof l !== 'object' || !str(l.tag, 40)) return null;
        return {
            ...cleanAttrs(l),
            rel: str(l.rel, 80), title: str(l.title, 80), text: str(l.text, 40),
            pos: Array.isArray(l.pos) && l.pos.length === 2 && l.pos.every(Number.isInteger) ? l.pos : null,
            ancestors: sketch(l.ancestors),
            method: ['link', 'click', 'select'].includes(l.method) ? l.method : 'click'
        };
    }

    function cleanRule(r) {
        if (!r || typeof r !== 'object' || !str(r.key) || typeof r.prefix !== 'string' || typeof r.suffix !== 'string' ||
            r.prefix.length > 40 || r.suffix.length > 40 || !Number.isInteger(r.a) || r.a === 0 || !(r.b === null || Number.isInteger(r.b))) return null;
        return { key: r.key, prefix: r.prefix, suffix: r.suffix, a: r.a, b: r.b, zero: !!r.zero, conditions: strMap(r.conditions) };
    }

    const newId = () => Math.random().toString(36).slice(2, 8);

    function cleanEntry(e) {
        if (!e || typeof e !== 'object' || !str(e.scope, 40)) return null;
        const base = { id: str(e.id, 16) || newId(), scope: e.scope, t: Number(e.t) || 0 };
        if (e.origin === 'legacy') base.origin = 'legacy';
        if (e.kind === 'pager') {
            const pager = cleanSignature(e.pager);
            return pager && { ...base, kind: 'pager', pager, method: ['link', 'click', 'numbered'].includes(e.method) ? e.method : null };
        }
        if (e.kind === 'control') {
            const next = cleanLocator(e.next), prev = cleanLocator(e.prev);
            return (next || prev) ? { ...base, kind: 'control', next, prev } : null;
        }
        if (e.kind === 'rule') {
            const rule = cleanRule(e.rule);
            return rule && { ...base, kind: 'rule', rule };
        }
        return null;
    }

    // Malformed or unknown records are dropped rather than trusted.
    function readMemory() {
        const raw = GM_getValue(STORAGE.MEMORY) || '';
        if (memoryCache.mem && raw === memoryCache.raw) return memoryCache.mem;
        const parsed = safeJsonParse(raw, null);
        const mem = { v: 2, hosts: {} };
        const hosts = parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {};
        for (const [host, site] of Object.entries(hosts)) {
            if (!site || !Array.isArray(site.entries)) continue;
            mem.hosts[host] = { t: Number(site.t) || 0, legacy: Number(site.legacy) || 0, entries: site.entries.map(cleanEntry).filter(Boolean) };
        }
        memoryCache = { raw, mem };
        return mem;
    }

    function writeMemory(mem) {
        const keeps = site => (site.entries.some(e => e.kind !== 'rule') ? 1 : 0);
        const hosts = Object.entries(mem.hosts)
            .sort((a, b) => keeps(b[1]) - keeps(a[1]) || b[1].t - a[1].t)
            .slice(0, MEMORY_LIMITS.hosts);
        mem.hosts = {};
        for (const [host, site] of hosts) {
            const newest = (a, b) => (b.t || 0) - (a.t || 0);
            site.entries = [
                ...site.entries.filter(e => e.kind !== 'rule').sort(newest).slice(0, MEMORY_LIMITS.choicesPerHost),
                ...site.entries.filter(e => e.kind === 'rule').sort(newest).slice(0, MEMORY_LIMITS.rulesPerHost)
            ];
            mem.hosts[host] = site;
        }
        const raw = JSON.stringify(mem);
        memoryCache = { raw, mem };
        GM_setValue(STORAGE.MEMORY, raw);
        // What was taught may have changed.
        DetectionCache.taught = new Map();
    }

    // A site's entries, importing its v9.2.0 saved target when needed.
    function siteEntries(domain) {
        const mem = readMemory();
        const site = mem.hosts[domain];
        const legacy = getGroupChoices()[domain];
        const legacyAt = Number(legacy?.savedAt) || 0;
        const signature = legacy ? cleanSignature(legacy.signature) : null;
        if (signature && legacyAt > (site?.legacy || 0)) {
            const entries = (site?.entries || []).filter(e => e.origin !== 'legacy');
            entries.push({ id: newId(), kind: 'pager', scope: '*', pager: signature, origin: 'legacy', t: legacyAt });
            mem.hosts[domain] = { t: Date.now(), legacy: legacyAt, entries };
            writeMemory(mem);
            debugLog('Imported v9.2.0 saved target for', domain);
            return entries;
        }
        return site?.entries || [];
    }

    // Saves an entry. A new chosen pager or taught control replaces the
    // section's previous choice; a rule replaces the section's rule for the
    // same parameter and page size.
    function saveEntry(domain, entry) {
        const mem = readMemory();
        const site = mem.hosts[domain] || { t: 0, legacy: 0, entries: [] };
        site.entries = site.entries.filter(e => {
            if (e.scope !== entry.scope) return true;
            if (entry.kind === 'rule') return !(e.kind === 'rule' && e.rule.key === entry.rule.key && sameConditions(e.rule.conditions, entry.rule.conditions));
            return e.kind === 'rule';
        });
        site.entries.push({ id: newId(), ...entry, t: Date.now() });
        site.t = Date.now();
        mem.hosts[domain] = site;
        writeMemory(mem);
    }

    function removeEntry(domain, id) {
        const mem = readMemory();
        const site = mem.hosts[domain];
        if (!site) return;
        site.entries = site.entries.filter(e => e.id !== id);
        writeMemory(mem);
    }

    function sameConditions(a, b) {
        return JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
    }

    // Forgets this site's pagination memory (and v9.2.0's saved target) and
    // the matching in-memory state. Site enable/disable and configuration
    // are separate keys and untouched.
    function forgetSite(domain) {
        const mem = readMemory();
        delete mem.hosts[domain];
        writeMemory(mem);
        const legacy = getGroupChoices();
        if (legacy[domain]) {
            delete legacy[domain];
            GM_setValue(STORAGE.GROUP_CHOICES, JSON.stringify(legacy));
        }
        const pending = safeJsonParse(GM_getValue(STORAGE.TRANSITION) || '', null);
        if (pending?.host === domain) GM_setValue(STORAGE.TRANSITION, '');
        setSession(null);
        invalidateCache('forget');
        showFeedback('Pagination memory cleared', 'success');
    }

    // Path segments that only say which page of a section this is: p2 or
    // page3.html, or a page word followed by its number (/page/3). A bare
    // number is left alone: it is as often an item's id as a page.
    const PAGE_WORD_SEGMENT = /^(?:page|pages|p|pg|seite|pagina|strona|halaman|sayfa)$/i;

    function sectionSegments(pathname) {
        const segs = pathname.split('/').filter(Boolean);
        const out = [];
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (/^(?:p|pg|page)[-_]?\d+(?:\.html?)?$/i.test(seg)) continue;
            if (PAGE_WORD_SEGMENT.test(seg) && /^\d+$/.test(segs[i + 1] || '')) { i++; continue; }
            out.push(seg);
        }
        return out;
    }

    // The section of the site a page belongs to: its first path segment
    // (identifier-like segments count as '*') and its depth, ignoring the
    // segments that only number the page, so /forum/general/42 and
    // /forum/help/7 share a section, /blog/ and /blog/page/2/ share one, and
    // /search does not. Chosen targets and rules apply within their section.
    // The segment is stored only as a hash.
    function scopeOf(href) {
        let u;
        try { u = new URL(href); } catch { return '*'; }
        const segs = sectionSegments(u.pathname);
        const first = segs.length === 0 ? '' : (/^[a-z][a-z_-]{0,23}$/i.test(segs[0]) ? segs[0].toLowerCase() : '*');
        return `${hashText(first)}/${Math.min(segs.length, 4)}`;
    }

    // Identity evidence lets an entry apply outside the section it was made
    // in: the same container id or accessible label.
    function hasIdentityMatch(el, loc) {
        if (!el || !loc) return false;
        return (!!loc.id && el.id === loc.id) || (!!loc.ariaLabel && el.getAttribute('aria-label') === loc.ariaLabel);
    }

    // What a pager is for, as the heading or label beside it, hashed, with
    // numbers ignored (a heading such as "Comments (12)" keeps its key as the
    // count changes). Used to tell lookalike pagers apart.
    let contextCache = new WeakMap();

    function contextKey(group) {
        if (contextCache.has(group)) return contextCache.get(group);
        const text = findNearestContext(group.container || group.candidates[0]?.el?.parentElement);
        const key = text ? hashText(text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\d+/g, '#')) : null;
        contextCache.set(group, key);
        return key;
    }

    const anchorOf = group => group.container || group.candidates[0]?.el || null;

    function inDocumentOrder(a, b) {
        const x = anchorOf(a.group || a), y = anchorOf(b.group || b);
        if (!x || !y || x === y) return 0;
        return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }

    const sameGroup = (a, b) => (!!a.container && a.container === b.container) ||
        a.candidates.some(c => b.candidates.some(o => o.el === c.el));

    // Breaks an exact tie between groups matching a saved pager. Pagers that
    // navigate identically are one target. Otherwise the heading saved with
    // the choice decides, then the choice's position among the lookalikes it
    // was made from, when they are all still there.
    function resolveTie(tied, sig) {
        const distinct = distinctOptions(tied.map(t => t.group));
        if (distinct.length === 1) return { group: distinct[0].group, score: tied[0].score };
        let pool = tied;
        if (sig.context) {
            const same = tied.filter(t => contextKey(t.group) === sig.context);
            if (same.length === 1) return same[0];
            if (same.length > 1) pool = same;
        }
        if (Number.isInteger(sig.ordinal) && sig.peers === pool.length) {
            return [...pool].sort(inDocumentOrder)[sig.ordinal] || { ambiguous: true };
        }
        return { ambiguous: true };
    }

    // The remembered pager on this page: the strongest defensible match among
    // the site's saved pagers (see matchGroupToSignature and resolveTie). A
    // choice saved with a heading is looked for among the pagers under that
    // heading first. A choice made among lookalikes (pagers its signature
    // could not tell apart) is recognised only by its heading, so where that
    // heading is absent a lookalike under another heading is ambiguous, not
    // the choice (detection or the chooser decide); any other choice is
    // recognised by its signature, as headings often change from page to
    // page. A choice made in this section always comes before one made
    // elsewhere or imported from v9.2.0; one made in another section needs
    // identity evidence to apply here. A tie that cannot be broken matches
    // nothing. `identified` says the match carries id or label evidence.
    function recallPager(entries, groups) {
        const here = scopeOf(location.href);
        const hits = [];
        let ambiguous = false;
        for (const entry of entries) {
            if (entry.kind !== 'pager') continue;
            const same = entry.scope === here;
            // Only a choice that could apply here (made in this section, or
            // imported from v9.2.0) makes this page ambiguous; one from
            // another section applies only with identity evidence.
            const applies = same || entry.scope === '*';
            const context = entry.pager.context;
            const underHeading = context ? groups.filter(g => contextKey(g) === context) : [];
            const pool = underHeading.length ? underHeading : groups;
            let match = matchGroupToSignature(pool, entry.pager);
            if (match?.ambiguous) match = resolveTie(match.tied, entry.pager);
            if (!match) continue;
            if (match.ambiguous) { if (applies) ambiguous = true; continue; }
            // A choice made among lookalikes (other lists) shared any id or
            // label it had with them (a generic "Pagination", say), so that
            // is no evidence.
            const identified = !entry.pager.lookalike &&
                hasIdentityMatch(signatureNode(match.group, entry.pager), entry.pager.container);
            if (!applies && !identified) continue;
            if (entry.pager.lookalike && pool === groups && contextKey(match.group) && contextKey(match.group) !== context) {
                ambiguous = true;
                continue;
            }
            hits.push({ group: match.group, entry, same, identified, score: match.score });
        }
        hits.sort((a, b) => (b.same - a.same) || (b.score - a.score));
        const [first, second] = hits;
        if (first && (!second || second.same < first.same || second.score < first.score || second.group === first.group)) return first;
        return (first || ambiguous) ? { ambiguous: true } : null;
    }

    // A reusable description of a control someone pointed at: attributes,
    // label text, position among like siblings and a short ancestor sketch.
    // Never its destination. Ids containing digits are left out: they are
    // usually generated, or differ from page to page.
    function createControlLocator(el) {
        const parent = el.parentElement;
        const like = parent ? [...parent.children].filter(c => c.tagName === el.tagName) : [el];
        const href = getHref(el);
        const attrs = pickStableAttrs(el);
        return cleanLocator({
            ...attrs,
            id: attrs.id && !/\d/.test(attrs.id) ? attrs.id : null,
            ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 120) || null,
            rel: el.getAttribute('rel') || null,
            title: (el.getAttribute('title') || '').slice(0, 80) || null,
            // A page selector's text is its list of options, which differs
            // from page to page; it is not a label.
            text: el.tagName === 'SELECT' ? null : getTextCheap(el).replace(/\s+/g, ' ').slice(0, 40) || null,
            pos: [like.indexOf(el), like.length],
            ancestors: getAncestorSketch(el, 3),
            method: el.tagName === 'SELECT' ? 'select' : el.tagName === 'A' && isUsableHref(href) ? 'link' : 'click'
        });
    }

    // The score a perfect match would reach: the weight of every feature the
    // locator recorded.
    function maxControlScore(loc) {
        let max = 0;
        if (loc.id) max += 50;
        if (loc.ariaLabel) max += 25;
        if (loc.role) max += 8;
        if (loc.rel) max += 15;
        if (loc.title) max += 10;
        if (loc.text) max += 15;
        max += Object.keys(loc.data).length * 12;
        if (loc.classes.length) max += 20;
        for (const a of loc.ancestors) max += 2 + a.classes.length;
        if (loc.pos) max += 6;
        return max;
    }

    // Scores an element against a locator: { score, place }, where `place` is
    // the part of the score that comes from its position among like siblings.
    // `siblings` caches each parent's like-tag children and their positions,
    // so a long flat list is walked once rather than once per element.
    function scoreControl(el, loc, siblings = new Map()) {
        const g = pickStableAttrs(el);
        if (g.tag !== loc.tag) return { score: 0, place: 0 };
        let score = 0, place = 0;
        if (loc.id && g.id === loc.id) score += 50;
        if (loc.ariaLabel && el.getAttribute('aria-label') === loc.ariaLabel) score += 25;
        if (loc.role && g.role === loc.role) score += 8;
        if (loc.rel && el.getAttribute('rel') === loc.rel) score += 15;
        if (loc.title && el.getAttribute('title') === loc.title) score += 10;
        if (loc.text && sameLabel(el, loc.text)) score += 15;
        for (const [k, v] of Object.entries(loc.data)) if (g.data[k] === v) score += 12;
        if (loc.classes.length && loc.classes.every(c => g.classes.includes(c))) score += 20;
        const anc = getAncestorSketch(el, 3);
        for (let i = 0; i < Math.min(anc.length, loc.ancestors.length); i++) {
            if (anc[i].tag === loc.ancestors[i].tag) score += 2;
            score += anc[i].classes.filter(c => loc.ancestors[i].classes.includes(c)).length;
        }
        const parent = el.parentElement;
        if (loc.pos && parent) {
            let like = siblings.get(parent);
            if (!like) {
                const list = [...parent.children].filter(c => c.tagName === el.tagName);
                like = { length: list.length, index: new Map(list.map((c, i) => [c, i])) };
                siblings.set(parent, like);
            }
            const i = like.index.get(el);
            // The same place among its siblings, counted from either end
            // (a Next link is last whether or not a Previous link precedes it).
            if (i === loc.pos[0] && like.length === loc.pos[1]) place = 6;
            else if (like.length - 1 - i === loc.pos[1] - 1 - loc.pos[0] || i === loc.pos[0]) place = 4;
        }
        return { score: score + place, place };
    }

    // A rel that names a direction; other values (nofollow, noopener) are
    // shared by unrelated links.
    const DIRECTIONAL_REL = /\b(?:next|prev|previous)\b/i;

    // The unique best visible match for a taught control's locator, or null
    // when nothing matches well enough or two elements match equally. The
    // search is narrowed by the locator's most specific attribute; elements
    // are scored on attributes first and checked for visibility only when
    // they could qualify. A locator with a distinctive feature (id, label, a
    // rel naming a direction, title, or text compared with its numbers
    // aside) needs one of them to match, and
    // 20 points or 60% of its full score when that is less. One without needs
    // every attribute it recorded (classes, data, role) and its whole
    // ancestry to match, and the same place among its siblings, counted from
    // either end (the number of items before it may change), so a similar
    // control elsewhere, such as another button styled the same way, is never
    // taken for it.
    function findTaughtControl(loc) {
        if (!loc || typeof loc.tag !== 'string') return null;
        let pool = [];
        if (loc.id) {
            const el = document.getElementById(loc.id);
            if (el) pool = [el];
        }
        if (pool.length === 0) {
            const attr = (name, value) => `[${name}="${CSS.escape(value)}"]`;
            const firstData = Object.keys(loc.data)[0];
            const narrow = loc.classes[0] ? `.${CSS.escape(loc.classes[0])}`
                : loc.ariaLabel ? attr('aria-label', loc.ariaLabel)
                : loc.role ? attr('role', loc.role)
                : loc.rel ? attr('rel', loc.rel)
                : loc.title ? attr('title', loc.title)
                : firstData ? `[${firstData}]` : '';
            try { pool = document.querySelectorAll(loc.tag + narrow); } catch { pool = []; }
        }
        const distinctive = !!(loc.id || loc.ariaLabel || DIRECTIONAL_REL.test(loc.rel || '') || loc.title || loc.text);
        const max = maxControlScore(loc);
        const attributes = max - (loc.pos ? 6 : 0);
        const siblings = new Map();
        let best = null, second = 0;
        for (const el of pool) {
            if (isOwnUiNode(el)) continue;
            const { score, place } = scoreControl(el, loc, siblings);
            const enough = distinctive
                ? score >= Math.min(20, 0.6 * max) && matchesDistinctive(el, loc)
                : score - place === attributes && (!loc.pos || place > 0);
            if (!enough || !isVisible(el)) continue;
            if (!best || score > best.score) { second = best ? best.score : 0; best = { el, score }; }
            else if (score > second) second = score;
        }
        if (!best || best.score === second) return null;
        return best;
    }

    function matchesDistinctive(el, loc) {
        return (!!loc.id && el.id === loc.id) ||
            (!!loc.ariaLabel && el.getAttribute('aria-label') === loc.ariaLabel) ||
            (DIRECTIONAL_REL.test(loc.rel || '') && el.getAttribute('rel') === loc.rel) ||
            (!!loc.title && el.getAttribute('title') === loc.title) ||
            (!!loc.text && sameLabel(el, loc.text));
    }

    // Whether a control's text is the recorded label, numbers aside ("Show
    // results 21-40" on one page is "Show results 41-60" on the next). The
    // recorded label is the first 40 characters, so one of that length is
    // compared with the start of the text.
    function sameLabel(el, text) {
        const numbersAside = t => t.replace(/\d+/g, '#');
        const label = numbersAside(getTextCheap(el).replace(/\s+/g, ' ').slice(0, 200));
        const saved = numbersAside(text);
        return text.length < 40 ? label === saved : label.startsWith(saved);
    }

    // A taught control for this direction, preferring one taught in this
    // section. Controls taught elsewhere need an id or label to be looked
    // for at all, and then identity evidence. Ties between different
    // elements are ambiguous. A taught page selector serves both directions.
    // The result is kept until detection is next invalidated.
    function recallTaught(entries, increment) {
        const key = increment ? 'next' : 'prev';
        if (DetectionCache.taught.has(key)) {
            const hit = DetectionCache.taught.get(key);
            if (!hit || hit.el.isConnected) return hit;
        }
        const here = scopeOf(location.href);
        let best = null, tie = false;
        for (const entry of entries) {
            if (entry.kind !== 'control') continue;
            const loc = increment ? entry.next : (entry.prev || (entry.next?.method === 'select' ? entry.next : null));
            if (!loc) continue;
            const same = entry.scope === here;
            if (!same && !loc.id && !loc.ariaLabel) continue;
            const found = findTaughtControl(loc);
            if (!found) continue;
            if (!same && !hasIdentityMatch(found.el, loc)) continue;
            const score = found.score + (same ? 20 : 0);
            if (best && score === best.score && found.el !== best.el) tie = true;
            else if (!best || score > best.score) { best = { el: found.el, entry, loc, score }; tie = false; }
        }
        const result = best && !tie ? best : null;
        DetectionCache.taught.set(key, result);
        return result;
    }

    // How a chosen pager was operated when it was saved. Kept with the
    // choice as the brief asks; when a choice is recalled, the pager's live
    // controls decide how to move, so it is informational.
    function methodOf(group) {
        const picked = pickDirectional(group, true) || pickDirectional(group, false);
        if (!picked) return 'numbered';
        return picked.el.tagName === 'A' && isUsableHref(getHref(picked.el)) ? 'link' : 'click';
    }

    // Records a chosen pager for this section and this document. The saved
    // signature leaves out v9.2.0's sample of the pager's own controls, and
    // adds the part of the address its links change (`key`) and what tells
    // lookalike pagers apart: the hashed heading or label beside it, whether
    // a pager for another list matched the signature as well (`lookalike`;
    // an identical copy of the same pager, top and bottom, is not one), and,
    // among lookalikes sharing both signature and heading, its position.
    function rememberChoice(group) {
        setSession(group);
        const { candidateSample, ...signature } = createGroupSignature(group);
        const context = contextKey(group);
        if (context) signature.context = context;
        const key = pagedComponent(group);
        if (key) signature.key = key;
        const { groups } = getCandidatesAndGroups();
        const own = scoreSignatureMatch(group, signature);
        if (groups.some(g => !sameGroup(g, group) && scoreSignatureMatch(g, signature) >= own &&
            distinctOptions([group, g]).length > 1)) signature.lookalike = true;
        const peers = groups.filter(g => scoreSignatureMatch(g, signature) === own && contextKey(g) === context).sort(inDocumentOrder);
        const at = peers.findIndex(g => sameGroup(g, group));
        if (signature.lookalike && peers.length > 1 && at >= 0) {
            signature.ordinal = at;
            signature.peers = peers.length;
        }
        saveEntry(location.hostname, { kind: 'pager', scope: scopeOf(location.href), pager: cleanSignature(signature), method: methodOf(group) });
    }

    // The pager chosen or matched earlier in this document and section, if
    // still there.
    function sessionGroup(pool) {
        const s = Session.group;
        if (!s || Session.scope !== scopeOf(location.href)) return null;
        return pool.find(g => sameGroup(g, s)) || null;
    }

    function setSession(group) {
        Session.group = group;
        Session.scope = group ? scopeOf(location.href) : '';
    }

    // =========================================================================
    // CACHE INVALIDATION
    // =========================================================================

    function invalidateCache(reason) {
        DetectionCache.dirty = true;
        DetectionCache.candidates = null;
        DetectionCache.groups = null;
        DetectionCache.taught = new Map();
        contextCache = new WeakMap();
        expensiveTextCache = new WeakMap();
        debugLog('Cache invalidated:', reason);
    }

    // Page Hopper's own interface: its host element or anything inside the
    // host's shadow root.
    function isOwnUiNode(node) {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        if (!el) return false;
        if (UI.root && el.getRootNode() === UI.root) return true;
        return !!el.closest?.('#pagehop-ui');
    }

    function isOwnMutation(record) {
        if (isOwnUiNode(record.target)) return true;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return nodes.length > 0 && nodes.every(isOwnUiNode);
    }

    const PAGER_ATTRS = ['href', 'class', 'aria-current', 'aria-disabled', 'disabled', 'aria-label', 'aria-labelledby', 'title', 'rel', 'data-page', 'hidden'];

    // Attribute and text changes inside detected pagers (the current page
    // moved, an href or disabled state changed in place) also invalidate
    // detection. Only the pagers found by the last detection are watched,
    // and only once a detection has run.
    function observePagers(groups) {
        pagerObserver?.disconnect();
        pagerObserver = null;
        const targets = new Set();
        for (const g of groups) {
            const node = g.container || g.candidates[0]?.el?.parentElement;
            if (node && node !== document.body) targets.add(node);
            if (targets.size >= Config.detection.maxScopes) break;
        }
        if (targets.size === 0) return;
        pagerObserver = new MutationObserver(() => invalidateCache('pager-update'));
        for (const node of targets) {
            pagerObserver.observe(node, { attributes: true, attributeFilter: PAGER_ATTRS, characterData: true, subtree: true });
        }
    }

    function onUrlChanged(reason) {
        DetectionCache.url = window.location.href;
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

    // The two latest times a node changed on its own. A node that changed
    // twice within the wait allowed for a move (Config.ajax.contentLoadTimeout)
    // before a click is live content, such as a clock or a ticker: its
    // changes are no evidence that the click moved the page. While a click
    // awaits evidence only live content is noted, so what the click itself
    // changes never becomes live, and live content stays live. Entries go
    // with their nodes.
    function noteChange(node, now) {
        const times = changeTimes.get(node);
        if (!times) changeTimes.set(node, [0, now]);
        else if (times[1] !== now) { times[0] = times[1]; times[1] = now; }
    }

    function isLive(node, since) {
        const times = changeTimes.get(node);
        return !!times && times[0] >= since;
    }

    function installMutationObserver() {
        if (mutationObserver || !document.body) return;
        mutationObserver = new MutationObserver((records) => {
            const now = Date.now();
            const since = now - Config.ajax.contentLoadTimeout;
            for (const record of records) {
                if (!awaitingMove || isLive(record.target, since)) noteChange(record.target, now);
            }
            // Page Hopper's own UI never invalidates detection, and text
            // edited in place is left to the pager observer.
            if (records.every(r => r.type === 'characterData' || isOwnMutation(r))) return;
            if (mutationScheduled) return;
            mutationScheduled = true;
            setTimeout(() => {
                mutationScheduled = false;
                invalidateCache('mutation');
            }, 250);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
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

    const DISABLED_CLASS = /^(?:is-)?disabled$|[-_]disabled$/i;

    // A control marked disabled on itself or on a wrapper inside its pager
    // (e.g. <li class="disabled"><a href="#">Next</a></li>). A class name
    // alone does not disable a link that leads to another page (a class such
    // as tooltip-disabled styles something else); the disabled attribute and
    // aria-disabled always count.
    function isDisabledControl(el, container) {
        const destination = el.tagName === 'A' && isUsableHref(getHref(el)) ? resolveHref(el) : '';
        const leadsElsewhere = !!destination && destination.split('#')[0] !== location.href.split('#')[0];
        for (let node = el, depth = 0; node && node !== container && node !== document.body && depth < 3; node = node.parentElement, depth++) {
            if (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true') return true;
            if (!leadsElsewhere && typeof node.className === 'string' && node.className.split(/\s+/).some(c => DISABLED_CLASS.test(c))) return true;
        }
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

    // Where a link actually leads: its href resolved against the document base
    // (<base href>) and current URL, as the browser resolves it. Query-only,
    // path-relative and hash-only hrefs all resolve to a full URL. Returns ''
    // for no href, javascript: links and non-http(s) destinations.
    function resolveHref(el) {
        const raw = (el?.getAttribute?.('href') || '').trim();
        if (!raw || /^javascript:/i.test(raw)) return '';
        try {
            const url = new URL(raw, el.baseURI || document.baseURI);
            return /^https?:$/.test(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
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

    function classifyByTextStrict(text) {
        if (!text) return null;
        const norm = text.toLowerCase();
        for (const p of TEXT_PATTERNS.next) if (p.source.startsWith('^') && p.test(norm)) return 'next';
        for (const p of TEXT_PATTERNS.prev) if (p.source.startsWith('^') && p.test(norm)) return 'prev';
        return null;
    }

    function classifyByText(text) {
        if (!text) return null;
        const norm = text.toLowerCase();
        for (const p of TEXT_PATTERNS.next) if (p.test(norm)) return 'next';
        for (const p of TEXT_PATTERNS.prev) if (p.test(norm)) return 'prev';
        if (TEXT_PATTERNS.numbered.test(norm)) return 'numbered';
        return null;
    }

    // Next/prev role from text, aria-label or class, for elements the
    // clickable-only stages do not see (disabled or non-clickable controls).
    // `strict` takes text only when it is the whole of the control's text
    // (the anchored patterns), so a menu entry such as "Older Adults" is not
    // read as a Previous control.
    function classifyDirectional(el, strict = false) {
        const text = getTextCheap(el);
        const byText = text.length <= 50 ? (strict ? classifyByTextStrict(text) : classifyByText(text)) : null;
        if (byText === 'next' || byText === 'prev') return byText;
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (/\bnext\b/.test(label) && !/\bprev/.test(label)) return 'next';
        if (/\bprev(ious)?\b/.test(label) && !/\bnext\b/.test(label)) return 'prev';
        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if (cls.includes('next') && !cls.includes('prev')) return 'next';
        if (cls.includes('prev') && !cls.includes('next')) return 'prev';
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

        // Classifies an accessible name the way the aria-label stage does,
        // plus the text patterns (» › older, and so on).
        function addByName(el, name, confidence, source) {
            const label = (name || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!el || !label) return;
            if (/\bnext\b/.test(label) && !/\bprev/.test(label)) add(el, 'next', confidence, source);
            else if (/\bprev(ious)?\b/.test(label) && !/\bnext\b/.test(label)) add(el, 'prev', confidence, source);
            else {
                const role = classifyByText(label);
                if (role === 'next' || role === 'prev') add(el, role, confidence, source);
            }
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

        // Stage 3: other accessible names - aria-labelledby, image
        // alternatives and titles. Bounded like the text stage (pagination-
        // like scopes, or the body only when it is the sole scope, with the
        // same per-scope and overall caps), and run after it so it cannot
        // change whether that stage runs.
        let stage3Scanned = 0;
        for (const scope of scopes) {
            if (stage3Scanned >= Config.detection.maxStage2Global) break;
            if (scope === document.body && scopes.length > 1) continue;
            let perScope = 0;
            const take = () => {
                if (perScope >= Config.detection.maxStage2PerScope || stage3Scanned >= Config.detection.maxStage2Global) return false;
                perScope++;
                stage3Scanned++;
                return true;
            };
            for (const el of scope.querySelectorAll('a[aria-labelledby], button[aria-labelledby], [role="button"][aria-labelledby]')) {
                if (!take()) break;
                const name = el.getAttribute('aria-labelledby').split(/\s+/)
                    .map(id => document.getElementById(id)?.textContent || '').join(' ');
                addByName(el, name, 90, 'labelledby');
            }
            for (const img of scope.querySelectorAll('a[href] img[alt], button img[alt], [role="button"] img[alt]')) {
                if (!take()) break;
                addByName(img.closest('a[href], button, [role="button"]'), img.getAttribute('alt'), 60, 'alt');
            }
            for (const el of scope.querySelectorAll('a[title], button[title], [role="button"][title]')) {
                if (!take()) break;
                addByName(el, el.getAttribute('title'), 60, 'title');
            }
        }

        // Stage 4: boundary evidence - a Next or Previous inside a
        // pagination-like scope that is disabled or not clickable at all
        // (for example <span class="disabled">Next</span> on the last page).
        // Recorded so a confirmed first/last page is not mistaken for
        // detection failure. These are never clicked.
        for (const scope of scopes) {
            if (scope === document.body) continue;
            scope.querySelectorAll('[disabled], [aria-disabled="true"], [class*="disabled"]').forEach(marked => {
                const inner = marked.querySelectorAll('a, button, span');
                const options = [marked];
                for (let i = 0; i < inner.length && options.length < 4; i++) options.push(inner[i]);
                for (const el of options) {
                    if (seen.has(el) || !isVisible(el)) continue;
                    const role = classifyDirectional(el, true);
                    if (!role) continue;
                    seen.add(el);
                    candidates[role].push({ el, confidence: 40, source: 'disabled', disabled: true });
                    break;
                }
            });
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
            // Claim members only once they form a valid group. Claiming them
            // first dropped a leftover candidate (e.g. a Next link beside a
            // numbered nav): it was marked assigned but never grouped, so it
            // could neither join a shallower ancestor nor become a singleton.
            const memberIdx = [...anc.indices].filter(idx => !assigned.has(idx));
            if (memberIdx.length >= 2) {
                memberIdx.forEach(idx => assigned.add(idx));
                const members = memberIdx.map(idx => all[idx]);
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
    // PAGER ANALYSIS (CURRENT PAGE AND NUMBERED CONTROLS)
    // =========================================================================

    const CURRENT_CLASS = /(?:^|[-_])(?:current|active|selected|cur)(?:$|[-_])/i;

    function pageNumberOf(el) {
        const text = getTextCheap(el);
        return /^\d{1,6}$/.test(text) ? Number(text) : null;
    }

    function hasCurrentClass(el) {
        return typeof el.className === 'string' && el.className.split(/\s+/).some(c => CURRENT_CLASS.test(c));
    }

    // Reads a pager's numbered controls and its current page. Evidence for
    // the current page, strongest first: aria-current; a current, active or
    // selected class on the number or its wrapper; a number that is not
    // clickable (or is disabled) among numbers that are. The current page is
    // only reported when one number clearly holds the strongest evidence.
    // Page values come from the numbers themselves, never from DOM order.
    function analysePager(group) {
        const links = new Map();
        for (const c of group.candidates) {
            if (c.role !== 'numbered') continue;
            const n = pageNumberOf(c.el);
            if (n === null) continue;
            if (!links.has(n)) links.set(n, []);
            links.get(n).push(c);
        }

        const container = group.container || group.candidates[0]?.el?.parentElement || null;
        let current = null;
        if (container) {
            const nodes = container.querySelectorAll('*');
            const levels = new Map();
            if (nodes.length <= 400) {
                for (const el of nodes) {
                    const n = pageNumberOf(el);
                    if (n === null) continue;
                    // Judge the innermost element carrying the number.
                    if ([...el.children].some(child => getTextCheap(child) === String(n))) continue;

                    let level = 0;
                    for (let node = el, depth = 0; node && node !== container && depth < 3; node = node.parentElement, depth++) {
                        const aria = node.getAttribute('aria-current');
                        if (aria && aria !== 'false') { level = 3; break; }
                        if (hasCurrentClass(node)) level = Math.max(level, 2);
                    }
                    if (!level) {
                        const clickable = el.closest('a[href], button, [role="button"]');
                        const inside = clickable && container.contains(clickable);
                        if (!inside || clickable.matches(':disabled') || clickable.getAttribute('aria-disabled') === 'true') level = 1;
                    }
                    if (level > (levels.get(n) || 0)) levels.set(n, level);
                }
            }
            const best = Math.max(0, ...levels.values());
            const top = [...levels].filter(([, level]) => level === best).map(([n]) => n);
            // A lone plain number is only evidence beside clickable numbers.
            if (best > 0 && top.length === 1 && (best > 1 || links.size > 0)) current = top[0];
        }

        return { current, links };
    }

    // The clickable numbered control for the page adjacent to the current
    // one, or null when the current page or that neighbour is not shown.
    // A condensed pager's distant number is never taken as the neighbour.
    function adjacentNumberedCandidate(group, increment) {
        const { current, links } = analysePager(group);
        if (current === null) return null;
        const page = current + (increment ? 1 : -1);
        const items = (links.get(page) || []).filter(c => !isDisabledControl(c.el, group.container));
        if (items.length === 0) return null;
        const destination = resolveHref(items[0].el);
        if (items.some(c => resolveHref(c.el) !== destination)) return null;
        return { ...items[0], page };
    }

    // Numbered-only paging needs a container named as a pager (class, id,
    // aria-label or test hook on it or up to two ancestors), not merely a
    // <nav>, so numbered menus, steppers and calendars are never paged.
    const PAGER_TOKEN = /pagination|paginat|pager|paging|page-?nav|page-?numbers|page-?links|page-?list/i;
    const PAGER_LABEL = /\bpag(?:e|es|ination|ing)\b/i;

    function isExplicitPager(group) {
        let node = group.container || group.candidates[0]?.el?.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
            const ds = node.dataset || {};
            const tokens = [typeof node.className === 'string' ? node.className : '', node.id, ds.testid, ds.test, ds.role, ds.component].join(' ');
            if (PAGER_TOKEN.test(tokens) || PAGER_LABEL.test(node.getAttribute('aria-label') || '')) return true;
        }
        return false;
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

        const choices = distinctOptions(groups);
        if (choices.length > 1 && (choices[0].score - choices[1].score) < 15) {
            return { ambiguous: true, options: choices.slice(0, 9) };
        }

        return choices[0].group;
    }

    // Groups scored and clustered by what they navigate, one option per
    // distinct pagination, best first. Used for automatic selection and for
    // the chooser, so duplicates never appear as separate choices.
    function distinctOptions(groups) {
        // Compare navigation, not DOM position, labels or CSS classes.
        // This stays inside selection: detection, saved signatures and
        // navigation execution continue to use the original groups.
        function describeAction(candidate, group) {
            const el = candidate.el;
            let url = '';

            // Resolve real links as the browser does. Preserve query strings
            // and fragments: either can identify a different list or SPA route.
            const href = String(getHref(el)).trim();
            if (el.tagName === 'A' && href && !/^(?:#|javascript:)/i.test(href)) {
                try {
                    const target = new URL(href, el.baseURI || document.baseURI);
                    if (/^https?:$/.test(target.protocol) && (target.href !== location.href || candidate.role === 'numbered')) {
                        url = target.href;
                    }
                } catch { /* Not a usable destination. */ }
            }

            // For JavaScript buttons, an explicit aria-controls relationship
            // can identify the content being paged. Do not infer this from
            // matching button text, data-page values or shared class names.
            const boundary = group.container?.closest('nav, [role="navigation"]') || group.container;
            let owner = el;
            while (owner && owner !== document.body) {
                if (owner.hasAttribute('aria-controls')) break;
                if (owner === boundary || (!boundary && owner !== el && isPaginationLikeContainer(owner))) {
                    owner = null;
                    break;
                }
                owner = owner.parentElement;
            }

            if (owner === document.body) owner = null;
            const ids = [...new Set((owner?.getAttribute('aria-controls') || '')
                .trim().split(/\s+/).filter(Boolean))].sort();

            return {
                url,
                controls: ids.length ? JSON.stringify(ids) : '',
                controlsExist: ids.length > 0 && ids.every(id => document.getElementById(id)),
                page: el.getAttribute('data-page') || '',
                disabled: el.matches(':disabled') ||
                    !!el.closest('[aria-disabled="true"], .disabled')
            };
        }

        function describeNavigation(group) {
            const actions = new Map();
            const used = { next: pickDirectional(group, true), prev: pickDirectional(group, false) };
            for (const candidate of group.candidates) {
                let key = candidate.role;
                if (key === 'numbered') {
                    const text = getTextCheap(candidate.el);
                    if (!/^\d+$/.test(text)) continue;
                    key = `page:${Number(text)}`;
                } else if (key !== 'next' && key !== 'prev') {
                    continue;
                } else if (candidate !== used[key]) {
                    // A direction is described by the control that would
                    // actually be used. Extra controls in the same role, such
                    // as a pager's first/last links (« »), are not conflicting
                    // destinations; treating them as such made identical top
                    // and bottom pagers look different and prompted.
                    continue;
                }

                const action = describeAction(candidate, group);
                const existing = actions.get(key);

                // An internally inconsistent group is not safe to deduplicate.
                if (existing && JSON.stringify(existing) !== JSON.stringify(action)) {
                    return null;
                }
                actions.set(key, action);
            }

            // A pager without directional controls is described by the
            // numbered control it would use in each direction.
            if (!group.hasNext && !group.hasPrev) {
                for (const [role, inc] of [['next', true], ['prev', false]]) {
                    const adjacent = adjacentNumberedCandidate(group, inc);
                    if (adjacent) actions.set(role, describeAction(adjacent, group));
                }
            }
            return actions;
        }

        function sameNavigation(a, b) {
            if (!a || !b) return false;
            let matchedDirection = false;

            for (const [key, left] of a) {
                const right = b.get(key);
                if (!right) continue; // One pager may show fewer controls.

                // Any conflicting evidence keeps these groups separate.
                if (left.disabled !== right.disabled) return false;
                if (left.controls && right.controls && left.controls !== right.controls) return false;
                if (left.url && right.url && left.url !== right.url) return false;
                if (!left.url && !right.url && left.page && right.page && left.page !== right.page) return false;

                if (key !== 'next' && key !== 'prev') continue;
                if (left.disabled && !left.url && !right.url) continue;

                if (left.url && right.url) {
                    matchedDirection = true;
                } else if (!left.url && !right.url &&
                           left.controlsExist && right.controlsExist &&
                           left.controls === right.controls) {
                    matchedDirection = true;
                } else {
                    // Unknown click handlers are not evidence of equivalence.
                    return false;
                }
            }

            // Matching page numbers alone cannot establish a shared pager.
            return matchedDirection;
        }

        const scored = groups.map(group => ({ group, score: scoreGroup(group) }));
        scored.sort((a, b) => b.score - a.score);

        const distinct = [];
        for (const option of scored) {
            const navigation = describeNavigation(option.group);
            const duplicate = distinct.find(entry =>
                entry.navigations.every(other => sameNavigation(navigation, other))
            );

            if (duplicate) {
                // Check against every member, not just the representative.
                // A partial pager must not hide two conflicting full pagers.
                duplicate.navigations.push(navigation);
            } else {
                // Keep the highest-scoring ORIGINAL group. Do not merge its
                // candidates, change its score or alter its saved signature.
                distinct.push({ option, navigations: [navigation] });
            }
        }

        return distinct.map(entry => entry.option);
    }

    // =========================================================================
    // GROUP SIGNATURES (RICHER ATTR MATCHING)
    // =========================================================================

    function extractStableClasses(el) {
        // An SVG element's className is not a string; its class attribute
        // is (a taught icon may be an <svg>).
        const raw = typeof el?.className === 'string' ? el.className : el?.getAttribute?.('class');
        if (typeof raw !== 'string') return [];
        return raw.split(/\s+/)
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

    // Returns the group that matches the saved signature most strongly. The
    // first group over the threshold is not enough: lookalike pagers (same
    // classes and shape, different lists) all pass it, and the first one in
    // the document was silently used in place of the one actually chosen.
    // A tie between the best candidates is ambiguous and returns no group
    // (only the tied groups, for the caller to break the tie with other
    // evidence), so the caller recovers through that evidence, detection or
    // selection instead.
    function matchGroupToSignature(groups, sig) {
        const scored = groups
            .map(group => ({ group, score: scoreSignatureMatch(group, sig) }))
            .filter(entry => entry.score >= 35)
            .sort((a, b) => b.score - a.score);
        if (scored.length === 0) return null;
        if (scored.length > 1 && scored[0].score === scored[1].score) {
            debugLog('Saved target tied between', scored.length, 'groups');
            return { ambiguous: true, tied: scored.filter(entry => entry.score === scored[0].score) };
        }
        return scored[0];
    }

    // The element that stands for a group when it is matched to a saved
    // pager: its own container, or, for a pager showing a single control (at
    // its first or last page), that control's parent when it has the saved
    // container's tag and its id, its label or all of its classes. When some
    // of its classes differ (a layout class often changes when a control is
    // missing), it still stands for the pager if it keeps at least half of
    // them and its control is a link changing the part of the address the
    // chosen pager's links changed (`key`, the p in ?p=3). A lone control
    // elsewhere (a carousel control sharing utility classes, say) is never
    // matched on its ancestry alone.
    function signatureNode(group, sig) {
        if (group.container) return group.container;
        const saved = sig?.container;
        const parent = group.candidates.length === 1 ? group.candidates[0].el.parentElement : null;
        if (!parent || !saved) return null;
        const g = pickStableAttrs(parent);
        if (g.tag !== saved.tag) return null;
        const classes = saved.classes || [];
        const shared = classes.filter(c => g.classes.includes(c)).length;
        if ((!!saved.id && g.id === saved.id) || (!!saved.ariaLabel && g.ariaLabel === saved.ariaLabel) ||
            (classes.length > 0 && shared === classes.length)) return parent;
        return shared > 0 && shared * 2 >= classes.length && !!sig.key && pagedComponent(group) === sig.key ? parent : null;
    }

    function scoreSignatureMatch(group, sig) {
        let score = 0;

        // Shape match. A pager saved with both directions shows only one at
        // its first or last page and is still the same pager.
        const atEnd = sig.hasNext && sig.hasPrev && group.hasNext !== group.hasPrev;
        if (group.hasNext === sig.hasNext || atEnd) score += 10;
        if (group.hasPrev === sig.hasPrev || atEnd) score += 10;
        if (group.hasNumbered === sig.hasNumbered) score += 10;

        // Container match
        const node = signatureNode(group, sig);
        if (sig.container && node) {
            const g = pickStableAttrs(node);

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
            const gAnc = getAncestorSketch(node, 2);
            for (let i = 0; i < Math.min(sigAnc.length, gAnc.length, 2); i++) {
                if (sigAnc[i].tag === gAnc[i].tag) score += 2;
                const ancOverlap = (sigAnc[i].classes || []).filter(c => (gAnc[i].classes || []).includes(c));
                score += ancOverlap.length * 1;
            }
        } else if (!sig.container && !group.container) {
            score += 15;
        }

        return score;
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
        if (!DetectionCache.dirty && DetectionCache.groups) {
            // Revalidate before reuse: controls replaced since detection
            // and not reported by an observer force a fresh detection.
            const stale = DetectionCache.groups.some(g => g.candidates.some(c => !c.el.isConnected));
            if (!stale) return true;
        }

        DetectionCache.candidates = findPaginationCandidates();
        DetectionCache.groups = groupCandidates(DetectionCache.candidates);
        DetectionCache.dirty = false;
        observePagers(DetectionCache.groups);

        return true;
    }

    function getCandidatesAndGroups() {
        if (!ensureCache()) return { candidates: null, groups: [] };
        return { candidates: DetectionCache.candidates, groups: DetectionCache.groups || [] };
    }

    // =========================================================================
    // SHARED UI (HOST, STYLES AND PREVIEW MARKS)
    // =========================================================================

    // Page Hopper's own interface follows Cam's Shared UI design system
    // (www/base). It lives in one open shadow root on a single host element
    // attached to <html>, outside <body>: page styles cannot reach it, its
    // styles cannot reach the page, observers of <body> (Page Hopper's own
    // included) never see it, and observers of <html> see only the host
    // being added, never what happens inside it. Detection never queries
    // into it.
    //
    // A userscript cannot import foundation.js, so the tokens used here are
    // copied from www/base/foundation.js (modified 2026-09-20, SHA-256
    // 47c2cb02bcca42249911220a48413444aa086dfbacb8dac992bad389a0973549):
    // light values by default and dark values under prefers-color-scheme, as
    // foundation's own section 6 does for standalone use. Like the light-DOM
    // fallbacks in tooltips.js (docs/componentry/tooltips.md), they must be
    // synchronised by hand when foundation.js changes. Two adaptations: font
    // sizes are foundation's rem values resolved against its stated 16px
    // base, because every page sets its own root size; and the host sits at
    // the top of the page's stacking order, because the --ui-z-* scale
    // orders layers inside Home Assistant, not above arbitrary pages.
    // Treatments: feedback toast, and the teaching prompt as a persistent
    // toast with an action (spec 6.14); chooser dialog (6.12, with the popup's
    // standard scrim and 48px close button from 6.13, so the page stays
    // visible behind it for previewing); chooser options as menu items (6.10).
    // Preview marks use the toast's in-progress pink and the focus offset.
    const UI_CSS = `
        :host {
            /* Important throughout: page rules must not move, hide or restyle
               the host, and the reset would otherwise override what follows. */
            all: initial !important;
            display: block !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 0 !important;
            height: 0 !important;
            z-index: 2147483647 !important;
            pointer-events: none !important;

            font-family: system-ui, sans-serif !important;
            font-size: var(--ui-font-m) !important;
            line-height: 1.45 !important;
            color: var(--ui-text) !important;
            -webkit-font-smoothing: antialiased !important;
            text-rendering: optimizeLegibility !important;
            font-kerning: normal !important;

            --ui-space-1: 4px;
            --ui-space-3: 12px;
            --ui-space-4: 16px;
            --ui-space-6: 24px;
            --ui-space-10: 48px;
            --ui-radius-s: 8px;
            --ui-radius-m: 12px;
            --ui-radius-l: 18px;
            --ui-radius-xl: 32px;
            --ui-border-width-m: 2px;
            --ui-border-width-l: 3px;
            --ui-font-xs: 12px;
            --ui-font-s: 13.76px;
            --ui-font-m: 16px;
            --ui-font-l: 18.4px;
            --ui-font-weight-l: 500;
            --ui-font-line-height-m: 1.4;
            --ui-motion-fast: 120ms cubic-bezier(0.2, 0, 0.2, 1);
            --ui-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
            --ui-focus-outline-offset: 2px;
            --ui-icon-m: 20px;
            --ui-toast-radius: var(--ui-radius-m);
            --ui-toast-padding-x: var(--ui-space-4);
            --ui-toast-padding-y: var(--ui-space-3);
            --ui-toast-motion-in: 600ms var(--ui-ease-spring);
            --ui-toast-motion-out: 150ms cubic-bezier(0.5, 0, 1, 1);
            --ui-toast-max-width: 400px;
            --ui-toast-position-bottom: 100px;
            --ui-toast-position-right: 18px;
            --ui-toast-stack-gap: var(--ui-space-4);
            --ui-toast-border-width: var(--ui-border-width-l);
            --ui-modal-radius: var(--ui-radius-l);
            --ui-modal-max-width-s: 480px;
            --ui-modal-header-gap: var(--ui-space-3);
            --ui-modal-motion-in: 200ms cubic-bezier(0, 0, 0.2, 1);
            --ui-modal-motion-out: 120ms ease-in;
            --ui-modal-backdrop-in: 120ms ease-out;
            --ui-modal-backdrop-out: 120ms ease-in;
            --ui-menu-item-height: 50px;
            --ui-menu-item-radius: var(--ui-radius-xl);
            --ui-menu-item-padding-x: var(--ui-space-4);
            --ui-menu-item-font-size: var(--ui-font-m);
            --ui-pink: rgb(255, 46, 146);
            --ui-spinner-color: var(--ui-pink);

            --ui-success-rgb: 0, 162, 103;
            --ui-warning-rgb: 232, 177, 0;
            --ui-info-rgb: 0, 158, 211;
            --ui-accent: rgb(var(--ui-accent-rgb));
            --ui-success: rgb(var(--ui-success-rgb));
            --ui-warning: rgb(var(--ui-warning-rgb));
            --ui-error: rgb(var(--ui-error-rgb));
            --ui-info: rgb(var(--ui-info-rgb));
            --ui-menu-item-color: var(--ui-text);
            --ui-toast-border-color: var(--ui-spinner-color);

            --ui-text: rgb(48, 50, 60);
            --ui-text-mute: rgb(92, 94, 106);
            --ui-text-strong: rgb(28, 30, 40);
            --ui-accent-rgb: 0, 104, 128;
            --ui-error-rgb: 189, 0, 68;
            --ui-elevated-2: rgb(226, 226, 238);
            --ui-shadow-3: 0 4px 12px rgba(0, 0, 0, 0.18);
            --ui-shadow-4: 0 6px 18px rgba(0, 0, 0, 0.22);
            --ui-state-hover: rgba(48, 50, 60, 0.06);
            --ui-state-focus-ring: rgba(0, 104, 128, 0.50);
            --ui-overlay-scrim: rgba(0, 0, 0, 0.40);
            --ui-menu-item-hover-bg: rgba(48, 50, 60, 0.06);
            --ui-toast-bg: rgb(40, 43, 54);
            --ui-toast-text: rgb(245, 245, 255);
        }

        @media (prefers-color-scheme: dark) {
            :host {
                --ui-text: rgb(228, 228, 242);
                --ui-text-mute: rgb(145, 147, 159);
                --ui-text-strong: rgb(240, 240, 252);
                --ui-accent-rgb: 6, 157, 216;
                --ui-error-rgb: 255, 77, 141;
                --ui-elevated-2: rgb(40, 43, 54);
                --ui-shadow-3: 0 4px 12px rgba(0, 0, 0, 0.40);
                --ui-shadow-4: 0 6px 18px rgba(0, 0, 0, 0.50);
                --ui-state-hover: rgba(228, 228, 242, 0.08);
                --ui-state-focus-ring: rgb(80, 210, 240);
                --ui-overlay-scrim: rgba(0, 0, 0, 0.55);
                --ui-menu-item-hover-bg: rgba(228, 228, 242, 0.06);
                --ui-overlay-bg: rgb(30, 33, 42);
                --ui-toast-bg: var(--ui-overlay-bg);
                --ui-toast-text: var(--ui-text);
            }
        }

        *, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        :focus-visible { outline-offset: var(--ui-focus-outline-offset); }
        :focus:not(:focus-visible) { outline: none; }
        svg { shape-rendering: geometricPrecision; }
        [hidden] { display: none !important; }

        .ph-marks { position: fixed; inset: 0; pointer-events: none; }
        .ph-mark {
            position: fixed; top: 0; left: 0;
            border-radius: var(--ui-radius-s);
            outline: var(--ui-border-width-l) solid var(--ui-pink);
            outline-offset: var(--ui-focus-outline-offset);
        }

        .ph-scrim {
            position: fixed; inset: 0;
            background: var(--ui-overlay-scrim);
            pointer-events: auto;
            animation: ph-fade-in var(--ui-modal-backdrop-in) both;
        }
        .ph-scrim.is-exiting { pointer-events: none; animation: ph-fade-out var(--ui-modal-backdrop-out) both; }
        .ph-dialog {
            position: fixed; inset: 0; margin: auto;
            width: calc(100% - 2 * var(--ui-space-4));
            max-width: var(--ui-modal-max-width-s);
            height: fit-content;
            max-height: calc(100% - 2 * var(--ui-space-4));
            overflow-y: auto;
            display: flex; flex-direction: column;
            gap: var(--ui-modal-header-gap);
            padding: var(--ui-space-6);
            background: var(--ui-elevated-2);
            color: var(--ui-text);
            border-radius: var(--ui-modal-radius);
            box-shadow: var(--ui-shadow-4);
            pointer-events: auto;
            animation: ph-modal-in var(--ui-modal-motion-in) both;
        }
        .ph-dialog.is-exiting { pointer-events: none; animation: ph-modal-out var(--ui-modal-motion-out) both; }
        .ph-dialog:focus, .ph-dialog:focus-visible { outline: none; }
        .ph-dialog__header {
            display: flex; align-items: center; justify-content: space-between;
            gap: var(--ui-modal-header-gap);
        }
        .ph-dialog__title {
            flex: 1; margin: 0;
            font-size: var(--ui-font-l); font-weight: 600;
            line-height: var(--ui-font-line-height-m);
            color: var(--ui-text-strong);
        }
        .ph-dialog__text, .ph-dialog__hint {
            margin: 0;
            line-height: var(--ui-font-line-height-m);
            color: var(--ui-text-mute);
        }
        .ph-dialog__text { font-size: var(--ui-font-s); }
        .ph-dialog__hint { font-size: var(--ui-font-xs); padding-top: var(--ui-space-3); }
        .ph-close {
            flex: none;
            display: flex; align-items: center; justify-content: center;
            width: var(--ui-space-10); height: var(--ui-space-10);
            padding: 0; border: none; border-radius: 50%;
            background: transparent; color: var(--ui-text-mute);
            cursor: pointer;
            transition: background var(--ui-modal-backdrop-in), color var(--ui-modal-backdrop-in);
        }
        .ph-close:hover { background: var(--ui-state-hover); color: var(--ui-text); }
        .ph-close svg { width: var(--ui-icon-m); height: var(--ui-icon-m); }
        .ph-close:focus-visible, .ph-toast__action:focus-visible {
            outline: var(--ui-border-width-m) solid var(--ui-state-focus-ring);
            outline-offset: var(--ui-focus-outline-offset);
        }
        .ph-list { display: flex; flex-direction: column; gap: var(--ui-space-1); }
        .ph-option {
            position: relative;
            display: flex; align-items: center; gap: var(--ui-space-3);
            min-height: var(--ui-menu-item-height);
            padding: var(--ui-space-1) var(--ui-menu-item-padding-x);
            border-radius: var(--ui-menu-item-radius);
            color: var(--ui-menu-item-color);
            font-size: var(--ui-menu-item-font-size);
            cursor: pointer;
        }
        .ph-option::before {
            content: ""; position: absolute; inset: 0;
            border-radius: inherit;
            background: var(--ui-menu-item-hover-bg);
            opacity: 0;
            transition: opacity var(--ui-motion-fast);
            pointer-events: none;
        }
        @media (hover: hover) and (pointer: fine) {
            .ph-option:hover::before { opacity: 1; }
        }
        .ph-option[aria-selected="true"]::before { opacity: 1; }
        .ph-option:focus-visible {
            /* As .ui-menu__item:focus-visible in components.js. */
            outline: var(--ui-border-width-m) solid var(--ui-state-focus-ring);
            outline-offset: -2px;
        }
        .ph-option__key {
            flex: none; width: var(--ui-space-6);
            text-align: center;
            font-size: var(--ui-font-s); font-weight: var(--ui-font-weight-l);
            font-variant-numeric: tabular-nums;
            color: var(--ui-accent);
        }
        .ph-option__text { display: flex; flex-direction: column; min-width: 0; }
        .ph-option__title, .ph-option__detail {
            overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            line-height: var(--ui-font-line-height-m);
        }
        .ph-option__detail { font-size: var(--ui-font-s); color: var(--ui-text-mute); }

        .ph-toasts {
            position: fixed;
            left: var(--ui-toast-position-right);
            right: var(--ui-toast-position-right);
            bottom: var(--ui-toast-position-bottom);
            display: flex; flex-direction: column; align-items: flex-end;
            gap: var(--ui-toast-stack-gap);
            pointer-events: none;
        }
        .ph-toast {
            position: relative;
            max-width: var(--ui-toast-max-width);
            padding: var(--ui-toast-padding-y) var(--ui-toast-padding-x);
            background: var(--ui-toast-bg);
            color: var(--ui-toast-text);
            border: var(--ui-toast-border-width) solid var(--ui-toast-border-color);
            border-radius: var(--ui-toast-radius);
            box-shadow: var(--ui-shadow-3);
            font-size: var(--ui-font-m);
            line-height: 1.5;
            overflow-wrap: break-word;
            animation: ph-toast-in var(--ui-toast-motion-in) forwards;
        }
        .ph-toast[data-tone="success"] { border-color: var(--ui-success); }
        .ph-toast[data-tone="info"] { border-color: var(--ui-info); }
        .ph-toast[data-tone="warning"] { border-color: var(--ui-warning); }
        .ph-toast[data-tone="error"] { border-color: var(--ui-error); }
        .ph-toast.is-exiting { animation: ph-toast-out var(--ui-toast-motion-out) forwards; }
        /* The toast surface is dark in both themes (--ui-toast-bg), so its
           action takes the accent foundation defines for dark surfaces. */
        .ph-toast--teach { pointer-events: auto; --ui-accent-rgb: 6, 157, 216; --ui-accent: rgb(var(--ui-accent-rgb)); }
        .ph-toast__action {
            display: inline-block;
            margin-left: var(--ui-space-3);
            padding: 0; border: none; background: none;
            color: var(--ui-accent);
            font-family: inherit; font-size: var(--ui-font-xs); font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.05em;
            white-space: nowrap;
            cursor: pointer;
            transition: opacity var(--ui-modal-backdrop-in);
        }
        .ph-toast__action:hover { opacity: 0.8; }

        @keyframes ph-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ph-fade-out { from { opacity: 1; } to { opacity: 0; } }
        @keyframes ph-modal-in {
            from { opacity: 0; transform: scale(0.97); }
            to { opacity: 1; transform: scale(1); }
        }
        @keyframes ph-modal-out {
            from { opacity: 1; transform: none; }
            to { opacity: 0; transform: translateY(8px) scale(0.96); }
        }
        @keyframes ph-toast-in {
            0% { opacity: 0; transform: translateY(10px) scaleX(0.6); }
            100% { opacity: 1; transform: translateY(0) scaleX(1); }
        }
        @keyframes ph-toast-out {
            0% { opacity: 1; transform: translateX(0); }
            100% { opacity: 0; transform: translateX(10px); }
        }

        @media (prefers-reduced-motion: reduce) {
            .ph-scrim, .ph-scrim.is-exiting, .ph-dialog, .ph-dialog.is-exiting { animation: none; }
            .ph-scrim.is-exiting, .ph-dialog.is-exiting { visibility: hidden; }
            .ph-option::before, .ph-close, .ph-toast__action { transition: none; }
            .ph-toast { animation: ph-fade-in var(--ui-motion-fast) forwards; }
            .ph-toast.is-exiting { animation: ph-fade-out var(--ui-motion-fast) forwards; }
        }
    `;

    // Removal delays mirroring --ui-toast-motion-out and --ui-modal-motion-out,
    // as tooltips.js mirrors the tokens its script needs.
    const TOAST_EXIT_MS = 150;
    const MODAL_EXIT_MS = 120;

    function prefersReducedMotion() {
        return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    }

    function adoptUiStyles(root) {
        // A constructed stylesheet needs no <style> element in the page. The
        // <style> fallback covers engines that refuse a sheet constructed in
        // the userscript's own context, as toasts.js and modals.js fall back
        // where adopted stylesheets are unavailable.
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(UI_CSS);
            root.adoptedStyleSheets = [sheet];
        } catch {
            const style = document.createElement('style');
            style.textContent = UI_CSS;
            root.appendChild(style);
        }
    }

    // Creates the host on first use and re-attaches it if the page removed
    // it. Returns the shadow root, or null before <html> exists.
    function ensureUi() {
        if (UI.host?.isConnected) return UI.root;
        const parent = document.documentElement;
        if (!parent) return null;
        if (!UI.host) {
            const host = document.createElement('div');
            host.id = 'pagehop-ui';
            const root = host.attachShadow({ mode: 'open' });
            adoptUiStyles(root);
            const marks = uiElement('div', 'ph-marks');
            const toasts = uiElement('div', 'ph-toasts');
            toasts.setAttribute('role', 'status');
            toasts.setAttribute('aria-live', 'polite');
            root.append(marks, toasts);
            Object.assign(UI, { host, root, marks, toasts });
        }
        parent.appendChild(UI.host);
        return UI.root;
    }

    // Every label is set as text, never parsed as markup.
    function uiElement(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    // The close icon from modals.js, built without markup strings.
    function closeIcon() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
        for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
        for (const [x1, y1, x2, y2] of [[18, 6, 6, 18], [6, 6, 18, 18]]) {
            const line = document.createElementNS(ns, 'line');
            line.setAttribute('x1', x1); line.setAttribute('y1', y1);
            line.setAttribute('x2', x2); line.setAttribute('y2', y2);
            svg.appendChild(line);
        }
        return svg;
    }

    // Plays the exit motion, then removes the nodes. With reduced motion the
    // dialog is hidden at once and a toast only fades (see the stylesheet).
    function removeAfterExit(nodes, ms) {
        nodes.forEach(node => node.classList.add('is-exiting'));
        setTimeout(() => nodes.forEach(node => node.remove()), ms);
    }

    // Preview marks are outlines drawn in Page Hopper's own layer over page
    // elements, so previewing never changes the page's attributes, styles or
    // layout. They follow scrolling and resizing while shown; nothing is
    // listened to while none are shown.
    function markElements(elements) {
        clearMarks();
        if (!ensureUi()) return;
        for (const el of elements) {
            if (!el?.isConnected) continue;
            const box = uiElement('div', 'ph-mark');
            box.setAttribute('data-ph-mark', '');
            UI.marks.appendChild(box);
            UI.marked.push(el);
            UI.markBoxes.push(box);
        }
        if (UI.marked.length === 0) return;
        placeMarks();
        window.addEventListener('scroll', scheduleMarks, { capture: true, passive: true });
        window.addEventListener('resize', scheduleMarks, { passive: true });
    }

    function placeMarks() {
        UI.markFrame = 0;
        UI.marked.forEach((el, i) => {
            const box = UI.markBoxes[i];
            const rect = el.isConnected ? el.getBoundingClientRect() : null;
            if (!rect || (rect.width === 0 && rect.height === 0)) { box.hidden = true; return; }
            box.hidden = false;
            box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
            box.style.width = `${rect.width}px`;
            box.style.height = `${rect.height}px`;
        });
    }

    function scheduleMarks() {
        if (!UI.markFrame) UI.markFrame = requestAnimationFrame(placeMarks);
    }

    function clearMarks() {
        if (UI.markFrame) cancelAnimationFrame(UI.markFrame);
        UI.markFrame = 0;
        UI.markBoxes.forEach(box => box.remove());
        UI.marked = [];
        UI.markBoxes = [];
        window.removeEventListener('scroll', scheduleMarks, { capture: true });
        window.removeEventListener('resize', scheduleMarks);
    }

    // Scrolls a previewed pager into the part of the viewport the chooser
    // leaves uncovered, unless it is already fully visible there.
    function revealPreview(el, panel) {
        const r = el.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        const height = window.innerHeight;
        const inView = r.top >= 0 && r.bottom <= height;
        const uncovered = r.bottom <= p.top || r.top >= p.bottom || r.right <= p.left || r.left >= p.right;
        if (inView && uncovered) return;
        const above = p.top, below = height - p.bottom;
        const centre = above >= below ? above / 2 : p.bottom + below / 2;
        window.scrollBy({ top: r.top + r.height / 2 - centre, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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

    // The developer description used by the debug output. The chooser
    // describes options with describeOption() instead.
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

    // Where a pager sits, for pagers with no heading or label of their own.
    function pagePosition(el) {
        const rect = el?.getBoundingClientRect?.();
        const height = document.documentElement.scrollHeight;
        if (!rect || !height) return 'on this page';
        const at = (rect.top + window.scrollY) / height;
        return at < 1 / 3 ? 'near the top of the page' : at < 2 / 3 ? 'in the middle of the page' : 'near the bottom of the page';
    }

    // What pressing Next or Previous would do with this pager: the page it
    // reaches when the pager shows it, otherwise whether it opens a new page
    // or updates this one; or the boundary it is already at.
    function describeMove(group, increment) {
        const word = increment ? 'Next' : 'Previous';
        const target = extractTarget(group, increment);
        if (target.type === 'boundary') return `Already at the ${target.edge} page`;
        if (target.type === 'url-fallback') return `No ${word} control`;
        if (target.page !== undefined && target.page !== null) return `${word} goes to page ${target.page}`;
        // A link that is clicked rather than followed still leads where its
        // href does.
        const destination = target.type === 'url' ? target.value : target.type === 'click' ? resolveHref(target.value) : '';
        const opensPage = !!destination && destination.split('#')[0] !== location.href.split('#')[0];
        return opensPage ? `${word} opens a new page` : `${word} updates this page`;
    }

    // A chooser option in words: what the pager pages (its heading or label,
    // otherwise where it sits) and where choosing it leads. CSS classes are
    // never used, and page-derived text is only ever inserted as text.
    function describeOption(group, increment) {
        const context = findNearestContext(group.container || group.candidates[0]?.el?.parentElement);
        const title = context ? context.replace(/\s+/g, ' ').trim() : `Pagination ${pagePosition(anchorOf(group))}`;
        const { current } = analysePager(group);
        const parts = current !== null ? [`On page ${current}`] : [];
        parts.push(describeMove(group, increment));
        return { title, detail: parts.join(' · ') };
    }

    // The chooser: a dialog listing the distinct paginations, previewing each
    // on hover or keyboard focus. Digits choose directly; the arrow keys,
    // Home and End move through the options; Enter or Space chooses; Tab
    // stays inside the dialog; Escape, the close button or the scrim cancel.
    // While it is open no key event reaches the page's own handlers (a key's
    // browser default, such as PageDown scrolling, still happens unless the
    // chooser uses that key). On close, focus returns to where it was and
    // every mark is removed. onSelect receives the chosen group,
    // { teach: true }, or null when cancelled.
    function showGroupSelector(options, onSelect, { teach = false, increment = true } = {}) {
        // With teaching offered, the last key belongs to "point to the control".
        const list = teach ? options.slice(0, 8) : options;
        UI.chooser?.close(null);
        const root = ensureUi();
        if (!root) { onSelect(null); return; }

        const items = list.map(opt => ({ group: opt.group, ...describeOption(opt.group, increment) }));
        // Two options with the same heading are told apart by position.
        for (const item of items) {
            if (items.filter(other => other.title === item.title).length > 1) {
                item.title = `${item.title} (${pagePosition(anchorOf(item.group))})`;
            }
        }
        if (teach) items.push({ teach: true, title: 'None of these', detail: 'Point to the Next control on the page' });

        const scrim = uiElement('div', 'ph-scrim');
        const dialog = uiElement('div', 'ph-dialog');
        dialog.setAttribute('data-ph-chooser', '');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'ph-chooser-title');
        dialog.setAttribute('aria-describedby', 'ph-chooser-text');
        dialog.tabIndex = -1;

        const header = uiElement('div', 'ph-dialog__header');
        const title = uiElement('h2', 'ph-dialog__title', 'Which pagination should Page Hopper use?');
        title.id = 'ph-chooser-title';
        const closeButton = uiElement('button', 'ph-close');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', 'Cancel');
        closeButton.appendChild(closeIcon());
        header.append(title, closeButton);

        const text = uiElement('p', 'ph-dialog__text', 'Your choice is remembered for this part of the site.');
        text.id = 'ph-chooser-text';

        const listbox = uiElement('div', 'ph-list');
        listbox.setAttribute('role', 'listbox');
        listbox.setAttribute('aria-labelledby', 'ph-chooser-title');

        let active = -1;
        let closed = false;
        const previous = document.activeElement;

        const preview = (i, reveal = true) => {
            const group = items[i]?.group;
            if (!group) { clearMarks(); return; }
            const elements = group.candidates.map(c => c.el);
            markElements(elements);
            const shown = elements.find(el => el?.isConnected && el.getClientRects().length > 0);
            if (shown && reveal) revealPreview(shown, dialog);
        };

        const rows = items.map((item, i) => {
            const row = uiElement('div', 'ph-option');
            row.id = `ph-option-${i + 1}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.tabIndex = i === 0 ? 0 : -1;
            const key = uiElement('span', 'ph-option__key', i < 9 ? String(i + 1) : '');
            key.setAttribute('aria-hidden', 'true');
            if (i < 9) row.setAttribute('aria-keyshortcuts', String(i + 1));
            const words = uiElement('span', 'ph-option__text');
            words.append(uiElement('span', 'ph-option__title', item.title), uiElement('span', 'ph-option__detail', item.detail));
            row.append(key, words);
            row.addEventListener('mouseenter', () => preview(i));
            row.addEventListener('click', () => choose(i));
            listbox.appendChild(row);
            return row;
        });
        listbox.addEventListener('mouseleave', () => (active >= 0 ? preview(active, false) : clearMarks()));

        const hint = uiElement('p', 'ph-dialog__hint', 'Press a number to choose, or use the arrow keys and Enter. Esc cancels.');
        dialog.append(header, text, listbox, hint);

        const setActive = (i) => {
            active = i;
            rows.forEach((row, j) => {
                row.tabIndex = j === i ? 0 : -1;
                row.setAttribute('aria-selected', String(j === i));
            });
            rows[i].focus({ preventScroll: true });
            rows[i].scrollIntoView({ block: 'nearest' });
            preview(i);
        };

        const close = (value) => {
            if (closed) return;
            closed = true;
            window.removeEventListener('keydown', onKey, true);
            clearMarks();
            dialog.removeAttribute('data-ph-chooser');
            removeAfterExit([scrim, dialog], MODAL_EXIT_MS);
            if (UI.chooser?.close === close) UI.chooser = null;
            // Focus goes back where it was, without scrolling the page.
            if (previous && previous !== UI.host && previous.isConnected && typeof previous.focus === 'function') {
                try { previous.focus({ preventScroll: true }); } catch { /* Not focusable. */ }
            } else {
                root.activeElement?.blur();
            }
            onSelect(value);
        };
        const choose = (i) => close(items[i].teach ? { teach: true } : items[i].group);

        const onKey = (event) => {
            const key = event.key;
            const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
            const handled = () => { event.preventDefault(); event.stopPropagation(); };
            if (key === 'Escape') {
                handled(); close(null);
            } else if (plain && /^[1-9]$/.test(key) && Number(key) <= items.length) {
                handled(); choose(Number(key) - 1);
            } else if (key === 'Tab') {
                handled();
                const stops = [closeButton, rows[Math.max(active, 0)]];
                const at = stops.indexOf(root.activeElement);
                const next = at < 0 ? (event.shiftKey ? stops.length - 1 : 0)
                    : (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
                if (next === 1 && active < 0) setActive(0);
                else stops[next].focus();
            } else if (plain && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
                handled();
                const last = rows.length - 1;
                setActive(key === 'Home' ? 0 : key === 'End' ? last
                    : key === 'ArrowDown' ? (active < 0 || active === last ? 0 : active + 1)
                    : (active <= 0 ? last : active - 1));
            } else if (key === 'Enter' || key === ' ') {
                handled();
                const focused = root.activeElement;
                if (focused === closeButton) close(null);
                else if (active >= 0 && focused === rows[active]) choose(active);
            } else {
                // No other key event reaches the page's handlers while the
                // chooser is open.
                event.stopPropagation();
            }
        };

        closeButton.addEventListener('click', () => close(null));
        scrim.addEventListener('click', () => close(null));

        root.insertBefore(scrim, UI.marks);
        root.insertBefore(dialog, UI.toasts);
        UI.chooser = { close };
        window.addEventListener('keydown', onKey, true);
        // Focus moves to the dialog itself, as Shared UI modals do, so no
        // focus ring is painted until the keyboard is used.
        dialog.focus({ preventScroll: true });
    }

    // =========================================================================
    // VISUAL FEEDBACK
    // =========================================================================

    // One toast at a time, updated in place while shown. Its border carries
    // the kind of result: 'progress' (an attempt under way, the toast's own
    // pink), 'success' (confirmed), 'info', 'warning' (not confirmed or not
    // possible) or 'error' (failed). A progress message stays until its
    // outcome replaces it or the page unloads; the rest leave after the
    // configured time.
    function showFeedback(message, tone = 'success') {
        if (!Config.feedback.enabled || !ensureUi()) return;
        clearTimeout(UI.toastTimer);
        if (!UI.toast) {
            UI.toast = uiElement('div', 'ph-toast');
            UI.toast.setAttribute('data-ph-feedback', '');
            UI.toasts.appendChild(UI.toast);
        }
        UI.toast.textContent = message;
        UI.toast.dataset.tone = tone;
        if (tone !== 'progress') UI.toastTimer = setTimeout(hideFeedback, Config.feedback.timeout);
    }

    function hideFeedback(immediate = false) {
        clearTimeout(UI.toastTimer);
        const toast = UI.toast;
        if (!toast) return;
        UI.toast = null;
        toast.removeAttribute('data-ph-feedback');
        if (immediate === true) toast.remove();
        else removeAfterExit([toast], TOAST_EXIT_MS);
    }

    // How feedback names a move: its page when known, otherwise its direction.
    function moveLabel(page, increment) {
        return page !== undefined && page !== null ? `page ${page}` : `${increment ? 'next' : 'previous'} page`;
    }

    function sentenceCase(text) {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    // Starts a navigation and reports it: an attempt while a new document
    // loads (the page unloads before anything can be confirmed), a
    // confirmed move when only the fragment changed and the move completed
    // here. Returns what navigateTo() returns.
    function navigateWithFeedback(url, page, increment) {
        showFeedback(`Loading ${moveLabel(page, increment)}…`, 'progress');
        Action.pending = sentenceCase(moveLabel(page, increment));
        const loading = navigateTo(url);
        if (!loading) showFeedback(Action.pending, 'success');
        return loading;
    }

    // =========================================================================
    // AJAX CLICK HANDLING
    // =========================================================================

    function getDomMetric(scope = document.body) {
        const text = scope?.innerText?.length || 0;
        const els = scope?.querySelectorAll('*').length || 0;
        return text + els * 10;
    }

    // A compact description of a pager's visible state: its text, where its
    // controls lead, which page is marked current and which controls are
    // disabled. A change after a click is evidence the transition happened.
    function pagerState(container) {
        if (!container || !container.isConnected) return '';
        const nodes = container.querySelectorAll('a, button, [role="button"], [aria-current], li, span');
        const parts = [container.textContent.replace(/\s+/g, ' ').trim()];
        for (let i = 0; i < nodes.length && i < 300; i++) {
            const n = nodes[i];
            parts.push(`${n.getAttribute('href') || ''}|${n.getAttribute('aria-current') || ''}|${hasCurrentClass(n) ? 'c' : ''}${n.disabled || n.getAttribute('aria-disabled') === 'true' ? 'd' : ''}`);
        }
        return parts.join('\u00a7');
    }

    // The content a control pages: what it or its pager names with
    // aria-controls, otherwise the page's main content container.
    function contentRegions(el, pager) {
        for (let node = el; node && node !== document.body; node = node.parentElement) {
            if (node.hasAttribute('aria-controls')) {
                const found = node.getAttribute('aria-controls').split(/\s+/)
                    .map(id => document.getElementById(id)).filter(Boolean);
                if (found.length) return found;
            }
            if (node === pager) break;
        }
        const contentSelectors = ['main', '[role="main"]', '#content', '#main', '.content', 'article', '.results'];
        for (const sel of contentSelectors) {
            const found = document.querySelector(sel);
            if (found && isVisible(found)) return [found];
        }
        return [document.body];
    }

    const TRIVIAL_NODES = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);

    function isMeaningfulNode(node) {
        if (node.nodeType === 3) return /\S/.test(node.data);
        return node.nodeType === 1 && !TRIVIAL_NODES.has(node.tagName) && !isOwnUiNode(node);
    }

    // Clicks a control, or operates a page control through `act`, and waits
    // for evidence that the page actually moved: the document began to
    // unload, the URL changed, the pager's state changed, or the content it
    // pages was replaced. Changes to live content (see noteChange) are not
    // evidence. Returns 'navigating', 'confirmed', 'unconfirmed' or
    // 'failed'. A timeout means unconfirmed, never success, and nothing is
    // retried.
    async function clickPaginationElement(el, increment, { pager = null, act = null, page } = {}) {
        if (!el || !isVisible(el)) return 'failed';

        const regions = contentRegions(el, pager);
        const beforeMetric = getDomMetric(regions[0]);
        const beforeUrl = window.location.href;
        const beforePager = pagerState(pager);
        const since = Date.now() - Config.ajax.contentLoadTimeout;

        let unloading = false, replaced = false, grew = false, liveChanged = false, lastChange = 0;
        const onUnload = () => { unloading = true; };
        window.addEventListener('beforeunload', onUnload);
        window.addEventListener('pagehide', onUnload);
        const observer = new MutationObserver(records => {
            for (const r of records) {
                if (isLive(r.target, since)) { liveChanged = true; continue; }
                if (r.type === 'characterData') {
                    if (!isOwnUiNode(r.target) && /\S/.test(r.target.data || '')) { replaced = true; lastChange = Date.now(); }
                    continue;
                }
                if ([...r.removedNodes].some(isMeaningfulNode)) { replaced = true; lastChange = Date.now(); }
                if ([...r.addedNodes].some(isMeaningfulNode)) { grew = true; lastChange = Date.now(); }
            }
        });
        regions.forEach(region => observer.observe(region, { childList: true, subtree: true, characterData: true }));

        if (Config.ajax.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 250));
        }

        showFeedback(`Loading ${moveLabel(page, increment)}…`, 'progress');
        Action.pending = sentenceCase(moveLabel(page, increment));

        let result;
        try {
            awaitingMove = true;
            if (act) act();
            else if (typeof el.click === 'function') el.click();
            else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            result = await new Promise(resolve => {
                const start = Date.now();
                const check = () => {
                    const now = Date.now();
                    if (unloading) return resolve('navigating');
                    if (window.location.href !== beforeUrl) return resolve('confirmed');
                    if (pager && pagerState(pager) !== beforePager) return resolve('confirmed');
                    // Replaced or edited content counts once it settles.
                    // Content that only grew needs a longer quiet spell, so
                    // a loading indicator on its own is less likely to pass.
                    if (replaced && now - lastChange >= 120) return resolve('confirmed');
                    if (grew && now - lastChange >= 400) return resolve('confirmed');
                    if (now - start >= Config.ajax.contentLoadTimeout) return resolve('unconfirmed');
                    setTimeout(check, 50);
                };
                setTimeout(check, 50);
            });
            // v9.2.0's size measure is kept as a last check: content shown
            // or hidden by a class change alters the rendered text without
            // any node being added or removed. Live content that changed
            // meanwhile would distort it, so it is not used then: an
            // unconfirmed move is reported rather than a false success.
            if (result === 'unconfirmed' && !liveChanged && Math.abs(getDomMetric(regions[0]) - beforeMetric) >= Config.ajax.minDomChange) {
                result = 'confirmed';
            }
        } catch {
            result = 'failed';
        } finally {
            awaitingMove = false;
            observer.disconnect();
            window.removeEventListener('beforeunload', onUnload);
            window.removeEventListener('pagehide', onUnload);
        }

        if (result !== 'navigating') invalidateCache('after-click');
        return result;
    }

    // =========================================================================
    // URL-BASED PAGINATION (FALLBACK)
    // =========================================================================

    function safeDecode(text) {
        try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; }
    }

    // The query string and any key=value fragment (#page=2, #!page=2,
    // #/list?page=2) of a URL, with their offsets in the URL text, so
    // parameters can be read and replaced in place rather than re-serialised.
    function paramAreas(u) {
        const text = u.href;
        const hashStart = text.length - u.hash.length;
        const areas = [];
        if (u.search.length > 1) areas.push({ type: 'query', text: u.search.slice(1), offset: hashStart - u.search.length + 1 });
        if (u.hash.length > 1) {
            const q = u.hash.indexOf('?');
            if (q >= 0) {
                areas.push({ type: 'hash', text: u.hash.slice(q + 1), offset: hashStart + q + 1 });
            } else if (/^#!?[^/?#]*=/.test(u.hash)) {
                const skip = u.hash.startsWith('#!') ? 2 : 1;
                areas.push({ type: 'hash', text: u.hash.slice(skip), offset: hashStart + skip });
            }
        }
        return areas;
    }

    // key=value pairs of one area with absolute offsets in the URL text.
    // Pairs without '=' are skipped but counted, so offsets stay exact.
    function readParams(area) {
        const params = [];
        let pos = 0;
        for (const part of area.text.split('&')) {
            const eq = part.indexOf('=');
            if (eq > 0) {
                params.push({
                    key: safeDecode(part.slice(0, eq)),
                    raw: part,
                    value: part.slice(eq + 1),
                    start: area.offset + pos,
                    valueStart: area.offset + pos + eq + 1
                });
            }
            pos += part.length + 1;
        }
        return params;
    }

    function identifyPageNumber(url) {
        let urlObj;
        try { urlObj = new URL(url); } catch { return null; }

        const candidates = [];

        // Query and fragment parameters are located in the URL text itself so
        // the page value can be replaced in place, leaving every other
        // parameter, its encoding and the fragment exactly as they were.
        for (const area of paramAreas(urlObj)) {
            for (const param of readParams(area)) {
                const k = param.key.toLowerCase();
                if (Config.pagination.keywords.includes(k) || k.includes('page') || ['offset', 'start', 'p'].includes(k)) {
                    const digits = /^\d+/.exec(param.value)?.[0] || '';
                    const num = digits ? parseInt(digits, 10) : NaN;
                    if (!isNaN(num) && num >= Config.pagination.minPageNumber && num <= Config.pagination.maxPageNumber) {
                        candidates.push({
                            type: area.type,
                            value: num,
                            paramName: param.key,
                            leadingZeros: digits.length - num.toString().length,
                            score: area.type === 'query' ? 200 : 190,
                            matchedString: param.raw,
                            matchPosition: param.start,
                            digitPosition: param.valueStart - param.start,
                            digitStr: digits
                        });
                    }
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

    // Sets a parameter in the raw query text: the first existing value is
    // replaced where it stands, otherwise the pair is appended. Every other
    // parameter keeps its exact text.
    function setQueryParam(url, key, value) {
        const beforeHash = url.href.slice(0, url.href.length - url.hash.length);
        const q = beforeHash.indexOf('?');
        if (q >= 0) {
            const parts = beforeHash.slice(q + 1).split('&');
            const i = parts.findIndex(part => part.split('=')[0] === key);
            if (i >= 0) {
                parts[i] = `${key}=${value}`;
                return beforeHash.slice(0, q + 1) + parts.join('&') + url.hash;
            }
        }
        return appendQueryParam(url, `${key}=${value}`);
    }

    function appendQueryParam(url, pair) {
        const beforeHash = url.href.slice(0, url.href.length - url.hash.length);
        const joiner = url.search ? '&' : (beforeHash.endsWith('?') ? '' : '?');
        return beforeHash + joiner + pair + url.hash;
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
        const route = urlFallback(increment);
        if (route.message) {
            showFeedback(route.message, route.tone);
            return false;
        }
        return route.url ? navigateWithFeedback(route.url, route.page, increment) : false;
    }

    // Where the URL fallback goes from this address: { url, page }, a
    // { message, tone } when it cannot move, or {} when the address would
    // not change. Computed without navigating, so boundary evidence can
    // check whether the page itself links there (see pagesThisUrl).
    function urlFallback(increment) {
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
                }
                // The query style sets page=2 in the existing query text
                // (replacing an unusable value such as page=0 where it stands)
                // instead of re-serialising every other parameter.
                let newUrl = style === 'query' ? setQueryParam(url, 'page', '2') : url.toString();
                if (fragment && !newUrl.includes('#')) newUrl += fragment;
                return { url: newUrl, page: 2 };
            }
            return { message: 'No pagination detected', tone: 'warning' };
        }

        const newPage = pageInfo.value + (increment ? stepSize : -stepSize);
        if (newPage < minPageNumber) return { message: 'Already at first page', tone: 'info' };
        if (newPage > maxPageNumber) return { message: 'Page limit reached', tone: 'info' };

        const pad = pageInfo.leadingZeros > 0 ? pageInfo.value.toString().length + pageInfo.leadingZeros : 0;
        const newPageStr = pad > 0 ? newPage.toString().padStart(pad, '0') : newPage.toString();

        // Every candidate type (query, fragment, path) records where its
        // digits sit in the URL text, so only those digits are replaced.
        const before = pageInfo.matchedString.slice(0, pageInfo.digitPosition);
        const after = pageInfo.matchedString.slice(pageInfo.digitPosition + pageInfo.digitStr.length);
        let newUrl = url.href.slice(0, pageInfo.matchPosition) + before + newPageStr + after +
                     url.href.slice(pageInfo.matchPosition + pageInfo.matchedString.length);

        if (fragment && !newUrl.includes('#')) newUrl += fragment;

        // The feedback names the page only when the number is one (see
        // isNamedPage); v9.2.0 also called an offset or an id a page.
        return newUrl !== window.location.href ? { url: newUrl, page: isNamedPage(pageInfo) ? newPage : null } : {};
    }

    // =========================================================================
    // PAGE SELECTORS AND PAGE-NUMBER FORMS
    // =========================================================================

    // Named as a page control, and not as a page-size or sort control.
    const PAGE_WORD = /(?:^|[^a-z])(?:page|pg|pagenum|pagenumber|pageno|seite|pagina|página|strona|halaman|sayfa)(?:[^a-z]|$)/i;
    const NOT_PAGE_WORD = /per[\s_-]?page|page[\s_-]?size|pagesize|items|rows|results|show|limit|sort|order/i;

    function controlName(el) {
        const parts = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder')];
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) for (const id of labelledBy.split(/\s+/)) parts.push(document.getElementById(id)?.textContent);
        if (el.labels) for (const label of el.labels) parts.push(label.textContent);
        return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    function isPageControl(el) {
        const name = controlName(el);
        return PAGE_WORD.test(name) && !NOT_PAGE_WORD.test(name);
    }

    // A form whose only user-editable field is the page control, so
    // submitting it cannot send anything else the user typed or chose.
    function isPageForm(form, control) {
        if (!form) return false;
        for (const field of form.elements) {
            if (field === control || field.disabled) continue;
            if (['BUTTON', 'FIELDSET', 'OUTPUT', 'OBJECT'].includes(field.tagName)) continue;
            if (['hidden', 'submit', 'button', 'reset', 'image'].includes((field.type || '').toLowerCase())) continue;
            if (!isVisible(field)) continue;
            return false;
        }
        return true;
    }

    function optionPage(option) {
        const m = /^\s*(?:page\s*)?(\d{1,6})(?:\s*(?:of|\/)\s*\d+)?\s*$/i.exec(option.textContent || '');
        if (m) return Number(m[1]);
        return /^\d{1,6}$/.test(option.value) ? Number(option.value) : null;
    }

    // A clearly identified page selector or page-number form, used only when
    // no pager control exists. Duplicates (top and bottom selectors) must
    // agree. A selector already on its last or first page, or an input at
    // its min or max, is a confirmed boundary.
    function findPageControl(increment) {
        const found = [];
        const edge = increment ? 'last' : 'first';
        const selects = document.querySelectorAll('select');
        for (let i = 0; i < selects.length && i < 30; i++) {
            const select = selects[i];
            if (select.multiple || select.disabled || !isVisible(select) || !isPageControl(select)) continue;
            // Only a select whose change is applied by its own handler, by
            // script outside any form, or by submitting a form that holds
            // nothing but the page control. Never change a select inside
            // another form with nothing to apply it.
            if (!select.hasAttribute('onchange') && select.form && !isPageForm(select.form, select)) continue;
            const numbered = [...select.options].map(o => ({ o, n: optionPage(o) })).filter(x => x.n !== null);
            const current = numbered.find(x => x.o.selected);
            if (numbered.length < 2 || !current) continue;
            const target = numbered.find(x => x.n === current.n + (increment ? 1 : -1));
            if (target) {
                found.push({ type: 'select', el: select, option: target.o, page: target.n });
            } else {
                // Only a selector that lists every page from the first
                // confirms a boundary; one that lists nearby pages does not.
                const values = [...new Set(numbered.map(x => x.n))].sort((x, y) => x - y);
                if (values[0] <= 1 && values.every((v, i) => i === 0 || v === values[i - 1] + 1)) found.push({ type: 'boundary', edge });
            }
        }
        const inputs = document.querySelectorAll('input[type="number"], input[type="text"], input:not([type])');
        for (let i = 0; i < inputs.length && i < 60; i++) {
            const input = inputs[i];
            if (input.disabled || input.readOnly || !isVisible(input) || !isPageControl(input) || !isPageForm(input.form, input)) continue;
            const value = input.value.trim();
            if (!/^\d{1,6}$/.test(value)) continue;
            const page = Number(value) + (increment ? 1 : -1);
            const min = input.min !== '' ? Number(input.min) : 1;
            const max = input.max !== '' ? Number(input.max) : Infinity;
            found.push(page < min || page > max ? { type: 'boundary', edge } : { type: 'form', el: input, page });
        }
        if (found.length === 0) return null;
        const key = t => t.type === 'boundary' ? 'boundary' : `page:${t.page}`;
        return found.every(t => key(t) === key(found[0])) ? found[0] : null;
    }

    // Operates a page control as a person would: set the value, fire input
    // and change, and submit only a form whose only user field is the page
    // control. A select with its own change handler, or outside any form,
    // is left to that handler. No site-specific events are invented.
    function operatePageControl(target) {
        const el = target.el;
        // Through the element's own value setter, which frameworks that track
        // input values (React, for one) also observe.
        const value = target.type === 'select' ? target.option.value : String(target.page);
        const setter = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const form = el.form;
        const selfSubmitting = target.type === 'select' && (el.hasAttribute('onchange') || !form);
        if (selfSubmitting || !isPageForm(form, el)) return;
        const submitter = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
        try { form.requestSubmit(submitter || undefined); } catch { form.requestSubmit(); }
    }

    // =========================================================================
    // URL RULES FROM NEIGHBOURING LINKS
    // =========================================================================

    // Page-size parameters. A step learned while one page size is shown only
    // holds while the same page size is shown.
    const PAGE_SIZE_KEY = /^(?:limit|per_?page|page_?size|pagesize|size|num|count|rows|show|items|results|n|ps|pp)$/i;

    // Parameters that name a position in a list: a page (page, p, pg,
    // pageNum, currentPage, _pgn, and the translated names in
    // Config.pagination.keywords) or an offset (start, offset, from, skip).
    const POSITION_KEY = /^(?:_?(?:current_?)?(?:page|pag|pg|pgn|pn)(?:_?(?:num|number|no|index|idx))?|p|start|start_?index|offset|from|skip|first|begin|o|s)$/i;

    // Parameters that identify content or carry session state (post_id,
    // postId, sid, token) rather than a position.
    const IDENTITY_KEY = /(?:^|[-_.])(?:id|ids|uid|uuid|guid|sid|session|sessionid|token|auth|key|sig|signature|hash|nonce)$/i;
    const CAMEL_ID = /[a-z]Id$/;

    const paramName = key => key.replace(/^(?:query|hash):/, '').replace(/#\d+$/, '');

    // Cursors and identifiers are never learned, predicted or saved as steps.
    function isCursorKey(key) {
        if (key.startsWith('path:')) return false;
        const name = paramName(key);
        return CURSOR_KEY.test(name) || IDENTITY_KEY.test(name) || CAMEL_ID.test(name);
    }

    // Whether a component of `url` can carry a list position: a parameter
    // named as a page or offset, or a path segment that numbers the page
    // (p2, page3.html, or a number after a page word as in /page/3).
    function isPositionKey(key, url) {
        if (key.startsWith('path:')) {
            const c = url.comps.get(key);
            if (!c || c.digits === undefined) return false;
            if (/^(?:p|pg|page)[-_]?$/i.test(c.prefix)) return true;
            return c.prefix === '' && PAGE_WORD_SEGMENT.test(url.comps.get(`path:${Number(key.slice(5)) - 1}`)?.raw || '');
        }
        const name = paramName(key);
        return !isCursorKey(key) && (POSITION_KEY.test(name) || Config.pagination.keywords.includes(name.toLowerCase()));
    }

    // A URL split into the components that can carry a page position: query
    // and fragment parameters by name, path segments by position. Numeric
    // components record where their digits sit so they can be replaced.
    function urlComponents(href) {
        if (!href) return null;
        let u;
        try { u = new URL(href, document.baseURI); } catch { return null; }
        if (!/^https?:$/.test(u.protocol)) return null;
        const text = u.href;
        const comps = new Map();
        const component = (raw, start) => {
            const m = /^(\D*)(\d{1,9})(\D*)$/.exec(raw);
            return m ? { raw, prefix: m[1], digits: m[2], suffix: m[3], value: Number(m[2]), start: start + m[1].length } : { raw };
        };
        for (const area of paramAreas(u)) {
            const seen = new Map();
            for (const p of readParams(area)) {
                const n = seen.get(p.key) || 0;
                seen.set(p.key, n + 1);
                comps.set(`${area.type}:${p.key}${n ? '#' + n : ''}`, component(p.value, p.valueStart));
            }
        }
        const segments = u.pathname.split('/');
        let offset = text.length - u.hash.length - u.search.length - u.pathname.length;
        segments.forEach((seg, i) => {
            if (i > 0) comps.set(`path:${i}`, component(seg, offset));
            offset += seg.length + 1;
        });
        return { text, origin: u.origin, depth: segments.length, comps };
    }

    // Fits value = a * page + b for exactly one component across numbered
    // links that show their page numbers. Every other component must be
    // identical across those links, so a second varying component, or a
    // varying non-numeric value such as a cursor, gives no rule. A step is
    // never assumed from a parameter's name.
    function fitRule(points) {
        const depths = points.map(p => p.url.depth);
        const depth = depths.sort((x, y) => depths.filter(d => d === y).length - depths.filter(d => d === x).length)[0];
        const pts = points.filter(p => p.url.depth === depth && p.url.origin === points[0].url.origin);
        const keys = new Set(pts.flatMap(p => [...p.url.comps.keys()]));
        const varying = [...keys].filter(k => new Set(pts.map(p => p.url.comps.get(k)?.raw ?? '\u0000')).size > 1);
        if (varying.length !== 1) return null;

        const key = varying[0];
        if (isPageSizeKey(key) || isCursorKey(key)) return null;
        const known = pts.filter(p => p.url.comps.get(key)?.digits !== undefined);
        const byPage = [...new Map(known.map(p => [p.page, p])).values()];
        if (byPage.length < 2) return null;
        const { prefix, suffix } = byPage[0].url.comps.get(key);
        if (known.some(p => p.url.comps.get(key).prefix !== prefix || p.url.comps.get(key).suffix !== suffix)) return null;

        const [p1, p2] = byPage;
        const v1 = p1.url.comps.get(key).value, v2 = p2.url.comps.get(key).value;
        const a = (v2 - v1) / (p2.page - p1.page);
        const b = v1 - a * p1.page;
        if (!Number.isInteger(a) || a === 0 || !Number.isInteger(b)) return null;
        if (known.some(p => p.url.comps.get(key).value !== a * p.page + b)) return null;
        return { key, prefix, suffix, a, b, zero: known.some(p => p.url.comps.get(key).value === 0) };
    }

    // The step between this URL and a live next/prev link: exactly one
    // component of the link may differ from this URL, numerically, and it
    // must be a position (a single link is not enough to take an id or a
    // cursor for a page step). Parameters only this URL carries (tracking
    // and the like) are ignored.
    function relativeStep(here, link, increment) {
        if (!link || link.origin !== here.origin || link.depth !== here.depth) return null;
        let found = null;
        for (const [key, c] of link.comps) {
            const h = here.comps.get(key);
            if (h && h.raw === c.raw) continue;
            if (found || !h || c.digits === undefined || h.digits === undefined || c.prefix !== h.prefix || c.suffix !== h.suffix ||
                isPageSizeKey(key) || !isPositionKey(key, link)) return null;
            found = { key, prefix: c.prefix, suffix: c.suffix, a: (c.value - h.value) * (increment ? 1 : -1), b: null, zero: c.value === 0 || h.value === 0 };
        }
        return found && found.a !== 0 ? found : null;
    }

    function isPageSizeKey(key) {
        return !key.startsWith('path:') && PAGE_SIZE_KEY.test(paramName(key));
    }

    function pageSizeConditions(here, ruleKey) {
        const conditions = {};
        for (const [key, c] of here.comps) {
            if (key !== ruleKey && isPageSizeKey(key)) conditions[key] = c.raw;
        }
        return conditions;
    }

    function sameRule(x, y) {
        return x.key === y.key && x.prefix === y.prefix && x.suffix === y.suffix && x.a === y.a &&
            (x.b === null || y.b === null || x.b === y.b);
    }

    // Learns the rule for this page from each pager's numbered links, or
    // failing that from its live next/prev links against this URL. Pagers
    // that disagree give no rule. A rule from numbered links (b known) is
    // evidence enough to remember; a step read from a single link is only
    // used on this page.
    function learnRule(groups) {
        const here = urlComponents(location.href);
        if (!here) return null;
        let found = null;
        for (const group of groups) {
            const { current, links } = analysePager(group);
            const points = [];
            for (const [page, items] of links) {
                const url = urlComponents(resolveHref(items[0].el));
                if (url) points.push({ page, url });
            }
            // Numbers alone are weak evidence: only a clearly identified pager
            // teaches a rule from its numbered links. Its next/prev links
            // (already classified as directional) can teach a step anywhere.
            let rule = points.length >= 2 && isExplicitPager(group) ? fitRule(points) : null;
            if (rule && current !== null) {
                const c = here.comps.get(rule.key);
                if (c?.digits !== undefined && c.value !== rule.a * current + rule.b) rule = null;
            }
            if (!rule) {
                for (const inc of [true, false]) {
                    const picked = pickDirectional(group, inc);
                    const step = picked && relativeStep(here, urlComponents(resolveHref(picked.el)), inc);
                    if (!step) continue;
                    if (rule && !sameRule(rule, step)) { rule = null; break; }
                    rule = rule || step;
                }
            }
            if (!rule) continue;
            if (found && !sameRule(found, rule)) return null;
            if (!found || (found.b === null && rule.b !== null)) found = rule;
        }
        if (found) found.conditions = pageSizeConditions(here, found.key);
        return found;
    }

    // Applies a rule to this URL. Only the rule's digits change; every other
    // part of the URL is kept exactly. Returns a boundary when the step would
    // go below the first page.
    function applyRule(rule, increment) {
        const here = urlComponents(location.href);
        const c = here?.comps.get(rule.key);
        if (!c || c.digits === undefined || c.prefix !== rule.prefix || c.suffix !== rule.suffix) return null;
        for (const [key, raw] of Object.entries(rule.conditions || {})) {
            if ((here.comps.get(key)?.raw ?? null) !== raw) return null;
        }
        const value = c.value + (increment ? rule.a : -rule.a);
        let page = null;
        if (rule.b !== null) {
            page = (value - rule.b) / rule.a;
            if (!Number.isInteger(page)) return null;
            if (page < 1) return { boundary: increment ? 'last' : 'first' };
        } else {
            const floor = Math.abs(rule.a) === 1 && !rule.zero ? Config.pagination.minPageNumber : 0;
            if (value < floor) return { boundary: increment ? 'last' : 'first' };
        }
        const width = c.digits.length > 1 && c.digits.startsWith('0') ? c.digits.length : 0;
        const digits = width ? String(value).padStart(width, '0') : String(value);
        return { href: here.text.slice(0, c.start) + digits + here.text.slice(c.start + c.digits.length), page };
    }

    // =========================================================================
    // RESOLUTION FLOW
    // =========================================================================

    async function resolvePaginationTarget(increment, allowPrompt) {
        const override = getSiteOverride();
        if (override?.disabled) {
            showFeedback('Disabled on this site', 'info');
            return { type: 'disabled' };
        }

        const edge = increment ? 'last' : 'first';
        const domain = window.location.hostname;
        const entries = siteEntries(domain);
        const { candidates, groups } = getCandidatesAndGroups();

        // A control taught for this direction is the site's explicit
        // preference. A taught JavaScript control keeps its click behaviour,
        // a taught link is followed to wherever it currently leads, and a
        // taught page selector is set to its neighbouring option.
        const taught = recallTaught(entries, increment);
        if (taught) {
            const el = taught.el;
            if (taught.loc.method === 'select' && el.tagName === 'SELECT') {
                const option = el.options[el.selectedIndex + (increment ? 1 : -1)];
                if (el.disabled || !option || option.disabled) return { type: 'boundary', edge };
                return { type: 'select', el, option, via: 'taught' };
            }
            if (isDisabledControl(el, null)) return { type: 'boundary', edge };
            if (taught.loc.method === 'click') return { type: 'click', value: el, via: 'taught' };
            return { ...targetForControl(el), via: 'taught' };
        }

        // The pager chosen or matched earlier in this document and section,
        // then the remembered pager: one saved for this section, or one saved
        // elsewhere (or by v9.2.0) that this page's pager matches by id or
        // label. It is the one used in both directions, and another list is
        // never paged in its place. When it has no control for this
        // direction, that is its boundary if its numbers show it; if another
        // pager could move this way, nothing moves; otherwise the page-level
        // routes below apply when it is the page's only pager, or when they
        // change the part of the address its own links change (see
        // pageRouteFits).
        const canMove = g => (increment ? g.hasNext : g.hasPrev) ||
            (g.hasNumbered && isExplicitPager(g) && !!adjacentNumberedCandidate(g, increment));
        let chosenGroup = sessionGroup(groups);
        if (!chosenGroup) {
            const match = recallPager(entries, groups);
            if (match && !match.ambiguous && (match.same || match.identified)) {
                chosenGroup = match.group;
                setSession(chosenGroup);
            }
        }
        if (chosenGroup) {
            const target = extractTarget(chosenGroup, increment);
            if (target.type !== 'url-fallback') return target;
            if (atEdge(chosenGroup, increment)) return { type: 'boundary', edge };
            const others = groups.filter(g => !sameGroup(g, chosenGroup));
            if (others.some(canMove)) return { type: 'no-control' };
            if (others.length && !pageRouteFits(chosenGroup, candidates, increment)) return { type: 'no-control' };
        }

        let usable = groups.filter(g => increment ? g.hasNext : g.hasPrev);

        // No directional control anywhere: clearly identified pagers whose
        // current page is marked and whose adjacent number is shown, chosen
        // exactly as directional pagers are (equivalence, memory, prompt).
        if (usable.length === 0) {
            usable = groups.filter(g => g.hasNumbered && isExplicitPager(g) && adjacentNumberedCandidate(g, increment));
        }

        // If DOM groups fail, use SEO rel=next/prev href as a clean URL jump, else URL fallback.
        if (usable.length === 0) {
            const seo = seoTarget(candidates, increment);
            if (seo) return seo;

            // A clearly identified page selector or page-number form.
            const control = findPageControl(increment);
            if (control) return control;

            // A pager that marks its current page and shows nothing beyond
            // it in this direction is at its first or last page.
            const boundary = numberedBoundary(groups, increment);
            if (boundary) return boundary;

            // A step learned from the page's own links beats blind arithmetic
            // (offsets of 10 or 80, zero-based pages). One fitted to a
            // pager's numbered links is remembered for this section; a step
            // read from a single link is used here only. A remembered step is
            // used when the page shows no evidence of its own. Cursors and
            // identifiers never qualify (see isCursorKey and isPositionKey).
            const live = learnRule(groups);
            if (live && live.b !== null) rememberRule(domain, live);
            const scope = scopeOf(location.href);
            const remembered = siteEntries(domain).filter(e => e.kind === 'rule' && e.scope === scope).map(e => e.rule)
                .filter(rule => applyRule(rule, increment));
            // Remembered steps for two different parameters that both apply
            // here (two lists on one page) are ambiguous: use neither.
            const keys = new Set(remembered.map(rule => rule.key));
            const rule = live || (keys.size === 1 ? remembered[0] : null);
            const ruled = rule && applyRule(rule, increment);
            if (ruled?.boundary) return { type: 'boundary', edge: ruled.boundary };
            if (ruled) return { type: 'url', value: ruled.href, page: ruled.page, via: 'rule' };

            return { type: 'url-fallback' };
        }

        // A pager remembered elsewhere on the site without id or label
        // evidence (v9.2.0's site-wide choice, say), among the pagers that can
        // move this way.
        const match = recallPager(entries, usable);
        if (match && !match.ambiguous) return extractTarget(match.group, increment);
        if (!match && entries.some(e => e.kind === 'pager')) debugLog('Saved target not found on this page');

        // A remembered choice that fits more than one pager here asks again,
        // rather than letting detection page one of them silently.
        let selection = selectBestGroup(usable);
        if (match?.ambiguous && selection && !selection.ambiguous) {
            const options = distinctOptions(usable);
            if (options.length > 1) selection = { ambiguous: true, options: options.slice(0, 9) };
        }

        // Ambiguity always asks. v9.2.0 asked once per URL and then
        // silently used the first option, which could page an unrelated
        // list. A choice is remembered, so asking again only happens when
        // it cannot be recognised.
        if (selection && selection.ambiguous && allowPrompt) {
            return new Promise(resolve => {
                showGroupSelector(selection.options, (choice) => {
                    if (choice?.teach) {
                        resolve({ type: 'teach' });
                    } else if (choice) {
                        rememberChoice(choice);
                        showFeedback('Target saved', 'success');
                        resolve(extractTarget(choice, increment));
                    } else {
                        // Cancel means no action and no saved change. It
                        // previously fell through to the URL fallback
                        // and navigated.
                        resolve({ type: 'cancelled' });
                    }
                }, { teach: true, increment });
            });
        }

        chosenGroup = selection && !selection.ambiguous ? selection : null;
        if (!chosenGroup) return { type: 'url-fallback' };

        return withSeoAtBoundary(extractTarget(chosenGroup, increment), chosenGroup, candidates, increment);
    }

    // Whether a pager's own numbers show it at its first or last page: page 1
    // is marked current (for Previous), or no number beyond the current one
    // is shown in this direction.
    function atEdge(group, increment) {
        const { current, links } = analysePager(group);
        if (current === null) return false;
        if (!increment && current === 1) return true;
        return links.size > 0 && ![...links.keys()].some(n => increment ? n > current : n < current);
    }

    // Whether the page-level route for this direction (rel=next/prev, else
    // the URL fallback) moves the chosen pager: it changes the same part of
    // the address that the pager's own links change (for a "More"-only list,
    // the p in ?p=3), not the parameter of another list on the page.
    function pageRouteFits(group, candidates, increment) {
        const own = pagedComponent(group);
        const route = seoTarget(candidates, increment)?.value || urlFallback(increment).url;
        return !!own && !!route && changedComponent(route) === own;
    }

    // The part of this address that a group's own links change, or null.
    function pagedComponent(group) {
        return group.candidates.map(c => isUsableHref(getHref(c.el)) ? changedComponent(resolveHref(c.el)) : null).find(Boolean) || null;
    }

    // The one part of this address (a parameter or path segment) that a
    // destination on the same site changes, or null. Parameters only this
    // address carries (utm_source, say) and a trailing slash are ignored,
    // except that a destination changing nothing it carries changes the one
    // numbered part of this address it leaves out (page 1 written without
    // its number).
    function changedComponent(destination) {
        const trimmed = href => {
            try {
                const u = new URL(href, document.baseURI);
                if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
                return u.href;
            } catch { return ''; }
        };
        const here = urlComponents(trimmed(location.href)), there = urlComponents(trimmed(destination));
        if (!here || !there || here.origin !== there.origin || here.depth !== there.depth) return null;
        const changed = [...there.comps.keys()].filter(k => here.comps.get(k)?.raw !== there.comps.get(k).raw);
        if (changed.length) return changed.length === 1 ? changed[0] : null;
        const dropped = [...here.comps.keys()].filter(k => !there.comps.has(k) && here.comps.get(k).digits !== undefined);
        return dropped.length === 1 ? dropped[0] : null;
    }

    function seoTarget(candidates, increment) {
        const seoEl = increment ? candidates?.seoNext?.[0]?.el : candidates?.seoPrev?.[0]?.el;
        const seoHref = seoEl?.href || '';
        return seoHref ? { type: 'url', value: seoHref, via: 'seo' } : null;
    }

    // When detection alone picked a group (nothing chosen or remembered), only
    // a clearly identified pager confirms a boundary with a disabled control:
    // a disabled control in some other group (a carousel, a menu) gives way
    // to the page's own rel=next/prev link when there is one.
    function withSeoAtBoundary(target, group, candidates, increment) {
        if (target.type !== 'boundary' || isExplicitPager(group)) return target;
        return seoTarget(candidates, increment) || target;
    }

    // A clearly identified pager with no control for this direction, whose
    // current page is marked, which shows no page beyond it in this direction,
    // and which speaks for this address (see pagesThisUrl): its first or last
    // page (a WordPress-style pager omits Next on the last page rather than
    // disabling it). A pager for something else on the page (a reviews
    // widget, say) is not evidence about this address.
    function numberedBoundary(groups, increment) {
        for (const g of groups) {
            if (!g.hasNumbered || (increment ? g.hasNext : g.hasPrev) || !isExplicitPager(g)) continue;
            const { current, links } = analysePager(g);
            if (current === null || links.size === 0) continue;
            if ([...links.keys()].some(n => increment ? n > current : n < current)) continue;
            if (pagesThisUrl(links, current, increment, groups)) return { type: 'boundary', edge: increment ? 'last' : 'first' };
        }
        return null;
    }

    // Whether a pager at its edge speaks for this address, so the URL
    // fallback must not move past it. A pager whose numbered links lead to
    // addresses following one rule (value = a x page + b) does when the rule
    // puts this address at the current page (or the address omits the
    // number and the pager is at page 1); where this address's page number
    // is clearly identified, the rule must also be in that part of the
    // address. A bare trailing path number (an id or a date as often as a
    // page) counts as identified only when the page's own Next or Previous
    // links change it. A pager whose numbers lead nowhere (script buttons,
    // # links) does unless the page itself links to where the URL fallback
    // would go: that is an existing route, not a speculative hop.
    function pagesThisUrl(links, current, increment, groups) {
        const points = [];
        for (const [page, items] of links) {
            if (!isUsableHref(getHref(items[0].el))) continue;
            const url = urlComponents(resolveHref(items[0].el));
            if (url) points.push({ page, url });
        }
        const rule = points.length >= 2 ? fitRule(points) : null;
        if (!rule) {
            const route = urlFallback(increment).url;
            return !route || !linksTo(route);
        }
        const here = urlComponents(location.href);
        const c = here?.comps.get(rule.key);
        const info = identifyPageNumber(location.href);
        const at = info ? info.matchPosition + info.digitPosition : -1;
        const infoKey = info && here ? [...here.comps].find(([, comp]) => comp.digits !== undefined && comp.start === at)?.[0] : null;
        const identified = !!infoKey && (!isBarePathNumber(info) || groups.some(g => g.candidates.some(cand =>
            (cand.role === 'next' || cand.role === 'prev') && isUsableHref(getHref(cand.el)) && changedComponent(resolveHref(cand.el)) === infoKey)));
        if (identified) return rule.key === infoKey && c.value === rule.a * current + rule.b;
        return c?.digits !== undefined ? c.value === rule.a * current + rule.b : current === 1;
    }

    // Whether the page links to an address, with parameters in any order and
    // however they are encoded. The fragment is compared only when the
    // address differs from this one in its fragment alone (a hash route);
    // otherwise it is ignored (#top). Only links to the same path have their
    // query parsed.
    function linksTo(address) {
        let raw;
        try { raw = new URL(address); } catch { return false; }
        const inFragment = raw.href.split('#')[0] === location.href.split('#')[0];
        const query = search => {
            const params = new URLSearchParams(search);
            params.sort();
            return params.toString();
        };
        const target = query(raw.search);
        return Array.prototype.some.call(document.links, a => a.pathname === raw.pathname && a.origin === raw.origin &&
            (!inFragment || a.hash === raw.hash) && query(a.search) === target);
    }

    // A bare trailing number in the path (/item/12345, /2024/05/) is as
    // often an id or a date as a page number.
    function isBarePathNumber(info) {
        return info?.type === 'path' && /^\/\d+\/?$/.test(info.matchedString);
    }

    // Remembers a step for this section. The same evidence again changes
    // nothing, and consistent evidence that adds the page mapping replaces
    // it; evidence that contradicts the remembered step invalidates it (and
    // only it): the stored rule is removed and the new observation is not
    // trusted on its own either.
    function rememberRule(domain, rule) {
        if (!cleanRule({ ...rule, conditions: rule.conditions || {} })) return;
        const scope = scopeOf(location.href);
        const conditions = rule.conditions || {};
        const existing = siteEntries(domain).find(e => e.kind === 'rule' && e.scope === scope &&
            e.rule.key === rule.key && sameConditions(e.rule.conditions, conditions));
        if (existing) {
            const old = existing.rule;
            const consistent = old.a === rule.a && old.prefix === rule.prefix && old.suffix === rule.suffix &&
                (old.b === null || rule.b === null || old.b === rule.b);
            if (!consistent) {
                removeEntry(domain, existing.id);
                debugLog('Step evidence contradicts the remembered rule for', rule.key, '- rule removed');
                return;
            }
            if (old.b !== null || rule.b === null) return;
        }
        saveEntry(domain, { kind: 'rule', scope, rule: { key: rule.key, prefix: rule.prefix, suffix: rule.suffix, a: rule.a, b: rule.b, zero: !!rule.zero, conditions } });
    }

    // The directional control a group would use: highest confidence, first in
    // document order on a tie. Shared by execution and by the equivalence
    // check in distinctOptions(), so both describe the same control.
    function pickDirectional(group, increment) {
        const all = group.candidates.filter(c => c.role === (increment ? 'next' : 'prev'));
        if (all.length === 0) return null;
        // Enabled controls first. A disabled one is returned only when every
        // control for this direction is disabled, so the caller can report
        // the boundary.
        const enabled = all.filter(c => !c.disabled && !isDisabledControl(c.el, group.container));
        const candidates = enabled.length ? enabled : all;
        candidates.sort((a, b) => b.confidence - a.confidence);
        if (candidates.length > 1) {
            // Several controls for one direction (‹ and «, › and ») usually
            // mean adjacent-page and first/last-page links. Prefer the one
            // that leads where the pager's own numbered link for the adjacent
            // page leads; without that evidence keep the first candidate.
            const adjacent = adjacentNumberedCandidate(group, increment);
            const target = adjacent ? resolveHref(adjacent.el) : '';
            const match = target && candidates.find(c => resolveHref(c.el) === target);
            if (match) return match;
        }
        return candidates[0];
    }

    function extractTarget(group, increment) {
        const picked = pickDirectional(group, increment);
        if (!picked) {
            // No control for this direction: the pager's adjacent numbered
            // control, when it is clearly a pager and shows that neighbour.
            const adjacent = isExplicitPager(group) ? adjacentNumberedCandidate(group, increment) : null;
            return adjacent ? targetForControl(adjacent.el, adjacent.page, group.container) : { type: 'url-fallback' };
        }

        // Every control for this direction is disabled: a confirmed boundary,
        // which must not fall through to a speculative URL hop.
        if (picked.disabled || isDisabledControl(picked.el, group.container)) {
            return { type: 'boundary', edge: increment ? 'last' : 'first' };
        }

        // The page it reaches is known when the pager's own numbered control
        // for the adjacent page is the same control or leads to the same
        // place. It is used for feedback only.
        const adjacent = adjacentNumberedCandidate(group, increment);
        const destination = resolveHref(picked.el);
        const page = adjacent && (adjacent.el === picked.el || (destination && resolveHref(adjacent.el) === destination))
            ? adjacent.page : undefined;
        return targetForControl(picked.el, page, group.container);
    }

    function targetForControl(el, page, pager = null) {
        const href = getHref(el);
        if (isUsableHref(href) && isSameSection(href)) {
            // The choice between following the URL and clicking is unchanged;
            // the destination is the link's own, resolved against the document
            // base. Resolving against the origin sent <base href> pages (and
            // other relative links that happened to pass) to the wrong URL.
            const destination = resolveHref(el);
            if (destination) return { type: 'url', value: destination, page };
            try { return { type: 'url', value: new URL(href, location.origin).href, page }; } catch {}
        }

        if (Config.ajax.enabled) return { type: 'click', value: el, page, pager };

        return { type: 'url-fallback' };
    }

    // =========================================================================
    // LEARNING STEPS FROM CONFIRMED TRANSITIONS
    // =========================================================================

    // Parameters that carry cursors rather than positions. With IDENTITY_KEY
    // (see isCursorKey) they are never learned, predicted or saved as a step:
    // not from transitions, not from links.
    const CURSOR_KEY = /^(?:after|before|since|until|cursor|token|continuation|marker|next|prev|max_?id|min_?id|since_?id|from_?id|last_?id|page_?token|ctoken|offset_?id)$/i;

    function hashText(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
    }

    // A URL's query and fragment parameters: the value of a numeric position
    // parameter (with the text around its digits hashed), anything else only
    // as a hash, so cursors, identifiers and tokens are never recorded.
    function paramSnapshot(href) {
        const parsed = urlComponents(href);
        const snap = {};
        if (!parsed) return snap;
        for (const [key, c] of parsed.comps) {
            if (key.startsWith('path:')) continue;
            snap[key] = c.digits !== undefined && isPositionKey(key, parsed) ? [hashText(c.prefix), c.value, hashText(c.suffix)] : hashText(c.raw);
        }
        return snap;
    }

    // Transitions are recorded and learned in the top-level page only, and
    // never on a site where Page Hopper is disabled.
    const canLearn = () => window.top === window && !getSiteOverride()?.disabled;

    // Recorded just before a move through a live Next/Previous control whose
    // destination is known (Page Hopper's own move, or my click on such a
    // link). It holds hashes of the destination and path plus the parameter
    // snapshot (the values of position parameters only), and is consumed by
    // the next top-level page load on the same site within 15 seconds (see
    // consumeTransition).
    function recordTransition(increment, destination) {
        if (!destination || !canLearn()) return;
        let path;
        try { path = new URL(destination).pathname; } catch { return; }
        GM_setValue(STORAGE.TRANSITION, JSON.stringify({
            host: location.hostname,
            t: Date.now(),
            dir: increment ? 1 : -1,
            dest: hashText(destination),
            path: hashText(path),
            from: paramSnapshot(location.href)
        }));
    }

    // An adjacent transition teaches a step only when exactly one numeric
    // position parameter changed (never a cursor, identifier or page-size
    // parameter) and nothing else in the query or fragment changed.
    function learnTransition(record, href) {
        const to = paramSnapshot(href);
        const from = record.from || {};
        let changed = null;
        for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
            const a = from[key], b = to[key];
            if (JSON.stringify(a) === JSON.stringify(b)) continue;
            if (changed || !Array.isArray(a) || !Array.isArray(b) || a[0] !== b[0] || a[2] !== b[2]) return;
            changed = { key, from: a[1], to: b[1] };
        }
        if (!changed || isCursorKey(changed.key) || isPageSizeKey(changed.key)) return;
        const here = urlComponents(href);
        const c = here?.comps.get(changed.key);
        if (!c || c.digits === undefined || !isPositionKey(changed.key, here)) return;
        const step = (changed.to - changed.from) * record.dir;
        if (step === 0) return;
        rememberRule(location.hostname, {
            key: changed.key, prefix: c.prefix, suffix: c.suffix, a: step, b: null,
            zero: changed.from === 0 || changed.to === 0,
            conditions: pageSizeConditions(here, changed.key)
        });
        debugLog('Learned step', step, 'for', changed.key);
    }

    // On load: learn from the transition the previous page recorded, but only
    // if this page is exactly its destination. A page on another site (in
    // another tab, say) leaves the record alone; the next top-level page on
    // the same site consumes it, and learns only if it is the destination.
    // Records older than 15 seconds are discarded unused.
    function consumeTransition() {
        if (window.top !== window) return;
        const raw = GM_getValue(STORAGE.TRANSITION);
        if (!raw) return;
        const record = safeJsonParse(raw, null);
        const expired = !record || !(Date.now() - record.t <= 15000);
        if (!expired && record.host !== location.hostname) return;
        GM_setValue(STORAGE.TRANSITION, '');
        if (expired || !canLearn()) return;
        if (record.dest !== hashText(location.href) || record.path !== hashText(location.pathname)) return;
        learnTransition(record, location.href);
    }

    // My own clicks on a site's Next/Previous links are observable
    // transitions too. Plain left clicks on same-tab links only.
    function noteLinkClick(event) {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !event.isTrusted) return;
        const el = event.target?.closest?.('a[href]');
        if (!el || isOwnUiNode(el) || (el.target && el.target !== '_self')) return;
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        const role = /\bnext\b/.test(rel) ? 'next' : /\bprev(ious)?\b/.test(rel) ? 'prev' : classifyDirectional(el);
        if (role === 'next' || role === 'prev') recordTransition(role === 'next', resolveHref(el));
    }

    // =========================================================================
    // TEACHING (POINTING TO AN UNDETECTED NEXT/PREVIOUS CONTROL)
    // =========================================================================

    const Teach = { active: false, step: 'next', next: null, prev: null, panel: null, hovered: null };

    // While teaching, pointer interaction with the page is intercepted by
    // listeners registered at document start, ahead of the page's own, so
    // the control pointed at is recorded and never activated.
    const TEACH_POINTER_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick'];

    function isTeachUi(event) {
        return !!UI.host && event.composedPath().includes(UI.host);
    }

    function interceptTeachPointer(event) {
        if (!Teach.active || isTeachUi(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    // Registered at document start: teaching clicks are taken over; other
    // clicks are only observed (noteLinkClick) and never altered.
    function onDocumentClick(event) {
        if (!Teach.active) { noteLinkClick(event); return; }
        if (isTeachUi(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.button === 0) pickTeachTarget(teachTargetOf(event.target));
    }

    // The control a pointer or focus lands on. Inside an SVG icon, the icon
    // itself (or its clickable ancestor) is taken, never a path: a click on
    // the icon reaches a listener on the icon and, bubbling, one on any
    // element around it.
    function teachTargetOf(node) {
        let el = node?.nodeType === 1 ? node : node?.parentElement;
        const svg = el?.closest?.('svg');
        if (svg) el = svg;
        if (!el || el === document.body || el === document.documentElement) return null;
        return el.closest('a[href], button, [role="button"], [onclick], input[type="button"], input[type="submit"], [tabindex]') || el;
    }

    function startTeaching() {
        if (Teach.active) return;
        Object.assign(Teach, { active: true, step: 'next', next: null, prev: null, hovered: null });
        Action.busy = true;
        document.addEventListener('mouseover', onTeachHover, true);
        document.addEventListener('focusin', onTeachHover, true);
        document.addEventListener('keydown', onTeachKey, true);
        showTeachPrompt();
    }

    function onTeachHover(event) {
        const el = teachTargetOf(event.target);
        if (el === Teach.hovered || (el && isOwnUiNode(el))) return;
        Teach.hovered = el;
        markElements(el ? [el] : []);
    }

    function onTeachKey(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            // At the Previous step, Escape skips it and keeps Next.
            finishTeaching(Teach.step === 'prev');
        } else if (event.key === 'Enter' && document.activeElement && !isOwnUiNode(document.activeElement)) {
            const el = teachTargetOf(document.activeElement);
            if (!el) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            pickTeachTarget(el);
        }
    }

    function pickTeachTarget(el) {
        if (!el || isOwnUiNode(el)) return;
        if (Teach.step === 'next') {
            Teach.next = el;
            // A page selector serves both directions: nothing more to ask.
            if (el.tagName === 'SELECT') { finishTeaching(true); return; }
            Teach.step = 'prev';
            showTeachPrompt();
        } else {
            Teach.prev = el;
            finishTeaching(true);
        }
    }

    // Saves what was pointed at as this section's controls (replacing its
    // previous choice) and removes every trace of teaching from the page.
    function finishTeaching(save) {
        document.removeEventListener('mouseover', onTeachHover, true);
        document.removeEventListener('focusin', onTeachHover, true);
        document.removeEventListener('keydown', onTeachKey, true);
        clearMarks();
        if (Teach.panel) {
            Teach.panel.removeAttribute('data-ph-teach');
            removeAfterExit([Teach.panel], TOAST_EXIT_MS);
        }
        const { next, prev } = Teach;
        Object.assign(Teach, { active: false, step: 'next', next: null, prev: null, panel: null, hovered: null });
        Action.busy = false;
        if (save && next) {
            saveEntry(location.hostname, {
                kind: 'control',
                scope: scopeOf(location.href),
                next: createControlLocator(next),
                prev: prev ? createControlLocator(prev) : null
            });
            setSession(null);
            invalidateCache('teach');
            showFeedback(next.tagName === 'SELECT' ? 'Page selector saved' : prev ? 'Next and Previous controls saved' : 'Next control saved', 'success');
        }
    }

    // The teaching prompt is a persistent Shared UI toast with an action
    // (spec 6.14), in the in-progress colour: what to point at, and an action
    // that cancels at the Next step or skips the Previous step (keeping
    // Next), as Escape does. The toast region announces each step.
    function showTeachPrompt() {
        if (!ensureUi()) return;
        if (!Teach.panel) {
            const toast = uiElement('div', 'ph-toast ph-toast--teach');
            toast.setAttribute('data-ph-teach', '');
            toast.dataset.tone = 'progress';
            const message = uiElement('span');
            const action = uiElement('button', 'ph-toast__action');
            action.type = 'button';
            action.addEventListener('click', () => finishTeaching(Teach.step === 'prev'));
            toast.append(message, action);
            UI.toasts.appendChild(toast);
            Teach.panel = toast;
        }
        const [message, action] = Teach.panel.children;
        message.textContent = Teach.step === 'next'
            ? 'Click the Next control, or Tab to it and press Enter. Esc cancels.'
            : 'Now click the Previous control, or skip this step.';
        action.textContent = Teach.step === 'next' ? 'Cancel' : 'Skip';
    }

    // =========================================================================
    // ACTION EXECUTION
    // =========================================================================

    // Starts a navigation. Returns true when a new document is loading, and
    // false for a same-document move (only the fragment changes), which is
    // already complete. Assigning the current address without a fragment
    // reloads the page, so that is a new document too.
    function navigateTo(url) {
        const sameDocument = url.includes('#') && url.split('#')[0] === window.location.href.split('#')[0];
        window.location.href = url;
        return !sameDocument;
    }

    // Whether an identified number can be named as a page in feedback: not an
    // offset (start, offset) and not a bare trailing path number.
    function isNamedPage(info) {
        return !!info && !/^(?:offset|start)$/i.test(info.paramName || '') && !isBarePathNumber(info);
    }

    // The page number a destination URL shows, for feedback only (see
    // isNamedPage). When the number is the same as this URL's, something else
    // changed (another list's parameter, say), so no page number is claimed.
    function destinationPage(url) {
        const to = identifyPageNumber(url);
        if (!isNamedPage(to)) return null;
        const from = identifyPageNumber(window.location.href);
        const unchanged = from && from.type === to.type && from.paramName === to.paramName && from.value === to.value;
        return unchanged ? null : to.value;
    }

    async function adjustPage(increment) {
        debugLog('adjustPage:', increment ? 'next' : 'prev');
        if (Action.busy) return;
        Action.busy = true;
        let loading = false;

        try {
            const target = await resolvePaginationTarget(increment, true);

            if (target.type === 'disabled' || target.type === 'cancelled') return;

            if (target.type === 'teach') {
                setTimeout(startTeaching, 0);
                return;
            }

            if (target.type === 'boundary') {
                showFeedback(target.edge === 'first' ? 'Already at first page' : 'Already at last page', 'info');
                return;
            }

            // The chosen pager has no control this way and another list is
            // on the page: nothing moves rather than paging the wrong list.
            if (target.type === 'no-control') {
                showFeedback(`Chosen pagination has no ${increment ? 'Next' : 'Previous'} control`, 'info');
                return;
            }

            if (target.type === 'url') {
                // A rule knows its page (or knows it does not); only other
                // targets guess the page number from the destination URL.
                const pageNum = target.page !== undefined ? target.page : destinationPage(target.value);
                // Moves through live controls teach the step; arithmetic
                // (rules and the URL fallback) never teaches itself.
                if (target.via !== 'rule') recordTransition(increment, target.value);
                const before = paramSnapshot(location.href);
                loading = navigateWithFeedback(target.value, pageNum || null, increment);
                if (!loading && target.via !== 'rule') learnTransition({ dir: increment ? 1 : -1, from: before }, location.href);
                return;
            }

            if (target.type === 'click' || target.type === 'select' || target.type === 'form') {
                const el = target.type === 'click' ? target.value : target.el;
                const act = target.type === 'click' ? null : () => operatePageControl(target);
                const before = paramSnapshot(location.href);
                const beforeUrl = location.href;
                if (target.type === 'click' && el.tagName === 'A') recordTransition(increment, resolveHref(el));
                const result = await clickPaginationElement(el, increment, { pager: target.pager || null, act, page: target.page });
                loading = result === 'navigating';
                // A confirmed move that changed the URL in place (an SPA
                // route) is an adjacent transition observed directly.
                if (result === 'confirmed' && target.type === 'click' && location.href !== beforeUrl) {
                    learnTransition({ dir: increment ? 1 : -1, from: before }, location.href);
                }
                reportClickResult(result, increment, target);
                return;
            }

            loading = adjustPageByUrl(increment);
        } finally {
            // A loading document keeps further presses out until it unloads.
            // If it never does (a download, an empty response), presses are
            // accepted again after a generous wait, and the attempt is
            // reported as not confirmed.
            if (loading) {
                Action.release = setTimeout(() => {
                    Action.busy = false;
                    if (UI.toast?.dataset.tone === 'progress') showFeedback(`${Action.pending} not confirmed`, 'warning');
                }, 10000);
            } else {
                Action.busy = false;
            }
        }
    }

    // Feedback after a click or page control: the page reached when it is
    // known (from the pager as it now stands, else from the control chosen),
    // the direction otherwise, and plainly when nothing was confirmed.
    function reportClickResult(result, increment, target) {
        if (result === 'navigating') return;
        if (result === 'failed') { showFeedback('Click failed', 'error'); return; }
        if (result === 'unconfirmed') { showFeedback(`${sentenceCase(moveLabel(target.page, increment))} not confirmed`, 'warning'); return; }
        let page = target.pager?.isConnected ? analysePager({ container: target.pager, candidates: [] }).current : null;
        if (page === null) page = target.page;
        showFeedback(sentenceCase(moveLabel(page, increment)), 'success');
    }

    // A page restored from the back/forward cache resumes as it was left,
    // mid-navigation: nothing is in progress any more.
    function onPageShow(event) {
        if (!event.persisted) return;
        clearTimeout(Action.release);
        Action.busy = false;
        if (UI.toast?.dataset.tone === 'progress') hideFeedback(true);
    }

    function navigateHistory(forward) {
        debugLog('History:', forward ? 'forward' : 'back');
        if (forward) history.forward();
        else history.back();
        showFeedback(forward ? 'Forward' : 'Back', 'info');
    }

    // =========================================================================
    // DEBUG INFO
    // =========================================================================

    function showDebugInfo() {
        const { candidates, groups } = getCandidatesAndGroups();
        const urlPageInfo = identifyPageNumber(window.location.href);
        const domain = window.location.hostname;
        const entries = siteEntries(domain);
        const override = getSiteOverride();

        const info = [
            '=== Page Hopper v10.0.0 Debug ===',
            `URL: ${window.location.href}`,
            `URL Page: ${urlPageInfo ? `${urlPageInfo.value} (${urlPageInfo.type}, score: ${urlPageInfo.score})` : 'not detected'}`,
            `Site override: ${override ? JSON.stringify(override) : 'none'}`,
            `Site memory: ${entries.length ? entries.map(e => `${e.kind}${e.method ? ` (${e.method})` : ''}${e.origin === 'legacy' ? ' (from v9.2.0)' : ''} in ${e.scope}`).join('; ') : 'none'}`,
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
        showFeedback(`${groups?.length || 0} groups, ${candidates?.next?.length || 0}N/${candidates?.prev?.length || 0}P`, 'info');
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

        // A press while an action is in progress is consumed and ignored.
        if (Action.busy && (action === 'pageNext' || action === 'pagePrev')) return;

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

        // Changes the chosen target for this section: a detected pager, or
        // "point to the Next control" to teach one detection missed.
        GM_registerMenuCommand('Select pagination target', () => {
            if (Action.busy) return;
            const { groups } = getCandidatesAndGroups();
            const options = distinctOptions(groups);
            if (options.length === 0) {
                startTeaching();
                return;
            }
            Action.busy = true;
            showGroupSelector(options, (choice) => {
                Action.busy = false;
                if (choice?.teach) {
                    startTeaching();
                } else if (choice) {
                    rememberChoice(choice);
                    showFeedback('Target saved', 'success');
                }
            }, { teach: true });
        });

        GM_registerMenuCommand('Forget pagination memory for this site', () => {
            forgetSite(window.location.hostname);
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
        consumeTransition();
        debugLog('Page Hopper v10.0.0 initialized');
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true });

    // Teaching interception and observation of my own Next/Previous clicks,
    // registered at document start so they run ahead of the page's own
    // listeners. Both return at once unless teaching or a link click.
    for (const type of TEACH_POINTER_EVENTS) window.addEventListener(type, interceptTeachPointer, true);
    window.addEventListener('click', onDocumentClick, true);
    window.addEventListener('pageshow', onPageShow);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
