/**
 * POST /api/submit
 *
 * Takes a finished run and decides whether it happened.
 *
 * The order of the checks is deliberate: everything cheap and structural runs
 * first, and the replay — the only expensive thing here — runs last, on a payload
 * that has already been shown to be well-formed and within limits. That is what
 * keeps "verify every score" from also meaning "let anyone spend our CPU".
 */

const store = require('./_store');
const { replay } = require('./_replay');
const { RULES_VERSION, decodeTrace, TRACE_MAX_EVENTS } = require('../js/trace');
const { normaliseHandle, HANDLE_MAX } = require('../js/profile');

/** Wide enough that no honest run hits it, narrow enough to bound the work. */
const MAX_SCORE = 5000000;
const MAX_BODY = 200000;

function reject(res, code, reason) {
    return res.status(code).json({ ok: false, reason });
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return reject(res, 405, 'method not allowed');
    }

    // Vercel parses JSON bodies for us; a string body means an odd content-type.
    let run = req.body;
    if (typeof run === 'string') {
        if (run.length > MAX_BODY) return reject(res, 413, 'payload too large');
        try { run = JSON.parse(run); } catch (e) { return reject(res, 400, 'malformed json'); }
    }
    if (!run || typeof run !== 'object') return reject(res, 400, 'malformed json');

    /* ---- structural checks, cheapest first ---- */

    if (Number(run.v) !== RULES_VERSION) {
        // An old client held a stale tab open across a deploy. Its trace is
        // honest, it just describes a game with different physics.
        return reject(res, 409, 'game rules changed — reload the page');
    }

    const name = normaliseHandle(run.name);
    if (!name || name.length > HANDLE_MAX) return reject(res, 400, 'bad handle');

    const seed = Number(run.seed) >>> 0;
    if (!seed) return reject(res, 400, 'bad seed');

    const claimed = Number(run.score);
    if (!Number.isInteger(claimed) || claimed < 0 || claimed > MAX_SCORE) {
        return reject(res, 400, 'bad score');
    }

    if (typeof run.trace !== 'string' || run.trace.length > MAX_BODY) {
        return reject(res, 400, 'bad trace');
    }
    const events = decodeTrace(run.trace);
    if (events === null) return reject(res, 400, 'bad trace');
    if (events.length > TRACE_MAX_EVENTS) return reject(res, 413, 'trace too long');

    const skin = typeof run.skin === 'string' ? run.skin.slice(0, 16) : 'coral';

    /* ---- rate limit, before any simulation ---- */

    if (!(await store.allow(clientIp(req)))) {
        return reject(res, 429, 'too many submissions — try again in a minute');
    }

    /* ---- the actual verification ---- */

    let out;
    try {
        out = replay(seed, events);
    } catch (e) {
        return res.status(500).json({ ok: false, reason: 'replay failed' });
    }
    if (!out.ok) return reject(res, 400, out.reason);

    if (out.score !== claimed) {
        // The one rejection worth naming precisely. If an honest player ever sees
        // this, something in the simulation is not deterministic and it is a bug
        // here, not cheating there.
        return reject(res, 422, `replay mismatch (${out.score} vs ${claimed})`);
    }

    try {
        const saved = await store.record({
            name,
            skin,
            score: out.score,
            distance: out.distance,
            biome: out.biome,
        });
        return res.status(200).json({
            ok: true,
            rank: saved.rank,
            best: saved.best,
            improved: saved.improved,
            store: saved.store,
            verified: { score: out.score, distance: out.distance, steps: out.steps },
        });
    } catch (e) {
        return res.status(503).json({ ok: false, reason: 'board unavailable' });
    }
};
