/**
 * Ring-buffer logger with a persisted tail, so "it didn't work" becomes a
 * paste-able timeline instead of a debugging session.
 */

const MAX = 500;
const buf = [];
let flushTimer = null;

export function log(scope, ...args) {
    const line = {
        t: Date.now(),
        scope,
        msg: args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' '),
    };
    buf.push(line);
    if (buf.length > MAX) buf.shift();
    // eslint-disable-next-line no-console
    console.log(`[mdl:${scope}]`, ...args);
    scheduleFlush();
}

export function warn(scope, ...args) {
    log(scope, 'WARN', ...args);
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
        flushTimer = null;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                await chrome.storage.local.set({ 'mdl:log': buf.slice(-MAX) });
            }
        } catch { /* logging must never break the caller */ }
    }, 2000);
}

export function snapshot() {
    return buf.slice();
}

/** Redacted, paste-ready diagnostics. Strips query strings, which carry tokens. */
export async function diagnostics(extra = {}) {
    const redact = (s) => String(s).replace(/\?[^\s"']*/g, '?…');
    let manifest = {};
    try { manifest = chrome.runtime.getManifest(); } catch { /* not in extension ctx */ }
    return {
        version: manifest.version || 'unknown',
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
        generatedAt: new Date().toISOString(),
        ...extra,
        log: buf.slice(-200).map((l) => ({ ...l, msg: redact(l.msg) })),
    };
}
