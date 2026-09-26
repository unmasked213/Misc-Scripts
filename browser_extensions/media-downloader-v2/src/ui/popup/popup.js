import { Req } from '../../shared/protocol.js';

const $ = (s) => document.querySelector(s);

async function send(action, extra = {}) {
    try {
        return await chrome.runtime.sendMessage({ action, ...extra });
    } catch (e) {
        return { ok: false, message: e?.message || 'worker unreachable' };
    }
}

async function refresh() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const r = await send(Req.GET_STATE, { tabId: tab.id });
    if (r?.ok) {
        $('#n').textContent = r.value.items.length;
        const failed = r.value.items.filter((i) => i.state === 'failed').length;
        const done = r.value.items.filter((i) => i.state === 'done').length;
        // Say something true, always — never render a result into a hidden box.
        $('#note').textContent = r.value.items.length
            ? `${done} saved · ${failed} failed · ${r.value.items.length} detected on this tab`
            : 'Nothing detected on this tab yet.';
    } else {
        $('#note').textContent = r?.message || '';
    }
}

$('#library').onclick = async () => { await send(Req.OPEN_LIBRARY); window.close(); };

$('#scan').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    $('#scan').disabled = true;
    const r = await send(Req.SCAN_TAB, { tabId: tab.id });
    $('#scan').disabled = false;
    if (!r?.ok) { $('#note').textContent = r?.message || 'Scan failed'; return; }
    await send(Req.OPEN_LIBRARY);
    window.close();
};

$('#scanAll').onclick = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const ids = tabs.filter((t) => /^https?:/.test(t.url || '')).map((t) => t.id);
    $('#scanAll').disabled = true;
    await send(Req.SCAN_TABS, { tabIds: ids });
    await send(Req.OPEN_LIBRARY);
    window.close();
};

refresh();
