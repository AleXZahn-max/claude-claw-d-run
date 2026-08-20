/**
 * Claude Claw'd Run — Entities
 *
 * Everything here lives in grid space: positions are columns and rows, and
 * velocities are cells per logical step (the engine runs a fixed 60Hz step).
 * Nothing measures itself in pixels, which is what makes the whole game snap
 * to the character cell.
 */

/** Board geometry. The hero stands with his legs on STAND, the line is GROUND. */
const GEO = {
    cols: 112,
    rows: 28,
    hudRow: 0,
    meterRow: 1,
    skyTop: 2,
    standRow: 22,   // hero legs, obstacle bases
    groundRow: 23,  // the ground line itself
    statusRow: 27,  // bottom statusline; terrain fills the rows between
    heroX: 8,
    flyerBase: 19,  // flyer bottom row: hits a standing hero, misses a ducking one
};

/*
 * A full jump peaks ~11 rows up over ~1.04s.
 *
 * Height and duration are separate knobs here, and duration is the one that
 * decides fairness. Apex height only has to clear the tallest hazard; what
 * decides whether a *wide* hazard is passable is how long the hero stays above
 * its top row, because the world scrolls underneath him the whole time. Low
 * gravity with a matching low launch velocity keeps the same apex — the same
 * silhouette on screen — while nearly doubling that window. `fastDrop` is what
 * keeps a floaty arc from feeling unresponsive: ducking mid-air cuts it short.
 */
const PHYS = {
    gravity: 0.022,
    jumpV: -0.686,
    shortJumpV: -0.45, // applied when the key is released before apex
    fastDrop: 3.4,     // gravity multiplier while ducking mid-air
    coyote: 6,         // steps of grace after leaving the ground
    buffer: 8,         // steps a jump press stays queued before landing
};

/* ================================================================== *
 * Claw'd
 * ================================================================== */

class Clawd {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = GEO.heroX;
        this.y = GEO.standRow;   // row of the bottom-most sprite row
        this.vy = 0;
        this.grounded = true;
        this.ducking = false;
        this.dead = false;

        this.distance = 0;       // cells travelled, drives the gait
        this.airSteps = 0;
        this.landSteps = 0;
        this.coyote = 0;
        this.buffered = 0;
        this.jumpHeld = false;

        this.face = 'normal';
        this.faceHold = 0;       // steps left on a temporary expression
        this.blinkIn = 140;
        this.clawSnap = 0;
        this.snapIn = 90;
        this.thinking = false;
    }

    /* ---------------- input ---------------- */

    requestJump(sound) {
        if (this.dead) return false;
        if (this.grounded || this.coyote > 0) {
            this.vy = PHYS.jumpV;
            this.grounded = false;
            this.coyote = 0;
            this.airSteps = 0;
            this.jumpHeld = true;
            this.ducking = false;
            this.setFace('wide', 22);
            if (sound) sound.playJump();
            return true;
        }
        this.buffered = PHYS.buffer;
        return false;
    }

    releaseJump() {
        this.jumpHeld = false;
        // Cutting the jump short: clamp upward speed instead of killing it, so
        // a tap still arcs rather than stopping dead in the air.
        if (!this.grounded && this.vy < PHYS.shortJumpV) this.vy = PHYS.shortJumpV;
    }

    setDucking(on) {
        if (this.dead) return;
        this.ducking = on;
    }

    setFace(name, steps) {
        this.face = name;
        this.faceHold = steps;
    }

    kill() {
        this.dead = true;
        this.ducking = false;
        this.vy = 0;
        this.setFace('dead', Infinity);
    }

    /* ---------------- simulation ---------------- */

    /**
     * `speed` is world cells per step; `dt` is the time dilation factor shared
     * with the world. Gravity has to be dilated alongside the scenery — a hero
     * on 1× physics over a 0.42× world covers less than half the ground in one
     * jump, which quietly turns wide hazards into walls. Scaling both keeps the
     * arc identical in world space and simply hands the player more real
     * seconds to read it.
     */
    step(speed, dt = 1) {
        if (this.dead) return null;

        this.distance += speed;
        let landed = null;

        if (!this.grounded) {
            this.airSteps++;
            const g = PHYS.gravity * (this.ducking && this.vy > 0 ? PHYS.fastDrop : 1);
            this.vy += g * dt;
            this.y += this.vy * dt;

            if (this.y >= GEO.standRow) {
                landed = Math.abs(this.vy);
                this.y = GEO.standRow;
                this.vy = 0;
                this.grounded = true;
                this.landSteps = 5;
                if (this.face === 'wide') this.faceHold = 0;
            }
        } else {
            this.coyote = PHYS.coyote;
            if (this.landSteps > 0) this.landSteps--;
        }

        if (this.coyote > 0 && !this.grounded) this.coyote--;
        if (this.buffered > 0) {
            this.buffered--;
            if (this.grounded) {
                this.buffered = 0;
                this.requestJump(window.soundController);
            }
        }

        // Expression bookkeeping. Blinks and claw snaps are the whole reason
        // he reads as alive while standing still.
        if (this.faceHold > 0) {
            this.faceHold--;
            if (this.faceHold === 0) this.face = 'normal';
        }
        if (this.thinking) {
            this.face = 'think';
            this.faceHold = 0;
        } else if (this.face === 'think') {
            this.face = 'normal';
        }

        if (this.faceHold === 0 && !this.thinking && this.grounded) {
            if (--this.blinkIn <= 0) {
                this.setFace('blink', 7);
                this.blinkIn = 120 + Math.floor(RNG.look.next() * 260);
            }
        }

        if (this.clawSnap > 0) this.clawSnap--;
        else if (--this.snapIn <= 0) {
            this.clawSnap = 8;
            this.snapIn = 70 + Math.floor(RNG.look.next() * 130);
        }

        return landed;
    }

    /* ---------------- presentation ---------------- */

    get pose() {
        if (this.dead) return 'dead';
        if (!this.grounded) return this.vy < -0.05 ? 'jump' : 'fall';
        if (this.ducking) return 'duck';
        if (this.landSteps > 0) return 'land';
        return 'run';
    }

    /**
     * Integer cell box used for collision: [left, top, right, bottom] inclusive.
     * Deliberately narrower than the silhouette — the claws and the shell rim
     * overhang, and clipping them should not end a run.
     */
    get hitbox() {
        const x = Math.round(this.x);
        const y = Math.round(this.y);
        if (this.pose === 'duck') {
            // Flattened: the box gives up its top rows, which is exactly what
            // makes ducking under a drone possible.
            return [x + 5, y - 2, x + 13, y];
        }
        return [x + 5, y - 4, x + 10, y];
    }

    draw(term, tick) {
        const C = GLYPHS.CLAWD;
        const pose = this.pose;
        const x = Math.round(this.x);
        const y = Math.round(this.y);

        // Claw'd is a solid object: `solid` blanks the columns his shell occupies
        // before each layer lands, so a ground strut or a star cannot end up
        // inside the carapace. The eyes and mouth that follow are overlays and go
        // on top of it, unaffected.
        const opts = { clipAbove: GEO.skyTop, solid: true };

        if (pose === 'dead') {
            term.blit(C.dead, x, y - C.dead.h + 1, opts);
            return;
        }

        let body, eyeAt, mouthAt;
        if (pose === 'duck') {
            body = C.duck;
            eyeAt = [[4, 2], [14, 2]];
            mouthAt = null;
        } else if (pose === 'jump') {
            body = C.jump;
            eyeAt = [[4, 2], [10, 2]];
            mouthAt = [4, 3];
        } else if (pose === 'fall' || pose === 'land') {
            body = C.fall;
            eyeAt = [[4, 2], [10, 2]];
            mouthAt = [4, 3];
        } else {
            body = C.body;
            eyeAt = [[4, 2], [10, 2]];
            mouthAt = [4, 3];
        }

        // Running is the one pose assembled from two sprites, so it is one row
        // taller than its body: the legs are a separate frame beneath it.
        const totalH = pose === 'run' ? body.h + 1 : body.h;
        const top = y - totalH + 1;
        const tint = this.thinking ? 'cyan' : undefined;
        term.blit(body, x, top, { ...opts, tint });

        if (pose === 'run') {
            // Gait steps with distance travelled, so he never moonwalks when
            // the world speeds up.
            const legs = C.legs[Math.floor(this.distance / 1.8) % C.legs.length];
            term.blit(legs, x, top + body.h, { ...opts, tint });
            if (this.clawSnap > 0) {
                term.blit(C.clawsShut, x, top, { clipAbove: GEO.skyTop, tint });
            }
        }

        const f = GLYPHS.CLAWD.faces[this.face] || GLYPHS.CLAWD.faces.normal;
        const eyeColor = this.thinking ? 'cyanHot' : f.eye;
        for (let i = 0; i < eyeAt.length; i++) {
            const [ex, ey] = eyeAt[i];
            term.put(x + ex, top + ey, f.eyes[i % f.eyes.length], eyeColor);
        }
        if (mouthAt) {
            const [mx, my] = mouthAt;
            for (let i = 0; i < f.mouth.length; i++) {
                term.put(x + mx + i, top + my, f.mouth[i], f.lip);
            }
        }

        // Bubbles while thinking — the tell that bullet time is live.
        if (this.thinking) {
            const b = ['·', '∘', '○'][Math.floor(tick / 8) % 3];
            term.put(x + 15, top - 1, b, 'cyan', 0.8);
            term.put(x + 17, top - 2, '·', 'cyanHot', 0.6);
        }
    }
}

/* ================================================================== *
 * Hazards
 *
 * One class for both kinds: a hazard is a sprite, a base row, and a rule about
 * whether you go over it or under it.
 * ================================================================== */

/*
 * `min` is the score a hazard unlocks at, and it is not a flavour decision: the
 * wider and taller a hazard, the more relative travel the hero needs to pass it,
 * and travel comes from world speed. Each gate below is the score at which the
 * jump window for that shape is worth about a third of a second. Unlocking them
 * any earlier makes them unfair rather than hard.
 */
const HAZARDS = {
    bug:         { art: () => GLYPHS.OBSTACLES.bug,         air: false, inset: 1, reason: 'UnhandledBug',  min: 0 },
    segfault:    { art: () => GLYPHS.OBSTACLES.segfault,    air: false, inset: 1, reason: 'Segfault',      min: 200 },
    rateLimit:   { art: () => GLYPHS.FLYERS.rateLimit,      air: true,  inset: 1, reason: 'RateLimited',   min: 350 },
    nullPtr:     { art: () => GLYPHS.OBSTACLES.nullPtr,     air: false, inset: 1, reason: 'NullPointer',   min: 550 },
    bugPair:     { art: () => GLYPHS.OBSTACLES.bugPair,     air: false, inset: 2, reason: 'UnhandledBug',  min: 700 },
    timeout:     { art: () => GLYPHS.FLYERS.timeout,        air: true,  inset: 1, reason: 'Timeout',       min: 900, drift: 0.09 },
    loop:        { art: null,                               air: false, inset: 1, reason: 'InfiniteLoop',  min: 1200 },
    conflict:    { art: () => GLYPHS.OBSTACLES.conflict,    air: false, inset: 2, reason: 'MergeConflict', min: 1600 },
    nodeModules: { art: () => GLYPHS.OBSTACLES.nodeModules, air: false, inset: 2, reason: 'DependencyHell', min: 2600 },
};

class Hazard {
    constructor(kind, x) {
        const def = HAZARDS[kind];
        this.kind = kind;
        this.def = def;
        this.x = x;
        this.animated = kind === 'loop';
        this.frame = 0;
        this.sprite = this.animated ? GLYPHS.LOOP_FRAMES[0] : def.art();
        this.bottom = def.air ? GEO.flyerBase : GEO.standRow;
        this.drift = def.drift || 0;
        this.passed = false;
        this.grazed = false;
        this.minGap = Infinity;
        this.bob = RNG.look.next() * Math.PI * 2;
    }

    step(speed, tick) {
        this.x -= speed * (1 + this.drift * 4);
        if (this.animated) {
            this.frame = Math.floor(tick / 5) % GLYPHS.LOOP_FRAMES.length;
            this.sprite = GLYPHS.LOOP_FRAMES[this.frame];
        }
        if (this.def.air) this.bob += 0.09;
    }

    /** Nominal top row. Collision uses this; the drawn position may bob. */
    get top() {
        return this.bottom - this.sprite.h + 1;
    }

    /**
     * [left, top, right, bottom] inclusive, inset for fairness.
     * The bob is deliberately left out: a drone that dipped its hitbox one row
     * would become impossible to duck under, at random.
     */
    get hitbox() {
        const x = Math.round(this.x);
        const i = this.def.inset;
        const t = this.top;
        return [x + i, t, x + this.sprite.w - 1 - i, t + this.sprite.h - 1];
    }

    get offscreen() {
        return this.x + this.sprite.w < -2;
    }

    draw(term) {
        const bob = this.def.air ? Math.round(Math.sin(this.bob) * 0.6) : 0;
        // Solid, like the hero: a bug is a thing in the world, not a stencil over
        // it. Without this the code-structure struts behind a `,--.` / `(x  x)`
        // came through its face as `(x│ x)`.
        term.blit(this.sprite, Math.round(this.x), this.top + bob,
                  { clipAbove: GEO.skyTop, solid: true });
    }
}

/* ================================================================== *
 * Context tokens
 * ================================================================== */

class Token {
    constructor(x, row) {
        this.x = x;
        this.row = row;
        this.taken = false;
        this.phase = RNG.look.next() * 4;
    }

    step(speed) {
        this.x -= speed;
        this.phase += 0.22;
    }

    get hitbox() {
        const x = Math.round(this.x);
        return [x, this.row, x + 2, this.row];
    }

    get offscreen() {
        return this.x < -4 || this.taken;
    }

    draw(term) {
        const frames = GLYPHS.TOKEN_FRAMES;
        const f = frames[Math.floor(this.phase) % frames.length];
        term.blit(f, Math.round(this.x), this.row);
    }
}

/* ================================================================== *
 * World — ground, terrain, parallax, biome
 * ================================================================== */

/**
 * A stable 0..1 value per (column, row). The sub-surface texture used to be a
 * modulo stride, and a modulo stride is visibly periodic: you could read the
 * repeat right off the screen as `.   ·         .   ·`. A hash gives the same
 * cheap per-cell decision with no period, so the ground below the line looks
 * like dirt instead of like a ruler.
 */
function hash2(x, y) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class World {
    constructor() {
        this.reset();
    }

    reset() {
        this.distance = 0;
        this.scroll = 0;
        this.biomeIndex = 0;
        this.biome = GLYPHS.BIOMES[0];
        this.stars = [];
        this.far = [];
        this.mid = [];
        this.seedBackdrop();
    }

    seedBackdrop() {
        const S = GLYPHS.DECOR.stars;
        for (let i = 0; i < 46; i++) {
            this.stars.push({
                x: RNG.look.next() * GEO.cols,
                y: GEO.skyTop + RNG.look.next() * 11,
                ch: S[Math.floor(RNG.look.next() * S.length)],
                a: 0.25 + RNG.look.next() * 0.5,
            });
        }
        for (let i = 0; i < 5; i++) this.far.push(this.makeDecor(RNG.look.next() * GEO.cols, 'far'));
        for (let i = 0; i < 4; i++) this.mid.push(this.makeDecor(RNG.look.next() * GEO.cols, 'mid'));
    }

    makeDecor(x, band) {
        if (band === 'far') {
            const set = GLYPHS.DECOR[this.biome.decor] || GLYPHS.DECOR.clouds;
            const s = set[Math.floor(RNG.look.next() * set.length)];
            return { x, sprite: s, bottom: GEO.skyTop + 6 + Math.floor(RNG.look.next() * 5) };
        }
        const set = GLYPHS.DECOR.trees;
        const s = set[Math.floor(RNG.look.next() * set.length)];
        return { x, sprite: s, bottom: GEO.standRow };
    }

    /**
     * `scored` separates the two things "distance" was doing. The backdrop scrolls
     * on the menu too — that idling world is the first thing you see — but the
     * metre count is a run statistic, and a menu that sat there for a minute used
     * to hand you 300 m before you had pressed anything. It also has to stay a
     * pure function of the run for the server's replay to agree with the browser.
     */
    step(speed, scored = true) {
        this.scroll += speed;
        if (scored) this.distance += speed;

        for (const s of this.stars) {
            s.x -= speed * 0.09;
            if (s.x < -1) { s.x += GEO.cols + 2; s.y = GEO.skyTop + RNG.look.next() * 11; }
        }
        for (const d of this.far) {
            d.x -= speed * 0.3;
            if (d.x + d.sprite.w < -2) Object.assign(d, this.makeDecor(GEO.cols + RNG.look.next() * 30, 'far'));
        }
        for (const d of this.mid) {
            d.x -= speed * 0.62;
            if (d.x + d.sprite.w < -2) Object.assign(d, this.makeDecor(GEO.cols + RNG.look.next() * 40, 'mid'));
        }
    }

    /** Returns the new biome when the score crosses a threshold, else null. */
    checkBiome(score) {
        const next = GLYPHS.BIOMES[this.biomeIndex + 1];
        if (next && score >= next.threshold) {
            this.biomeIndex++;
            this.biome = next;
            return next;
        }
        return null;
    }

    drawSky(term, thinking, tick) {
        for (const s of this.stars) {
            term.put(Math.round(s.x), Math.round(s.y), s.ch, 'dim', s.a);
        }
        for (const d of this.far) {
            term.blit(d.sprite, Math.round(d.x), d.bottom - d.sprite.h + 1, { clipAbove: GEO.skyTop });
        }

        if (thinking) {
            // Thought fragments drift the other way, slower than everything else,
            // so the world visibly stops making sense at normal speed. They fade
            // in and out at the screen edges rather than being sliced off there:
            // a word cut mid-letter at column 111 looks like a bug, not a mood.
            const T = GLYPHS.DECOR.thoughts;
            for (let i = 0; i < 5; i++) {
                const t = T[(i * 3 + Math.floor(tick / 90)) % T.length];
                const span = GEO.cols + 30;
                const x = Math.round(((tick * 0.13 + i * 41) % span) - 15);
                const edge = Math.min(x + t.length, GEO.cols - x) / 7;
                const a = 0.34 * Math.max(0, Math.min(1, edge));
                if (a > 0.02) term.text(x, GEO.skyTop + 1 + i * 2, t, 'cyan', a);
            }
        }
    }

    drawMid(term) {
        for (const d of this.mid) {
            term.blit(d.sprite, Math.round(d.x), d.bottom - d.sprite.h + 1, { clipAbove: GEO.skyTop });
        }
    }

    drawGround(term) {
        const b = this.biome;
        const off = Math.floor(this.scroll);

        for (let x = 0; x < GEO.cols; x++) {
            term.put(x, GEO.groundRow, b.ground, b.accent, 0.85);
        }

        // Sub-surface texture, thinning out with depth so the board has a floor
        // rather than a wall. Both the presence of a glyph and which glyph it is
        // come from a hash of the *world* column, so the pattern scrolls with the
        // ground it belongs to and never shows a seam.
        const fill = b.fill;
        for (let row = GEO.groundRow + 1; row < GEO.statusRow; row++) {
            const depth = row - GEO.groundRow;
            const density = 0.62 / depth;
            for (let x = 0; x < GEO.cols; x++) {
                const wx = x + off;
                if (hash2(wx, row) > density) continue;
                const ch = fill[Math.floor(hash2(wx, row + 97) * fill.length)];
                if (ch === ' ') continue;
                term.put(x, row, ch, depth < 2 ? 'dim' : 'dimmer', 1 - depth * 0.13);
            }
        }
    }
}

/* ================================================================== *
 * Spawner
 *
 * Difficulty comes from spacing, not from unfair shapes: every hazard is
 * always clearable, and the gaps just get tighter.
 * ================================================================== */

/** Ground covered by one full jump, in cells. The unit every gap is measured in. */
function jumpCells(speed) {
    return speed * (2 * Math.abs(PHYS.jumpV) / PHYS.gravity);
}

/**
 * A line of tokens laid along the flight path of a jump made over the hazard at
 * world column `hx`. The arc is not a decorative sine: it is the hero's real
 * trajectory, sampled, so the tokens sit exactly where he will actually be. That
 * is the whole point — the reward traces the input, and it re-shapes with speed
 * because the same jump covers more ground the faster the world runs.
 */
function arcTokens(hx, speed) {
    const airtime = 2 * Math.abs(PHYS.jumpV) / PHYS.gravity;
    const lead = jumpCells(speed) * 0.45;   // where a well-timed jump starts
    const out = [];
    for (const f of [0.18, 0.34, 0.5, 0.66, 0.82]) {
        const t = airtime * f;
        const row = Math.round(GEO.standRow + PHYS.jumpV * t + 0.5 * PHYS.gravity * t * t) - 2;
        out.push(new Token(Math.round(hx - 2.5 - lead + t * speed), row));
    }
    return out;
}

class Spawner {
    constructor() {
        this.reset();
    }

    reset() {
        this.nextHazard = 40;
        this.nextToken = 60;
        this.lastKind = null;
        this.arcOver = null;   // world column of a hazard owed a token arc
    }

    /**
     * Advance by `cells` of world travel; returns { hazards, tokens } to add.
     *
     * Every draw below comes from RNG.play — this method *is* the run. Reach for
     * RNG.look here and the server's replay of the same inputs will build a
     * different road, and honest scores start getting rejected.
     */
    step(cells, score, speed) {
        const out = { hazards: [], tokens: [] };
        const rng = RNG.play;

        this.nextHazard -= cells;
        if (this.nextHazard <= 0) {
            const kind = this.pickKind(score);
            out.hazards.push(new Hazard(kind, GEO.cols + 3));

            // A drone tucked behind a ground hazard: jump, then duck. The best
            // moments in a runner are the ones that need two inputs in a row.
            // The drone sits four fifths of a jump back, so you land before you
            // have to duck — at a fixed 22 cells it arrived while you were still
            // airborne and ducking meant fast-dropping onto the hazard.
            const reach = jumpCells(speed);
            const combo = score > 700 && rng.chance(0.18) && !HAZARDS[kind].air;
            if (combo) out.hazards.push(new Hazard('rateLimit', GEO.cols + 3 + Math.round(reach * 0.8)));

            // Half the ground hazards get a token arc over them, claimed on the
            // next token beat.
            if (!HAZARDS[kind].air && !combo && rng.chance(0.5)) {
                this.arcOver = GEO.cols + 3;
                this.nextToken = Math.min(this.nextToken, 1);
            }

            // Spacing is measured in jumps, not in cells, so a hazard is never
            // placed where the previous jump has not finished. Difficulty comes
            // from having less time to read the gap, not from unfair spacing.
            const pressure = Math.min(1, score / 3200);
            this.nextHazard = reach * (1.55 - pressure * 0.42)
                + rng.next() * reach * 0.55
                + (combo ? reach * 0.5 : 0);
            this.lastKind = kind;
        }

        this.nextToken -= cells;
        if (this.nextToken <= 0) {
            const reach = jumpCells(speed);
            if (this.arcOver !== null) {
                // Tokens strung along the jump the player already has to make.
                out.tokens.push(...arcTokens(this.arcOver, speed));
                this.arcOver = null;
            } else if (this.nextHazard > reach * 0.9) {
                // Ground-level tokens are only fair with a clear jump of road
                // ahead of them; otherwise picking one up costs you the jump the
                // next hazard needs, which reads as the game cheating.
                out.tokens.push(new Token(GEO.cols + 3, GEO.standRow - 1 - rng.int(3)));
            }
            this.nextToken = reach * (1.4 + rng.next() * 1.8);
        }

        return out;
    }

    pickKind(score) {
        const pool = [];
        for (const [kind, def] of Object.entries(HAZARDS)) {
            if (score < def.min) continue;
            if (kind === this.lastKind) continue; // never twice running
            pool.push(kind);
        }
        if (!pool.length) return 'bug';
        return RNG.play.pick(pool);
    }
}

/* ------------------------------------------------------------------ *
 * Collision helpers
 * ------------------------------------------------------------------ */

function overlaps(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Smallest cell gap between two boxes. 0 means touching. */
function gapBetween(a, b) {
    const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
    const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
    return Math.max(dx, dy);
}

window.GEO = GEO;
window.PHYS = PHYS;
window.jumpCells = jumpCells;
window.hash2 = hash2;
window.Clawd = Clawd;
window.Hazard = Hazard;
window.HAZARDS = HAZARDS;
window.Token = Token;
window.World = World;
window.Spawner = Spawner;
window.overlaps = overlaps;
window.gapBetween = gapBetween;
