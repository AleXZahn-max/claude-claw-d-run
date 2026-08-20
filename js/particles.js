/**
 * Claude Claw'd Run — Glyph Particles
 *
 * Particles are characters. They live in grid space alongside everything else,
 * so a puff of dust is a handful of dots drifting across cells rather than a
 * layer of alpha-blended circles on top of the picture.
 */

class GlyphParticle {
    constructor(x, y, vx, vy, chars, color, life, gravity = 0) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.chars = chars;
        this.color = color;
        this.life = life;
        this.maxLife = life;
        this.gravity = gravity;
    }

    step(worldSpeed) {
        this.x += this.vx - worldSpeed;
        this.y += this.vy;
        this.vy += this.gravity;
        this.life--;
        return this.life > 0;
    }

    draw(term) {
        const t = this.life / this.maxLife;
        // Walk backwards through the character set as the particle dies, so it
        // visibly thins out instead of just fading.
        const i = Math.min(this.chars.length - 1, Math.floor((1 - t) * this.chars.length));
        term.put(Math.round(this.x), Math.round(this.y), this.chars[i], this.color, Math.max(0.1, t));
    }
}

/** Rising text: score pops, combo callouts, pickups. */
class Floater {
    constructor(x, y, text, color, life = 46) {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color;
        this.life = life;
        this.maxLife = life;
    }

    step(worldSpeed) {
        this.y -= 0.055;
        this.x -= worldSpeed * 0.4;
        this.life--;
        return this.life > 0;
    }

    draw(term) {
        const t = this.life / this.maxLife;
        term.text(Math.round(this.x), Math.round(this.y), this.text, this.color, Math.min(1, t * 1.8));
    }
}

class ParticleManager {
    constructor() {
        this.parts = [];
        this.floats = [];
    }

    clear() {
        this.parts.length = 0;
        this.floats.length = 0;
    }

    step(worldSpeed) {
        for (let i = this.parts.length - 1; i >= 0; i--) {
            if (!this.parts[i].step(worldSpeed)) this.parts.splice(i, 1);
        }
        for (let i = this.floats.length - 1; i >= 0; i--) {
            if (!this.floats[i].step(worldSpeed)) this.floats.splice(i, 1);
        }
    }

    draw(term) {
        for (const p of this.parts) p.draw(term);
        for (const f of this.floats) f.draw(term);
    }

    add(p) {
        // Hard cap: a runaway particle count would start eating the play area.
        if (this.parts.length < 260) this.parts.push(p);
    }

    text(x, y, str, color, life) {
        this.floats.push(new Floater(x, y, str, color, life));
    }

    /* ---------------- emitters ---------------- */

    runDust(x, y, accent) {
        if (RNG.look.next() > 0.34) return;
        this.add(new GlyphParticle(
            x, y, -0.06 - RNG.look.next() * 0.09, -0.02 - RNG.look.next() * 0.04,
            ['·', '.', ' '], accent, 14 + RNG.look.next() * 10,
        ));
    }

    jumpPuff(x, y) {
        for (let i = 0; i < 7; i++) {
            const a = Math.PI + (RNG.look.next() - 0.5) * 2.2;
            this.add(new GlyphParticle(
                x + (RNG.look.next() - 0.5) * 6, y,
                Math.cos(a) * 0.16, Math.abs(Math.sin(a)) * 0.05,
                ['o', '°', '·', '.'], 'dim', 16 + RNG.look.next() * 8,
            ));
        }
    }

    landPuff(x, y, force) {
        const n = 5 + Math.round(force * 7);
        for (let i = 0; i < n; i++) {
            const dir = RNG.look.next() < 0.5 ? -1 : 1;
            this.add(new GlyphParticle(
                x + (RNG.look.next() - 0.5) * 8, y,
                dir * (0.1 + RNG.look.next() * 0.22), -0.03 - RNG.look.next() * 0.05,
                ['*', 'o', '·', '.'], 'dim', 12 + RNG.look.next() * 10, 0.006,
            ));
        }
    }

    /** Token pickup: a little cyan burst plus the pulse frames scattering. */
    pickup(x, y) {
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            this.add(new GlyphParticle(
                x, y, Math.cos(a) * 0.24, Math.sin(a) * 0.13,
                ['◆', '◇', '·', '.'], i % 2 ? 'cyanHot' : 'cyan', 15 + RNG.look.next() * 8,
            ));
        }
    }

    /**
     * Crash: the code itself comes apart. Fragments are the punctuation you'd
     * see in a stack trace, thrown outward under gravity.
     */
    crash(x, y) {
        const debris = ['@', '#', '%', '&', '*', '!', '?', ';', '/', ')', '}', '>'];
        for (let i = 0; i < 46; i++) {
            const a = -Math.PI / 2 + (RNG.look.next() - 0.5) * Math.PI * 1.7;
            const sp = 0.16 + RNG.look.next() * 0.4;
            const ch = debris[Math.floor(RNG.look.next() * debris.length)];
            this.add(new GlyphParticle(
                x + (RNG.look.next() - 0.5) * 10, y - RNG.look.next() * 4,
                Math.cos(a) * sp, Math.sin(a) * sp * 0.62,
                [ch, ch, '·', '.'], RNG.look.next() < 0.55 ? 'bug' : 'clawDeep',
                26 + RNG.look.next() * 26, 0.014,
            ));
        }
    }

    /** Score milestone: sparks rise off the ground line across the board. */
    milestone(accent) {
        for (let i = 0; i < 22; i++) {
            const x = RNG.look.next() * GEO.cols;
            this.add(new GlyphParticle(
                x, GEO.groundRow - RNG.look.next() * 2,
                (RNG.look.next() - 0.5) * 0.06, -0.09 - RNG.look.next() * 0.1,
                ['✦', '*', '+', '·'], accent, 26 + RNG.look.next() * 20,
            ));
        }
    }

    /** Entering extended thinking: the meter's charge scatters into the sky. */
    thinkBurst(x, y) {
        for (let i = 0; i < 26; i++) {
            const a = RNG.look.next() * Math.PI * 2;
            this.add(new GlyphParticle(
                x, y, Math.cos(a) * 0.3, Math.sin(a) * 0.17,
                ['◆', '◇', '∘', '·'], i % 3 ? 'cyan' : 'cyanHot', 30 + RNG.look.next() * 22,
            ));
        }
    }
}

window.GlyphParticle = GlyphParticle;
window.Floater = Floater;
window.ParticleManager = ParticleManager;
window.particleManager = new ParticleManager();
