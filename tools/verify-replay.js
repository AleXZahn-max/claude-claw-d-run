/**
 * Claude Claw'd Run — Replay determinism check
 *
 *     node tools/verify-replay.js
 *
 * The leaderboard screen makes a promise: "every score here was replayed on the
 * server before it landed". That promise has a failure mode worse than cheating —
 * if the simulation is not bit-identical between the browser and the server, the
 * verifier rejects *honest* players, and it does it silently, to the ones who
 * played longest.
 *
 * So this is the test. It plays the real game headless with a bot, records the
 * trace the way the browser would, and hands seed + trace to the same
 * api/_replay.js that /api/submit uses. Every number has to come back the same.
 *
 * The recorder is deliberately handicapped compared to the verifier:
 *   · it sits through the boot typewriter and idles on the menu first, so `tick`
 *     and the cosmetic RNG are far out of step with a fresh replay
 *   · it plays several runs back to back through the death panel, so anything
 *     leaking between runs shows up as a mismatch on run 2 and after
 * A pass therefore means more than "the same code gives the same answer": it
 * means nothing outside the seed and the keypresses reaches the score.
 */

const path = require('path');
const { replay, freshGame } = require(path.join(__dirname, '..', 'api', '_replay.js'));
const { encodeTrace, decodeTrace, RULES_VERSION } = require('../js/trace');
const { makeBot } = require('./_bot');

/** Fixed so a failure is reproducible; spread so one lucky seed cannot hide a bug. */
const SEEDS = [1, 2, 99, 0x1234567, 0xdeadbeef, 424242, 0x9e3779b9, 7777777];

/** Steps the bot steers for before it drops the controller and lets the run end. */
const STEER_STEPS = 2400;   // 40 seconds of competent play
const IDLE_LIMIT = 6000;    // how long to wait for an unsteered hero to hit something

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

function makeRecorder() {
    const { sandbox } = freshGame();

    // A named crab, so boot lands on the menu instead of stopping at the
    // first-run profile screen and idling there forever.
    sandbox.PROFILE.save('verifier', 'phosphor');

    const game = new sandbox.Game(sandbox.__canvas);
    game.submitRun = () => {};   // no board client in here, and nothing to submit

    let guard = 0;
    while (game.state === 'boot' && guard++ < 4000) game.step();
    for (let i = 0; i < 90; i++) game.step();   // idling on the menu, world scrolling

    return { sandbox, game };
}

function recordRun(game, bot, seed) {
    game.startRun(seed);

    let steps = 0;
    while (game.state === 'playing' && steps < STEER_STEPS + IDLE_LIMIT) {
        bot(game, steps < STEER_STEPS);
        game.step();
        steps++;
    }

    const out = {
        seed,
        alive: game.state === 'playing',
        score: game.score,
        distance: Math.floor(game.world.distance),
        steps: game.runStep,
        tokens: game.tokensTaken,
        bestCombo: game.bestCombo,
        biome: game.world.biome.name,
        reason: game.deathReason,
        events: game.trace.length,
        trace: encodeTrace(game.trace),
    };

    // Sit through the death panel like a real player would, so the next run
    // starts with the cosmetic RNG, the particle pool and `tick` all somewhere
    // a fresh replay could never guess.
    for (let i = 0; i < 120; i++) game.step();
    return out;
}

/* ------------------------------------------------------------------ *
 * Checking
 * ------------------------------------------------------------------ */

const FIELDS = ['score', 'distance', 'steps', 'tokens', 'bestCombo', 'biome', 'reason'];

function check(rec) {
    const events = decodeTrace(rec.trace);
    if (events === null) return { ok: false, why: 'trace failed to decode' };
    if (events.length !== rec.events) {
        return { ok: false, why: `round trip lost events (${rec.events} → ${events.length})` };
    }

    const out = replay(rec.seed, events);
    if (!out.ok) return { ok: false, why: `replay refused: ${out.reason}` };

    const bad = FIELDS.filter((f) => out[f] !== rec[f])
        .map((f) => `${f} ${JSON.stringify(rec[f])} → ${JSON.stringify(out[f])}`);
    if (out.unusedEvents !== 0) bad.push(`${out.unusedEvents} events left unconsumed`);
    if (bad.length) return { ok: false, why: bad.join(', ') };

    // Twice, to catch a verifier that carries state between calls.
    const again = replay(rec.seed, decodeTrace(rec.trace));
    const drift = FIELDS.filter((f) => again[f] !== out[f]);
    if (drift.length) return { ok: false, why: `second replay differs: ${drift.join(', ')}` };

    // And once with the keypresses thrown away. If a hero who never touches a
    // key scores the same, the replay is ignoring the trace and every check
    // above is passing for the wrong reason.
    const mute = replay(rec.seed, []);
    if (mute.ok && mute.score >= out.score) {
        return { ok: false, why: `inputs had no effect (idle run scored ${mute.score})` };
    }

    return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`replay determinism · rules v${RULES_VERSION} · node ${process.version}\n`);

const { sandbox, game } = makeRecorder();
console.log(`recorder ready  state=${game.state}  tick=${game.tick}\n`);
console.log(`  ${pad('seed', 12)}${num('score', 8)}${num('steps', 8)}${num('events', 8)}${num('trace', 8)}  result`);
console.log(`  ${'─'.repeat(52)}`);

let failures = 0;
const t0 = process.hrtime.bigint();

for (const seed of SEEDS) {
    const rec = recordRun(game, makeBot(sandbox), seed);
    const res = rec.alive
        ? { ok: false, why: 'bot never died — run did not terminate' }
        : check(rec);

    if (!res.ok) failures++;
    console.log(
        `  ${pad('0x' + seed.toString(16), 12)}${num(rec.score, 8)}${num(rec.steps, 8)}` +
        `${num(rec.events, 8)}${num(rec.trace.length + 'b', 8)}  ` +
        (res.ok ? `ok · ${rec.reason}` : `FAIL · ${res.why}`)
    );
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\n  ${SEEDS.length} runs, ${failures} mismatch${failures === 1 ? '' : 'es'}, ${ms.toFixed(0)}ms`);

if (failures) {
    console.log('\n  A mismatch here is a bug in the simulation, not in a player.');
    console.log('  Something below the drawing layer read the wall clock, Math.random,');
    console.log('  RNG.look, or `tick` — find it before shipping the board.\n');
    process.exit(1);
}
console.log('  every recorded run replayed to the same score.\n');
