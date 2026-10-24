# The current climb outside the queue (F3)

The sync design for F3 (#6666), rule 3 of `docs/climb-lists-and-queue.md`: "The queue holds
only what you or your crew add." Option (b), chosen on 2026-10-23: the current climb lives
outside the queue.

Code references are to `main` at `edef962b3e` (2026-10-24). Mobile paths are under
`packages/mobile/`, shared paths under `packages/shared/`, backend paths under
`packages/backend/src/`. Line numbers drift; the function names next to them don't.

Review log: 2026-10-24, Fable adversarial review (15 confirmed findings, 12 nits, 2 refuted).
Every confirmed finding is addressed in this revision, along with the nits that held up. A
Fable re-check the same day raised five more (the Swift test's CI gate, `next-from-line` at one
History entry and on row taps, orphans at percent 0, one orphan rule for payloads); all five
are addressed.

## What the climber gets

| Today | After F3 |
| --- | --- |
| Opening a climb from any list inserts it into Up next. Climbs you looked at pile up there. | Opening a climb puts it on the wall. When you move on it goes to History. Up next only changes when someone adds to it. |
| With A, B (current) and C queued, tapping C in the logbook gives A, B, C′ (current), C. Next lands on C again (`shared/queue/src/reducer.ts:289-299`). | The same tap gives A, B in History and C current. No copy. Next goes past C. |
| Connecting a board after days away lights the climb that was current when you left (#4979). | The board stays dark. The app shows that climb, when it was last on the wall ("Last on the wall Tuesday") and Put on the wall, one tap away. |
| Tapping a History row rewinds to it: every climb after it becomes Up next. | The tap moves that one climb into Now (decision 3). To rewind, long-press the row → Replay from here: the climbs after it are Up next again, in order. |

Out of scope: web (no climbing UI since W-16, #4435), and workouts, which keep "add to queue"
until workout stages land (#5379).

## The short version

- The climber, the queue sheet and every list model see three parts: **History**, **Now** (the
  current climb) and **Up next**.
- On the wire and in storage the queue keeps today's shape: one flat `queue` array plus
  `currentClimbQueueItem`. The current climb keeps a slot in the array, and that slot always
  sits on the line between History and Up next. We call it the **Now slot**.
- One new integer, `historyCount`, marks the line when nothing is current. Every server write
  keeps it up to date, at every rollout percent, so an add, removal or reorder never erases the
  line.
- What changes is the rule for putting a climb on the wall. The server moves an existing entry
  into the Now slot instead of copying it, and it never jumps the pointer forward over climbs
  nobody climbed. One pure function in `@boardsesh/queue` holds that rule, and the backend and
  the mobile reducer both call it.
- The new GraphQL documents are used only when the mobile flag is on **and** the connected
  backend serves the new fields (a probe on every connect). Otherwise the phone sends today's
  documents and runs today's reducer, so a backend rollback or an early OTA preview can't break
  sync.
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
| Wire change | Two optional output fields (`QueueState.historyCount`, `QueueState.currentChangedAt`) and three optional arguments (`setCurrentClimb(placement:)`, `setQueue(historyCount:)`, `joinSession(initialHistoryCount:)`). No new event type, no new event field. New phones keep both document sets until the cleanup PR. |
| Storage change | Four Redis hash fields. No Postgres change. |
| Native change | None required. One Swift test on `main` pins the same-sequence event the design relies on. An optional Swift slice that reads `historyCount` follows on `release/next` (PR 7). |
| Old binaries | In a crew: no copies from the opens they send there, after a flash of one round trip. Solo (including the issue's logbook case): unchanged until they take the OTA. |
| Kill switches | Backend `QUEUE_NOW_SLOT_PERCENT` (unset means 0, today's rules). Mobile `queue-now-slot` (positive, read `=== true`; picks the documents and the reducer, and only takes effect when the server probe says yes) and `stale-current-hold-kill` (read `!== true`). |

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
| `setQueue`, `joinSession` | `setQueue` silently clears the current climb. `joinSession` clears it when a seed queue was sent without it, and a seed with only a current climb is dropped (`room-manager/client-lifecycle.ts:235` needs a non-empty seed queue). | `graphql/resolvers/queue/mutations.ts:396-412`, `graphql/resolvers/sessions/mutations.ts:168-182` |

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

While nothing is current, every write moves the line by the same rule on the server and on new
phones (`lineAfterDelta`, below), whoever sent it and whatever `QUEUE_NOW_SLOT_PERCENT` says:

| Change while nothing is current | `historyCount` |
| --- | --- |
| Add at index p (append: p = length) | +1 when p < `historyCount`, else unchanged |
| Remove at index i | −1 when i < `historyCount`, else unchanged |
| Reorder from i to j (j in the final array) | −1 when i < `historyCount` ≤ j, +1 when j < `historyCount` ≤ i, else unchanged |
| History trim of n entries | −n |
| Removing the current climb | its index |
| `setCurrentClimb(null)` | the cleared climb's index + 1 |
| A current climb is set | derived from its index again |

`historyCount` is always clamped to `[0, queue.length]`.

`QueueState` (`shared/queue/src/types.ts:214-224`) gains `historyCount: number | null`.
`null` means "derive it from the current climb".

### Invariants (server and new clients)

1. The current climb is in `queue` or `null`. Nothing stores an orphan, at any
   `QUEUE_NOW_SLOT_PERCENT`. There is one rule for every orphan, whatever brought it: it is
   inserted at index `line`, the Now slot, where it stays current (once another climb goes on
   the wall it is History's last entry). For an orphan the line is computed as if nothing were
   current. The rule covers three sources: a room that already holds one when PR 2 deploys
   (today's native stale-item path stores them), normalised on its first write after the deploy;
   the native socket's stale item (section 2, event table row 3); and a `setQueue` or
   `joinSession` payload whose current climb isn't in its queue (section 3). Each of those writes
   publishes a `FullSync`. A new reducer that receives an orphan anyway (a subscribe `FullSync`
   from a room not yet written since the deploy) keeps it as received and never inserts it
   locally, like today's `INITIAL_QUEUE_DATA`; it takes the line from `historyCount`, so both
   hashes still match the server's, and the server's next write normalises the room.
2. Putting a climb on the wall never adds a second copy of a climb already in `queue`.
3. Up next changes only through `addQueueItem`, `reorderQueueItem`, `setQueue` (Add to queue,
   Play next, workouts, Undo, playlist replace), a removal, or a step back on the queue walk
   (section 7). `replaceQueueItem` and `mirrorSessionClimb` rewrite one entry in place and keep
   its index, so they change no membership. The widget and Garmin navigate stops at the ends
   instead of wrapping (section 3).
4. History holds at most 125 entries and is trimmed to 100. The whole array holds at most
   `MAX_SYNCED_QUEUE_ITEMS` = 500 (`shared/queue/src/limits.ts:17`).
5. Every server write stores a `historyCount` computed by `now-slot.ts`. No writer leaves it to
   a default.

### One placement function, shared

New module `packages/shared/queue/src/now-slot.ts`, pure TS, imported by the backend and the
reducer, the same way `state-hash.ts` is shared so the two sides can't drift (#2359):

| Export | What it does |
| --- | --- |
| `upNextStart(queue, current, historyCount)` | `indexOf(current) + 1` when the current climb is in `queue`, else (nothing current, or an orphan) `historyCount ?? 0`. Every reader that today does `findIndex(current)` and treats -1 as "all Up next" calls this instead. |
| `historyOf(state)`, `upNextOf(state)` | The two slices. Readers never do index arithmetic on `queue` themselves. |
| `placeOnWall(state, item, placement)` | The table below. Returns `{ queue, current, historyCount, rewrite }`. |
| `capHistory(state)` | Trims History, oldest first (section 5). |
| `lineAfterDelta(state, delta)` | The `historyCount` after an add, remove, reorder, trim or clear (table above). The resolvers and the reducer both call it, so a delta can't move the line differently on the two sides. |
| `reorderAcrossLine(state, oldIndex, newIndex)` | The clamp for an Up next entry dragged above the line with nothing current (section 7, reducer table), then `lineAfterDelta`. |
| `normaliseHistoryCount(input, queue, current)` | Validates a client-sent `historyCount` / `initialHistoryCount` (section 2). |
| `chooseQueueEvent(before, request, after)` | Which event to publish (section 2). |

`placement` is `NOW`, `STEP` or absent. Absent means a shipped client, the native socket,
or a server-side caller that hasn't been changed. The first row that matches applies.

| Request | `placement` | Result | `rewrite` |
| --- | --- | --- | --- |
| `item.uuid` is the current climb | any | Nothing moves. Re-lights the wall. | `none` |
| `item.uuid` is Up next[0] | any | Pointer moves one step forward. | `next` |
| `item.uuid` is `queue[0]`, nothing current, `historyCount` ≥ 1, Up next not empty, `shouldAddToQueue` not `true` | absent | Read as an old phone's Next (`findNextQueueItem` returns `queue[0]` with nothing current, `shared/play-view/src/queue-navigation.ts:53`, sent with `shouldAddToQueue: false`). Up next[0] becomes current. History stays. | `next-from-line` |
| `item.uuid` is the last History entry | `STEP` or absent | Pointer moves one step back. The climb you left becomes Up next[0]. | `step` |
| `item.uuid` is in History, not last, a climb current | `STEP` or absent | Pointer moves back, as today. Every climb after it moves into Up next. | `step` |
| `item.uuid` is in History, not last, nothing current (any other case) | `STEP` or absent | That entry moves into the Now slot. The rest of History stays. | `move-history` |
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

**Why the "History, not last" row keeps today's pointer move while a climb is current.** A
shipped client sends an existing History uuid in two cases: a History row tap and a back-swipe
on a track (`findQueuedListNeighbour`, `shared/play-view/src/queue-navigation.ts:164-182`,
reuses the neighbour's History entry). The server can tell the row tap from Previous, because a
shipped row tap goes through `setCurrentClimb` and sends `shouldAddToQueue: true`
(`src/providers/queue-provider.tsx:2113`) while Previous and a track swipe onto a queued
neighbour send `false` (`:2257`, `:2280`). It can't tell the track swipe from Previous.
Decision 3 keeps today's pointer move for old phones in both cases, so the server keeps today's
result there (section 3, residual 5). New phones send `NOW` and get `move-history`.

`STEP` lands on that row too. A new phone's Previous names `queue[upNextStart - 1]` from its own
state. When a crewmate's open reaches the server first, that entry is no longer History's last,
and the widget relay hits the same case whenever native's index lags one move. `step` is the
pointer move every shipped reducer predicts, so it stays a plain `CurrentClimbChanged`, and it
matches decision 2: Previous steps back into Up next.

Replay from here (section 7, decision 8) sends `STEP` on purpose for any History entry while a
climb is current. The last-entry row and this row both give `step`: the array doesn't change,
the pointer goes to that entry, and every climb after it (the rest of History and the old
current climb) is Up next again in its old order. Nothing is copied. With History [A B C], D
current and Up next [E], Replay from here on B gives History [A], B current, Up next [C D E].
With nothing current the same request lands on the `move-history` row instead; section 7 says
why the menu hides the action then.

**Why nothing current is different.** With nothing current, a shipped Previous returns nothing
(`findPreviousQueueItem`, `queue-navigation.ts:73`), so a History uuid without `placement` is
an old phone's Next (`queue[0]`, `shouldAddToQueue: false`), a row tap (`true`), or a track
swipe (`false`). A pointer move there would spill up to 100 History climbs into the crew's Up
next: History [H1..H60], the current climb removed, an old phone presses Next, and H2..H60
become Up next for everyone. So no placement-less request spills History while nothing is
current. Next lands on `next-from-line` from one History entry up: with History [A], Up next
[C D], an old Next names A and the server lights C, the climb a new phone's Next picks (S12,
S13). A row tap on `queue[0]` sends `true`, skips that row and lights the climb tapped
(`move-history`, or `step` when it is History's only entry; S18). A track back-swipe that lands
on `queue[0]` looks exactly like Next and is read as Next (section 3, residual 6). The reshaping
rows publish `FullSync` + trailing; the old phone shows its own pick for one round trip, the
same class as S3.

**An orphan in the stored state** (rooms written before PR 2) is normalised first (invariant 1),
then the table applies, at every percent. The write is always a `FullSync`.

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

All additive, so old documents keep validating against the new schema. The reverse is not true:
an unknown field, an unknown argument or a variable of an unknown type (`CurrentClimbPlacement`)
is a document-level validation error whatever the variable's value. The repo already handled
this for `setQueue.baselineSequence` with a separate document plus a runtime fallback
(`SET_QUEUE_WITH_BASELINE`, the comment above it in `queue-session.ts:274`;
`isUnknownBaselineArgumentError`, `shared/queue-react/src/create-queue-mutations.ts:69-81`).
F3 follows that pattern: new phones keep both document sets (below).

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
  "When the room's current climb last changed to a different climb (ISO 8601). Null from a pre-F3 server."
  currentChangedAt: String
}
```

- The server tells new clients from old ones by whether `placement` is present. The
  `x-boardsesh-client` header (`shared-schema/src/client-identity.ts`) stays ungated.
- No event type or event field changes. `FullSync.state` carries `historyCount`. Every delta
  keeps flat positions. Both sides derive `historyCount` from a delta with `lineAfterDelta`.
- `addQueueItem` gains one failure: a GraphQL error with `extensions.code = 'QUEUE_FULL'`
  (section 5).
- **Input validation.** `setQueue(historyCount:)` and `joinSession(initialHistoryCount:)` go
  through `normaliseHistoryCount`: `QueueIndexSchema` (`validation/schemas/primitives.ts:125`,
  integer ≥ 0) first, then, after `parseArrayTolerant` and `capHistory`, a clamp to
  `[0, queue.length]`. When the write carries a current climb that is in its queue, the input is
  ignored and the line is derived from the current index. For a payload orphan the input is the
  line the orphan is inserted at (invariant 1). A buggy client can't send 9999 or −3 and empty everyone's
  Up next.
- **Two document sets.** The new documents are added beside today's, not edited in place:
  `JOIN_SESSION_NOW_SLOT`, `SET_CURRENT_CLIMB_NOW_SLOT` (`$placement`), `SET_QUEUE_NOW_SLOT`
  and `SET_QUEUE_WITH_BASELINE_NOW_SLOT` (`$historyCount`) in
  `packages/shared/graphql/src/operations/queue-session.ts` (today's `JOIN_SESSION` `:62`,
  `SET_CURRENT_CLIMB` `:167`, `SET_QUEUE` `:254`, `SET_QUEUE_WITH_BASELINE` `:281`), and
  `QUEUE_UPDATES_SUBSCRIPTION_NOW_SLOT` beside mobile's `QUEUE_UPDATES_SUBSCRIPTION`
  (`src/lib/graphql/operations.ts:1229`), selecting `historyCount` and `currentChangedAt`. The
  variables are built in `packages/shared/queue-react/src/create-queue-mutations.ts`
  (`setCurrentClimb` signature `:176`, variables `:398-403`), which takes an injected
  `useNowSlotDocuments()` getter and picks the set per call. The legacy set is deleted in the
  cleanup PR.
- **Which set a phone uses.** The new set only when `queue-now-slot === true` **and** the
  connected backend serves the fields. On every socket connect, before the join, the client runs
  one probe, `{ __type(name: "QueueState") { fields { name } } }` (the backend has no
  introspection-blocking rule), and caches the answer for that connection. A deploy or rollback
  drops the socket, so the reconnect probes again. As a second guard, a validation error that
  names `placement`, `CurrentClimbPlacement`, `historyCount`, `initialHistoryCount` or
  `currentChangedAt` (matched as narrowly as `isUnknownBaselineArgumentError`) marks the
  connection legacy and retries on the legacy document. The legacy set means the legacy reducer
  too (section 7).
- The new documents alter the pinned document hashes, so the screenshot fixtures must be
  re-recorded (`src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts`, which imports
  `@boardsesh/graphql/operations` too). The drift test pins both sets. The native
  `SessionWebSocketManager.swift` document doesn't change.

### Which event the server publishes

`chooseQueueEvent` is the one guard against the drift and echo-suppression class, so it is a
check, not a table someone has to keep in sync:

| Case | Event |
| --- | --- |
| The request's `item.uuid` was already in `queue`, the array after the write equals the array before it, and the new current climb is the request's item (`none`, `next`, `step`) | `CurrentClimbChanged`, with the origin's `clientId` and `correlationId`, as today |
| The array after the write is the array before it with the request's item inserted at the Now slot (`insert`, no trim), and the request carried `shouldAddToQueue: true` or `placement` | `FullSync`, as today (`services/queue-navigation.ts:94-99`) |
| The same `insert`, but the request carried neither (the native socket's Next / Previous with a stale item that already left the queue) | `FullSync`, then the trailing `CurrentClimbChanged` under the same sequence, at every percent. Today this request stores an orphan and publishes `CurrentClimbChanged` (`queue-navigation.ts:40-59`, `:103-111`), which is what repaints the wall from a locked phone. The trailing event keeps that repaint. Shipped clients already expect the insert: the old JS reducer puts a `CurrentClimbChanged`'s missing climb right after its current one (`sync-coordinator.ts:143-173` → `reducer.ts:289-299`), which is the Now slot, so today's orphan is itself a drift the `FullSync` removes. |
| Anything else (`move-*`, `dedupe-*`, `next-from-line`, a trim, an orphan normalised) | `FullSync`, then `CurrentClimbChanged` for the new current climb under the **same sequence**, with the origin's `clientId` and `correlationId: null` |

The third condition in the first row matters for `next-from-line`: the array doesn't change,
but the server lights a different climb from the one the old phone asked for. A pointer event
carrying the old phone's `correlationId` would be dropped as its own echo, and the phone would
stay on the wrong climb.

The trailing event is published without entering the replay buffer (`pubsub/index.ts:420-425`
buffers every event but `PlaybackStateChanged`; it gains a `buffer: false` option). It carries
nothing the `FullSync` lacks, so buffering it would only halve how far back the 100-entry buffer
(`EVENT_BUFFER_SIZE`, `:41`) reaches for the #3933 merge, and a replay sorted by sequence could
put it before its own `FullSync`. The publish hooks (APNs, kiosk preview) still run for it.

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
  is a `FullSync`. The trailing event keeps it lit. It passes two equality-sensitive gates on
  the native path before the repaint: the sequence check (`hasSequenceGap` is
  `received > lastKnown + 1`, `SessionQueueState.swift:316-319`, via `QueueSequencePolicy.decision`
  `:59-67`) and the mirror persist (`SharedMirrorState.persist` rejects only
  `sequence < stored`, `SharedMirrorState.swift:104`; a `false` there returns before
  `persistAndNotify` repaints, `SessionWebSocketManager.swift:500-515`). Tightening either to
  reject an equal sequence would silently stop the repaint, so a Swift test pins both (section 9).
  JS drops the trailing event as `ignore-stale` (`shared/queue/src/event-utils.ts:46`). The
  ESP32 gets one more LED write for the same climb.
- **This pattern already ships.** `setClimbFromLedPositions` publishes a `FullSync` and a
  `CurrentClimbChanged` under one sequence (`graphql/resolvers/controller/mutations.ts:264-290`),
  and `docs/websocket-implementation.md` ("Sequence Assignment") documents it as legal.

Plain inserts keep today's single `FullSync`, so a backgrounded phone still doesn't repaint a
crewmate's newly opened climb. That is today's behaviour and stays out of scope.

### Redis (`services/redis-session-store.ts`)

- Four new hash fields: `historyCount`, `historyCountVersion`, `currentUuid` and
  `currentChangedAt`. `UPDATE_QUEUE_STATE_CAS_SCRIPT` (`:95-150`) takes `historyCount` and the
  new current uuid as two more ARGV and writes the fields in the same `HSET` (`:139-147`), so
  they move atomically with `queue` under the same version check. `historyCountVersion` is set
  to the new version. The non-CAS `updateQueueState` (`:212`) writes them the same way;
  `saveSession` copies what it is given.
- **Both CAS callers carry it.** The script has two callers, both through `casWithDormancyFloor`
  (`services/room-manager/queue-state.ts:22`): `updateQueueState` (`:82`, used by
  `setCurrentClimb`, `removeQueueItem`, `setQueue`, `replaceQueueItem`, navigate) and
  `updateQueueOnly` (`:317`, used by `addQueueItem` `queue/mutations.ts:95` and
  `reorderQueueItem` `:210`). `historyCount` becomes a **required** field of the
  `casWithDormancyFloor` input, so the compiler finds every writer. `updateQueueOnly` gains the
  argument too; without it, every add or reorder would bump `version` past
  `historyCountVersion`, and the reader would fall back to 0 while nothing is current, which
  is exactly the erased line this design exists to prevent.
- **Rolling deploys.** For a few minutes two backend instances run the old and the new script.
  An old-script write leaves stale fields. On read, `historyCount` counts only when
  `historyCountVersion == version`; otherwise the reader derives it: the current index, or 0
  when nothing is current, which is today's display.
- **`currentChangedAt` (the #4979 hold's clock).** It is keyed on the current climb, not the
  queue (section 6). Today the script reads only `version`, `sequence`, `stateHash` and
  `stateHashOrdered` (`HMGET`, `:112`); it never reads the stored `queue` or
  `currentClimbQueueItem` JSON. The new script adds `currentUuid` to that `HMGET` and stamps
  `currentChangedAt = now` only when the incoming current uuid differs from it (`null` counts as
  a value). It compares uuids, never JSON: the stored bodies come from different serialisers
  (`addQueueItem` stores the GraphQL input as received, `queue/mutations.ts:89`; `setQueue`
  stores zod-parsed items, `:381`; a mobile write-back re-serialises items it rebuilt from the
  subscription, `src/lib/graphql/operations.ts:1159-1173`), so a byte compare would stamp on
  nearly every no-op write-back. Adds, removes of other entries, reorders, trims, mirror flips
  and `replaceQueueItem` keep the uuid, so they don't stamp. `lastActivity` can't stand in for
  it: the CAS script stamps `lastActivity` on every write (`:147`), and a Postgres restore
  copies `sessions.lastActivity`, which tick logging (`graphql/resolvers/ticks/mutations.ts:1024`,
  `:1548`, `:1895`), title and notes edits (`social/session-mutations.ts:154`) and board-path
  changes (`room-manager/session-discovery.ts:82`) also bump. When `historyCountVersion` is
  stale (an old-script write), the reader returns `lastActivity`, which that old write just
  stamped; it errs towards lighting.
- **Writes that need the stored line are versioned.** The derivation with nothing current needs
  the stored `historyCount` and queue, read in Node. Today's no-baseline `setQueue` is a blind
  `CAS_ANY_VERSION` write (`queue/mutations.ts:522`, `queue-state.ts:137`), so a crewmate's
  removal between the read and the write would leave the line one off. Rule: a write that
  leaves nothing current always passes the version it read and retries on conflict, the way
  `setCurrentClimbAndPublish` does (`resolvers/shared/queue-retry.ts:38-39`). A blind write is
  allowed only when a climb is current, because then the line is derived.

### Postgres (`packages/db/src/schema/app/sessions.ts:172-182`)

**No migration.** `board_session_queues` keeps `queue` and `current_climb_queue_item`.
`historyCount` isn't persisted. On a dormant restore (`services/room-manager/session-restoration.ts:81-108`)
it comes back from the stored current index, or 0 when nothing was current. `currentChangedAt`
comes back from `board_session_queues.updated_at`, which every queue flush writes
(`services/room-manager/queue-state.ts:218-292`), not from `sessions.lastActivity`. That is
approximate: any queue write, an Up next add included, bumps `updated_at`, so a dormant room can
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

The facade methods are `roomManager.updateQueueState(sessionId, queue, current, expectedVersion)`
(`services/room-manager/room-manager.ts:570`) and
`roomManager.updateQueueOnly(sessionId, queue, expectedVersion, knownState)` (`:595`), over
`updateQueueState(deps, ...)` and `updateQueueOnly(deps, ...)` in
`services/room-manager/queue-state.ts:82` and `:317`. Both gain a `historyCount` argument and
pass it to `casWithDormancyFloor`, where it is required. `updateQueueStateImmediate` (`:198`,
the join seed) gains it too.

Every writer computes the value with `now-slot.ts` at every `QUEUE_NOW_SLOT_PERCENT`; the
percent gates only the placement rules, the clamps and the caps (section 8). The orphan rules
(invariant 1) are not gated either:

| Writer | `historyCount` it stores |
| --- | --- |
| `setCurrentClimbAndPublish`, `setClimbFromLedPositions` | From `placeOnWall` |
| `addQueueItem` | `lineAfterDelta` for the add at the stored position |
| `reorderQueueItem` | `lineAfterDelta` for the reorder (after the clamp, inside the percent) |
| `removeQueueItem` (`queue/mutations.ts:147-154`) | `lineAfterDelta`: the current climb's index when it was removed, −1 for a History entry |
| `setQueue`, `joinSession` seed | `normaliseHistoryCount` on the input, or the derivation in section 3 when there is none |
| `replaceQueueItem` (`queue/mutations.ts:313-361`) | The stored value: it swaps an entry by uuid in place |
| `mirrorSessionClimb` (`services/queue-mirror.ts:14-36`) | The stored value: it rewrites the current entry in place |
| `navigateToQueueItem` (`services/queue-navigation.ts:127-183`), widget and Garmin `navigateSessionQueue`, controller `navigateQueue` | Derived: they always set a current climb |

`getQueueState` (`:401`) returns `historyCount` and `currentChangedAt` beside `queue`.

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
| Old JS, Next / Previous on the queue | `setCurrentClimb(neighbour's uuid)`. With nothing current, Next sends `queue[0]` and Previous sends nothing (`shared/play-view/src/queue-navigation.ts:53`, `:73`). | `next` / `step`: pointer only. With nothing current: `next-from-line` (S12, S15). |
| Old JS, queue-row tap | `setCurrentClimb(that row's uuid, shouldAddToQueue: true)` (`queue-provider.tsx:2113`, via `use-queue-sheet-handlers.ts:65`) | `move-up-next`, or `step` for a History row. With nothing current, a History row is `move-history` (`step` for History's only entry); the `true` keeps a tap on `queue[0]` from being read as Next (S18). |
| Old JS, Undo after a remove, playlist replace or clear, workout append, empty-room reseed after a failed seed | `setQueue(queue, current)`, no `historyCount` (`queue-provider.tsx:1677-1683` `setQueue`, `:1692` `restoreQueueItems`, `:1754` `appendQueueItems`; `reSeedQueueRef`, `:976`) | Line = index of current; with nothing current, derived from the stored History (below). Caps apply (section 5). |
| Native Live Activity Next / Previous | `setCurrentClimb(item, correlationId)` without `shouldAddToQueue` (`SessionWebSocketManager.swift:343`) | `next` / `step`; a stale item that left the queue is inserted at the Now slot instead of becoming an orphan, at every percent, with the trailing `CurrentClimbChanged` so the wall still repaints. With nothing current (Swift sits on index 0) its Next names `queue[1]`, which is `move-history` or `move-up-next`, never a spill. |
| Widget, Garmin | REST navigate, server-side index ± 1 with wrap-around (`handlers/session-queue-actions.ts:50-59`; Garmin `handlers/session-actions.ts:125`, widget `handlers/widget-navigate.ts:230`) | Pointer only. Inside the percent it stops at the ends, as controller `navigateQueue` already does (`controller/mutations.ts:439-442`, `:451-454`): Next with Up next empty and Previous with History empty return the existing `out_of_bounds` result, which both routes already handle (`session-actions.ts:131`, `widget-navigate.ts:247`). Today Previous from index 0 wraps to the last climb and sends every Up next climb to History unclimbed, and Next from the end wraps to `queue[0]` and spills all of History. With nothing current, Next goes to `queue[historyCount]` and Previous to `queue[historyCount - 1]`. |
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
| S12 | After S11, O presses Next | O sends `queue[0]` = A (`findNextQueueItem`) with `shouldAddToQueue: false`. `next-from-line`: C current, A stays History, Up next D. The same result as S13. | `FullSync` + trailing | O showed A for one round trip, then C | Repaint C |
| S13 | After S11, N presses Next instead | C = `queue[historyCount]` becomes current, A stays History | `CurrentClimbChanged(C)` | pointer move | Swift finds C |
| S14 | O removes A. While O's Undo `setQueue` is in flight, N taps queue row D (`move-up-next`). | N's move lands first: B **D** C. Then O's Undo, composed from O's live state before N's `FullSync` reached it: A B C D, B current. The #3933 merge replays only `QueueItemAdded`, so N's move is lost. | `FullSync`, `FullSync` | A B C D, B current | Repaint D. The Undo `FullSync` moves Swift's index to B without a repaint. |
| S15 | A long session: History H1..H60, X current, Up next C D. Anyone removes X, then O presses Next. | O sends `queue[0]` = H1. `next-from-line`: C current, H1..H60 stay History, Up next D. | `QueueItemRemoved`, then `FullSync` + trailing | O showed H1 for one round trip, then C | Repaint C |
| S16 | After S11 (`historyCount` 1), O taps Play next on X, inside the percent. O sends position 0 (`playNextInsertPosition` returns 0 with nothing current, `shared/queue/src/play-next.ts:92`). | Clamped to 1: A **X** C D, `historyCount` 1 | `QueueItemAdded(1)`, then `FullSync` | A X C D. Its next Next names A and lights X (`next-from-line`), as today's X A C D would. | Kiosk Up next X C D |
| S17 | The same as S16, in a session outside the percent | Stored at 0: X A C D, `historyCount` 2 (X is filed under History) | `QueueItemAdded(0)` | X A C D, as today. Its next Next lights X: outside the percent the server applies today's pointer move. | Kiosk Up next C D |
| S18 | After S15's removal, O taps the first row of its queue sheet (H1) | O sends H1 with `shouldAddToQueue: true`, so not `next-from-line`. `move-history`: H2..H60 **H1** C D, H1 current. | `FullSync` + trailing | H1, the climb tapped | Repaint H1 |

### The 60 s hash watchdog

The watchdog (`src/providers/queue/use-session-realtime.ts:980-1035`) hashes queue uuids plus
the current uuid on both sides. After every `FullSync` an old phone holds exactly what the
server holds, current climb included, so the hashes match. After every `CurrentClimbChanged`
the old phone's own pointer move gives the server's array and current climb, which
`chooseQueueEvent` checks before choosing that event. So the orphan loop from "Why not take the current climb out" can't
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
  it. It inserts it at the line (invariant 1), at every percent, and the `FullSync` tells the
  origin. Appending it at the end instead would file the climber's whole Up next under History:
  a pre-F3 snapshot [A B C] with orphan X would store [A B C X] with X current. With the line
  rule a fresh join stores [X A B C], X current, and A B C stay Up next on every phone, as the
  old phone showed them (an orphan reads as nothing current, so `queue-list-model.ts:33-37`
  showed all three as Up next). Today the same join clears the current climb
  (`sessions/mutations.ts:168-182`) and `setQueue` does too (`queue/mutations.ts:396-412`). The
  line for a payload orphan is `normaliseHistoryCount` on the sent `historyCount` when there is
  one, else the nothing-current derivation below (0 for a fresh join). A join that seeds only a
  current climb stores `[current]`. Today that seed is dropped, because the join
  writes a seed only when the seed queue is non-empty (`room-manager/client-lifecycle.ts:235`);
  PR 2 changes that guard to "a seed queue or a seed current climb".
- No `historyCount` in the payload: the server derives it from the current climb. With nothing
  current, the line goes just after the last payload entry that is in the stored History:
  `historyCount` = 1 + the highest payload index holding a stored History uuid, or 0 when the
  payload holds none (a playlist clear). An Undo of a History removal puts the line back: stored
  [B | C D] after A was removed, payload [A B C D], line 2. A restored entry that sits right at
  the line goes to the head of Up next. The write is versioned and retried on conflict
  (section 2, Redis), so a crewmate's removal can't slip between the read and the write.
- A payload over 500 is trimmed from History instead of thrown (section 5), so an old phone can
  no longer wedge sync this way. With nothing current the excess comes off the head of the
  array, the oldest entries, and the line moves down by the number trimmed.
- No per-item field is added, so there is nothing for an old client to strip on write-back
  (the #3927 / #3995 class stays closed).
- **A reshape inside the write's round trip is lost (S14).** The #3933 merge
  (`set-queue-merge.ts`) replays only `QueueItemAdded` events that landed after the baseline;
  a `FullSync`-only change in that window is overwritten (`docs/websocket-implementation.md`,
  "Sequence Assignment"). That is true today. F3 makes it more common, because every `move-*`
  and `dedupe-*` is now such a change, so a crewmate's queue-row tap or session-history re-tap
  inside an old phone's Undo round trip is reverted, current climb included. A crewmate's
  deliberate add is never lost this way: an add that trims or clamps still publishes its
  `QueueItemAdded` first and the `FullSync` after it (section 5), so the merge sees the add.

**No flapping.** Flapping needs two writers that disagree about the stored state and keep
writing it back. Old clients and the server agree on the encoding exactly: one array, current
climb inside it. The server is the only writer that reshapes the array in a way a shipped
reducer wouldn't predict, and it always says so with a `FullSync`, which old clients apply as
it is.

### What old binaries keep until they update

1. **Solo, everything.** No server in the loop: copies, the jump to the end on similar climbs,
   and #4979.
2. **A flash of one round trip** in S3, S4, S7 and S8.
3. **The coalescer's deferred add** (old phones only; new phones don't make one, section 7).
   If O's `setCurrentClimb(C′)` is superseded or throttled,
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
5. **History-row taps and track back-swipes onto a History entry while a climb is current**
   are pointer moves (S6): the climbs after that entry move back into Up next.
6. **Nothing current, on their own screen.** Their queue sheet shows History as Up next, and
   their Live Activity falls back to `queue[0]`, the oldest History climb
   (`use-live-activity.ts:461`, `:528`), as today. Inside the percent their Next no longer
   rewrites the room: the server reads it as Next from the line (S12, S15), so they see their
   pick for one round trip and the crew's History stays put. A track back-swipe that lands on
   `queue[0]` with nothing current sends the same request as Next (`shouldAddToQueue: false`),
   so it lights Up next[0] too, not the climb swiped to. A row tap on that climb does light it
   (S18).
7. **Old-phone drags and Play next across the line with nothing current** are clamped inside
   the percent (S16, section 7 reducer table). The phone sees the clamp as one `FullSync`.
   Outside the percent they land where the phone put them, and the line moves with them (S17).

A shipped mobile FullSync doesn't cancel playlist suggestion mode: the reducer's
`playlistSuggestionSource` reset (`shared/queue/src/reducer.ts:98`) is not what mobile reads.
Mobile keeps the source in provider state (`queue-provider.tsx:373`), so the extra `FullSync`s
cost it nothing.

---

## 4. Native changes

**None required.** Everything native receives keeps today's shape, with the current climb
always in the array. Two native items are still in the plan: a Swift test on `main` that pins
the same-sequence acceptance (below), and the optional `release/next` slice that reads
`historyCount` (PR 7).

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
JS update overwrites it. Teaching Swift to read `historyCount` is PR 7 in the rollout table: a
`release/next` PR, opened after the backend field is deployed and reviewed by Fable
(section 10, decision 7).

**The Swift test on `main`.** The design rests on a trailing `CurrentClimbChanged` with the
same sequence as its `FullSync` being applied, persisted and repainted natively (section 2).
Nothing pins that today: the tests in `packages/mobile/ios-tests/LiveActivityWidgetTests.swift`
cover deltas one or more past `lastKnown` and persists at rising sequences, never an equal one,
and no test covers `QueueEventRepaintPolicy`. PR 2 adds three assertions there:
`QueueSequencePolicy.decision` applies a delta at `received == lastKnown`;
`SharedMirrorState.persist` returns `true` twice at the same sequence; and
`shouldRepaintBoard(for: .currentClimbChanged)` is `true`. `ios-tests/` sits outside the
generated `ios/` project and outside the fingerprint, so the test rides `main` with no native
release.

It does not run by itself, though. `ios-rn-ci.yml` triggers on `packages/mobile/**`, but its
macOS job (the only place `prepare-rn-ios-tests.mjs` and `xcodebuild test-without-building`
run) has `needs: gate` and runs only when `.github/actions/mobile-native-gate` says
`should_build`. The gate's path screen doesn't list `ios-tests/`, and adding it there wouldn't
help: the gate would go on to compare fingerprints, find them equal (the tests are outside the
fingerprint) and skip anyway. #5391 (`337b27df63`) ran its Swift tests only because it also
changed `modules/live-activity/ios/*.swift`. So PR 2 adds a forced-build rule to the gate, iOS
only, beside the "iOS Release launch plumbing changed" block: a change under
`packages/mobile/ios-tests` or to `scripts/prepare-rn-ios-tests.mjs` builds with the notice
"iOS Swift tests changed". PR 2's own run exercises the job twice over, since editing the
action also trips the gate's "CI plumbing changed" rule. From then on any later edit to the
test runs it too.

No Bluetooth or Live Activity source file changes before PR 7, so the Fable / Astra rule isn't
triggered by a path until then. Three PRs still get a Fable review because they change what the
wall lights: the backend PR (the trailing event), the #4979 hold, and PR 7.

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
| `addQueueItem` | Uncapped | If Now + Up next is already 500, reject with `QUEUE_FULL`. New clients pre-check and say "Up next is full (500)". An old phone's optimistic add is undone by the next resync. Otherwise insert, then `capHistory`. | `QueueItemAdded`, then a `FullSync` under the next sequence (below) |
| `addQueueItem` with a position inside History | Inserted there | Honoured while a climb is current, as today. Clamped to `historyCount` only when nothing is current, so an old Play next sent at position 0 lands at the head of Up next (S16). (An old coalescer's deferred add never targets History: it lands in Up next, section 3 residual 3.) | `QueueItemAdded` at the clamped position, then a `FullSync` |
| `setQueue`, `joinSession` seed | Throw above 500 | Accept up to 1,000 raw items (still a memory guard), then `capHistory`. With a climb current, throw only when Now + Up next alone exceed 500. With nothing current, never throw: the excess comes off the head (section 3). | `FullSync` (already) |
| `setQueue` #3933 merge survivors (`set-queue-merge.ts`) | Re-appended at the end | Unchanged. The merge folds only `QueueItemAdded` and `QueueItemRemoved` (`set-queue-merge.ts:124-132`), which is why an add that trims still publishes its `QueueItemAdded`. | — |
| History | Unbounded inside 500 | 100, trimmed at 125 | — |
| Mobile bulk append (`queue-provider.tsx:1735-1750`) | Clamps to `500 - queue.length` | Clamps to `500 - (Now + Up next)`, trimming History in the payload with the same `capHistory`. That is a whole-queue write the server stores as sent, so it can't drift. | — |
| New mobile reducer, solo | — | `capHistory` after every local insert or move | — |
| New mobile reducer, in a session | — | Never trims on its own. The server's trim is the only one, and it arrives as a `FullSync` (+ trailing). | — |

**An add that trims or clamps is two writes.** Write 1 stores the add (at the clamped position)
and publishes `QueueItemAdded` under sequence n. Write 2, only when write 1 left History over
125, the array over 500, or the position clamped, is a versioned write of the array, trimmed
when needed, under the version write 1 returned, and publishes `FullSync` under n + 1. The `FullSync`
corrects an old phone that inserted at its own position. Publishing only a `FullSync` would hide
the add from the #3933 merge: an old phone's in-flight Undo would find no `QueueItemAdded` in
its window and overwrite the crewmate's add. The cost is one more Redis round trip on one add in
25 and on clamps. If write 2 fails, the array stays untrimmed until the next write trims it.

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

1. The queue provider keeps `lastCurrentChangeAt`: the time the current climb last became a
   different climb (a different uuid, or `null`). The hold is about the climb on the wall, so
   edits to Up next don't count: a gym member adding five climbs for tonight from home at 09:00
   must not make the board light yesterday's climb at 10:00 (decision 4). It advances only on:
   - a `DELTA_UPDATE_CURRENT_CLIMB`, local or from a server delta, whose uuid differs from the
     current one;
   - a `DELTA_REMOVE_QUEUE_ITEM` that removes the current climb;
   - a local `SET_QUEUE` (playlist replace, Undo) or `CLEAR_QUEUE` that changes the current uuid.

   It never advances on an add, a reorder, a removal of another entry, a mirror flip, a
   `replaceQueueItem`, the restore's `UPDATE_QUEUE`, `HYDRATE_CLIMBS` or `REGRADE_CLIMBS`.
   - **Every `FullSync` seeds it from the server**, not only the join's. The backend sends a
     `FullSync` on every subscribe (`graphql/resolvers/queue/subscriptions.ts:56-66`), the client
     resubscribes on every reconnect (`src/providers/queue/use-session-realtime.ts:884-908`), and
     the watchdog and sequence-gap resyncs dispatch the same `INITIAL_QUEUE_DATA`
     (`:1005`, `:590`). All of them set `lastCurrentChangeAt = state.currentChangedAt`. If any of
     them used the arrival time, the Wi-Fi change on the walk to the wall would release a
     3-day-old hold. When `currentChangedAt` is null (the server probe said legacy, so this
     path is off anyway) and the `FullSync`'s current uuid equals the local one, the local
     value stays; otherwise it is the arrival time.
   - **Solo: a new snapshot field, not `savedAt`.** `savedAt` can't seed it. The save effect
     (`src/providers/queue/use-queue-persistence.ts:237-262`) depends on `queue`, so it fires
     after the cold-start restore (`:121-133` dispatches `UPDATE_QUEUE`, a new `queue`
     identity), after every hydrate and regrade, and when the board settles, and
     `setStoredQueueSnapshot` stamps a fresh `savedAt` on every write
     (`src/lib/queue-snapshot-store.ts:51-56`). A climber who opens the app daily without
     touching the queue, the #4979 report, would refresh `savedAt` daily and never be held.
     So `LocalQueueSnapshot` gains `lastCurrentChangeAt`, owned by the provider and written
     through the save effect unchanged; the restore seeds the in-memory value from it. An older
     snapshot without the field seeds from `savedAt` once, which errs towards lighting.
2. When the auto-sender would send and `now - lastCurrentChangeAt >= 4 h`, it records the current
   uuid as held and skips the send.
3. The hold releases only when the current climb's uuid changes (a tap, Next, a crewmate's
   pick) or when the climber asks for a re-light (the lightbulb or Put on the wall bumps
   `reassertNonce`). It compares uuids, so a `FullSync` that rebuilds the same item (every
   reconnect) doesn't release it.

| Case | Board on connect |
| --- | --- |
| Solo, cold start, current climb set under 4 h ago | Lights the current climb, as today |
| Solo, cold start, current climb set 4 h or more ago (`use-queue-persistence.ts:121-158` never checks age today) | Dark. History and Up next come back as they were. |
| Solo, app left in memory overnight | Dark, from the in-memory `lastCurrentChangeAt` |
| Session, `currentChangedAt` under 4 h | Lights, as today |
| Session, `currentChangedAt` 4 h or older (ticks, Up next edits and no-op write-backs don't move it) | Dark on new phones. The room's state is not touched. |
| Session, current climb set 5 h ago, a crewmate added to Up next 10 min ago | Dark |
| Session, held, then the socket reconnects (Wi-Fi change, foreground) | Still dark: the reconnect `FullSync` reseeds from `currentChangedAt` |
| Session restored from Postgres after 4 h or more | Dark on new phones, unless any queue write within 4 h bumped `board_session_queues.updated_at` (section 2): then it lights. The room's state is not touched. |
| Old JS bundle | Lights, as today, until it takes the OTA |

Why a hold and not a queue change:

- Clearing the room's current climb on the server reaches old binaries and makes their Next
  jump to the oldest History climb (section 1, alternatives).
- Moving the solo current climb into History at restore would be a second mechanism with its
  own tests, and it would still need the in-memory case. The hold covers all three.
- A CoreBluetooth background connect is still covered by the #4499 gate first.

**What the climber sees while held.** A dark board right after connecting reads like a
Bluetooth failure, so the held state says why. Under the climb, beside Put on the wall, the
player shows when that climb was last on the wall, from the same `lastCurrentChangeAt` the gate
reads (seeded from `currentChangedAt` in a session, from the snapshot solo). No second clock, so
the line and the hold can't disagree. The line goes away when the hold releases.

| Age of `lastCurrentChangeAt` | en-US | es | fr | de |
| --- | --- | --- | --- | --- |
| Same calendar day (4 h or more ago) | Last on the wall at {{time}} | En el muro por última vez a las {{time}} | Au mur pour la dernière fois à {{time}} | Zuletzt um {{time}} am Board beleuchtet |
| Yesterday | Last on the wall yesterday | En el muro por última vez ayer | Au mur pour la dernière fois hier | Zuletzt gestern am Board beleuchtet |
| 2 to 6 days | Last on the wall {{weekday}} | En el muro por última vez el {{weekday}} | Au mur pour la dernière fois {{weekday}} | Zuletzt am {{weekday}} am Board beleuchtet |
| 7 days or more | Last on the wall {{date}} | En el muro por última vez el {{date}} | Au mur pour la dernière fois le {{date}} | Zuletzt am {{date}} am Board beleuchtet |

Keys under `session.playView.wallState` beside `putOnWall` (`lastOnWallTime`,
`lastOnWallYesterday`, `lastOnWallWeekday`, `lastOnWallDate`), in all four locales. `{{time}}`,
`{{weekday}}` and `{{date}}` come from `Intl.DateTimeFormat` in the app locale, local time, so
"Tuesday" is the climber's Tuesday (`mardi`, `martes`, `Dienstag`, lower case where the language
writes it so). The Spanish line says _muro_ like `putOnWall` does; the board device stays
_plafón_ anywhere it is named. French lights with « allumer » only, German says _Board
beleuchten_. PR 4 scope, behind the same `stale-current-hold-kill` flag: off, no hold and no
line.

The gate lives in `bluetooth-provider.tsx`, which isn't on the CLAUDE.md Bluetooth list. It
still gets a Fable review, because it decides what the wall lights.

---

## 7. Client behaviour changes (mobile JS, OTA on `main`)

Everything here runs only in **now-slot mode**: `queue-now-slot === true` and, in a session,
the server probe says the backend serves the new fields (section 2). Outside it the client is
an old client in every respect: the legacy documents, today's reducer, no `placement`, the
coalescer's deferred add as today. The legacy reducer stores `historyCount: null` and ignores
any `historyCount` in a payload, so `upNextStart` is today's `findIndex + 1`, or 0 with nothing
current, and every shared reader behaves exactly as today. In a session it then behaves like an
old client: the server applies its rules and the client follows the `FullSync`. The mode is
read when the session joins and on each reconnect; a flag change mid-session takes effect on
the next one.

### Reducer (`shared/queue/src/reducer.ts`)

| Action | Change |
| --- | --- |
| `DELTA_UPDATE_CURRENT_CLIMB`, local (`:216-318`) | Calls `placeOnWall(state, item, placement)`. The insert-after-current block, `shouldAddToQueue`, `insertAfterCurrent` and the solo prune (`pruneSuggestedAfterCurrent`) are ignored in this mode. |
| `DELTA_UPDATE_CURRENT_CLIMB`, server event | Never re-runs placement. The pointer goes to the named uuid. Only when that uuid is missing (a dropped add) is it inserted at `upNextStart`, which matches today's insert-after-current. |
| `INITIAL_QUEUE_DATA`, `UPDATE_QUEUE` (`:80-127`) | Take `historyCount` from the payload. Missing means derive. An orphan current climb (a room not yet written since PR 2 deployed) is kept as received and never inserted; `upNextStart` reads it as nothing current (invariant 1). |
| `DELTA_ADD_QUEUE_ITEM` | Applied at the index it names, local or from the server (the reducer can't tell them apart: `queue-provider.tsx:1328` and `sync-coordinator.ts:118` dispatch the same action). `lineAfterDelta` moves the line: +1 when nothing is current and the index is below `historyCount`. The reducer never clamps. The clamp runs only in the resolver, inside the percent, and a new phone never needs it because it computes positions with `upNextStart` (Play next) or appends. |
| `DELTA_REMOVE_QUEUE_ITEM` | `lineAfterDelta`: removing the current climb sets `historyCount` to its index; with nothing current, removing an entry below `historyCount` lowers it by one, so the line stays between the same climbs. |
| `DELTA_REORDER_QUEUE_ITEM` | With a climb current, the line follows it, as today. With nothing current, `reorderAcrossLine` in `now-slot.ts` (shared with the `reorderQueueItem` resolver) decides. A move within one side leaves `historyCount` alone. A History entry dragged below the line joins Up next and `historyCount` drops by one; the array is what an old phone predicted, so the resolver publishes the plain reorder event. An Up next entry dragged above the line (an old phone sees one flat Up next list, `queue-list-model.ts:33-37`, and `reorderQueueItem` moves by index, `queue/mutations.ts:195-201`) is clamped to `newIndex = historyCount`, the head of Up next, so it keeps the old phone's intent instead of being filed under History; the resolver publishes a `FullSync` when it clamped. The clamp runs only in the resolver (inside the percent) and on a new phone's own drag. A reorder event from the server is applied as given, and `lineAfterDelta` moves `historyCount` by one in whichever direction the entry crossed, the same function the resolver stores with at every percent, so a session outside the percent can't drift. |
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
| Mutation plumbing (shared) | `useQueueMutations().setCurrentClimb` (`packages/shared/queue-react/src/create-queue-mutations.ts:176`) gains an optional trailing `placement`, so any other importer keeps compiling unchanged; the variables at `:398-403` pass it, on the `_NOW_SLOT` document only. `setQueue` gains an optional `historyCount`, same rule. The coalescer's `SetCurrentClimbArgs` (`packages/shared/queue-runtime/src/set-current-climb-coalescer.ts:31-35`) carries `placement` through to `sendArgs`. `queue-provider.tsx:43` imports this hook. | `create-queue-mutations.ts`, `set-current-climb-coalescer.ts` |
| No deferred add in now-slot mode | Today `setCurrentClimb` passes `shouldAddToQueue: true` on every open (`queue-provider.tsx:2113`), and the coalescer re-sends a superseded or rejected open as a plain `addQueueItem` (`fireDeferredQueueAdd`, keyed on `shouldAddToQueue`, `set-current-climb-coalescer.ts:97-99`, fired at `:123` and `:143`). Kept for new phones, three fast track swipes would put the middle peek into every crewmate's Up next, the bug this design removes. In now-slot mode a request with `placement` sends `shouldAddToQueue: false` (the server ignores it under `placement` anyway), so the coalescer never fires a deferred add. A superseded or lost open loses nothing worth keeping: the peek never reached the wall. | `queue-provider.tsx:2113`, `set-current-climb-coalescer.ts` |
| Documents (shared) | The `_NOW_SLOT` set beside today's (section 2): `SET_CURRENT_CLIMB_NOW_SLOT` with `$placement`, `SET_QUEUE_NOW_SLOT` and `SET_QUEUE_WITH_BASELINE_NOW_SLOT` with `$historyCount`, `JOIN_SESSION_NOW_SLOT` with `$initialHistoryCount`, selecting the two new `QueueState` fields | `packages/shared/graphql/src/operations/queue-session.ts`, beside `:62`, `:167`, `:254`, `:281` |
| Subscription document (mobile) | `QUEUE_UPDATES_SUBSCRIPTION_NOW_SLOT` selects `historyCount` and `currentChangedAt` in `FullSync.state`; today's document stays for legacy mode | `src/lib/graphql/operations.ts:1229` |
| Server probe | On every socket connect, before the join: the `__type(name: "QueueState")` probe, cached per connection, plus the narrow validation-error fallback (section 2). Injected into `create-queue-mutations.ts` as `useNowSlotDocuments()`. | `src/providers/queue/use-session-realtime.ts:884-908` |
| Throttled open | A throttled `move-*` or `dedupe-*` reorders the array, so it can't use the "pointer self-heals" skip. It resyncs like any failed write. In now-slot mode a throttled `insert` resyncs too; `recoverThrottledQueueAdd` stays for the legacy branch only. | `queue-provider.tsx:1974-2000`, `:1844` |
| `nextClimb` on a track | Sends `NOW`. A track peek still becomes a queue item, but at the Now slot, so it is History once you move on. If the list's neighbour is already queued, that entry moves instead of being copied. | `queue-provider.tsx:2234-2258` |
| `previousClimb` | On a track: `NOW` (the list's previous climb, from History or new). With no track, walking the queue (rule 4): `STEP`. | `queue-provider.tsx:2261-2281` |
| BLE board-compatibility skip | Moves the target into Now, so the skipped climbs for a crewmate's other board stay in Up next | `shared/board-config/src/board-compatibility.ts:256-273` |
| Queue sheet row tap | Up next or History row: `NOW` | `src/components/play-drawer/use-queue-sheet-handlers.ts:65` |
| Replay from here (History row long-press) | The long-press already opens the climb actions menu with the row's `queueItemUuid` (`handleOpenActions`, `use-queue-sheet-handlers.ts:75-85`). On a History row, while a climb is current, the menu adds **Replay from here** (`climbs.climbActions.replayFromHere`: en-US "Replay from here", es "Repetir desde aquí", fr "Reprendre d'ici", de "Ab hier wiederholen"). It calls `setCurrentClimb` with that History entry and a new optional `placement: STEP` override (every other caller keeps `NOW`), which the table in section 1 resolves to `step`: the line moves back to that climb, the climbs after it are Up next again in order, nothing is copied, and the server publishes a plain `CurrentClimbChanged`. The plain tap stays `NOW` (decision 3). Hidden with nothing current, where `STEP` would mean `move-history` (the same as the tap), and hidden in legacy mode, where the plain tap already does the pointer move. If a crewmate cleared the current climb while the request was in flight, the server applies `move-history` and the `FullSync` corrects the phone. | `use-queue-sheet-handlers.ts`, `src/components/climb-actions/use-climb-actions.ts` |
| Similar climbs | Drops the `addToQueue` call and calls `setCurrentClimb` once. The cross-board prompt moves with it. | `use-play-selection-controller.ts:341-378` |
| Widget relay | `dispatchWidgetNavigation` keeps ±1 from native, sent as `STEP` / pointer next | `queue-provider.tsx:2285-2297` |
| Navigation | With nothing current, `selectNextQueueItemWithSuggestions` starts at `upNextStart`, not `queue[0]`. `findPreviousQueueItemWithSuggestions` returns `queue[upNextStart - 1]`. `computeNavigationState.remainingCount` counts Up next. | `shared/play-view/src/queue-navigation.ts:48-110`, `:296-336`, `:374-401` |
| Play next | `playNextInsertPosition` returns `upNextStart`: still `currentIndex + 1` with a climb current, `historyCount` (not 0) without one. Play next on a History row still moves it to the head of Up next. | `shared/queue/src/play-next.ts:91-139` |
| Queue list model | History = `queue[0, upNextStart)` even with nothing current | `shared/play-view/src/queue-list-model.ts:33-37` |
| Other readers | `QueueSheet.tsx:293`, `src/providers/queue/use-queue-regrade.ts:116-120`, `src/providers/queue/use-queue-resolve-climbs.ts:30`, `countFutureQueueItems` in `src/lib/playlists/use-playlist-activation.ts:258` all use `upNextStart` | — |
| Live Activity | With nothing current, the fallback `currentClimbQueueItem ?? queue[0]` becomes `queue[upNextStart]` (the climb Next would pick, S13), and with an empty Up next it sends no climb. Today's fallback shows History's oldest climb as current after S11. | `src/lib/live-activity/use-live-activity.ts:308`, `:461-464`, `:528-531` |
| Playlist replace | `buildPlaylistQueue` keeps the History prefix (today it drops it) and sends `historyCount` | `use-playlist-activation.ts:268` |
| Persistence | Snapshot gains `historyCount` and `lastCurrentChangeAt` (section 6). Both optional, so the key `boardsesh_local_queue_snapshot_v1` keeps its suffix. | `src/lib/queue-snapshot-store.ts:22-29`, `use-queue-persistence.ts:121-158` |
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
| 1 | main | `shared/queue/src/now-slot.ts` and its tests; the frozen legacy reducer and the Swift port in `shared/queue/src/testing/`, exported as a new `./testing` subpath in `packages/shared/queue/package.json` so the backend tests can import them through the package (today `@boardsesh/queue` exports only `.`); the legacy-client simulation (section 9). No callers. | — | 2/5 |
| 2 | main | Backend: schema additions; Redis fields and script; `historyCount` through `casWithDormancyFloor` (required), `updateQueueState`, `updateQueueOnly` and `updateQueueStateImmediate`; `normaliseHistoryCount` on the two inputs; `placeOnWall` in `setCurrentClimbAndPublish` (`services/queue-navigation.ts:20-115`), `setClimbFromLedPositions`, `addQueueItem`, `setQueue`, `joinSession`, `removeQueueItem`, `reorderQueueItem`; the `client-lifecycle.ts:235` seed guard; `chooseQueueEvent`, the trailing event and its `buffer: false`; caps and the two-write add; readers that use `upNextStart` with nothing current (kiosk preview, `navigateSessionQueue`, controller `navigateQueue`); `navigateSessionQueue` stopping at the ends; mutation metrics; `QUEUE_NOW_SLOT_PERCENT`; the three Swift assertions in `ios-tests/LiveActivityWidgetTests.swift` and the `mobile-native-gate` rule that builds iOS when `ios-tests/` or `prepare-rn-ios-tests.mjs` change, so they run in PR 2's CI (section 4). Fable review for the trailing event. | PR 1 | 4/5 |
| 3 | main (OTA) | Mobile section 7 in now-slot mode; the `_NOW_SLOT` documents beside today's in `packages/shared/graphql/src/operations/queue-session.ts` and mobile's `src/lib/graphql/operations.ts`; the server probe and the validation-error fallback; `placement` and `historyCount` through `@boardsesh/queue-react` `create-queue-mutations.ts` and the coalescer's `SetCurrentClimbArgs`; `shouldAddToQueue: false` with `placement`; Replay from here on the History row long-press with its `placement: STEP` override and four-locale string (decision 8); the `Set Active Climb` properties (telemetry); re-recorded screenshot fixtures pinning both document sets. | PR 2 merged (the drift test validates every mobile document against `@boardsesh/shared-schema`, so PR 3 can't pass CI without PR 2's schema). Production OTA promotion already fails closed unless the live backend serves the OTA's schema (`scripts/mobile-ota-schema-ready.mjs`, run by `production-deploy.yml:815`, `mobile-ota-production.yml:312`). | 4/5 |
| 4 | main (OTA) | #4979 hold (section 6) behind `stale-current-hold-kill`, with the last-on-the-wall line and its four-locale strings (decision 9). Fable review. | PR 3 (needs `currentChangedAt`) | 4/5 |
| 5 | main | Docs: rule 3 and inconsistency 3 in `docs/climb-lists-and-queue.md`; the Queue Mutations table, the deferred-add and Play next paragraphs, the Redis structures, the unbuffered trailing event and the two-write add in `docs/websocket-implementation.md`. | with PR 3 | 1/5 |
| 6 | main | Cleanup: delete the legacy reducer branch, the legacy document set, the probe, the prune, the `queue-now-slot` flag. | 2 weeks at 100% with the numbers below flat | 2/5 |
| 7 | `release/next`, title prefixed `[native-train]` | Swift reads `FullSync.state.historyCount`: the native `SessionWebSocketManager.swift` document selects it, and `QueueStateReducer` lands on `queue[historyCount]` instead of index 0 when nothing is current. Fable Live Activity review (decision 7). | PR 2 deployed | 5/5 |
| (later) | main | `board_session_queues.history_count` column, generated by drizzle | Telemetry shows permanent sessions waking with nothing current | 3/5 |

**PR 2 ramps before any new client exists.** `QUEUE_NOW_SLOT_PERCENT` goes 0 → 10 → 50 → 100
over about a week, while the field still runs only old bundles. That is the real test of the
compatibility layer: production traffic from shipped clients only, with the hash-drift numbers
split by build.

**OTA previews before PR 2 is live.** The per-PR preview publishes a same-repo PR's bundle on
open and on every push (`.github/workflows/mobile-ota-preview.yml:55-56`, no draft or label
opt-out), built against the production backend, and store-build testers can surf to it. With
the server probe that bundle runs legacy mode against a pre-PR-2 backend, so it can't break a
tester's sync. It also can't show the change, so PR 3's device QA waits until PR 2 is live; the
PR 3 test plan says so.

### Kill switches

- **Backend `QUEUE_NOW_SLOT_PERCENT`** (Railway variable, 0-100). A session is in when the
  FNV-1a hash of its id mod 100 is below it. Unset or unparseable means 0, so it fails closed.
  It governs requests **without** `placement` (old clients, the native socket, the LED path,
  every `addQueueItem` and `reorderQueueItem`): their placement rules, the History clamps, the
  stop-at-the-ends navigate and the caps. At 0 those requests produce today's arrays and events,
  with one exception: no orphan is stored. The `historyCount` bookkeeping and the orphan rules
  (invariant 1) run at every percent (section 2, the backend choke point). No shipped client
  reads `historyCount`, and without it a new phone's line would be erased by an old phone's add.
  The orphan rules turn today's orphan writes (the native socket's stale item, a payload orphan
  in `setQueue` or `joinSession`) into an insert at the Now slot plus a `FullSync`, which every
  shipped client applies as it is. Gating them would let a lowered percent store an orphan that
  a new reducer can't hash the same way, and reopen the drift loop on new phones. Requests **with** `placement`, and `setQueue` with `historyCount`,
  always get the new rules and the caps, so a new phone's optimistic state never disagrees
  with the server. New phones don't trim History locally in a session (section 5), so a
  session outside the percent is not a drift state for them.
  This is the first percent-style env gate in the backend. The nearest precedent is the
  numeric `WS_ANON_CONNECTIONS_PER_CLIENT_IP` (`websocket/connection-cap.ts:67-90`, `readCap`:
  blank means the default, an invalid value is logged and ignored). PR 2 adds a small parser in
  the same style: trim, `Number.parseInt`, `NaN` to 0, clamp to 0-100, with tests. A Railway
  variable change redeploys the service, a few minutes.
- **Mobile `queue-now-slot`**, a positive flag in `FEATURE_FLAG_DEFINITIONS`
  (`src/providers/feature-flags-provider.tsx:67`), read `=== true`. Unresolved or off: legacy
  mode (section 7), with the legacy documents, so it really is a kill switch for every failure
  this design can cause. It takes effect on each phone's next flag reload and the session's next
  join or reconnect, not instantly: PostHog values persist on the device
  (`docs/feature-flags.md`). Flipping it mid-session is safe, because both reducers produce
  states the other accepts and the server decides in a crew. Ramp 10% → 50% → 100%, 3 days per
  step.
- **Mobile `stale-current-hold-kill`** for PR 4, read `!== true`, so unresolved means the hold
  is on (`docs/feature-flags.md`, kill switches).

Lowering the percent while PR 3 bundles are live is safe for sync: old-client requests in the
excluded sessions go back to today's rules, new-client requests keep the new ones, no orphan is
stored at any percent, and the two produce states each side accepts. What it costs is the no-copy fix for old phones in those
sessions. Turn the mobile flag off first only when the goal is today's behaviour everywhere.

### Telemetry

Split everything by `$app_build` and `ota_is_embedded`, the way the `DriverChanged` retirement
was measured, so old and new clients can be compared.

| Signal | Bad looks like |
| --- | --- |
| `Queue Sync Hash Drift` (`shared/analytics/src/events.ts:170`) per session-hour, before and during the PR 2 ramp | Any rise on old builds. It means `chooseQueueEvent` sent a pointer event for a reshape, the biggest risk in this design. |
| Backend `logMutationMetrics('setCurrentClimb' / 'addQueueItem' / 'setQueue')` gains `placement` (`explicit` / `absent`), `rewrite`, `event` (`pointer` / `fullsync` / `fullsync+trailing`), `trimmed`, `queueFull` | `FullSync`s per session-hour over 2× the pre-ramp baseline |
| Share of opens that were `dedupe-*` | Near 0 means the match key is wrong |
| `Set Active Climb` (`shared/analytics/src/events.ts:139`, already tracked in `setCurrentClimb`, `queue-provider.tsx:2085`, with `sessionId` null when solo) gains `rewrite`, `placement` and `nowSlotMode` from the local `placeOnWall`. This is the only signal for the issue's headline case: a solo queue never reaches the server, so the backend metrics can't see it. | Near-zero `dedupe-*` share on new builds with `sessionId` null, while the session share is healthy: the match key misses on solo inputs (for example `boardType` on one side only) |
| New `Queue Snapshot Restored`, once per launch: `historyCount`, `upNextCount`, and `upNextDuplicates` (climbs that appear more than once in the restored solo Up next) | `upNextDuplicates` not falling on new builds as old solo snapshots age out |
| Daily read-only query on `board_session_queues`: rooms where one climb appears more than once in Up next | Not falling as the ramp goes up. Measure the baseline before PR 2. |
| `QUEUE_FULL` rejections, and rooms whose Now + Up next alone exceed 500 | Any sustained count |
| `Queue Sync Stale Event Ignored` (`use-session-realtime.ts:571-578`) per session-hour | Expected to rise in step with the `FullSync` + trailing count, because every JS subscriber drops the trailing event as `ignore-stale`. Bad is a rise beyond that ratio. |
| New `Board Stale Current Held` (`ageHours`, `solo` / `session`) and its release reason | Holds with no release (a stuck gate), or session holds released by `reconnect` (the reseed failed) |
| New `Queue Server Probe` (`nowSlotServer: true / false`, `fallback: probe / validation-error`), at most once per launch and on every `false` | Any `false` after PR 2 is live, outside a deploy window |
| APNs `buildContentStateFromQueueState` returning null | Any rise |

### Rollback

- Mobile flag off: each phone's next flag reload, then its next join or reconnect. A bad
  bundle: `vp run ota:rollout -- revert`.
- `QUEUE_NOW_SLOT_PERCENT=0`: minutes.
- Nothing needs to move back. Every state either rule set writes is a valid state for the
  other: one array, current climb in it. Older code ignores the four Redis fields. There is no
  Postgres change to undo.
- Rolling the backend back past PR 2 while PR 3 bundles are in the field is survivable. The
  deploy drops every socket, the reconnect probe says legacy, and new phones run legacy mode
  with today's documents until the backend comes back. A request already in flight on the old
  socket can fail once with a validation error; the fallback retries it on the legacy document.
- After PR 6 deletes the legacy documents and the probe, the old rule returns: don't roll the
  backend back past PR 2.

---

## 9. Test plan for the implementation PRs

| File | Scenarios |
| --- | --- |
| `shared/queue/src/__tests__/now-slot.test.ts` (new) | Every row of the `placeOnWall` table, including `STEP` onto a History entry that is no longer last (a crewmate's open landed first): `step`, and `chooseQueueEvent` picks `CurrentClimbChanged`. Nothing current: `queue[0]` with `shouldAddToQueue: false` and `historyCount` 60 gives `next-from-line` (History stays 60), and with `historyCount` 1 gives `next-from-line` too (History stays 1); with Up next empty it gives `move-history` (`step` at `historyCount` 1); the same `queue[0]` with `shouldAddToQueue: true` (a row tap) gives `move-history` (`step` at `historyCount` 1); any other History entry gives `move-history`; none that reshapes is a pointer event. An orphan pre-state, and a `setQueue` / `joinSession` payload orphan, is inserted at the line (a fresh join [A B C] + orphan X gives [X A B C]) and gives a `FullSync`. `upNextStart` with an orphan current returns `historyCount ?? 0`. The issue's A, B, C example. The match key: angle and board type, mirror ignored. A moved entry keeps uuid, `tickedBy`, `addedByUser` and mirror. `item: null`. `lineAfterDelta` for every row of the section 1 line table, including the reorder boundaries (j = `historyCount`, j = `historyCount` − 1). `normaliseHistoryCount`: −1 and 9999 rejected or clamped to `[0, length]`, ignored when a climb is current. `capHistory` at 125 → 100 and at 500. `QUEUE_FULL`. `upNextStart` with and without a current climb. |
| `shared/queue/src/testing/legacy-queue-2026-10.ts` (new, `@boardsesh/queue/testing`) | A frozen copy of today's `reducer.ts` current-climb branch and `mapQueueEventToAction`, plus a TS port of `QueueStateReducer` from `SessionQueueState.swift`. Later edits to the live reducer can't change what "an old client" does. Imported through the package by the shared simulation and the backend mixed-crew test. |
| `shared/queue/src/__tests__/legacy-client-sim.test.ts` (new) | A server model built on `now-slot.ts`, two frozen legacy clients, one Swift port and two new clients, over 1,000 seeded random operations: opens, logbook re-taps, track swipes both ways, queue-row taps, steps, adds, removes, reorders, `setQueue` write-backs, trims, Next with nothing current, at percent 0 and 100. After every published event: every client's v1 and v2 hashes equal the server's; **every new client's `historyCount` equals the server's**; the Swift port's current uuid is in its list. **For every `CurrentClimbChanged` the server publishes, the frozen legacy reducer applied to the pre-state gives exactly the stored array and current climb.** No orphan is ever stored. |
| `shared/queue/src/__tests__/reducer.test.ts` | Local `NOW` / `STEP`. Replay from here: History [A B C], D current, Up next [E], a local `STEP` for B leaves the array as it was, makes B current with History [A] and Up next [C D E], and the hash equals the server's after its `CurrentClimbChanged`; the same `STEP` with nothing current gives `move-history`. Server events skip placement. Nothing current, `historyCount` 1: a server `QueueItemAdded` at 0 is applied at 0 and the line becomes 2; at 1 the line stays 1; a removal at 0 lowers it to 0. `historyCount` across reorder, clear and `FullSync`. Nothing current: a local drag of an Up next entry above the line is clamped to the head of Up next; a History entry dragged below it lowers `historyCount` by one; a server reorder event across the line is applied as given. In a session the reducer never trims History; solo it trims at 125. HYDRATE / REGRADE freeze History with nothing current. A `FullSync` with an orphan current climb keeps it as received, inserts nothing, and hashes equal to the server's. Legacy mode stores `historyCount: null` even when a `FullSync` carries 1, and its readers match today's (existing cases stay green). |
| `shared/queue/src/__tests__/sync-coordinator.test.ts`, `play-next.test.ts`, `state-hash.test.ts` | `historyCount` through `FullSync`. Play next with nothing current and `historyCount` 3 lands at 3. The hash ignores `historyCount`. |
| `shared/play-view/src/__tests__/queue-navigation.test.ts`, `queue-list-model.test.ts` | Nothing current with History. Next from nothing starts at the line. Track Previous and Next onto queued neighbours. |
| `shared/queue-runtime/src/__tests__/set-current-climb-coalescer.test.ts` | `placement` is carried through `sendArgs`. Now-slot mode: three fast opens with `placement` and `shouldAddToQueue: false`; the superseded middle open fires no deferred add, and neither does a drain rejection. Legacy mode: a superseded open's deferred add carries its live local position, just after the newer pick when the slot is still local, no position (server appends to the end of Up next) when a `FullSync` removed it. The old-client residual is asserted, not hidden. |
| `shared/queue-react/src/__tests__/create-queue-mutations.test.ts` | Mode off or probe `false`: every call uses today's documents and sends no `placement` / `historyCount`. Mode on and probe `true`: the `_NOW_SLOT` documents. A validation error naming `placement` or `historyCount` falls back to the legacy document once and marks the connection legacy; any other error is not retried. |
| `backend/src/__tests__/queue-navigation.test.ts` | `setCurrentClimbAndPublish` per `rewrite`: the right event, the trailing event's same sequence and null `correlationId`, `FullSync` on a trim. The trailing event is not in the replay buffer, and the APNs and kiosk hooks still run for it. `next-from-line` publishes `FullSync` + trailing, not a pointer event. Percent 0 gives today's arrays and events for placement-less calls, except that no orphan is stored; placement-carrying calls get the new rules at any percent. Percent 0, placement `NOW`, History at 125: the server trims and publishes `FullSync` + trailing. A native-shaped request (no `shouldAddToQueue`, no `placement`) with a stale item, at percent 0 and at 100: `insert` at the Now slot plus the trailing event, never an orphan. A room holding a pre-PR-2 orphan is normalised on its first write at percent 0. The percent parser: unset, `abc`, `-5`, `150`. |
| `backend/src/__tests__/mixed-crew-now-slot.test.ts` (new, real Redis) | S1 to S18 from section 3, through the real resolvers, with a legacy-fixture subscriber and a new-reducer subscriber. S14 is the Undo case: O removes A, N's `move-up-next` lands while O's Undo `setQueue` is in flight; the test records the resulting array and current climb as the residual. S15: History H1..H60, the current climb removed, O's Next: History stays 60 for N and the kiosk. Nothing current, percent 0: O adds, removes a History entry and reorders; after each, the server's `historyCount` equals N's and the next `FullSync` carries it (the line is never erased). Also: the watchdog firing inside the gap, a `setQueue` composed inside the gap, a coalescer deferred add after a dedupe (old phone only), an old-phone reorder across the line with nothing current (clamped, `FullSync`), and a 130-entry History in a session outside the percent with a new phone pressing Next (no hash drift). |
| `backend/src/__tests__/queue-now-slot-redis.test.ts` (new) | Rolling deploy: write with the old Lua script, read with the new one, `historyCountVersion` stale, line derived, `currentChangedAt` from `lastActivity`. `addQueueItem` and `reorderQueueItem` through `updateQueueOnly` with nothing current keep `historyCount` valid (`historyCountVersion == version`). `currentChangedAt` moves when the current uuid changes, and not on an add, a reorder, a mirror flip, a tick, or a no-op `setQueue` write-back whose items were re-serialised the way mobile rebuilds them (different key order, slim fields). A nothing-current `setQueue` raced by a removal between read and write conflicts and retries. Dormant restore derives `historyCount` and takes `currentChangedAt` from `board_session_queues.updated_at`. |
| `backend/src/__tests__/set-queue-concurrent-add-merge.test.ts`, `queue-sync-fixes.test.ts` | `historyCount` input: −1, 9999 and a value sent with a current climb. Old-phone Undo of a History removal with nothing current: stored [B \| C D], payload [A B C D], line 2. A playlist clear gives 0. A 600-item old payload is trimmed, not thrown, with and without a current climb. A payload orphan is inserted at the line, not cleared and not appended: `joinSession` with [A B C] + orphan X stores [X A B C] with Up next A B C, at percent 0 and 100. `joinSession` with only a current climb stores `[current]`. `addQueueItem` `QUEUE_FULL` and the History position rule. An add that trims while an old phone's Undo is in flight: the merge sees its `QueueItemAdded` and keeps the add, and the `FullSync` follows under the next sequence. |
| `backend/src/__tests__/board-queue-preview.test.ts`, `navigate-queue.test.ts`, `widget-navigate.test.ts`, `session-state.test.ts`, `apns.test.ts`, `controller.test.ts` | Nothing current with History: the kiosk's Up next starts at the line; widget next goes to `queue[historyCount]`. Inside the percent the widget and Garmin stop at both ends with `out_of_bounds` (the wrap case at `widget-navigate.test.ts:399` flips); at percent 0 they still wrap. The LED path reuses a queued climb and keeps its controller event. APNs never sees an orphan. |
| `mobile/src/providers/__tests__/queue-provider-now-slot.test.tsx` (new), `queue-provider-play-next.test.tsx` | Logbook tap on a queued climb: no copy. Similar climbs leaves Up next alone. Track walk forward and back leaves Up next alone. Three fast swipes in a session leave Up next unchanged. Flag off, or probe `false`: no `placement`, today's documents. `Set Active Climb` carries `rewrite`, `placement` and `nowSlotMode`, solo and in a session. |
| `mobile/src/components/play-drawer/__tests__/use-queue-sheet-handlers.test.tsx`, `climb-actions/__tests__/use-climb-actions.test.tsx` | Long-press a History row with a climb current: the menu shows Replay from here, and tapping it calls `setCurrentClimb` with that row's uuid and `placement: STEP`. A plain tap on the same row still sends `NOW`. The action is absent on Up next rows, on the current climb, with nothing current, and in legacy mode. |
| `mobile/src/providers/__tests__/bluetooth-auto-sender.test.ts`, `mobile/src/providers/queue/__tests__/use-queue-persistence-stale.test.ts` (new) | A snapshot whose `lastCurrentChangeAt` is 5 h old holds; 1 h lights. The app relaunched three times over five days with no queue change still holds (the save effect rewrites `savedAt` but not `lastCurrentChangeAt`). An add to Up next 10 min ago with the current climb set 5 h ago still holds, solo and in a session. A hydrate or regrade doesn't advance it. A snapshot without the field seeds from `savedAt`. In memory for 5 h holds. A session join with `currentChangedAt` 5 h ago holds; then a reconnect `FullSync`, a watchdog resync and a sequence-gap resync with the same `currentChangedAt` keep holding. Each release: a new current, a crewmate's pick, the lightbulb. The kill switch turns the hold off. While held, the player shows the last-on-the-wall line for each age band in section 6 (same day, yesterday, 2 to 6 days, 7 or more) in all four locales; it goes away on release and never shows with the kill switch on. |
| `mobile/src/lib/live-activity/__tests__/use-live-activity.test.tsx` | Nothing current with History and Up next: the update names Up next[0], not `queue[0]`. Nothing current and Up next empty: no climb sent. Flag off: today's `queue[0]`. |
| `mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts` | Passes after re-recording, with both document sets validated against the schema. |
| `mobile/ios-tests/LiveActivityWidgetTests.swift` | Three new assertions (section 4): `QueueSequencePolicy.decision` applies a `CurrentClimbChanged` at `received == lastKnown`; `SharedMirrorState.persist` returns `true` twice at the same sequence; `QueueEventRepaintPolicy.shouldRepaintBoard(for: .currentClimbChanged)` is `true`. Together they pin the trailing event where it lives, which the TS port can't (its reducer ignores sequences). They run in PR 2's CI through the new `mobile-native-gate` rule (section 4); check that the iOS job ran rather than skipped. |

Device QA for PR 3 needs two phones in one session, after PR 2 is live: one on the new bundle,
one on an embedded old build with a Live Activity and a board connected. Tester steps for the
PR body:

1. Queue three climbs → open the second from session history → no copy.
2. Open a climb from Search → Up next unchanged.
3. Old phone: tap a queued climb in session history → copy vanishes.
4. Old phone locked → new phone taps a queue row → board lights it.
5. Remove the current climb → old phone taps Next → History stays.
6. Long-press a History row → Replay from here → later climbs return.

PR 4's plan adds: climb left on 4 h → reconnect board → dark, "Last on the wall".

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
8. **Replay from here.** Approved 2026-10-24, from the climber panel (circuit climbers wanted
   "A, then B, C again"). A History row's long-press offers Replay from here, which sends
   `STEP` for that entry while a climb is current: the line moves back to it and the climbs
   after it are Up next again in order. The plain tap keeps decision 3. PR 3 scope.
9. **Say why the board is dark.** Approved 2026-10-24, from the same panel. While the hold keeps
   the board dark, the player shows when the climb was last on the wall ("Last on the wall
   Tuesday") beside Put on the wall, so it doesn't read as a Bluetooth failure. PR 4 scope.
