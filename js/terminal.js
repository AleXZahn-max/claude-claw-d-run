/**
 * Claude Claw'd Run — Terminal Renderer
 *
 * A character-cell display. Everything the game draws goes into a grid of
 * glyphs, each with a palette key and an alpha; once per frame the grid is
 * rasterised to canvas and passed through a CRT composite (bloom, scanlines,
 * vignette, flash, glitch).
 *
 * Nothing here knows about the game. It knows about cells.
 */

class Terminal {
    constructor(canvas, { cols, rows, cellW, cellH }) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        this.cols = cols;
        this.rows = rows;
        this.cellW = cellW;
        this.cellH = cellH;
        this.w = cols * cellW;
        this.h = rows * cellH;

        // Cell buffers, flat and reused. One entry per cell, row-major.
        this.n = cols * rows;
        this.ch = new Array(this.n).fill(' ');
        this.col = new Array(this.n).fill('fg');
        this.al = new Float32Array(this.n).fill(1);

        // Glyph layer, then a small copy of it used as the bloom source.
        this.glyph = document.createElement('canvas');
        this.gctx = this.glyph.getContext('2d');
        this.bloomScale = 0.34;
        this.bloom = document.createElement('canvas');
        this.bctx = this.bloom.getContext('2d');

        this.palette = GLYPHS.PALETTES.dark;

        /**
         * An optional palette-key → palette-key remap, consulted on every write.
         * Skins ride on this: the crab sprites still ask for `claw`, and a skin
         * says `claw → phosphorBase`. Because it is a key map rather than a hex
         * override, a skinned crab still swaps correctly when the theme changes.
         * Set it around a draw call and clear it after.
         */
        this.recolor = null;

        this.fontFamily = `'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace`;
        this.fontSize = cellW / 0.6; // refined against real metrics in measureFont()

        // Post effects, driven by the game each frame.
        this.shakeX = 0;
        this.shakeY = 0;
        this.flash = 0;        // 0..1 white-out
        this.flashColor = 'white';
        this.glitch = 0;       // 0..1 chromatic tear
        this.bloomAmount = 0.34;
        this.effects = true;
        this.scanlines = true;

        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.resize();
    }

    /* ------------------------------------------------------------------ *
     * Setup
     * ------------------------------------------------------------------ */

    resize() {
        const dpr = this.dpr;
        for (const [cv, cx] of [[this.canvas, this.ctx], [this.glyph, this.gctx]]) {
            cv.width = Math.round(this.w * dpr);
            cv.height = Math.round(this.h * dpr);
            cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        this.bloom.width = Math.max(1, Math.round(this.w * this.bloomScale));
        this.bloom.height = Math.max(1, Math.round(this.h * this.bloomScale));

        this.measureFont();
        this.buildScanlines();
        this.buildVignette();
    }

    /**
     * Pick a font size whose advance width matches the cell width, so a glyph
     * lands dead centre in its cell regardless of which fallback font loaded.
     */
    measureFont() {
        const g = this.gctx;
        g.font = `${this.fontSize}px ${this.fontFamily}`;
        const advance = g.measureText('M').width;
        if (advance > 0) {
            this.fontSize = this.fontSize * (this.cellW / advance);
        }
        this.fontSpec = `${this.fontSize.toFixed(2)}px ${this.fontFamily}`;
        g.font = this.fontSpec;
        this.padX = (this.cellW - g.measureText('M').width) / 2;
    }

    setPalette(palette) {
        this.palette = palette;
    }

    /* ------------------------------------------------------------------ *
     * Writing to the grid
     * ------------------------------------------------------------------ */

    clear() {
        this.ch.fill(' ');
        this.al.fill(1);
    }

    put(x, y, ch, color = 'fg', alpha = 1) {
        x |= 0; y |= 0;
        if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
        const i = y * this.cols + x;
        this.ch[i] = ch;
        this.col[i] = this.recolor ? (this.recolor[color] || color) : color;
        this.al[i] = alpha;
    }

    /** Runs `fn` with a skin's key remap active, and always takes it back off. */
    skinned(map, fn) {
        const prev = this.recolor;
        this.recolor = map;
        try { fn(); } finally { this.recolor = prev; }
    }

    /** Reads back a cell's glyph. Used by effects that chew on what's already drawn. */
    peek(x, y) {
        if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return ' ';
        return this.ch[y * this.cols + x];
    }

    /** Fades everything already in the buffer, so a panel can sit on top of it. */
    dimAll(factor) {
        for (let i = 0; i < this.n; i++) this.al[i] *= factor;
    }

    text(x, y, str, color = 'fg', alpha = 1) {
        for (let i = 0; i < str.length; i++) {
            if (str[i] !== ' ') this.put(x + i, y, str[i], color, alpha);
        }
    }

    /** Writes a string with its spaces intact, punching holes in whatever is beneath. */
    textOpaque(x, y, str, color = 'fg', alpha = 1) {
        for (let i = 0; i < str.length; i++) this.put(x + i, y, str[i], color, alpha);
    }

    centered(y, str, color = 'fg', alpha = 1) {
        this.text(Math.round((this.cols - str.length) / 2), y, str, color, alpha);
    }

    /** Blanks a region so text laid over the world has somewhere to sit. */
    clearRect(x, y, w, h) {
        for (let ry = 0; ry < h; ry++) {
            for (let rx = 0; rx < w; rx++) this.put(x + rx, y + ry, ' ', 'fg', 1);
        }
    }

    /**
     * Centred text with a one-cell margin punched out around it. Parallax stars
     * drifting through the middle of a headline is the single fastest way to make
     * a text UI look accidental, and every readable line here gets this instead.
     */
    centeredHalo(y, str, color = 'fg', alpha = 1) {
        const x = Math.round((this.cols - str.length) / 2);
        this.clearRect(x - 2, y, str.length + 4, 1);
        this.text(x, y, str, color, alpha);
    }

    /** Clears whole rows. Used to give a title block its own quiet air. */
    band(y, h = 1) {
        this.clearRect(0, y, this.cols, h);
    }

    /** Right-aligned text, so a column of numbers lines up on its last digit. */
    textRight(x, y, str, color = 'fg', alpha = 1) {
        this.text(x - str.length + 1, y, str, color, alpha);
    }

    /**
     * Draws a sprite. `mask` characters select a palette key per cell; anything
     * unmasked takes the sprite's tint, or `tint` if the caller overrides it.
     * `clipAbove` keeps a sprite from spilling into the HUD.
     *
     * `solid` makes the sprite opaque: the columns its ink occupies are blanked
     * on every row it draws, so nothing behind shows through the gaps. See the
     * `sprite()` factory for why the gaps are there in the first place.
     */
    blit(s, x, y, { tint, alpha = 1, clipAbove = -Infinity, solid = false } = {}) {
        const base = tint || s.tint;
        const span = solid && s.span ? s.span : null;
        for (let ry = 0; ry < s.h; ry++) {
            const ty = y + ry;
            if (ty < clipAbove || ty < 0 || ty >= this.rows) continue;
            const row = s.rows[ry];
            const mrow = s.mask ? s.mask[ry] : null;
            if (span) {
                for (let rx = span[0]; rx <= span[1]; rx++) this.put(x + rx, ty, ' ', 'fg', 1);
            }
            for (let rx = 0; rx < s.w; rx++) {
                const c = row[rx];
                if (c === ' ') continue;
                let key = base;
                if (mrow) {
                    const m = mrow[rx];
                    if (m !== ' ') key = GLYPHS.PAINT[m] || base;
                }
                this.put(x + rx, ty, c, key, alpha);
            }
        }
    }

    hline(x, y, len, ch = '─', color = 'fg', alpha = 1) {
        for (let i = 0; i < len; i++) this.put(x + i, y, ch, color, alpha);
    }

    vline(x, y, len, ch = '│', color = 'fg', alpha = 1) {
        for (let i = 0; i < len; i++) this.put(x, y + i, ch, color, alpha);
    }

    fillRect(x, y, w, h, ch = ' ', color = 'fg', alpha = 1) {
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) this.put(x + i, y + j, ch, color, alpha);
        }
    }

    /**
     * A panel. Panels are how this game shows menus — there is no HTML on top
     * of the play area, so a dialog is box-drawing characters like anything else.
     */
    box(x, y, w, h, { style = 'round', color = 'fg', alpha = 1, fill = true, title = null, titleColor = null } = {}) {
        const b = GLYPHS.BOX[style] || GLYPHS.BOX.round;
        if (fill) this.fillRect(x, y, w, h, ' ', color, alpha);

        this.hline(x + 1, y, w - 2, b.h, color, alpha);
        this.hline(x + 1, y + h - 1, w - 2, b.h, color, alpha);
        this.vline(x, y + 1, h - 2, b.v, color, alpha);
        this.vline(x + w - 1, y + 1, h - 2, b.v, color, alpha);
        this.put(x, y, b.tl, color, alpha);
        this.put(x + w - 1, y, b.tr, color, alpha);
        this.put(x, y + h - 1, b.bl, color, alpha);
        this.put(x + w - 1, y + h - 1, b.br, color, alpha);

        if (title) {
            const label = ` ${title} `;
            const tx = x + Math.round((w - label.length) / 2);
            this.textOpaque(tx, y, label, titleColor || color, alpha);
        }
    }

    /** A horizontal bar meter, drawn with block fills. */
    meter(x, y, width, ratio, { color = 'fg', emptyColor = 'dimmer', alpha = 1 } = {}) {
        const M = GLYPHS.METER;
        const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
        for (let i = 0; i < width; i++) {
            const on = i < filled;
            this.put(x + i, y, on ? M.full : M.light, on ? color : emptyColor, alpha);
        }
    }

    /* ------------------------------------------------------------------ *
     * Rasterise + composite
     * ------------------------------------------------------------------ */

    buildScanlines() {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 3;
        const x = c.getContext('2d');
        x.fillStyle = 'rgba(0,0,0,0.22)';
        x.fillRect(0, 2, 1, 1);
        this.scanPattern = this.ctx.createPattern(c, 'repeat');
    }

    buildVignette() {
        const g = this.ctx.createRadialGradient(
            this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.28,
            this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.72,
        );
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.55)');
        this.vignette = g;
    }

    /** Rasterises the cell buffer into the glyph layer. */
    drawGlyphs() {
        const g = this.gctx;
        g.clearRect(0, 0, this.w, this.h);
        g.font = this.fontSpec;
        g.textBaseline = 'middle';
        g.textAlign = 'left';

        // Adjacent cells usually share a colour, so tracking the last style
        // keeps state changes to a few dozen per frame instead of a few thousand.
        let lastStyle = null;
        let lastAlpha = -1;
        const half = this.cellH / 2;

        for (let y = 0; y < this.rows; y++) {
            const py = y * this.cellH + half;
            const rowStart = y * this.cols;
            for (let x = 0; x < this.cols; x++) {
                const i = rowStart + x;
                const c = this.ch[i];
                if (c === ' ') continue;
                const style = this.palette[this.col[i]] || this.palette.fg;
                const a = this.al[i];
                if (style !== lastStyle) { g.fillStyle = style; lastStyle = style; }
                if (a !== lastAlpha) { g.globalAlpha = a; lastAlpha = a; }
                g.fillText(c, x * this.cellW + this.padX, py);
            }
        }
        g.globalAlpha = 1;
    }

    render(time = 0) {
        this.drawGlyphs();

        const ctx = this.ctx;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;

        ctx.fillStyle = this.palette.bg;
        ctx.fillRect(0, 0, this.w, this.h);

        ctx.save();
        ctx.translate(this.shakeX, this.shakeY);

        if (this.glitch > 0.01) {
            // Split the channels apart. The world is corrupting, so say so.
            const off = this.glitch * 6;
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.55;
            ctx.drawImage(this.glyph, -off, 0, this.w, this.h);
            ctx.drawImage(this.glyph, off, this.glitch * 2, this.w, this.h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.drawImage(this.glyph, 0, 0, this.w, this.h);

        if (this.effects && this.bloomAmount > 0) {
            // Bloom on the cheap: downscale, then let bilinear upscaling blur it.
            const bw = this.bloom.width;
            const bh = this.bloom.height;
            this.bctx.clearRect(0, 0, bw, bh);
            this.bctx.drawImage(this.glyph, 0, 0, bw, bh);

            const flicker = 1 + Math.sin(time * 0.021) * 0.06 + Math.sin(time * 0.113) * 0.03;
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.min(1, this.bloomAmount * flicker);
            ctx.drawImage(this.bloom, 0, 0, bw, bh, 0, 0, this.w, this.h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();

        if (this.scanlines && this.scanPattern) {
            ctx.fillStyle = this.scanPattern;
            ctx.fillRect(0, 0, this.w, this.h);
        }

        if (this.effects) {
            ctx.fillStyle = this.vignette;
            ctx.fillRect(0, 0, this.w, this.h);
        }

        if (this.flash > 0.01) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.min(1, this.flash);
            ctx.fillStyle = this.palette[this.flashColor] || '#FFFFFF';
            ctx.fillRect(0, 0, this.w, this.h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }
    }
}

window.Terminal = Terminal;
