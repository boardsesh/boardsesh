# The current climb outside the queue (F3)

The sync design for F3 (#6666), rule 3 of `docs/climb-lists-and-queue.md`: "The queue holds
only what you or your crew add." Option (b), chosen on 2026-10-23: the current climb lives
outside the queue.

Code references are to `main` at `edef962b3e` (2026-10-24). Mobile paths are under
`packages/mobile/`, shared paths under `packages/shared/`, backend paths under
`packages/backend/src/`. Line numbers drift; the function names next to them don't.

## What the climber gets

| Today | After F3 |
| --- | --- |
| Opening a climb from any list inserts it into Up next. Climbs you looked at pile up there. | Opening a climb puts it on the wall. When you move on it goes to History. Up next only changes when someone adds to it. |
| With A, B (current) and C queued, tapping C in the logbook gives A, B, C′ (current), C. Next lands on C again (`shared/queue/src/reducer.ts:289-299`). | The same tap gives A, B in History and C current. No copy. Next goes past C. |
| Connecting a board after days away lights the climb that was current when you left (#4979). | The board stays dark. The app shows that climb with Put on the wall, one tap away. |

Out of scope: web (no climbing UI since W-16, #4435), and workouts, which keep "add to queue"
until workout stages land (#5379).

## The short version

- The climber, the queue sheet and every list model see three parts: **History**, **Now** (the
  current climb) and **Up next**.
- On the wire and in storage the queue keeps today's shape: one flat `queue` array plus
  `currentClimbQueueItem`. The current climb keeps a slot in the array, and that slot always
  sits on the line between History and Up next. We call it the **Now slot**.
- One new integer, `historyCount`, marks the line when nothing is current.
- What changes is the rule for putting a climb on the wall. The server moves an existing entry
  into the Now slot instead of copying it, and it never jumps the pointer forward over climbs
  nobody climbed. One pure function in `@boardsesh/queue` holds that rule, and the backend and
  the mobile reducer both call it.
- The server picks the event by what a shipped client would compute. When a shipped reducer
  would get the same array, it sends `CurrentClimbChanged`, as today. Otherwise it sends
  `FullSync`, then a `CurrentClimbChanged` under the same sequence, so the native Live
  Activity socket still lights the wall.
- **No native change.** **No Postgres migration.** The backend ships first and can reach 100%
  while every phone is still old. Old phones in a crew get the no-copy fix from the server for
  the opens they actually send there: session-history taps, the board history sheet, track
  swipes and Put on the wall. Their logbook, search and similar-climb taps are already previews
  in a crew and send nothing. The issue's logbook example is a solo case on shipped builds, so
  only the OTA fixes it. The new mobile JS ships by OTA behind a flag.

| Question | Answer |
| --- | --- |
| What marks the History / Up next line? | The Now slot, which is the current climb's index. When nothing is current, `historyCount`. |
| Where does History live? | In the same `queue` array, before the Now slot. Oldest first. At most 100 entries, trimmed when it reaches 125. |
| Wire change | Two optional output fields (`QueueState.historyCount`, `QueueState.lastChangedAt`) and three optional arguments (`setCurrentClimb(placement:)`, `setQueue(historyCount:)`, `joinSession(initialHistoryCount:)`). No new event type, no new event field. |
| Storage change | Three Redis hash fields. No Postgres change. |
| Native change | None. |
| Old binaries | In a crew: no copies from the opens they send there, after a flash of one round trip. Solo (including the issue's logbook case): unchanged until they take the OTA. |
| Kill switches | Backend `QUEUE_NOW_SLOT_PERCENT` (unset means 0, today's rules). Mobile `queue-now-slot` (positive, read `=== true`) and `stale-current-hold-kill` (read `!== true`). |

## Why not take the current climb out of the array

The literal reading of (b) stores the current climb outside `queue`. Every shipped reader
would then see an orphan current climb, and none of them can handle one:

| Shipped reader | What it does with an orphan current climb | Where |
| --- | --- | --- |
| JS sync coordinator (every shipped bundle) | Maps every `CurrentClimbChanged` to `shouldAddToQueue: true, insertAfterCurrent: true`, so it inserts the climb into its local queue. Its hash then disagrees with the server's. The 60 s watchdog resyncs it into an orphan, and the next event inserts it again. An old phone writing its queue back puts the copy in the room (the #3927 flapping class). | `shared/queue/src/sync-coordinator.ts:143-173`, `reducer.ts:289-299` |
| Native Live Activity reducer | Appends the missing climb to its own list, so the lock screen shows a queue nobody else has. | `modules/live-activity/ios/SessionQueueState.swift:183-193` |
| APNs content state | Returns `null`, so Live Activity pushes stop. | `services/apns/content-state.ts:15-23` |
| Widget and Garmin next / previous | Fall back to index 0. | `handlers/session-queue-actions.ts:46-47` |
| Garmin state, ESP32 queue sync | Report `currentIndex: -1`. | `handlers/session-state.ts:95`, `graphql/resolvers/controller/subscriptions.ts:56-63` |
| Kiosk Up next | Shows the whole queue as Up next. | `services/board-queue-preview.ts:88-90` |
| `setQueue`, `joinSession` | Silently clear the current climb. | `graphql/resolvers/queue/mutations.ts:396-412`, `graphql/resolvers/sessions/mutations.ts:168-182` |

The slot is not the bug. Three rules are:

1. Every open mints a new queue-item uuid and inserts it (`reducer.ts:289-299`,
   `src/lib/climb-to-queue-item.ts:106`). The reducer only skips a uuid it already holds.
2. Some paths jump the pointer forward over climbs nobody climbed. Similar climbs appends to
   the end and then jumps there (`src/components/play-drawer/use-play-selection-controller.ts:368`,
   `:377`). A queue-row tap jumps over every climb before it.
3. With nothing current, or an orphan, the next insert goes to the end of Up next
   (`reducer.ts:295`, `services/queue-navigation.ts:50-55`).

Change those rules and the flat array is an honest projection of History, Now and Up next.
The climber-facing queue, Up next, never holds a climb only because it was looked at, which
is what (b) asks for.

---

## 1. Data model

### The line

```
current set:     queue = [ History ... ][ Now ][ Up next ... ]    line = index of current
nothing current: queue = [ History ... ] | [ Up next ... ]        line = historyCount
```

- **History** = `queue.slice(0, line)`. Climbs that were on the wall, oldest first.
- **Now** = `currentClimbQueueItem`, at index `line`. Not History and not Up next: no count,
  cap, prompt or list section treats it as an Up next member.
- **Up next** = everything after Now (or from `line` on when nothing is current). It holds
  climbs someone added on purpose, plus whatever was there before F3.

`historyCount` only carries information while nothing is current. That happens after a
crewmate removes the current climb (`queue/mutations.ts:147-152` clears it) or after
`setCurrentClimb(null)`. Today, in that state, the whole queue shows as Up next
(`shared/play-view/src/queue-list-model.ts:33-37`). With `historyCount` History stays History.
While a climb is current, `historyCount` is defined as its index, sent anyway, and ignored on
read.

`historyCount` is not part of the state hash (`shared/queue/src/state-hash.ts:65-102`
unchanged), so shipped clients can't disagree with it. Two new phones can only disagree about
it while nothing is current, and the next current climb puts the line back.

`QueueState` (`shared/queue/src/types.ts:214-224`) gains `historyCount: number | null`.
`null` means "derive it from the current climb".

### Invariants (server and new clients)

1. The current climb is in `queue` or `null`. Nothing stores an orphan.
2. Putting a climb on the wall never adds a second copy of a climb already in `queue`.
3. Up next changes only through `addQueueItem`, `reorderQueueItem`, `setQueue` (Add to queue,
   Play next, workouts, Undo, playlist replace), a removal, or a step back on the queue walk
   (section 7). `replaceQueueItem` and `mirrorSessionClimb` rewrite one entry in place and keep
   its index, so they change no membership.
4. History holds at most 125 entries and is trimmed to 100. The whole array holds at most
   `MAX_SYNCED_QUEUE_ITEMS` = 500 (`shared/queue/src/limits.ts:17`).

### One placement function, shared

New module `packages/shared/queue/src/now-slot.ts`, pure TS, imported by the backend and the
reducer, the same way `state-hash.ts` is shared so the two sides can't drift (#2359):

| Export | What it does |
| --- | --- |
| `upNextStart(queue, current, historyCount)` | `indexOf(current) + 1` when a climb is current, else `historyCount ?? 0`. Every reader that today does `findIndex(current)` and treats -1 as "all Up next" calls this instead. |
| `historyOf(state)`, `upNextOf(state)` | The two slices. Readers never do index arithmetic on `queue` themselves. |
| `placeOnWall(state, item, placement)` | The table below. Returns `{ queue, current, historyCount, rewrite }`. |
| `capHistory(state)` | Trims History, oldest first (section 5). |
| `reorderAcrossLine(state, oldIndex, newIndex)` | The reorder rule with nothing current (section 7, reducer table). |
| `chooseQueueEvent(before, request, after)` | Which event to publish (section 2). |

`placement` is `NOW`, `STEP` or absent. Absent means a shipped client, the native socket,
or a server-side caller that hasn't been changed.

| Request | `placement` | Result | `rewrite` |
| --- | --- | --- | --- |
| `item.uuid` is the current climb | any | Nothing moves. Re-lights the wall. | `none` |
| `item.uuid` is Up next[0] | any | Pointer moves one step forward. | `next` |
| `item.uuid` is the last History entry | `STEP` or absent | Pointer moves one step back. The climb you left becomes Up next[0]. | `step` |
| `item.uuid` is in History, not last | absent | Pointer moves back, as today. Every climb after it moves into Up next. | `step` |
| `item.uuid` is in History | `NOW` | That entry moves into the Now slot. The old current climb goes to History's end. | `move-history` |
| `item.uuid` is in Up next at k > 0 | any | That entry moves into the Now slot. The climbs before it stay in Up next. | `move-up-next` |
| new uuid, same climb as current | any | Re-assert the current climb. The new uuid is dropped. | `dedupe-current` |
| new uuid, climb in Up next | any | The first Up next copy moves into the Now slot. | `dedupe-up-next` |
| new uuid, climb only in History | any | The newest History copy moves into the Now slot. | `dedupe-history` |
| new uuid, climb nowhere in `queue` | any | Inserted at the Now slot. `shouldAddToQueue` is ignored, so no orphan can form. | `insert` |
| `item: null` | — | The current climb stays as History's last entry. `historyCount` = its index + 1. | `clear` |

**What "same climb" means.** `climb.uuid` and `climb.angle`, plus `climb.boardType` when both
sides carry it. A climb queued at 40° is not reused for an open at 45°. The mirror flag is
not part of the match. A reused entry keeps its own uuid, `addedByUser`, `tickedBy` and
mirror flag.

**The issue's example.** A, B (current), C. Tap C in the logbook. The new uuid C′ matches C in
Up next, so the `dedupe-up-next` row applies: A, B in History, C current. No C′.

**Why the "History, not last, absent" row keeps today's pointer move.** A shipped client sends
an existing History uuid in two cases: a History row tap and a back-swipe on a track
(`findQueuedListNeighbour`, `shared/play-view/src/queue-navigation.ts:164-182`, reuses the
neighbour's History entry). The server can't tell either from Previous. So it keeps today's
result, and old phones keep today's behaviour there (section 3, residual 5). New phones send
`NOW` and get `move-history`.

### Alternatives we rejected

| Option | Why not |
| --- | --- |
| Store the current climb outside `queue` | Every shipped reader breaks (table above). |
| Store `history[]`, `current`, `upNext[]` as three new fields and build the flat array on read | Old clients need the flat array for months, so every write keeps two encodings in step. Delta events would need list-relative copies of every index. An old backend instance in a rolling deploy writes `queue` and leaves the lists stale. Payload and Redis hash double. The flat array plus one integer loses nothing. |
| Keep the server on today's rules and dedupe only in new clients | Old phones in a crew keep putting copies into the room's Up next for months through session-history taps, the board history sheet and Put on the wall, and new phones display them. The LED path keeps inserting a copy of a queued climb. |
| Park the room's current climb on the server after a long gap (#4979) | It reaches old binaries. With nothing current their Next goes to `queue[0]` (`findNextQueueItem`, `shared/play-view/src/queue-navigation.ts:53`), the oldest History climb, and the Swift reducer shows index 0 (`SessionQueueState.swift:115-116`). Section 6 holds the auto-send on the phone instead. |

---

## 2. Wire format and storage

### GraphQL (`packages/shared-schema/src/schema/`)

All additive. Old documents don't select or send any of it. This follows patterns the schema
already uses: optional inputs old clients omit (`setQueue.baselineSequence`,
`joinSession.participantId`) and optional outputs (`stateHashOrdered`).

```graphql
enum CurrentClimbPlacement { NOW STEP }

# mutations.ts:70
setCurrentClimb(item: ClimbQueueItemInput, shouldAddToQueue: Boolean,
                correlationId: ID, placement: CurrentClimbPlacement): ClimbQueueItem
# mutations.ts, setQueue
setQueue(..., baselineSequence: Int, historyCount: Int): QueueState!
# mutations.ts, joinSession
joinSession(..., initialHistoryCount: Int): Session!

# queue.ts:57-68
type QueueState {
  ...existing fields unchanged...
  "Entries before Up next. Equals the current index when a climb is current. Null from a pre-F3 server."
  historyCount: Int
  "When the room's queue last changed (ISO 8601). Null from a pre-F3 server."
  lastChangedAt: String
}
```

- The server tells new clients from old ones by whether `placement` is present. The
  `x-boardsesh-client` header (`shared-schema/src/client-identity.ts`) stays ungated.
- No event type or event field changes. `FullSync.state` carries `historyCount`. Every delta
  keeps flat positions. Both sides derive `historyCount` from a delta with the same function.
- `addQueueItem` gains one failure: a GraphQL error with `extensions.code = 'QUEUE_FULL'`
  (section 5).
- The documents live in two places. Mobile's own `QUEUE_UPDATES_SUBSCRIPTION`
  (`src/lib/graphql/operations.ts:1229`) selects the two new fields. The joinSession document
  is `JOIN_SESSION` in `packages/shared/graphql/src/operations/queue-session.ts:62`; the same
  file holds `SET_CURRENT_CLIMB` (`:167`, today only `$item`, `$shouldAddToQueue`,
  `$correlationId`), `SET_QUEUE` (`:254`) and `SET_QUEUE_WITH_BASELINE` (`:281`), which gain
  `$placement` and `$historyCount`. The variables are built in
  `packages/shared/queue-react/src/create-queue-mutations.ts` (`setCurrentClimb` signature
  `:176`, variables `:398-403`). These changes alter the pinned document hashes, so the
  screenshot fixtures must be re-recorded
  (`src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts`, which imports
  `@boardsesh/graphql/operations` too). The native `SessionWebSocketManager.swift` document
  doesn't change.

### Which event the server publishes

`chooseQueueEvent` is the one guard against the drift and echo-suppression class, so it is a
check, not a table someone has to keep in sync:

| Case | Event |
| --- | --- |
| The request's `item.uuid` was already in `queue`, and the array after the write equals the array before it (`none`, `next`, `step`) | `CurrentClimbChanged`, with the origin's `clientId` and `correlationId`, as today |
| The array after the write is the array before it with the request's item inserted at the Now slot (`insert`, no trim), and the request carried `shouldAddToQueue: true` or `placement` | `FullSync`, as today (`services/queue-navigation.ts:94-99`) |
| The same `insert`, but the request carried neither (the native socket's Next / Previous with a stale item that already left the queue) | `FullSync`, then the trailing `CurrentClimbChanged` under the same sequence. Today this request stores an orphan and publishes `CurrentClimbChanged` (`queue-navigation.ts:40-59`, `:103-111`), which is what repaints the wall from a locked phone. The trailing event keeps that repaint. |
| Anything else (`move-*`, `dedupe-*`, a trim) | `FullSync`, then `CurrentClimbChanged` for the new current climb under the **same sequence**, with the origin's `clientId` and `correlationId: null` |

Why each half matters:

- **A shipped JS reducer drops its own echo.** When the origin's `correlationId` is pending,
  the reducer skips the `CurrentClimbChanged` (`reducer.ts:233-242`). If the server had
  published one for a dedupe, the old phone would keep its optimistic copy C′ until the 60 s
  watchdog, long enough for a `setQueue` write-back to store it. A `FullSync` carries no
  `correlationId`, so it can't be dropped, and `INITIAL_QUEUE_DATA` clears the pending ids
  (`reducer.ts:80-104`). That is why `dedupe-current` is a `FullSync` even though the stored
  array doesn't change.
- **The native socket doesn't repaint on `FullSync`.** `QueueEventRepaintPolicy`
  (`SessionQueueState.swift:32-41`) repaints only on `CurrentClimbChanged` and
  `ClimbMirrored`, because a `FullSync` arrives on every resubscribe. Today a queue-row jump is
  a pointer `CurrentClimbChanged` and lights the wall from a backgrounded phone. Under F3 it
  is a `FullSync`. The trailing event keeps it lit. The Swift sequence check accepts the same
  sequence (`hasSequenceGap` is `received > lastKnown + 1`, `SessionQueueState.swift:316-319`).
  JS drops it as `ignore-stale` (`shared/queue/src/event-utils.ts:46`). The ESP32 gets one more
  LED write for the same climb.
- **This pattern already ships.** `setClimbFromLedPositions` publishes a `FullSync` and a
  `CurrentClimbChanged` under one sequence (`graphql/resolvers/controller/mutations.ts:264-290`),
  and `docs/websocket-implementation.md` ("Sequence Assignment") documents it as legal.

Plain inserts keep today's single `FullSync`, so a backgrounded phone still doesn't repaint a
crewmate's newly opened climb. That is today's behaviour and stays out of scope.

### Redis (`services/redis-session-store.ts`)

- `UPDATE_QUEUE_STATE_CAS_SCRIPT` (`:95-150`) takes one more ARGV and writes up to three more
  fields in the same `HSET` (`:139-147`): `historyCount`, `historyCountVersion` set to the new
  version, and `queueChangedAt` (below). They move atomically with `queue` under the same
  version check. The non-CAS `updateQueueState` (`:212`) writes them with the same comparison;
  `saveSession` copies what it is given.
- **Rolling deploys.** For a few minutes two backend instances run the old and the new script.
  An old-script write leaves a stale `historyCount`. On read, `historyCount` counts only when
  `historyCountVersion == version`; otherwise the reader derives it: the current index, or 0
  when nothing is current, which is today's display.
- `lastChangedAt` reads a third new field, `queueChangedAt`. `lastActivity` can't stand in for
  it: the CAS script stamps `lastActivity` on every write (`:147`), including an old phone's
  whole-queue write-back that changes nothing, and a Postgres restore copies
  `sessions.lastActivity`, which tick logging (`graphql/resolvers/ticks/mutations.ts:1024`,
  `:1548`, `:1895`), title and notes edits (`social/session-mutations.ts:154`) and board-path
  changes (`room-manager/session-discovery.ts:82`) also bump. The new script already reads the
  stored hash, so it compares `queueJson` and `currentClimbJson` with the stored values and
  stamps `queueChangedAt` only when either differs. `saveSession` copies it unchanged. When
  `historyCountVersion` is stale (an old-script write), the reader falls back to `lastActivity`,
  which that old write just stamped.

### Postgres (`packages/db/src/schema/app/sessions.ts:172-182`)

**No migration.** `board_session_queues` keeps `queue` and `current_climb_queue_item`.
`historyCount` isn't persisted. On a dormant restore (`services/room-manager/session-restoration.ts:81-108`)
it comes back from the stored current index, or 0 when nothing was current. `queueChangedAt`
comes back from `board_session_queues.updated_at`, which every queue flush writes
(`services/room-manager/queue-state.ts:218-292`), not from `sessions.lastActivity`. That is
approximate: a write-back that changed nothing still bumps `updated_at`, so a dormant room can
restore as "changed recently" and light its climb on connect. It never errs the other way.

This only costs anything for a room that sits past the 4 h Redis TTL with nothing current.
Non-permanent sessions end after 1 h idle (`docs/websocket-implementation.md`, "Inactivity
sweep"), so that is a permanent gym session whose current climb was removed. Its History then
shows as Up next after the restore, which is what happens today. If telemetry says it matters,
the follow-up is one nullable `history_count integer` column: edit the schema, `vp run build:db`,
then `vp exec drizzle-kit generate` from `packages/db/`, and expect exactly one
`ALTER TABLE ... ADD COLUMN`. Never hand-written.

The Postgres-only single-instance fallback keeps `historyCount` in memory, and it comes back as
0 after a restart.

### The backend choke point

`updateQueueState(sessionId, queue, current, version, historyCount?)`
(`services/room-manager/queue-state.ts:82`) gains an optional last argument. When it is
omitted, it derives the value from the current index. Legacy writers that only move the pointer
or rewrite one entry in place stay correct with no edits: `navigateToQueueItem`
(`services/queue-navigation.ts:127-183`), the widget and Garmin `navigateSessionQueue`,
controller `navigateQueue`, `replaceQueueItem` (`graphql/resolvers/queue/mutations.ts:313-361`,
swaps an entry by uuid and keeps the Now slot's index when the swapped entry was current) and
`mirrorSessionClimb` (`services/queue-mirror.ts:14-36`, rewrites the current entry in place).
`getQueueState` (`:401`) returns `historyCount` and `lastChangedAt` beside `queue`.

---

## 3. Old clients in a mixed crew

An old client is any phone running JS from before this change: binaries on a native
fingerprint that can no longer take main's OTA, and phones that haven't fetched it yet. The
server runs `placeOnWall` for every request. Old clients never send `placement`.

### What shipped senders send

| Sender | Sends | Server result |
| --- | --- | --- |
| Old JS, a committed open in a crew: a session-history tap (`src/components/session-screen/in-session/InSessionView.tsx:135`, `:447`), the board history sheet (`src/providers/drawer-host-provider.tsx:1061-1067`), Put on the wall after a preview, a playlist activation | `setCurrentClimb(fresh uuid, shouldAddToQueue: true)` (`src/providers/queue-provider.tsx:2116`). The board history sheet reuses the queue-item uuid when it has one. | `insert`, or a `dedupe-*` when the climb is already there |
| Old JS, logbook / feed / profile / search open or similar-climb tap in a crew | Nothing. A fresh open in a shared session is a preview (`PlayCore.tsx:870` `browseByDefault`, `use-play-selection-controller.ts:158`, `:179`); similar climbs takes the preview path too (`:356`). Solo, these send nothing either, because there is no server. | — |
| Old JS, track swipe | `setCurrentClimb` with the neighbour's queue entry when queued (`findQueuedListNeighbour`), else a fresh uuid from `resolveCommittableQueueItem` (`src/lib/climb-to-queue-item.ts:209-215`) | `step` / `next` for a queued neighbour, `insert` or `dedupe-*` for a fresh one |
| Old JS, Next / Previous on the queue | `setCurrentClimb(neighbour's uuid)` | `next` / `step`: pointer only |
| Old JS, queue-row tap | `setCurrentClimb(that row's uuid)` | `move-up-next`, or `step` for a History row |
| Old JS, Undo after a remove, playlist replace or clear, workout append, empty-room reseed after a failed seed | `setQueue(queue, current)`, no `historyCount` (`queue-provider.tsx:1677-1683` `setQueue`, `:1692` `restoreQueueItems`, `:1754` `appendQueueItems`; `reSeedQueueRef`, `:976`) | Line = index of current. Caps apply (section 5). |
| Native Live Activity Next / Previous | `setCurrentClimb(item, correlationId)` without `shouldAddToQueue` (`SessionWebSocketManager.swift:343`) | `next` / `step`; a stale item that left the queue is inserted at the Now slot instead of becoming an orphan, with the trailing `CurrentClimbChanged` so the wall still repaints |
| Widget, Garmin | REST navigate, server-side index ± 1 with wrap-around (`handlers/session-queue-actions.ts:30-69`) | Pointer only, unchanged |
| ESP32 LED detect | `setClimbFromLedPositions` (`controller/mutations.ts:233-262`) | Now goes through `placeOnWall` with a fresh uuid, so a queued climb is reused instead of copied |

### Step by step

Start of every row: A, B (current), C, D. History [A], Up next [C, D]. N is a new phone, O an
old one, in the same crew with O's Live Activity running, the kiosk and the ESP32.

| # | Action | Server stores | Event | O after the event | Native, kiosk, ESP32 |
| --- | --- | --- | --- | --- | --- |
| S1 | N opens X from search (`NOW`) | A B **X** C D | `FullSync` | A B X C D | Swift index 2. Kiosk Up next C D. |
| S2 | N opens D from its logbook. N resolves it locally and sends D's own uuid with `NOW`. | A B **D** C | `FullSync` + same-seq `CurrentClimbChanged(D)` | A B D C | Swift repaints D |
| S3 | **The issue's case, in a crew.** O taps C in the session's history (in a crew, a logbook tap is a preview and sends nothing). O mints C′ and shows A B C′ C D. | A B **C** D (`dedupe-up-next`) | `FullSync` + trailing | C′ is gone, C is current. O showed C′ for one round trip. | Repaint C |
| S4 | O taps B in the session's history (B′) | A B C D, B current (`dedupe-current`) | `FullSync` + trailing | B′ is gone | Re-lights B |
| S5 | O swipes forward on a search track to new climb Y | A B **Y** C D (`insert`) | `FullSync` | unchanged | as today |
| S6 | O swipes back on a track to A. The shipped client reuses A's History uuid. | **A** B C D (`step`): B moves into Up next | `CurrentClimbChanged(A)` | pointer move, as today | Swift pointer, repaint |
| S7 | O taps queue row D, skipping C | A B **D** C (`move-up-next`) | `FullSync` + trailing | A B D C. Today C would have gone to History. | Repaint D |
| S8 | O previews D from its logbook (sends nothing), then taps Put on the wall. O mints D′ and shows A B D′ C D. | A B **D** C (`dedupe-up-next`) | `FullSync` + trailing | A B D C | Repaint D |
| S9 | O's lock-screen Next | A B **C** D (`next`) | `CurrentClimbChanged(C)` | pointer move | Swift index +1, as it predicted |
| S10 | ESP32 reads C off the LEDs | A B **C** D (`dedupe-up-next`, no suggested copy) | `FullSync` + controller `CurrentClimbChanged` (existing pattern) | A B C D | ESP32 keeps its clientId check |
| S11 | Anyone removes B, the current climb | A C D, nothing current, `historyCount` 1 | `QueueItemRemoved` | Nothing current. Shows A C D as Up next, as today. | Swift index clamps onto C, as today. Kiosk Up next C D. |
| S12 | After S11, O presses Next | O's Next is `queue[0]` = A (`findNextQueueItem`). A current, `historyCount` 0. | `CurrentClimbChanged(A)` | pointer move, as today | Swift finds A |
| S13 | After S11, N presses Next instead | C = `queue[historyCount]` becomes current, A stays History | `CurrentClimbChanged(C)` | pointer move | Swift finds C |
| S14 | O removes A. While O's Undo `setQueue` is in flight, N taps queue row D (`move-up-next`). | N's move lands first: B **D** C. Then O's Undo, composed from O's live state before N's `FullSync` reached it: A B C D, B current. The #3933 merge replays only `QueueItemAdded`, so N's move is lost. | `FullSync`, `FullSync` | A B C D, B current | Repaint D. The Undo `FullSync` moves Swift's index to B without a repaint. |

### The 60 s hash watchdog

The watchdog (`src/providers/queue/use-session-realtime.ts:980-1035`) hashes queue uuids plus
the current uuid on both sides. After every `FullSync` an old phone holds exactly what the
server holds, current climb included, so the hashes match. After every `CurrentClimbChanged`
the old phone's own pointer move gives the server's array, which `chooseQueueEvent` checks
before choosing that event. So the orphan loop from "Why not take the current climb out" can't
start: no event names a current climb the server doesn't hold.

The one exposure is the gap between an old phone's optimistic copy (S3, S4, S7, S8) and the
`FullSync`: one round trip. If the 60 s tick lands inside it, the phone asks for one extra
resync and gets the same `FullSync`. If the `FullSync` is lost, the existing sequence-gap
check resyncs.

### An old phone writing the whole queue back

Shipped mobile calls `setQueue` from four places. Add to queue is `addQueueItem`
(`queue-provider.tsx:1347`), and a reconnect only resubscribes and applies the server's
`FullSync`, so neither writes the queue back.

- `setQueue` (`queue-provider.tsx:1677-1683`): playlist replace and clear.
- `restoreQueueItems` (`:1692`): Undo after a remove. It composes from the phone's live state
  right before sending (`src/lib/queue-undo.ts:30`), with `baselineSequence`.
- `appendQueueItems` (`:1754`): the workout append.
- `reSeedQueueRef` (`:976`): only after a failed seed, when the server answers with an empty
  room (`use-session-realtime.ts:548-562`).

- The payload contains the phone's current climb, because the old reducer inserts any current
  climb it gets. So the orphan branch (`queue/mutations.ts:396-412`) doesn't fire.
- An orphan can still come from a solo snapshot saved before F3. The server no longer clears
  it. It appends it at the end, where every shipped client would put it, and the `FullSync`
  tells the origin. Same for `joinSession` (`sessions/mutations.ts:168-182`); a join that
  seeds only a current climb stores `[current]`.
- No `historyCount` in the payload: the server derives it from the current climb. With nothing
  current, it keeps the stored `historyCount` when the payload's first `historyCount` uuids match
  the stored ones, and uses 0 otherwise.
- A payload over 500 is trimmed from History instead of thrown (section 5), so an old phone can
  no longer wedge sync this way.
- No per-item field is added, so there is nothing for an old client to strip on write-back
  (the #3927 / #3995 class stays closed).
- **A reshape inside the write's round trip is lost (S14).** The #3933 merge
  (`set-queue-merge.ts`) replays only `QueueItemAdded` events that landed after the baseline;
  a `FullSync`-only change in that window is overwritten (`docs/websocket-implementation.md`,
  "Sequence Assignment"). That is true today. F3 makes it more common, because every `move-*`
  and `dedupe-*` is now such a change, so a crewmate's queue-row tap or session-history re-tap
  inside an old phone's Undo round trip is reverted, current climb included.

**No flapping.** Flapping needs two writers that disagree about the stored state and keep
writing it back. Old clients and the server agree on the encoding exactly: one array, current
climb inside it. The server is the only writer that reshapes the array in a way a shipped
reducer wouldn't predict, and it always says so with a `FullSync`, which old clients apply as
it is.

### What old binaries keep until they update

1. **Solo, everything.** No server in the loop: copies, the jump to the end on similar climbs,
   and #4979.
2. **A flash of one round trip** in S3, S4, S7 and S8.
3. **The coalescer's deferred add.** If O's `setCurrentClimb(C′)` is superseded or throttled,
   the shipped code re-sends C′ as a plain `addQueueItem`, and the copy lands in Up next:
   - Throttled (`recoverThrottledQueueAdd`, `queue-provider.tsx:1844-1874`): the position is
     C′'s index in O's local queue, which is O's Now slot, so the server puts C′ at the head of
     Up next.
   - Superseded (`sendDeferredQueueAdd`, `shared/queue-react/src/create-queue-mutations.ts:405-437`,
     fired from `set-current-climb-coalescer.ts` `fireDeferredQueueAdd`): the position is read
     live when it fires. If C′ is still local, it lands just after O's newer pick, inside Up
     next. If a `FullSync` already wiped C′ and it isn't in the removal ledger, the add goes
     without a position and the server appends it to the end of Up next.

   The server can't tell either from a deliberate Add to queue, so C′ stays. Recognising a
   deferred add of a climb already present (same `climb.uuid` and angle) and dropping it would
   be a design change, because a deliberate duplicate add looks the same. Not in this design.
4. **A `setQueue` composed inside the gap** writes the copy back, and a `setQueue` in flight
   while a crewmate moves or dedupes reverts that move (S14).
5. **History-row taps and track back-swipes onto a History entry** are pointer moves (S6): the
   climbs after that entry move back into Up next.
6. **Nothing current.** Their queue sheet shows History as Up next, their Next goes to
   `queue[0]` (S12), and their Live Activity falls back to `queue[0]`, the oldest History climb
   (`use-live-activity.ts:461`, `:528`). All three are today's behaviour.
7. **Playlist suggestion mode resets more often.** Every `FullSync` runs `INITIAL_QUEUE_DATA`,
   which sets `playlistSuggestionSource: null` (`shared/queue/src/reducer.ts:98`). A crewmate's
   queue-row tap or session-history re-tap is a pointer event today and a `FullSync` under F3,
   so it now cancels an old phone's playlist suggestion mode.
8. **Old-phone drags across the line with nothing current** are clamped (section 7, reducer
   table). The phone sees the clamp as one `FullSync`.

---

## 4. Native changes

**None.** Everything native receives keeps today's shape, with the current climb always in
the array.

| Native piece | Why it needs nothing |
| --- | --- |
| `SessionQueueState.swift` `QueueStateReducer` (`:103-195`) | It always finds the current uuid, so its "append if missing" branch (`:183-193`) goes dead. `FullSync` reorders already apply (`:114-116`). |
| `QueueEventRepaintPolicy` (`:32-41`) | The trailing same-sequence `CurrentClimbChanged` (section 2) keeps the wall lit for every move that today is a pointer event. |
| `LiveActivityManager.buildContentState` | Its index is always in bounds while a climb is current. |
| `ClimbNavigationIntent` | Steps the native index by ±1 and sends `setCurrentClimb(item)` without `shouldAddToQueue` (`SessionWebSocketManager.swift:343`). The server reads an adjacent step as `next` / `step` (S9). |
| Android `BoardSessionService.kt`, `SessionPresenceModule.kt` | Get `currentIndex` from JS, computed the same way as today. |
| APNs `buildContentStateFromQueueState` | Unchanged and never sees an orphan. |

Old binaries see more `FullSync` events (moves, dedupes, History trims), each followed by a
same-sequence `CurrentClimbChanged`, and otherwise today's behaviour. History is trimmed to 100,
so the Live Activity's "4 / 120" position text counts at most 125 History climbs.

One edge exists today and stays on the native side: with nothing current, Swift sets index 0
(`SessionQueueState.swift:115-116`), so the lock screen shows the oldest climb. That happens
after S11, an ordinary removal of the current climb. JS doesn't avoid it today: a queue with
no current climb keeps the activity alive (`hasContent`, `src/lib/live-activity/use-live-activity.ts:308`),
and both send paths fall back to `queue[0]` (`:461`, `:528`) and send its index. Under F3
`queue[0]` is History's oldest climb. The fix is JS and rides the OTA: new phones fall back to
`queue[upNextStart]`, the climb Next would pick (S13), or end the update when Up next is empty
(section 7, other readers). Swift's own `FullSync` handling still lands on index 0 until a
JS update overwrites it; teaching Swift to read `historyCount` is planned as its own
`release/next` PR, opened after the backend field is deployed and reviewed by Fable (section 10).

No Bluetooth or Live Activity file changes, so the Fable / Astra rule isn't triggered by a
path. Two PRs still get a Fable review because they change what the wall lights: the backend
PR (the trailing event) and the #4979 hold.

---

## 5. The 500 cap

`MAX_SYNCED_QUEUE_ITEMS = 500` stays the cap on the whole array, History + Now + Up next. Today
`setQueue` and `joinSession` throw above 500 (`parseArrayTolerant(..., 500)`,
`queue/mutations.ts:381`, `sessions/mutations.ts:146`), while `addQueueItem`
(`queue/mutations.ts:37-130`) and `setCurrentClimb` have no cap. A long session can pass 500
through opens, after which every full-queue write throws. That wedge is fixed here for every
client.

`capHistory`: when History reaches 125 entries, trim it to the newest 100. When an add would
push the array past 500, drop the oldest History entries first. The current climb and Up next
are never trimmed. The 25-entry gap means a long session pays one trim `FullSync` per 25
climbs, not one per climb.

| Path | Today | F3 | Event when it trims |
| --- | --- | --- | --- |
| `setCurrentClimb` (insert or move) | Uncapped insert | `capHistory` after placing. Never rejected: the climb that left the Now slot is History and can go. | `FullSync` + trailing |
| `setClimbFromLedPositions` | Uncapped insert | Same | `FullSync` + controller event |
| `addQueueItem` | Uncapped | `capHistory` first. If Now + Up next is already 500, reject with `QUEUE_FULL`. New clients pre-check and say "Up next is full (500)". An old phone's optimistic add is undone by the next resync. | `FullSync` instead of `QueueItemAdded` |
| `addQueueItem` with a position inside History | Inserted there | Honoured while a climb is current, as today. Clamped to `historyCount` only when nothing is current, so an old Play next sent at position 0 lands at the head of Up next. (An old coalescer's deferred add never targets History: it lands in Up next, section 3 residual 3.) | `FullSync` when it clamped |
| `setQueue`, `joinSession` seed | Throw above 500 | Accept up to 1,000 raw items (still a memory guard), then `capHistory`. Throw only when Now + Up next alone exceed 500. | `FullSync` (already) |
| `setQueue` #3933 merge survivors (`set-queue-merge.ts`) | Re-appended at the end | Unchanged | — |
| History | Unbounded inside 500 | 100, trimmed at 125 | — |
| Mobile bulk append (`queue-provider.tsx:1735-1750`) | Clamps to `500 - queue.length` | Clamps to `500 - (Now + Up next)`, trimming History in the payload with the same `capHistory`. That is a whole-queue write the server stores as sent, so it can't drift. | — |
| New mobile reducer, solo | — | `capHistory` after every local insert or move | — |
| New mobile reducer, in a session | — | Never trims on its own. The server's trim is the only one, and it arrives as a `FullSync` (+ trailing). | — |

**Who trims, and why the client doesn't in a session.** The server caps every request that
carries `placement` and every `setQueue` that carries `historyCount`, whatever
`QUEUE_NOW_SLOT_PERCENT` says. Requests without either (old phones, the native socket, the LED
path, and every `addQueueItem`, which has no `placement` argument) are capped only in sessions
inside the percent. If the new reducer trimmed locally in a session outside the percent, its
array would differ from the server's at 125 History entries, with no `FullSync` to correct it:
a pointer move is echo-suppressed and an add is a plain `QueueItemAdded`. The 60 s watchdog
(`use-session-realtime.ts:972-1035`) compares membership and order, would resync to the
untrimmed array, and the next move would trim again: a `Queue Sync Hash Drift` loop on new
builds. Leaving the trim to the server removes the loop at any percent.

Swap the inline `500` in both resolvers for `MAX_SYNCED_QUEUE_ITEMS` in the same PR (the
`limits.ts` comment tracks it).

---

## 6. #4979: connecting a board after a long gap

**The rule:** when the current climb hasn't changed for 4 hours or more, connecting a board
doesn't light it. The board stays dark until you act. The app still shows the climb, with Put
on the wall. 4 h matches the Redis TTL, and non-permanent sessions end after 1 h idle, so in a
session it only applies to permanent gym sessions.

**One mechanism for all three cases: a hold in the auto-sender.** `BluetoothAutoSender`
(`src/providers/bluetooth-provider.tsx:312`) sends `currentClimbQueueItem` from its effect
(`:462-489`) whenever the board connects or the current climb changes. Today only the #4499
background-adopt gate (`consumeBackgroundAdoptSendGate`, `:562`) stops it. Add a second gate
beside it:

1. The queue provider keeps `lastQueueChangeAt`: the time of the last change to `queue` or the
   current climb. It advances only on `DELTA_UPDATE_CURRENT_CLIMB` (local or server),
   `DELTA_ADD_QUEUE_ITEM`, `DELTA_REMOVE_QUEUE_ITEM`, `DELTA_REORDER_QUEUE_ITEM`, a
   `SET_QUEUE` or `INITIAL_QUEUE_DATA` that comes from a server event or a climber's action,
   and `CLEAR_QUEUE`. It never advances on the restore's `UPDATE_QUEUE`, on `HYDRATE_CLIMBS` or
   on `REGRADE_CLIMBS`, which replace the array without anyone changing the queue.
   - **Solo: a new snapshot field, not `savedAt`.** `savedAt` can't seed it. The save effect
     (`src/providers/queue/use-queue-persistence.ts:237-262`) depends on `queue`, so it fires
     after the cold-start restore (`:121-133` dispatches `UPDATE_QUEUE`, a new `queue`
     identity), after every hydrate and regrade, and when the board settles, and
     `setStoredQueueSnapshot` stamps a fresh `savedAt` on every write
     (`src/lib/queue-snapshot-store.ts:51-56`). A climber who opens the app daily without
     touching the queue, the #4979 report, would refresh `savedAt` daily and never be held.
     So `LocalQueueSnapshot` gains `lastQueueChangeAt`, owned by the provider and written
     through the save effect unchanged; the restore seeds the in-memory value from it. An older
     snapshot without the field seeds from `savedAt` once, which errs towards lighting.
   - **In a session**, the join `FullSync` seeds it from `lastChangedAt`, and each later event
     sets it to the time it arrived.
2. When the auto-sender would send and `now - lastQueueChangeAt >= 4 h`, it records the current
   uuid as held and skips the send.
3. The hold releases when the current climb's uuid changes (a tap, Next, a crewmate's pick) or
   when the climber asks for a re-light (the lightbulb or Put on the wall bumps
   `reassertNonce`).

| Case | Board on connect |
| --- | --- |
| Solo, cold start, snapshot under 4 h old | Lights the current climb, as today |
| Solo, cold start, snapshot 4 h or older (`use-queue-persistence.ts:121-158` never checks age today) | Dark. History and Up next come back as they were. |
| Solo, app left in memory overnight | Dark, from the in-memory `lastQueueChangeAt` |
| Session, `lastChangedAt` under 4 h | Lights, as today |
| Session, `lastChangedAt` 4 h or older (Redis `queueChangedAt`; ticks and no-op write-backs don't move it) | Dark on new phones. The room's state is not touched. |
| Session restored from Postgres after 4 h or more | Dark on new phones, unless a write within 4 h bumped `board_session_queues.updated_at` without changing the queue (section 2): then it lights. The room's state is not touched. |
| Old JS bundle | Lights, as today, until it takes the OTA |

Why a hold and not a queue change:

- Clearing the room's current climb on the server reaches old binaries and makes their Next
  jump to the oldest History climb (section 1, alternatives).
- Moving the solo current climb into History at restore would be a second mechanism with its
  own tests, and it would still need the in-memory case. The hold covers all three.
- A CoreBluetooth background connect is still covered by the #4499 gate first.

The gate lives in `bluetooth-provider.tsx`, which isn't on the CLAUDE.md Bluetooth list. It
still gets a Fable review, because it decides what the wall lights.

---

## 7. Client behaviour changes (mobile JS, OTA on `main`)

Everything here is behind the `queue-now-slot` flag. With it off, the client runs today's
reducer and sends no `placement`. In a session it then behaves like an old client: the server
applies its rules and the client follows the `FullSync`.

### Reducer (`shared/queue/src/reducer.ts`)

| Action | Change |
| --- | --- |
| `DELTA_UPDATE_CURRENT_CLIMB`, local (`:216-318`) | Calls `placeOnWall(state, item, placement)`. The insert-after-current block, `shouldAddToQueue`, `insertAfterCurrent` and the solo prune (`pruneSuggestedAfterCurrent`) are ignored in this mode. |
| `DELTA_UPDATE_CURRENT_CLIMB`, server event | Never re-runs placement. The pointer goes to the named uuid. Only when that uuid is missing (a dropped add) is it inserted at `upNextStart`, which matches today's insert-after-current. |
| `INITIAL_QUEUE_DATA`, `UPDATE_QUEUE` (`:80-127`) | Take `historyCount` from the payload. Missing means derive. |
| `DELTA_ADD_QUEUE_ITEM` | Same History rule as the server (section 5). |
| `DELTA_REMOVE_QUEUE_ITEM` | Keeps the line. Removing the current climb sets `historyCount` to its index. |
| `DELTA_REORDER_QUEUE_ITEM` | With a climb current, the line follows it, as today. With nothing current, `reorderAcrossLine` in `now-slot.ts` (shared with the `reorderQueueItem` resolver) decides. A move within one side leaves `historyCount` alone. A History entry dragged below the line joins Up next and `historyCount` drops by one; the array is what an old phone predicted, so the resolver publishes the plain reorder event. An Up next entry dragged above the line (an old phone sees one flat Up next list, `queue-list-model.ts:33-37`, and `reorderQueueItem` moves by index, `queue/mutations.ts:195-201`) is clamped to `newIndex = historyCount`, the head of Up next, so it keeps the old phone's intent instead of being filed under History; the resolver publishes a `FullSync` when it clamped. The clamp runs only in the resolver (inside the percent) and on a new phone's own drag. A reorder event from the server is applied as given, and `historyCount` moves by one in whichever direction the entry crossed, the same derivation on both sides, so a session outside the percent can't drift. |
| `HYDRATE_CLIMBS` (`:402-423`), `REGRADE_CLIMBS` (`:478-484`) | Freeze History by `index < upNextStart - (current ? 1 : 0)` instead of `index < currentIndex`, so a History climb keeps its climbed-at grade with nothing current. A History climb moved into Now is re-graded, like any current climb. |
| `CLEAR_QUEUE` | `historyCount = 0` |
| `SET_CURRENT_CLIMB` (`:50-63`) | Routed through `placeOnWall`, so it no longer appends for an orphan |
| `SET_CURRENT_CLIMB_QUEUE_ITEM` (`:65-73`) | Appends an orphan `suggested` item today. Nothing outside tests dispatches it, so it is deleted in the cleanup PR; until then it is routed through `placeOnWall` like `SET_CURRENT_CLIMB`. |

`sync-coordinator.ts:94-105` passes `historyCount` from `FullSync`. `:143-173` keeps today's
mapping; the reducer decides what to do with it.

### Provider and callers

| Area | Change | Where |
| --- | --- | --- |
| `setCurrentClimb` | Runs `placeOnWall` locally, then sends the item it resolved to (an existing entry's uuid when the climb is already queued) with `placement: NOW`. Callers keep minting fresh items with `climbToQueueItem`; no caller needs its own "already queued" check. | `src/providers/queue-provider.tsx:2068-2116`, `dispatchSetCurrent` `:1912-2016` |
| Mutation plumbing (shared) | `useQueueMutations().setCurrentClimb` (`packages/shared/queue-react/src/create-queue-mutations.ts:176`) gains an optional trailing `placement`, so any other importer keeps compiling unchanged; the variables at `:398-403` pass it. `setQueue` gains an optional `historyCount`. The coalescer's `SetCurrentClimbArgs` (`packages/shared/queue-runtime/src/set-current-climb-coalescer.ts:31-35`) carries `placement` through to `sendArgs`; its deferred-add decision (`fireDeferredQueueAdd`, keyed on `shouldAddToQueue`) is unchanged. `queue-provider.tsx:43` imports this hook. | `create-queue-mutations.ts`, `set-current-climb-coalescer.ts` |
| Documents (shared) | `SET_CURRENT_CLIMB` gains `$placement`, `SET_QUEUE` and `SET_QUEUE_WITH_BASELINE` gain `$historyCount`, `JOIN_SESSION` gains `$initialHistoryCount` and selects the two new `QueueState` fields | `packages/shared/graphql/src/operations/queue-session.ts:62`, `:167`, `:254`, `:281` |
| Subscription document (mobile) | `QUEUE_UPDATES_SUBSCRIPTION` selects `historyCount` and `lastChangedAt` in `FullSync.state` | `src/lib/graphql/operations.ts:1229` |
| Throttled open | A throttled `move-*` or `dedupe-*` reorders the array, so it can't use the "pointer self-heals" skip. It resyncs like any failed write. A throttled `insert` keeps `recoverThrottledQueueAdd`. | `queue-provider.tsx:1974-2000`, `:1844` |
| `nextClimb` on a track | Sends `NOW`. A track peek still becomes a queue item, but at the Now slot, so it is History once you move on. If the list's neighbour is already queued, that entry moves instead of being copied. | `queue-provider.tsx:2234-2258` |
| `previousClimb` | On a track: `NOW` (the list's previous climb, from History or new). With no track, walking the queue (rule 4): `STEP`. | `queue-provider.tsx:2261-2281` |
| BLE board-compatibility skip | Moves the target into Now, so the skipped climbs for a crewmate's other board stay in Up next | `shared/board-config/src/board-compatibility.ts:256-273` |
| Queue sheet row tap | Up next or History row: `NOW` | `src/components/play-drawer/use-queue-sheet-handlers.ts:65` |
| Similar climbs | Drops the `addToQueue` call and calls `setCurrentClimb` once. The cross-board prompt moves with it. | `use-play-selection-controller.ts:341-378` |
| Widget relay | `dispatchWidgetNavigation` keeps ±1 from native, sent as `STEP` / pointer next | `queue-provider.tsx:2285-2297` |
| Navigation | With nothing current, `selectNextQueueItemWithSuggestions` starts at `upNextStart`, not `queue[0]`. `findPreviousQueueItemWithSuggestions` returns `queue[upNextStart - 1]`. `computeNavigationState.remainingCount` counts Up next. | `shared/play-view/src/queue-navigation.ts:48-110`, `:296-336`, `:374-401` |
| Play next | `playNextInsertPosition` returns `upNextStart`: still `currentIndex + 1` with a climb current, `historyCount` (not 0) without one. Play next on a History row still moves it to the head of Up next. | `shared/queue/src/play-next.ts:91-139` |
| Queue list model | History = `queue[0, upNextStart)` even with nothing current | `shared/play-view/src/queue-list-model.ts:33-37` |
| Other readers | `QueueSheet.tsx:293`, `src/providers/queue/use-queue-regrade.ts:116-120`, `src/providers/queue/use-queue-resolve-climbs.ts:30`, `countFutureQueueItems` in `src/lib/playlists/use-playlist-activation.ts:258` all use `upNextStart` | — |
| Live Activity | With nothing current, the fallback `currentClimbQueueItem ?? queue[0]` becomes `queue[upNextStart]` (the climb Next would pick, S13), and with an empty Up next it sends no climb. Today's fallback shows History's oldest climb as current after S11. | `src/lib/live-activity/use-live-activity.ts:308`, `:461-464`, `:528-531` |
| Playlist replace | `buildPlaylistQueue` keeps the History prefix (today it drops it) and sends `historyCount` | `use-playlist-activation.ts:268` |
| Persistence | Snapshot gains `historyCount` and `lastQueueChangeAt` (section 6). Both optional, so the key `boardsesh_local_queue_snapshot_v1` keeps its suffix. | `src/lib/queue-snapshot-store.ts:22-29`, `use-queue-persistence.ts:121-158` |
| Dead code | `pruneSuggestedQueueItemsAfterCurrent` (`shared/queue/src/playlist-suggestions.ts`) and the `sessionIdRef.current == null` prune switch (`queue-provider.tsx:1950`). Nothing browse-origin reaches Up next any more. Deleted in the cleanup PR, once the legacy branch goes. | — |

### The other follow-ups

- **F1 (#6664):** "Keep going with your queue (N)" counts Up next, which is now honest. Tapping
  it sends `NOW` for Up next[0].
- **F2 (#6665):** every list goes through `setCurrentClimb`, and `placeOnWall` handles copies,
  so F2 needs no per-list "already queued" logic. Record's history
  (`src/components/session-screen/in-session/InSessionView.tsx:135`, `:447`) and the board
  history sheet (`src/providers/drawer-host-provider.tsx`) stop making copies with no change of
  their own. The already-current checks (`isAlreadyCurrent`, `use-play-selection-controller.ts:146`;
  `reusableCurrentItem`, `use-playlist-activation.ts:275`) become redundant and can go in F2.
- **F2 crew previews:** a preview never reaches the server. Only Put on the wall is a
  `setCurrentClimb`, so previews compose without change. The browse gate ("browsing emits
  nothing") still decides whether a gesture is sent at all.
- **F4 (#6667):** play from the list sends only `setCurrentClimb`. "Tapping a playlist loads it
  into my queue" appends to Up next under the section 5 rules and keeps History.
- **F6 (#6669):** the section labels read the same list model.
- **Workouts (#5379):** `appendQueueItems` keeps its behaviour, but it is a whole-queue
  `setQueue` (`queue-provider.tsx:1754`), so from a new phone it sends `historyCount` like
  every other `setQueue`. Undo (`restoreQueueItems`) does the same.

---

## 8. Rollout, kill switches, telemetry, rollback

### Order

| PR | Branch | Contents | Waits for | Risk |
| --- | --- | --- | --- | --- |
| 0 | main | This doc. | — | 1/5 |
| 1 | main | `shared/queue/src/now-slot.ts` and its tests, the frozen legacy fixture and the legacy-client simulation (section 9). No callers. | — | 2/5 |
| 2 | main | Backend: schema additions; Redis fields and script; `updateQueueState` optional `historyCount`; `placeOnWall` in `setCurrentClimbAndPublish` (`services/queue-navigation.ts:20-115`), `setClimbFromLedPositions`, `addQueueItem`, `setQueue`, `joinSession`, `removeQueueItem`, `reorderQueueItem`; `chooseQueueEvent` and the trailing event; caps; readers that use `upNextStart` with nothing current (kiosk preview, `navigateSessionQueue`, controller `navigateQueue`); mutation metrics; `QUEUE_NOW_SLOT_PERCENT`. Fable review for the trailing event. | PR 1 | 4/5 |
| 3 | main (OTA) | Mobile section 7 behind `queue-now-slot`; the shared documents in `packages/shared/graphql/src/operations/queue-session.ts` (`JOIN_SESSION`, `SET_CURRENT_CLIMB`, `SET_QUEUE`, `SET_QUEUE_WITH_BASELINE`) and mobile's `QUEUE_UPDATES_SUBSCRIPTION`; `placement` and `historyCount` through `@boardsesh/queue-react` `create-queue-mutations.ts` and the coalescer's `SetCurrentClimbArgs`; re-recorded screenshot fixtures. | **PR 2 live on production Railway** and checked with a query that selects `historyCount`. A bundle that selects it against an old schema fails validation and loses all queue sync. The `release/next` train's OTAs talk to the production backend too, so the rule holds there. | 4/5 |
| 4 | main (OTA) | #4979 hold (section 6) behind `stale-current-hold-kill`. Fable review. | PR 3 (needs `lastChangedAt`) | 4/5 |
| 5 | main | Docs: rule 3 and inconsistency 3 in `docs/climb-lists-and-queue.md`; the Queue Mutations table, the deferred-add and Play next paragraphs and the Redis structures in `docs/websocket-implementation.md`. | with PR 3 | 1/5 |
| 6 | main | Cleanup: delete the legacy reducer branch, the prune, the `queue-now-slot` flag. | 2 weeks at 100% with the numbers below flat | 2/5 |
| (later) | main | `board_session_queues.history_count` column, generated by drizzle | Telemetry shows permanent sessions waking with nothing current | 3/5 |

**PR 2 ramps before any new client exists.** `QUEUE_NOW_SLOT_PERCENT` goes 0 → 10 → 50 → 100
over about a week, while the field still runs only old bundles. That is the real test of the
compatibility layer: production traffic from shipped clients only, with the hash-drift numbers
split by build.

### Kill switches

- **Backend `QUEUE_NOW_SLOT_PERCENT`** (Railway variable, 0-100). A session is in when the
  FNV-1a hash of its id mod 100 is below it. Unset or unparseable means 0, so it fails closed.
  It governs requests **without** `placement` (old clients, the native socket, the LED path,
  every `addQueueItem` and `reorderQueueItem`) and their caps. At 0 those requests follow
  today's code exactly. Requests **with** `placement`, and `setQueue` with `historyCount`,
  always get the new rules and the caps, so a new phone's optimistic state never disagrees
  with the server. New phones don't trim History locally in a session (section 5), so a
  session outside the percent is not a drift state for them.
  This is the first percent-style env gate in the backend. The nearest precedent the backend
  actually reads is `OG_CARD_TEXT_DISABLED` (`handlers/og-climb.ts:62`), read once at module
  load; `SYNC_DAEMON_DISABLED` is read by `packages/sync-runtime/src/daemon-switch.ts`, not the
  backend. PR 2 adds a small parser beside the gate: trim, `Number.parseInt`, `NaN` to 0,
  clamp to 0-100, with tests. Read once at load, so a change needs a redeploy or restart, a
  few minutes.
- **Mobile `queue-now-slot`**, a positive flag in `FEATURE_FLAG_DEFINITIONS`
  (`src/providers/feature-flags-provider.tsx:67`), read `=== true`. Unresolved or off: today's
  reducer, no `placement`. Flipping it mid-session is safe, because both reducers produce
  states the other accepts and the server decides in a crew. Ramp 10% → 50% → 100%, 3 days per
  step.
- **Mobile `stale-current-hold-kill`** for PR 4, read `!== true`, so unresolved means the hold
  is on (`docs/feature-flags.md`, kill switches).

Lowering the percent while PR 3 bundles are live is safe for sync: old-client requests in the
excluded sessions go back to today's rules, new-client requests keep the new ones, and the two
produce states each side accepts. What it costs is the no-copy fix for old phones in those
sessions. Turn the mobile flag off first only when the goal is today's behaviour everywhere.

### Telemetry

Split everything by `$app_build` and `ota_is_embedded`, the way the `DriverChanged` retirement
was measured, so old and new clients can be compared.

| Signal | Bad looks like |
| --- | --- |
| `Queue Sync Hash Drift` (`shared/analytics/src/events.ts:170`) per session-hour, before and during the PR 2 ramp | Any rise on old builds. It means `chooseQueueEvent` sent a pointer event for a reshape, the biggest risk in this design. |
| Backend `logMutationMetrics('setCurrentClimb' / 'addQueueItem' / 'setQueue')` gains `placement` (`explicit` / `absent`), `rewrite`, `event` (`pointer` / `fullsync` / `fullsync+trailing`), `trimmed`, `queueFull` | `FullSync`s per session-hour over 2× the pre-ramp baseline |
| Share of opens that were `dedupe-*` | Near 0 means the match key is wrong |
| Daily read-only query on `board_session_queues`: rooms where one climb appears more than once in Up next | Not falling as the ramp goes up. Measure the baseline before PR 2. |
| `QUEUE_FULL` rejections, and rooms whose Now + Up next alone exceed 500 | Any sustained count |
| `Queue Sync Stale Event Ignored` (`use-session-realtime.ts:571-578`) per session-hour | Expected to rise in step with the `FullSync` + trailing count, because every JS subscriber drops the trailing event as `ignore-stale`. Bad is a rise beyond that ratio. |
| New `Board Stale Current Held` (`ageHours`, `solo` / `session`) and its release reason | Holds with no release (a stuck gate) |
| APNs `buildContentStateFromQueueState` returning null | Any rise |

### Rollback

- Mobile flag off: seconds. A bad bundle: `vp run ota:rollout -- revert`.
- `QUEUE_NOW_SLOT_PERCENT=0`: minutes.
- Nothing needs to move back. Every state either rule set writes is a valid state for the
  other: one array, current climb in it. Older code ignores the three Redis fields. There is no
  Postgres change to undo.
- Don't roll the backend back past PR 2 while PR 3 bundles are in the field: their documents
  select `historyCount`, and an old schema rejects the whole subscription.

---

## 9. Test plan for the implementation PRs

| File | Scenarios |
| --- | --- |
| `shared/queue/src/__tests__/now-slot.test.ts` (new) | Every row of the `placeOnWall` table. The issue's A, B, C example. The match key: angle and board type, mirror ignored. A moved entry keeps uuid, `tickedBy`, `addedByUser` and mirror. `item: null`. `capHistory` at 125 → 100 and at 500. `QUEUE_FULL`. Orphan append. `upNextStart` with and without a current climb. |
| `shared/queue/src/__tests__/__fixtures__/legacy-queue-2026-10.ts` (new) | A frozen copy of today's `reducer.ts` current-climb branch and `mapQueueEventToAction`, plus a TS port of `QueueStateReducer` from `SessionQueueState.swift`. Later edits to the live reducer can't change what "an old client" does. |
| `shared/queue/src/__tests__/legacy-client-sim.test.ts` (new) | A server model built on `now-slot.ts`, two frozen legacy clients, one Swift port and two new clients, over 1,000 seeded random operations: opens, logbook re-taps, track swipes both ways, queue-row taps, steps, adds, removes, reorders, `setQueue` write-backs, trims. After every published event: every client's v1 and v2 hashes equal the server's, and the Swift port's current uuid is in its list. **For every `CurrentClimbChanged` the server publishes, the frozen legacy reducer applied to the pre-state gives exactly the stored array.** No orphan is ever stored. |
| `shared/queue/src/__tests__/reducer.test.ts` | Local `NOW` / `STEP`. Server events skip placement. `historyCount` across remove, reorder, clear and `FullSync`. Nothing current: a local drag of an Up next entry above the line is clamped to the head of Up next; a History entry dragged below it lowers `historyCount` by one; a server reorder event across the line is applied as given. In a session the reducer never trims History; solo it trims at 125. HYDRATE / REGRADE freeze History with nothing current. Legacy mode unchanged (existing cases stay green). |
| `shared/queue/src/__tests__/sync-coordinator.test.ts`, `play-next.test.ts`, `state-hash.test.ts` | `historyCount` through `FullSync`. Play next with nothing current and `historyCount` 3 lands at 3. The hash ignores `historyCount`. |
| `shared/play-view/src/__tests__/queue-navigation.test.ts`, `queue-list-model.test.ts` | Nothing current with History. Next from nothing starts at the line. Track Previous and Next onto queued neighbours. |
| `shared/queue-runtime/src/__tests__/set-current-climb-coalescer.test.ts` | `placement` is carried through `sendArgs`. A superseded open's deferred add carries its live local position: just after the newer pick when the slot is still local, no position (server appends to the end of Up next) when a `FullSync` removed it. The residual is asserted, not hidden. |
| `backend/src/__tests__/queue-navigation.test.ts` | `setCurrentClimbAndPublish` per `rewrite`: the right event, the trailing event's same sequence and null `correlationId`, `FullSync` on a trim. Percent 0 gives today's results for placement-less calls; placement-carrying calls get the new rules at any percent. Percent 0, placement `NOW`, History at 125: the server trims and publishes `FullSync` + trailing. A native-shaped request (no `shouldAddToQueue`, no `placement`) with a stale item: `insert` plus the trailing event. The percent parser: unset, `abc`, `-5`, `150`. |
| `backend/src/__tests__/mixed-crew-now-slot.test.ts` (new, real Redis) | S1 to S14 from section 3, through the real resolvers, with a legacy-fixture subscriber and a new-reducer subscriber. S14 is the Undo case: O removes A, N's `move-up-next` lands while O's Undo `setQueue` is in flight; the test records the resulting array and current climb as the residual. Includes the watchdog firing inside the gap, a `setQueue` composed inside the gap, a coalescer deferred add after a dedupe, an old-phone reorder across the line with nothing current (clamped, `FullSync`), and a 130-entry History in a session outside the percent with a new phone pressing Next (no hash drift). |
| `backend/src/__tests__/queue-now-slot-redis.test.ts` (new) | Rolling deploy: write with the old Lua script, read with the new one, `historyCountVersion` stale, line derived, `lastChangedAt` from `lastActivity`. `queueChangedAt` moves on a real change and not on a no-op `setQueue` write-back or a tick. Dormant restore derives `historyCount` and takes `lastChangedAt` from `board_session_queues.updated_at`. |
| `backend/src/__tests__/set-queue-concurrent-add-merge.test.ts`, `queue-sync-fixes.test.ts` | `historyCount` input. A 600-item old payload is trimmed, not thrown. Orphan appended, not cleared. `addQueueItem` `QUEUE_FULL` and the History position rule. |
| `backend/src/__tests__/board-queue-preview.test.ts`, `navigate-queue.test.ts`, `widget-navigate.test.ts`, `session-state.test.ts`, `apns.test.ts`, `controller.test.ts` | Nothing current with History: the kiosk's Up next starts at the line; widget next goes to `queue[historyCount]`. The LED path reuses a queued climb and keeps its controller event. APNs never sees an orphan. |
| `mobile/src/providers/__tests__/queue-provider-now-slot.test.tsx` (new), `queue-provider-play-next.test.tsx` | Logbook tap on a queued climb: no copy. Similar climbs leaves Up next alone. Track walk forward and back leaves Up next alone. Flag off sends no `placement`. |
| `mobile/src/providers/__tests__/bluetooth-auto-sender.test.ts`, `mobile/src/providers/queue/__tests__/use-queue-persistence-stale.test.ts` (new) | A snapshot whose `lastQueueChangeAt` is 5 h old holds; 1 h lights. The app relaunched three times over five days with no queue change still holds (the save effect rewrites `savedAt` but not `lastQueueChangeAt`). A hydrate or regrade doesn't advance it. A snapshot without the field seeds from `savedAt`. In memory for 5 h holds. A session join with `lastChangedAt` 5 h ago holds. Each release: a new current, a crewmate's pick, the lightbulb. The kill switch turns the hold off. |
| `mobile/src/lib/live-activity/__tests__/use-live-activity.test.tsx` | Nothing current with History and Up next: the update names Up next[0], not `queue[0]`. Nothing current and Up next empty: no climb sent. Flag off: today's `queue[0]`. |
| `mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts` | Passes after re-recording. |
| `mobile/ios-tests/LiveActivityWidgetTests.swift` | No change. The Swift port in the legacy fixture pins what the shipped reducer receives. |

Device QA for PR 3 needs two phones in one session: one on the new bundle, one on an embedded
old build with a Live Activity and a board connected. Tester steps for the PR body:

1. Queue three climbs → open the second from session history → no copy.
2. Open a climb from Search → Up next unchanged.
3. Old phone: tap a queued climb in session history → copy vanishes.
4. Old phone locked → new phone taps a queue row → board lights it.

---

## 10. Decisions

Owner answers, 2026-10-24, posted on PR #6699.

1. **Model.** Approved: build on the existing `currentClimbQueueItem`. Its copy in the queue
   moves to the History / Up next line (the Now slot) instead of being duplicated. A literal
   out-of-array current climb (option b) is not pursued.
2. **Previous on the queue walk.** Previous steps back into Up next, as the doc proposes.
3. **Tapping a History row.** On new phones the tap moves that climb into Now. Old phones keep
   today's pointer move.
4. **The gap.** 4 h (#4979). After it the board stays dark and the app shows the climb with
   Put on the wall.
5. **History size.** 100 kept, trimmed at 125.
6. **Mirror.** A queued climb is reused whatever its mirror state, keeping the queued entry's
   mirror flag.
7. **Native.** The optional Swift slice that reads `historyCount` will be built as its own
   `release/next` PR after the backend field is deployed, with a Fable Live Activity review.
