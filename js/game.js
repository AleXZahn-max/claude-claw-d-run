/**
 * Claude Claw'd Run — Engine
 *
 * A fixed-timestep runner drawn entirely into a character grid. There is no
 * HTML on top of the play area: menus, the pause screen and the stack trace on
 * death are all box-drawing characters written into the same buffer as the
 * hero, because the whole conceit is that this is a terminal.
 */

const STATE = {
    BOOT: 'boot',
    PROFILE: 'profile',
    MENU: 'menu',
    BOARD: 'board',
    PLAYING: 'playing',
    PAUSED: 'paused',
    DEAD: 'dead',
};

const STEP_MS = 1000 / 60;
const MAX_STEPS = 5; // if the tab stalls, drop the backlog rather than fast-forward

const TUNING = {
    // Speed is cells per step. A full jump lasts 62 steps, so base speed puts
    // ~26 cells of ground under one jump — enough to clear the widest hazard
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

    // Below this, a run is not worth a row on a global board.
    submitFloor: 150,
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

        PROFILE.load();
        // The name field the profile screen edits. Kept separate from the saved
        // handle so backing out of the screen cannot half-rename you.
        this.draft = PROFILE.name;
        this.skinIndex = Math.max(0, GLYPHS.SKIN_IDS.indexOf(PROFILE.skin));
        this.submit = { state: 'idle', rank: -1, reason: '' };

        /*
         * Who we are is asked for, not waited for.
         *
         * The probe is one request and the boot sequence runs straight through it.
         * If it comes back saying we are somebody, the name and the crab change
         * underneath a screen that is already up — which is the right way round.
         * A runner that shows a spinner before you can jump has traded the thing
         * it is good at for the thing it is merely correct about.
         */
        this.notice = AUTH.notice;
        this.signOutAt = 0;
        this.authLabel = '';
        this.authFace = '';
        AUTH.probe().then(() => this.applyIdentity());

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

        // The two things a run has to be reproducible from. `runStep` is the
        // clock every recorded input is stamped against, and it counts only
        // simulation steps — never boot frames, never paused frames.
        this.runStep = 0;
        this.trace = [];

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
        // The board used to be reachable only by pressing L, which on a phone is
        // not reachable at all. A leaderboard nobody can open is not one.
        on('boardBtn', () => this.toggleBoard());
        // Sign-in lives in the titlebar rather than on a game screen because it is
        // the one control that has to be reachable from every screen, on a phone,
        // including the first-run one where the keyboard is busy being a keyboard.
        on('authBtn', () => this.authClick());

        this.bindHandleField();

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
        press(btnJump, () => this.primary(), () => this.release());
        press(btnDuck, () => this.secondary(true), () => this.secondary(false));
        press(btnThink, () => this.tryThink());

        // Tapping the board itself: top half jumps, bottom half ducks.
        const cv = this.term.canvas;
        cv.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.sound.resume();
            const r = cv.getBoundingClientRect();
            // On the handle screen a tap means "let me type", and it has to focus
            // the field from inside the gesture — iOS only opens its keyboard for
            // a focus() that a user action caused.
            if (this.state === STATE.PROFILE) { this.focusHandle(); return; }
            if (this.state !== STATE.PLAYING) { this.primary(); return; }
            if ((e.clientY - r.top) / r.height > 0.62) this.secondary(true);
            else this.primary();
        });
        cv.addEventListener('pointerup', (e) => {
            e.preventDefault();
            this.secondary(false);
            this.release();
        });
        cv.addEventListener('pointercancel', () => { this.secondary(false); this.release(); });
    }

    /* ------------------------------------------------------------------ *
     * The handle field
     *
     * A hidden `<input>` is the only way a canvas game can ask for text on a
     * phone. Everything below keeps it and `this.draft` agreeing, and routes its
     * two non-text keys — enter and escape — the same way the canvas would.
     * ------------------------------------------------------------------ */

    bindHandleField() {
        const inp = document.getElementById('handleInput');
        this.handleInput = inp || null;
        if (!inp) return;

        // The field is authoritative while it has focus, but the normaliser is
        // authoritative over the field: whatever the OS keyboard offers, what
        // lands in `draft` is what the server would accept, and the field is
        // written back so the two never disagree.
        inp.addEventListener('input', () => {
            const next = normaliseHandle(inp.value).slice(0, HANDLE_MAX);
            if (next !== inp.value) inp.value = next;
            if (next !== this.draft) {
                this.draft = next;
                this.sound.playBoot(this.draft.length);
            }
        });

        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.commitProfile(); return; }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (!PROFILE.isNew) { this.state = STATE.MENU; this.sound.playClick(); }
                return;
            }
            // Up is sign-in, the same as it is when the field is not focused.
            if (e.key === 'ArrowUp') { e.preventDefault(); this.authClick(); return; }
            // Left and right belong to the colour picker on this screen, which the
            // panel says out loud. A fourteen-character field does not need a
            // caret you can walk, and backspace still edits.
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.cycleSkin(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); this.cycleSkin(1); }
        });
    }

    focusHandle() {
        const inp = this.handleInput;
        if (!inp) return;
        inp.value = this.draft;
        try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    }

    blurHandle() {
        const inp = this.handleInput;
        if (inp && document.activeElement === inp) inp.blur();
    }

    /* ================================================================== *
     * Input
     * ================================================================== */

    bindInput() {
        const JUMP = new Set(['Space', 'ArrowUp', 'KeyW', 'Enter']);
        const DUCK = new Set(['ArrowDown', 'KeyS']);
        // Where `g` means github. Every screen that mentions it, and no others:
        // not the profile screen, where every letter belongs to the handle field,
        // and not mid-run, where it would navigate away from a live game.
        const SIGNABLE = new Set([STATE.MENU, STATE.DEAD, STATE.BOARD]);

        window.addEventListener('keydown', (e) => {
            if (e.repeat && !DUCK.has(e.code)) return;
            this.sound.resume();

            // The handle field handles its own keys. Without this, typing "k" with
            // the field focused would reach both it and `profileKey` and land in
            // the draft twice.
            if (this.handleInput && e.target === this.handleInput) return;

            // The profile screen owns the whole keyboard while it is up — it has
            // a text field, and a text field cannot share letters with hotkeys.
            if (this.state === STATE.PROFILE) { this.profileKey(e); return; }

            // A focused chrome button owns space and enter, so tabbing to
            // "pause" and hitting space presses the button instead of jumping.
            const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
            if (onButton && (e.code === 'Space' || e.code === 'Enter')) return;

            if (this.state === STATE.BOARD) {
                if (e.code === 'KeyR') { e.preventDefault(); this.openBoard(); return; }
                if (e.code === 'Escape' || e.code === 'KeyL' || JUMP.has(e.code)) {
                    e.preventDefault();
                    this.toggleBoard();
                    return;
                }
            }

            if (JUMP.has(e.code)) { e.preventDefault(); this.primary(); return; }
            if (DUCK.has(e.code)) { e.preventDefault(); this.secondary(true); return; }
            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); this.tryThink(); return; }
            if (e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); this.togglePause(); return; }
            if (e.code === 'KeyC' && (this.state === STATE.MENU || this.state === STATE.DEAD)) {
                this.openProfile(); return;
            }
            if (e.code === 'KeyL' && (this.state === STATE.MENU || this.state === STATE.DEAD)) {
                this.toggleBoard(); return;
            }
            if (e.code === 'KeyG' && SIGNABLE.has(this.state)) {
                this.authClick(); return;
            }
            if (e.code === 'KeyT') { this.toggleTheme(); return; }
            if (e.code === 'KeyM') { this.toggleMute(); return; }
            if (e.code === 'KeyF') { this.term.effects = !this.term.effects; this.term.scanlines = this.term.effects; return; }
        });

        window.addEventListener('keyup', (e) => {
            if (this.state === STATE.PROFILE) return;
            if (JUMP.has(e.code)) this.release();
            if (DUCK.has(e.code)) this.secondary(false);
        });

        window.addEventListener('blur', () => {
            this.secondary(false);
            this.release();
            if (this.state === STATE.PLAYING) this.togglePause();
        });
    }

    /* ------------------------------------------------------------------ *
     * Recording
     *
     * Every input that can change the outcome goes into the trace at the step it
     * was pressed on. This is the honest half of the leaderboard: the server
     * replays exactly this list against exactly this seed and computes the score
     * itself, so a submitted number is a claim it can check rather than one it
     * has to trust.
     * ------------------------------------------------------------------ */

    record(code) {
        if (this.trace && this.trace.length < TRACE_MAX_EVENTS) {
            this.trace.push([this.runStep, code]);
        }
    }

    /** Space and friends: context-sensitive, so one key always does the obvious thing. */
    primary() {
        switch (this.state) {
            case STATE.BOOT:
                // Skipping the boot sequence lands wherever a fresh visitor
                // should land: at the "who are you" screen, or straight at the menu.
                this.state = PROFILE.isNew ? STATE.PROFILE : STATE.MENU;
                if (this.state === STATE.PROFILE) this.focusHandle();
                break;
            case STATE.MENU:
                this.startRun();
                break;
            case STATE.PLAYING:
                this.record('j');
                this.hero.requestJump(this.sound);
                break;
            case STATE.PAUSED:
                this.togglePause();
                break;
            case STATE.DEAD:
                if (this.deathSteps > 40) this.startRun();
                break;

            // The two screens below have no keyboard on a phone, so the jump
            // button has to carry them. Both do the one thing that screen is for.
            case STATE.PROFILE:
                this.commitProfile();
                break;
            case STATE.BOARD:
                this.toggleBoard();
                break;
        }
    }

    secondary(down) {
        // Off the run, duck is the left-hand button on the touch pad, and each
        // screen that has no keyboard borrows it for its own left-hand action.
        if (this.state === STATE.PROFILE) {
            if (down) this.cycleSkin(-1);
            return;
        }
        if (this.state === STATE.BOARD) {
            if (down) this.toggleBoard();
            return;
        }
        if (this.state !== STATE.PLAYING) return;
        this.record(down ? 'd' : 'D');
        const was = this.hero.ducking;
        this.hero.setDucking(down);
        if (down && !was && this.hero.grounded) this.sound.playDuck();
    }

    /** Letting go of jump. Routed through the game so it lands in the trace. */
    release() {
        if (this.state === STATE.PLAYING) this.record('J');
        this.hero.releaseJump();
    }

    startRun(seed) {
        this.seed = (seed >>> 0) || newSeed();
        RNG.play.seed(this.seed);
        this.resetRun();
        this.state = STATE.PLAYING;
        this.submit = { state: 'idle', rank: -1, reason: '' };
        // Whatever the sign-in had to say has been on screen since the menu. It has
        // no business over a run.
        this.notice = '';
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
        // The think button is the middle of the touch pad; the two keyboard-less
        // screens borrow it too.
        if (this.state === STATE.PROFILE) { this.cycleSkin(1); return; }
        if (this.state === STATE.BOARD) { this.openBoard(); return; }
        if (this.state !== STATE.PLAYING || this.thinking) return;
        this.record('t');
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
     * Profile — handle and crab colour
     * ================================================================== */

    /* ================================================================== *
     * Identity
     * ================================================================== */

    /**
     * Reconciles the game with whatever the sign-in probe found.
     *
     * Called after the probe and after every sign-in and sign-out, because all
     * three can change the player's name and their crab while a screen is already
     * on the glass. One function so the three paths cannot drift apart.
     */
    applyIdentity() {
        if (AUTH.member) {
            PROFILE.adopt(AUTH.login, AUTH.skin);
            // A signed-in player is never new, so a first-run screen asking for a
            // handle is now asking for nothing. Let them out of it.
            if (this.state === STATE.PROFILE) this.state = STATE.MENU;
        } else if (PROFILE.isGithub) {
            // Signed out: hand back whatever this browser called itself before.
            PROFILE.release();
        }

        this.draft = PROFILE.name;
        this.skinIndex = Math.max(0, GLYPHS.SKIN_IDS.indexOf(PROFILE.skin));
        if (AUTH.notice) {
            this.notice = AUTH.notice;
            AUTH.notice = '';
        }
        this.signOutAt = 0;
    }

    /** The titlebar button. Signs in, or arms and then confirms a sign-out. */
    authClick() {
        if (!AUTH.member) {
            if (!AUTH.available) {
                this.notice = 'this deploy has no github app wired up';
                this.sound.playClick();
                return;
            }
            this.sound.playClick();
            AUTH.signIn();     // leaves the page
            return;
        }

        // Two taps to sign out. One tap is a misclick, and a misclick that signs
        // you out of the board you were reading is a bad trade for one saved tap.
        if (this.signOutAt && this.tick - this.signOutAt < 300) {
            this.signOutAt = 0;
            this.sound.playClick();
            AUTH.signOut().then(() => this.applyIdentity());
            return;
        }
        this.signOutAt = this.tick;
        this.sound.playClick();
    }

    /**
     * Keeps the titlebar button labelled — and faced — with the truth.
     *
     * Called from `draw`, every frame, which is affordable because it writes to the
     * DOM only when the label actually changes — and it has to be every frame,
     * since the armed sign-out expires on a tick rather than on an event.
     */
    syncAuthButton() {
        const el = document.getElementById('authBtn');
        if (!el) return;

        let label;
        if (AUTH.state === 'unknown') label = '…';
        else if (!AUTH.member) label = AUTH.available ? 'sign in' : 'guest';
        else if (this.signOutAt && this.tick - this.signOutAt < 300) label = 'sign out?';
        else label = `@${AUTH.login}`;

        if (label !== this.authLabel) {
            this.authLabel = label;
            const text = document.getElementById('authLabel');
            if (text) text.textContent = label;
            el.classList.toggle('chrome-btn--on', AUTH.member && label[0] === '@');
            el.disabled = AUTH.state === 'unknown';
        }

        this.syncAvatar(el);
    }

    /**
     * Puts the player's github face next to their name.
     *
     * github.com/<login>.png is the whole of it: the login *is* the URL, so there
     * is no avatar field to fetch, cache, or watch go stale when somebody changes
     * their picture. The browser's own image cache is the only cache involved.
     *
     * Guarded on the login rather than on the label, so arming a sign-out — which
     * does change the label — does not throw the image away and fetch it again a
     * second later. And it survives failure quietly: a 404, a blocked request, or
     * a deploy someone is reading over dodgy hotel wifi hides the element rather
     * than leaving a broken-image glyph in the titlebar.
     */
    syncAvatar(el) {
        const img = document.getElementById('authAvatar');
        if (!img) return;

        const login = AUTH.member ? AUTH.login : '';
        if (login === this.authFace) return;
        this.authFace = login;

        el.classList.toggle('chrome-btn--face', !!login);
        if (!login) {
            img.hidden = true;
            img.removeAttribute('src');
            return;
        }

        img.onerror = () => {
            img.hidden = true;
            el.classList.remove('chrome-btn--face');
        };
        // 18px on the glass, so ask for 2x and let github do the scaling — the
        // unsized original is a 460px png for a hole the size of one character.
        img.src = `https://github.com/${encodeURIComponent(login)}.png?size=40`;
        img.hidden = false;
    }

    openProfile() {
        this.draft = PROFILE.name;
        this.skinIndex = Math.max(0, GLYPHS.SKIN_IDS.indexOf(PROFILE.skin));
        this.state = STATE.PROFILE;
        this.sound.playClick();
        // Called from a keypress or a click, so this focus is inside a gesture and
        // a phone will actually raise its keyboard for it.
        this.focusHandle();
    }

    /** The live preview colour, which is the skin under the cursor, not the saved one. */
    get draftSkin() {
        return GLYPHS.SKIN_IDS[this.skinIndex] || 'coral';
    }

    cycleSkin(dir) {
        const n = GLYPHS.SKIN_IDS.length;
        this.skinIndex = (this.skinIndex + dir + n) % n;
        this.sound.playClick();
    }

    commitProfile() {
        // Enter on an empty field is a legitimate answer — plenty of people do not
        // want to name themselves to play a browser game, and they still deserve
        // a board of their own. It just comes pre-filled.
        PROFILE.save(this.draft || suggestHandle(), this.draftSkin);
        this.draft = PROFILE.name;
        // Signed in, the colour belongs to the account rather than to this browser,
        // so it goes to the server and is waiting on your phone.
        if (AUTH.member) AUTH.saveSkin(PROFILE.skin);
        this.state = STATE.MENU;
        this.sound.playMilestone();
    }

    profileKey(e) {
        const k = e.key;
        if (k === 'Enter') { e.preventDefault(); this.commitProfile(); return; }
        if (k === 'Escape') {
            e.preventDefault();
            if (!PROFILE.isNew) { this.state = STATE.MENU; this.sound.playClick(); }
            return;
        }
        // Up is sign-in on this screen. It has to be a non-printable key: every
        // letter on this screen belongs to the handle field, so there is no room
        // for a mnemonic like "g".
        if (k === 'ArrowUp') { e.preventDefault(); this.authClick(); return; }
        if (k === 'Backspace') { e.preventDefault(); this.draft = this.draft.slice(0, -1); return; }
        if (k === 'ArrowLeft') { e.preventDefault(); this.cycleSkin(-1); return; }
        if (k === 'ArrowRight' || k === 'Tab') { e.preventDefault(); this.cycleSkin(1); return; }

        // One printable character at a time, run through the same normaliser the
        // server uses, so what you see typed is exactly what gets stored.
        if (k.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        if (this.draft.length >= HANDLE_MAX) return;
        const next = normaliseHandle(this.draft + k);
        if (next !== this.draft) {
            this.draft = next;
            this.sound.playBoot(this.draft.length);
        }
    }

    /* ================================================================== *
     * Leaderboard
     * ================================================================== */

    openBoard() {
        this.state = STATE.BOARD;
        this.sound.playClick();
        BOARD.load(10);
    }

    /**
     * What the titlebar's "board" button does. It has to work from wherever the
     * player is, including out of a run — so a run in progress is paused rather
     * than abandoned, and closing the board puts them back on it.
     */
    toggleBoard() {
        if (this.state === STATE.BOARD) {
            this.state = this.boardFrom || STATE.MENU;
            this.boardFrom = null;
            this.sound.playClick();
            return;
        }
        if (this.state === STATE.BOOT) return;
        if (this.state === STATE.PROFILE) return;   // finish naming yourself first
        this.boardFrom = this.state === STATE.PLAYING ? STATE.PAUSED : this.state;
        if (this.state === STATE.PLAYING) {
            this.secondary(false);
            this.release();
        }
        this.openBoard();
    }

    /**
     * Keeps the DOM chrome telling the truth about the screen underneath it.
     *
     * Runs once per state change, from `draw`, rather than at each transition —
     * `state` is written in eight places and a sync you have to remember to call
     * is a sync that will be forgotten.
     */
    syncTouchUi() {
        if (this.uiState === this.state) return;
        this.uiState = this.state;

        if (this.state !== STATE.PROFILE) this.blurHandle();

        const board = document.getElementById('boardBtn');
        if (board) board.textContent = this.state === STATE.BOARD ? 'back' : 'board';

        // The touch pad is the only control a phone has, so on the two screens
        // with no keyboard it stops saying "duck / think / jump" and says what it
        // actually does there.
        const PADS = {
            [STATE.PROFILE]: [['‹', 'colour'], ['›', 'colour'], ['✓', "that's me"]],
            [STATE.BOARD]:   [['‹', 'back'],   ['↻', 'refresh'], ['✓', 'back']],
        };
        const pad = PADS[this.state] || [['↓', 'duck'], ['◆', 'think'], ['↑', 'jump']];
        ['touchDuck', 'touchThink', 'touchJump'].forEach((id, i) => {
            const el = document.getElementById(id);
            if (!el) return;
            const key = el.querySelector('.pad-key');
            const label = el.querySelector('.pad-label');
            if (key) key.textContent = pad[i][0];
            if (label) label.textContent = pad[i][1];
        });
    }

    /**
     * Hands the finished run to the board. The trace goes with it; the score does
     * not have to be believed.
     */
    submitRun() {
        if (this.score < TUNING.submitFloor) {
            this.submit = { state: 'skipped', rank: -1, reason: '' };
            return;
        }

        const run = {
            v: RULES_VERSION,
            name: PROFILE.name,
            skin: PROFILE.skin,
            seed: this.seed,
            score: this.score,
            distance: Math.floor(this.world.distance),
            biome: this.world.biome.name,
            steps: this.runStep,
            trace: encodeTrace(this.trace),
        };

        /*
         * Known to be anonymous: keep the run on the local board and say so, with
         * no round trip that could only come back 401. The invitation to sign in is
         * worth more when it arrives instantly than when it arrives as a rejection.
         */
        if (AUTH.state === 'anon') {
            BOARD.writeLocal(run);
            this.submit = { state: 'anon', rank: -1, reason: '', available: AUTH.available };
            return;
        }

        this.submit = { state: 'sending', rank: -1, reason: '' };
        BOARD.submit(run).then((r) => {
            if (r.ok) this.submit = { state: 'ranked', rank: r.rank, reason: '', ephemeral: !!r.ephemeral };
            else if (r.needsAuth) this.submit = { state: 'anon', rank: -1, reason: '', available: r.available };
            else if (r.local) this.submit = { state: 'local', rank: -1, reason: '' };
            else this.submit = { state: 'rejected', rank: -1, reason: r.reason || 'rejected' };
        });
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
            this.term.shakeX = (RNG.look.next() - 0.5) * s;
            this.term.shakeY = (RNG.look.next() - 0.5) * s;
        } else {
            this.term.shakeX = this.term.shakeY = 0;
        }
        this.term.flash *= 0.86;

        if (this.banner) {
            this.banner.life--;
            if (this.banner.life <= 0) this.banner = null;
        }

        if (this.state === STATE.MENU || this.state === STATE.PROFILE || this.state === STATE.BOARD) {
            // The menu is the game, idling. The world already scrolls, so the
            // first thing you see is motion rather than a card — but the metre
            // count is a run statistic, so the scenery moves and the odometer
            // does not.
            const idle = TUNING.baseSpeed * 0.55;
            this.world.step(idle, false);
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
        if (this.bootChars > total + 60) this.state = PROFILE.isNew ? STATE.PROFILE : STATE.MENU;
    }

    stepPlaying() {
        // The run clock. Every recorded input is stamped against this, and it
        // counts simulation steps only — not boot frames and not paused frames —
        // which is what lets the server line the trace up with its own replay.
        this.runStep++;

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
            // The run clock, not the wall clock: `tick` keeps counting through the
            // menu, so it differs between a browser session and a server replay.
            // Only the loop hazard's animation reads it, and its frames all share
            // a hitbox — but a simulation should not take that on faith.
            h.step(world, this.runStep);
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
        this.submitRun();
        this.setStatusButtons();
    }

    /* ================================================================== *
     * Drawing
     * ================================================================== */

    draw() {
        const t = this.term;
        t.clear();
        this.syncTouchUi();
        this.syncAuthButton();

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
        if (this.state === STATE.PROFILE) this.drawProfile();
        if (this.state === STATE.BOARD) this.drawBoard();
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

        // The hero is the one thing on screen wearing the player's colours. The
        // remap covers the sprite and the face overlay in one hook, which is the
        // reason it lives in the renderer rather than in the sprite table.
        const skin = this.state === STATE.PROFILE ? GLYPHS.skinRecolor(this.draftSkin) : PROFILE.recolor;
        t.skinned(skin, () => this.hero.draw(t, this.tick));
    }

    drawHud() {
        const t = this.term;
        const b = this.world.biome;

        // Left: where you are. The path is the level name, and the note hangs off
        // it behind a single separator with one column of air either side.
        t.put(1, 0, '●', b.accent);
        t.text(3, 0, b.name, 'fg');
        const noteX = 3 + b.name.length + 1;
        t.put(noteX, 0, '·', 'dim');
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

        // Token count sits just clear of the "shift" prompt, so the two never
        // run into each other when the meter fills.
        if (this.tokensTaken > 0) {
            t.text(33, 1, `◆ ${this.tokensTaken}`, 'cyan', 0.8);
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
                hint = 'space  run    c  crab    l  board    ↓  duck    shift  think    t  theme    m  mute';
                break;
            case STATE.PROFILE:
                mode = ' SETUP '; modeColor = 'cyan';
                // Signed in there is no handle to type, so the statusline must not
                // offer it. A hint for a key that does nothing is worse than none.
                hint = PROFILE.isGithub
                    ? '← →  colour    enter  done    ↑  sign out'
                    : 'type  handle    ← →  colour    enter  save';
                break;
            case STATE.BOARD:
                mode = ' BOARD '; modeColor = 'amber';
                hint = 'esc  back    r  refresh';
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
                hint = 'space  run again    l  board    c  crab    t  theme';
        }

        for (let x = 0; x < GEO.cols; x++) t.put(x, y, ' ', 'fg', 1);
        t.text(1, y, mode, modeColor);
        t.text(2 + mode.length, y, hint, 'dim');

        // The odometer belongs to a run. Showing it on the menu made the number
        // climb while nobody was playing.
        if (this.state === STATE.PLAYING || this.state === STATE.PAUSED || this.state === STATE.DEAD) {
            const dist = `${fmt(this.world.distance)} m`;
            t.text(GEO.cols - 1 - dist.length, y, dist, 'dim');
        } else if (PROFILE.name) {
            t.text(GEO.cols - 1 - PROFILE.name.length, y, PROFILE.name, 'dim');
        }
    }

    drawBanner() {
        const t = this.term;
        const b = this.banner;
        const p = b.life / b.max;
        // Ease in fast, hold, fade out — so it registers without lingering.
        const alpha = Math.min(1, Math.min(p * 4, (1 - p) * 6 + 0.2));
        const head = `→  ${b.name}`;
        t.centeredHalo(4, head, this.world.biome.accent, alpha);
        t.centeredHalo(5, b.note, 'fgDim', alpha * 0.8);
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

        // The masthead gets the whole band to itself. Letting parallax stars and
        // clouds drift through the middle of the wordmark was the one thing that
        // made the front of the game look accidental rather than composed.
        t.band(2, 9);
        t.blit(T, x, 3 + drift, { tint: 'claw' });

        // No drop shadow. A one-cell offset is a whole glyph in a character
        // grid, so a shadow of row N lands exactly on row N+1 of the wordmark
        // and fills its gaps — every vertical stroke came out doubled and
        // "CLAW'D" read as `|||___ |||___`. Depth here comes from the palette
        // and the bloom, not from a second copy of the letters.

        t.centered(9, 'an endless runner about shipping code', 'fgDim');

        // Who is about to run, wearing the colour they picked. This is the line
        // that makes the board feel like it has your name on it before you start.
        const handle = PROFILE.name || 'unnamed';
        const label = 'running as';
        // A signed-in name is a claim the server will back, so it gets said out
        // loud. It is also the only visible difference between a name that owns its
        // row on the board and a name that is just a word this browser remembers.
        const badge = PROFILE.isGithub ? '  ✓ github' : '';
        const wide = label.length + 8 + handle.length + badge.length;
        const cx = Math.round((GEO.cols - wide) / 2);
        t.clearRect(cx - 2, 11, wide + 4, 1);
        t.text(cx, 11, label, 'dim');
        t.skinned(PROFILE.recolor, () => {
            t.blit(GLYPHS.CLAWD.mini, cx + label.length + 2, 11, { tint: 'claw' });
        });
        t.text(cx + label.length + 8, 11, handle, 'fg');
        if (badge) t.text(cx + label.length + 8 + handle.length, 11, badge, 'ok', 0.85);

        const blink = Math.sin(this.tick * 0.09) > -0.3;
        const cta = 'press  space  to run';
        t.centeredHalo(13, cta, 'fg', blink ? 1 : 0.35);
        t.put(Math.round((GEO.cols - cta.length) / 2) + cta.length + 1, 13, blink ? '█' : ' ', 'claw', 0.9);

        // Three lines of rules, in the order you need them.
        const rules = [
            ['jump', 'bugs, conflicts and node_modules sit on the ground'],
            ['duck', 'rate limits and timeouts fly at head height'],
            ['◆', 'tokens charge extended thinking — shift slows the world'],
        ];
        const lx = Math.round((GEO.cols - 62) / 2);
        rules.forEach(([key, why], i) => {
            const y = 16 + i;
            t.clearRect(lx - 2, y, why.length + 11, 1);
            t.text(lx, y, key, i === 2 ? 'cyan' : 'claw');
            t.text(lx + 7, y, why, 'dim');
        });

        if (this.best > 0) {
            t.centeredHalo(20, `best  ${fmt(this.best)}`, 'amber', 0.8);
        }

        /*
         * The bottom line: either what just happened to your sign-in, or the reason
         * to bother with one.
         *
         * It sits under the rules rather than over the title because it is the least
         * urgent thing on the screen. Nobody arrives at a runner wanting to log in,
         * so the invitation waits until after the part that explains how to jump.
         */
        let line = '', tone = 'fgDim';
        if (this.notice) {
            line = this.notice;
            tone = 'cyan';
        } else if (!AUTH.member && AUTH.available) {
            line = 'g   sign in with github to claim a row on the global board';
        } else if (AUTH.state === 'offline') {
            line = 'offline — runs are kept in this browser';
            tone = 'dim';
        }
        if (line) t.centeredHalo(22, line, tone, 0.9);
    }

    /* ---------------- profile ---------------- */

    /**
     * The first thing a new player sees, framed as the boot sequence asking who
     * it is talking to. It is one screen because the two questions belong
     * together: a leaderboard row is a handle and a crab, and this is the row.
     */
    drawProfile() {
        const t = this.term;
        t.dimAll(0.16);

        const w = 58;
        const h = 18;
        const x = Math.round((GEO.cols - w) / 2);
        const y = 4;
        const ix = x + 3;
        const skin = GLYPHS.skinById(this.draftSkin);

        t.box(x, y, w, h, {
            style: 'round', color: 'cyan',
            title: PROFILE.isGithub ? 'your crab' : PROFILE.isNew ? 'first run' : 'your crab',
            titleColor: 'cyanHot',
        });

        /*
         * The top block asks a different question depending on who is asking it.
         *
         * Signed in, the name is not a question at all — it came from GitHub and the
         * server will not accept any other, so offering a text field here would be
         * offering to edit something that cannot be edited. It is stated instead.
         */
        t.text(ix, y + 2, '$ whoami', 'fgDim');
        t.put(ix, y + 3, '›', 'cyan');

        if (PROFILE.isGithub) {
            t.text(ix + 2, y + 3, PROFILE.name, 'fg');
            t.text(ix + 2 + PROFILE.name.length + 2, y + 3, '✓ github', 'ok');
            t.text(ix, y + 4, 'this name is yours — nobody else can take it', 'dim');
            t.text(ix, y + 5, '↑   sign out', 'fgDim');
        } else {
            t.text(ix + 2, y + 3, this.draft, 'fg');
            const caret = Math.sin(this.tick * 0.12) > -0.2 ? '█' : ' ';
            t.put(ix + 2 + this.draft.length, y + 3, caret, 'clawHot', 0.9);

            const room = HANDLE_MAX - this.draft.length;
            const note = this.draft
                ? `${room} character${room === 1 ? '' : 's'} left`
                : 'enter picks one for you';
            t.text(ix, y + 4, note, 'dim');

            // The one place worth being blunt about what a typed name is worth. A
            // player who reads this and shrugs has lost nothing; a player who wanted
            // their score to be theirs now knows what to press.
            if (AUTH.available) {
                t.text(ix, y + 5, '↑', 'cyan');
                t.text(ix + 4, y + 5, 'sign in with github for the global board', 'fgDim');
            }
        }

        t.hline(x + 2, y + 6, w - 4, '─', 'dimmer');

        // Live preview: the actual hero sprite, in the actual skin, so what you
        // choose here is exactly what you will be looking at for the next run.
        const C = GLYPHS.CLAWD;
        const legs = C.legs[Math.floor(this.tick / 9) % C.legs.length];
        t.skinned(GLYPHS.skinRecolor(this.draftSkin), () => {
            t.blit(C.body, ix, y + 8);
            t.blit(legs, ix, y + 13);
            const f = C.faces[Math.sin(this.tick * 0.04) > 0.94 ? 'blink' : 'happy'];
            t.put(ix + 4, y + 10, f.eyes[0], f.eye);
            t.put(ix + 10, y + 10, f.eyes[1], f.eye);
            for (let i = 0; i < f.mouth.length; i++) {
                t.put(ix + 4 + i, y + 11, f.mouth[i], f.lip);
            }
        });

        // Right column: the picker.
        const px = ix + 20;
        t.text(px, y + 8, 'pick a shell', 'fgDim');

        const pick = skin.name;
        t.text(px, y + 10, '‹', 'cyan');
        t.text(px + 3, y + 10, pick, 'clawHot');
        t.text(px + 3 + pick.length + 2, y + 10, '›', 'cyan');
        t.text(px, y + 11, skin.note, 'dim');
        // Signed in, the colour is account-shaped rather than device-shaped, and
        // saying so is the difference between a setting and a possession.
        if (PROFILE.isGithub) t.text(px, y + 12, 'saved to your account', 'ok', 0.7);

        // Position in the set, as dots. Eight skins is few enough to show them all.
        GLYPHS.SKIN_IDS.forEach((id, i) => {
            const on = i === this.skinIndex;
            t.skinned(GLYPHS.skinRecolor(id), () => {
                t.put(px + i * 2, y + 13, on ? '●' : '○', 'claw', on ? 1 : 0.55);
            });
        });

        t.hline(x + 2, y + 15, w - 4, '─', 'dimmer');
        // Enter lands on the menu either way — never straight into a run — so it
        // must not say "start running". The menu is where the controls are, which
        // is exactly what a first-time visitor is about to need.
        t.text(ix, y + 16, PROFILE.isGithub ? 'enter  done'
            : PROFILE.isNew ? "enter  that's me" : 'enter  save', 'fg');
        t.text(ix + 24, y + 16, '← →  colour', 'fgDim');
        if (!PROFILE.isNew) t.text(ix + 39, y + 16, 'esc  back', 'dim');
    }

    /* ---------------- leaderboard ---------------- */

    drawBoard() {
        const t = this.term;
        t.dimAll(0.16);

        const w = 88;
        const h = 19;
        const x = Math.round((GEO.cols - w) / 2);
        const y = 3;
        const ix = x + 3;
        const iw = w - 6;

        const scope = BOARD.scope;
        t.box(x, y, w, h, {
            style: 'round', color: 'amber',
            title: `leaderboard · ${scope}`, titleColor: 'amber',
        });

        // Column heads. Five numbers per row is the most a text table can carry
        // before it stops being readable, so the run is described by exactly five.
        t.text(ix, y + 2, '#', 'fgDim');
        t.text(ix + 5, y + 2, 'crab', 'fgDim');
        t.textRight(ix + 40, y + 2, 'score', 'fgDim');
        t.textRight(ix + 53, y + 2, 'distance', 'fgDim');
        t.text(ix + 57, y + 2, 'reached', 'fgDim');
        t.textRight(ix + iw - 1, y + 2, 'when', 'fgDim');
        t.hline(x + 2, y + 3, w - 4, '─', 'dimmer');

        const rows = BOARD.rows;
        if (BOARD.status === 'loading') {
            const spin = '|/-\\'[Math.floor(this.tick / 4) % 4];
            t.text(ix, y + 5, `${spin} reading the board`, 'cyan');
        } else if (!rows.length) {
            t.text(ix, y + 5, BOARD.message || 'nobody has shipped anything yet', 'dim');
            t.text(ix, y + 7, 'be the first — press esc, then space.', 'fgDim');
        }

        // Recomputed per frame rather than read from BOARD.mine, because signing
        // out while this screen is open changes the answer and nothing refetches.
        // The rule for what counts as "yours" lives in BOARD.myRow().
        const myRow = BOARD.myRow();

        rows.slice(0, 10).forEach((r, i) => {
            const ry = y + 4 + i;
            const mine = i === myRow;
            const nameColor = mine ? 'clawHot' : 'fg';
            const a = mine ? 1 : 0.86;

            // Your own row gets a marker in the gutter. On a board of strangers
            // the only thing anyone looks for first is themselves.
            if (mine) t.put(x + 1, ry, '▸', 'clawHot');
            t.textRight(ix + 1, ry, String(i + 1), i < 3 ? 'amber' : 'dim', a);
            t.skinned(GLYPHS.skinRecolor(r.skin), () => {
                t.blit(GLYPHS.CLAWD.mini, ix + 5, ry, { tint: 'claw', alpha: a });
            });
            // GitHub logins run to 39 characters. The score is right-aligned at
            // ix+40 and the widest one a run can reach is nine columns, so a name
            // may have twenty before the two collide. Cut on screen only — the
            // stored name is whole, and the trailing dash goes with the cut because
            // "github-…" reads as a name and "github-" reads as a bug.
            const shown = r.name.length > 20
                ? `${r.name.slice(0, 19).replace(/-+$/, '')}…`
                : r.name;
            t.text(ix + 11, ry, shown, nameColor, a);
            t.textRight(ix + 40, ry, fmt(r.score), mine ? 'amber' : 'fg', a);
            t.textRight(ix + 53, ry, `${fmt(r.distance)} m`, 'fgDim', a);
            t.text(ix + 57, ry, r.biome.slice(0, 15), 'dim', a);
            t.textRight(ix + iw - 1, ry, ago(r.at), 'dim', a);
        });

        t.hline(x + 2, y + 15, w - 4, '─', 'dimmer');

        // The footnote is the reason the board is worth reading, so it says the
        // true thing for the board you are actually looking at. "Verified on the
        // server", "the name is really theirs" and "stored somewhere that survives
        // the night" are three separate claims, and a deploy can have any subset.
        const footnote = {
            redis: 'every row was replayed on the server, under a github name its owner signed into',
            memory: 'no database on this deploy — verified, but the board resets when the server sleeps',
            local: 'offline — showing runs from this browser only',
        };
        t.text(ix, y + 16, footnote[BOARD.store] || footnote.local, 'dim');
        t.text(ix, y + 17, 'esc  back', 'fg');
        t.text(ix + 13, y + 17, 'r  refresh', 'fgDim');
        // A stranger's board is a wall. Yours is a scoreboard. Say which one this is.
        if (!AUTH.member && AUTH.available && BOARD.store !== 'local') {
            t.text(ix + 28, y + 17, 'g  sign in to join', 'cyan');
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
        const h = 15;
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

        // What happened to the run after it ended. A submitted score is either on
        // the board, kept locally, or turned away — and being told which is the
        // difference between a leaderboard and a wish.
        const s = this.submit;
        let word = '', color = 'dim';
        if (s.state === 'sending') word = 'submitting to the board…';
        else if (s.state === 'ranked') {
            const where = s.rank > 0 ? `#${s.rank}` : 'on the board';
            if (s.ephemeral) {
                // Verified, counted, and gone on the next cold start. Whoever
                // deployed this needs to know that, and they are reading this line.
                word = `${where} · ${PROFILE.name} — no database wired up yet`;
                color = 'amber';
            } else {
                word = `${where} on the board · ${PROFILE.name}`;
                color = 'ok';
            }
        } else if (s.state === 'anon') {
            // Nothing went wrong here: the run counted, there is simply no account
            // to file it under. Phrased as an invitation, in cyan rather than amber,
            // because a player who is not signed in has not made a mistake.
            word = 'saved here only — no account behind it yet';
            color = 'cyan';
        } else if (s.state === 'local') { word = 'saved on this browser · offline'; color = 'fgDim'; }
        else if (s.state === 'rejected') { word = `not accepted — ${s.reason}`; color = 'amber'; }
        else if (s.state === 'skipped') word = `runs under ${TUNING.submitFloor} don't make the board`;
        if (word) t.text(ix, yy + 10, word, color, a);
        // The offer goes directly under the fact it answers, and only when there is
        // an OAuth App to send them to — an invitation to a door that does not exist
        // is worse than no invitation.
        if (s.state === 'anon' && s.available !== false) {
            t.text(ix, yy + 11, 'g   sign in with github to join the board', 'fgDim', a * 0.9);
        }

        const cta = 'space  run again';
        const blink = Math.sin(this.tick * 0.09) > -0.3;
        t.text(ix, yy + 12, cta, 'fg', a * (blink ? 1 : 0.4));
        t.text(ix + 20, yy + 12, 'l  leaderboard', 'fgDim', a);
        t.text(ix + 38, yy + 12, 'c  crab', 'dim', a);

        if (this.isNewBest) {
            const badge = ` new best — ${fmt(this.best)} `;
            t.textOpaque(x + Math.round((w - badge.length) / 2), yy + h - 1, badge, 'amber', a);
        }
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

// `class` and `const` at script top level are lexical, not properties of the
// global object, so the engine has to publish itself like every other module
// here. The server's replay verifier reaches for exactly these.
window.Game = Game;
window.STATE = STATE;
window.TUNING = TUNING;
window.fmt = fmt;

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    if (canvas) window.game = new Game(canvas);
});
