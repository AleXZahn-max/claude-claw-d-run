/**
 * GET /api/top?limit=10
 *
 * The board, newest verified bests first. Cached at the edge for a few seconds:
 * a leaderboard that is ten seconds stale is indistinguishable from a live one,
 * and it means a thousand people opening the board is a handful of Redis reads.
 */

const store = require('./_store');
const auth = require('./_auth');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET');
        return res.status(405).json({ error: 'method not allowed' });
    }

    const raw = parseInt((req.query && req.query.limit) || '10', 10);
    const limit = Math.max(1, Math.min(50, Number.isFinite(raw) ? raw : 10));

    // `?debug=1` answers the one question you cannot answer from outside a
    // deploy: whether this function can see any database credentials, and which
    // names it found. Names only — a token is never in this response.
    const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');

    try {
        const { rows, store: kind } = await store.top(limit);
        res.setHeader('cache-control', debug
            ? 'no-store'
            : 'public, s-maxage=10, stale-while-revalidate=60');
        const body = { rows, store: kind };
        if (debug) {
            body.env = store.envReport();
            body.auth = auth.authReport();
        }
        return res.status(200).json(body);
    } catch (e) {
        // The board failing should not look like the game failing. The client has
        // a local board to fall back to and will use it on a non-200.
        return res.status(503).json({ error: 'board unavailable', rows: [] });
    }
};
