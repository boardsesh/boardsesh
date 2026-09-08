# App Store screenshots against recorded fixtures

The store capture used to shoot the app against PROD, so every screenshot moved
whenever the data behind it moved — a new tick in a shared feed, a resolver
change, a rollout. The screenshot backend removes that: it records what PROD
answered once, then replays those bytes for every later capture. The screenshots
become a pure function of the JS bundle.

The server is `scripts/lib/screenshot-backend.ts`; everything it keys, validates
and logs is defined in the pure sibling `scripts/lib/screenshot-fixtures.ts`.

## The two modes

**record** proxies the app's traffic to an upstream (PROD by default), streams
the answer straight back, and writes a fixture for each new GraphQL key and each
new `/static/*` asset. It records nothing for a non-200, for a body with no
`data` key, or for a `200` carrying an `INTERNAL_SERVER_ERROR` extension — a
broken answer is not a fixture. First recording of a key wins; a repeat logs
`DUP` and is dropped, so the fixture set does not depend on scroll timing.

**replay** never makes an outbound request. It answers every GraphQL POST from
disk, hands out synthetic auth tokens for the recorded account, serves the
recorded asset bytes, and 404s anything it has no handler for.

Before it serves anything, replay **proves the fixture set readable**: every
graphql fixture the manifest names is read and parsed and checked against the
key it was filed under (`formatVersion`, `operationName`, `documentHash`,
`variablesHash`, and a `response` that is actually there), and every static file
is stat'd against its recorded byte count. Any problem and `listen()` rejects
with one error listing every offending file — a capture is a long unattended
run, so a fixture set that cannot be replayed has to fail at second zero, not
halfway through. If a fixture goes missing or truncated *during* a run, the
request answers the ordinary miss (200 + `errors`, or a `404` for an asset) and
logs `reason=unreadable-fixture`; it is never a 500.

A replay miss answers **HTTP 200 with a GraphQL `errors` array**, never a 5xx or
an `INTERNAL_SERVER_ERROR` extension — those are what flip the app's
connectivity store into "backend unreachable"
(`packages/mobile/src/lib/graphql/client.ts`) and swap every screen for the
connectivity banner, hiding the very miss the log is reporting. A 200 miss
instead makes `graphql-request` throw a `ClientError`, which React Query
reports as an errored query; `deriveOfflineQueryState`
(`packages/mobile/src/hooks/use-offline-query-state.ts`) then renders that
screen's own `OfflineState` placard with reason `error` — not an empty list.
The placard stays visible in the capture, which is exactly what makes a miss
noticeable at a glance, and the connectivity store itself is never tripped.

## CLI

```
vp run mobile:screenshot-backend -- --mode replay
vp run mobile:screenshot-backend -- --mode record --upstream https://ws.boardsesh.com --fresh
```

| Flag | Default |
| --- | --- |
| `--mode replay\|record` | required |
| `--port <n>` | `BOARDSESH_SCREENSHOT_BACKEND_PORT`, else `8090` |
| `--fixtures <dir>` | `packages/mobile/screenshot-fixtures` (relative to the repo root) |
| `--upstream <url>` | `https://ws.boardsesh.com` — record only |
| `--frozen-now <iso>` | record: now, to the second · replay: the manifest's `frozenNow` |
| `--flow <name>` | `app-store` — record only |
| `--fresh` | off — record only; discards the existing fixture set first |

It binds `0.0.0.0` so the iOS simulator (localhost) and the Android emulator
(`adb reverse`) both reach it, prints its `READY` line to stdout, and stays up
until SIGINT/SIGTERM. A recording run exits `1` if any fixture was refused for
carrying a live token; a replay run exits `1` before binding the port if the
startup check found a fixture it cannot replay, printing the list.

## Routes

| Route | replay | record |
| --- | --- | --- |
| `POST /graphql` | keyed lookup; a batch array is a `400` | proxied, then recorded |
| `POST /auth/native/credentials` | synthetic tokens for the recorded email, `401` for any other | proxied; the returned tokens stay in memory |
| `POST /auth/native/refresh` | synthetic tokens with a fresh expiry | proxied |
| `GET /static/*` | recorded bytes + recorded `Content-Type` | fetched with `redirect: follow`, keyed by the ORIGINAL path |
| `GET /health`, `/health/db` | `{"status":"healthy",...}` | same |
| `GET /__screenshot-backend/status` | the counters | same |
| WS upgrade on `/graphql` | inert graphql-ws: acks, pongs, never emits | same |
| anything else | `404` + `MISS route` | `404` + `MISS route` |

The catch-all is deliberately **not** proxied in either mode. A call nobody
handles is the one thing a capture has to learn about; proxying it would make a
"replay" run quietly depend on PROD.

The only subscription the store screens open is `ClimbStatsUpdated`, and they
render correctly when it never emits — so the WebSocket side speaks just enough
of graphql-ws to stop the client retrying, and then stays silent.

## Keying

A GraphQL fixture is identified by `(operationName, variablesHash)` and carries
a `documentHash` alongside it.

- `documentHash` = sha256 of the query with every whitespace run collapsed to a
  single space. `graphql-request`'s `gql` tag sends its template verbatim, so the
  raw bytes carry whatever the formatter last chose; hashing them directly would
  invalidate the world on a reflow.
- `variablesHash` = sha256 of the variables as canonical JSON: object keys
  sorted at every depth, `undefined` properties dropped, arrays left in order.

Splitting the two is what lets replay say `document-changed` (the query moved,
re-record) instead of `no-fixture` (nobody ever recorded this).

`IGNORED_VARIABLE_PATHS` excludes per-run client values from the variables hash —
today the `token` of the four push-token mutations
(`RegisterActivityPushToken` / `UnregisterActivityPushToken` from JS, and the
`RegisterToken` / `UnregisterToken` the Live Activity module sends under its own
names from Swift). **Only** client-generated values belong there (uuids, device
tokens, wall-clock stamps), never a data-shaping input: stripping a filter or a
cursor would collapse two different responses onto one fixture and the capture
would silently shoot the wrong data. The same list is applied at record and
replay, so the two can never disagree.

**An ignored path is hashed out AND redacted.** Two steps, both at record time:
the key ignores the value (so a later run sending a different token still hits
the fixture), and the persisted `variables` carry the literal
`<redacted:per-run>` in its place (so no client credential is committed). The
variable itself stays present — a fixture that dropped it would no longer show
what the app sends. `findSensitiveVariableKeys` runs *after* that swap and skips
a key already holding the literal, which is why an APNs push token is redacted
rather than refusing the fixture, while any other `password` / `secret` /
`token` / `credential` still refuses it outright.

Static assets are keyed on the original pathname plus its query sorted into a
stable order. PROD answers `/static/*` with a `302` to a CDN; the recorder
follows it for the bytes but files them under what the app asked for.

## On disk

```
packages/mobile/screenshot-fixtures/
  manifest.json
  graphql/<OperationName>/<variablesHash16>.json
  static/<key16>.<ext>
```

A graphql fixture's filename is 16 hex characters of the variables hash —
matching the static key length. Log lines still show the shorter 12-character
`FIXTURE_HASH_DISPLAY_LENGTH` prefix; only the on-disk filename uses 16.

`manifest.json` is rewritten after every new entry (temp file + rename), so a
SIGTERM mid-capture still leaves a manifest that matches the files beside it. Its
entries are sorted — graphql by operation then variables hash, static by path
then query — so re-recording an unchanged capture produces no diff. Every
`file` a manifest entry names is validated at load time: it must be a relative
path with no `..` segment, no leading `/`, no backslash, and it must actually
sit under `graphql/` or `static/` — a manifest that fails this refuses to load
rather than let a recorded path read outside the fixtures directory. The
server checks the same thing again immediately before it reads a fixture's
bytes off disk, as a second line of defense.

**Nothing header-derived is ever persisted.** Before a fixture is written its
serialized body is checked against the jwt and refresh token the recorder saw on
the proxied auth response; a match logs `REDACTED`, drops the fixture, and fails
the run at exit. The same check runs against the request's own `variables`: any
key that looks like `password`, `secret`, `token` or `credential` (at any depth,
case-insensitively — see `findSensitiveVariableKeys`) is refused before the
fixture is ever written, since a board-login mutation carries the climber's
Aurora credentials as an ordinary variable, not a header (the exception is an
ignored per-run path, already replaced by `<redacted:per-run>` — see Keying).
Replay hands out a synthetic session instead, so a fixture set is safe to
commit.

**`manifest.json`'s `accountEmail` is committed to the repo in plain text.**
Record fixtures only with the dedicated screenshots account
(`test@boardsesh.com`), never a personal one — whatever email signs in during
recording ends up readable in git history.

`manifest.json` also carries **`accountUserId`**: the `sub` claim the recorder
decoded (unverified, in memory) out of the live jwt the upstream returned. The
id is written; the token never is. Replay needs it because the app reads its own
user id back out of its session token (`userIdFromJwt`,
`packages/mobile/src/lib/jwt-user-id.ts`) to decide what is "yours" while
offline — so the synthetic session is a real jwt *shape*: three base64url
segments, `alg: none`, the recorded id as `sub`, `iss: screenshot-replay`, and
the literal `screenshot-replay` where a signature would be. The refresh token
stays the constant `screenshot-replay-refresh`. Both are inert: nothing verifies
them, because in replay nothing but the fixture set answers a request.

## Log grammar

Every line is single-line and prefixed `[screenshot-backend]`.

```
READY mode=replay port=8090 fixtures=<dir> frozenNow=<iso> graphql=<n> static=<n>
HIT graphql <Op> <hash12>
HIT static <path?query>
HIT auth credentials|refresh
MISS graphql <Op> <hash12> reason=no-fixture|document-changed|anonymous-operation|unreadable-fixture
MISS static <path?query>
MISS route <METHOD> <path>
MISS auth email=<e> expected=<e>
RECORDED graphql <Op> <hash12> -> <relative file>
RECORDED static <path?query> -> <relative file>
DUP graphql <Op> <hash12>
UPSTREAM-ERROR graphql <Op> status=<n>|code=INTERNAL_SERVER_ERROR
REDACTED graphql <Op>
NOTE graphql <Op> <note>
WS connection_init ack
WS subscribe <Op>
WS error <message>
```

`HIT auth` counts toward the "the app never reached the replay backend" check
the same as any other hit. `WS error` is never a problem line — it logs a
malformed frame the `ws` server rejected (bad RSV bits, an unmasked client
frame, …) so it is visible in the log, but one bad client frame must not fail
the capture or take the process down.

`findScreenshotBackendProblems(logText, { mode })` turns that log into the list a
capture run should fail on — one line per distinct problem, repeats collapsed
into `×N`, each line ending in the fix. Replay fails on any `MISS`, and on a log
with no `HIT` at all (the app never reached the backend). Record is *allowed* to
miss — that is what recording is — so it fails only on `UPSTREAM-ERROR`,
`MISS route` and `MISS auth`.

## Not here yet

The capture orchestrator (`scripts/mobile-screenshots.ts`) does not start this
server or set `EXPO_PUBLIC_BACKEND_URL` / `EXPO_PUBLIC_WS_URL` yet, and there is
no drift test asserting the recorded operation set still covers what the app
sends. Both land in follow-up PRs, along with the orchestrator's own
`--fixtures record|replay` flag — the remedy every problem message quotes
(`RE_RECORD_COMMAND`) already names it, but running that command does nothing
until the integration lands.
