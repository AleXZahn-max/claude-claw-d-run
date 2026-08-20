/**
 * A bot that plays the real game, for the tools in this folder.
 *
 * It presses keys rather than moving the hero, and it presses them on edges only
 * — one keydown, one keyup — because that is what a keyboard produces and
 * therefore what the trace format has to survive. A bot that reached into
 * `hero.vy` would prove nothing about the recording path.
 */

function makeBot(sandbox) {
    const { GEO, jumpCells } = sandbox;
    let jumpDown = false;
    let duckDown = false;

    /**
     * @param game  the live Game instance
     * @param steer false hands the controller back, so the run ends on its own
     */
    return function bot(game, steer = true) {
        const hero = game.hero;
        if (hero.dead) return;

        let wantJump = false;
        let wantDuck = false;

        if (steer) {
            const pb = hero.hitbox;
            for (const h of game.hazards) {
                const hb = h.hitbox;
                const dist = hb[0] - pb[2];
                if (hb[2] < pb[0] - 1) continue;
                if (h.def.air) {
                    if (dist < 16 && hb[2] > pb[0] - 2) wantDuck = true;
                } else {
                    // The same lead the game's own token arcs assume: mid-window.
                    const lead = jumpCells(game.speed) * 0.45;
                    if (dist > 0 && dist < lead) wantJump = true;
                    if (dist <= 0 && hb[2] > pb[0]) wantJump = true;
                }
            }

            // Tokens are worth a jump only when the road is empty. Spending the
            // jump a hazard needs is how this bot used to die at score 120.
            const reach = jumpCells(game.speed);
            let roadClear = true;
            for (const h of game.hazards) {
                if (h.def.air) continue;
                const d = h.hitbox[0] - pb[2];
                if (d > -6 && d < reach * 1.2) roadClear = false;
            }
            if (!wantJump && !wantDuck && hero.grounded && roadClear) {
                for (const tk of game.tokens) {
                    const d = tk.x - pb[2];
                    const lift = GEO.standRow - tk.row;
                    if (d > 3 && d < 12 && lift > 2 && lift < 10) { wantJump = true; break; }
                }
            }
        }

        // Ducking wins outright, and jump stays held for the whole flight so the
        // arc reaches full height instead of being cut short by a stray keyup.
        const nextDuck = wantDuck;
        const nextJump = !wantDuck && (wantJump || !hero.grounded);

        if (nextDuck !== duckDown) { game.secondary(nextDuck); duckDown = nextDuck; }
        if (nextJump !== jumpDown) {
            if (nextJump) game.primary(); else game.release();
            jumpDown = nextJump;
        }
        if (steer && game.think >= 0.55 && !game.thinking) game.tryThink();
    };
}

module.exports = { makeBot };
