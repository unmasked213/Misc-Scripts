/**
 * The message contract between the six execution contexts.
 *
 * v1 had no schema: handlers guessed at message shapes, some branches never
 * responded (leaving the channel open until the port died), and the offscreen
 * document received a plain Array where crypto.subtle.importKey needed a
 * BufferSource — a guaranteed TypeError whose catch block wrote the still-
 * encrypted bytes to disk and reported success. One file, one contract.
 */

/** popup / library -> worker */
export const Req = {
    GET_STATE: 'get-state',              // {tabId?} -> {items, counts}
    SCAN_TAB: 'scan-tab',                // {tabId} -> {added}
    SCAN_TABS: 'scan-tabs',              // {tabIds} -> {added}
    DOWNLOAD: 'download',                // {ids, template, jobName} -> {jobId}
    CANCEL_JOB: 'cancel-job',            // {jobId}
    RETRY: 'retry',                      // {ids, strategy}
    GET_JOB: 'get-job',                  // {jobId} -> job
    CLEAR: 'clear',                      // {tabId?}
    OPEN_LIBRARY: 'open-library',
    GET_THUMBS: 'get-thumbs',            // {urls} -> {url: {thumb, w, h, bytes}}
    PROBE: 'probe',                      // {ids} -> preflight sizes/types
    GET_DIAGNOSTICS: 'get-diagnostics',
    GET_SETTINGS: 'get-settings',
    SET_SETTINGS: 'set-settings',
};

/** worker -> library/popup, over a long-lived port */
export const Evt = {
    ITEMS_CHANGED: 'items-changed',      // {added, changed, removed} — deltas, never snapshots
    JOB_PROGRESS: 'job-progress',
    JOB_DONE: 'job-done',
    THUMB_READY: 'thumb-ready',
};

/** content script (MAIN) -> bridge (ISOLATED) -> worker */
export const Probe = {
    MEDIA_ELEMENT: 'probe:media-element',
    MEDIA_PLAY: 'probe:media-play',
    MSE_ATTACH: 'probe:mse-attach',
    MSE_APPEND: 'probe:mse-append',
    EME_DETECTED: 'probe:eme-detected',
    DOM_MEDIA: 'probe:dom-media',
};

/** worker -> offscreen document */
export const Off = {
    FETCH_TO_DISK: 'off:fetch-to-disk',
    FETCH_BYTES: 'off:fetch-bytes',
    HLS_DOWNLOAD: 'off:hls-download',
    MAKE_THUMB: 'off:make-thumb',
    PROBE_HEAD: 'off:probe-head',
    CANCEL: 'off:cancel',
    RELEASE: 'off:release',              // {blobUrls: [...]} -> revoke after chrome.downloads has consumed them
};

/** offscreen -> worker */
export const OffEvt = {
    PROGRESS: 'off:progress',
    LOG: 'off:log',
};

export const PORT_LIBRARY = 'mdl-library';

/** The single event name used to cross the MAIN/ISOLATED boundary. */
export const PROBE_EVENT = '__mdl_probe_v2';

/**
 * Minimal runtime validation. Not a type system, but it turns a malformed
 * message into a named error at the boundary instead of an undefined-property
 * crash three frames deep.
 */
export function validate(msg, requiredFields = []) {
    if (!msg || typeof msg !== 'object') return 'message is not an object';
    if (typeof msg.action !== 'string') return 'message.action missing';
    for (const f of requiredFields) {
        if (msg[f] === undefined || msg[f] === null) return `missing required field: ${f}`;
    }
    return null;
}
