/**
 * GET /api/login
 *
 * Step one of two. Mints a CSRF token, remembers it in a short-lived cookie, and
 * sends the player to GitHub.
 *
 * The `state` parameter is the whole reason this is not just a link straight to
 * github.com. Without it, anyone could hand you a crafted `/api/callback?code=…`
 * URL and sign you into *their* account inside your browser — login CSRF. The
 * token goes out with the request and comes back with it, and the callback
 * refuses any code that does not arrive alongside the cookie we set here.
 */

const auth = require('./_auth');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return res.status(405).json({ error: 'method not allowed' });
    }

    if (!auth.configured()) {
        // A deploy without an OAuth App is a legitimate state — the game plays
        // fine, it just has no accounts — so say which piece is missing rather
        // than failing blankly.
        return res.status(503).json({
            error: 'github sign-in is not configured on this deploy',
            env: auth.authReport(),
        });
    }

    const state = auth.newState();
    auth.setState(req, res, state);

    res.setHeader('cache-control', 'no-store');
    res.setHeader('location', auth.authorizeUrl(req, state));
    return res.status(302).end();
};
