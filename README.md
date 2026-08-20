# Claude Claw'd Run

An ASCII endless runner about shipping code, starring Claw'd the crab. Jump the
bugs, duck the rate limits, spend your context tokens on extended thinking.

Every pixel on screen is a character. There is no build step and no dependency —
the browser loads the plain files in `js/`, and the server's replay verifier
loads the very same ones, which is the whole trick behind the leaderboard.

Live: <https://claude-claw-d-run.vercel.app/>

---

## Playing

| key | |
|---|---|
| `space` / `↑` / `W` | jump — hold for height, tap for a hop |
| `↓` / `S` | duck, or drop faster while airborne |
| `shift` | extended thinking — slows the world while it burns tokens |
| `L` | leaderboard |
| `C` | change your crab |
| `P` `T` `M` `F` | pause · theme · mute · screen effects |

First launch asks for a handle and a shell colour. Enter on an empty field is a
real answer — it picks `anon-crab-NN` for you.

---

## Running it locally

```
npx vercel dev          # the game plus the /api routes
```

Or, with no API at all: open `index.html`. The board falls back to this
browser's own runs and says `leaderboard · this browser` on screen.

---

## Wiring up the leaderboard

Out of the box the API works with no database: it keeps the board in the
serverless instance's memory. Scores are still verified, they just do not
survive a cold start, and both the board and the death screen say so instead of
pretending otherwise.

To make it permanent you need a Redis-compatible KV store with an HTTP API.
Two ways, and the code accepts either set of names:

**Vercel's marketplace (easiest).** Project → Storage → add an Upstash Redis
database. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` into the
project's environment.

**Upstash directly.** Create a Redis database at
[console.upstash.com](https://console.upstash.com), then add its REST URL and
token as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

Either way, redeploy once so the functions pick the variables up. The board
header flips from `this deploy` to `global`, and the footnote under the table
changes to match. Nothing else needs to change.

The free tier is far more than this needs: a run costs one `ZADD` plus one
`HSET`, and the board itself is cached for ten seconds at the edge.

### Why not Firebase

Firebase would work, but its client SDK is bigger than this entire game, and
putting the database in the browser means the browser is the thing that decides
what a score is. The interesting problem in a leaderboard is not storage, it is
*belief* — and that is a server problem. This one is four `fetch` calls.

---

## How a score gets believed

The game records your keypresses, not your score.

Runs are seeded: `RNG.play` drives everything that affects the outcome, and a
separate `RNG.look` drives things that only affect how it looks. So a seed plus
your keypresses fully determines a run. The client delta-encodes those into a
short string — a 40-second run is about 40 events and 120 bytes — and
`/api/submit` replays them through the real engine in a `vm` context and
compares the score it computes with the one you claimed.

```
POST /api/submit   { v, name, skin, seed, score, trace }
GET  /api/top?limit=10
```

`RULES_VERSION` in `js/trace.js` couples the two. Change the physics, bump it,
and old traces are rejected with a 409 that tells the player to reload rather
than silently scoring them under new rules.

The failure mode that matters is not cheating, it is a verifier that rejects
honest players because the simulation drifted. So:

```
node tools/verify-replay.js
```

plays eight seeded runs with a bot, encodes each trace exactly as the browser
would, and hands it to the same `api/_replay.js` that `/api/submit` uses. Every
field has to come back identical. It also replays each trace twice (to catch
state leaking between calls) and once with the keypresses thrown away (to catch
a verifier that is ignoring the trace and passing for the wrong reason).

The recorder is deliberately handicapped: it sits through the boot typewriter,
idles on the menu, and plays the runs back to back through the death panel, so
`tick`, the cosmetic RNG and the particle pool are all somewhere a fresh replay
could never guess.

---

## Reviewing the layout

In a game where every pixel is a character, the layout can be reviewed without a
browser — run the real engine, call the real draw code, print the buffer:

```
node tools/screens.js                        # all 15 screens
node tools/screens.js menu boardOnline dead  # just those
```

Colour and bloom are missing, but colour is not where box-drawing goes wrong.
Alignment is, and alignment is all there.

---

## Layout

```
index.html            one terminal window; the game's statusline is its UI
style.css             the window chrome, the CRT, the touch pad
js/rng.js             xorshift32, two streams: play and look
js/trace.js           input recording, delta-encoded — and RULES_VERSION
js/glyphs.js          sprites, palettes, the eight shells, biomes
js/terminal.js        the character grid: ch / col / al buffers, bloom, scanlines
js/profile.js         handle + shell, and the handle normaliser the server reuses
js/audio.js           WebAudio, built lazily on first input
js/particles.js       dust, sparks, token pops
js/entities.js        Claw'd, hazards, tokens, the world
js/leaderboard.js     the board client, and where its rows actually live
js/game.js            states, fixed-timestep loop, every screen
api/submit.js         verify a run, then record it
api/top.js            read the board
api/_replay.js        the engine in a vm context, headless
api/_store.js         Redis sorted set over Upstash REST, with a memory fallback
tools/verify-replay.js  the test that makes the board's promise true
tools/screens.js        every screen as text
tools/_bot.js           a bot that presses keys, for both tools
```

Colours are palette *keys* all the way down, resolved at raster time — which is
why switching theme or shell recolours the whole screen instantly, and why
adding a ninth crab is one entry in `SKINS`.

## Licence

MIT.
