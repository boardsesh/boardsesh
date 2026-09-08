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
| `--frozen-now <iso>` | record: the START instant (a FLOOR, not the final value — see "The frozen clock" below), defaults to now, to the second · replay: the manifest's `frozenNow` |
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

Only a `HIT graphql` line counts toward the "the app never reached the replay
backend" check — an app that only ever authenticated (`HIT auth`) never actually
exercised a screen's data, so that alone must still fail the check. `WS error`
is never a problem line — it logs a malformed frame the `ws` server rejected
(bad RSV bits, an unmasked client frame, …) so it is visible in the log, but one
bad client frame must not fail the capture or take the process down.

`findScreenshotBackendProblems(logText, { mode })` turns that log into the list a
capture run should fail on — one line per distinct problem, repeats collapsed
into `×N`, each line ending in the fix. Replay fails on any `MISS`, and on a log
with no `HIT graphql` at all (the app never reached the backend, even if it did
authenticate). Record is *allowed* to miss — that is what recording is — so it
fails only on `UPSTREAM-ERROR`, `MISS route` and `MISS auth`.

## Running a capture against fixtures

The orchestrator owns the backend's lifecycle: `--fixtures replay|record` starts
it once per platform run, points the JS bundle at it, and stops it in the same
`finally` that stops Metro.

```
vp run mobile:screenshots -- --fixtures replay --platform ios --devices common --locales all
vp run mobile:screenshots -- --fixtures record --backend prod --platform ios --devices common --locales en-US --fresh
```

| Flag | What it does |
| --- | --- |
| `--fixtures off` | the default; the app talks to `--backend` and nothing changes |
| `--fixtures record` | proxy `--backend` and write down every answer |
| `--fixtures replay` | serve the recorded set; no outbound request is made |
| `--fixtures-dir <path>` | where the set lives (default `packages/mobile/screenshot-fixtures`, relative to the repo root) |
| `--fresh` | record only; discard the existing set first (consumed once per PROCESS — a `--platform all` run starts a backend per platform, and only the first one gets `--fresh`, so the second platform doesn't wipe the first's recording) |
| `--frozen-now <iso>` | record only; override the minted instant instead of using now-to-the-second. Validated as a parseable ISO instant. Optional even for a multi-shard recording — the merge takes the max regardless (see "Recording a set" above). |

`--backend` keeps its old meaning throughout: it names the UPSTREAM. A recording
proxies it, a replay ignores it.

With `--fixtures` on, Metro is started with

```
EXPO_PUBLIC_BACKEND_URL=http://localhost:8090
EXPO_PUBLIC_WS_URL=ws://localhost:8090/graphql
EXPO_PUBLIC_SCREENSHOT_NOW=<the set's frozenNow>
```

overriding whatever `--backend` would have set (`BOARDSESH_SCREENSHOT_BACKEND_PORT`
moves the port). `EXPO_PUBLIC_WEB_URL` is deliberately left alone: the app's
`/static/*` reads go through `EXPO_PUBLIC_BACKEND_URL`, not the web URL, which
instead serves dev-only thumbnail routes and share links — redirecting it would
make a `--backend local` fixtures capture fail on `MISS route` for every one of
those, and would bake `localhost` share URLs into the bundle. On Android the
backend port is reversed onto the emulator alongside Metro's, and `--fixtures`
requires `--dev-client` — a standalone APK bakes its backend URL in at build
time and cannot be redirected.

### The frozen clock

`frozenNow` is read from the manifest on a replay and minted (now, to the second,
or overridden with `--frozen-now`) on a recording, and it reaches the app as
`EXPO_PUBLIC_SCREENSHOT_NOW`. The app logs which clock it ended up on at boot:

```
[screenshot] clock: frozen at 2026-09-08T12:00:00.000Z
[screenshot] clock: live
```

A capture fails, in EITHER mode, if that line says `live`, names an instant
other than this run's frozen instant, or never appears — a bundle on the wall
clock reading frozen bodies produces a complete, plausible store set whose
relative timestamps drift a little further from the fixtures every day. Record
mode carries a `frozenNow` too (minted, or overridden with `--frozen-now`), so
there is always something for the app's boot line to be checked against.

**The minted/overridden instant is a FLOOR, not the value the set ships with.**
A recording is a long unattended run — one shard alone can take 20+ minutes —
so an instant fixed at the START can end up earlier than a response recorded
near the end; replaying that response would then render its own wall-clock
content (a tick's `firstTickAt`, a session's timestamp) as being in the future.
The app keeps running on the start instant for the whole recording (that run's
own screenshots are not the product, so this never matters to what's on
screen), but every time the backend writes the manifest it bumps the PERSISTED
`frozenNow` past the newest response recorded so far — so nothing recorded ever
renders in the future. `vp run mobile:screenshot-fixtures-merge` re-derives this
per shard too before taking the max across every input (see "Recording a set"
below), so a pre-fix or hand-edited input set can't slip through either.

Timezone is pinned to UTC on both platforms, so a local capture and a CI capture
derive the same calendar day from the same instant: iOS launches the app with
`SIMCTL_CHILD_TZ=UTC`, and the emulator boots with `-timezone UTC` (in
`mobile-screenshots-android.yml` for CI, `scripts/lib/android-emulator.ts`
locally).

### The miss gate

After Maestro, the run reads the backend log from a per-capture baseline (one
backend serves every device and locale, so the slice keeps device 2 from failing
on device 1's misses) and prints each problem `findScreenshotBackendProblems`
returns as

```
[mobile:screenshots] FAILED: no recorded response for GetClimb (variables 3f2a1b9c0d11) — re-record with `…`
```

Any problem fails the run. A record run instead prints what it captured — new
responses, the set's totals, hits and misses — and fails if any fixture was
refused for carrying a live auth token, since that leaves a hole the NEXT
capture would only discover as a replay miss.

## Recording a set

There is no macOS or Android hardware in the loop locally, so a set is recorded
by the capture workflows and merged afterwards.

1. Dispatch **Mobile Screenshots (iOS)** with `fixtures = record` and
   `locales = en-US`. Each shard records only its own traffic and uploads it as
   `screenshot-fixtures-<locale>-<device-slug>` (7-day retention). Both capture
   workflows expose an optional `frozen_now` dispatch input (an ISO instant;
   empty mints one) that threads through to the backend's `--frozen-now` — this
   is the START instant each shard runs on, not the final manifest value (see
   "The frozen clock" above); set it the same on both dispatches if you want
   every shard to start from the same instant, though it is optional: the merge
   below takes the max of each shard's own FINALIZED `frozenNow` regardless.
2. Dispatch **Mobile Screenshots (Android)** with `fixtures = record`. It uploads
   `screenshot-fixtures-android`.
3. Download every `screenshot-fixtures-*` artifact and unpack each into its own
   directory.
4. Fold them into one set:

   ```
   vp run mobile:screenshot-fixtures-merge -- --out packages/mobile/screenshot-fixtures ./artifacts/screenshot-fixtures-*
   ```

   The merge is a union. When two shards recorded the same key, their CONTENT
   must be identical — a conflict is a CONTENT difference, never a
   `recordedAt` difference. Every `graphql/<Op>/<hash>.json` fixture carries
   its own top-level `recordedAt`, and shards recorded minutes apart from
   live data will always disagree on that even when the response underneath
   is identical, so it never counts. A genuine content difference IS real —
   shards recorded minutes apart will legitimately disagree on a live feed
   someone wrote to between recordings, or a counter that moved — and by
   default (`--on-conflict fail`) the merge fails naming the key rather than
   silently picking a winner, so that difference is always seen once.
   `--on-conflict newest` is the documented resolution: it keeps whichever
   shard recorded the key LATER (the newest data sits closest to the merged
   set's frozen instant, itself the maximum `frozenNow` across every shard —
   see below) and logs each resolution as a `CONFLICT` line naming the key,
   which shard won, and both `recordedAt` instants. It also refuses sets
   recorded as different accounts (`accountEmail` or `accountUserId`), against
   different upstreams, or from different flows, and refuses any shard whose
   `accountUserId` is empty (it never signed in, so nothing in it is trustworthy).
   `upstream`, `accountEmail`, `accountUserId` and `flow` come from the first
   input — the checks above already required every shard to agree on them.
   `frozenNow` and `recordedAt`, instead, take the MAXIMUM across every input —
   and before that max, each input's `frozenNow` is independently re-derived
   against its own recorded responses (belt and braces on top of what the
   backend already did while recording), so an input whose manifest carries a
   `frozenNow` earlier than one of its own entries still can't win the max.
   Recording several shards on the same instant (via `--frozen-now` /
   `frozen_now`, above) is optional, since the merge takes care of this
   regardless — this is what keeps a shard's own recorded data from rendering
   as being from the future relative to the merged set's frozen "now".
5. Commit `packages/mobile/screenshot-fixtures/`.
6. Flip both workflows' `fixtures` input default from `live` to `replay`, so an
   ordinary dispatch captures against the committed set.

Until step 6 the default stays `live` and captures run against PROD exactly as
they always have.

## The drift test

`packages/mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts` runs
on every PR and keeps the committed set honest. Its registry is every document
the app can send: `packages/mobile/src/lib/graphql/operations.ts`, the operations
mobile imports from `@boardsesh/graphql/operations*` (read out of source, so a
padded namespace import can't weaken the check), and `listSyncPullDocuments()`.
The source scan covers `packages/mobile/src` and `packages/mobile/app`, plus
the `src` directory of every `@boardsesh/*-react` package mobile depends on
(`packages/mobile/package.json`, resolved to `packages/shared/<name>/src`) —
a shared hook package sends documents too (`@boardsesh/board-react`'s
`use-logbook.ts` sends `GetTicks`, `@boardsesh/playlists-react` sends the
playlist queries), so scanning only the two mobile roots would miss them.

It asserts:

- every one of those documents parses and validates against the shared schema —
  a check nothing else did for mobile's own operations;
- every manifest entry names an operation the app still sends, at the document
  hash it was recorded with;
- every fixture's `documentHash` / `variablesHash` recompute from its own `query`
  and `variables`, so a hand-edited file is caught;
- every field the current document selects is present in the recorded response
  (`checkSelectionCoverage` beside the test walks the selection set — aliases are
  response keys, lists recurse per element, a null parent is a complete answer,
  `@skip`/`@include` are read off the fixture's variables, and an inline fragment
  applies only when `__typename` says it does);
- the store flow's spine — `GetProfile`, `GetMyBoards`, `SearchClimbs`,
  `GetClimb`, `GetSessionGroupedFeed` — has a fixture.

Everything past the first bullet skips itself while there is no `manifest.json`.

### When it fails

- **"was recorded from a … document the app no longer sends"** — the query text
  moved. Re-record.
- **"is missing …, which the current … document selects"** — either the backend
  stopped returning that field (fix the backend, then re-record) or the document
  grew one after the set was recorded (re-record).
- **"the file was edited by hand"** — a fixture's bytes and its hashes disagree.
  Revert the edit or re-record; never patch a fixture by hand, the replay lookup
  is keyed on those hashes.
- **"which the app no longer sends"** — a stale fixture for a deleted operation.
  Delete it, or re-record with `--fresh`.
- **"Mobile imports from …, which this test does not read"** — someone imported
  from a new `@boardsesh/graphql/operations/*` module. Add it to
  `SHARED_OPERATION_MODULES` in the test.
- **"imports a namespace import / a default import / a re-export"** — someone
  imported `@boardsesh/graphql/operations*` in a form the registry can't scan
  (`import * as …`, a bare default import, or `export { … } from`). Rewrite it
  as a named `import { … } from '@boardsesh/graphql/operations...'`.

Re-recording always means the whole loop above, not a partial run: merging a
freshly re-recorded shard against shards left over from an earlier session
folds each shared key by CONTENT, not by when it was recorded — but a key
behind a live feed or a counter genuinely can move between two recording
sessions, and that surfaces as a real conflict (the merge's default fails
naming it; `--on-conflict newest` would keep the fresher copy, but the other
un-re-recorded shards' overlapping keys are still frozen at a stale instant).
