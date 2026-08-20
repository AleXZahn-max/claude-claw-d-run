/**
 * GET  /api/me  → who the cookie says you are, plus the settings that follow you
 * POST /api/me  → save one of those settings
 *
 * The client calls the GET once at boot. It answers 200 whether or not you are
 * signed in, because "you are nobody yet" is an answer and not a failure — the
 * game plays either way, and a 401 on the very first request of a page load reads
 * like something is broken.
 */

const auth = require('./_auth');
const store = require('./_store');
const GLYPHS = require('../js/glyphs');

const anon = (extra) => ({ signedIn: false, provider: 'github', ...extra });

module.exports = async function handler(req, res) {
    res.setHeader('cache-control', 'no-store');

    if (req.method === 'GET' || req.method === 'HEAD') {
        const s = auth.readSession(req);
        if (!s) return res.status(200).json(anon({ available: auth.configured() }));

        // The profile read is a nicety, not the answer. If Redis is down you are
        // still signed in; you just get the default crab until it comes back.
        let saved = null;
        try { saved = await store.profile(s.login); } catch (e) { /* keep going */ }

        return res.status(200).json({
            signedIn: true,
            provider: 'github',
            available: true,
            login: s.login,
            skin: saved && GLYPHS.SKIN_IDS.includes(saved.skin) ? saved.skin : null,
            expires: s.exp,
        });
    }

    if (req.method === 'POST') {
        const s = auth.readSession(req);
        if (!s) return res.status(401).json({ ok: false, reason: 'not signed in' });

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = null; }
        }
        if (!body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, reason: 'malformed json' });
        }

        // Exactly one settable field today. Whitelisting rather than merging the
        // body wholesale is what keeps this endpoint from becoming a way to write
        // arbitrary keys into an account when the shop adds `owns` next to `skin`.
        if (!GLYPHS.SKIN_IDS.includes(body.skin)) {
            return res.status(400).json({ ok: false, reason: 'unknown skin' });
        }

        try {
            const saved = await store.saveProfile(s.login, { skin: body.skin });
            return res.status(200).json({ ok: true, skin: saved.skin });
        } catch (e) {
            return res.status(503).json({ ok: false, reason: 'store unavailable' });
        }
    }

    res.setHeader('allow', 'GET, POST');
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
};
