/**
 * Claude Claw'd Run — Glyph Library
 *
 * Every visual in this game is a character on a grid. This file holds the art:
 * palettes, sprites, and the colour masks that paint them.
 *
 * A sprite is { rows: string[], mask: string[]|null, tint: string }.
 * `rows` are the characters. `mask` is a parallel grid where each character is a
 * palette key (see PAINT below); a space in the mask means "use the tint".
 * Sprites are normalised to a rectangle on load, so authoring can stay loose.
 */

const R = String.raw;

/**
 * A raw template cannot end in a backslash — the lexer reads it as escaping the
 * closing backtick. Art rows that end in one are concatenated with this instead.
 */
const BS = '\\';

/* ------------------------------------------------------------------ *
 * Palettes
 *
 * Warm near-black, not the usual blue-black: Claude's identity is warm,
 * and the whole board should feel lit by the mascot rather than by a UI kit.
 * The accent is Claude's own coral. Everything else is a muted ANSI-ish
 * spread so obstacles can carry meaning by hue.
 * ------------------------------------------------------------------ */

const PALETTES = {
    dark: {
        bg:        '#12100E',
        bgDeep:    '#0B0A09',
        panel:     '#1A1714',
        claw:      '#D97757',
        clawHot:   '#F6AE90',
        clawDeep:  '#A9502F',
        shell:     '#E08A63',
        eye:       '#FFF6F0',
        bug:       '#E06C75',
        bugDeep:   '#8E3D45',
        cyan:      '#56B6C2',
        cyanHot:   '#9BE7F0',
        ok:        '#98C379',
        amber:     '#E5C07B',
        violet:    '#C08BE0',
        fg:        '#D6CCC2',
        fgDim:     '#8A7F76',
        dim:       '#4A423C',
        dimmer:    '#2E2925',
        white:     '#FFFFFF',
    },
    light: {
        bg:        '#F4EEE5',
        bgDeep:    '#E8E0D4',
        panel:     '#FBF7F1',
        claw:      '#C35A32',
        clawHot:   '#E07A4E',
        clawDeep:  '#8A3D1E',
        shell:     '#B85028',
        eye:       '#2A1E18',
        bug:       '#C0392F',
        bugDeep:   '#8A2820',
        cyan:      '#1E7A88',
        cyanHot:   '#0F5560',
        ok:        '#4C7A2E',
        amber:     '#9A6B12',
        violet:    '#7A4C9E',
        fg:        '#3A302A',
        fgDim:     '#6B5F55',
        dim:       '#B5A899',
        dimmer:    '#D3C8BA',
        white:     '#2A1E18',
    },
};

/** Single-letter mask keys → palette keys. Keeps masks readable as art. */
const PAINT = {
    c: 'claw',      // claw pincers
    a: 'clawDeep',  // arms / joints
    s: 'shell',     // carapace
    e: 'eye',       // eyes
    l: 'clawDeep',  // legs
    h: 'clawHot',   // highlight
    b: 'bug',
    d: 'bugDeep',
    y: 'cyan',
    Y: 'cyanHot',
    g: 'ok',
    m: 'amber',
    v: 'violet',
    f: 'fg',
    n: 'fgDim',
    x: 'dim',
    w: 'white',
};

/** Pad every row to the widest, so a sprite is always a clean rectangle. */
function sprite(rows, mask = null, tint = 'fg') {
    const w = Math.max(...rows.map((r) => r.length));
    const pad = (arr) => arr.map((r) => r.padEnd(w, ' '));
    const out = { rows: pad(rows), mask: mask ? pad(mask) : null, tint, w, h: rows.length };
    if (mask && mask.length !== rows.length) out.mask = null; // ragged mask: fall back to tint
    return out;
}

/* ================================================================== *
 * 1. CLAW'D
 *
 * The hero is drawn as a fixed body plus swappable legs and face, so the
 * run cycle animates without redrawing the silhouette every frame.
 * Body is 15x5; legs are row 5; the face is overlaid onto rows 2 and 3.
 * ================================================================== */

const CLAWD = {
    /** Rows 0-4. Row 5 comes from LEGS. */
    body: sprite([
        R` (\/)     (\/) `,
        R`  \_,-----,_/  `,
        R`   /● . . ●\   `,
        R`  | \_____/ |  `,
        R`   \_______/   `,
    ], [
        R` cccc     cccc `,
        R`  aasssssssaa  `,
        R`   se a a es   `,
        R`  s sssssss s  `,
        R`   sssssssss   `,
    ], 'claw'),

    /** Four-step gait. Index cycles with distance travelled, not with time. */
    legs: [
        sprite([R`   //  |  \\   `], [R`   ll  l  ll   `], 'clawDeep'),
        sprite([R`   /|  |  |\   `], [R`   ll  l  ll   `], 'clawDeep'),
        sprite([R`   |\  |  /|   `], [R`   ll  l  ll   `], 'clawDeep'),
        sprite([R`   /|  |  |\   `], [R`   ll  l  ll   `], 'clawDeep'),
    ],

    /** Claws snap shut on a beat — a small tell that he's alive. */
    clawsOpen:   sprite([R` (\/)     (\/) `], [R` cccc     cccc `], 'claw'),
    clawsShut:   sprite([R` (><)     (><) `], [R` cccc     cccc `], 'claw'),
    clawsUp:     sprite([R` \\/)     (\// `], [R` cccc     cccc `], 'claw'),

    /**
     * Faces are overlaid at (4,2)/(10,2) for eyes and (4,3) for a 7-wide mouth.
     * Keeping them separate means every expression works in every pose.
     */
    faces: {
        normal: { eyes: ['●', '●'], mouth: R`\_____/`, eye: 'eye',     lip: 'shell'   },
        blink:  { eyes: ['-', '-'], mouth: R`\_____/`, eye: 'eye',     lip: 'shell'   },
        wide:   { eyes: ['◉', '◉'], mouth: R`\_ooo_/`, eye: 'eye',     lip: 'clawHot' },
        think:  { eyes: ['◔', '◔'], mouth: R`~~~~~~~`, eye: 'cyanHot', lip: 'cyan'    },
        happy:  { eyes: ['^', '^'], mouth: R`\_____/`, eye: 'eye',     lip: 'clawHot' },
        dead:   { eyes: ['x', 'x'], mouth: R`/\/\/\/`, eye: 'bug',     lip: 'bugDeep' },
        hurt:   { eyes: ['@', '@'], mouth: R`/\/\/\/`, eye: 'bug',     lip: 'bug'     },
    },

    /** Airborne: claws flung wide, legs tucked. Same 15-wide footprint. */
    jump: sprite([
        R` \/         \/ `,
        R` /\_,-----,_/\ `,
        R`   /● . . ●\   `,
        R`  | \_ooo_/ |  `,
        R`   \_______/   `,
        R`    ^^   ^^    `,
    ], [
        R` cc         cc `,
        R` aaasssssssaaa `,
        R`   se a a es   `,
        R`  s sssssss s  `,
        R`   sssssssss   `,
        R`    ll   ll    `,
    ], 'claw'),

    /** Falling: claws down, braced for landing. */
    fall: sprite([
        R`  \_,-----,_/  `,
        R` (/\)     (/\) `,
        R`   /● . . ●\   `,
        R`  | \_____/ |  `,
        R`   \_______/   `,
        R`   \\  |  //   `,
    ], [
        R`  aasssssssaa  `,
        R` cccc     cccc `,
        R`   se a a es   `,
        R`  s sssssss s  `,
        R`   sssssssss   `,
        R`   ll  l  ll   `,
    ], 'claw'),

    /** Ducking: 17 wide, 4 tall — flattened against the deck. */
    duck: sprite([
        R`  (\/)       (\/)  `,
        R`   \_,-------,_/   `,
        R`   /● . . . . ●\   `,
        R`  '-\_________/-'  `,
        R`   ^^  ^   ^  ^^   `,
    ], [
        R`  cccc       cccc  `,
        R`   aasssssssssaa   `,
        R`   se a a a a es   `,
        R`  sssssssssssssss  `,
        R`   ll  l   l  ll   `,
    ], 'claw'),

    /** Crashed: tipped onto the shell, claws limp. */
    dead: sprite([
        R`  \/,       ,\/ `,
        R`   \'-.   .-'/  `,
        R`    \  x x  /   `,
        R`    | /\/\/ |   `,
        R`    /_______\   `,
        R`   \\   |   //  `,
    ], [
        R`  cca       acc `,
        R`   aass   ssaa  `,
        R`    s  e e  s   `,
        R`    s sssss s   `,
        R`    sssssssss   `,
        R`   ll   l   ll  `,
    ], 'clawDeep'),
};

/* ================================================================== *
 * 2. OBSTACLES
 *
 * Each one is a thing that actually goes wrong in a coding session, so the
 * hazards read as jokes rather than as generic spikes.
 * ================================================================== */

const OBSTACLES = {
    /** A single escaped bug. Low — clear it with a short hop. */
    bug: sprite([
        R` ,--. `,
        R`(x  x)`,
        R` /\/\ `,
    ], null, 'bug'),

    /** Two of them. Wider, so the hop has to be committed. */
    bugPair: sprite([
        R` ,--.  ,--. `,
        R`(x  x)(x  x)`,
        R` /\/\  /\/\ `,
    ], null, 'bug'),

    /** Unresolved merge conflict. Tall, unmistakable, universally hated. */
    conflict: sprite([
        R`<<<<<<< HEAD`,
        R`  ours      `,
        R`============`,
        R`  theirs    `,
        R`>>>>>>> feat`,
    ], [
        R`bbbbbbb nnnn`,
        R`  nnnn      `,
        R`mmmmmmmmmmmm`,
        R`  nnnnnn    `,
        R`ggggggg nnnn`,
    ], 'bug'),

    /** node_modules. The tallest thing on the ground, obviously. */
    nodeModules: sprite([
        R` __________ `,
        R`|          |`,
        R`| node_    |`,
        R`|   modules|`,
        R`|~~~~~~~~~~|`,
        R`|__________|`,
    ], [
        R` nnnnnnnnnn `,
        R`n          n`,
        R`n ggggg    n`,
        R`n   gggggggn`,
        R`nxxxxxxxxxxn`,
        R`nnnnnnnnnnnn`,
    ], 'fgDim'),

    /** Null pointer. Narrow but tall — a precision jump. */
    nullPtr: sprite([
        R` null `,
        R`  ||  `,
        R`  ||  `,
        R`  ||  `,
        R` _||_ `,
    ], [
        R` vvvv `,
        R`  vv  `,
        R`  vv  `,
        R`  vv  `,
        R` vvvv `,
    ], 'violet'),

    /** Segfault: the ground itself is broken. */
    segfault: sprite([
        R`SIGSEGV`,
        R` \|/|/ `,
        R`  \|/  `,
    ], [
        R`bbbbbbb`,
        R` ddddd `,
        R`  ddd  `,
    ], 'bug'),
};

/** Flying hazards. Ducked under, never jumped over. */
const FLYERS = {
    /** Rate limit. It hovers at head height and judges you. */
    rateLimit: sprite([
        R`  _429_  `,
        R` [-o-o-] `,
        R`  \~~~/  `,
    ], [
        R`  mmmmm  `,
        R` bbbbbbb `,
        R`  yyyyy  `,
    ], 'amber'),

    /** Timeout drone. Faster than the rest of the world. */
    timeout: sprite([
        R` <ETIMEDOUT> `,
        R`  [o]---[o]  `,
        R`   \  ~  /   `,
    ], [
        R` bbbbbbbbbbb `,
        R`  yyyyyyyyy  `,
        R`   y  y  y   `,
    ], 'bug'),
};

/** The infinite loop spins. Four frames, one per rotation step. */
const LOOP_FRAMES = [
    sprite([R` while `, R` (true)`, R`   |   `], null, 'violet'),
    sprite([R` while `, R` (true)`, R`   /   `], null, 'violet'),
    sprite([R` while `, R` (true)`, R`   -   `], null, 'violet'),
    sprite([R` while `, R` (true)`, R`   \   `], null, 'violet'),
];

/* ================================================================== *
 * 3. PICKUPS
 * ================================================================== */

/** A context token. Pulses through four sizes so it reads as collectable. */
const TOKEN_FRAMES = [
    sprite([R` ◆ `], null, 'cyan'),
    sprite([R`·◆·`], null, 'cyanHot'),
    sprite([R`◇◆◇`], null, 'cyanHot'),
    sprite([R`·◆·`], null, 'cyan'),
];

/** Dropped when a run ends well. Restores a slice of the thinking meter. */
const SPARK_FRAMES = [
    sprite([R` * `], null, 'amber'),
    sprite([R`\*/`], null, 'amber'),
    sprite([R`-*-`], null, 'amber'),
    sprite([R`/*` + BS], null, 'amber'),
];

/* ================================================================== *
 * 4. WORLD DECOR
 *
 * Parallax furniture. All of it is drawn in the dim palette so it never
 * competes with anything the player has to react to.
 * ================================================================== */

const DECOR = {
    clouds: [
        sprite([R`  .-~-.  `, R` (     ) `, R`  '~-~'  `], null, 'dim'),
        sprite([R`   .--~~--.   `, R` .'          '. `, R`  '~--__--~'  `], null, 'dim'),
        sprite([R` .-. `, R`(   )`], null, 'dim'),
    ],

    /** Skyline built from code punctuation instead of buildings. */
    skyline: [
        sprite([R` /\ `, R`/{}` + BS], null, 'dimmer'),
        sprite([R`  ___  `, R` |___| `], null, 'dimmer'),
        sprite([R` /\/\ `, R`/ () ` + BS], null, 'dimmer'),
        sprite([R` [] `, R` [] `], null, 'dimmer'),
        sprite([R` <> `, R`/__` + BS], null, 'dimmer'),
    ],

    /** Foreground trees: a directory tree, naturally. */
    trees: [
        sprite([R`├──`, R`│  `, R`└──`], null, 'dim'),
        sprite([R`├─┬`, R`│ └`, R`└──`], null, 'dim'),
    ],

    stars: ['·', '.', '*', '+', '˙', '✦'],

    /** Scrolls behind the world during extended thinking. */
    thoughts: [
        'analysing', 'let me think', 'considering', 'hmm', 'weighing options',
        'checking edge cases', 'that tracks', 'reconsidering', 'one moment',
        'tracing the call', 'what if', 'almost',
    ],
};

/* ================================================================== *
 * 5. BIOMES
 *
 * The run moves through four places. Each swaps the accent colour, the
 * ground texture and the furniture, so progress is legible at a glance.
 * ================================================================== */

const BIOMES = [
    {
        id: 'repo',
        name: '~/dev/clawd-run',
        note: 'clean working tree',
        accent: 'ok',
        ground: '=',
        fill: ['.', ' ', ' ', ' ', '·', ' ', ' '],
        decor: 'clouds',
        threshold: 0,
    },
    {
        id: 'modules',
        name: '~/node_modules',
        note: '48,213 packages',
        accent: 'amber',
        ground: '#',
        fill: ['{', '}', ' ', ':', ' ', ' ', '"'],
        decor: 'skyline',
        threshold: 900,
    },
    {
        id: 'prod',
        name: '/var/log/prod',
        note: 'incident in progress',
        accent: 'bug',
        ground: '~',
        fill: ['!', ' ', ' ', 'E', ' ', ' ', '!'],
        decor: 'skyline',
        threshold: 2200,
    },
    {
        id: 'loop',
        name: '/dev/null',
        note: 'nothing escapes',
        accent: 'violet',
        ground: '-',
        fill: [' ', '0', ' ', '1', ' ', '0', ' '],
        decor: 'clouds',
        threshold: 4000,
    },
];

/* ================================================================== *
 * 6. TITLE
 *
 * The display typography is the ASCII art itself — there is no second
 * typeface, because a terminal does not have one.
 * ================================================================== */

const TITLE = sprite([
    R`  ____  _         _    __        __  _  ____  `,
    R` / ___|| |       / \   \ \      / / ( )|  _ \ `,
    R`| |    | |      / _ \   \ \ /\ / /   \|| | | |`,
    R`| |___ | |___  / ___ \   \ V  V /      | |_| |`,
    R` \____||_____|/_/   \_\   \_/\_/       |____/ `,
], null, 'claw');

/* ------------------------------------------------------------------ *
 * Box-drawing sets, for panels rendered inside the grid.
 * ------------------------------------------------------------------ */
const BOX = {
    round:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
    sharp:  { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
    double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
    heavy:  { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};

/** Meter fills, coarse → fine. */
const METER = { full: '█', half: '▓', light: '░', empty: '·' };

const GLYPHS = {
    PALETTES, PAINT, sprite,
    CLAWD, OBSTACLES, FLYERS, LOOP_FRAMES,
    TOKEN_FRAMES, SPARK_FRAMES,
    DECOR, BIOMES, TITLE, BOX, METER,
};

if (typeof window !== 'undefined') window.GLYPHS = GLYPHS;
if (typeof module !== 'undefined') module.exports = GLYPHS;
