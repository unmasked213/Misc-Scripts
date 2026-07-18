// ==UserScript==
// @name         Video management: examplesite
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      11.0
// @description  Plays and pauses videos on examplesite pages, jumps to midpoint, hides short videos, manages video visibility, and toggles images
// @author       Unmasked213
// @include      /^https:\/\/.*examplesit.*\.[^\/]+\/a\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/video_management_examplesite.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/video_management_examplesite.user.js
// ==/UserScript==



(function() {
    'use strict';

    const CSS = `
    .np-panel,.np-panel *,.np-panel *::before,.np-panel *::after{box-sizing:border-box;margin:0;padding:0}
    .np-panel{
        --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;
        --rs:8px;--rm:12px;--rl:18px;--fs:14px;--fxs:11px;--fl:22px;--wm:400;--wl:500;
        --fast:120ms cubic-bezier(.2,0,.2,1);--spring:320ms cubic-bezier(.34,1.56,.64,1);
        --surface:rgb(11,14,23);--e1:rgb(28,31,41);--e2:rgb(40,43,54);--e3:rgb(56,60,72);
        --text:rgb(228,228,242);--mute:rgb(145,147,159);--strong:rgb(240,240,252);
        --accent:rgb(30,171,208);--accent-f:rgba(30,171,208,.16);--accent-on:rgb(0,36,46);
        --success:rgb(0,162,103);--success-f:rgba(0,162,103,.16);
        --error:rgb(255,113,100);--error-f:rgba(255,113,100,.16);
        --bl:rgba(228,228,242,.10);--bm:rgba(228,228,242,.22);
        --shadow:0 4px 12px rgba(0,0,0,.78);
        position:fixed;top:var(--s4);right:var(--s4);z-index:1000;
        background:var(--surface);border:1px solid var(--bl);border-radius:var(--rl);
        box-shadow:var(--shadow);padding:var(--s4);display:flex;flex-direction:column;
        gap:var(--s3);width:230px;color:var(--text);line-height:1.4;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        cursor:grab;user-select:none;transform-origin:top right;transition:transform var(--spring)
    }
    .np-panel.np-collapsed{transform:scale(0)!important;opacity:0;pointer-events:none;
        transition:transform var(--spring),opacity 200ms cubic-bezier(.2,0,.2,1)}
    .np-panel.np-dragging{cursor:grabbing;opacity:.9}
    .np-min{position:absolute;right:var(--s2);top:50%;transform:translateY(-50%);
        width:20px;height:20px;border-radius:50%;background:0;border:0;cursor:pointer;
        display:flex;align-items:center;justify-content:center;color:var(--mute);
        font-size:12px;transition:all var(--fast);opacity:.4}
    .np-min:hover{opacity:1;color:var(--accent)}
    .np-pill{position:fixed;top:16px;right:16px;z-index:1000;width:40px;height:40px;border-radius:50%;
        background:rgb(11,14,23);border:1px solid rgba(228,228,242,.10);
        box-shadow:0 4px 12px rgba(0,0,0,.78);cursor:grab;display:flex;align-items:center;
        justify-content:center;color:rgb(30,171,208);font-size:18px;font-weight:700;
        font-family:inherit;transform-origin:center;user-select:none;
        transition:transform 320ms cubic-bezier(.34,1.56,.64,1),opacity 200ms cubic-bezier(.2,0,.2,1)}
    .np-pill:hover{background:rgb(28,31,41)}
    .np-pill.np-dragging{cursor:grabbing}
    .np-pill.np-hidden{transform:scale(0);opacity:0;pointer-events:none}
    .np-card{display:flex;flex-direction:column;gap:var(--s2);padding:var(--s3);
        background:var(--e1);border-radius:var(--rm);border:1px solid var(--bl)}
    .np-lbl{font-size:var(--fxs);font-weight:var(--wl);color:var(--mute);
        text-transform:uppercase;letter-spacing:1px;padding:0 var(--s1);margin-bottom:var(--s1)}
    .np-stats{justify-content:center;align-items:center;gap:var(--s5);flex-direction:row;
        padding:var(--s4) var(--s5) var(--s4) var(--s3);position:relative}
    .np-stat{display:flex;flex-direction:column;align-items:center;gap:var(--s1)}
    .np-sv{font-size:var(--fl);font-weight:600;color:var(--accent);line-height:1}
    .np-sl{font-size:var(--fxs);font-weight:var(--wm);color:var(--mute);text-transform:uppercase;letter-spacing:1px}
    .np-sd{width:1px;height:32px;background:var(--bl)}
    .np-panel .np-btn{display:flex;align-items:center;justify-content:center;height:36px;
        background:var(--e2);border:1px solid var(--bl);border-radius:var(--rs);color:var(--text);
        font-size:var(--fs);font-weight:var(--wl);letter-spacing:.3px;cursor:pointer;
        transition:all var(--fast);font-family:inherit;width:100%}
    .np-panel .np-btn:hover{background:var(--e3);border-color:var(--bm)}
    .np-panel .np-btn:active{transform:scale(.97)}
    .np-panel .np-btn.np-on{background:var(--accent-f);border-color:var(--accent);color:var(--accent)}
    .np-panel .np-btn-p{background:var(--accent);border-color:var(--accent);color:var(--accent-on)}
    .np-panel .np-btn-p:hover{background:rgb(50,190,225);border-color:rgb(50,190,225)}
    .np-panel .np-btn-p.np-on{background:var(--success-f);border-color:var(--success);color:var(--success)}
    .np-panel .np-btn-x{background:var(--error-f);border-color:transparent;color:var(--error)}
    .np-panel .np-btn-x:hover{background:rgba(255,113,100,.24);border-color:var(--error)}
    .np-row{display:flex;align-items:center;gap:var(--s2);width:100%}
    .np-row .np-btn{flex:1;width:auto}
    .np-rl{flex:1;font-size:var(--fs);font-weight:var(--wl);color:var(--text);letter-spacing:.3px;padding:0 var(--s3)}
    .np-panel .np-iw{display:flex;align-items:center;height:36px;gap:2px;
        background:var(--surface)!important;border:1px solid var(--bl)!important;
        border-radius:var(--rs);padding:0 var(--s2)!important;flex-shrink:0;transition:border-color var(--fast)}
    .np-panel .np-iw:focus-within{border-color:var(--accent)!important}
    .np-panel .np-i{width:32px!important;background:0!important;border:0!important;
        color:var(--strong)!important;font-size:var(--fs)!important;font-weight:var(--wl)!important;
        text-align:right!important;outline:0!important;appearance:textfield!important;
        -moz-appearance:textfield!important;font-family:inherit!important;
        padding:0!important;margin:0!important;height:auto!important;line-height:1!important}
    .np-panel .np-i::-webkit-inner-spin-button,.np-panel .np-i::-webkit-outer-spin-button{
        -webkit-appearance:none!important;margin:0!important}
    .np-iu{color:var(--mute);font-size:var(--fxs);font-weight:var(--wm);pointer-events:none}
    .media-group>div.video{position:relative}
    div.img[data-src]{position:relative}
    .np-fab{position:absolute;top:8px;right:8px;z-index:50;width:36px;height:36px;border-radius:50%;
        border:0;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;
        line-height:1;cursor:pointer;font-family:inherit;opacity:0;pointer-events:none;overflow:hidden;
        transition:opacity 120ms cubic-bezier(.2,0,.2,1),transform 120ms cubic-bezier(.2,0,.2,1);
        box-shadow:0 2px 8px rgba(0,0,0,.7);background:rgb(30,171,208);color:rgb(0,36,46)}
    .media-group>div.video:hover .np-fab,.media-group div.img[data-src]:hover .np-fab{opacity:1;pointer-events:auto}
    .np-fab:hover{transform:scale(1.12);background:rgb(50,190,225)}
    .np-fab:active{transform:scale(.92)}
    .np-fab[data-st=queued]{opacity:1;pointer-events:none;background:rgb(232,177,0);color:rgb(40,30,0)}
    .np-fab[data-st=downloading]{opacity:1;pointer-events:none;
        background:conic-gradient(rgb(30,171,208) var(--np-prog,0%),rgb(40,43,54) 0%);color:rgb(240,240,252)}
    .np-fab[data-st=downloading]::after{content:'';position:absolute;inset:4px;border-radius:50%;background:rgb(28,31,41)}
    .np-fab[data-st=downloading] .np-pct{position:relative;z-index:1;font-size:9px;font-weight:700;color:rgb(228,228,242)}
    .np-fab[data-st=done]{opacity:1;pointer-events:none;background:rgb(0,162,103);color:rgb(240,240,252)}
    .np-fab[data-st=error]{opacity:1;pointer-events:auto;background:rgb(255,113,100);color:rgb(240,240,252)}
    .np-queue{font-size:var(--fxs);font-weight:var(--wl);color:var(--accent);text-align:center;letter-spacing:.3px}
    .np-prog{width:100%;height:4px;background:var(--e2);border-radius:2px;overflow:hidden}
    .np-prog-f{height:100%;width:0;background:var(--accent);border-radius:2px;transition:width 240ms cubic-bezier(.2,0,.2,1)}
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    // --- Helpers ---

    function el(tag, cls, p) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (p) {
            if (p.text != null) e.textContent = p.text;
            if (p.type) e.type = p.type;
            if (p.value !== undefined) e.value = p.value;
            if (p.step) e.step = p.step;
            if (p.children) p.children.forEach(c => e.appendChild(c));
            if (p.on) Object.entries(p.on).forEach(([ev, fn]) => e.addEventListener(ev, fn));
        }
        return e;
    }

    const inputRegistry = {};

    function makeInput(key, def, step, unit, onChange) {
        const val = GM_getValue(key, def);
        const inp = el('input', 'np-i', { type: 'number', value: val, step, on: {
            input: e => {
                const v = onChange(e);
                GM_setValue(key, v);
                channel.postMessage({ type: 'setting', key, value: v });
            }
        }});
        inputRegistry[key] = { inp, onChange: v => { inp.value = v; } };
        const children = [inp];
        if (unit) children.push(el('span', 'np-iu', { text: unit }));
        const wrap = el('div', 'np-iw', { children, on: { click: e => e.stopPropagation() } });
        return wrap;
    }

    function makeDraggable(target, { ignore, onStart, onEnd } = {}) {
        let dx, dy, moved;
        target.addEventListener('mousedown', e => {
            if (ignore && e.target.closest(ignore)) return;
            if (target.style.left === '') {
                const r = target.getBoundingClientRect();
                target.style.left = r.left + 'px';
                target.style.top = r.top + 'px';
                target.style.right = 'auto';
            }
            if (onStart) onStart(target);
            dx = e.clientX - target.offsetLeft;
            dy = e.clientY - target.offsetTop;
            moved = false;
            target.classList.add('np-dragging');
            const onMove = e => { moved = true; target.style.left = (e.clientX - dx) + 'px'; target.style.top = (e.clientY - dy) + 'px'; };
            const onUp = () => {
                target.classList.remove('np-dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (moved && onEnd) onEnd(target);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        return { wasMoved: () => moved };
    }

    // --- State ---

    let videoLengthToHide = GM_getValue('np_threshold', 30);
    let panelScale = GM_getValue('np_scale', 100);
    let maxDl = GM_getValue('np_concurrency', 3);
    let dlPaused = false, dlActive = 0, dlTotal = 0, dlCompleted = 0;
    const dlQueue = [], dlHandles = new Map();
    const DL_KEY = 'np_downloaded_urls', DL_MAX = 500;
    const dlDone = new Set(JSON.parse(localStorage.getItem(DL_KEY) || '[]'));
    const toggles = {
        short:    { on: false, hidden: [], btn: null },
        unloaded: { on: false, hidden: [], btn: null },
        images:   { on: false, hidden: [], btn: null },
    };

    function saveDl() {
        const a = [...dlDone];
        if (a.length > DL_MAX) a.splice(0, a.length - DL_MAX);
        localStorage.setItem(DL_KEY, JSON.stringify(a));
    }

    // --- Hide/show ---

    function hide(items, t) { items.forEach(i => { i.style.display = 'none'; t.hidden.push(i); }); }
    function show(t) { t.hidden.forEach(i => i.style.display = ''); t.hidden = []; }
    function setBtn(t, text, on) { t.btn.textContent = text; t.btn.classList.toggle('np-on', on); }

    function toggleShort() {
        const t = toggles.short;
        if (!t.on) {
            const h = [];
            document.querySelectorAll('div.video video').forEach(v => {
                const s = getDuration(v), d = v.duration;
                if ((s !== null && s < videoLengthToHide) || (d && d < videoLengthToHide))
                    h.push(v.closest('div.video') || v);
            });
            if (!h.length) return;
            hide(h, t); setBtn(t, 'Show all', true); thresholdIW.style.display = 'none';
        } else { show(t); setBtn(t, 'Hide under', false); thresholdIW.style.display = ''; }
        t.on = !t.on; updateCount();
    }

    function toggleUnloaded() {
        const t = toggles.unloaded;
        if (!t.on) {
            const h = [];
            document.querySelectorAll('div.video video').forEach(v => { if (v.readyState < 1) h.push(v.closest('div.video') || v); });
            if (!h.length) return;
            hide(h, t); setBtn(t, 'Show unloaded', true);
        } else { show(t); setBtn(t, 'Hide unloaded', false); }
        t.on = !t.on; updateCount();
    }

    function toggleImages() {
        const t = toggles.images;
        if (!t.on) {
            const items = [...document.querySelectorAll('div.img[data-src]')];
            if (!items.length) return;
            hide(items, t); setBtn(t, 'Show images', true);
        } else { show(t); setBtn(t, 'Hide images', false); }
        t.on = !t.on; updateCount();
    }

    function getDuration(v) {
        const s = v.closest('.video')?.querySelector('.duration');
        if (!s) return null;
        const [m, sec] = s.textContent.trim().split(':').map(Number);
        return m * 60 + sec;
    }

    function updateCount() {
        document.querySelectorAll('.media-group').forEach(g => {
            if (!g.children.length) return;
            g.style.display = [...g.children].every(c => c.style.display === 'none') ? 'none' : '';
        });
        const cv = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).length;
        const vids = cv('div.video'), imgs = cv('div.img[data-src]');
        statVV.textContent = vids; statIV.textContent = imgs;
        statSD.style.display = statSI.style.display = imgs > 0 ? '' : 'none';
        updateDlBtns();
    }

    // --- Download queue ---

    function queueDl(url, filename, fab, minSize = 1000) {
        if (fab.dataset.st && fab.dataset.st !== 'ready' && fab.dataset.st !== 'error') return;
        if (dlDone.has(url)) { fab.dataset.st = 'done'; fab.textContent = '\u2713'; return; }
        if (dlActive === 0 && dlQueue.length === 0) { dlTotal = 0; dlCompleted = 0; }
        dlDone.add(url); saveDl();
        dlQueue.push({ url, filename, fab, minSize }); dlTotal++;
        fab.dataset.st = 'queued'; fab.textContent = '\u23F3';
        processDl(); updateQueueUI();
    }

    function processDl() {
        if (dlPaused) return;
        while (dlActive < maxDl && dlQueue.length) {
            const item = dlQueue.shift(); dlActive++;
            item.fab.dataset.st = 'downloading'; item.fab.textContent = '\u2193';
            fetchDl(item);
        }
    }

    async function fetchDl(item) {
        try {
            const blob = await new Promise((resolve, reject) => {
                const handle = GM_xmlhttpRequest({
                    method: 'GET', url: item.url, responseType: 'blob',
                    headers: { Referer: window.location.href },
                    onprogress: p => {
                        const pct = p.total ? Math.round(p.loaded / p.total * 100) : 0;
                        item.fab.style.setProperty('--np-prog', pct + '%');
                        let pe = item.fab.querySelector('.np-pct');
                        if (!pe) { pe = document.createElement('span'); pe.className = 'np-pct'; item.fab.textContent = ''; item.fab.appendChild(pe); }
                        pe.textContent = pct + '%';
                    },
                    onload: r => r.response?.size > (item.minSize || 100) ? resolve(r.response) : reject(new Error(`Bad: ${r.status}`)),
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout')),
                });
                dlHandles.set(item.fab, { handle, url: item.url });
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = item.filename; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
            item.fab.style.removeProperty('--np-prog');
            item.fab.dataset.st = 'done'; item.fab.textContent = '\u2713'; dlCompleted++;
        } catch (e) {
            if (!dlHandles.has(item.fab) && item.fab.dataset.st === 'ready') { /* cancelled */ }
            else { item.fab.style.removeProperty('--np-prog'); item.fab.dataset.st = 'error'; item.fab.textContent = '!'; dlDone.delete(item.url); saveDl(); console.warn('[NP]', e?.message); }
        } finally {
            dlHandles.delete(item.fab);
            if (dlActive > 0) dlActive--;
            updateQueueUI(); processDl();
        }
    }

    let queueHideTimer;
    function updateQueueUI() {
        clearTimeout(queueHideTimer);
        const active = dlQueue.length + dlActive;
        if (active > 0 || dlCompleted > 0) {
            const pct = dlTotal > 0 ? Math.round(dlCompleted / dlTotal * 100) : 0;
            queueEl.textContent = `${dlCompleted} / ${dlTotal}`; queueEl.style.display = '';
            progFill.style.width = pct + '%'; progBar.style.display = '';
            if (active === 0 && dlCompleted > 0) queueHideTimer = setTimeout(() => {
                if (dlQueue.length + dlActive === 0) { queueEl.style.display = 'none'; progBar.style.display = 'none'; progFill.style.width = '0'; dlTotal = dlCompleted = 0; }
            }, 2000);
        } else { queueEl.style.display = 'none'; progBar.style.display = 'none'; progFill.style.width = '0'; }
        updateDlBtns();
    }

    // --- FABs ---

    function getVidSrc(c) { const s = c.querySelector('video source[src]'); return s?.src || c.querySelector('video')?.currentSrc || ''; }
    function fname(url) { try { return new URL(url).pathname.split('/').pop()?.split('?')[0] || 'media'; } catch { return 'media'; } }

    function attachFabs() {
        document.querySelectorAll('.media-group > div.video').forEach(c => {
            if (c.querySelector('.np-fab')) return;
            const fab = document.createElement('button');
            fab.className = 'np-fab'; fab.textContent = '\u2193'; fab.dataset.st = 'ready';
            const u = getVidSrc(c);
            if (u && dlDone.has(u)) { fab.dataset.st = 'done'; fab.textContent = '\u2713'; }
            fab.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                if (fab.dataset.st === 'error') fab.dataset.st = 'ready';
                if (fab.dataset.st !== 'ready') return;
                const url = getVidSrc(c);
                if (url?.startsWith('http')) queueDl(url, fname(url), fab);
                else { fab.dataset.st = 'error'; fab.textContent = '!'; }
            });
            c.appendChild(fab);
        });
        document.querySelectorAll('div.img[data-src]').forEach(c => {
            if (c.querySelector('.np-fab')) return;
            const fab = document.createElement('button');
            fab.className = 'np-fab'; fab.textContent = '\u2193'; fab.dataset.st = 'ready';
            const u = c.dataset.src;
            if (u && dlDone.has(u)) { fab.dataset.st = 'done'; fab.textContent = '\u2713'; }
            fab.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                if (fab.dataset.st === 'error') fab.dataset.st = 'ready';
                if (fab.dataset.st !== 'ready') return;
                const url = c.dataset.src;
                if (url?.startsWith('http')) queueDl(url, fname(url), fab, 100);
                else { fab.dataset.st = 'error'; fab.textContent = '!'; }
            });
            c.appendChild(fab);
        });
    }

    // --- Download controls ---

    function dlAll() {
        dlPaused = false;
        document.querySelectorAll('.media-group > div.video').forEach(c => {
            if (!c.offsetParent) return;
            const url = getVidSrc(c), fab = c.querySelector('.np-fab');
            if (!url?.startsWith('http') || !fab || fab.dataset.st === 'done') return;
            queueDl(url, fname(url), fab);
        });
        updateDlBtns();
    }

    function dlAllImages() {
        dlPaused = false;
        document.querySelectorAll('div.img[data-src]').forEach(imgDiv => {
            if (!imgDiv.offsetParent) return;
            const url = imgDiv.dataset.src;
            if (!url?.startsWith('http')) return;
            const fab = imgDiv.querySelector('.np-fab');
            if (!fab || fab.dataset.st === 'done') return;
            queueDl(url, fname(url), fab, 100);
        });
        updateDlBtns();
    }

    function pauseDl() { dlPaused = !dlPaused; if (!dlPaused) processDl(); updateDlBtns(); }

    function cancelDl() {
        dlPaused = false;
        dlHandles.forEach(({ handle, url }, fab) => {
            try { handle.abort(); } catch (_) {}
            fab.dataset.st = 'ready'; fab.textContent = '\u2193'; fab.style.removeProperty('--np-prog'); dlDone.delete(url);
        });
        dlHandles.clear(); dlActive = 0;
        dlQueue.forEach(i => { i.fab.dataset.st = 'ready'; i.fab.textContent = '\u2193'; dlDone.delete(i.url); });
        dlQueue.length = 0; dlTotal = dlCompleted = 0;
        saveDl(); updateQueueUI(); updateDlBtns();
    }

    function updateDlBtns() {
        const busy = dlQueue.length + dlActive > 0;
        btnPause.textContent = dlPaused ? 'Resume' : 'Pause';
        btnPause.style.display = btnCancel.style.display = busy ? '' : 'none';
        if (busy) { btnDlAll.style.display = 'none'; return; }
        btnDlAll.style.display = '';
        const vis = [...document.querySelectorAll('.media-group > div.video')].filter(c => c.offsetParent);
        const done = vis.length > 0 && vis.every(c => { const u = getVidSrc(c); return u && dlDone.has(u); });
        btnDlAll.textContent = done ? '\u2713 All downloaded' : 'Download all';
        btnDlAll.classList.toggle('np-on', done);
        btnDlAll.style.pointerEvents = done ? 'none' : '';
    }

    let fabTimer;
    new MutationObserver(() => { clearTimeout(fabTimer); fabTimer = setTimeout(attachFabs, 300); })
        .observe(document.body, { childList: true, subtree: true });

    // --- Build UI ---

    const statVV = el('div', 'np-sv', { text: '0' }), statIV = el('div', 'np-sv', { text: '0' });
    const statSD = el('div', 'np-sd'), statSI = el('div', 'np-stat', { children: [statIV, el('div', 'np-sl', { text: 'Images' })] });

    const statsBar = el('div', 'np-card np-stats', { children: [
        el('div', 'np-stat', { children: [statVV, el('div', 'np-sl', { text: 'Videos' })] }), statSD, statSI,
    ]});

    toggles.unloaded.btn = el('button', 'np-btn', { text: 'Hide unloaded', on: { click: toggleUnloaded } });
    toggles.images.btn = el('button', 'np-btn', { text: 'Hide images', on: { click: toggleImages } });
    toggles.short.btn = el('button', 'np-btn', { text: 'Hide under', on: { click: toggleShort } });

    const thresholdIW = makeInput('np_threshold', 30, '30', 's', e => videoLengthToHide = parseInt(e.target.value, 10) || 0);
    const concIW = makeInput('np_concurrency', 3, '1', null, e => maxDl = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)));
    const scaleIW = makeInput('np_scale', 100, '10', '%', e => { panelScale = Math.max(25, Math.min(200, parseInt(e.target.value, 10) || 100)); applyScale(); return panelScale; });

    const controls = el('div', 'np-card', { children: [
        el('div', 'np-lbl', { text: 'Visibility' }),
        toggles.unloaded.btn, toggles.images.btn,
        el('div', 'np-row', { children: [toggles.short.btn, thresholdIW] }),
        el('div', 'np-row', { children: [el('div', 'np-rl', { text: 'Concurrent' }), concIW] }),
        el('div', 'np-row', { children: [el('div', 'np-rl', { text: 'Scale' }), scaleIW] }),
    ]});

    const btnDlAll = el('button', 'np-btn np-btn-p', { text: '\u2193 Videos', on: { click: dlAll } });
    const btnDlImg = el('button', 'np-btn np-btn-p', { text: '\u2193 Images', on: { click: dlAllImages } });
    const btnPause = el('button', 'np-btn', { text: 'Pause', on: { click: pauseDl } }); btnPause.style.display = 'none';
    const btnCancel = el('button', 'np-btn np-btn-x', { text: 'Cancel', on: { click: cancelDl } }); btnCancel.style.display = 'none';
    const queueEl = el('div', 'np-queue'); queueEl.style.display = 'none';
    const progFill = el('div', 'np-prog-f'), progBar = el('div', 'np-prog', { children: [progFill] }); progBar.style.display = 'none';

    const dlCard = el('div', 'np-card', { children: [
        el('div', 'np-lbl', { text: 'Downloads' }),
        el('div', 'np-row', { children: [btnDlAll, btnDlImg] }),
        el('div', 'np-row', { children: [btnPause, btnCancel] }), progBar, queueEl,
    ]});

    const btnMin = el('button', 'np-min', { text: '\u00D7' });
    statsBar.appendChild(btnMin);

    const panel = el('div', 'np-panel', { children: [statsBar, controls, dlCard] });

    const pill = el('div', 'np-pill np-hidden', { text: '\u2630' });

    document.body.appendChild(panel);
    document.body.appendChild(pill);

    // --- Collapse / expand ---
    let collapsed = false;

    function savePos() {
        GM_setValue('np_pos', { ...lastPos, collapsed });
        broadcastPos();
    }

    let lastPos = { x: 0, y: 0 };

    function trackPos(element) {
        const r = element.getBoundingClientRect();
        lastPos = { x: Math.round(r.left), y: Math.round(r.top) };
    }

    function applyPos(pos) {
        if (!pos) return;
        lastPos = { x: pos.x, y: pos.y };
        if (pos.collapsed) {
            pill.style.left = pos.x + 'px'; pill.style.top = pos.y + 'px'; pill.style.right = 'auto';
            panel.classList.add('np-collapsed');
            pill.classList.remove('np-hidden');
            collapsed = true;
        } else {
            panel.style.left = pos.x + 'px'; panel.style.top = pos.y + 'px';
            panel.style.right = 'auto'; panel.style.transformOrigin = 'top left';
            collapsed = false;
        }
    }

    function collapse() {
        collapsed = true;
        const r = panel.getBoundingClientRect();
        const px = Math.round(r.right - 40), py = Math.round(r.top);
        pill.style.left = px + 'px'; pill.style.top = py + 'px'; pill.style.right = 'auto';
        lastPos = { x: px, y: py };
        panel.classList.add('np-collapsed');
        setTimeout(() => pill.classList.remove('np-hidden'), 150);
        savePos();
    }

    function expand() {
        collapsed = false;
        const r = pill.getBoundingClientRect();
        const panelX = r.right - 230, panelY = r.top;
        panel.style.left = panelX + 'px'; panel.style.top = panelY + 'px';
        panel.style.right = 'auto'; panel.style.transformOrigin = 'top right';
        lastPos = { x: Math.round(panelX), y: Math.round(panelY) };
        pill.classList.add('np-hidden');
        setTimeout(() => { panel.classList.remove('np-collapsed'); applyScale(); }, 150);
        savePos();
    }

    btnMin.addEventListener('click', e => { e.stopPropagation(); collapse(); });

    // Pill: drag + click
    const pillDrag = makeDraggable(pill, { onEnd: () => { trackPos(pill); savePos(); } });
    pill.addEventListener('mouseup', () => { if (!pillDrag.wasMoved()) expand(); });

    // --- Panel scale + drag ---
    function applyScale() { if (!collapsed) panel.style.transform = panelScale === 100 ? '' : `scale(${panelScale / 100})`; }
    makeDraggable(panel, {
        ignore: 'button,input,.np-iw',
        onStart: p => { p.style.transformOrigin = 'top left'; },
        onEnd: () => { trackPos(panel); savePos(); },
    });

    // --- Cross-tab sync ---
    const channel = new BroadcastChannel('np_panel_sync');
    channel.onmessage = e => {
        if (e.data?.type === 'pos') applyPos(e.data.pos);
        if (e.data?.type === 'setting') {
            const { key, value } = e.data;
            if (key === 'np_threshold') { videoLengthToHide = value; }
            else if (key === 'np_concurrency') { maxDl = value; }
            else if (key === 'np_scale') { panelScale = value; applyScale(); }
            if (inputRegistry[key]) inputRegistry[key].onChange(value);
        }
    };

    function broadcastPos() { channel.postMessage({ type: 'pos', pos: { ...lastPos, collapsed } }); }

    // --- Init ---
    applyPos(GM_getValue('np_pos', null));
    updateCount(); attachFabs(); applyScale();
})();