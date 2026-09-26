/**
 * Result<T, E> — explicit success/failure with no throwing across context boundaries.
 *
 * The v1 extension reported success the moment chrome.downloads minted an ID and
 * threw away every error path. Every fallible operation here returns a Result and
 * every failure carries a machine-readable code, so the UI can group failures by
 * cause and retry them with a different strategy.
 */

/** @typedef {{ok: true, value: any}} Ok */
/** @typedef {{ok: false, code: string, message: string, meta?: object}} Err */

export function ok(value) {
    return { ok: true, value };
}

export function err(code, message, meta) {
    return { ok: false, code, message: String(message ?? code), ...(meta ? { meta } : {}) };
}

export function isOk(r) {
    return !!r && r.ok === true;
}

/** Wrap a throwing async fn so it yields an Err instead of rejecting. */
export async function attempt(code, fn) {
    try {
        return ok(await fn());
    } catch (e) {
        return err(code, e?.message || String(e), { name: e?.name });
    }
}

/**
 * Typed failure taxonomy. The UI groups by these and offers a strategy-aware
 * retry per group — "retry all 17 timeouts with a longer deadline" rather than
 * replaying the identical request that already failed.
 */
export const Fail = {
    // Network / HTTP
    HTTP_401: 'http_401',
    HTTP_403: 'http_403',
    HTTP_404: 'http_404',
    HTTP_429: 'http_429',
    HTTP_5XX: 'http_5xx',
    NETWORK: 'network_error',
    TIMEOUT: 'timeout',
    ABORTED: 'aborted',

    // Content verification — the class v1 could not detect at all
    WRONG_MAGIC: 'wrong_magic',          // bytes are not the media type claimed
    HTML_RESPONSE: 'html_response',      // the classic "downloaded an error page"
    ZERO_BYTES: 'zero_bytes',
    IMPLAUSIBLE_SIZE: 'implausible_size',
    REDIRECTED_AWAY: 'redirected_away',
    MIME_MISMATCH: 'mime_mismatch',

    // Download subsystem
    DOWNLOAD_INTERRUPTED: 'download_interrupted',
    FILENAME_REJECTED: 'filename_rejected',
    DISK_FULL: 'disk_full',

    // Stream-specific
    DRM_PROTECTED: 'drm_protected',
    MANIFEST_PARSE: 'manifest_parse',
    SEGMENT_FAILED: 'segment_failed',
    DECRYPT_FAILED: 'decrypt_failed',

    // Pipeline
    TOO_LARGE: 'too_large',              // exceeds what the in-memory tier can hold
    NO_TRANSPORT: 'no_transport',
    OFFSCREEN_UNAVAILABLE: 'offscreen_unavailable',
    CANCELLED: 'cancelled',
};

/** Human-readable, actionable text for a failure code. Shown in the ledger. */
export const FAIL_TEXT = {
    [Fail.HTTP_401]: 'Unauthorized — the server wants credentials we did not send',
    [Fail.HTTP_403]: 'Forbidden — likely a Referer check or an expired signed URL',
    [Fail.HTTP_404]: 'Not found — the URL may have expired',
    [Fail.HTTP_429]: 'Rate limited — too many requests to this host',
    [Fail.HTTP_5XX]: 'Server error',
    [Fail.NETWORK]: 'Network error',
    [Fail.TIMEOUT]: 'Timed out',
    [Fail.ABORTED]: 'Aborted',
    [Fail.WRONG_MAGIC]: 'File contents are not the expected media type',
    [Fail.HTML_RESPONSE]: 'Server returned an HTML page, not media',
    [Fail.ZERO_BYTES]: 'Empty response',
    [Fail.IMPLAUSIBLE_SIZE]: 'File is far too small to be the real media',
    [Fail.REDIRECTED_AWAY]: 'Redirected to a different origin — probably a login or interstitial',
    [Fail.MIME_MISMATCH]: 'Content-Type does not match the requested media',
    [Fail.DOWNLOAD_INTERRUPTED]: 'Download interrupted by the browser',
    [Fail.FILENAME_REJECTED]: 'Chrome rejected the filename',
    [Fail.DISK_FULL]: 'Not enough disk space',
    [Fail.DRM_PROTECTED]: 'DRM protected — cannot be downloaded',
    [Fail.MANIFEST_PARSE]: 'Could not parse the stream manifest',
    [Fail.SEGMENT_FAILED]: 'One or more stream segments failed',
    [Fail.DECRYPT_FAILED]: 'Decryption failed',
    [Fail.TOO_LARGE]: 'Too large to assemble in memory — needs the native helper (Tier 3)',
    [Fail.NO_TRANSPORT]: 'Every download method failed',
    [Fail.OFFSCREEN_UNAVAILABLE]: 'Internal download worker unavailable',
    [Fail.CANCELLED]: 'Cancelled',
};

/** Map an HTTP status onto a failure code. */
export function failFromStatus(status) {
    if (status === 401) return Fail.HTTP_401;
    if (status === 403) return Fail.HTTP_403;
    if (status === 404) return Fail.HTTP_404;
    if (status === 429) return Fail.HTTP_429;
    if (status >= 500) return Fail.HTTP_5XX;
    return Fail.NETWORK;
}

/**
 * Should this failure escalate to the next transport tier, or is it terminal?
 * Retrying a 404 at a higher tier just wastes time; a 403 is exactly what the
 * header-injection tier exists to solve.
 */
export function shouldEscalate(code) {
    return [
        Fail.HTTP_401, Fail.HTTP_403, Fail.NETWORK, Fail.TIMEOUT,
        Fail.WRONG_MAGIC, Fail.HTML_RESPONSE, Fail.ZERO_BYTES,
        Fail.IMPLAUSIBLE_SIZE, Fail.REDIRECTED_AWAY, Fail.MIME_MISMATCH,
        Fail.DOWNLOAD_INTERRUPTED,
    ].includes(code);
}
