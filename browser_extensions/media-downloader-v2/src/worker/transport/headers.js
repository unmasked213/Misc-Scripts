/**
 * Referer/Origin injection via declarativeNetRequest SESSION rules.
 *
 * v1 had a genuinely nasty bug here. Rule IDs came from an in-memory counter
 * (`let activeRefererRuleId = 1000`, background.js:577) but were written into
 * *persistent dynamic* rules. The teardown was a 5-second setTimeout that ran on
 * a service worker Chrome is free to kill at any moment. So: worker dies before
 * teardown -> rule leaks permanently -> worker restarts -> counter resets to 1000
 * -> updateDynamicRules throws "rule with id 1000 already exists" -> the whole
 * download is skipped before chrome.downloads.download is ever reached.
 *
 * Three changes fix it for good:
 *   - SESSION rules, which Chrome clears on browser restart by construction.
 *   - IDs seeded from getSessionRules() at startup, so a restart never collides.
 *   - Teardown in a finally block, plus a sweep of anything we orphaned.
 *
 * v2.1 — the rule could never match. v2.0 conditioned on `tabIds: [rec.tabId]`,
 * but the requests this rule exists for (chrome.downloads and the offscreen
 * document's fetch) do not originate from a tab: their tabId is TAB_ID_NONE (-1).
 * The condition excluded exactly the requests it was meant to affect. It now
 * matches requests with no tab, anchored to the media URL. And because fetch()
 * silently drops Referer and Origin (forbidden header names), this rule is the
 * ONLY mechanism that can set them — so Tier 2 is wrapped in it as well.
 *
 * Still unverified against official docs (spikes S3/S4): no denylist is
 * published for `set`/`remove`, and no page says whether DNR applies to
 * chrome.downloads-initiated requests. `node test.mjs` covers the rule shape;
 * chrome://net-export is the runtime test.
 */

import { log } from '../../shared/log.js';

const MIN_ID = 9000;
const MAX_SESSION_RULES = 4000;   // Chrome's cap is 5000; leave headroom.

/** Everything a download or an extension fetch might be typed as. DNR excludes main_frame by default. */
const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'other', 'image', 'object', 'ping'];

let nextId = MIN_ID;
let seeded = false;

function tabIdNone() {
    try { return chrome.tabs.TAB_ID_NONE; } catch { return -1; }
}

/**
 * Build the rule. Pure, so it can be unit-tested.
 *
 * @param {number} id
 * @param {{url: string, pageUrl: string, broad?: boolean}} ctx
 *   broad=true drops the URL anchor: used for stream jobs, whose segment URLs
 *   are unknown when the rule is installed and often live on another host. It
 *   is still scoped to requests with no tab, i.e. our own.
 * @returns {object|null} null when there is nothing valid to spoof with
 */
export function buildRefererRule(id, { url, pageUrl, broad = false }, tabNone = -1) {
    let origin;
    let urlFilter = null;
    try {
        origin = new URL(pageUrl).origin;
        if (!broad) {
            const u = new URL(url);
            urlFilter = `|${u.origin}${u.pathname}`;   // anchored, ignores query churn
        }
    } catch {
        return null;
    }

    return {
        id,
        priority: 2,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [
                { header: 'Referer', operation: 'set', value: pageUrl },
                { header: 'Origin', operation: 'set', value: origin },
            ],
        },
        condition: {
            ...(urlFilter ? { urlFilter } : {}),
            resourceTypes: RESOURCE_TYPES,
            // Requests from chrome.downloads and from the offscreen document have
            // no tab. Page-driven requests never match, which is what we want.
            tabIds: [tabNone],
        },
    };
}

async function seed() {
    if (seeded) return;
    try {
        const existing = await chrome.declarativeNetRequest.getSessionRules();
        const ours = existing.filter((r) => r.id >= MIN_ID);
        nextId = ours.length ? Math.max(...ours.map((r) => r.id)) + 1 : MIN_ID;
        if (nextId > MIN_ID + MAX_SESSION_RULES) {
            // We've wrapped; clear our range and start over rather than exhaust the quota.
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: ours.map((r) => r.id),
            });
            nextId = MIN_ID;
        }
        log('headers', `seeded rule ids from ${nextId}`);
    } catch (e) {
        log('headers', 'seed failed', e?.message);
        nextId = MIN_ID;
    }
    seeded = true;
}

/**
 * Install a temporary Referer+Origin rule scoped as tightly as we can manage,
 * run `fn`, then always tear the rule down.
 *
 * @param {{url: string, pageUrl: string, broad?: boolean}} ctx
 * @param {() => Promise<any>} fn
 */
export async function withRefererRule(ctx, fn) {
    if (!ctx?.pageUrl) return fn();     // nothing to spoof with

    await seed();
    const id = nextId++;
    const rule = buildRefererRule(id, ctx, tabIdNone());
    if (!rule) return fn();

    try {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule], removeRuleIds: [id] });
        log('headers', `rule ${id} -> Referer ${ctx.pageUrl}${ctx.broad ? ' (broad)' : ''}`);
    } catch (e) {
        log('headers', `rule ${id} failed, continuing without`, e?.message);
        return fn();
    }

    try {
        return await fn();
    } finally {
        // Always, even if fn threw or the worker is about to be killed.
        try {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
        } catch { /* best effort */ }
    }
}

/** Remove every rule we own. Called on startup to clear anything orphaned. */
export async function sweep() {
    try {
        const existing = await chrome.declarativeNetRequest.getSessionRules();
        const ids = existing.filter((r) => r.id >= MIN_ID).map((r) => r.id);
        if (ids.length) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
            log('headers', `swept ${ids.length} orphaned rules`);
        }
    } catch { /* best effort */ }
    seeded = false;
    nextId = MIN_ID;
}
