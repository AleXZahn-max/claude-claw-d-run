/**
 * GET /api/callback?code=…&state=…
 *
 * Step two of two, and the only place this project ever holds a GitHub token.
 *
 * The shape of it: prove the request is ours (`state`), trade the code for a
 * token, ask GitHub one question with it — who is this — then throw the token
 * away and hand back a session of our own. It is deliberately a very short life
 * for a credential. We never need it again, so keeping it would be keeping a
 * liability with no upside.
 *
 * Every failure ends the same way: a redirect back to the game with a one-word
 * reason. An error page would strand the player somewhere that is not the game.
 */

const crypto = require('crypto');
const auth = require('./_auth');

const UA = 'claude-clawd-run';

/** Back to the game, with a word the client can turn into a sentence. */
function home(res, why) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('location', why ? `/?auth=${why}` : '/?auth=ok');
    return res.status(302).end();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return res.status(405).json({ error: 'method not allowed' });
    }
    if (!auth.configured()) return home(res, 'unconfigured');

    const q = req.query || {};

    // The state cookie has done its job either way, and a CSRF token that
    // outlives one attempt is a CSRF token that can be replayed.
    const expected = auth.readState(req);
    auth.clearState(req, res);

    // "Cancel" on GitHub's consent screen lands here. Not an error — a decision.
    if (q.error) return home(res, q.error === 'access_denied' ? 'cancelled' : 'denied');

    const code = typeof q.code === 'string' ? q.code : '';
    const given = typeof q.state === 'string' ? q.state : '';
    if (!code || !given || !expected) return home(res, 'state');

    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return home(res, 'state');

    /* ---- code → token ---- */

    let token = '';
    try {
        const r = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'user-agent': UA,
            },
            body: JSON.stringify({
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
                redirect_uri: auth.redirectUri(req),
            }),
        });
        const data = await r.json().catch(() => ({}));
        // GitHub answers 200 with `{error}` for a spent or mismatched code, so the
        // status alone is not the answer.
        if (!r.ok || data.error || !data.access_token) return home(res, 'token');
        token = data.access_token;
    } catch (e) {
        return home(res, 'token');
    }

    /* ---- token → identity ---- */

    let user = null;
    try {
        const r = await fetch('https://api.github.com/user', {
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                // api.github.com rejects requests with no User-Agent outright.
                'user-agent': UA,
            },
        });
        if (!r.ok) return home(res, 'user');
        user = await r.json();
    } catch (e) {
        return home(res, 'user');
    }

    const login = auth.normaliseLogin(user && user.login);
    const gid = Number(user && user.id) || 0;
    if (!login || !gid) return home(res, 'user');

    /*
     * Hand the token back before doing anything else.
     *
     * We have the only fact we wanted. Revoking it means that even if this
     * function's logs, or a proxy, or a future bug leaked the token, the token is
     * already dead. Fire-and-forget: if the revocation fails the login still
     * worked, and the token expires on GitHub's own schedule anyway.
     */
    const basic = Buffer.from(
        `${process.env.GITHUB_CLIENT_ID}:${process.env.GITHUB_CLIENT_SECRET}`,
    ).toString('base64');
    fetch(`https://api.github.com/applications/${process.env.GITHUB_CLIENT_ID}/token`, {
        method: 'DELETE',
        headers: {
            authorization: `Basic ${basic}`,
            accept: 'application/vnd.github+json',
            'user-agent': UA,
        },
        body: JSON.stringify({ access_token: token }),
    }).catch(() => { /* best effort; the session is already earned */ });

    /* ---- our own session ---- */

    const exp = Date.now() + auth.SESSION_DAYS * 86400 * 1000;
    if (!auth.setSession(req, res, { login, gid, exp })) return home(res, 'unconfigured');

    return home(res, 'ok');
};
