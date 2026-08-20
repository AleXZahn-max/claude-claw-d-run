/**
 * Claude Claw'd Run — Player profile
 *
 * A handle and a crab colour, kept in localStorage. That is the whole account
 * system, and it is deliberately the whole account system: the leaderboard's
 * value is being able to point at a row and say "that one is mine", which needs
 * a name and a face and nothing else.
 *
 * The handle rules are shared with the server on purpose — api/submit.js runs the
 * same normalisation, because a client is free to POST anything it likes and the
 * board is what everybody else has to read.
 */

const HANDLE_MAX = 14;

/**
 * Lowercase, ASCII, and only the characters that survive being read aloud.
 * Spaces become dashes rather than being dropped, so "claw d" stays two words.
 */
function normaliseHandle(raw) {
    return String(raw == null ? '' : raw)
        .toLowerCase()
        .replace(/[\s.]+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, HANDLE_MAX);
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

    /** True until the player has ever confirmed a handle. Drives the first-run screen. */
    get isNew() {
        return !this.name;
    },

    load() {
        let name = null, skin = null;
        try {
            name = localStorage.getItem(this.KEY_NAME);
            skin = localStorage.getItem(this.KEY_SKIN);
        } catch (e) { /* private mode: play without a profile */ }
        this.name = normaliseHandle(name || '');
        this.skin = GLYPHS.SKIN_IDS.includes(skin) ? skin : 'coral';
        return this;
    },

    save(name, skin) {
        if (name !== undefined) this.name = normaliseHandle(name) || suggestHandle();
        if (skin !== undefined && GLYPHS.SKIN_IDS.includes(skin)) this.skin = skin;
        try {
            localStorage.setItem(this.KEY_NAME, this.name);
            localStorage.setItem(this.KEY_SKIN, this.skin);
        } catch (e) { /* nothing to do; the run still counts locally */ }
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
}
if (typeof module !== 'undefined') module.exports = { normaliseHandle, suggestHandle, HANDLE_MAX };
