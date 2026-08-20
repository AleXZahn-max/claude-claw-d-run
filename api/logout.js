/**
 * POST /api/logout
 *
 * Clears the session cookie. That is all a signed session can be — it carries its
 * own validity, so signing out means dropping it, not revoking it somewhere.
 *
 * POST rather than GET on purpose. A GET that changes state can be fired by
 * anything that loads a URL — an `<img src="/api/logout">` in a comment on
 * another site would sign visitors out. Nuisance rather than danger, but the fix
 * costs one word.
 */

const auth = require('./_auth');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return res.status(405).json({ ok: false, reason: 'method not allowed' });
    }

    auth.clearSession(req, res);
    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({ ok: true, signedIn: false });
};
