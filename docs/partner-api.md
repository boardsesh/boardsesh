# Boardsesh API for apps

This is the contract for any app that wants to work with a climber's
Boardsesh data: a training planner, a logbook, a coaching tool, a script you
wrote for yourself. Register an app, send the climber through a standard
OAuth consent screen, and then:

- read their logbook (every tick on every board) and keep a copy in sync, and
- hand them a planned board session and read back what they climbed.

There is no application process and no commercial agreement. Every app gets
the same API, the same scopes and the same limits.

Status: draft v1, written before the endpoints exist. Field names and
semantics here are what we intend to ship. Questions go to the Boardsesh team
until milestone 2 publishes a support channel with the docs. Each section says which milestone
of [integration-platform.md](./integration-platform.md) delivers it: the
logbook first (milestone 1), workouts next (milestone 3), webhooks after that
(milestone 4). This file becomes the public developer docs at
`https://www.boardsesh.com/developers` in milestone 2. The design behind it is
in [integration-platform.md](./integration-platform.md); the workouts internals
are in [partner-workouts-internal.md](./partner-workouts-internal.md).

Everything is HTTPS.

| Host | What lives there |
| --- | --- |
| `https://api.boardsesh.com` | OAuth (`/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke`, metadata at `/.well-known/oauth-authorization-server/api/auth`) and the API (`/v1/*`) |
| `https://www.boardsesh.com` | What people see: app registration (`/developers/apps`), sign-in and the consent screen (the authorize step sends the climber there), workout launch links (`/w/…`), these docs |

## How it fits together

```
 your app                        Boardsesh                         climber
 ────────                        ─────────                         ───────
 register once at www.boardsesh.com/developers/apps → client_id

 Connect Boardsesh ────────────▶ OAuth authorize (consent) ─────▶ browser: sign in, Allow
                   ◀──────────── redirect with code
 POST OAuth token ─────────────▶ access + refresh token

 GET /v1/logbook/changes ──────▶ ticks and deletions since your cursor   (milestone 1)

 POST /v1/workouts ────────────▶ workout id + launch link                 (milestone 3)
 Open in Boardsesh ──────────────────────────────────────────────▶ app opens, climbs, End
 GET /v1/workouts/{id} ────────▶ results
                   ◀──────────── webhook: "go read" (optional)           (milestone 4)
```

---

## 1. Registering your app

Sign in at `https://www.boardsesh.com/developers/apps` with a Boardsesh
account whose email is verified, and create an app. It is usable immediately.

| Field | Notes |
| --- | --- |
| Name | Shown on the consent screen. Names of Boardsesh and of board brands are refused |
| Homepage URL | Linked from the consent screen |
| Privacy policy URL | Linked from the consent screen. Required |
| Type | **Confidential** if the token exchange happens on your server (you get a client secret). **Public** if it happens in a mobile app, a desktop or CLI tool, or a browser (no secret; PKCE protects the code). Registration also records web versus native redirect behavior separately |
| Redirect URIs | Up to 10, matched as exact strings. Allowed: any `https://` URL; loopback `http://127.0.0.1:{port}/…` or `http://[::1]:{port}/…` for tools running on the user's machine (the port is ignored when matching, so pick any free port at runtime); private-use schemes containing a dot, such as `com.example.app:/oauth/boardsesh`. Not allowed: other `http://` URLs, wildcards, fragments, `boardsesh.com` hosts, and the `boardsesh` and `com.boardsesh…` schemes |

You get an opaque `client_id`, and for a confidential app a client secret,
shown once. Never ship a client secret inside a mobile or desktop binary:
make that app public instead. You can rotate the secret in the console; the
old one stops working immediately. Coordinate the change with your token-exchange backend; there is no overlap window.

Limits that apply to every app (see section 6 for request rates):

- 10 apps per developer account.
- 200 new climber connections per app per day. If your app needs more, ask
  through the form in the console.
- The consent screen tells climbers that Boardsesh has not reviewed your app.
  That is true of every app; it is not a warning about yours.
- Browser-only apps work: the token, revoke and API endpoints answer CORS for
  the origins of your registered `https` redirect URIs. Generic authentication
  errors are readable from registered origins even when an expired opaque
  token no longer identifies its app, so a browser can see `401` and refresh.
  `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,
  `WWW-Authenticate` and `Sunset` are exposed to browser JavaScript.

## 2. Connecting a climber

Boardsesh is an OAuth 2.0 authorization server following the OAuth 2.1
profile: authorization code flow, PKCE required, refresh tokens rotate. The
climber approves once; you keep a refresh token and act for them from then on.
Climbers who sign in to Boardsesh with Apple, Google or a password all go
through the same flow. They never give you their Boardsesh credentials.

Server metadata (RFC 8414) is at
`https://api.boardsesh.com/.well-known/oauth-authorization-server/api/auth`; any
standard OAuth client library can configure itself from it. The issuer is
`https://api.boardsesh.com/api/auth`. Discover endpoint URLs from metadata.
The API's resource identifier is exactly `https://api.boardsesh.com/v1`, without
a trailing slash. Every registered app is authorized to request it. Send this
`resource` parameter when authorizing, exchanging a code and refreshing; it
is distinct from the issuer and redirect URI. Tokens without that audience
cannot call the API.

### Scopes

| Scope | Grants | Milestone |
| --- | --- | --- |
| `logbook:read` | Every tick the climber has logged, on every board, including ones they keep private on Boardsesh | 1 |
| `profile:read` | The climber's display name and avatar | 1 |
| `workouts:write` | Create and cancel workouts for the climber | 3 |
| `workouts:read` | Read workouts your app created, including results | 3 |
| `offline_access` | Receive a refresh token to keep accessing the other granted scopes while the climber is away | 1 |

Ask for the smallest set you need. The consent screen lists each one in plain
language. Separate scopes with spaces. Include `offline_access` whenever you need a refresh token; it grants no logbook or workout access by itself.

### Authorization request

Open this URL in the system browser or an auth session
(`ASWebAuthenticationSession` on iOS, Custom Tabs on Android). Never in an
embedded WebView: the climber may already be signed in to Boardsesh in their
browser, and a WebView is where OAuth phishing lives.

```
GET https://api.boardsesh.com/api/auth/oauth2/authorize
    ?response_type=code
    &client_id=bsk_4Rk2PzQ8mW1xTb7nYc3vLd
    &redirect_uri=com.example.app%3A%2Foauth%2Fboardsesh
    &scope=logbook%3Aread%20profile%3Aread%20offline_access
    &resource=https%3A%2F%2Fapi.boardsesh.com%2Fv1
    &state=8f3c...            (random, at least 128 bits, you verify it)
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    &code_challenge_method=S256
```

PKCE is required for every client, confidential ones included. Only `S256` is
accepted. A missing challenge, a `plain` method, an unknown client or an
unregistered redirect URI shows an error page on boardsesh.com and never
redirects anywhere.

Boardsesh sends the browser on to the consent screen on `www.boardsesh.com`.
If the climber is not signed in they sign in first, then see it. Once they
approve:

```
com.example.app:/oauth/boardsesh?code=SplxlOBeZQQYbYS6WxSbIA&state=8f3c...&iss=https%3A%2F%2Fapi.boardsesh.com%2Fapi%2Fauth
```

Check `state`, and check `iss` equals `https://api.boardsesh.com/api/auth` (RFC 9207;
it stops a mix-up if your app talks to several OAuth servers).

If they decline: `?error=access_denied&state=...`.

The code lives for 60 seconds and works exactly once. Reusing it is rejected.
If you cannot tell whether an exchange succeeded, restart authorization; do
not retry the same code expecting another token pair.

### Token exchange

```
POST https://api.boardsesh.com/api/auth/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=SplxlOBeZQQYbYS6WxSbIA
&redirect_uri=com.example.app%3A%2Foauth%2Fboardsesh
&client_id=bsk_4Rk2PzQ8mW1xTb7nYc3vLd
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
&resource=https%3A%2F%2Fapi.boardsesh.com%2Fv1
&client_secret=...            (confidential apps only)
```

A confidential app uses the authentication method chosen at registration:
`client_secret_post` (body, as above) or `client_secret_basic` (HTTP Basic).
Do not switch methods per request. A public app uses `none` and sends only
`client_id` for client authentication, along with the other grant parameters.
The same registered method applies to refresh and revoke.

```json
{
  "token_type": "Bearer",
  "access_token": "2YotnFZFEjr1zCsicMWpAA…",
  "expires_in": 3600,
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIA…",
  "scope": "logbook:read profile:read offline_access"
}
```

Access tokens last an hour. Refresh tokens last 90 days and rotate on every
use: each refresh returns a new refresh token and the old one stops working.
Store the newest one before using the new access token. If a refresh token
that has already been used is presented again, its token family is invalidated;
reconnect when refreshing no longer works. Other independently issued token
families are not implicitly a whole-connection disconnect. If two of your
processes might refresh at once, serialize refreshes per climber. Ordinary
Boardsesh sign-out does not end the `offline_access` connection. Security
revocation and Connected apps Disconnect do.

```
POST https://api.boardsesh.com/api/auth/oauth2/token
grant_type=refresh_token&refresh_token=tGzv3JOkF0XG5Qx2TlKWIA…&client_id=bsk_...
&resource=https%3A%2F%2Fapi.boardsesh.com%2Fv1
&client_secret=...            (confidential apps only)
```

Connecting the same climber again (a second device, or more scopes) gives
you a new token pair with the new scopes, and earlier tokens keep working at
the scopes they were issued with. To use newly granted scopes, replace your
stored tokens with the new pair.

Errors follow RFC 6749 section 5.2 (`invalid_grant`, `invalid_client`,
`invalid_request`, `unauthorized_client`, `invalid_scope`, `invalid_target`), as JSON with an
`error_description` you can log.

### When a token stops working

Codes and tokens are opaque strings: store them as secrets, never parse
them, and do not assume a length or format.

Every API call takes `Authorization: Bearer <access token>`. A `401` with
`error: "invalid_token"` means the access token expired or was revoked:
refresh once and retry. If the refresh answers `invalid_grant`, the
stored credential can no longer renew access. Show a "Reconnect Boardsesh" state and stop calling for
that climber; do not loop.

### Revoking a token

`POST https://api.boardsesh.com/api/auth/oauth2/revoke` accepts
`token=<token>&client_id=...` with the client's registered authentication
method. Revoking an opaque access token invalidates that token only; its
refresh token can still work. Revoking a refresh token invalidates it and
its associated access tokens, not every independently issued family or
remembered consent. Unknown/already-invalid tokens return `200`; invalid
client authentication returns `invalid_client` (`401` with a Basic challenge
for `client_secret_basic`, `400` for `client_secret_post`).

Use this endpoint to discard a credential. Use Disconnect below to end the
entire app/climber connection.

### Disconnecting

Your app calls `DELETE https://api.boardsesh.com/v1/connection` with a valid
API access token. It needs no additional scope and can only disconnect the
connection that token belongs to; there is no user/client ID parameter. The
response is `204`, which confirms the server disconnected the connection.
The state change is idempotent, but a retry may return `401` because its token
was revoked or expired. A `401` alone does not prove the earlier request
succeeded: refresh once through your normal serialized refresh path and retry
DELETE. If refresh returns `invalid_grant`, your saved credentials are unusable,
but that does not prove every independent token family was disconnected.
Direct the climber to Boardsesh Connected apps to confirm or finish the
server-side disconnect. Network errors, `429` and `5xx` are retryable and do
not confirm disconnect.

The climber can also choose Settings → Connected apps in the Boardsesh app,
or account settings on the web, and tap Disconnect. A password reset,
security revocation or account deletion also ends the affected connections.

Disconnect removes remembered consent and invalidates every credential family
for this connection. API calls then return `401 invalid_token`, refreshes
return `invalid_grant`, unfinished workouts move to `revoked`, and the only
remaining webhook is `connection.revoked`. Reconnecting requires consent
again; old credentials stay invalid after reconnect. Delete stored Boardsesh
data for the climber unless they asked you to keep it.

## 3. Reading the logbook

Milestone 1. Scope `logbook:read`. Every path below is on
`https://api.boardsesh.com` and already starts with `/v1`.

### Who is connected

```
GET /v1/me
```

```json
{ "id": "usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6", "displayName": "Alex", "avatarUrl": "https://…" }
```

`id` is the climber's id **for your app**: stable across reconnects, different
for every app, and not the id Boardsesh uses anywhere else. Use it to tell
whether a reconnect is the same climber. `displayName` and `avatarUrl` need
`profile:read`.

### Syncing

There is one endpoint for the first complete download and every later update:

```
GET /v1/logbook/changes?cursor=<cursor>&limit=100
```

```json
{
  "changes": [
    { "type": "tick", "tick": { "id": "0d6c4a2e-…", "…": "…" } },
    { "type": "tick.deleted", "id": "9a1f7c3d-…" }
  ],
  "cursor": "c3.eyJraW5kIjo…",
  "hasMore": true
}
```

Omitting `cursor` creates a complete snapshot of the climber's visible ticks,
including unchanged ticks older than our retained change history and ticks
created before the API launched. Keep following its cursors: the last snapshot
page leads into incremental catch-up and still has `hasMore: true`. Only
`hasMore: false` means the complete snapshot and its catch-up are finished.

Build a replacement copy separately and publish it **together with its final
cursor in one durable transaction**. Keep the previous copy until then. After
a crash during a full sync, restart that full sync without a cursor; never
resume it as an incremental sync against the previous copy. Snapshot cursors
expire after one hour and are private to this app connection.

The loop below uses illustrative storage methods. Their transaction contracts
matter: a sync lock serializes work for one climber; `requireFullSync` is
durable; `applyPageAndCursor` commits tick mutations and the cursor together;
`publishReplacement` atomically swaps the entire staged copy and its cursor
and clears the full-sync requirement. A file-based client can implement the
last two with an atomic file replacement containing both ticks and cursor.

```js
const API = 'https://api.boardsesh.com';

class ReconnectNeeded extends Error {}
class CursorExpired extends Error {}

// One request: refresh once on 401, including after earlier rate limits.
async function api(climber, path) {
  let refreshed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${await store.getAccessToken(climber)}` },
    });
    if (res.ok) return res.json();
    if (res.status === 401 && !refreshed) {
      // POST /api/auth/oauth2/token; atomically replace the token pair.
      // Serialize refresh per climber; throw ReconnectNeeded on invalid_grant.
      await refreshTokens(climber);
      refreshed = true;
      continue;
    }
    if (res.status === 401) throw new ReconnectNeeded();
    if (res.status === 410) throw new CursorExpired();
    if (res.status === 429 || res.status >= 500) {
      const waitSeconds = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    throw new Error(`${res.status} ${await res.text()}`);
  }
  throw new Error('gave up after retries');
}

async function sync(climber) {
  return store.withSyncLock(climber, async () => {
    // At most one immediate full-sync restart; repeated expiry retries later.
    for (let restart = 0; restart < 2; restart++) {
      const state = await store.getSyncState(climber);
      const fullSync = state.fullSyncRequired || !state.cursor;
      let cursor = fullSync ? undefined : state.cursor;
      // Empty staging is separate from the live copy. Abandoned staging from
      // a crashed process is discarded; it is never a resumable normal cursor.
      const staging = fullSync ? await store.beginEmptyReplacement(climber) : undefined;
      try {
        let hasMore;
        do {
          const query = new URLSearchParams({ limit: '200' });
          if (cursor) query.set('cursor', cursor);
          const page = await api(climber, `/v1/logbook/changes?${query}`);
          if (fullSync) {
            await store.applyToReplacement(staging, page.changes);
          } else {
            await store.applyPageAndCursor(climber, page.changes, page.cursor);
          }
          cursor = page.cursor;
          hasMore = page.hasMore;
        } while (hasMore);
        if (fullSync) await store.publishReplacement(climber, staging, cursor);
        return;
      } catch (error) {
        if (error instanceof CursorExpired) {
          // Persist this before any new request, even when an old cursor exists.
          await store.requireFullSync(climber);
          continue;
        }
        throw error; // ReconnectNeeded: show "Reconnect Boardsesh" and stop.
      } finally {
        if (fullSync) await store.discardUnpublishedReplacement(staging);
      }
    }
    throw new CursorExpired();
  });
}
```

- `limit` is 1 to 200, default 100. A page may be empty while
  `hasMore: true`; keep going.
- Apply entries in order: `tick` upserts by `id`, and `tick.deleted`
  removes that id, even if you never saw it. Ignore unknown change types.
  Incremental entries describe the current state when read; snapshot entries
  describe their consistent snapshot, followed by catch-up for later changes.
  Public climb metadata is still redacted against current privacy rules on
  each snapshot page.
- Commit every incremental page and its cursor together, including empty
  pages. During full sync only the completed replacement becomes live.
  Cursors are opaque: do not parse or build them.
- Sync when the climber opens your app, and in the background no more often
  than every 15 minutes per climber.

What the feed guarantees:

- **Complete initial state and settled changes.** The initial snapshot includes
  every visible tick. Catch-up and subsequent incremental syncs cover edits,
  deletions, and ticks hidden or revealed by duplicate handling. A final
  `hasMore: false` includes changes settled when that final page was read;
  computed climb fields are the exception below.
- **A deleted account answers `401`.** The next API call gets
  `401 invalid_token` and refresh gets `invalid_grant`. There are no
  `tick.deleted` entries for account deletion; delete what you hold for them.
- **At least once.** Treat entries as "set this tick to this" or "remove this
  tick", never "add one". Unchanged entries and snapshot/catch-up overlap are
  normal.
- **Usually within a second.** A change appears once committed and all
  database writes that started before it have finished. A large import can
  delay the feed.
- **Computed fields are not changes.** `climb.name`, `climb.grade` and
  `climb.boardseshGrade` are filled in when read. They may change without
  the tick appearing in the feed; refresh them when displaying if needed.

### Expired cursors

Incremental change history is retained for 90 days. Cursors outside retained
history, expired snapshot cursors, or a cursor from before a database recovery
answer `410` with `error: "cursor_expired"`. This can happen during a long
bootstrap too; implement recovery even when syncing frequently.

Persist that a full sync is required, then start without a cursor. Stage and
publish the completed replacement as above so ticks absent from the new
snapshot disappear and a crash cannot preserve stale ticks. To test recovery,
send `c3.expired`: it always answers `410`. Also interrupt a full sync after
one page and verify the next run still completes a full replacement.

### One tick

```
GET /v1/logbook/ticks/{id}
```

Returns one tick, or `404 not_found` if it was deleted or is not this
climber's.

### The tick

```json
{
  "id": "0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77",
  "climbedAt": "2026-10-20T18:42:11Z",
  "status": "send",
  "attempts": 3,
  "angle": 40,
  "mirrored": false,
  "stars": 4,
  "grade": { "v": 4, "font": "6B+", "label": "6B+/V4" },
  "benchmark": false,
  "comment": "Finally stuck the cross-through",
  "climb": {
    "id": "3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b",
    "name": "Slopey Business",
    "board": { "type": "kilter", "layout": "Kilter Board Original" },
    "grade": { "v": 4, "font": "6B+", "label": "6B+/V4" },
    "boardseshGrade": 4.2
  },
  "createdAt": "2026-10-20T18:42:15Z",
  "updatedAt": "2026-10-20T18:42:15Z"
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable id of this tick. Never reused |
| `climbedAt` | When the climber logged the climb, UTC. Ticks imported from other board apps carry the time that app recorded |
| `status` | `flash` (first go), `send` (topped after one or more failed goes), `attempt` (did not top). New values may be added; treat unknown ones as `attempt` |
| `attempts` | Goes this tick represents. A `send` with `attempts: 3` went on the third go |
| `angle` | Wall angle in degrees |
| `mirrored` | Climbed mirrored, on boards that support it |
| `stars` | The climber's 1 to 5 rating, or `null` |
| `grade` | The grade the climber gave it, or `null` if they did not give one |
| `benchmark` | The climb is a benchmark on its board |
| `comment` | The climber's note, or `null` when they left none |
| `climb.id` | Stable climb id. If Boardsesh merges duplicate climbs, a tick's `climb.id` changes to the surviving one, and the tick comes through the feed again with the new id |
| `climb.name` | Climb name. `null` for a climb on someone else's spray wall that is not public: the wall's owner shared it with the climber, not with apps |
| `climb.board.type` | `kilter`, `tension`, `moonboard`, `decoy`, `touchstone`, `grasshopper`, `soill`, `woods`, `spray` (a climber's own spray wall). New values may be added |
| `climb.board.layout` | Layout name, for display (`"Spray wall"` when the name is withheld) |
| `climb.grade` | The community grade at this angle when you read it. It drifts over time without the tick changing |
| `climb.boardseshGrade` | The Boardsesh universal grade, a decimal on the V scale, or `null`. Optional; the model behind it may change |

A grade object is `{ "v": 4, "font": "6B+", "label": "6B+/V4" }`: `v` is an
integer or `null` where the board grade has no V equivalent, `font` the
Fontainebleau grade, `label` the board's own label. Use whichever scale your
climber prefers.

The API does not include hold positions, other climbers' ticks or full board
catalogs. If you need a catalog, the public nightly snapshots are documented
at [board-snapshots-dataset.md](./board-snapshots-dataset.md).

## 4. Workouts

Milestone 3. For training apps: hand the climber a planned board session,
they climb it in Boardsesh, you read back what they did. Scopes
`workouts:write` and `workouts:read`.

### Creating a workout

```
POST /v1/workouts
Idempotency-Key: 0f4d6a2e-...        (uuid, required)
```

```json
{
  "externalRef": "session_88213",
  "title": "Board 4x4s",
  "scheduledFor": "2026-09-18",
  "notes": "Pick problems you can do in 1-2 goes. Quality over grade.",
  "preferredBoard": { "type": "kilter", "angle": 40 },
  "blocks": [
    {
      "type": "warmUp",
      "climbCount": 6,
      "gradeRange": { "scale": "v", "from": 0, "to": 3 }
    },
    {
      "type": "fourByFour",
      "targetGrade": { "scale": "v", "value": 4 },
      "climbCount": 4,
      "rounds": 4,
      "restBetweenClimbsSeconds": 0,
      "restBetweenRoundsSeconds": 180
    },
    {
      "type": "freeClimbing",
      "label": "Cool down",
      "instructions": "Ten minutes of easy volume, nothing above V2.",
      "durationSeconds": 600
    }
  ]
}
```

| Field            | Required | Notes                                                                                   |
| ---------------- | -------- | --------------------------------------------------------------------------------------- |
| `externalRef`    | yes      | Your id for this planned session. Unique per climber per app; reused refs return 409    |
| `title`          | yes      | Shown on the workout card in Boardsesh. 80 characters                                   |
| `scheduledFor`   | no       | ISO date, at most 90 days out. Only display; the climber can open it any day until it expires |
| `notes`          | no       | Coach's notes, shown above the blocks. 2000 characters                                  |
| `preferredBoard` | no       | A hint. `type` is a board type from section 3; `angle` in degrees. The climber can still pick any board |
| `blocks`         | yes      | 1 to 12 blocks, run in order                                                            |

### Blocks

A block is one part of the session. The fields that matter depend on `type`;
unknown fields are ignored, and a block the app cannot run yet is still shown
(see `support` below).

| Field                      | Type                       | Used by                                        |
| -------------------------- | -------------------------- | ---------------------------------------------- |
| `type`                     | string                     | all                                            |
| `label`                    | string, 40 chars           | all, overrides the default block name          |
| `instructions`             | string, 1000 chars         | all, shown on the block card                   |
| `targetGrade`              | `{ scale, value }`         | `volume`, `gradeFocus`, `onTheMinute`, `fourByFour`, `limitBouldering` |
| `gradeRange`               | `{ scale, from, to }`      | `warmUp`, `pyramid`, `ladder`                  |
| `climbCount`               | int, 1 to 40               | everything except `freeClimbing`               |
| `rounds`                   | int, 1 to 10               | `fourByFour`                                   |
| `restBetweenClimbsSeconds` | int, 0 to 3600             | `fourByFour`                                   |
| `restBetweenRoundsSeconds` | int, 0 to 3600             | `fourByFour`                                   |
| `intervalSeconds`          | int, 15 to 3600            | `onTheMinute` (default 60)                     |
| `restSeconds`              | int, 0 to 3600             | `limitBouldering`, `volume`, `pyramid`, `ladder`, `gradeFocus` (rest after each climb) |
| `durationSeconds`          | int                        | `freeClimbing`, display only                   |

Block types, and how Boardsesh runs each one today:

| `type`            | What the climber gets                                                     | Runs natively today |
| ----------------- | ------------------------------------------------------------------------- | ------------------- |
| `warmUp`          | Climbs stepping up through the grade range                                | yes                 |
| `volume`          | N climbs around the target grade                                          | yes                 |
| `pyramid`         | Up the grades and back down                                               | yes                 |
| `ladder`          | Up the grades, then stop                                                  | yes                 |
| `gradeFocus`      | N climbs all at the target grade                                          | yes                 |
| `onTheMinute`     | One climb per interval, the wall advances on its own                      | yes                 |
| `fourByFour`      | A card with your label and instructions, climbed freestyle (see below)    | no, freeform        |
| `limitBouldering` | A few hard problems, long rests, attempts count more than sends           | later               |
| `freeClimbing`    | Just the instructions text and a timer; the climber picks their own climbs| yes                 |

"Runs natively" means Boardsesh builds the queue of climbs for that block on
the climber's board and paces it. A block that does not run natively yet is
still shown, as a card with your `label` and `instructions`, and the climber
climbs it freestyle. Every tick they log during the session still comes back
in the results, so nothing is lost; the app just does not pace those blocks
for them yet. The create response tells you which is which per block, so you
can say so in your UI.

A 4x4 built in the app is reps × sets on one climb: a set is one climb done
once for every rep (a fall counts as a rep), with an optional rest between
reps, then the rest between sets, and the wall moves to the next climb for the
next set. There are no rounds of several climbs. A `fourByFour` block keeps
the fields above and stays freeform, a card with your `label` and
`instructions`, until we decide how `climbCount`, `rounds` and the two rests
map onto reps per set, sets and the two rests (tracked in
[#6734](https://github.com/boardsesh/boardsesh/issues/6734)). That mapping is
announced before `fourByFour` runs natively.

### Grades in a request

Send grades on a named scale, never as a bare string:

```json
{ "scale": "v", "value": 4 }
{ "scale": "font", "value": "6B+" }
```

`v` takes an integer 0 to 17. `font` takes the usual Fontainebleau strings
from `3` to `9A`. Boardsesh converts to the grade table of whichever board the
climber ends up on. Results use the grade object from section 3.

### Response

```json
{
  "id": "wk_01J9X7ZQ3M",
  "externalRef": "session_88213",
  "status": "created",
  "launchUrl": "https://www.boardsesh.com/w/wk_01J9X7ZQ3M",
  "appUrl": "com.boardsesh.app://w/wk_01J9X7ZQ3M",
  "expiresAt": "2026-09-25T00:00:00Z",
  "blocks": [
    { "index": 0, "type": "warmUp", "support": "native" },
    { "index": 1, "type": "fourByFour", "support": "freeform" },
    { "index": 2, "type": "freeClimbing", "support": "native" }
  ]
}
```

`support` is `native` or `freeform` per the table above. A workout that is
never started expires seven days after creation (or the day after
`scheduledFor`, whichever is later), whether or not the climber opened it. `scheduledFor` more than 90 days out
is rejected with `422`, so the longest an unstarted workout can live is 91
days.

### Idempotency and duplicates

`Idempotency-Key` is required on `POST`. Replaying the same key with the same
body within 24 hours returns the original response. Same key, different body:
`422`.

Creating a second workout with an `externalRef` that already exists for this
climber returns `409` with the existing workout in the body. Cancel the old
one first if the plan changed.

### Reading and cancelling

```
GET    /v1/workouts/{id}
GET    /v1/workouts?externalRef=session_88213
DELETE /v1/workouts/{id}
```

`GET` returns the workout, its current `status`, and once it has finished, a
`results` object. `DELETE` cancels a workout that has not been started; after
`started` it returns `409`. You only ever see workouts your app created.

### Workout status

```
created ──▶ opened ──▶ started ──▶ completed
   │           │           └──────▶ auto_closed
   │           ├──────▶ cancelled
   │           └──────▶ expired
   ├──────────────────▶ cancelled
   ├──────────────────▶ expired
   └──────────────────▶ revoked   (from created, opened or started, when the climber disconnects)
```

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `created`     | You made it. Nobody has opened it in the app                             |
| `opened`      | The climber opened it on their phone and is looking at the pre-session   |
| `started`     | They pressed Start. A Boardsesh session is running against this workout  |
| `completed`   | They pressed End. Results are attached                                   |
| `auto_closed` | They stopped climbing and never pressed End; Boardsesh closed the session after an hour of inactivity. Results are attached and complete up to the last tick |
| `cancelled`   | You deleted it                                                           |
| `expired`     | Not started before `expiresAt`                                           |
| `revoked`     | The climber disconnected your app before the workout finished. Finished workouts keep their status |

New statuses may be added; treat an unknown one as "not finished".

### Opening the workout in Boardsesh

Put an "Open in Boardsesh" button on the planned session. When tapped:

1. If the Boardsesh app is installed, open `appUrl`. On iOS declare
   `com.boardsesh.app` in `LSApplicationQueriesSchemes` and check
   `canOpenURL` first; on Android an intent for the scheme resolves without
   extra setup.
2. Otherwise open `launchUrl` in the browser. That page shows the workout
   title, an "Open in Boardsesh" button that retries the scheme, and App Store
   / Play links. On iOS the universal link opens the app directly when it is
   installed. On Android the universal link opens the app only on builds that
   carry the `/w` intent filter; until that build is in the store, the scheme
   is the reliable path there.

What the climber sees: the Record tab, with a card at the top naming your app
and the workout title, the blocks underneath, and the usual board picker. If
they have a board already set up it is preselected. They press Start. The
warm-up and native blocks are queued as real climbs on their board; freeform
blocks show your instructions. When they press End they get the normal
session summary, and the results are ready to read.

A few cases worth handling in your UI:

- Not signed in to Boardsesh on that phone. The app asks them to sign in, then
  lands on the workout. Nothing for you to do.
- Signed in as a different Boardsesh account than the one that connected your
  app. The app says the workout was sent to a different account and offers to
  switch. The workout stays `created` and `GET` shows
  `"openedByMismatch": true`, so you can prompt them to reconnect.
- Already in the middle of a session. Boardsesh offers to end that session or
  add the workout to it.

### Results

When `status` is `completed` or `auto_closed`, `GET /v1/workouts/{id}`
includes:

```json
{
  "results": {
    "completion": "ended",
    "session": {
      "startedAt": "2026-09-18T17:32:10Z",
      "endedAt": "2026-09-18T18:41:55Z",
      "durationSeconds": 4185,
      "timezone": "Europe/Amsterdam",
      "board": {
        "type": "kilter",
        "name": "Homewall",
        "layout": "Kilter Board Original",
        "size": "12x12",
        "angle": 40
      },
      "notes": "Felt strong, last round fell apart."
    },
    "ticks": [
      { "id": "0d6c4a2e-…", "climbedAt": "2026-09-18T17:51:03Z", "status": "send", "attempts": 2, "…": "…", "blockIndex": 1 }
    ],
    "blocks": [
      { "index": 1, "type": "fourByFour", "support": "freeform", "planned": { "climbCount": 4, "rounds": 4 } }
    ]
  }
}
```

- `completion` is `ended` (they pressed End) or `auto_closed`.
- `ticks` are the climber's own ticks from that session, in time order, in
  the tick shape from section 3, plus `blockIndex`. Other climbers in a shared
  session are never included. With `logbook:read` the same ticks also arrive
  through the logbook feed with the same `id`, so de-duplicate on it.
- `blockIndex` is inferred from the recorded plan when a tick's climb matches
  exactly one block. It is `null` when no block matches or more than one does
  (for example, the same climb in both warm-up and volume). A plan snapshot
  alone does not prove which stage produced a tick. Compute rest gaps and
  per-block counts from
  `climbedAt` and `blockIndex`.
- `blocks[].planned` echoes the block as you sent it.
- `session.notes` is what the climber wrote on the session summary.
- There is no effort rating (RPE or RIR); Boardsesh does not collect one. If
  that changes it arrives as an optional `session.effort`.
- There is no session id or session link. A Boardsesh session link invites
  people into the session, so it is never shared with apps.

If you poll instead of using webhooks: check `started` workouts when the
climber opens your app, and sweep any `started` workout older than a day.

## 5. Webhooks

Milestone 4. Optional: everything works by polling. Set one HTTPS URL and
the events you want in the console.

Events carry no climbing data. They tell you to read with the climber's
token, which is how a disconnect takes effect even for events already in
flight. After a disconnect the only event still sent is
`connection.revoked`:

| Event | Means | Then |
| --- | --- | --- |
| `logbook.changed` | This climber's logbook changed. At most one per climber per minute | Run your sync |
| `workout.completed` | A workout finished (ended or auto-closed) | `GET /v1/workouts/{workoutId}` |
| `connection.revoked` | A connection for this climber was revoked; it may predate a reconnect | Check current credentials before removing their stored data |

```
POST https://api.example.com/hooks/boardsesh
Content-Type: application/json
Boardsesh-Event: workout.completed
Boardsesh-Delivery-Id: 7e0a4b0c-...
Boardsesh-Signature: t=1758150000,v1=5f1c...
```

```json
{ "id": "evt_01JA…", "type": "workout.completed", "occurredAt": "2026-09-18T18:41:55Z", "user": "usr_7Qk3…", "workoutId": "wk_01J9X7ZQ3M" }
```

`user` is the id from `GET /v1/me` and stays the same across reconnects.
Events can arrive out of order and more than once. Use `Boardsesh-Delivery-Id`
to drop duplicates. Respond with any `2xx` within 10 seconds and do the work
afterwards.

For `connection.revoked`, a delayed event must not erase a newer connection.
In your background handler, call `GET /v1/me` with the currently stored access
token, refreshing once on `401` through the same per-climber refresh lock used
by ordinary API calls. If that succeeds, the current connection is
valid and the old event needs no cleanup. Only remove stored credentials/data
when that same credential set has been confirmed unusable (`invalid_grant`
on refresh, or another `401` after successful refresh). Network failures,
`429` and `5xx` are retryable, not evidence of revocation. Serialize this check
and cleanup with reconnect and token replacement, or compare a stored
credential version atomically before deletion and recheck if it changed. If
you have no stored credential, keep the local disconnected state. Test an old
revocation arriving after a successful reconnect.

The URL must be public HTTPS on port 443. Private, loopback and link-local
addresses are refused, and redirects are not followed.

### Verifying the signature

`v1` is hex HMAC-SHA256 over `t + "." + rawBody` using your webhook secret.
Compare in constant time and reject timestamps more than five minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const pairs = header.split(',').map((kv) => kv.split('='));
  const t = pairs.find(([key]) => key === 't')?.[1];
  const signatures = pairs.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Sign over the raw request body, not a re-serialised copy. While you rotate
the secret we send two `v1` entries; accept the header if either matches.

### Retries

| Your response          | We do                                          |
| ---------------------- | ---------------------------------------------- |
| `2xx`                  | Mark delivered                                 |
| `410 Gone`             | Stop sending to this URL until you re-enable it in the console |
| `408`, `429`, `5xx`, timeout, connection error | Retry with exponential backoff: about 2 min, then doubling, nine retries over roughly 17 hours |
| Any other `4xx`        | Give up on this delivery immediately           |

If every delivery to your URL fails for three days we switch webhooks off for
your app and email you. Nothing is lost: everything an event pointed at is
still readable through the API.

## 6. Limits, errors, versioning

| Limit                            | Value                               |
| -------------------------------- | ----------------------------------- |
| Token endpoint, refresh          | 10 requests per minute per connected climber |
| Token endpoint, code exchange and revoke | 60 requests per minute per app per client IP |
| Token endpoint, whole app        | 6,000 requests per minute           |
| API, per climber                 | 120 requests per minute per app per climber |
| API, per app                     | 6,000 requests per minute across all your climbers |
| Page size (`limit`)              | 200                                 |
| Unfinished workouts per climber  | 20 per app                          |
| Blocks per workout               | 12                                  |
| Request body                     | 64 KB                               |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` for the tightest limit that applies. Over the limit returns
`429` with `Retry-After` in seconds. If your app genuinely needs more, ask
through the console.

Every response carries `Boardsesh-Request-Id`. Quote it when something looks
wrong.

Errors are JSON:

```json
{ "error": "invalid_block", "message": "blocks[1].rounds must be between 1 and 10", "field": "blocks[1].rounds", "requestId": "req_7Hc2…" }
```

| HTTP  | `error`               | Cause                                                  |
| ----- | --------------------- | ------------------------------------------------------ |
| `400` | `invalid_request`     | Malformed JSON, missing required field, bad parameter  |
| `400` | `invalid_cursor`      | A cursor this API did not issue                        |
| `401` | `invalid_token`       | Expired, revoked, or unknown access token              |
| `403` | `insufficient_scope`  | Token lacks the scope this call needs                  |
| `404` | `not_found`           | No such tick or workout for this app and climber       |
| `409` | `conflict`            | Duplicate `externalRef`, or cancelling a started workout |
| `409` | `workout_limit`       | This climber already has 20 unfinished workouts from your app |
| `410` | `cursor_expired`      | Start a full sync (section 3)                          |
| `413` | `payload_too_large`   | Body over 64 KB                                        |
| `422` | `invalid_block`, `idempotency_mismatch` | Body fails validation                |
| `429` | `rate_limited`        | See limits                                             |
| `5xx` | `server_error`        | Our fault. Retry with backoff                          |

If your app is suspended or deleted, the token endpoint answers
`invalid_client` and the API answers `401 invalid_token`; the console says why.
If your app has reached its daily cap of new connections, the authorize step
redirects back with `error=temporarily_unavailable`; existing connections are
unaffected.

New `error` codes may be added; branch on the HTTP status first.

The OpenAPI 3.1 description of every route is at
`https://api.boardsesh.com/v1/openapi.json`.

The version is in the path. Additive changes ship on `v1` without notice: new
fields, new routes, new scopes, new event types, new enum values. Read what
you know and ignore the rest. Anything that removes or renames a field becomes
`v2`, with `v1` kept running for at least six months and a `Sunset` header on
its responses for that whole time. Every contract change is listed on the
changelog page at `https://www.boardsesh.com/developers/changelog`.

## Later

On the roadmap and shaped so none of them changes what is described above:

- `fourByFour` and `limitBouldering` running natively. For `fourByFour` the
  field mapping onto the app's reps × sets on one climb is decided first
  (#6734); until then the block stays freeform. When it runs natively, ticks
  in results gain a position within the block, announced with the mapping.
- Rest adherence per block (planned rest vs actual), once blocks are tracked
  on the server instead of inferred from tick timing.
- Optional effort rating on the session.
- A progress event during a workout, for apps that want to show it live.
- Writing ticks (`logbook:write`), if apps ask for it.

## Checklist

Before you ship:

1. The authorize URL opens in a system browser or auth session, with PKCE
   S256, a `state` you verify, and an `iss` you check.
2. Refresh tokens are stored encrypted, and the newest one replaces the old
   one on every refresh. Refreshes for one climber never run in parallel.
3. A `401` triggers one refresh; an `invalid_grant` on refresh shows a
   reconnect prompt instead of retrying.
4. Incremental pages and cursors commit together. A `410` starts a staged
   full replacement that removes absent ticks, including after crash/restart.
5. Unknown change types, statuses, board types and fields are ignored, not
   fatal.
6. Background sync runs no more than every 15 minutes per climber, and
   honours `Retry-After`.
7. Workouts: `Idempotency-Key` is a fresh uuid per planned session, kept with
   the session so a retry reuses it; `appUrl` first, `launchUrl` as the
   fallback.
8. Webhooks, if used: the handler verifies the signature on the raw body,
   replies `2xx` in under 10 seconds, and dedupes on `Boardsesh-Delivery-Id`.
9. Disconnecting in your app calls `DELETE /v1/connection`, and a disconnect from
   either side deletes the climber's Boardsesh data you stored.
