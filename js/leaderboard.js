/**
 * Claude Claw'd Run — Leaderboard client
 *
 * Two boards behind one interface. If /api/top answers, the board is global and
 * verified. If it does not — the game opened from a file:// path, the deploy has
 * no Redis wired up, the network is out — the same screen shows a local board
 * built from this browser's own runs.
 *
 * That fallback is not politeness. It means the game never has a screen that
 * only works on one deploy, and it means the leaderboard code can be developed
 * and looked at without a backend running.
 */

const BOARD = {
    KEY_LOCAL: 'claude_clawd_board',

    /** null = not yet probed, true = talking to the API, false = local only. */
    online: null,
    /**
     * Where the rows on screen actually live: 'redis' if the deploy has a
     * database, 'memory' if the API answered but is holding the board in a
     * serverless instance that will evaporate, 'local' if we never reached it.
     *
     * Three values rather than two because "the API replied" and "your score is
     * safe" are different facts, and a board that calls the second one true when
     * only the first is has lied about the only thing it exists to promise.
     */
    store: 'local',
    rows: [],
    status: 'idle',      // idle | loading | ok | local | error
    message: '',
    /** The row this player owns on the last fetched board, if any. */
    mine: -1,

    /** What to call this board on screen. */
    get scope() {
        if (this.store === 'redis') return 'global';
        if (this.store === 'memory') return 'this deploy';
        return 'this browser';
    },

    /* ------------------------------------------------------------------ *
     * Reading
     * ------------------------------------------------------------------ */

    async load(limit = 12) {
        this.status = 'loading';
        this.message = 'reading board';
        try {
            const res = await fetch(`/api/top?limit=${limit}`, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data.rows)) throw new Error('malformed');
            this.online = true;
            this.store = data.store === 'redis' ? 'redis' : 'memory';
            this.rows = data.rows.map(normaliseRow);
            this.status = 'ok';
            this.message = data.rows.length ? '' : 'nobody has shipped anything yet';
        } catch (e) {
            this.online = false;
            this.store = 'local';
            this.rows = this.localRows(limit);
            this.status = 'local';
            this.message = 'offline — showing this browser only';
        }
        this.mine = this.myRow();
        return this.rows;
    },

    /**
     * Which row on screen is this player's, or -1.
     *
     * A name match is not enough. On the global board every row is a GitHub login,
     * so a match only means something if this player *has* one — an anonymous
     * player who typed `kayza` is not the GitHub kayza, and claiming their row
     * would be precisely the mix-up that signing in exists to end. On the local
     * board there is nobody else, so a name match is the whole of the question.
     */
    myRow() {
        if (!PROFILE.name) return -1;
        if (this.store !== 'local' && !PROFILE.isGithub) return -1;
        return this.rows.findIndex((r) => r.name === PROFILE.name);
    },

    /* ------------------------------------------------------------------ *
     * Writing
     * ------------------------------------------------------------------ */

    /**
     * Sends a finished run. The local board is always written first, so a
     * rejected or unreachable submission still leaves the player with a record
     * of their own best — the run happened either way.
     *
     * `run.name` goes along for the local board only. The server does not read it:
     * it takes the name from the session cookie, which is the whole reason a row on
     * the global board can be trusted.
     */
    async submit(run) {
        this.writeLocal(run);
        if (this.online === false) return { ok: false, reason: 'offline', local: true };

        try {
            const res = await fetch('/api/submit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // The session cookie is the submission's identity, so it has to go.
                credentials: 'same-origin',
                body: JSON.stringify(run),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                // Not signed in is its own answer, not a rejection. The run was
                // fine; there is simply no account to file it under, and the death
                // screen says so in those terms rather than as a refusal.
                if (res.status === 401 || data.needsAuth) {
                    return {
                        ok: false,
                        needsAuth: true,
                        available: data.available !== false,
                        reason: data.reason || 'sign in to use the board',
                    };
                }
                // A rejection is worth surfacing verbatim: "replay mismatch" is
                // the one message that tells an honest player something is
                // genuinely wrong rather than that they are being ignored.
                return { ok: false, reason: data.reason || `HTTP ${res.status}`, rank: -1 };
            }
            this.online = true;
            this.store = data.store === 'redis' ? 'redis' : 'memory';
            return {
                ok: true,
                name: data.name || run.name,
                rank: data.rank == null ? -1 : data.rank,
                best: data.best,
                ephemeral: this.store !== 'redis',
            };
        } catch (e) {
            this.online = false;
            this.store = 'local';
            return { ok: false, reason: 'offline', local: true };
        }
    },

    /* ------------------------------------------------------------------ *
     * The local board
     * ------------------------------------------------------------------ */

    readLocal() {
        try {
            const raw = localStorage.getItem(this.KEY_LOCAL);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    },

    writeLocal(run) {
        const all = this.readLocal();
        const i = all.findIndex((r) => r.name === run.name);
        // One row per handle, holding that handle's best. A board that lists the
        // same person nine times is a log, not a leaderboard.
        if (i >= 0) {
            if (all[i].score >= run.score) { all[i].skin = run.skin; }
            else all[i] = rowOf(run);
        } else {
            all.push(rowOf(run));
        }
        all.sort((a, b) => b.score - a.score);
        try {
            localStorage.setItem(this.KEY_LOCAL, JSON.stringify(all.slice(0, 50)));
        } catch (e) { /* full or blocked: the run is still on screen */ }
    },

    localRows(limit) {
        return this.readLocal().slice(0, limit).map(normaliseRow);
    },
};

function rowOf(run) {
    return {
        name: run.name,
        skin: run.skin,
        score: run.score,
        distance: run.distance,
        biome: run.biome,
        at: Date.now(),
    };
}

function normaliseRow(r) {
    return {
        // LOGIN_MAX, not HANDLE_MAX: rows on the global board are GitHub logins and
        // can be up to 39 characters. Clamping them to 14 here would rename people
        // on the way to the screen. The table truncates for display instead.
        name: normaliseHandle(r.name, LOGIN_MAX) || 'anon',
        skin: GLYPHS.SKIN_IDS.includes(r.skin) ? r.skin : 'coral',
        score: Math.max(0, Math.floor(Number(r.score) || 0)),
        distance: Math.max(0, Math.floor(Number(r.distance) || 0)),
        biome: typeof r.biome === 'string' ? r.biome.slice(0, 18) : '',
        at: Number(r.at) || 0,
    };
}

/** "3m", "4h", "2d" — a board wants elapsed time, not a timestamp. */
function ago(ms) {
    if (!ms) return '—';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
    return `${Math.round(s / (86400 * 30))}mo ago`;
}

if (typeof window !== 'undefined') {
    window.BOARD = BOARD;
    window.ago = ago;
}
