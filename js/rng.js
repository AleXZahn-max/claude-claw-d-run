/**
 * Claude Claw'd Run — Deterministic randomness
 *
 * Two separate streams, and the split is the whole point.
 *
 * `play` drives anything that can change the outcome of a run: which hazard
 * spawns, how far apart, where a token sits. `look` drives anything purely
 * cosmetic: stars, dust, blinks, screen shake.
 *
 * They are separate because the leaderboard validates a run by replaying the
 * player's inputs on the server and recomputing the score. That only works if
 * the same seed plus the same keypresses always produce the same world — and it
 * would break the moment a particle burst pulled one extra number out of a
 * shared stream and shifted every future spawn by one. Cosmetics are allowed to
 * diverge between browser and server; the simulation is not.
 *
 * xorshift32: four operations, no state beyond one word, identical results in
 * every JS engine. Math.random() is none of those things, which is why it is
 * banned everywhere below the drawing layer.
 */

class Rng {
    constructor(seed) {
        this.seed(seed);
    }

    seed(s) {
        // Zero is a fixed point for xorshift, so it can never be the state.
        this.s = (s >>> 0) || 0x9e3779b9;
        return this;
    }

    /** Next float in [0, 1). */
    next() {
        let x = this.s;
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;  x >>>= 0;
        this.s = x;
        return x / 4294967296;
    }

    /** Integer in [0, n). */
    int(n) {
        return Math.floor(this.next() * n);
    }

    /** Float in [lo, hi). */
    range(lo, hi) {
        return lo + this.next() * (hi - lo);
    }

    pick(arr) {
        return arr[this.int(arr.length)];
    }

    chance(p) {
        return this.next() < p;
    }
}

/** A seed that reads as a short word, so it can travel in a URL or a share card. */
function newSeed() {
    // Date.now is fine here: it is only ever used to *pick* a seed, never inside
    // the simulation. Once chosen, the seed is the only entropy a run has.
    return ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) || 1;
}

function seedToCode(seed) {
    return (seed >>> 0).toString(36).padStart(7, '0');
}

function codeToSeed(code) {
    const n = parseInt(String(code).trim().toLowerCase(), 36);
    return Number.isFinite(n) ? (n >>> 0) || 1 : 1;
}

/** Gameplay and cosmetics, never crossing. */
const RNG = {
    play: new Rng(1),
    look: new Rng(newSeed()),
};

if (typeof window !== 'undefined') {
    window.Rng = Rng;
    window.RNG = RNG;
    window.newSeed = newSeed;
    window.seedToCode = seedToCode;
    window.codeToSeed = codeToSeed;
}
