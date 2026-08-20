/**
 * Claude Claw'd Run — Engine
 *
 * A fixed-timestep runner drawn entirely into a character grid. There is no
 * HTML on top of the play area: menus, the pause screen and the stack trace on
 * death are all box-drawing characters written into the same buffer as the
 * hero, because the whole conceit is that this is a terminal.
 */

const STATE = { BOOT: 'boot', MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', DEAD: 'dead' };

const STEP_MS = 1000 / 60;
const MAX_STEPS = 5; // if the tab stalls, drop the backlog rather than fast-forward

const TUNING = {
    // Speed is cells per step. A full jump lasts 51 steps, so base speed puts
    // ~21 cells of ground under one jump — enough to clear the widest hazard
    // with room to read the gap. Anything slower makes jumping useless.
    baseSpeed: 0.42,
    maxSpeed: 0.92,
    speedPerPoint: 0.00009,
    scoreRate: 0.88,
    milestone: 500,

    thinkPerToken: 0.085,
    thinkMin: 0.3,
    thinkDrain: 1 / 220,
    thinkScale: 0.42,

    comboWindow: 260,
    comboMax: 9,
    comboStep: 0.2,
    grazeCells: 2,
};

/** What the stack trace says you died of. */
const TRACE = {
    UnhandledBug:   'Uncaught BugError: unexpected behaviour reached production',
    Segfault:       'SIGSEGV: segmentation fault (core dumped)',
    NullPointer:    'TypeError: cannot read properties of null',
    MergeConflict:  'GitError: automatic merge failed, fix conflicts and commit',
    DependencyHell: 'ResolveError: peer dependency graph is unsatisfiable',
    RateLimited:    'HTTP 429: too many requests, retry after 60s',
    Timeout:        'ETIMEDOUT: upstream did not respond in time',
    InfiniteLoop:   'RangeError: maximum call stack size exceeded',
};

const BOOT_LINES = [
    { text: '$ claude run ./clawd', color: 'fg' },
    { text: '', color: 'fg' },
    { text: '● Claude Code — claw\'d runtime', color: 'claw' },
    { text: '  loading glyph atlas ............. ok', color: 'fgDim' },
    { text: '  warming carapace ................ ok', color: 'fgDim' },
    { text: '  binding claws to <space> ........ ok', color: 'fgDim' },
    { text: '  extended thinking ............... armed', color: 'ok' },
    { text: '', color: 'fg' },
    { text: '  ready.', color: 'fg' },
];

/** 1842 → "1 842". Grouped digits read as a stat; zero-padding reads as a coin-op. */
function fmt(n) {
    return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

class Game {
    constructor(canvas) {
        this.term = new Terminal(canvas, {
            cols: GEO.cols, rows: GEO.rows, cellW: 10, cellH: 20,
        });

        this.world = new World();
        this.hero = new Clawd();
        this.spawner = new Spawner();
        this.fx = window.particleManager;
        this.sound = window.soundController;

        this.hazards = [];
        this.tokens = [];

        this.theme = localStorage.getItem('claude_clawd_theme') || 'dark';
        this.best = parseInt(localStorage.getItem('claude_clawd_high_score') || '0', 10);
        this.applyTheme();

        this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (this.reduceMotion) {
            this.term.effects = false;
            this.term.scanlines = false;
        }

        this.state = STATE.BOOT;
        this.tick = 0;
        this.bootChars = 0;
        this.bootLine = -1;

        this.resetRun();
        this.bindInput();
        this.bindChrome();

        this.acc = 0;
        this.last = 0;
        this.loop = this.loop.bind(this);

        // Wait for the mono font before the first paint, otherwise the opening
        // frame measures a fallback face and every glyph lands off-centre.
        const start = () => {
            this.term.measureFont();
            requestAnimationFrame((t) => { this.last = t; requestAnimationFrame(this.loop); });
        };
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
        else start();
    }

    resetRun() {
        this.hazards.length = 0;
        this.tokens.length = 0;
        this.world.reset();
        this.hero.reset();
        this.spawner.reset();
        this.fx.clear();

        this.scoreF = 0;
        this.score = 0;
        this.speed = TUNING.baseSpeed;
        this.timeScale = 1;
        this.nextMilestone = TUNING.milestone;

        this.think = 0;
        this.thinking = false;
        this.tokensTaken = 0;
        this.tokenChain = 0;
        this.tokenChainTimer = 0;

        this.combo = 0;
        this.comboTimer = 0;
        this.bestCombo = 0;

        this.shake = 0;
        this.banner = null;
        this.deathReason = 'UnhandledBug';
        this.deathSteps = 0;
        this.isNewBest = false;
    }

    /* ================================================================== *
     * Theme + chrome
     * ================================================================== */

    applyTheme() {
        this.term.setPalette(GLYPHS.PALETTES[this.theme]);
        document.body.dataset.theme = this.theme;
        const btn = document.getElementById('themeBtn');
        if (btn) btn.textContent = this.theme === 'dark' ? 'theme: dark' : 'theme: light';
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('claude_clawd_theme', this.theme);
        this.applyTheme();
        this.sound.playClick();
    }

    toggleMute() {
        const muted = this.sound.toggleMute();
        const btn = document.getElementById('soundBtn');
        if (btn) btn.textContent = muted ? 'sound: off' : 'sound: on';
        if (!muted) this.sound.playClick();
    }

    bindChrome() {
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        };
        on('themeBtn', () => this.toggleTheme());
        on('soundBtn', () => this.toggleMute());
        on('pauseBtn', () => this.togglePause());

        const btnJump = document.getElementById('touchJump');
        const btnDuck = document.getElementById('touchDuck');
        const btnThink = document.getElementById('touchThink');
        const press = (el, down, up) => {
            if (!el) return;
            el.addEventListener('pointerdown', (e) => { e.preventDefault(); this.sound.resume(); down(); });
            el.addEventListener('pointerup', (e) => { e.preventDefault(); up && up(); });
            el.addEventListener('pointercancel', () => up && up());
            el.addEventListener('pointerleave', () => up && up());
        };
        press(btnJump, () => this.primary(), () => this.hero.releaseJump());
        press(btnDuck, () => this.secondary(true), () => this.secondary(false));
        press(btnThink, () => this.tryThink());

        // Tapping the board itself: top half jumps, bottom half ducks.
        const cv = this.term.canvas;
        cv.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.sound.resume();
            const r = cv.getBoundingClientRect();
            if (this.state !== STATE.PLAYING) { this.primary(); return; }
            if ((e.clientY - r.top) / r.height > 0.62) this.secondary(true);
            else this.primary();
        });
        cv.addEventListener('pointerup', (e) => {
            e.preventDefault();
            this.secondary(false);
            this.hero.releaseJump();
        });
        cv.addEventListener('pointercancel', () => { this.secondary(false); this.hero.releaseJump(); });
    }

    /* ================================================================== *
     * Input
     * ================================================================== */

    bindInput() {
        const JUMP = new Set(['Space', 'ArrowUp', 'KeyW', 'Enter']);
        const DUCK = new Set(['ArrowDown', 'KeyS']);

        window.addEventListener('keydown', (e) => {
            if (e.repeat && !DUCK.has(e.code)) return;
            this.sound.resume();

            // A focused chrome button owns space and enter, so tabbing to
            // "pause" and hitting space presses the button instead of jumping.
            const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
            if (onButton && (e.code === 'Space' || e.code === 'Enter')) return;

            if (JUMP.has(e.code)) { e.preventDefault(); this.primary(); return; }
            if (DUCK.has(e.code)) { e.preventDefault(); this.secondary(true); return; }
            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); this.tryThink(); return; }
            if (e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); this.togglePause(); return; }
            if (e.code === 'KeyT') { this.toggleTheme(); return; }
            if (e.code === 'KeyM') { this.toggleMute(); return; }
            if (e.code === 'KeyF') { this.term.effects = !this.term.effects; this.term.scanlines = this.term.effects; return; }
        });

        window.addEventListener('keyup', (e) => {
            if (JUMP.has(e.code)) this.hero.releaseJump();
            if (DUCK.has(e.code)) this.secondary(false);
        });

        window.addEventListener('blur', () => {
            this.secondary(false);
            this.hero.releaseJump();
            if (this.state === STATE.PLAYING) this.togglePause();
        });
    }

    /** Space and friends: context-sensitive, so one key always does the obvious thing. */
    primary() {
        switch (this.state) {
            case STATE.BOOT:
                this.state = STATE.MENU;
                break;
            case STATE.MENU:
                this.startRun();
                break;
            case STATE.PLAYING:
                this.hero.requestJump(this.sound);
                break;
            case STATE.PAUSED:
                this.togglePause();
                break;
            case STATE.DEAD:
                if (this.deathSteps > 40) this.startRun();
                break;
        }
    }

    secondary(down) {
        if (this.state !== STATE.PLAYING) return;
        const was = this.hero.ducking;
        this.hero.setDucking(down);
        if (down && !was && this.hero.grounded) this.sound.playDuck();
    }

    startRun() {
        this.resetRun();
        this.state = STATE.PLAYING;
        this.sound.clearFilter();
        this.sound.playClick();
        this.setStatusButtons();
    }

    togglePause() {
        if (this.state === STATE.PLAYING) {
            this.state = STATE.PAUSED;
        } else if (this.state === STATE.PAUSED) {
            this.state = STATE.PLAYING;
        } else return;
        this.sound.playClick();
        this.setStatusButtons();
    }

    setStatusButtons() {
        const btn = document.getElementById('pauseBtn');
        if (btn) btn.textContent = this.state === STATE.PAUSED ? 'resume' : 'pause';
    }

    tryThink() {
        if (this.state !== STATE.PLAYING || this.thinking) return;
        if (this.think < TUNING.thinkMin) return;
        this.thinking = true;
        this.hero.thinking = true;
        this.sound.playThinkStart();
        this.fx.thinkBurst(this.hero.x + 7, this.hero.y - 3);
        this.fx.text(GEO.heroX + 16, GEO.standRow - 8, 'extended thinking', 'cyanHot', 80);
    }

    endThink() {
        this.thinking = false;
        this.hero.thinking = false;
        this.think = 0;
        this.sound.playThinkEnd();
    }

    /* ================================================================== *
     * Simulation — one 60Hz step
     * ================================================================== */

    step() {
        this.tick++;

        if (this.state === STATE.BOOT) return this.stepBoot();

        if (this.shake > 0.01) {
            this.shake *= 0.87;
            const s = this.reduceMotion ? 0 : this.shake;
            this.term.shakeX = (Math.random() - 0.5) * s;
            this.term.shakeY = (Math.random() - 0.5) * s;
        } else {
            this.term.shakeX = this.term.shakeY = 0;
        }
        this.term.flash *= 0.86;

        if (this.banner) {
            this.banner.life--;
            if (this.banner.life <= 0) this.banner = null;
        }

        if (this.state === STATE.MENU) {
            // The menu is the game, idling. The world already scrolls, so the
            // first thing you see is motion rather than a card.
            const idle = TUNING.baseSpeed * 0.55;
            this.world.step(idle);
            this.hero.step(idle);
            this.fx.runDust(this.hero.x + 3, GEO.standRow, this.world.biome.accent);
            this.fx.step(idle);
            return;
        }

        if (this.state === STATE.PAUSED) return;

        if (this.state === STATE.DEAD) {
            this.deathSteps++;
            this.term.glitch = Math.max(0, this.term.glitch * 0.94);
            this.fx.step(0);
            return;
        }

        this.stepPlaying();
    }

    stepBoot() {
        const total = BOOT_LINES.reduce((n, l) => n + l.text.length + 1, 0);
        this.bootChars += 2.1;
        const line = Math.min(BOOT_LINES.length - 1, Math.floor((this.bootChars / total) * BOOT_LINES.length));
        if (line !== this.bootLine) {
            this.bootLine = line;
            this.sound.playBoot(line);
        }
        if (this.bootChars > total + 60) this.state = STATE.MENU;
    }

    stepPlaying() {
        // Extended thinking dilates time for the hero and the world together, so
        // every jump still covers exactly the ground it always did — you just get
        // two and a half times as long to read the road. Score keeps accruing at
        // the undilated rate, which is what makes it a real cost.
        if (this.thinking) {
            this.think -= TUNING.thinkDrain;
            if (this.think <= 0) this.endThink();
        }
        this.timeScale = this.thinking ? TUNING.thinkScale : 1;

        this.speed = Math.min(TUNING.maxSpeed, TUNING.baseSpeed + this.score * TUNING.speedPerPoint);
        const world = this.speed * this.timeScale;

        if (this.comboTimer > 0 && --this.comboTimer === 0) this.combo = 0;
        if (this.tokenChainTimer > 0 && --this.tokenChainTimer === 0) this.tokenChain = 0;

        const mult = 1 + this.combo * TUNING.comboStep;
        this.scoreF += this.speed * TUNING.scoreRate * mult;
        this.score = Math.floor(this.scoreF);

        if (this.score >= this.nextMilestone) {
            this.nextMilestone += TUNING.milestone;
            this.sound.playMilestone();
            this.fx.milestone(this.world.biome.accent);
            this.hero.setFace('happy', 40);
        }

        const changed = this.world.checkBiome(this.score);
        if (changed) {
            this.banner = { name: changed.name, note: changed.note, life: 170, max: 170 };
            this.sound.playBiome();
            this.term.flash = 0.18;
            this.term.flashColor = changed.accent;
        }

        this.world.step(world);
        const landed = this.hero.step(world, this.timeScale);
        if (landed !== null) {
            const force = Math.min(1, landed / 0.9);
            this.sound.playLand(force);
            this.fx.landPuff(this.hero.x + 7, GEO.standRow, force);
            this.shake = Math.max(this.shake, force * 1.6);
        }
        if (this.hero.grounded && !this.hero.ducking) {
            this.fx.runDust(this.hero.x + 3, GEO.standRow, this.world.biome.accent);
        }

        const spawned = this.spawner.step(world, this.score, this.speed);
        for (const h of spawned.hazards) this.hazards.push(h);
        for (const t of spawned.tokens) this.tokens.push(t);

        for (let i = this.hazards.length - 1; i >= 0; i--) {
            const h = this.hazards[i];
            h.step(world, this.tick);
            if (h.offscreen) this.hazards.splice(i, 1);
        }
        for (let i = this.tokens.length - 1; i >= 0; i--) {
            const t = this.tokens[i];
            t.step(world);
            if (t.offscreen) this.tokens.splice(i, 1);
        }

        this.fx.step(world);
        this.collide();
    }

    collide() {
        const pb = this.hero.hitbox;

        for (const h of this.hazards) {
            const hb = h.hitbox;
            if (overlaps(pb, hb)) return this.crash(h);

            // Near miss: remember the tightest gap while the hazard is level
            // with the hero, then score it once the hazard is behind him.
            if (hb[2] >= pb[0] - 4 && hb[0] <= pb[2] + 4) {
                h.minGap = Math.min(h.minGap, gapBetween(pb, hb));
            }
            if (!h.passed && hb[2] < pb[0]) {
                h.passed = true;
                if (h.minGap <= TUNING.grazeCells) this.nearMiss(h);
            }
        }

        for (const t of this.tokens) {
            if (t.taken) continue;
            if (!overlaps(pb, t.hitbox)) continue;
            t.taken = true;
            this.tokensTaken++;
            this.tokenChain = Math.min(9, this.tokenChain + 1);
            this.tokenChainTimer = 90;
            this.think = Math.min(1, this.think + TUNING.thinkPerToken);
            this.scoreF += 12;
            this.sound.playPickup(this.tokenChain);
            this.fx.pickup(t.x + 1, t.row);
            if (this.tokenChain >= 3) {
                this.fx.text(t.x - 1, t.row - 1, `×${this.tokenChain}`, 'cyanHot', 34);
            }
            if (this.think >= TUNING.thinkMin && !this.thinking) this.hero.setFace('happy', 30);
        }
    }

    nearMiss(h) {
        this.combo = Math.min(TUNING.comboMax, this.combo + 1);
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        this.comboTimer = TUNING.comboWindow;
        this.scoreF += 10 * this.combo;
        this.sound.playNearMiss(this.combo);
        this.fx.text(GEO.heroX + 2, GEO.standRow - 7, `close ×${this.combo}`, this.world.biome.accent, 40);
    }

    crash(h) {
        this.state = STATE.DEAD;
        this.deathSteps = 0;
        this.deathReason = h.def.reason;
        this.hero.kill();
        if (this.thinking) { this.thinking = false; this.hero.thinking = false; }

        this.sound.playHit();
        this.sound.playGameOver();
        this.fx.crash(this.hero.x + 7, GEO.standRow);
        this.shake = this.reduceMotion ? 0 : 6.5;
        this.term.flash = 0.4;
        this.term.flashColor = 'bug';
        this.term.glitch = this.reduceMotion ? 0 : 1;

        this.isNewBest = this.score > this.best;
        if (this.isNewBest) {
            this.best = this.score;
            localStorage.setItem('claude_clawd_high_score', String(this.best));
        }
        this.setStatusButtons();
    }

    /* ================================================================== *
     * Drawing
     * ================================================================== */

    draw() {
        const t = this.term;
        t.clear();

        if (this.state === STATE.BOOT) {
            this.drawBoot();
            t.render(this.tick * STEP_MS);
            return;
        }

        this.drawScene();
        this.drawHud();
        this.drawStatusline();
        if (this.banner) this.drawBanner();

        if (this.state === STATE.MENU) this.drawMenu();
        if (this.state === STATE.PAUSED) this.drawPause();
        if (this.state === STATE.DEAD && this.deathSteps > 34) this.drawDeath();

        t.render(this.tick * STEP_MS);
    }

    drawScene() {
        const t = this.term;
        this.world.drawSky(t, this.thinking, this.tick);
        this.world.drawMid(t);
        this.world.drawGround(t);

        for (const tk of this.tokens) tk.draw(t);
        for (const h of this.hazards) h.draw(t);
        this.fx.draw(t);
        this.hero.draw(t, this.tick);
    }

    drawHud() {
        const t = this.term;
        const b = this.world.biome;

        // Left: where you are. The path is the level name.
        t.put(1, 0, '●', b.accent);
        t.text(3, 0, b.name, 'fg');
        const noteX = 3 + b.name.length + 2;
        t.text(noteX, 0, '·', 'dim');
        t.text(noteX + 2, 0, b.note, 'fgDim');

        // Right: score, then best in a quieter colour.
        const score = fmt(this.score);
        const best = `best ${fmt(this.best)}`;
        t.text(GEO.cols - 1 - best.length, 0, best, 'fgDim');
        t.text(GEO.cols - 3 - best.length - score.length, 0, score, this.isNewBest ? 'amber' : 'fg');

        // Row 1, left: the thinking meter.
        const ready = this.think >= TUNING.thinkMin;
        const label = this.thinking ? 'THINKING' : 'thinking';
        t.text(1, 1, label, this.thinking ? 'cyanHot' : ready ? 'cyan' : 'dim');
        t.meter(10, 1, 14, this.think, {
            color: this.thinking ? 'cyanHot' : 'cyan',
            emptyColor: 'dimmer',
        });
        if (this.thinking) {
            const spin = '|/-\\'[Math.floor(this.tick / 4) % 4];
            t.put(25, 1, spin, 'cyanHot');
        } else if (ready && this.state === STATE.PLAYING) {
            t.text(25, 1, 'shift', 'cyan', 0.55 + Math.sin(this.tick * 0.12) * 0.4);
        }

        // Row 1, right: combo, only when there is one.
        if (this.combo > 0) {
            const mult = (1 + this.combo * TUNING.comboStep).toFixed(1);
            const bar = `×${mult}`;
            const decay = this.comboTimer / TUNING.comboWindow;
            t.text(GEO.cols - 1 - bar.length, 1, bar, this.world.biome.accent);
            t.meter(GEO.cols - 3 - bar.length - 8, 1, 8, decay, {
                color: this.world.biome.accent, emptyColor: 'dimmer', alpha: 0.7,
            });
        }

        if (this.tokensTaken > 0) {
            const tk = `◆ ${this.tokensTaken}`;
            t.text(42, 1, tk, 'cyan', 0.8);
        }
    }

    drawStatusline() {
        const t = this.term;
        const y = GEO.statusRow;
        const b = this.world.biome;

        let mode, modeColor, hint;
        switch (this.state) {
            case STATE.MENU:
                mode = ' READY '; modeColor = 'ok';
                hint = 'space  jump    ↓  duck    shift  extended thinking    t  theme    m  mute';
                break;
            case STATE.PLAYING:
                mode = ' RUN '; modeColor = b.accent;
                hint = 'space  jump    ↓  duck / fast drop    shift  think    p  pause';
                break;
            case STATE.PAUSED:
                mode = ' PAUSED '; modeColor = 'amber';
                hint = 'p  resume    t  theme    m  mute    f  effects';
                break;
            default:
                mode = ' CRASHED '; modeColor = 'bug';
                hint = 'space  run again    t  theme    m  mute';
        }

        for (let x = 0; x < GEO.cols; x++) t.put(x, y, ' ', 'fg', 1);
        t.text(1, y, mode, modeColor);
        t.text(2 + mode.length, y, hint, 'dim');

        const dist = `${fmt(this.world.distance)} m`;
        t.text(GEO.cols - 1 - dist.length, y, dist, 'dim');
    }

    drawBanner() {
        const t = this.term;
        const b = this.banner;
        const p = b.life / b.max;
        // Ease in fast, hold, fade out — so it registers without lingering.
        const alpha = Math.min(1, Math.min(p * 4, (1 - p) * 6 + 0.2));
        const head = `→  ${b.name}`;
        t.centered(4, head, this.world.biome.accent, alpha);
        t.centered(5, b.note, 'fgDim', alpha * 0.8);
    }

    /* ---------------- boot ---------------- */

    drawBoot() {
        const t = this.term;
        let budget = this.bootChars;
        let y = 4;
        for (const line of BOOT_LINES) {
            if (budget <= 0) break;
            const n = Math.min(line.text.length, Math.floor(budget));
            t.text(8, y, line.text.slice(0, n), line.color);
            if (n < line.text.length) {
                t.put(8 + n, y, '█', 'claw', 0.9);
                break;
            }
            budget -= line.text.length + 1;
            y++;
        }
        if (this.bootChars > 40) {
            t.centered(GEO.rows - 4, 'press any key to skip', 'dim', 0.5);
        }
    }

    /* ---------------- menu ---------------- */

    drawMenu() {
        const t = this.term;
        const T = GLYPHS.TITLE;
        const x = Math.round((GEO.cols - T.w) / 2);
        const drift = Math.round(Math.sin(this.tick * 0.03) * 0.5);

        t.blit(T, x, 3 + drift, { tint: 'claw' });
        // A one-cell offset copy underneath reads as a drop shadow without
        // needing anything the grid can't express.
        for (let ry = 0; ry < T.h; ry++) {
            for (let rx = 0; rx < T.w; rx++) {
                const c = T.rows[ry][rx];
                if (c !== ' ' && t.peek(x + rx + 1, 4 + drift + ry) === ' ') {
                    t.put(x + rx + 1, 4 + drift + ry, c, 'clawDeep', 0.28);
                }
            }
        }

        t.centered(9, 'an endless runner about shipping code', 'fgDim');

        const blink = Math.sin(this.tick * 0.09) > -0.3;
        const cta = 'press  space  to run';
        t.centered(12, cta, 'fg', blink ? 1 : 0.35);
        t.put(Math.round((GEO.cols - cta.length) / 2) + cta.length + 1, 12, blink ? '█' : ' ', 'claw', 0.9);

        // Three lines of rules, in the order you need them.
        const rules = [
            ['jump', 'bugs, conflicts and node_modules sit on the ground'],
            ['duck', 'rate limits and timeouts fly at head height'],
            ['◆', 'tokens charge extended thinking — shift slows the world'],
        ];
        rules.forEach(([key, why], i) => {
            const line = `${key.padEnd(6)}${why}`;
            const lx = Math.round((GEO.cols - 62) / 2);
            t.text(lx, 15 + i, key, i === 2 ? 'cyan' : 'claw');
            t.text(lx + 7, 15 + i, why, 'dim');
        });

        if (this.best > 0) {
            t.centered(19, `best  ${fmt(this.best)}`, 'amber', 0.8);
        }
    }

    /* ---------------- pause ---------------- */

    drawPause() {
        const t = this.term;
        t.dimAll(0.22);
        const w = 34, h = 7;
        const x = Math.round((GEO.cols - w) / 2);
        const y = 8;
        t.box(x, y, w, h, { style: 'round', color: 'amber', title: 'paused', titleColor: 'amber' });
        t.centered(y + 2, 'the world is holding still', 'fgDim');
        t.centered(y + 4, 'press  p  to resume', 'fg');
    }

    /* ---------------- death ---------------- */

    drawDeath() {
        const t = this.term;
        t.dimAll(0.2);

        const msg = TRACE[this.deathReason] || TRACE.UnhandledBug;
        const w = Math.max(58, msg.length + 8);
        const h = 13;
        const x = Math.round((GEO.cols - w) / 2);
        const y = 6;

        // Slide up over ~14 steps so the panel arrives instead of appearing.
        const t0 = Math.min(1, (this.deathSteps - 34) / 14);
        const yy = y + Math.round((1 - t0) * 3);
        const a = t0;

        t.box(x, yy, w, h, {
            style: 'heavy', color: 'bug', alpha: a,
            title: 'process exited · code 1', titleColor: 'bug',
        });

        const ix = x + 3;
        const line = 1000 + (this.score % 8000);
        t.text(ix, yy + 2, msg, 'bug', a);
        t.text(ix + 4, yy + 3, `at Clawd.run (clawd-run.js:${line}:${9 + (this.score % 40)})`, 'dim', a);
        t.text(ix + 4, yy + 4, `at World.tick (engine.js:${88 + (this.tokensTaken % 30)}:12)`, 'dim', a);

        t.hline(x + 2, yy + 6, w - 4, '─', 'dimmer', a);

        const stats = [
            ['score', fmt(this.score), this.isNewBest ? 'amber' : 'fg'],
            ['distance', `${fmt(this.world.distance)} m`, 'fg'],
            ['tokens', `◆ ${this.tokensTaken}`, 'cyan'],
            ['best chain', `×${(1 + this.bestCombo * TUNING.comboStep).toFixed(1)}`, this.world.biome.accent],
        ];
        stats.forEach(([k, v, c], i) => {
            const col = ix + (i % 2) * Math.floor((w - 6) / 2);
            const row = yy + 7 + Math.floor(i / 2);
            t.text(col, row, k, 'fgDim', a);
            t.text(col + 12, row, v, c, a);
        });

        if (this.isNewBest) {
            const badge = ` new best — ${fmt(this.best)} `;
            t.textOpaque(x + Math.round((w - badge.length) / 2), yy + h - 1, badge, 'amber', a);
        }

        const cta = 'press  space  to run again';
        const blink = Math.sin(this.tick * 0.09) > -0.3;
        t.centered(yy + h + 1, cta, 'fg', a * (blink ? 1 : 0.4));
    }

    /* ================================================================== *
     * Main loop
     * ================================================================== */

    loop(now) {
        const dt = Math.min(200, now - this.last);
        this.last = now;
        this.acc += dt;

        let steps = 0;
        while (this.acc >= STEP_MS && steps < MAX_STEPS) {
            this.step();
            this.acc -= STEP_MS;
            steps++;
        }
        if (steps === MAX_STEPS) this.acc = 0; // stalled tab: drop the backlog

        this.draw();
        requestAnimationFrame(this.loop);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    if (canvas) window.game = new Game(canvas);
});
