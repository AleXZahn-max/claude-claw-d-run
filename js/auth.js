/**
 * Claude Claw'd Run — Sign-in, client side
 *
 * Three states and one probe. The game never waits for this: it boots, it plays,
 * and if the answer arrives saying you are somebody, it adopts that name. A runner
 * that shows a spinner before you can jump has traded the thing it is good at for
 * the thing it is merely correct about.
 *
 * There is no token here and no way to get one. The session is an HttpOnly
 * cookie, which means this file cannot read it even if it wanted to — it can only
 * ask the server what the cookie says. That is the point of HttpOnly.
 */

const AUTH = {
    /** unknown until the probe answers, then one of: anon, member, offline. */
    state: 'unknown',
    login: '',
    /** Whether this deploy has an OAuth App at all. False = hide the button. */
    available: false,
    /** The skin the account remembers, if it remembers one. */
    skin: null,
    /** A sentence to show once, set by a return trip from github.com. */
    notice: '',

    get member() {
        return this.state === 'member';
    },

    /* ------------------------------------------------------------------ *
     * Reading
     * ------------------------------------------------------------------ */

    /**
     * Asks /api/me who we are. Answers are 200 either way, so a failure here
     * genuinely means the network or the deploy is missing — not that you are
     * anonymous.
     */
    async probe() {
        try {
            const res = await fetch('/api/me', {
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.available = !!data.available;
            if (data.signedIn) {
                this.state = 'member';
                this.login = String(data.login || '');
                this.skin = data.skin || null;
            } else {
                this.state = 'anon';
                this.login = '';
                this.skin = null;
            }
        } catch (e) {
            // file://, no deploy, offline. Sign-in is simply not on the table.
            this.state = 'offline';
            this.available = false;
        }
        return this.state;
    },

    /* ------------------------------------------------------------------ *
     * Writing
     * ------------------------------------------------------------------ */

    /**
     * Leaves the page. Not a fetch: OAuth is a redirect flow, and the consent
     * screen has to be a real top-level navigation the player can see the URL of.
     * Anything that hid github.com behind a popup or an iframe would be teaching
     * people to type their password into a frame they cannot verify.
     */
    signIn() {
        window.location.href = '/api/login';
    },

    async signOut() {
        try {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (e) { /* the cookie may outlive this; the next probe will say so */ }
        this.state = 'anon';
        this.login = '';
        this.skin = null;
        this.notice = 'signed out';
        return this.state;
    },

    /** Remembers the crab colour on the account, so it follows you to your phone. */
    async saveSkin(skin) {
        if (!this.member) return false;
        this.skin = skin;
        try {
            const res = await fetch('/api/me', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ skin }),
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    },
};

/**
 * What the callback told us on the way back in, as a sentence.
 *
 * `?auth=` is read once and then scrubbed out of the URL with `replaceState`, so
 * that a reload does not re-announce a sign-in that happened five minutes ago and
 * so the address bar stays clean enough to share.
 */
const AUTH_NOTES = {
    ok: 'signed in',
    cancelled: 'sign-in cancelled',
    denied: 'github turned the sign-in down',
    state: 'sign-in expired — try again',
    token: "couldn't finish with github — try again",
    user: 'github would not say who you are',
    unconfigured: 'this deploy has no github app wired up',
};

function readAuthNotice() {
    try {
        const url = new URL(window.location.href);
        const key = url.searchParams.get('auth');
        if (!key) return '';
        url.searchParams.delete('auth');
        window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
        return AUTH_NOTES[key] || '';
    } catch (e) {
        return '';
    }
}

if (typeof window !== 'undefined') {
    window.AUTH = AUTH;
    AUTH.notice = readAuthNotice();
}
