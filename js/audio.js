/**
 * Claude Claw'd Run — Procedural Audio
 *
 * Every sound is synthesised on the fly: no files, no loading, no latency.
 * Everything runs through one master bus with a lowpass, which is how extended
 * thinking gets its underwater feel — the filter sweeps down and the whole mix
 * goes muffled while time is slowed.
 */
class SoundController {
    constructor() {
        this.ctx = null;
        this.muted = false;
        this.initialized = false;
        this.volume = 0.8;
    }

    init() {
        if (this.initialized) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            this.ctx = new AC();

            this.master = this.ctx.createGain();
            this.master.gain.value = this.volume;

            this.filter = this.ctx.createBiquadFilter();
            this.filter.type = 'lowpass';
            this.filter.frequency.value = 20000;
            this.filter.Q.value = 0.7;

            this.filter.connect(this.master);
            this.master.connect(this.ctx.destination);
            this.initialized = true;
        } catch (e) {
            console.warn('Audio unavailable:', e.message);
        }
    }

    resume() {
        if (!this.initialized) this.init();
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    toggleMute() {
        this.muted = !this.muted;
        if (this.master) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.02);
        }
        return this.muted;
    }

    get ready() {
        return !!(this.ctx && !this.muted);
    }

    /* ------------------------------------------------------------------ *
     * Primitives
     * ------------------------------------------------------------------ */

    /** One oscillator with a pitch sweep and an envelope. */
    tone({ type = 'square', from, to, at = 0, dur = 0.12, gain = 0.12, curve = 'exp' }) {
        const t = this.ctx.currentTime + at;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(from, t);
        if (to && to !== from) {
            if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
            else osc.frequency.linearRampToValueAtTime(to, t + dur);
        }

        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.connect(g);
        g.connect(this.filter);
        osc.start(t);
        osc.stop(t + dur + 0.02);
    }

    /** A burst of filtered white noise, for impacts and dust. */
    noise({ at = 0, dur = 0.15, gain = 0.14, cutoff = 2200, type = 'lowpass' }) {
        const t = this.ctx.currentTime + at;
        const frames = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

        const src = this.ctx.createBufferSource();
        src.buffer = buf;

        const bp = this.ctx.createBiquadFilter();
        bp.type = type;
        bp.frequency.value = cutoff;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        src.connect(bp);
        bp.connect(g);
        g.connect(this.filter);
        src.start(t);
    }

    /* ------------------------------------------------------------------ *
     * Game sounds
     * ------------------------------------------------------------------ */

    playJump() {
        if (!this.ready) return;
        this.tone({ type: 'square', from: 190, to: 660, dur: 0.11, gain: 0.09 });
        this.noise({ dur: 0.05, gain: 0.05, cutoff: 1400 });
    }

    playLand(force = 1) {
        if (!this.ready) return;
        this.noise({ dur: 0.07, gain: 0.05 + force * 0.05, cutoff: 900 });
        this.tone({ type: 'sine', from: 140, to: 70, dur: 0.08, gain: 0.06 });
    }

    playDuck() {
        if (!this.ready) return;
        this.tone({ type: 'sine', from: 340, to: 120, dur: 0.09, gain: 0.08 });
    }

    /** Token pickup: a clean two-note blip that never gets tiring. */
    playPickup(step = 0) {
        if (!this.ready) return;
        const base = 880 * Math.pow(2, Math.min(6, step) / 12);
        this.tone({ type: 'triangle', from: base, dur: 0.055, gain: 0.09 });
        this.tone({ type: 'triangle', from: base * 1.5, at: 0.045, dur: 0.07, gain: 0.07 });
    }

    /** Near miss: a short upward tick, pitched by combo depth. */
    playNearMiss(combo = 1) {
        if (!this.ready) return;
        const f = 520 + Math.min(8, combo) * 70;
        this.tone({ type: 'square', from: f, to: f * 1.4, dur: 0.05, gain: 0.055 });
    }

    playMilestone() {
        if (!this.ready) return;
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
            this.tone({ type: 'triangle', from: f, at: i * 0.065, dur: 0.16, gain: 0.1 });
        });
    }

    playBiome() {
        if (!this.ready) return;
        [392, 523.25, 659.25].forEach((f, i) => {
            this.tone({ type: 'sine', from: f, at: i * 0.09, dur: 0.42, gain: 0.075 });
        });
        this.noise({ dur: 0.5, gain: 0.035, cutoff: 700 });
    }

    /** Extended thinking on: the mix dives, a rising figure signals the shift. */
    playThinkStart() {
        if (!this.ready) return;
        this.tone({ type: 'sine', from: 220, to: 1320, dur: 0.36, gain: 0.1 });
        this.tone({ type: 'triangle', from: 330, to: 990, at: 0.05, dur: 0.34, gain: 0.06 });
        const t = this.ctx.currentTime;
        this.filter.frequency.cancelScheduledValues(t);
        this.filter.frequency.setTargetAtTime(760, t, 0.18);
    }

    playThinkEnd() {
        if (!this.ready) return;
        this.tone({ type: 'sine', from: 990, to: 330, dur: 0.24, gain: 0.08 });
        const t = this.ctx.currentTime;
        this.filter.frequency.cancelScheduledValues(t);
        this.filter.frequency.setTargetAtTime(20000, t, 0.2);
    }

    /** Reset the bus, e.g. when a run ends while thinking was still active. */
    clearFilter() {
        if (!this.ctx) return;
        this.filter.frequency.cancelScheduledValues(this.ctx.currentTime);
        this.filter.frequency.setTargetAtTime(20000, this.ctx.currentTime, 0.05);
    }

    playHit() {
        if (!this.ready) return;
        this.clearFilter();
        this.tone({ type: 'sawtooth', from: 260, to: 42, dur: 0.4, gain: 0.16 });
        this.noise({ dur: 0.22, gain: 0.14, cutoff: 3000 });
        this.tone({ type: 'square', from: 90, to: 30, at: 0.06, dur: 0.34, gain: 0.1 });
    }

    /** Descending figure under the stack trace. */
    playGameOver() {
        if (!this.ready) return;
        [392, 349.23, 293.66, 220].forEach((f, i) => {
            this.tone({ type: 'triangle', from: f, at: 0.3 + i * 0.13, dur: 0.3, gain: 0.075 });
        });
    }

    /** Boot chatter — one blip per line of the startup sequence. */
    playBoot(i = 0) {
        if (!this.ready) return;
        this.tone({ type: 'square', from: 1200 + (i % 4) * 180, dur: 0.02, gain: 0.03 });
    }

    playClick() {
        if (!this.ready) return;
        this.tone({ type: 'sine', from: 820, to: 420, dur: 0.035, gain: 0.06 });
    }
}

window.soundController = new SoundController();
