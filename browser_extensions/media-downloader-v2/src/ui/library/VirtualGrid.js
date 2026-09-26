/**
 * Windowed grid with node pooling and stable identity.
 *
 * The single worst thing about v1's grid was structural: renderImageList()
 * rebuilt every tile with one innerHTML assignment (popup.js:1127-1152) and it
 * fired on filter change, sort change, select-all, deselect-all, dedupe
 * completion, and every tick of the min-size slider's input event. Dragging that
 * slider across 200 images destroyed and recreated 200 <img> elements dozens of
 * times per second, and each rebuild restarted the thumbnail fetch loop.
 *
 * Here the item list is a pure data transform (filter -> sort -> group) producing
 * an array of ids. The renderer diffs the visible window against a pool of
 * mounted nodes and mutates only what entered, left or moved. Filtering costs a
 * reposition of ~40 nodes and zero network. Keyboard focus survives, because
 * nothing is destroyed.
 */

export class VirtualGrid {
    /**
     * @param {HTMLElement} container scrollable viewport
     * @param {{renderTile: Function, updateTile: Function, onActivate?: Function}} hooks
     */
    constructor(container, hooks) {
        this.container = container;
        this.hooks = hooks;
        this.ids = [];
        this.data = new Map();          // id -> item
        this.pool = new Map();          // id -> element
        this.cols = 1;
        this.rowH = 200;
        this.tile = 168;
        this.gap = 8;
        this.overscanRows = 2;

        this.spacer = document.createElement('div');
        this.spacer.className = 'vg-spacer';
        this.layer = document.createElement('div');
        this.layer.className = 'vg-layer';
        container.appendChild(this.spacer);
        container.appendChild(this.layer);

        this._onScroll = () => this.render();
        container.addEventListener('scroll', this._onScroll, { passive: true });

        this._ro = new ResizeObserver(() => this.measure());
        this._ro.observe(container);

        this.measure();
    }

    destroy() {
        this.container.removeEventListener('scroll', this._onScroll);
        this._ro.disconnect();
    }

    setDensity(tilePx) {
        this.tile = tilePx;
        this.measure();
    }

    measure() {
        const w = this.container.clientWidth || 800;
        const cs = getComputedStyle(this.container);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const avail = Math.max(100, w - padL - padR);

        // Derived from the layout, not reverse-engineered by measuring a card's
        // width like v1 did (popup.js:1435-1438), which broke the moment cards varied.
        this.cols = Math.max(1, Math.floor((avail + this.gap) / (this.tile + this.gap)));
        this.cellW = Math.floor((avail - this.gap * (this.cols - 1)) / this.cols);
        this.rowH = Math.round(this.cellW * 0.82) + 34;   // image box + meta strip
        this.render(true);
    }

    /**
     * Replace the visible set. `ids` is already filtered, sorted and grouped.
     * Items keep their identity, so selection and focus are unaffected.
     */
    setItems(ids, dataMap) {
        this.ids = ids;
        this.data = dataMap;
        const rows = Math.ceil(ids.length / this.cols);
        this.spacer.style.height = Math.max(0, rows * this.rowH) + 'px';
        this.render(true);
    }

    /** Patch one item in place — a thumbnail arriving must NOT trigger a re-render. */
    patch(id, item) {
        this.data.set(id, item);
        const el = this.pool.get(id);
        if (el) this.hooks.updateTile(el, item);
    }

    indexOf(id) {
        return this.ids.indexOf(id);
    }

    /**
     * Ids in (or near) the current window. Thumbnail generation is a real network
     * fetch per image, so it must follow the viewport — requesting them for every
     * item in the list would pull hundreds of full-size originals on a big gallery,
     * which is the v1 failure mode in a new costume.
     */
    visibleIds(margin = 24) {
        const a = Math.max(0, (this._first ?? 0) - margin);
        const b = Math.min(this.ids.length, (this._last ?? this.ids.length) + margin);
        return this.ids.slice(a, b);
    }

    scrollToIndex(i) {
        const row = Math.floor(i / this.cols);
        const y = row * this.rowH;
        const top = this.container.scrollTop;
        const h = this.container.clientHeight;
        if (y < top) this.container.scrollTop = y;
        else if (y + this.rowH > top + h) this.container.scrollTop = y + this.rowH - h;
    }

    render(force = false) {
        const scrollTop = this.container.scrollTop;
        const h = this.container.clientHeight || 600;

        const firstRow = Math.max(0, Math.floor(scrollTop / this.rowH) - this.overscanRows);
        const lastRow = Math.ceil((scrollTop + h) / this.rowH) + this.overscanRows;
        const first = firstRow * this.cols;
        const last = Math.min(this.ids.length, lastRow * this.cols);

        if (!force && first === this._first && last === this._last) return;
        this._first = first;
        this._last = last;

        const wanted = new Set();
        for (let i = first; i < last; i++) wanted.add(this.ids[i]);

        // Recycle anything that scrolled out.
        for (const [id, el] of this.pool) {
            if (!wanted.has(id)) { el.remove(); this.pool.delete(id); }
        }

        for (let i = first; i < last; i++) {
            const id = this.ids[i];
            const item = this.data.get(id);
            if (!item) continue;

            let el = this.pool.get(id);
            if (!el) {
                el = this.hooks.renderTile(item);
                el.dataset.id = id;
                el.style.position = 'absolute';
                el.style.width = this.cellW + 'px';
                this.layer.appendChild(el);
                this.pool.set(id, el);
            } else {
                this.hooks.updateTile(el, item);
                el.style.width = this.cellW + 'px';
            }

            const col = i % this.cols;
            const row = Math.floor(i / this.cols);
            el.style.transform =
                `translate(${col * (this.cellW + this.gap)}px, ${row * this.rowH}px)`;
            el.style.height = (this.rowH - this.gap) + 'px';
            el.dataset.index = String(i);
        }
    }

    /** Layout rectangles for marquee hit-testing — arithmetic, not elementFromPoint. */
    rectFor(i) {
        const col = i % this.cols;
        const row = Math.floor(i / this.cols);
        return {
            x: col * (this.cellW + this.gap),
            y: row * this.rowH,
            w: this.cellW,
            h: this.rowH - this.gap,
        };
    }

    /** Every index intersecting a rect in layer coordinates. O(visible-ish). */
    indicesIn(rect) {
        const out = [];
        const firstRow = Math.max(0, Math.floor(rect.y / this.rowH));
        const lastRow = Math.min(
            Math.ceil((rect.y + rect.h) / this.rowH),
            Math.ceil(this.ids.length / this.cols)
        );
        for (let row = firstRow; row < lastRow; row++) {
            for (let col = 0; col < this.cols; col++) {
                const i = row * this.cols + col;
                if (i >= this.ids.length) break;
                const r = this.rectFor(i);
                if (r.x < rect.x + rect.w && r.x + r.w > rect.x &&
                    r.y < rect.y + rect.h && r.y + r.h > rect.y) out.push(i);
            }
        }
        return out;
    }
}
