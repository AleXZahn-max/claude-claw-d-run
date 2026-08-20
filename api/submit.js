/**
 * POST /api/submit
 *
 * Takes a finished run and decides whether it happened, and whose it was.
 *
 * The order of the checks is deliberate: everything cheap and structural runs
 * first, and the replay — the only expensive thing here — runs last, on a payload
 * that has already been shown to be well-formed and within limits. That is what
 * keeps "verify every score" from also meaning "let anyone spend our CPU".
 *
 * The name is never read from the body. It comes from the session cookie, which
 * means the two questions a leaderboard has to answer — did this run happen, and
 * is this person who they say they are — are both answered here and neither is
 * answered by the client.
 */

const store = require('./_store');
const auth = require('./_auth');
const { replay } = require('./_replay');
const { RULES_VERSION, decodeTrace, TRACE_MAX_EVENTS } = require('../js/trace');
const GLYPHS = require('../js/glyphs');

/** Wide enough that no honest run hits it, narrow enough to bound the work. */
const MAX_SCORE = 5000000;
const MAX_BODY = 200000;

function reject(res, code, reason) {
    return res.status(code).json({ ok: false, reason });
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

    /*
     * Who this is, before anything else expensive.
     *
     * One HMAC, no network, and it is the rejection an unsigned-in player is most
     * likely to hit — so it belongs above the trace decode, not below it. 401 is
     * the honest code: the run may well be real, we just have nowhere to file it.
     */
    const session = auth.readSession(req);
    if (!session) {
        return res.status(401).json({
            ok: false,
            reason: 'sign in with github to put a run on the board',
            needsAuth: true,
            available: auth.configured(),
        });
    }
    const name = auth.normaliseLogin(session.login);
    if (!name) return reject(res, 401, 'session is not readable — sign in again');

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

    // Cosmetic, so a wrong value cannot do harm — but it is stored and then read
    // back by every client that opens the board, and data that goes into a store
    // unvalidated comes out of it unvalidated.
    const skin = GLYPHS.SKIN_IDS.includes(run.skin) ? run.skin : 'coral';

    /* ---- rate limit, before any simulation ---- */

    // Per account rather than per address now that there is an account. An IP is
    // shared by a whole office and a whole mobile carrier; a login is one person.
    if (!(await store.allow(`u:${name}`))) {
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
            // The authoritative name, so the death screen credits the run to
            // whoever the cookie says it was rather than to a client-side guess.
            name,
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
