/**
 * Claude Claw'd Run — Server-side replay
 *
 * This is the leaderboard's whole reason to exist. A score arriving from a
 * browser is an assertion by code the player controls; anyone with devtools can
 * type `game.score = 99999`. So the client does not send a score to be believed,
 * it sends the seed and the keypresses, and this file runs the game again and
 * works out the score itself.
 *
 * It runs *the game's own files* — the same js/entities.js the browser loaded —
 * inside a fresh VM context, with the handful of browser objects the engine
 * touches stubbed out. Not a reimplementation: a reimplementation would drift
 * from the real physics within a week and start rejecting honest runs.
 *
 * The simulation is deterministic because it was built to be:
 *   · a fixed 60Hz step, so there is no frame-rate dependence to reproduce
 *   · two RNG streams, and only the seeded one touches spawning
 *   · no Math.sin or Math.cos anywhere below the drawing layer, so nothing
 *     depends on a platform's transcendental implementation
 *   · a run clock that counts simulation steps only
 * Drawing is never called here at all, which is why the canvas stub can be a
 * handful of empty functions.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Load order matters: the same order index.html uses, minus the board client. */
const FILES = [
    'rng.js', 'trace.js', 'glyphs.js', 'terminal.js', 'profile.js',
    'audio.js', 'particles.js', 'entities.js', 'game.js',
];

/** Compile once per instance; a cold start pays for it, requests after do not. */
const scripts = new Map();

function compile(files) {
    const root = path.join(__dirname, '..', 'js');
    return files.map((f) => {
        if (!scripts.has(f)) {
            scripts.set(f, new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), {
                filename: `js/${f}`,
            }));
        }
        return scripts.get(f);
    });
}

/** Everything the engine reaches for that a server does not have. */
function makeSandbox() {
    const ctx2d = () => ({
        font: '', textBaseline: '', textAlign: '', fillStyle: '', globalAlpha: 1,
        globalCompositeOperation: '', filter: '',
        setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {},
        save() {}, restore() {}, translate() {}, fillText() {},
        measureText: (s) => ({ width: s.length * 6 }),
        createPattern: () => ({}),
        createRadialGradient: () => ({ addColorStop() {} }),
    });
    const canvas = () => ({
        width: 0, height: 0,
        getContext: ctx2d,
        addEventListener() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 1120, height: 560 }),
    });

    const gameCanvas = canvas();
    const store = new Map();

    // Only the browser objects the engine actually touches. Deliberately no
    // Math/JSON/Array pass-through: a VM context already has its own intrinsics,
    // and handing it the host's instead is how you end up with two Object.prototypes.
    const sandbox = {
        console,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        document: {
            body: { dataset: {} },
            createElement: () => canvas(),
            getElementById: (id) => (id === 'gameCanvas' ? gameCanvas : null),
            addEventListener() {},
            activeElement: null,
        },
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: () => 0,
        addEventListener() {},
        removeEventListener() {},
        devicePixelRatio: 1,
        __canvas: gameCanvas,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    return sandbox;
}

/**
 * A fresh world per replay. Sharing one context between requests would share the
 * RNG state, the particle manager and the stored high score, and a leaderboard
 * whose verifier depends on what it verified last is not a verifier.
 *
 * Exported because the tools in tools/ need the other half of the test: a game
 * instance that *records* a trace, built exactly the way this one is. `extra`
 * lets them add the files a replay has no use for — leaderboard.js, in
 * particular, so the board screen can be rendered headless.
 */
function freshGame(extra = []) {
    const sandbox = makeSandbox();
    const ctx = vm.createContext(sandbox);
    for (const s of compile(FILES.concat(extra))) s.runInContext(ctx, { timeout: 5000 });
    return { sandbox, ctx };
}

const APPLY = {
    j: (g) => g.primary(),
    J: (g) => g.release(),
    d: (g) => g.secondary(true),
    D: (g) => g.secondary(false),
    t: (g) => g.tryThink(),
};

/**
 * Runs `events` against `seed` and reports what actually happened.
 *
 * `maxSteps` is a CPU guard, not a game rule: a serverless function has a wall
 * clock, and a trace claiming four hours of play should be turned away rather
 * than simulated.
 */
function replay(seed, events, maxSteps = 240000) {
    const { sandbox } = freshGame();
    const game = new sandbox.Game(sandbox.__canvas);

    // The harness drives the simulation directly, so nothing that belongs to a
    // browser session should fire: no boot typewriter, and above all no attempt
    // to submit this replay to the very board that is verifying it.
    game.submitRun = () => {};
    game.state = 'menu';
    game.startRun(seed);
    game.trace = null;              // replaying, not recording

    let i = 0;
    while (game.state === 'playing') {
        if (game.runStep > maxSteps) {
            return { ok: false, reason: 'trace too long' };
        }
        while (i < events.length && events[i][0] === game.runStep) {
            const fn = APPLY[events[i][1]];
            if (fn) fn(game);
            i++;
        }
        game.step();
    }

    return {
        ok: true,
        score: game.score,
        distance: Math.floor(game.world.distance),
        steps: game.runStep,
        tokens: game.tokensTaken,
        bestCombo: game.bestCombo,
        biome: game.world.biome.name,
        reason: game.deathReason,
        unusedEvents: events.length - i,
    };
}

module.exports = { replay, freshGame };
