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
| `G` | sign in with GitHub |
| `P` `T` `M` `F` | pause · theme · mute · screen effects |

First launch asks for a handle and a shell colour. Enter on an empty field is a
real answer — it picks `anon-crab-NN` for you.

That handle is yours on this browser. The *global* board is by GitHub login, so a
row there belongs to somebody — see [Signing in with
GitHub](#signing-in-with-github).

---

## Running it locally

```
npx vercel dev          # the game plus the /api routes
```

Or, with no API at all: open `index.html`. The board falls back to this
browser's own runs and says `leaderboard · this browser` on screen.

Signing in needs an OAuth App per callback URL, so localhost wants its own — see
[Signing in with GitHub](#signing-in-with-github). Without one the titlebar
button reads `guest` and everything else works.

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

If an integration gives you only a connection string, `REDIS_URL` or `KV_URL`
in the form `rediss://default:TOKEN@host.upstash.io:6379` works too — the REST
endpoint is the same host over https and the password is the token, so the code
derives both from it.

Either way, redeploy once so the functions pick the variables up. The board
header flips from `this deploy` to `global`, and the footnote under the table
changes to match. Nothing else needs to change.

The free tier is far more than this needs: a run costs one `ZADD` plus one
`HSET`, and the board itself is cached for ten seconds at the edge.

> **Not Edge Config.** Vercel's storage menu also offers *Global Config
> Storage* — that is Edge Config, and it is not a database. It is a
> read-optimised store for things like feature flags: reads are fast and free,
> but writes go through the Vercel management API, not through your function.
> A leaderboard cannot live in it. It sets `EDGE_CONFIG`, which is not a name
> this code looks for, so picking it leaves the board in memory mode.

### Is the store actually wired up?

`GET /api/top?debug=1` answers it from outside the deploy:

```json
{ "rows": [], "store": "memory",
  "env": { "configured": false, "present": ["EDGE_CONFIG"],
           "hint": "found EDGE_CONFIG only. Edge Config is not a database — …" } }
```

`store` is the same three-valued answer the game shows: `redis` (persistent),
`memory` (this instance only), `local` (the API was unreachable, so the board
you are looking at is your own browser's). `env.present` lists which of the
names the code looks for are set — **names only, never values**; a token never
appears in a response.

### Why not Firebase

Firebase would work, but its client SDK is bigger than this entire game, and
putting the database in the browser means the browser is the thing that decides
what a score is. The interesting problem in a leaderboard is not storage, it is
*belief* — and that is a server problem. This one is four `fetch` calls.

---

## Signing in with GitHub

A typed handle is not a name, it is a costume. Anyone can put it on, which means
a row that says `kayza` says nothing about who played the run. So the global
board is gated: you play as a guest for as long as you like and keep a personal
best and a board of your own runs, but to put a row on the *global* board you
sign in with GitHub. Logins are unique by construction, so squatting stops being
possible rather than being forbidden.

Nothing in the game requires it. There is no wall, no modal, and no dark pattern
where the score you just earned is held hostage. A guest's death screen says
where the run went and offers `g`; that is the whole of the pressure.

Once you are in, the titlebar button becomes your face and your handle:
`github.com/<login>.png`, ringed in the same coral as the process dot beside it.
No avatar URL is stored anywhere — the login *is* the URL, so there is nothing to
keep in sync when you change your picture, and nothing to show when the request
fails except the button you already had.

### Setting it up

1. **Create the OAuth App.** github.com → Settings → Developer settings → OAuth
   Apps → *New OAuth App*.

   | field | value |
   |---|---|
   | Application name | anything — this is what the consent screen shows |
   | Homepage URL | `https://your-deploy.vercel.app/` |
   | Authorization callback URL | `https://your-deploy.vercel.app/api/callback` |

   The callback must match exactly, path included. GitHub compares it against
   what the code sends and refuses the handshake on any difference — which is
   also why deriving the redirect from the request host is safe.

2. **Generate a client secret** on the same page, and copy it now. GitHub shows
   it once.

3. **Add two environment variables** in Vercel → Project → Settings →
   Environment Variables:

   | name | |
   |---|---|
   | `GITHUB_CLIENT_ID` | public; it appears in the URL you are redirected to |
   | `GITHUB_CLIENT_SECRET` | **secret**; Vercel only, never the repo, never `js/` |

4. **Redeploy.** Env vars are read at cold start, so an existing deployment will
   not pick them up.

Two optional ones:

| name | |
|---|---|
| `SESSION_SECRET` | ≥16 chars. Signs session cookies. Left unset, the key is derived from `GITHUB_CLIENT_SECRET`, which means rotating the client secret signs everyone out — usually what you want anyway. |
| `OAUTH_REDIRECT` | Overrides the derived callback URL. Only needed if the deploy sits behind a proxy that rewrites the host. |

An OAuth App has one callback URL, so `vercel dev` on `localhost:3000` needs a
second App with `http://localhost:3000/api/callback` and its own credentials in
`.env.local`. Without one, the game still runs locally — the titlebar button
reads `guest` and the board stays local.

`GET /api/top?debug=1` reports the state of this half too:

```json
{ "auth": { "configured": true,
            "present": ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
            "signingKey": "derived from GITHUB_CLIENT_SECRET" } }
```

Names only, never values — same rule as the store report.

### What the session is

A signed cookie, not a session table:

```
clawd_sess = base64url({login, gid, exp}) . HMAC-SHA256(that, key)
```

Verifying it is one hash and no network, which is why `/api/submit` can check
identity before it spends any CPU on a replay. The trade is that it cannot be
revoked before it expires — correct for a leaderboard, wrong for a bank.

Details that are deliberate rather than incidental:

- **The scope is empty.** GitHub's consent screen therefore says *public
  information only*. A game that asked for `repo` would deserve to be closed.
- **The access token is revoked immediately** after the one call that reads your
  login. Keeping it would be a liability with no upside.
- **`HttpOnly`**, so `js/auth.js` structurally cannot read the session — it can
  only ask the server what it says.
- **`SameSite=Lax`, not `Strict`.** Coming back from github.com is a cross-site
  navigation; `Strict` would withhold the cookie on precisely the request that
  has to compare the CSRF `state`.
- **The signature is checked before the payload is parsed**, so `JSON.parse`
  never runs on attacker-chosen input for free.
- **Both the signature and the `state` are compared with
  `crypto.timingSafeEqual`.** `===` on strings returns early and leaks how much
  of a forgery was right.
- **Logging out is `POST` only.** A `GET` logout can be fired by an `<img>` tag
  on somebody else's page.

### The name is not in the request

```
POST /api/submit   { v, skin, seed, score, trace }   + the session cookie
```

There is no `name` field the server reads. It takes the login from the cookie
and stores that, so the two questions a leaderboard has to answer — *did this
run happen* and *is this person who they say they are* — are both answered on
the server and neither is answered by the client.

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
POST /api/submit   { v, skin, seed, score, trace }
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
node tools/screens.js                        # all 19 screens
node tools/screens.js menu boardOnline dead  # just those
```

Colour and bloom are missing, but colour is not where box-drawing goes wrong.
Alignment is, and alignment is all there.

Screens that depend on who you are come in both versions — `menuAnon` and
`menuMember`, `profile` and `profileMember`, `deadAnon` next to `dead` — because
the two identities disagree about more of the layout than you would guess.

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
js/auth.js            three states and one probe; no token ever reaches it
js/audio.js           WebAudio, built lazily on first input
js/particles.js       dust, sparks, token pops
js/entities.js        Claw'd, hazards, tokens, the world
js/leaderboard.js     the board client, and where its rows actually live
js/game.js            states, fixed-timestep loop, every screen
api/submit.js         verify a run, then record it — under the name in the cookie
api/top.js            read the board
api/login.js          mint a CSRF state, redirect to github
api/callback.js       compare the state, swap the code, revoke the token
api/me.js             who the cookie says you are; also saves your shell
api/logout.js         drop the cookie (POST only)
api/_auth.js          the signed session, and the two URLs of the handshake
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
