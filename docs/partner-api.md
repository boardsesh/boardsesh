# Boardsesh Partner API: workouts

This is the contract for training apps that want to hand a planned board
session to Boardsesh and get the results back. A coach's plan says "4x4 at V4,
three minutes between sets". With this API the climber taps one button in your
app, lands in Boardsesh with that workout ready, picks their board, climbs, and
the grades and sends show up in your app without anyone typing them over.

Status: draft v1, written before the endpoints exist. Field names and
semantics here are what we intend to ship. Anything marked "later" is not part
of the first release. Questions go to the Boardsesh team.

The examples use production hosts. Everything is HTTPS.

| Host                     | What lives there                                  |
| ------------------------ | ------------------------------------------------- |
| `https://boardsesh.com`  | Consent page, workout landing page                |
| `https://ws.boardsesh.com` | Token endpoint, the partner API, nothing else    |

## How it fits together

```
 your app                       Boardsesh                          climber's phone
 ─────────                      ─────────                          ──────────────
 Connect Boardsesh  ──────────▶ /oauth/authorize (consent) ──────▶ (browser)
                    ◀────────── redirect with code
 POST /oauth/token  ──────────▶ tokens
 POST /v1/partner/workouts ───▶ workout id + launch link
 Open in Boardsesh  ──────────────────────────────────────────────▶ app opens on Record
                                                                    picks board, Start
                                                                    climbs, End
                    ◀────────── POST webhook: workout.completed
 GET /v1/partner/workouts/{id} (if the webhook never arrived)
```

Three things happen once per climber (connect), once per planned session
(create + open), and once per finished session (results).

## 1. Connecting a Boardsesh account

Boardsesh is the OAuth 2.0 authorization server. Your app is a registered
client. The climber approves once; you keep a refresh token and act on their
behalf from then on.

### Registration

There is no self-serve portal in v1. Send us:

- The app name and icon that should appear on the consent screen.
- Every redirect URI you will use, exactly. Custom schemes
  (`com.example.app://oauth/boardsesh`) and HTTPS universal links are both
  fine. We match the whole string, no prefixes, no wildcards.
- The HTTPS URL that should receive webhooks.
- Whether the token exchange happens from your servers (confidential client,
  gets a client secret) or from the app itself (public client, PKCE only).

You get back a `client_id`, a `client_secret` if confidential, and a
`webhook_secret`. The secrets are shown once. Never ship the client secret
inside a mobile binary.

### Scopes

| Scope            | Grants                                                             |
| ---------------- | ------------------------------------------------------------------ |
| `workouts:write` | Create and cancel workouts for the climber                         |
| `workouts:read`  | Read a workout, including its results                              |
| `profile:read`   | The climber's Boardsesh user id, display name and avatar           |

Ask for the smallest set you need. The consent screen lists each one in plain
language.

### Authorization request

Open this URL in the system browser or an auth session
(`ASWebAuthenticationSession` on iOS, Custom Tabs on Android). Do not use an
embedded WebView: the climber may be signed in to Boardsesh in their browser
already, and a WebView is where OAuth phishing lives.

```
GET https://boardsesh.com/oauth/authorize
    ?response_type=code
    &client_id=seq_1a2b3c
    &redirect_uri=com.example.app%3A%2F%2Foauth%2Fboardsesh
    &scope=workouts%3Awrite%20workouts%3Aread
    &state=8f3c...            (random, at least 128 bits, you verify it)
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    &code_challenge_method=S256
```

PKCE is required for every client, confidential ones included. Only `S256` is
accepted. A missing challenge, a `plain` method, or an unregistered redirect
URI shows an error page on boardsesh.com and never redirects anywhere.

If the climber is not signed in they sign in first, then see the consent
screen. Once they approve:

```
com.example.app://oauth/boardsesh?code=bsc_...&state=8f3c...
```

If they decline: `?error=access_denied&state=...`.

The code lives for 60 seconds and works exactly once. Presenting it twice
revokes everything that was issued from it, so treat a failed exchange as
"start over", not "retry".

### Token exchange

```
POST https://ws.boardsesh.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=bsc_...
&redirect_uri=com.example.app%3A%2F%2Foauth%2Fboardsesh
&client_id=seq_1a2b3c
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
&client_secret=...            (confidential clients only)
```

```json
{
  "token_type": "Bearer",
  "access_token": "bsa_...",
  "expires_in": 3600,
  "refresh_token": "bsr_...",
  "scope": "workouts:write workouts:read"
}
```

Access tokens last an hour. Refresh tokens last 90 days and rotate on every
use: each refresh returns a new refresh token and the old one stops working.
Store the newest one. If a refresh token that has already been rotated is
presented again we assume it leaked and revoke the whole connection; the
climber has to connect again.

```
POST https://ws.boardsesh.com/oauth/token
grant_type=refresh_token&refresh_token=bsr_...&client_id=seq_1a2b3c
```

Errors follow RFC 6749 section 5.2 (`invalid_grant`, `invalid_client`,
`invalid_request`, `unauthorized_client`, `invalid_scope`), as JSON with an
`error_description` you can log.

### Disconnecting

Either side can end it.

- Your side: `POST https://ws.boardsesh.com/oauth/revoke` with
  `token=<refresh or access token>&client_id=...`. Always returns 200.
- The climber's side: Boardsesh lists connected apps under More → Connected
  apps, with a Disconnect button. A password reset also revokes every
  connection, the same way Sequence's own tokens behave.

After a revoke, API calls return `401` with `error: "invalid_token"`, open
workouts for that climber move to `revoked`, and no more webhooks are sent for
them. Show a "Reconnect Boardsesh" state when you see that 401.

## 2. Creating a workout

Everything under `https://ws.boardsesh.com/v1/partner/` takes
`Authorization: Bearer bsa_...` and speaks JSON.

### Request

```
POST /v1/partner/workouts
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
| `externalRef`    | yes      | Your id for this planned session. Unique per climber per client; reused refs return 409 |
| `title`          | yes      | Shown on the workout card in Boardsesh. 80 characters                                   |
| `scheduledFor`   | no       | ISO date. Only display; the climber can open it any day until it expires                |
| `notes`          | no       | Coach's notes, shown above the blocks. 2000 characters                                  |
| `preferredBoard` | no       | A hint. `type` is `kilter`, `tension`, `moonboard`, `spray`; `angle` in degrees. The climber can still pick any board |
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
| `fourByFour`      | Four climbs, four rounds, timed rests between climbs and between rounds   | later, see below    |
| `limitBouldering` | A few hard problems, long rests, attempts count more than sends           | later               |
| `freeClimbing`    | Just the instructions text and a timer; the climber picks their own climbs| yes                 |

"Runs natively" means Boardsesh builds the queue of climbs for that block on
the climber's board and paces it. A block that does not run natively yet is
still shown, as a card with your `label` and `instructions`, and the climber
climbs it freestyle. Every tick they log during the session still comes back
in the results, so nothing is lost; the app just does not count rounds for
them yet. The create response tells you which is which per block, so you can
say so in your UI.

### Grades

Send grades on a named scale, never as a bare string:

```json
{ "scale": "v", "value": 4 }
{ "scale": "font", "value": "6B+" }
```

`v` takes an integer 0 to 17. `font` takes the usual Fontainebleau strings
from `3` to `9A`. Boardsesh converts to the grade table of whichever board the
climber ends up on. Results carry the climb's grade on both scales plus the
board's own label, so you can fill your logbook in whatever scale the climber
has configured.

### Response

```json
{
  "id": "wk_01J9X7ZQ3M",
  "externalRef": "session_88213",
  "status": "created",
  "launchUrl": "https://boardsesh.com/w/wk_01J9X7ZQ3M",
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
never opened expires seven days after creation (or the day after
`scheduledFor`, whichever is later).

### Idempotency and duplicates

`Idempotency-Key` is required on `POST`. Replaying the same key with the same
body within 24 hours returns the original response. Same key, different body:
`422`.

Creating a second workout with an `externalRef` that already exists for this
climber returns `409` with the existing workout in the body. Cancel the old
one first if the plan changed.

### Reading and cancelling

```
GET    /v1/partner/workouts/{id}
GET    /v1/partner/workouts?externalRef=session_88213
DELETE /v1/partner/workouts/{id}
```

`GET` returns the workout, its current `status`, and once it has finished, a
`results` object identical to the webhook payload. `DELETE` cancels a workout
that has not been started; after `started` it returns `409`.

### Workout status

```
created ──▶ opened ──▶ started ──▶ completed
   │           │           └──────▶ auto_closed
   │           └──────▶ cancelled
   ├──────────────────▶ cancelled
   ├──────────────────▶ expired
   └──────────────────▶ revoked   (from any state, when the climber disconnects)
```

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `created`     | You made it. Nobody has opened it in the app                             |
| `opened`      | The climber opened it on their phone and is looking at the pre-session   |
| `started`     | They pressed Start. A Boardsesh session is running against this workout  |
| `completed`   | They pressed End. Results are attached                                   |
| `auto_closed` | They stopped climbing and never pressed End; Boardsesh closed the session after an hour of inactivity. Results are attached and complete up to the last tick |
| `cancelled`   | You deleted it                                                           |
| `expired`     | Never opened before `expiresAt`                                          |
| `revoked`     | The climber disconnected your app                                        |

## 3. Opening the workout in Boardsesh

Put an "Open in Boardsesh" button on the planned session. When tapped:

1. If the Boardsesh app is installed, open `appUrl`. On iOS declare
   `com.boardsesh.app` in `LSApplicationQueriesSchemes` and check
   `canOpenURL` first; on Android an intent for the scheme resolves without
   extra setup.
2. Otherwise open `launchUrl` in the browser. That page shows the workout, an
   "Open in Boardsesh" button that retries the scheme, and App Store / Play
   links. On iOS the universal link opens the app directly when it is
   installed. On Android the universal link opens the app only on builds that
   carry the `/w` intent filter; until that build is in the store, the scheme
   is the reliable path there.

What the climber sees: the Record tab, with a card at the top naming your app
and the workout title, the blocks underneath, and the usual board picker. If
they have a board already set up it is preselected. They press Start. The
warm-up and native blocks are queued as real climbs on their board; freeform
blocks show your instructions. When they press End they get the normal
session summary, and the results are on their way to you.

A few cases worth handling in your UI:

- Not signed in to Boardsesh on that phone. The app asks them to sign in, then
  lands on the workout. Nothing for you to do.
- Signed in as a different Boardsesh account than the one that connected your
  app. The app says the workout was sent to a different account and offers to
  switch. The workout stays `created` and `GET` shows
  `"openedByMismatch": true`, so you can prompt them to reconnect.
- Already in the middle of a session. Boardsesh offers to end that session or
  add the workout to it.

## 4. Getting results back

### Webhooks

When a workout changes state we `POST` to your webhook URL:

```
POST https://api.example.com/hooks/boardsesh
Content-Type: application/json
Boardsesh-Event: workout.completed
Boardsesh-Delivery-Id: 7e0a4b0c-...
Boardsesh-Signature: t=1758150000,v1=5f1c...
```

| Event               | When                                                     |
| ------------------- | -------------------------------------------------------- |
| `workout.opened`    | First time the climber opens it on their phone           |
| `workout.completed` | They pressed End, or the session was auto-closed. `completion` in the body says which |
| `workout.cancelled` | You deleted it (sent for symmetry, easy to ignore)       |
| `workout.expired`   | It timed out unopened                                    |

Tell us at registration which events you want; most partners take
`workout.completed` only.

Respond with any `2xx` within 10 seconds. Do the heavy work after you have
answered. Use `Boardsesh-Delivery-Id` to drop duplicates: retries reuse the
same id.

### Verifying the signature

`v1` is hex HMAC-SHA256 over `t + "." + rawBody` using your `webhook_secret`.
Compare in constant time and reject timestamps more than five minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Sign over the raw request body, not a re-serialised copy. When we rotate your
secret we send two `v1` entries for a while; accept the header if either
matches.

### Retries

| Your response          | We do                                          |
| ---------------------- | ---------------------------------------------- |
| `2xx`                  | Mark delivered                                 |
| `410 Gone`             | Stop sending to this URL until you tell us otherwise |
| `408`, `429`, `5xx`, timeout, connection error | Retry: 1 min, 5 min, 15 min, 1 h, 4 h, 8 h, 8 h |
| Any other `4xx`        | Give up on this delivery immediately           |

After the last retry the delivery is marked dead. The results are still there
behind `GET /v1/partner/workouts/{id}`, so a periodic sweep over your
`started` workouts is a cheap safety net.

### The results payload

`workout.completed` carries this body. `GET` returns the same object under
`results`.

```json
{
  "event": "workout.completed",
  "workoutId": "wk_01J9X7ZQ3M",
  "externalRef": "session_88213",
  "completion": "ended",
  "session": {
    "id": "7b1e5c2f-4a3d-4e8b-9f10-2c6d8a1b3e55",
    "startedAt": "2026-09-18T17:32:10Z",
    "endedAt": "2026-09-18T18:41:55Z",
    "durationSeconds": 4185,
    "timezone": "Europe/Amsterdam",
    "board": {
      "type": "kilter",
      "name": "Kilter Homewall 12x12",
      "angle": 40,
      "layout": "Kilter Board Original",
      "size": "12x12"
    },
    "notes": "Felt strong, last round fell apart.",
    "url": "https://boardsesh.com/session/7b1e5c2f-4a3d-4e8b-9f10-2c6d8a1b3e55"
  },
  "totals": {
    "climbs": 18,
    "sends": 15,
    "flashes": 9,
    "attempts": 27,
    "hardestSend": { "v": 5, "font": "6C", "boardLabel": "6C/V5" }
  },
  "climbs": [
    {
      "climbUuid": "3f9c2a1e-...",
      "name": "Slopey Business",
      "url": "https://boardsesh.com/kilter/8/25/15,17/40/view/3f9c2a1e-...",
      "grade": { "v": 4, "font": "6B+", "boardLabel": "6B+/V4", "boardsesh": 4.2 },
      "angle": 40,
      "status": "send",
      "attempts": 2,
      "quality": 4,
      "climbedAt": "2026-09-18T17:51:03Z",
      "restBeforeSeconds": 84,
      "blockIndex": 1,
      "round": null
    }
  ],
  "blocks": [
    {
      "index": 1,
      "type": "fourByFour",
      "support": "freeform",
      "planned": { "climbCount": 4, "rounds": 4 },
      "done": { "climbs": 12, "sends": 10, "attempts": 16 }
    }
  ]
}
```

Field notes:

- `completion` is `ended` (they pressed End) or `auto_closed`.
- `climbs` is one entry per logged tick, in time order, for the climber who
  connected your app only. Other climbers in a shared session are never
  included.
- `status` is `flash`, `send`, or `attempt`. `attempts` is the number of goes
  that tick represents; a `send` with `attempts: 3` went on the third go.
- `grade.boardsesh` is the Boardsesh universal grade, a decimal on the V
  scale computed from ascent data. Optional; treat `v`/`font` as the truth for
  logbooks.
- `quality` is the climber's 1 to 5 star rating if they gave one.
- `restBeforeSeconds` is the gap since the previous tick. It is derived from
  timestamps, so the first climb has `null` and a long coffee break looks like
  a long rest.
- `blockIndex` and `round` say which block and round a tick belongs to. Today
  `blockIndex` is only set for native blocks and `round` is always `null`.
  Both fill in once the workout runner ships (see "Later").
- `blocks[].done` is counted from ticks attributed to the block. For freeform
  blocks the attribution is by time order against the plan, so treat it as a
  best guess.

Nothing in the payload is a rating of effort. Boardsesh does not collect RPE
or RIR today, and will not invent one. If that changes it arrives as an
optional `session.effort` field, never as a required one.

### Mapping into a logbook-style tracker

For a tracker whose logbook entries are name, grade, style, attempts and
notes, the mapping is direct:

| Boardsesh                          | Logbook field                                      |
| ---------------------------------- | -------------------------------------------------- |
| `climbs[].name`                    | Name                                               |
| `climbs[].grade.v` or `.font`      | Grade, in the scale the climber has configured     |
| `status: flash`                    | Flash                                              |
| `status: send`, first ever send    | Sent                                               |
| `status: send`, climbed before     | Repeat (you know their history, we do not)         |
| `status: attempt`                  | Attempt                                            |
| `climbs[].attempts`                | Attempts                                           |
| `session.board.name`, `.angle`     | Location, or a note                                |
| `session.notes`                    | Session notes                                      |

For an interval-style exercise (a 4x4, on-the-minute), `blocks[].done` gives
sets and reps completed; per-round timing comes later.

Sequence's Strava integration lets a climber decide per workout and per
completion whether to sync. The same switch fits here: a workout the climber
opted out of simply never gets created through this API.

## 5. Limits, errors, versioning

| Limit                            | Value                               |
| -------------------------------- | ----------------------------------- |
| Token endpoint                   | 60 requests per minute per client   |
| Partner API                      | 120 requests per minute per client per climber |
| Workouts per climber, unfinished | 20                                  |
| Blocks per workout               | 12                                  |
| Request body                     | 64 KB                               |

Over the limit returns `429` with `Retry-After` in seconds.

Errors are JSON:

```json
{ "error": "invalid_block", "message": "blocks[1].rounds must be between 1 and 10", "field": "blocks[1].rounds" }
```

| HTTP  | `error`               | Cause                                                  |
| ----- | --------------------- | ------------------------------------------------------ |
| `400` | `invalid_request`     | Malformed JSON, missing required field                 |
| `401` | `invalid_token`       | Expired, revoked, or unknown access token              |
| `403` | `insufficient_scope`  | Token lacks the scope this call needs                  |
| `404` | `not_found`           | No such workout for this client and climber            |
| `409` | `conflict`            | Duplicate `externalRef`, or cancelling a started workout |
| `422` | `invalid_block`, `idempotency_mismatch` | Body fails validation                |
| `429` | `rate_limited`        | See limits                                             |

The version is in the path. Additive changes (new fields, new block types,
new events) ship on `v1` without notice; read what you know and ignore the
rest. Anything that removes or renames a field becomes `v2`, with `v1` kept
running for at least six months.

## Later

These are on the Boardsesh roadmap and shape how the payload will grow. None
of them changes the shape of what is described above.

- `fourByFour` and `limitBouldering` running natively, with a round counter
  and both rest timers. When that ships, `climbs[].round` and per-round
  timing in `blocks[]` start being populated.
- Rest adherence per block (planned rest vs actual), once blocks are tracked
  on the server instead of inferred from tick timing.
- Optional effort rating on the session summary.
- A results event mid-session, for apps that want to show progress live.

## Checklist

Before going live with a client id:

1. Authorize URL opens in a system auth session, PKCE S256, `state` verified.
2. Refresh tokens stored encrypted; the newest one replaces the old one on
   every refresh.
3. A `401 invalid_token` shows a reconnect prompt instead of retrying.
4. `Idempotency-Key` is a fresh uuid per planned session, kept with the
   session so a retry reuses it.
5. `appUrl` first, `launchUrl` as the fallback.
6. Webhook handler verifies the signature on the raw body, replies `2xx` in
   under 10 seconds, and dedupes on `Boardsesh-Delivery-Id`.
7. Something sweeps `started` workouts older than a day with `GET`, in case a
   webhook never landed.
