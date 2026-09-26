/**
 * Selection store with anchor/lead semantics.
 *
 * Two v1 behaviours this exists to kill:
 *  - selection lived in popup memory and was destroyed on modal close, so any
 *    outside click vaporised ten minutes of triage;
 *  - applyPerceptualDedup called selectedImageUrls.delete() on every image it
 *    hid (popup.js:931), so picks you made five seconds ago silently vanished
 *    when a hash batch landed.
 *
 * Nothing here ever removes a selection except at the user's request. Ranges are
 * computed in VIEW order, so shift-select stays correct after a sort change.
 */

export class Selection {
    constructor(onChange) {
        this.selected = new Set();
        this.anchor = null;
        this.lead = null;
        this.onChange = onChange || (() => {});
    }

    get size() { return this.selected.size; }
    has(id) { return this.selected.has(id); }
    ids() { return [...this.selected]; }

    _changed() { this.onChange(this); }

    clear() {
        if (!this.selected.size) return;
        this.selected.clear();
        this._changed();
    }

    /** Plain click — replace the selection. */
    set(id) {
        this.selected.clear();
        this.selected.add(id);
        this.anchor = id;
        this.lead = id;
        this._changed();
    }

    /** Ctrl/Cmd click — toggle one, move the anchor to it. */
    toggle(id) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
        this.anchor = id;
        this.lead = id;
        this._changed();
    }

    /**
     * Shift click — range from anchor to id, in the order currently displayed.
     * v1 computed ranges against insertion order, so after any sort the range
     * selected a surprising set.
     */
    range(id, viewIds, additive = false) {
        if (!this.anchor) return this.set(id);
        const a = viewIds.indexOf(this.anchor);
        const b = viewIds.indexOf(id);
        if (a === -1 || b === -1) return this.set(id);

        if (!additive) this.selected.clear();
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) this.selected.add(viewIds[i]);
        this.lead = id;
        this._changed();
    }

    add(ids) {
        let n = 0;
        for (const id of ids) if (!this.selected.has(id)) { this.selected.add(id); n++; }
        if (n) this._changed();
    }

    remove(ids) {
        let n = 0;
        for (const id of ids) if (this.selected.delete(id)) n++;
        if (n) this._changed();
    }

    /** Select all of what is CURRENTLY FILTERED, not everything known. */
    selectAll(viewIds) {
        for (const id of viewIds) this.selected.add(id);
        this._changed();
    }

    invert(viewIds) {
        for (const id of viewIds) {
            if (this.selected.has(id)) this.selected.delete(id);
            else this.selected.add(id);
        }
        this._changed();
    }

    /**
     * Drop ids that no longer exist at all (e.g. the tab was closed).
     * Deliberately NOT called when filters change — selection is filter-stable,
     * so narrow -> pick -> widen -> pick works.
     */
    reconcile(knownIds) {
        const known = new Set(knownIds);
        let n = 0;
        for (const id of [...this.selected]) if (!known.has(id)) { this.selected.delete(id); n++; }
        if (n) this._changed();
    }
}

/**
 * Rubber-band marquee. Hit-tests arithmetically against the grid's layout array,
 * so it works over virtualized content where most tiles have no DOM node.
 */
export function attachMarquee(layerEl, grid, selection, getViewIds) {
    let start = null;
    let box = null;
    let mode = 'replace';

    const THRESHOLD = 4;   // don't start a band on a click

    layerEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.tile')) return;       // dragging a tile isn't a marquee
        start = { x: e.offsetX, y: e.offsetY };
        mode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        layerEl.setPointerCapture(e.pointerId);
    });

    layerEl.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = Math.abs(e.offsetX - start.x);
        const dy = Math.abs(e.offsetY - start.y);
        if (!box && dx < THRESHOLD && dy < THRESHOLD) return;

        if (!box) {
            box = document.createElement('div');
            box.className = 'marquee';
            layerEl.appendChild(box);
        }
        const r = {
            x: Math.min(start.x, e.offsetX),
            y: Math.min(start.y, e.offsetY),
            w: Math.abs(e.offsetX - start.x),
            h: Math.abs(e.offsetY - start.y),
        };
        Object.assign(box.style, {
            left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px',
        });
        box._rect = r;
    });

    const finish = (e) => {
        if (!start) return;
        if (box) {
            const viewIds = getViewIds();
            const hit = grid.indicesIn(box._rect || { x: 0, y: 0, w: 0, h: 0 })
                .map((i) => viewIds[i])
                .filter(Boolean);
            if (mode === 'replace') { selection.clear(); selection.add(hit); }
            else if (mode === 'add') selection.add(hit);
            else selection.remove(hit);
            box.remove();
            box = null;
        }
        start = null;
        try { layerEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    layerEl.addEventListener('pointerup', finish);
    layerEl.addEventListener('pointercancel', finish);
}

/** Hamming distance between two 16-hex-char dHashes. */
export function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { d += x & 1; x >>= 1; }
    }
    return d;
}

/**
 * Group near-duplicates into stacks. Returns Map<representativeId, memberIds[]>.
 *
 * Nothing is hidden and nothing is deselected — v1 filtered duplicates out of
 * existence and mutated your selection to match. A stack is a display decision,
 * fully reversible, and the representative is chosen by an explicit, visible
 * quality score rather than by whichever arrived first.
 */
export function cluster(items, threshold = 8) {
    const withHash = items.filter((i) => i.pHash);
    const used = new Set();
    const stacks = new Map();

    for (const a of withHash) {
        if (used.has(a.id)) continue;
        const members = [a];
        used.add(a.id);
        for (const b of withHash) {
            if (used.has(b.id)) continue;
            if (hamming(a.pHash, b.pHash) <= threshold) { members.push(b); used.add(b.id); }
        }
        // Quality score: pixels first, then bytes-per-pixel as a compression proxy.
        members.sort((x, y) => {
            const px = (x.width || 0) * (x.height || 0);
            const py = (y.width || 0) * (y.height || 0);
            if (py !== px) return py - px;
            return (y.bytes || 0) - (x.bytes || 0);
        });
        stacks.set(members[0].id, members.map((m) => m.id));
    }

    for (const i of items) if (!i.pHash) stacks.set(i.id, [i.id]);
    return stacks;
}
