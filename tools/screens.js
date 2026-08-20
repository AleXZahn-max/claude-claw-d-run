/**
 * Claude Claw'd Run — Screen dump
 *
 *     node tools/screens.js            all screens
 *     node tools/screens.js board menu just those
 *
 * Every pixel in this game is a character, which means the layout can be
 * reviewed without a browser: run the real engine, call the real draw code, and
 * print the character buffer. Colour and bloom are missing, but colour is not
 * where box-drawing goes wrong — alignment is, and alignment is all here.
 */

const path = require('path');
const { freshGame } = require(path.join(__dirname, '..', 'api', '_replay.js'));
const { makeBot } = require('./_bot');

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

/** A board with enough shape to test the columns: long handles, big numbers, every skin. */
const FAKE_ROWS = [
    { name: 'kayza', skin: 'coral', score: 48210, distance: 21455, biome: 'production', at: Date.now() - 40e3 },
    { name: 'clawd', skin: 'phosphor', score: 39902, distance: 17800, biome: 'the long tail', at: Date.now() - 9e5 },
    // A GitHub login at nearly full length, because the board has to survive one.
    { name: 'the-longest-github-login-you-can-have', skin: 'ice', score: 33100, distance: 15010, biome: 'code review', at: Date.now() - 2e6 },
    { name: 'anon-crab-47', skin: 'amber', score: 31544, distance: 14002, biome: 'code review', at: Date.now() - 3.2e6 },
    { name: 'segfault-sally', skin: 'ice', score: 22870, distance: 10233, biome: 'staging', at: Date.now() - 7e6 },
    { name: 'verifier', skin: 'plasma', score: 18004, distance: 8110, biome: 'staging', at: Date.now() - 2e7 },
    { name: 'off-by-one', skin: 'ember', score: 9120, distance: 4300, biome: 'the happy path', at: Date.now() - 6e7 },
    { name: 'x', skin: 'steel', score: 4021, distance: 1900, biome: 'the happy path', at: Date.now() - 2e8 },
    { name: 'printf-debug', skin: 'bone', score: 812, distance: 402, biome: 'the happy path', at: 0 },
];

/** What /api/me answers for a visitor with no session, where the app does exist. */
const ME_ANON = { signedIn: false, provider: 'github', available: true };
/** And for one with a session. */
const ME_MEMBER = {
    signedIn: true, provider: 'github', available: true, login: 'kayza', skin: 'coral',
};

/**
 * `me` answers the identity probe the Game fires the moment it is constructed.
 * Left null, nothing answers it and the game settles on 'offline' — which is the
 * right default here, and is also what a file:// visitor sees.
 *
 * The probe is a promise, so a screen drawn in the same tick as construction is
 * drawn before the answer lands. Scenes that care await `settle()` first.
 */
function build({ named = true, me = null } = {}) {
    const { sandbox } = freshGame(['leaderboard.js']);

    // No network in here. The board client is supposed to survive that, so let it.
    sandbox.fetch = (url) => {
        if (me && String(url).startsWith('/api/me')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve(me) });
        }
        return Promise.reject(new Error('no network in the dump tool'));
    };

    if (named) sandbox.PROFILE.save('kayza', 'coral');

    const game = new sandbox.Game(sandbox.__canvas);
    game.submitRun = () => {};
    return { sandbox, game };
}

function run(game, n) { for (let i = 0; i < n; i++) game.step(); }
function bootTo(game) { let g = 0; while (game.state === 'boot' && g++ < 4000) game.step(); }
/** Lets the VM's microtasks drain, so a pending probe has answered. */
const settle = () => new Promise((r) => setImmediate(r));

/** A keydown the profile screen will accept. */
const key = (k) => ({ key: k, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

function show(game, label) {
    const t = game.term;
    game.draw();

    const bar = '─'.repeat(t.cols);
    const tag = ` ${label} `;
    console.log(`\n┌${bar}┐`);
    console.log(`│${tag.padEnd(t.cols, ' ')}│`);
    console.log(`├${bar}┤`);
    for (let y = 0; y < t.rows; y++) {
        let line = '';
        for (let x = 0; x < t.cols; x++) line += t.ch[y * t.cols + x] || ' ';
        console.log(`│${line}│`);
    }
    console.log(`└${bar}┘`);
}

/* ------------------------------------------------------------------ *
 * The screens
 * ------------------------------------------------------------------ */

const SCREENS = {
    boot() {
        const { game } = build();
        run(game, 42);
        show(game, 'BOOT · mid typewriter');
    },

    /** The one screen a first-time visitor cannot avoid. */
    profile() {
        const { game } = build({ named: false });
        bootTo(game);
        if (game.state !== 'profile') throw new Error(`expected profile, got ${game.state}`);
        for (const c of 'kayza') game.profileKey(key(c));
        game.cycleSkin(1);
        game.cycleSkin(1);
        run(game, 30);
        show(game, `PROFILE · first run · typed "${game.draft}" · skin ${game.draftSkin}`);
    },

    /** The same screen reached later, from the menu: has an escape hatch. */
    profileReturn() {
        const { game } = build();
        bootTo(game);
        game.openProfile();
        for (let i = 0; i < 5; i++) game.cycleSkin(1);
        run(game, 30);
        show(game, `PROFILE · returning · skin ${game.draftSkin}`);
    },

    menu() {
        const { game } = build();
        bootTo(game);
        run(game, 140);
        show(game, 'MENU');
    },

    /** With a best score set, which adds a row the fresh menu does not have. */
    menuBest() {
        const { game } = build();
        bootTo(game);
        game.best = 48210;
        run(game, 140);
        show(game, 'MENU · with a best score');
    },

    /** Not signed in, on a deploy that can sign you in: the invitation shows. */
    async menuAnon() {
        const { game } = build({ me: ME_ANON });
        bootTo(game);
        await settle();
        run(game, 140);
        show(game, 'MENU · anonymous, github available');
    },

    /** Signed in: the name carries a badge and the invitation is gone. */
    async menuMember() {
        const { game } = build({ named: false, me: ME_MEMBER });
        bootTo(game);
        await settle();
        game.best = 48210;
        run(game, 140);
        show(game, 'MENU · signed in');
    },

    /**
     * The profile screen for a signed-in player. The one screen the two identities
     * disagree about most: no text field, no character count, a sign-out instead.
     */
    async profileMember() {
        const { game } = build({ named: false, me: ME_MEMBER });
        bootTo(game);
        await settle();
        game.openProfile();
        for (let i = 0; i < 3; i++) game.cycleSkin(1);
        run(game, 30);
        show(game, `PROFILE · signed in · skin ${game.draftSkin}`);
    },

    playing() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0x1234567);
        for (let i = 0; i < 1100; i++) { bot(game); game.step(); }
        show(game, `PLAYING · score ${game.score} · ${game.world.biome.name}`);
    },

    thinking() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0x1234567);
        for (let i = 0; i < 6000 && !game.thinking; i++) { bot(game); game.step(); }
        for (let i = 0; i < 12; i++) { bot(game); game.step(); }
        show(game, game.thinking
            ? `EXTENDED THINKING · score ${game.score}`
            : 'EXTENDED THINKING · never triggered (!)');
    },

    /** A live fetch of the board, which fails, so this is the offline board. */
    async boardOffline() {
        const { sandbox, game } = build();
        bootTo(game);
        for (const r of FAKE_ROWS.slice(0, 4)) sandbox.BOARD.writeLocal(r);
        await sandbox.BOARD.load(10);
        game.state = 'board';
        run(game, 12);
        show(game, `BOARD · store=${sandbox.BOARD.store}`);
    },

    /** The same screen with a database behind it. */
    async boardOnline() {
        const { sandbox, game } = build({ me: ME_ANON });
        bootTo(game);
        sandbox.fetch = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ rows: FAKE_ROWS, store: 'redis' }),
        });
        await sandbox.BOARD.load(10);
        game.state = 'board';
        run(game, 12);
        show(game, `BOARD · store=${sandbox.BOARD.store} · ${sandbox.BOARD.rows.length} rows`);
    },

    /** And with the API up but no Redis, the case that used to lie. */
    async boardEphemeral() {
        const { sandbox, game } = build();
        bootTo(game);
        sandbox.fetch = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ rows: FAKE_ROWS.slice(0, 3), store: 'memory' }),
        });
        await sandbox.BOARD.load(10);
        game.state = 'board';
        run(game, 12);
        show(game, `BOARD · store=${sandbox.BOARD.store}`);
    },

    async boardEmpty() {
        const { sandbox, game } = build();
        bootTo(game);
        sandbox.fetch = () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ rows: [], store: 'redis' }),
        });
        await sandbox.BOARD.load(10);
        game.state = 'board';
        run(game, 12);
        show(game, 'BOARD · empty');
    },

    paused() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0xdeadbeef);
        for (let i = 0; i < 700; i++) { bot(game); game.step(); }
        game.togglePause();
        run(game, 4);
        show(game, 'PAUSED');
    },

    /** Death with the submission accepted, which is the common case. */
    dead() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0x1234567);
        for (let i = 0; i < 9000 && game.state === 'playing'; i++) { bot(game, i < 2000); game.step(); }
        game.submit = { state: 'ranked', rank: 4, reason: '', ephemeral: false };
        run(game, 60);
        show(game, `DEAD · ${game.deathReason} · score ${game.score}`);
    },

    /** Death with the longest message and the widest failure text, to test the box. */
    deadRejected() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0x1234567);
        for (let i = 0; i < 9000 && game.state === 'playing'; i++) { bot(game, i < 2000); game.step(); }
        game.deathReason = 'DependencyHell';
        game.isNewBest = true;
        game.best = game.score;
        game.submit = { state: 'rejected', rank: -1, reason: 'replay mismatch (1923 vs 99999)' };
        run(game, 60);
        show(game, 'DEAD · submission rejected · new best');
    },

    /** And the one the person deploying this will see before wiring up Redis. */
    deadEphemeral() {
        const { sandbox, game } = build();
        bootTo(game);
        const bot = makeBot(sandbox);
        game.startRun(0x9e3779b9);
        for (let i = 0; i < 9000 && game.state === 'playing'; i++) { bot(game, i < 1200); game.step(); }
        game.submit = { state: 'ranked', rank: 1, reason: '', ephemeral: true };
        run(game, 60);
        show(game, 'DEAD · no database wired up');
    },

    /**
     * Death with nobody to file the run under. The one death panel a first-time
     * visitor sees, so the invitation on it matters more than any of the others.
     */
    async deadAnon() {
        const { sandbox, game } = build({ me: ME_ANON });
        bootTo(game);
        await settle();
        const bot = makeBot(sandbox);
        game.startRun(0x1234567);
        for (let i = 0; i < 9000 && game.state === 'playing'; i++) { bot(game, i < 2000); game.step(); }
        game.submit = { state: 'anon', rank: -1, reason: '', available: true };
        run(game, 60);
        show(game, 'DEAD · not signed in');
    },
};

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
    const want = process.argv.slice(2);
    const names = want.length
        ? want.filter((n) => {
            if (SCREENS[n]) return true;
            console.log(`unknown screen "${n}" — have: ${Object.keys(SCREENS).join(' ')}`);
            return false;
        })
        : Object.keys(SCREENS);

    for (const n of names) {
        try {
            await SCREENS[n]();
        } catch (e) {
            console.log(`\n!! ${n}: ${e.message}\n${e.stack.split('\n').slice(1, 4).join('\n')}`);
        }
    }
})();
