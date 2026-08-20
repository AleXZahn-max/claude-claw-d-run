/**
 * Claude Claw'd Run — Run traces
 *
 * The wire format of a run. A submitted score is not a number the client asks to
 * be believed: it is a seed plus the exact keypresses, and the server replays
 * them through this same simulation and computes the score itself. So this file
 * is the contract between the two, and both sides load it.
 *
 * An event is [step, code] where `step` is the count of completed simulation
 * steps at the moment the key was pressed, and `code` is one letter:
 *
 *   j  jump pressed        J  jump released (cuts the arc short)
 *   d  duck pressed        D  duck released
 *   t  extended thinking
 *
 * On the wire it is delta-encoded — "40j9J137d22D" — because the deltas are
 * small numbers and a 200-second run is then about a kilobyte.
 */

/**
 * Bump this whenever anything in PHYS, TUNING, HAZARDS or the Spawner changes.
 * A trace only means something under the rules it was recorded against; without
 * a version, a physics retune silently starts rejecting honest players.
 */
const RULES_VERSION = 3;

/** Every code the replay will act on. Anything else is rejected as malformed. */
const TRACE_CODES = 'jJdDt';

/** Sanity ceiling on a submitted trace: ~40 minutes of dense input. */
const TRACE_MAX_EVENTS = 20000;

function encodeTrace(events) {
    let last = 0;
    let out = '';
    for (const [step, code] of events) {
        out += (step - last) + code;
        last = step;
    }
    return out;
}

function decodeTrace(str) {
    const out = [];
    if (!str) return out;
    let last = 0;
    const re = /(\d{1,7})([a-zA-Z])/g;
    let m;
    let consumed = 0;
    while ((m = re.exec(String(str)))) {
        if (m.index !== consumed) return null;      // junk between events
        consumed = re.lastIndex;
        if (!TRACE_CODES.includes(m[2])) return null;
        last += parseInt(m[1], 10);
        out.push([last, m[2]]);
        if (out.length > TRACE_MAX_EVENTS) return null;
    }
    if (consumed !== String(str).length) return null; // junk at the end
    return out;
}

if (typeof window !== 'undefined') {
    window.RULES_VERSION = RULES_VERSION;
    window.TRACE_CODES = TRACE_CODES;
    window.TRACE_MAX_EVENTS = TRACE_MAX_EVENTS;
    window.encodeTrace = encodeTrace;
    window.decodeTrace = decodeTrace;
}
if (typeof module !== 'undefined') {
    module.exports = { RULES_VERSION, TRACE_CODES, TRACE_MAX_EVENTS, encodeTrace, decodeTrace };
}
