/**
 * Claude Claw'd Run — Leaderboard storage
 *
 * A Redis sorted set, reached over Upstash's REST API with plain `fetch`. No npm
 * dependency, which is the point: this project is a folder of files that Vercel
 * serves, and adding a client library to it just to run four commands would be
 * the largest thing in the repo.
 *
 * A leaderboard is exactly a sorted set — that is the whole reason to use one
 * here rather than a table. `ZADD … GT` keeps one row per handle holding that
 * handle's best, `ZREVRANGE` reads the top, and `ZREVRANK` answers "where did I
 * land" without reading the board.
 *
 * With no credentials configured it falls back to a per-instance Map so the API
 * still answers and the game still works. That board evaporates on the next cold
 * start, and `store` in every response says so rather than pretending.
 */

const VERSION = 3;
const BOARD_KEY = `clawd:board:v${VERSION}`;
const META_KEY = `clawd:meta:v${VERSION}`;

/** Vercel's Upstash integration sets KV_*; a hand-made Upstash DB sets UPSTASH_*. */
function creds() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

const configured = () => creds() !== null;

/** One Redis command. Arguments are sent as a JSON array, which is Upstash's REST shape. */
async function cmd(...args) {
    const c = creds();
    if (!c) throw new Error('no redis configured');
    const res = await fetch(c.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args.map(String)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `redis HTTP ${res.status}`);
    return body.result;
}

/* ------------------------------------------------------------------ *
 * The in-memory stand-in
 * ------------------------------------------------------------------ */

const mem = { scores: new Map(), meta: new Map(), hits: new Map() };

function memTop(limit) {
    return [...mem.scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, score]) => ({ name, score, ...(mem.meta.get(name) || {}) }));
}

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

/**
 * Reads the top `limit` rows, each with the run detail that goes beside the
 * number. Two round trips: the sorted set, then one HMGET for the metadata of
 * exactly the handles that came back.
 */
async function top(limit = 10) {
    if (!configured()) return { rows: memTop(limit), store: 'memory' };

    const flat = await cmd('ZREVRANGE', BOARD_KEY, 0, limit - 1, 'WITHSCORES');
    const names = [];
    const scores = [];
    for (let i = 0; i < flat.length; i += 2) {
        names.push(flat[i]);
        scores.push(Number(flat[i + 1]));
    }
    if (!names.length) return { rows: [], store: 'redis' };

    const metas = await cmd('HMGET', META_KEY, ...names);
    const rows = names.map((name, i) => {
        let m = {};
        try { m = JSON.parse(metas[i]) || {}; } catch (e) { /* row predates the field */ }
        return { name, score: scores[i], skin: m.skin, distance: m.distance, biome: m.biome, at: m.at };
    });
    return { rows, store: 'redis' };
}

/**
 * Records a verified run. Returns the handle's rank (1-based) and whether this
 * run was an improvement — GT means a worse run leaves the board untouched, so
 * "accepted" and "improved" are different answers and the game says which.
 */
async function record(run) {
    const meta = JSON.stringify({
        skin: run.skin, distance: run.distance, biome: run.biome, at: Date.now(),
    });

    if (!configured()) {
        const prev = mem.scores.get(run.name) || 0;
        const improved = run.score > prev;
        if (improved) {
            mem.scores.set(run.name, run.score);
            mem.meta.set(run.name, JSON.parse(meta));
        }
        const rank = memTop(10000).findIndex((r) => r.name === run.name) + 1;
        return { rank, improved, best: Math.max(prev, run.score), store: 'memory' };
    }

    const changed = await cmd('ZADD', BOARD_KEY, 'GT', 'CH', run.score, run.name);
    const improved = Number(changed) > 0;
    if (improved) await cmd('HSET', META_KEY, run.name, meta);

    const [rank, best] = await Promise.all([
        cmd('ZREVRANK', BOARD_KEY, run.name),
        cmd('ZSCORE', BOARD_KEY, run.name),
    ]);
    return {
        rank: rank == null ? -1 : Number(rank) + 1,
        improved,
        best: Number(best) || run.score,
        store: 'redis',
    };
}

/**
 * A crude fixed-window counter per client. It is not there to stop a determined
 * attacker — the replay check does that — but to keep one loop from spending the
 * function's whole CPU budget on simulations.
 */
async function allow(ip, limit = 12, windowSec = 60) {
    const key = `clawd:rl:${ip}`;
    if (!configured()) {
        const now = Date.now();
        const slot = Math.floor(now / (windowSec * 1000));
        const cur = mem.hits.get(key);
        const n = cur && cur.slot === slot ? cur.n + 1 : 1;
        mem.hits.set(key, { slot, n });
        return n <= limit;
    }
    try {
        const n = Number(await cmd('INCR', key));
        if (n === 1) await cmd('EXPIRE', key, windowSec);
        return n <= limit;
    } catch (e) {
        return true; // a broken limiter must not become a broken game
    }
}

module.exports = { top, record, allow, configured, VERSION };
