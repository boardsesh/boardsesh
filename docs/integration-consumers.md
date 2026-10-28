# Integration consumers: Sequence and DivePeaks

The first two apps that asked to integrate, and what each needs, mapped onto
the one API in [partner-api.md](./partner-api.md). They are test cases for
[integration-platform.md](./integration-platform.md), not specs: neither gets
an endpoint, a scope, a limit or a client row that any other app could not
get the same way. First-party login/session changes are tracked separately in
[better-auth-migration.md](./better-auth-migration.md); integrations launch
only after their own OAuth and API gates pass.

The rule for this file: if an app needs something the API does not offer, it
is a gap in the platform, it goes into the platform doc as a feature for every
app, and the entry here points at it. Nothing gets built "for Sequence" or
"for DivePeaks".

---

## Sequence

[sequence-app.com](https://sequence-app.com), a climbing training planner.
First contact September 2026; the original spec is #5530.

What they have: a training plan per climber, a logbook whose entries are name,
grade, style, attempts and notes, an outbound Strava sync that the climber
toggles per workout and per completion, and read-only MCP tokens. No OAuth
server, no inbound API.

What they want: a coach's plan says "4x4 at V4, three minutes between sets";
the climber taps one button, lands in Boardsesh with the workout ready, picks
their board, climbs, and the grades and sends show up in Sequence without
anyone typing them over.

### Requirements against the API

| Need | API | Milestone |
| --- | --- | --- |
| Connect a climber's Boardsesh account | OAuth, confidential app (they have a backend); `offline_access` for refresh tokens | 1 |
| Board ticks in the Sequence logbook | `logbook:read`, `GET /v1/logbook/changes` | 1 |
| Hand over a planned session | `workouts:write`, `POST /v1/workouts`, launch links | 3 |
| Results for the planned session | `workouts:read`, `GET /v1/workouts/{id}` | 3 |
| Know when a session finished | Poll `started` workouts, or the `workout.completed` webhook | 3 (poll), 4 (webhook) |
| Climber can stop it | Connected apps or `DELETE /v1/connection` | 1 |

Sequence gets something useful at milestone 1, before workouts exist: every
board tick a connected climber logs lands in their Sequence logbook. That is
most of "the grades and sends show up without typing them over"; workouts add
the link back to the planned session.

### Mapping into Sequence's logbook

| Boardsesh tick | Sequence logbook field |
| --- | --- |
| `climb.name` | Name |
| `grade` (fall back to `climb.grade`), `.v` or `.font` | Grade, in the scale the climber has configured |
| `status: flash` | Flash |
| `status: send`, first send of that `climb.id` | Sent |
| `status: send`, climbed before | Repeat (Sequence knows the history from the feed) |
| `status: attempt` | Attempt |
| `attempts` | Attempts |
| `climb.board.type`, `angle` | Location, or a note |
| `comment` | Notes |
| Workout `results.session.notes` | Session notes |

For an interval-style exercise (a 4x4, on-the-minute), count ticks per
`blockIndex` in the workout results.

### Their Strava-style opt-out: two separate choices

Sequence lets a climber choose per workout whether to sync to Strava. Against
Boardsesh there are two different things a climber might mean by "don't
sync", and they must not be blurred:

| The climber wants | What it means | How |
| --- | --- | --- |
| "Don't send this workout to Boardsesh" | No planned-workout handoff for that session | Sequence does not call `POST /v1/workouts` for it. Per workout, Sequence's own switch. Nothing on our side |
| "Don't bring my board climbing into Sequence" | No imported activity at all | Sequence does not hold `logbook:read`. Account-level, on the consent screen |

The per-workout switch only controls the handoff. If the climber has granted
`logbook:read`, every tick they log arrives through the feed whether or not it
was part of a workout, including ticks from a session they opted out of
handing over. Boardsesh does not filter the feed per workout: the feed is the
climber's logbook, and a per-workout filter would make "complete" untrue for
every other app.

So Sequence should present them as two settings:

1. An account setting, "Import my Boardsesh climbing", which is the
   `logbook:read` scope. Sequence asks for `workouts:write workouts:read offline_access` on
   their own when the climber only wants the handoff, and asks again with
   `logbook:read` added when the climber turns the import on. Consenting
   again widens the existing connection and returns a new token pair; Sequence
   must replace its stored tokens with that pair, because the earlier refresh
   token keeps only the scopes it was issued with.
2. The per-workout switch, which decides whether a workout is created.

`offline_access` is required for background sync and refresh; it does not
itself grant access to workouts or ticks. Token-only revocation at
`/api/auth/oauth2/revoke` does not disconnect the app. Both consumers use
`DELETE /v1/connection` for their "Disconnect Boardsesh" action, which revokes
all credentials for this connection and unfinished workouts.

Turning the import off later means disconnecting and reconnecting without
`logbook:read`, since a connection's scopes only widen. If Sequence wants to
hide imported ticks from a session the climber opted out of, it can do that
in its own app with the workout's results (`ticks[].id`), but that is a
Sequence display rule, not a sync contract.

### What changed from the original Sequence spec

Listed in full in the platform doc's assessment. The ones Sequence will
notice:

- They register their own app in the console instead of emailing us; their
  `client_id` is random, not `seq_…`.
- Host `api.boardsesh.com`, paths `/v1/workouts` (not `ws` and
  `/v1/partner/workouts`); consent on `www.boardsesh.com`.
- New: `logbook:read` and the change feed, which they can ship first.
- Results are read with `GET`. The webhook is optional and only says "go
  read".
- Results ticks use the logbook tick shape. `climbs` is now `ticks`;
  `climbUuid` is `climb.id`; `quality` is `stars`; grade objects are
  `{ v, font, label }` instead of carrying `boardLabel`; `grade.boardsesh` is
  `climb.boardseshGrade`. `grade` changed meaning: it was the climb's grade and
  is now the grade the climber gave, with the climb's community grade in
  `climb.grade`.
- Gone: `restBeforeSeconds`, `totals`, `blocks[].done`, `round` (derivable or
  never populated), `session.id` and `session.url` (a session link is an
  invite), and `climbs[].url` (a deep link into web climb pages, which are
  being retired; not something to put in a contract).
- No `workout.opened`, `workout.cancelled` or `workout.expired` events. A
  mid-session progress event stays on the "Later" list.
- Unopened and opened-but-unstarted workouts both expire; disconnecting only
  revokes unfinished ones.

### Open with Sequence

- Do they want `workout.completed` pushed at all, or is polling when the
  climber opens Sequence enough? (Milestone 4 waits on someone asking.)
- Can they pass the climber's grade scale on the workout so the Boardsesh card
  leads with it?
- Do they want Boardsesh ticks that were not part of any workout (the logbook
  feed), or only workout results? The design assumes both.

---

## DivePeaks

[app.divepeaks.com](https://app.divepeaks.com). Asked in October 2026 for
read access to climbers' Boardsesh logbooks, so climbers can see their board
climbing alongside the rest of their training and climbing data.

### Requirements against the API

| DivePeaks asked for | API | Milestone |
| --- | --- | --- |
| User-authorized, read-only access to their own logbook | `logbook:read offline_access`; no write scope requested | 1 |
| Tick status, attempts, angle, date, climb name, grade | `status`, `attempts`, `angle`, `climbedAt`, `climb.name`, `grade` and `climb.grade` on every tick | 1 |
| Works for Apple, Google and email/password accounts without sharing credentials | The consent page only needs the climber signed in to boardsesh.com, by any method; the app never sees credentials | 1 |
| Complete first import and incremental synchronization | `GET /v1/logbook/changes`; complete snapshot then catch-up, durable cursor and `tick.deleted`. A full replacement survives interruption | 1 |
| Webhooks for new or updated ticks | `logbook.changed` ("go sync"), not a tick payload | 4 |
| Revocable access | Connected apps or `DELETE /v1/connection` | 1 |
| No unrestricted access to board catalogs or community datasets | The API only returns climbs the climber ticked, as a summary; there is no catalog route | 1 |

Every requirement maps onto something the platform builds for all apps. Nothing
DivePeaks asked for needs a bespoke endpoint.

### Questions for DivePeaks

- Server-side token exchange (confidential app) or only in the browser
  (public app)? Both work; it decides whether they get a client secret.
- Is 15-minute polling fresh enough until webhooks exist?
- Do they also import board climbing from elsewhere (Kilter's own app, a
  watch)? If so they need to de-duplicate, and a `source` field on the tick
  would help; it is an open question in the platform doc.
- Do they want "only me" ticks? `logbook:read` includes them and says so on
  the consent screen.

---

## Who comes next

Any app that wants a climber's own board climbing. The ones that would work
on the milestone 1 API with no change: logbook and training trackers,
coaching tools reading an athlete's sends, personal dashboards and scripts
(loopback redirect, public app), and research tools a climber opts into. Ones
that would not, by design: catalog mirrors, alternative Boardsesh clients,
anything that controls a board (see the platform doc's "What an app can and
cannot do").
