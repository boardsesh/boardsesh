# Boardsesh API for apps

This is the contract for any app that wants to work with a climber's
Boardsesh data: a training planner, a logbook, a coaching tool, a script you
wrote for yourself. Register an app, send the climber through a standard
OAuth consent screen, and then:

- read their logbook and completed sessions, and keep a copy in sync, and
- hand them a planned board session and read back what they climbed.

There is no application process and no commercial agreement. Every app gets
the same API, the same scopes and the same limits.

Status: v1 is implemented through milestones 2–4: developer guides and
self-service registration, workouts and webhooks. This describes the
implemented contract; it does not announce production activation. Availability
and registration remain controlled by the staged rollout in
[integration-platform.md](integration-platform.md). In allowlist mode, only
invited developer accounts can register; open mode requires a separate email
verification. Each app starts with the connection caps in section 1.

The developer overview, guides, reference and changelog are implemented at
`https://www.boardsesh.com/developers`, with Markdown guides and `/llms.txt` for
coding agents. Section milestone labels record delivery order. Operator launch
checks, partner trials and device verification still apply before rollout.
Questions go to support@boardsesh.com. The design is in
[integration-platform.md](integration-platform.md); workout internals are in
[partner-workouts-internal.md](partner-workouts-internal.md).

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
account whose email is verified, accept the developer terms
(`https://www.boardsesh.com/developers/terms`), and create an app. It is usable
immediately.
During early access the console only lets in developer accounts the Boardsesh
team has invited; anyone else sees "App registration is invite-only for now".
"We couldn't check your invite" means Boardsesh could not look you up just
then; try again in a minute.

| Field | Notes |
| --- | --- |
| Name | Shown on the consent screen. Names of Boardsesh and of board brands are refused |
| Publisher name | Required. The person or company that makes the app, shown on the consent screen as "Made by". Same rules as the name |
| Homepage URL | Linked from the consent screen |
| Privacy policy URL | Linked from the consent screen. Required |
| Type | **Confidential** if the token exchange happens on your server (you get a client secret). **Public** if it happens in a mobile app, a desktop or CLI tool, or a browser (no secret; PKCE protects the code). Registration also records web versus native redirect behavior separately |
| Redirect URIs | Up to 10, matched as exact strings. Allowed: any `https://` URL; and for a native app, loopback `http://127.0.0.1:{port}/…` or `http://[::1]:{port}/…` for tools running on the user's machine (the port is ignored when matching, so register it without one and pick any free port at runtime) and private-use schemes containing a dot, such as `com.example.app:/oauth/boardsesh`. Not allowed: other `http://` URLs including `http://localhost`, wildcards, fragments, user names or passwords, `boardsesh.com` hosts, and schemes containing `boardsesh`. Write each URI the way a URL parser prints it back (lower-case scheme and host, `https://example.com/` rather than `https://example.com`) |

Boardsesh global admins can use Boardsesh app/publisher names, Boardsesh URLs,
and Boardsesh reverse-domain native schemes when creating or editing their own registrations.
This server-verified exception does not apply to ordinary developers, board-scoped
admins, or community leaders. Other maker names remain reserved. URI safety,
verified email, ownership, terms, scopes, PKCE, consent and recent-sign-in checks
apply to admin registrations too.

Adding a redirect URI, or replacing one, makes every climber who approved your
app see the consent screen again at their next authorization. The tokens you
already hold keep working. Removing a redirect URI, or editing the name,
publisher, homepage or privacy policy, keeps every climber's approval.

You get an opaque `client_id`, and for a confidential app a client secret,
shown once. Never ship a client secret inside a mobile or desktop binary:
make that app public instead. You can rotate the secret in the console; the
old one stops working immediately. Coordinate the change with your token-exchange backend; there is no overlap window.

Changing your redirect URIs (adding, replacing or removing one), making a new
client secret and deleting an app each need a sign-in from the last 5 minutes.
If yours is older, the console asks you to sign in again and brings you back to
your apps; make the change again from there. This stops anyone else who has your
session, on a shared computer for example, from pointing your app somewhere else
or taking its secret. Registering an app and editing its name, publisher,
homepage or privacy policy never ask.

If the console asks you to sign in again while you are editing an app, what you
typed stays in the form until you leave the page. Signing in again leaves it, so
copy any redirect URIs you want to keep first.

After each of those changes, and whenever an app is registered on your account,
Boardsesh emails the address on your account once it is verified: which app,
what happened and when. The email never contains a secret or a redirect URI. If
you did not make the change, change your Boardsesh password, check your apps in
the console, and reply to the email.

Limits that apply to every app (see section 6 for request rates):

- 10 apps per developer account.
- During early access, 25 climbers connected to an app at once, and 20 new
  connections in any 24 hours. A reconnect counts as new. The console shows both
  numbers on each app. If your app needs more, ask the Boardsesh team; there is
  no request form yet.
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
cannot call the API: a connection that names the resource at neither the
authorization nor the code exchange gets tokens the API refuses. A refresh keeps
the audience the connection was granted. Leave `resource` out of a refresh and
the new tokens still call the API (RFC 8707 section 2.2); name any other
resource, alone or beside this one, and the refresh is refused with
`invalid_target`, leaving your refresh token unspent.

### Scopes

| Scope | Grants | Milestone |
| --- | --- | --- |
| `logbook:read` | Every tick the climber has logged, on every board, including ones they keep private on Boardsesh | 1 |
| `sessions:read` | With `logbook:read`, completed sessions and their private recap, recorded duration and the climber's full completed workouts, including workouts supplied by other apps | Session sync |
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
accepted. A missing challenge or a `plain` method sends the browser back to your
registered redirect URI with `error=invalid_request` and your `state`, and no
code. An unknown client or an unregistered redirect URI shows an error page on
`api.boardsesh.com` and never redirects anywhere, because there is no redirect
URI Boardsesh can trust.

Boardsesh sends the browser on to the consent screen on `www.boardsesh.com`.
If the climber is not signed in, last signed in more than 30 days ago, or last
signed in before their password changed, they sign in first, then see it. The
same applies to a climber who has not signed in since Boardsesh switched app
connections on, so expect your first testers to be asked to sign in once.
`prompt=login` is accepted and changes nothing on top of that. Once they
approve:

```
com.example.app:/oauth/boardsesh?code=SplxlOBeZQQYbYS6WxSbIA&state=8f3c...&iss=https%3A%2F%2Fapi.boardsesh.com%2Fapi%2Fauth
```

Check `state`, and check `iss` equals `https://api.boardsesh.com/api/auth` (RFC 9207;
it stops a mix-up if your app talks to several OAuth servers).

If they decline: `?error=access_denied&state=...`.

Whether the consent screen appears again depends on your app:

- An app without a client secret, and every native app, can never
  re-authorize silently. Every authorization shows the consent screen, even if
  the climber approved a minute ago, and `prompt=none` never gets a code: the
  browser comes back to your redirect URI with `error=consent_required` and
  your `state`. Keep the refresh token instead of authorizing again.
  A browser app cannot keep a secret, so its `client_id` alone proves nothing
  about who sent the request (RFC 6749 section 10.2). A native app's secret
  ships in the binary, and on a phone or a computer another app can claim its
  scheme, its loopback port or an unverified link (RFC 8252 section 8.6). In
  both cases the climber's tap is the check.
- A confidential web app, which keeps its secret on a server and redirects to
  `https://`, is remembered. Once a climber approves, the next authorization
  goes straight back to you with a code, unless you ask for more scopes, the
  climber disconnected your app, or you added a redirect URI since. `prompt=none`
  gets a code when the approval is remembered, and `consent_required` when it is
  not.

The code lives for 60 seconds and works exactly once. Reusing it is rejected.
Reuse also ends the tokens that code issued, including when a confidential
app's retry leaves out `code_verifier`, so an app that reloads its callback and
sends the code again will find its new refresh token refused with `invalid_grant`.
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
client authentication returns `invalid_client`: `401` with a Basic challenge
when the request sent HTTP Basic credentials, `400` when it sent the secret in
the body. The token endpoint answers the same way.

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
Connected apps also shows the climber what your app can read, when they
connected it, and when it last called the API, to within an hour.

Disconnect removes remembered consent and invalidates every credential family
for this connection. API calls then return `401 invalid_token`, refreshes
return `invalid_grant`, unfinished workouts move to `revoked`, and the only
remaining webhook is `connection.revoked`. Reconnecting requires consent
again; old credentials stay invalid after reconnect. Delete stored Boardsesh
data for the climber unless they asked you to keep it.

## 3. Reading the logbook

Milestone 1. `GET /v1/me` works with any valid access token. The rest of this
section needs the `logbook:read` scope. Every path below is on
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
whether a reconnect is the same climber. `displayName` and `avatarUrl` are sent
only with `profile:read`, and either can be `null` when the climber has none.
`avatarUrl` is always an `https` URL on Boardsesh's media host or a sign-in
provider's image host (Google, Facebook); anything else a profile holds comes
through as `null`.

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
- A `503` with `Retry-After` when you start or continue a full sync means the
  snapshot cannot be made now: downloads are at capacity, or the logbook is too
  large to download as one snapshot. Wait at least `Retry-After` seconds, which
  can be an hour, before starting again. Starting a full sync more than twice a
  minute for one climber answers `429`; following a sync already in progress is
  never limited that way.

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
history, expired snapshot cursors, a cursor from before a database recovery,
and a cursor from before the climber reconnected your app answer `410` with
`error: "cursor_expired"`. This can happen during a long bootstrap too;
implement recovery even when syncing frequently.

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
  "grade": { "v": 4, "font": "6B+", "label": "6b+/V4" },
  "benchmark": false,
  "comment": "Finally stuck the cross-through",
  "sessionId": null,
  "climb": {
    "id": "3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b",
    "name": "Slopey Business",
    "board": { "type": "kilter", "layout": "Kilter Board Original" },
    "grade": { "v": 4, "font": "6B+", "label": "6b+/V4" },
    "boardseshGrade": null
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
| `sessionId` | Opaque completed-session export id with `logbook:read sessions:read`, or `null`; never an invite id |
| `climb.id` | Stable climb id. If Boardsesh merges duplicate climbs, a tick's `climb.id` changes to the surviving one, and the tick comes through the feed again with the new id |
| `climb.name` | Climb name. `null` for a climb on someone else's spray wall that is not public: the wall's owner shared it with the climber, not with apps |
| `climb.board.type` | `kilter`, `tension`, `moonboard`, `decoy`, `touchstone`, `grasshopper`, `soill`, `woods`, `spray` (a climber's own spray wall). New values may be added |
| `climb.board.layout` | Layout name, for display (`"Spray wall"` when the name is withheld) |
| `climb.grade` | The community grade at this angle when you read it, or `null` when the climb has none at this angle. Check for `null` before reading `climb.grade.font` or `climb.grade.v`: a sync that throws on it fails on the same tick every time it retries. It drifts over time without the tick changing |
| `climb.boardseshGrade` | The Boardsesh universal grade, a decimal on the V scale, or `null`. Always `null` for now: its V-scale form is not published yet. Optional; the model behind it may change |

A grade object is `{ "v": 4, "font": "6B+", "label": "6b+/V4" }`: `v` is an
integer or `null` where the board grade has no V equivalent, `font` the
Fontainebleau grade in capitals, `label` the board's own label as its grade
table spells it. Use whichever scale your climber prefers.

Your app sees every climb the climber has logged, including drafts and
unlisted climbs set by others, with the same id, name, layout and grade as any
other climb. The climber's logbook is theirs to share. The one exception is a
climb on someone else's spray wall that is not public, described under
`climb.name` above.

`sessionId` is the session's opaque export id when the token has both
`logbook:read` and `sessions:read` and the session is eligible; otherwise it is
`null`. It is not a session invite id. A tick may arrive before its session
record on another page: keep the reference until that record arrives.

The API does not include hold positions, other climbers' ticks or full board
catalogs. If you need a catalog, the public nightly snapshots are documented
at [board-snapshots-dataset.md](../data/board-snapshots-dataset.md).

### Completed sessions

Request `logbook:read sessions:read offline_access` to import session records
alongside ticks through the same `GET /v1/logbook/changes` snapshot and cursor.
The additional permission covers private recaps and the climber's completed
workout details, including plans and coach notes supplied by other apps. It
does not grant another climber's activity or access to another app's credentials.
`workouts:read` continues to control the existing app-owned workout endpoints.

The stream adds two change types:

- `session`: upsert `session` by its opaque `id`.
- `session.deleted`: remove the session with this `id`. It was deleted or no
  longer belongs in this climber's export.

Use `GET /v1/logbook/sessions/{id}` to read one current session. It requires
both read scopes and returns `404 not_found` for an unknown or ineligible
session. Session ids and the supplied links never grant permission to join.

Only completed, non-permanent sessions are exported: sessions the climber
created, including inferred sessions, or joined as a recorded participant.
Logging a tick against a session id does not by itself establish participation.
Active sessions and permanent gym sessions are excluded. A completed session
the climber owns can be exported even when it contains no ticks.

Each session includes its title, recap notes, recorded start and end,
`durationSeconds`, timezone, origin, safe history links and the climber's own
stored workout details. Duration is whole seconds between valid recorded
bounds; missing or reversed bounds produce `null`. No duration is guessed
from ticks. Inferred sessions are identified as inferred and use their stored
bounds. Old sessions without a stored plan or timestamps cannot have those
details reconstructed by this API.

Workout details include the stored plan, exercises, pacing, per-block results
and tick attribution. Results use only this climber's exportable ticks.
Completed workouts supplied by another partner are included, without that
partner's private integration identifiers. Planned-climb metadata follows the
same privacy redaction as tick metadata; hold positions and beta videos stay
out of the export. In shared sessions, another creator's title, goal, recap,
timezone and private board label are withheld.

Recap edits and clears, session completion, workout changes, tick edits,
reassignment and session merges are changes, so follow the same cursor to
keep both entities current. `logbook.changed` remains a hint to follow this
feed. Apply both entity types and the cursor atomically, and replace both
collections together after a full import. References may cross pages.

Session workout reads support up to 100,000 of the climber's ticks per
request. If a page returns `503` asking for a smaller limit, retry the same
cursor with a smaller `limit`; if `limit=1` still fails, contact support.
Workout results are never silently truncated. A size refusal is an explicit
error, not a successful empty page that repeats the same cursor forever.

Existing tick-only tokens do not gain session access. Ask the climber to
authorize the extra scope and replace your stored token pair with the new
one; an earlier refresh token retains its earlier scopes. A cursor or snapshot
made with tick-only access cannot continue under session access: `410
cursor_expired` requires a complete replacement import, including sessions
that predate the integration. Keep the previous published copy until the new
snapshot and catch-up finish. Old clients can continue their tick-only sync.

### Session credit and opening Boardsesh

On the primary view of an imported session, show a visible **Boardsesh** or
**Recorded with Boardsesh** source credit. A small footer or footnote is
sufficient. The credit must be visible without opening a menu; it need not
compete with the session's main action.

We also recommend an **Open in Boardsesh** action using the session's supplied
history links. This action may live in an ellipsis menu. Use `appUrl` when the
app can open it and `url` for the browser fallback. These links open the
session's history, preserve the destination through sign-in and check the
signed-in account's access. Do not construct an invite link or use `/join/`.

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
      "externalRef": "day_88213_exercise_4x4",
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
| `externalRef`              | string, 1–200 chars        | all; optional exercise ID, unique within this workout |
| `label`                    | string, 40 chars           | all, overrides the default block name          |
| `instructions`             | string, 1000 chars         | all, shown on the block card                   |
| `targetGrade`              | `{ scale, value }`         | `volume`, `gradeFocus`, `onTheMinute`, `fourByFour`, `limitBouldering` |
| `gradeRange`               | `{ scale, from, to }`      | `warmUp`, `pyramid`, `ladder`                  |
| `climbCount`               | int, 1 to 40               | everything except `freeClimbing`               |
| `rounds`                   | int, 1 to 10               | `fourByFour`                                   |
| `restBetweenClimbsSeconds` | int, 0 to 3600             | `fourByFour`                                   |
| `restBetweenRoundsSeconds` | int, 0 to 3600             | `fourByFour`                                   |
| `intervalSeconds`          | int, 15 to 3600            | `onTheMinute` (default 60)                     |
| `restSeconds`              | int, 0 to 3600             | `limitBouldering`, `volume`, `pyramid`, `ladder`, `gradeFocus` (rest after each climb, see below) |
| `advanceOn`                | `tick` or `send`           | `volume`, `pyramid`, `ladder`, `gradeFocus`; optional, defaults to `tick` when `restSeconds` is provided |
| `durationSeconds`          | int, 1 to 86400            | `freeClimbing`, display only                   |

`restSeconds` on `volume`, `pyramid`, `ladder` and `gradeFocus` paces the
climber's rest timer for that block. Every logged climb starts the rest.
`advanceOn: "tick"` advances after any logged climb, including a fall, once
the rest ends. `advanceOn: "send"` keeps the climb up after a fall and advances
only after the rest following a flash or send. Leaving `advanceOn` out keeps
the existing `tick` behavior. The climber can change this choice on each block
before starting or adding the workout to a session.

`restSeconds: 0` means no rest: a qualifying logged climb can advance
immediately. Leaving `restSeconds` out leaves the block unpaced, so the
climber's own rest-timer settings apply and `advanceOn` has no effect.
Started runs keep their saved pacing, including after a restart. Older app
versions ignore `advanceOn` and continue advancing after any logged climb;
integrators must not assume a send-only rule on those versions.

Block types, and how Boardsesh runs each one today:

| `type`            | What the climber gets                                                     | Runs natively today |
| ----------------- | ------------------------------------------------------------------------- | ------------------- |
| `warmUp`          | Climbs stepping up through the grade range                                | yes                 |
| `volume`          | N climbs around the target grade                                          | yes                 |
| `pyramid`         | Up the grades and back down                                               | yes                 |
| `ladder`          | Up the grades, then stop                                                  | yes                 |
| `gradeFocus`      | N climbs all at the target grade                                          | yes                 |
| `onTheMinute`     | One climb per interval, the wall advances on its own                      | yes                 |
| `fourByFour`      | The same climbs repeated round by round, with the requested rests        | yes                 |
| `limitBouldering` | A few hard problems, long rests, attempts count more than sends           | later               |
| `freeClimbing`    | Just the instructions text and a timer; the climber picks their own climbs| yes                 |

"Runs natively" means Boardsesh builds the queue of climbs for that block on
the climber's board and paces it. A block that does not run natively yet is
still shown, as a card with your `label` and `instructions`, and the climber
climbs it freestyle. Every tick they log during the session still comes back
in the results, so nothing is lost; the app just does not pace those blocks
for them yet. The create response tells you which is which per block, so you
can say so in your UI.

A partner `fourByFour` repeats `climbCount` selected climbs for `rounds`
rounds: four climbs A, B, C, D become ABCD, ABCD, ABCD, ABCD. A send or fall
finishes one visit. `restBetweenClimbsSeconds` applies inside a round;
`restBetweenRoundsSeconds` applies before the next round. Zero means no rest;
there is no forced ten-second changeover. App-created Rep/Set workouts keep
their separate meaning: repeat one climb for its reps before the next set.

Give a block an optional `externalRef` to identify the planned exercise in
your app. Supplied block references must be unique within the workout, but can
repeat in other workouts. They are echoed on block descriptors and in results,
including `planned.externalRef`. The workout-level reference keeps its existing
uniqueness and idempotency rules. Block references are returned only by the
creating app’s workout endpoints; generalized session/logbook exports omit
them, including when another app supplied the workout.

Partner 4×4 plans must fit the 500-visit session/queue budget. The app explains
when a complete plan cannot fit and leaves it unstarted; it does not silently
shorten the exercise. Native round support requires a compatible mobile release.

### Grades in a request

Send grades on a named scale, never as a bare string:

```json
{ "scale": "v", "value": 4 }
{ "scale": "font", "value": "6B+" }
```

`v` takes an integer 0 to 17. `font` takes the usual Fontainebleau strings
from `3` to `9A`. Boardsesh converts to the grade table of whichever board the
climber ends up on. Results use the grade object from section 3.
When the climber has Boardsesh grades turned on, the app picks climbs on the
Boardsesh grade it shows them, so a climb in a "V4" block can come back in
results with a community grade one away, such as V3 or V5.

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
    { "index": 1, "type": "fourByFour", "externalRef": "day_88213_exercise_4x4", "support": "native" },
    { "index": 2, "type": "freeClimbing", "support": "native" }
  ]
}
```

`support` is `native` or `freeform` per the table above. A workout that is
never started expires at the later of seven days after creation or
`scheduledFor` at 00:00 UTC plus two days. The extra UTC day covers the full
scheduled local day west of UTC. Opening the workout does not extend its
lifetime. `scheduledFor` more than 90 calendar days ahead of the creation UTC
date is rejected with `422 invalid_block`, so an unstarted workout lives at
most 92 days.

### Idempotency and duplicates

`Idempotency-Key` is required on `POST`. Replaying the same key with the same
body within 24 hours returns the original response. Same key, different body:
`422`.

Creating a second workout with an `externalRef` that already exists for this
climber returns `409` with the existing workout in the body. If the plan changes, cancel the old workout and use a new externalRef for
the replacement. Cancelling does not release the original externalRef.

### Reading and cancelling

```
GET    /v1/workouts/{id}
GET    /v1/workouts?externalRef=session_88213
DELETE /v1/workouts/{id}
```

`GET` returns the workout, its current `status`, and once it has finished, a
`results` object. `DELETE` cancels a workout that has not been started; after
`started` it returns `409`. You only ever see workouts your app created for
the climber identified by the bearer token.

The list accepts these query parameters:

| Parameter | Meaning |
| --- | --- |
| `externalRef` | Optional exact match for your reference, 1–200 characters |
| `limit` | 1–100 workouts per page, default 50 |
| `cursor` | The `cursor` returned by the preceding page; omit for the first page |

The list response is `{ workouts, cursor, hasMore }`. Each entry in `workouts`
has the same shape as `GET /v1/workouts/{id}`, including results when available.
When `hasMore` is `true`, request another page with the returned non-null
`cursor`, keeping any `externalRef` filter. The last page returns
`hasMore: false` and `cursor: null`. Pages are ordered by workout id, not by
creation time; treat the cursor as an opaque continuation value. Each page
reads a consistent snapshot, rather than freezing the whole list across requests.

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
2. Otherwise open `launchUrl` in the browser. That page shows your app's
   name when its public lookup succeeds, an "Open in Boardsesh" button that
   retries the scheme, and App Store / Play links. It does not expose the
   workout title, blocks or coach's notes. On iOS the universal link opens
   the app directly when it is installed. On Android the universal link opens the app only on builds that
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
  switch. This does not change the workout's status; `GET` shows
  `"openedByMismatch": true`, so you can prompt them to reconnect.
- Already in the middle of a session. Boardsesh offers to end that session or
  add the workout to it. Partner 4×4 rounds require a fresh personal session:
  end the current session first so the full round queue and plan can be saved
  together. Permanent gym sessions cannot accept a workout;
  the climber must start a personal session instead. A rejected attachment
  leaves the workout unstarted.

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
      { "index": 1, "type": "fourByFour", "externalRef": "day_88213_exercise_4x4", "support": "native", "planned": { "climbCount": 4, "rounds": 4 }, "progress": { "status": "completed", "completedRounds": 4, "plannedRounds": 4, "sends": 14, "falls": 2 } }
    ]
  }
}
```

- `completion` is `ended` (they pressed End) or `auto_closed`.
- `session.startedAt` is when the workout started. That is the session's
  start, or later when the climber added your workout to a session that was
  already running. `durationSeconds` runs from `startedAt` to `endedAt`.
- `ticks` are the climber's own ticks from this workout, in time order, in
  the tick shape from section 3, plus `blockIndex` and, when recorded unambiguously, `position`. A tick belongs to the
  workout when the climber logged it (`climbedAt`) after the workout started,
  or when the climber's session recorded it against one of the workout's
  blocks. Ticks from earlier in the same session are left out, even on a
  climb one of your blocks queued later, and so are other climbers' ticks in
  a shared session. With `logbook:read` the same ticks also arrive through
  the logbook feed with the same `id`, so de-duplicate on it.
- `blockIndex` is the block the climber's session recorded the tick on. So a
  climb queued in two blocks lands on the block it was climbed in. It is `null` for a tick on none of your blocks: a climb they added
  themselves, or a tick during a freeform block, which queues nothing. In the
  rare session with no record of its blocks, a tick gets a block only when
  exactly one block queued that climb. Compute rest gaps and per-block counts
  from `climbedAt` and `blockIndex`.
- `blocks[].planned` echoes the block as you sent it.
- `ticks[].position` identifies a native 4×4 visit with zero-based
  `roundIndex` and `climbIndex`. It is omitted when the original visit cannot
  be established. `blockIndex` retains its existing fallback behavior.
- Each 4×4 result block includes `progress`: `status` (`not_started`,
  `partial`, or `completed`), `completedRounds`, `plannedRounds`, `sends`, and
  `falls`. A completed round has a logged outcome at every original planned
  visit. Skipped visits do not count; extra ticks at one visit cannot fill a
  different visit. Sends count flash/send ticks; falls count attempt ticks,
  rather than multiplying visits by a tick's `attempts` field. Historical or
  ambiguous round attribution returns `progress: null`.
- Workout `status: completed` means the Boardsesh session ended, even when an
  exercise is partial. Ending after three rounds returns `3/4` and `partial`.
  Results are recalculated on read after late sync, edits, and deletions.

Use the block's `externalRef` to update the planned exercise, and keep the
individual ticks in your logbook. For example:

```json
{
  "index": 1,
  "type": "fourByFour",
  "externalRef": "day_88213_exercise_4x4",
  "support": "native",
  "progress": {
    "status": "completed",
    "completedRounds": 4,
    "plannedRounds": 4,
    "sends": 14,
    "falls": 2
  }
}
```

Combine the board/angle, planned target grade, and progress to write a note
such as **Kilter at 40°, V4 · 4/4 rounds · 14 sends, 2 falls**. This is your
exercise note; `results.session.notes` remains the climber's recap. If actual
angles or boards differ across the ticks, describe those differences instead
of labeling every tick with the session's starting configuration.

After the climber ends the Boardsesh session and returns to your app, refresh
with `GET`, or respond to `workout.completed`. Re-read results after logbook
sync to pick up late offline ticks; the completion event is not an immutable
results snapshot. No automatic return URL is required.

- `session.notes`, `session.timezone` and `session.board.name` describe the
  session creator's recap, timezone and board label. They are returned only
  when that creator is the climber who received the workout. When the climber
  joins someone else's shared session, all three fields are `null`; the board
  type, layout, size and angle remain available.
- There is no effort rating (RPE or RIR); Boardsesh does not collect one. If
  that changes it arrives as an optional `session.effort`.
- Workout results do not expose the internal session id or an invite link.
  With `sessions:read`, the logbook feed separately provides an opaque
  session entity and safe history links as described in section 3.

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

Sign over the raw request body, not a re-serialised copy. During the 24-hour
secret-rotation overlap, we normally send two `v1` entries; accept the header
if either matches. If the previous secret is unavailable, delivery continues
with the current secret alone.

### Retries

| Your response          | We do                                          |
| ---------------------- | ---------------------------------------------- |
| `2xx`                  | Mark delivered                                 |
| `410 Gone`             | Stop sending to this URL until you re-enable it in the console |
| `408`, `429`, `5xx`, timeout, connection error | Retry with exponential backoff: about 2 min, then doubling, nine retries over about 17–26 hours with jitter |
| Any other `4xx`        | Give up on this delivery immediately           |

We switch webhooks off and email you after a failure streak longer than
three days, with another failure in the preceding 24 hours. A successful
delivery clears the streak. A gap longer than 24 hours between failures starts
a new streak, so one failed delivery followed by quiet days does not disable
your endpoint. Everything an event pointed at remains readable through the API.

If Boardsesh cannot open the current signing secret, it makes no unsigned
request. The delivery is retried up to ten total attempts, then marked failed
with `signing_unavailable`; this server-side failure does not count against
your endpoint's failure streak.

## 6. Limits, errors, versioning

| Limit                            | Value                               |
| -------------------------------- | ----------------------------------- |
| Token endpoint, refresh          | 10 requests per minute per connected climber |
| Token endpoint, code exchange and revoke | 60 requests per minute per app per client IP |
| Token endpoint, whole app        | 6,000 requests per minute           |
| API, per climber                 | 120 requests per minute per app per climber |
| API, per app                     | 6,000 requests per minute across all your climbers |
| API, failed token lookups        | 600 per minute per client IP; past that, `429` instead of `401` |
| Starting a full sync             | 2 per minute per connected climber  |
| Connected climbers (early access) | 25 at once, 20 new in any 24 hours, per app |
| Logbook page size (`limit`)      | 200 maximum, default 100            |
| Workout page size (`limit`)      | 100 maximum, default 50             |
| Unfinished workouts per climber  | 20 per app                          |
| Blocks per workout               | 12                                  |
| Request body                     | 64 KB, sent within 5 seconds        |

A limit "per client IP" counts an IPv6 client as its /64. An app on Cloudflare
Workers counts per Worker zone (the `CF-Worker` header Cloudflare adds), because
every Worker reaches us from the same address; on the OAuth routes all Worker
zones together share 10 times each per-IP limit. Failed token lookups on the API
count per zone only.

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` for the tightest limit that applies. Over the limit returns
`429` with `Retry-After` in seconds. If your app genuinely needs more, ask the
Boardsesh team.

A `503` with `Retry-After` from any OAuth or API route means Boardsesh is busy
or has paused app access for a moment. Wait and retry. It never means the
climber disconnected, so do not drop their tokens on it. A body larger than
64 KB answers `413`, and one that takes longer than 5 seconds to arrive answers
`408`.

Keep at most 8 API requests in flight from one server address (one Worker
zone on Cloudflare Workers). Up to 8 more are still served, but they wait in a
slower lane; past 16, or when that lane is full too, the answer is `503` with
`Retry-After: 2`. Retry after that many seconds.

Every response carries `Boardsesh-Request-Id`. Quote it when something looks
wrong.

Errors are JSON:

```json
{ "error": "invalid_block", "message": "rounds must be between 1 and 10", "field": "blocks.1.rounds", "requestId": "req_7Hc2…" }
```

Workout validation fields use dot-separated paths, including numeric array
indices: `blocks.1.rounds` identifies `rounds` on the second block.

| HTTP  | `error`               | Cause                                                  |
| ----- | --------------------- | ------------------------------------------------------ |
| `400` | `invalid_request`     | Malformed JSON, invalid `Idempotency-Key`, bad query parameter |
| `400` | `invalid_cursor`      | A cursor this API did not issue                        |
| `401` | `invalid_token`       | Expired, revoked, or unknown access token              |
| `403` | `insufficient_scope`  | Token lacks the scope this call needs                  |
| `404` | `not_found`           | No such tick or workout for this app and climber       |
| `409` | `conflict`            | Duplicate `externalRef`, or cancelling a started workout |
| `409` | `workout_limit`       | This climber already has 20 unfinished workouts from your app |
| `410` | `cursor_expired`      | Start a full sync (section 3)                          |
| `413` | `payload_too_large`   | Body over 64 KB                                        |
| `422` | `invalid_block`       | Workout body fails schema validation, including missing required fields |
| `422` | `idempotency_mismatch` | The same key was used with a different body within 24 hours |
| `429` | `rate_limited`        | See limits                                             |
| `5xx` | `server_error`        | Our fault. Retry with backoff                          |

If your app is suspended or deleted, the token endpoint answers
`invalid_client` and the API answers `401 invalid_token`; the console says why.
If your app has reached its cap of connected climbers or its daily cap of new
connections, approving redirects back with `error=temporarily_unavailable`;
existing connections are unaffected. A connection counts from your first code
exchange, not from the climber's approval, so if the last place goes between the
two, the exchange answers `400 invalid_grant` with that reason.

New `error` codes may be added; branch on the HTTP status first.

The OpenAPI 3.1 description of every route is at
`https://api.boardsesh.com/v1/openapi.json`.

The version is in the path. Additive changes ship on `v1` without notice: new
fields, new routes, new scopes, new event types, new enum values. Read what
you know and ignore the rest. Anything that removes or renames a field becomes
`v2`, with `v1` kept running for at least six months and a `Sunset` header on
its responses for that whole time. Every contract change is listed on the
changelog page at `https://www.boardsesh.com/developers/changelog`. That page
and its Markdown version are implemented from the checked-in contract changelog
alongside the public developer guides.

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
