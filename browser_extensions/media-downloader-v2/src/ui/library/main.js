/**
 * Library page controller.
 *
 * State lives in one place, the view is a pure projection of it, and mutations
 * reconcile rather than rebuild. Filter, sort and density changes never touch
 * the network and never destroy a DOM node.
 */

import { Req, Evt, PORT_LIBRARY } from '../../shared/protocol.js';
import { fmtBytes, fmtDuration } from '../../shared/model.js';
import { DEFAULT_TEMPLATE } from '../../shared/url.js';
import { VirtualGrid } from './VirtualGrid.js';
import { Selection, attachMarquee, cluster } from './selection.js';

const $ = (s) => document.querySelector(s);

const state = {
    items: new Map(),        // id -> item
    viewIds: [],
    kind: 'all',
    minEdge: 0,
    sort: 'area',
    hideFiltered: false,
    stack: true,
    hideDone: false,
    stacks: new Map(),
    template: DEFAULT_TEMPLATE,
    activeJob: null,
    tabs: [],                // per-tab flags from the worker: MSE, DRM, segments
};

const selection = new Selection(() => {
    updateSelInfo();
    for (const [id, el] of grid.pool) el.classList.toggle('sel', selection.has(id));
});

let grid;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

async function send(action, extra = {}) {
    const r = await chrome.runtime.sendMessage({ action, ...extra });
    if (!r) return { ok: false, code: 'no_response', message: 'No response from worker' };
    return r;
}

const port = chrome.runtime.connect({ name: PORT_LIBRARY });
port.onMessage.addListener(({ type, payload }) => {
    if (type === Evt.ITEMS_CHANGED) refresh();
    else if (type === Evt.JOB_PROGRESS) onJobProgress(payload);
    else if (type === Evt.JOB_DONE) onJobDone(payload);
});

// ---------------------------------------------------------------------------
// Data pipeline: filter -> sort -> group. Pure, cheap, no side effects.
// ---------------------------------------------------------------------------

function passesFilter(it) {
    if (state.kind !== 'all' && it.kind !== state.kind) return false;
    if (state.hideDone && it.state === 'done') return false;
    if (state.minEdge > 0) {
        const edge = Math.max(it.width || 0, it.height || 0);
        // Unknown dimensions are never filtered out — we don't yet know, and
        // guessing would silently hide real results.
        if (edge > 0 && edge < state.minEdge) return false;
    }
    return true;
}

function sortItems(list) {
    const by = state.sort;
    return list.sort((a, b) => {
        switch (by) {
            case 'bytes': return (b.bytes || 0) - (a.bytes || 0);
            case 'added': return b.addedAt - a.addedAt;
            case 'confidence': return b.confidence - a.confidence;
            case 'name': return (a.label || '').localeCompare(b.label || '');
            case 'area':
            default: return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
        }
    });
}

function rebuildView() {
    const all = [...state.items.values()];

    state.stacks = state.stack ? cluster(all.filter((i) => i.kind === 'image')) : new Map();
    const stackedAway = new Set();
    if (state.stack) {
        for (const [rep, members] of state.stacks) {
            for (const m of members) if (m !== rep) stackedAway.add(m);
        }
    }

    const visible = all.filter((i) => !stackedAway.has(i.id));
    const passing = visible.filter(passesFilter);

    // Filtered-out items stay in the view but render dimmed, unless the user
    // explicitly asks to hide them. You can always see what your filter did.
    const shown = state.hideFiltered ? passing : visible;
    for (const it of shown) it._dim = !passesFilter(it);

    state.viewIds = sortItems(shown).map((i) => i.id);
    grid.setItems(state.viewIds, state.items);

    updateCounts(all);
    updateEmpty(all.length, state.viewIds.length);
    requestThumbs();
}

function updateCounts(all) {
    const counts = { all: all.length, image: 0, video: 0, stream: 0, audio: 0 };
    for (const i of all) if (counts[i.kind] !== undefined) counts[i.kind]++;
    for (const [k, n] of Object.entries(counts)) {
        const el = document.querySelector(`[data-count="${k}"]`);
        if (el) el.textContent = n;
    }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function renderTile(item) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `
        <div class="tile__box">
            <div class="tile__skel"></div>
            <img class="tile__img" alt="" hidden>
            <div class="tile__badges"></div>
            <div class="tile__check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        </div>
        <div class="tile__meta"><span class="dims"></span><span class="size"></span></div>`;
    updateTile(el, item);
    return el;
}

function updateTile(el, item) {
    const img = el.querySelector('.tile__img');
    const skel = el.querySelector('.tile__skel');

    // NEVER the full-resolution original. v1's `img.thumb || img.url` meant a
    // 200-image gallery of 4MB JPEGs decoded ~800MB of bitmaps into a popup.
    if (item.thumb) {
        if (img.getAttribute('src') !== item.thumb) img.src = item.thumb;
        img.hidden = false;
        skel.style.display = 'none';
    } else {
        img.hidden = true;
        skel.style.display = item.thumbFailed ? 'none' : '';
    }

    el.classList.toggle('sel', selection.has(item.id));
    el.classList.toggle('dim', !!item._dim);

    const badges = el.querySelector('.tile__badges');
    const b = [];
    const stackMembers = state.stacks.get(item.id);
    if (stackMembers && stackMembers.length > 1) b.push(`<span class="badge stack">&#9707; x${stackMembers.length}</span>`);
    if (item.state === 'done') b.push('<span class="badge have">saved</span>');
    if (item.state === 'failed') b.push('<span class="badge fail">failed</span>');
    if (item.isDRM) b.push('<span class="badge drm">DRM</span>');
    if (item.kind !== 'image') b.push(`<span class="badge">${item.kind}</span>`);
    badges.innerHTML = b.join('');

    el.querySelector('.dims').textContent =
        item.width && item.height ? `${item.width}x${item.height}`
        : item.duration ? fmtDuration(item.duration)
        : '';
    // Real bytes only. v1 fabricated filesize from pixel dimensions and showed
    // the guess as fact, so the one number worth filtering on was fiction.
    el.querySelector('.size').textContent = item.bytes ? fmtBytes(item.bytes) : '';
}

// ---------------------------------------------------------------------------
// Thumbnails — request once, patch in place, never re-render
// ---------------------------------------------------------------------------

let thumbTimer = null;
function requestThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(async () => {
        // Viewport-scoped, not list-scoped.
        const need = grid.visibleIds()
            .map((id) => state.items.get(id))
            .filter((i) => i && i.kind === 'image' && !i.thumb && !i.thumbFailed && !i.thumbPending)
            .slice(0, 24)
            .map((i) => i.id);
        if (!need.length) return;

        for (const id of need) { const it = state.items.get(id); if (it) it.thumbPending = true; }

        const r = await send(Req.GET_THUMBS, { ids: need });
        if (!r.ok) {
            for (const id of need) { const it = state.items.get(id); if (it) it.thumbPending = false; }
            return;
        }
        for (const id of need) {
            const it = state.items.get(id);
            if (!it) continue;
            it.thumbPending = false;
            const data = r.value[id];
            // A missing entry means the worker skipped it; treat as failed so we
            // never re-request it forever, which is exactly what v1 did on every
            // single re-render.
            if (!data || data.error) it.thumbFailed = true;
            else Object.assign(it, data);
            grid.patch(id, it);          // patch ONE tile; no cascade
        }
        requestThumbs();                 // continue down the viewport
    }, 60);
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function showInspector(id) {
    const it = state.items.get(id);
    const box = $('#inspector');
    if (!it) { box.innerHTML = '<div class="inspector__empty muted">Select an item to inspect it.</div>'; return; }

    // The FULL-resolution image, which is the whole point of an inspector.
    // v1's hover preview used `img.thumb || img.url` under a comment saying it
    // used the full-res URL — a 150px q0.5 JPEG scaled up.
    const preview = it.kind === 'image'
        ? `<img src="${escapeAttr(it.url)}" alt="" loading="lazy">`
        : '';

    box.innerHTML = `
        ${preview}
        <dl class="kv">
            <dt>Type</dt><dd>${escapeHtml(it.mime || it.kind || '?')}</dd>
            <dt>Size</dt><dd>${it.bytes ? fmtBytes(it.bytes) : '<span class="faint">unknown</span>'}</dd>
            ${it.width ? `<dt>Pixels</dt><dd>${it.width} x ${it.height}</dd>` : ''}
            ${it.duration ? `<dt>Length</dt><dd>${fmtDuration(it.duration)}</dd>` : ''}
            <dt>Confidence</dt><dd>${it.confidence}% <span class="faint">(${it.evidence.join(', ')})</span></dd>
            <dt>Source</dt><dd>${escapeHtml(it.pageTitle || it.site || '')}</dd>
            <dt>URL</dt><dd class="mono">${escapeHtml(it.url.slice(0, 160))}</dd>
            ${it.savedPath ? `<dt>Saved</dt><dd class="mono">${escapeHtml(it.savedPath)}</dd>` : ''}
            ${it.failMessage ? `<dt>Failed</dt><dd style="color:var(--ui-fail)">${escapeHtml(it.failMessage)}</dd>` : ''}
        </dl>
        <div class="row">
            <button id="i-copy">Copy URL</button>
            <button id="i-open">Open</button>
        </div>
        <div class="row">
            <button id="i-dl" class="primary">Download this</button>
        </div>`;

    $('#i-copy').onclick = () => navigator.clipboard.writeText(it.url);
    $('#i-open').onclick = () => chrome.tabs.create({ url: it.url });
    // Everything is downloadable, always. v1's "candidates" were unselectable
    // dead ends whose one escape hatch had no caller.
    $('#i-dl').onclick = () => startDownload([it.id]);
}

// ---------------------------------------------------------------------------
// Downloads + ledger
// ---------------------------------------------------------------------------

async function startDownload(ids) {
    if (!ids.length) return;
    const r = await send(Req.DOWNLOAD, { ids, template: $('#template').value, jobName: 'Library' });
    if (!r.ok) return alert(`Could not start: ${r.message}`);
    state.activeJob = r.value.jobId;
    $('#bar').hidden = false;
    $('#ledger').hidden = true;
}

function onJobProgress(p) {
    if (!p || p.jobId !== state.activeJob) return;
    if (p.recordId) {
        const it = state.items.get(p.recordId);
        if (it) { it.state = p.state || it.state; grid.patch(p.recordId, it); }
    }
    send(Req.GET_JOB, { jobId: state.activeJob }).then((r) => { if (r.ok) paintBar(r.value); });
}

function paintBar(s) {
    const total = s.total || 1;
    const pct = (n) => (n / total) * 100 + '%';
    $('.s-done').style.width = pct(s.counts.done || 0);
    $('.s-fail').style.width = pct(s.counts.failed || 0);
    $('.s-live').style.width = pct(s.counts.fetching || 0);
    $('#barText').textContent =
        `${s.counts.done || 0}/${s.total} done · ${s.counts.failed || 0} failed · ${fmtBytes(s.bytes)}`;
}

function onJobDone(s) {
    if (!s) return;
    paintBar(s);
    showLedger(s);
}

/**
 * The result summary, in a container that is actually visible.
 * This is the single most consequential UI fix in the rebuild.
 */
function showLedger(s) {
    const el = $('#ledger');
    const groups = (s.failures || []).map((f) => `
        <div class="ledger__group">
            <div><strong>${f.count}</strong> &times; ${escapeHtml(f.text)}</div>
            ${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ''}
            <div class="samples">${f.samples.map((u) => escapeHtml(u.slice(0, 90))).join('<br>')}</div>
            <div class="row" style="margin-top:8px">
                <button data-retry="${escapeAttr(f.code)}">Retry these ${f.count}</button>
            </div>
        </div>`).join('');

    const notes = (s.notes || []).map((n) => `
        <div class="ledger__note">${escapeHtml(n.note)}<div class="p">${escapeHtml(String(n.path || n.url || '').slice(0, 120))}</div></div>`).join('');
    const filesText = s.files && s.files !== (s.counts.done || 0) ? ` · ${s.files} files` : '';

    el.innerHTML = `
        <h3>${s.counts.done || 0} downloaded · ${s.counts.failed || 0} failed</h3>
        <div class="muted" style="margin-bottom:12px">${fmtBytes(s.bytes)} written${filesText}</div>
        ${notes}
        ${groups || '<div class="muted">No failures.</div>'}
        <div class="row" style="margin-top:12px">
            <button id="ledger-close">Close</button>
        </div>`;
    el.hidden = false;

    el.querySelectorAll('[data-retry]').forEach((b) => {
        b.onclick = async () => {
            await send(Req.RETRY, { jobId: s.jobId, codes: [b.dataset.retry] });
            el.hidden = true;
        };
    });
    $('#ledger-close').onclick = () => { el.hidden = true; };
}

// ---------------------------------------------------------------------------
// Empty / diagnostic states
// ---------------------------------------------------------------------------

function updateEmpty(totalKnown, shown) {
    const el = $('#empty');
    if (shown > 0) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = totalKnown === 0
        ? `<h2>Nothing detected yet</h2>
           <ul>
             <li>Click <strong>Scan current tab</strong> to walk the DOM (all frames).</li>
             <li>For video: press play once — many players only reveal the real
                 source when playback starts.</li>
             <li>Media inside a <em>closed</em> shadow root cannot be seen by any
                 extension. That is a platform limit, not a bug here.</li>
           </ul>`
        : `<h2>Everything is filtered out</h2>
           <ul><li>${totalKnown} item(s) detected, but none match the current filter.</li>
               <li>Try lowering <strong>Min edge</strong> or switching to <strong>All</strong>.</li></ul>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function updateSelInfo() {
    let bytes = 0;
    for (const id of selection.ids()) bytes += state.items.get(id)?.bytes || 0;
    $('#selInfo').textContent =
        `${selection.size} selected${bytes ? ' · ~' + fmtBytes(bytes) : ''}`;
    $('#download').disabled = selection.size === 0;
}

/**
 * Find the tab the user actually means.
 *
 * chrome.tabs.query({active:true, lastFocusedWindow:true}) returns the LIBRARY
 * when the Library is focused — which it always is, because that is where the
 * button lives. So we skip non-http(s) tabs and fall back to the most recently
 * accessed web page.
 */
async function pickTargetTab() {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && /^https?:/i.test(active.url || '')) return active;

    const tabs = await chrome.tabs.query({ currentWindow: true });
    const web = tabs.filter((t) => /^https?:/i.test(t.url || ''));
    if (!web.length) {
        const anyWindow = await chrome.tabs.query({});
        const w = anyWindow.filter((t) => /^https?:/i.test(t.url || ''));
        w.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        return w[0] || null;
    }
    web.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return web[0];
}

function setStatus(text, isError = false) {
    const el = $('#source');
    el.textContent = text;
    el.style.color = isError ? 'var(--ui-fail)' : '';
}

async function refresh() {
    // No tabId = everything. The Library is a session library: media accumulates
    // across tabs and navigations until you clear it.
    const r = await send(Req.GET_STATE, state.tabId != null ? { tabId: state.tabId } : {});
    if (!r.ok) return;
    for (const it of r.value.items) {
        const prev = state.items.get(it.id);
        state.items.set(it.id, prev ? { ...prev, ...it } : it);
    }
    // Drop records whose tab is gone, but never drop a selection for a filter change.
    const known = new Set(r.value.items.map((i) => i.id));
    for (const id of [...state.items.keys()]) if (!known.has(id)) state.items.delete(id);
    selection.reconcile([...state.items.keys()]);

    if (r.value.settings?.template && !$('#template').value) {
        $('#template').value = r.value.settings.template;
    }
    state.tabs = Array.isArray(r.value.tabs) ? r.value.tabs : [];
    updateNotice();
    rebuildView();
}

/**
 * Tab-level facts that used to be (mis)represented as records: a page using
 * MSE, a page that asked for a DRM key system, segments flowing for a stream.
 * Shown as one line so the user knows why the grid looks the way it does.
 */
function updateNotice() {
    const el = $('#notice');
    const bits = [];
    for (const t of state.tabs) {
        const site = siteLabel(t.pageUrl);
        if (t.drm) {
            bits.push(`<span><i class="dot drm"></i>${site}: protected playback (${escapeHtml(t.drm)}) — those streams cannot be downloaded</span>`);
        } else if (t.mse) {
            bits.push(`<span><i class="dot"></i>${site}: player uses MSE — press play, then rescan to expose the stream URL</span>`);
        }
        if (t.segments > 0) {
            bits.push(`<span><i class="dot info"></i>${site}: ${t.segments} stream segment${t.segments === 1 ? '' : 's'} observed — the stream itself is under <strong>Streams</strong></span>`);
        }
    }
    el.innerHTML = bits.join('');
    el.hidden = bits.length === 0;
}

function siteLabel(url) {
    try { return escapeHtml(new URL(url).hostname.replace(/^www\./, '')); } catch { return 'this page'; }
}

function wire() {
    grid = new VirtualGrid($('#gridwrap'), { renderTile, updateTile });
    attachMarquee(grid.layer, grid, selection, () => state.viewIds);

    // Thumbnails follow the viewport as you scroll.
    $('#gridwrap').addEventListener('scroll', () => requestThumbs(), { passive: true });

    grid.layer.addEventListener('click', (e) => {
        const tile = e.target.closest('.tile');
        if (!tile) return;
        const id = tile.dataset.id;
        if (e.shiftKey) selection.range(id, state.viewIds, e.ctrlKey || e.metaKey);
        else if (e.ctrlKey || e.metaKey) selection.toggle(id);
        else selection.set(id);
        showInspector(id);
    });

    $('#kindFilter').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state.kind = b.dataset.kind;
        [...e.currentTarget.children].forEach((c) => c.classList.toggle('on', c === b));
        rebuildView();
    });

    // Slider: paint the number on every tick, but only re-project on release.
    // v1 rebuilt the entire DOM on every `input` event.
    const minEdge = $('#minEdge');
    minEdge.addEventListener('input', () => { $('#minEdgeOut').textContent = minEdge.value; });
    minEdge.addEventListener('change', () => { state.minEdge = +minEdge.value; rebuildView(); });

    $('#density').addEventListener('input', (e) => grid.setDensity(+e.target.value));
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; rebuildView(); });
    $('#hideFiltered').addEventListener('change', (e) => { state.hideFiltered = e.target.checked; rebuildView(); });
    $('#stack').addEventListener('change', (e) => { state.stack = e.target.checked; rebuildView(); });
    $('#hideDone').addEventListener('change', (e) => { state.hideDone = e.target.checked; rebuildView(); });

    $('#selAll').onclick = () => selection.selectAll(state.viewIds.filter((id) => !state.items.get(id)?._dim));
    $('#selNone').onclick = () => selection.clear();
    $('#selInvert').onclick = () => selection.invert(state.viewIds);
    $('#download').onclick = () => startDownload(selection.ids());

    $('#scan').onclick = async () => {
        const tab = await pickTargetTab();
        if (!tab) return setStatus('No web page open to scan — open one in this window first.', true);
        setStatus(`Scanning ${tab.title || tab.url}…`);
        const r = await send(Req.SCAN_TAB, { tabId: tab.id });
        if (!r.ok) return setStatus(r.message, true);
        setStatus(`${tab.title || tab.url} — found ${r.value.added} new across ${r.value.frames} frame(s)`);
        refresh();
    };

    $('#scanAll').onclick = async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const ids = tabs.filter((t) => /^https?:/i.test(t.url || '')).map((t) => t.id);
        if (!ids.length) return setStatus('No web pages in this window to scan.', true);
        setStatus(`Scanning ${ids.length} tab(s)…`);
        const r = await send(Req.SCAN_TABS, { tabIds: ids });
        if (!r.ok) return setStatus(r.message, true);
        setStatus(`Scanned ${r.value.scanned} tab(s) — found ${r.value.added} new` +
                  (r.value.skipped ? ` · ${r.value.skipped} skipped (not web pages)` : ''));
        refresh();
    };
    $('#clear').onclick = async () => { await send(Req.CLEAR, {}); state.items.clear(); selection.clear(); rebuildView(); };

    $('#probe').onclick = async () => {
        const ids = selection.size ? selection.ids() : state.viewIds;
        const r = await send(Req.PROBE, { ids });
        if (!r.ok) return;
        if (r.value.warning) alert(r.value.warning);
        refresh();
    };

    $('#diag').onclick = async () => {
        const r = await send(Req.GET_DIAGNOSTICS);
        if (r.ok) {
            await navigator.clipboard.writeText(JSON.stringify(r.value, null, 2));
            $('#diag').textContent = 'Copied';
            setTimeout(() => { $('#diag').textContent = 'Diagnostics'; }, 1500);
        }
    };

    // Keyboard: focus survives filtering because tiles are never destroyed.
    $('#gridwrap').addEventListener('keydown', (e) => {
        const cur = selection.lead ? state.viewIds.indexOf(selection.lead) : -1;
        let next = null;
        if (e.key === 'ArrowRight') next = cur + 1;
        else if (e.key === 'ArrowLeft') next = cur - 1;
        else if (e.key === 'ArrowDown') next = cur + grid.cols;
        else if (e.key === 'ArrowUp') next = cur - grid.cols;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = state.viewIds.length - 1;
        else if (e.key === ' ' && selection.lead) { e.preventDefault(); selection.toggle(selection.lead); return; }
        else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selection.selectAll(state.viewIds); return; }
        else if (e.key === 'Escape') { selection.clear(); return; }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { startDownload(selection.ids()); return; }
        else return;

        e.preventDefault();
        next = Math.max(0, Math.min(state.viewIds.length - 1, next ?? 0));
        const id = state.viewIds[next];
        if (!id) return;
        if (e.shiftKey) selection.range(id, state.viewIds, true);
        else selection.set(id);
        grid.scrollToIndex(next);
        showInspector(id);
    });

    $('#template').value = DEFAULT_TEMPLATE;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

wire();
(async () => {
    // Deliberately does NOT scope to a tab. Setting state.tabId here was the bug:
    // the "active tab in the last focused window" is the Library itself, so the
    // view asked for records belonging to an extension page and always got none —
    // while 800+ records sat in the store.
    const tab = await pickTargetTab();
    setStatus(tab ? `nearest page: ${tab.title || tab.url}` : 'no web page open');
    refresh();
})();
