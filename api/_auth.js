/**
 * Claude Claw'd Run — Sessions
 *
 * Everything identity-shaped in one file: the session cookie, its signature, and
 * the two URLs of the GitHub handshake.
 *
 * The session is a *signed cookie*, not a row in Redis. It carries its own claims
 * — who you are and when it expires — and an HMAC over them, so verifying it is
 * one hash and no network. A session table would mean a database round trip on
 * every single request just to learn a name we already have in our hand.
 *
 * The trade is that a signed session cannot be revoked before it expires. For a
 * leaderboard that is the right trade; for a bank it would not be.
 *
 * No dependencies. The whole of this is Node's built-in `crypto`.
 */

const crypto = require('crypto');

const COOKIE_SESSION = 'clawd_sess';
const COOKIE_STATE = 'clawd_oauth';

const SESSION_DAYS = 30;
const STATE_SECONDS = 600;

/** GitHub's own ceiling on a username, so ours cannot be the thing that truncates. */
const LOGIN_MAX = 39;

/* ------------------------------------------------------------------ *
 * The signing key
 * ------------------------------------------------------------------ */

/**
 * `SESSION_SECRET` if you set one, otherwise derived from the OAuth client
 * secret.
 *
 * The fallback exists so that wiring this up is two environment variables rather
 * than three — one fewer thing to forget, and a forgotten signing key is a game
 * where nobody can stay signed in. The client secret is already high-entropy and
 * already secret, so a hash of it is a perfectly good HMAC key.
 *
 * The cost of relying on the fallback: rotating your GitHub client secret signs
 * everybody out. That is a fine thing to happen when you rotate a secret.
 */
function secret() {
    const explicit = process.env.SESSION_SECRET;
    if (explicit && explicit.length >= 16) return explicit;

    const cs = process.env.GITHUB_CLIENT_SECRET;
    if (cs) return crypto.createHash('sha256').update(`clawd-session|${cs}`).digest();

    return null;
}

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** `payload.signature`, both base64url. Returns null if there is no key to sign with. */
function sign(claims) {
    const key = secret();
    if (!key) return null;
    const body = b64(JSON.stringify(claims));
    const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${sig}`;
}

/**
 * The inverse, and the only place a claim is ever believed.
 *
 * Order matters: signature first, then expiry, then shape. Parsing untrusted
 * JSON before checking who wrote it means running the parser on input an attacker
 * chose, for no reason — the signature check costs one hash and rules that out.
 */
function verify(token) {
    const key = secret();
    if (!key || typeof token !== 'string' || token.length > 4096) return null;

    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('base64url'));

    /*
     * Constant time, because `===` on strings returns as soon as two bytes
     * differ. That timing difference is enough to guess a signature one byte at
     * a time, which is a real attack with a name and a Wikipedia page.
     */
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

    let claims;
    try {
        claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!claims || typeof claims !== 'object') return null;
    if (!Number.isFinite(claims.exp) || Date.now() > claims.exp) return null;

    const login = normaliseLogin(claims.login);
    if (!login) return null;
    return { login, gid: Number(claims.gid) || 0, exp: claims.exp };
}

/** GitHub logins are `[A-Za-z0-9-]`; this is that, lowercased, and nothing else. */
function normaliseLogin(raw) {
    return String(raw == null ? '' : raw)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, LOGIN_MAX);
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

function cookies(req) {
    const raw = req.headers.cookie || '';
    const out = {};
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim();
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = ''; }
    }
    return out;
}

/** True on a deploy, false under `vercel dev` — which is why `Secure` is conditional. */
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';

/**
 * One `Set-Cookie` value.
 *
 * `SameSite=Lax` rather than `Strict`, and this is not a detail: coming back from
 * github.com to `/api/callback` is a cross-site navigation, and `Strict` would
 * withhold the cookie on exactly that request — the one where we need to compare
 * `state`. Lax sends cookies on top-level navigations, which is what a redirect
 * is, and still withholds them from cross-site POSTs and subresources.
 *
 * `HttpOnly` because no script ever needs to read this. If the page picks up an
 * XSS one day, the session is still not readable from it.
 */
function cookie(name, value, { maxAge, secure }) {
    const bits = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAge}`,
    ];
    if (secure) bits.push('Secure');
    return bits.join('; ');
}

/** Appends rather than assigns: the callback sets a session *and* clears a state cookie. */
function addCookie(res, value) {
    const prev = res.getHeader('set-cookie');
    const all = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
    all.push(value);
    res.setHeader('set-cookie', all);
}

function setSession(req, res, claims) {
    const token = sign(claims);
    if (!token) return false;
    addCookie(res, cookie(COOKIE_SESSION, token, {
        maxAge: SESSION_DAYS * 86400, secure: isHttps(req),
    }));
    return true;
}

function clearSession(req, res) {
    addCookie(res, cookie(COOKIE_SESSION, '', { maxAge: 0, secure: isHttps(req) }));
}

function setState(req, res, value) {
    addCookie(res, cookie(COOKIE_STATE, value, {
        maxAge: STATE_SECONDS, secure: isHttps(req),
    }));
}

function clearState(req, res) {
    addCookie(res, cookie(COOKIE_STATE, '', { maxAge: 0, secure: isHttps(req) }));
}

/** The session on this request, or null. The one function the rest of the API calls. */
function readSession(req) {
    return verify(cookies(req)[COOKIE_SESSION]);
}

function readState(req) {
    return cookies(req)[COOKIE_STATE] || '';
}

/* ------------------------------------------------------------------ *
 * The handshake's two URLs
 * ------------------------------------------------------------------ */

/**
 * Where GitHub sends the player back.
 *
 * Derived from the request's own host so that preview deploys and localhost work
 * without a second environment variable, overridable with `OAUTH_REDIRECT` when
 * you need to pin it.
 *
 * Deriving it from a header the client could forge sounds unsafe and is not:
 * GitHub checks `redirect_uri` against the callback URL registered on the OAuth
 * App and refuses anything that is not underneath it. A forged `Host` does not
 * redirect the code somewhere new; it just fails the handshake.
 */
function redirectUri(req) {
    if (process.env.OAUTH_REDIRECT) return process.env.OAUTH_REDIRECT;
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${isHttps(req) ? 'https' : 'http'}://${host}/api/callback`;
}

function authorizeUrl(req, state) {
    const q = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID || '',
        redirect_uri: redirectUri(req),
        state,
        /*
         * Deliberately empty. We want a name and nothing else, and an empty scope
         * is what makes GitHub's consent screen say so — "this app will only be
         * able to read public information". A game asking for `repo` is a game
         * people are right to close.
         */
        scope: '',
        allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${q}`;
}

/** 32 random bytes. The CSRF token for the round trip through github.com. */
const newState = () => crypto.randomBytes(32).toString('base64url');

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

const configured = () =>
    !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && secret());

/** Names only, never values — same rule as the store's report. */
function authReport() {
    const names = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET', 'OAUTH_REDIRECT'];
    return {
        configured: configured(),
        present: names.filter((n) => !!process.env[n]),
        signingKey: process.env.SESSION_SECRET ? 'SESSION_SECRET'
            : process.env.GITHUB_CLIENT_SECRET ? 'derived from GITHUB_CLIENT_SECRET'
                : 'none — sessions cannot be signed',
    };
}

module.exports = {
    LOGIN_MAX, SESSION_DAYS,
    normaliseLogin,
    readSession, setSession, clearSession,
    readState, setState, clearState,
    redirectUri, authorizeUrl, newState,
    configured, authReport,
    isHttps,
};
