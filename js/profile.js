/**
 * Claude Claw'd Run — Player profile
 *
 * Who the game thinks you are, from one of two places.
 *
 * Signed in with GitHub, your name is your login and it is not yours to type —
 * the server takes it from the session cookie and ignores anything the client
 * claims. That is what makes a row on the global board mean something: logins are
 * unique, so nobody can turn up wearing your name.
 *
 * Not signed in, it is a handle in localStorage and a crab colour, exactly as
 * before. You can play, you keep a personal best, you get a board of your own
 * runs — you just cannot put a row on the global one, because there is nothing
 * there to stop the next person claiming it.
 */

/** A typed handle. Short, because you have to type it and read it in a table. */
const HANDLE_MAX = 14;
/** GitHub's own ceiling. Logins are not ours to shorten. */
const LOGIN_MAX = 39;

/**
 * Lowercase, ASCII, and only the characters that survive being read aloud.
 * Spaces become dashes rather than being dropped, so "claw d" stays two words.
 *
 * `max` is a parameter because the two kinds of name have different ceilings and
 * running a 20-character GitHub login through the 14-character rule would quietly
 * rename somebody.
 */
function normaliseHandle(raw, max = HANDLE_MAX) {
    return String(raw == null ? '' : raw)
        .toLowerCase()
        .replace(/[\s.]+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, max);
}

/** The name you get for pressing Enter on an empty field. */
function suggestHandle() {
    return `anon-crab-${10 + Math.floor(Math.random() * 90)}`;
}

const PROFILE = {
    KEY_NAME: 'claude_clawd_name',
    KEY_SKIN: 'claude_clawd_skin',

    name: '',
    skin: 'coral',
    /** 'local' = a typed handle, 'github' = a session. Decides who may edit the name. */
    source: 'local',

    get isGithub() {
        return this.source === 'github';
    },

    /**
     * True until the player has ever confirmed a handle. Drives the first-run
     * screen — and a signed-in player is never new, because their name arrived
     * already decided.
     */
    get isNew() {
        return !this.name && !this.isGithub;
    },

    load() {
        let name = null, skin = null;
        try {
            name = localStorage.getItem(this.KEY_NAME);
            skin = localStorage.getItem(this.KEY_SKIN);
        } catch (e) { /* private mode: play without a profile */ }
        this.name = normaliseHandle(name || '');
        this.skin = GLYPHS.SKIN_IDS.includes(skin) ? skin : 'coral';
        this.source = 'local';
        return this;
    },

    save(name, skin) {
        // A GitHub name is not editable here. Guarding at the setter rather than at
        // every call site means a stray `save()` cannot rename a signed-in player
        // locally and leave the screen disagreeing with the board.
        if (name !== undefined && !this.isGithub) {
            this.name = normaliseHandle(name) || suggestHandle();
        }
        if (skin !== undefined && GLYPHS.SKIN_IDS.includes(skin)) this.skin = skin;
        try {
            if (!this.isGithub) localStorage.setItem(this.KEY_NAME, this.name);
            localStorage.setItem(this.KEY_SKIN, this.skin);
        } catch (e) { /* nothing to do; the run still counts locally */ }
        return this;
    },

    /**
     * Takes on a signed-in identity. The saved handle is left untouched in
     * localStorage on purpose: signing out should give you back the name you had,
     * not a blank first-run screen.
     */
    adopt(login, skin) {
        this.name = normaliseHandle(login, LOGIN_MAX);
        this.source = 'github';
        // The account's colour wins if it has one — that is the whole point of
        // storing it. A device that has never seen this account keeps its own.
        if (skin && GLYPHS.SKIN_IDS.includes(skin)) this.skin = skin;
        return this;
    },

    /** Signing out: back to whatever this browser called itself. */
    release() {
        this.source = 'local';
        let name = null;
        try { name = localStorage.getItem(this.KEY_NAME); } catch (e) { /* ignore */ }
        this.name = normaliseHandle(name || '');
        return this;
    },

    /** The renderer's key remap for this player's crab. */
    get recolor() {
        return GLYPHS.skinRecolor(this.skin);
    },
};

if (typeof window !== 'undefined') {
    window.PROFILE = PROFILE;
    window.normaliseHandle = normaliseHandle;
    window.suggestHandle = suggestHandle;
    window.HANDLE_MAX = HANDLE_MAX;
    window.LOGIN_MAX = LOGIN_MAX;
}
if (typeof module !== 'undefined') {
    module.exports = { normaliseHandle, suggestHandle, HANDLE_MAX, LOGIN_MAX };
}
