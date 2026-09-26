/**
 * ISOLATED-world bridge.
 *
 * Dumb transport, and nothing else. v1's bridge.js ran its OWN uncoordinated
 * detection listeners (bridge.js:212-216) alongside intercept.js, emitting play
 * signals that were missing elementIdHash and nondeterministically resetting the
 * promotion window in the background (background.js:415). Two uncoordinated
 * detectors racing each other produced detection that felt random.
 *
 * There is exactly one detector now (probe.main.js). This file relays and does
 * not think.
 */

(() => {
    'use strict';

    const EVENT = '__mdl_probe_v2';

    document.addEventListener(EVENT, (e) => {
        const d = e?.detail;
        if (!d || typeof d.evidence !== 'string') return;

        // Never forward anything but our own known shape — the page can dispatch
        // this event too, and we are the trust boundary.
        const msg = {
            action: d.evidence,
            url: typeof d.url === 'string' ? d.url.slice(0, 4096) : null,
            elementId: typeof d.elementId === 'string' ? d.elementId.slice(0, 256) : undefined,
            width: Number.isFinite(d.width) ? d.width : undefined,
            height: Number.isFinite(d.height) ? d.height : undefined,
            duration: Number.isFinite(d.duration) ? d.duration : undefined,
            kind: ['video', 'audio', 'image', 'stream'].includes(d.kind) ? d.kind : undefined,
            pageTitle: typeof d.pageTitle === 'string' ? d.pageTitle.slice(0, 512) : undefined,
            drmSystem: typeof d.drmSystem === 'string' ? d.drmSystem.slice(0, 128) : undefined,
            isDRM: d.isDRM === true,
            evidence: mapEvidence(d.evidence),
        };
        if (!msg.url) return;

        try {
            chrome.runtime.sendMessage(msg).catch(() => {});
        } catch { /* extension context invalidated on reload — harmless */ }
    }, { passive: true });

    function mapEvidence(action) {
        switch (action) {
            case 'probe:media-play': return 'played';
            case 'probe:mse-append': return 'mse-appended';
            case 'probe:mse-attach': return 'mse-appended';
            case 'probe:eme-detected': return 'network';
            default: return 'dom-attached';
        }
    }
})();
