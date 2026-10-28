# Workout stages

How the mobile app knows that a queued climb is part of a workout, and which part:
"Warm-up · 2 of 5" in the player's top bar, and the "Your workout" card on the session screen.
Issue [#5379](https://github.com/boardsesh/boardsesh/issues/5379), part of epic
[#5399](https://github.com/boardsesh/boardsesh/issues/5399).

## The model

A workout is an ordered list of **blocks**, and every part of it is one, the warm-up
included. A block (`WorkoutBlockSpec`) is either a warm-up of one length (standard or
extended) or one run of the generator (volume, pyramid, ladder, grade focus, or one of
the timed types: on the minute, 4x4, limit bouldering) at one target grade, plus its own
climb filters (`WorkoutStageFilters`: climb bias, min ascents, min rating, tall only,
wide only). Each block becomes one **stage**. The code lives in
`packages/shared/playlist-generator/src/stages.ts`, pure TS and JSON-serialisable.

- `WorkoutPlan` is what the climber asked for: `planFromBlocks(blocks, makeId)` turns
  the blocks into stages, one per block, in the order given. A warm-up can sit anywhere
  and more than once. A workout block's own `warmUp` option is ignored. A block's
  `filters` pass to its stage; on a workout stage they win over the copies its
  `options` carry. The generator plans grades only, so filters never change a slot.
- `generateStagedPlan(plan, grades)` fills every stage with grade slots. Each slot names
  its stage id. A warm-up ramps to the grade of the first workout stage after it,
  skipping any warm-ups in between (partner warm-ups carry their own `targetGrade` and
  use that instead). With no workout stage after it, it is a **cool-down**: the climbs
  the same warm-up would plan up to the grade the nearest workout stage before it ends
  on, hardest first, in the `coolDown` section. That stage ends on its last planned
  climb, capped at its target grade (a volume spread can end above it), so the first
  cool-down climb is always easier than the climb before it. A standard warm-up after a
  V5 volume block plans V4, V3, V2, V1. After a V15 pyramid, which ends on V13, it plans
  V12 down to V9 rather than climbing back up to V14. A warm-up with no workout stage on
  either side plans no climbs. A warm-up plus one workout plans exactly what the
  single-type generator always planned.
- `WorkoutRun` is what actually got queued: per stage, the queue-item uuids that belong
  to it (`buildWorkoutRun`). A stage with no climbs is left out. A workout stage also
  keeps its `targetGrade`, and every stage keeps its `filters`, so a block added later
  can start from them. A warm-up planned as a cool-down keeps `coolDown: true`. All
  three are optional: a run stored before they existed still loads under the same
  storage key. A stage whose stored `filters` this bundle cannot read (a malformed
  field, or a climb bias it does not know) loses just that field; the stage and the run
  load, so the next mid-session block cannot overwrite the stages queued at Start.
- A timed stage also keeps its **pacing** (`WorkoutStagePacing`, `pacing.ts`). Pacing is
  worked out from the block's options by `pacingForOptions` and stored only on the run
  stage, because a run keeps no options. On the minute paces `onTheMinute` with its
  interval (15 s to an hour). A 4x4 paces `afterTick` with its rest between reps
  (`restSeconds`) and its `sets` (`repsPerSet` and `restBetweenSetsSeconds`), and moves on
  (`advanceOn: 'set'`) after any tick once the set's every rep is logged. Limit bouldering
  paces `afterTick` with its rest and moves on only after a flash or a send, so a fall
  rests and stays on the climb. Every other kind has no pacing: the climber's own rest-timer settings apply.
  `stageRestSeconds` never runs a rest that moves the wall under `STAGE_CHANGEOVER_SECONDS`
  (10 s), a rest of 0 included, so a tick saved a few seconds late can't land past the
  timer's 5 s overdue grace. A 4x4's rest between reps never moves the wall, so it runs as
  set, and 0 there is no rest at all.
- **A 4x4 set is one climb done for every rep** (Marco, 2026-10-25; it replaced the round
  model, A B C D climbed once per round). A 4x4 plans one slot per set, one climb fills
  each slot, and Start queues each climb once under its own queue item. Its reps are the
  ticks logged on that one queue item, falls and sends alike. "4 reps × 4 sets" is four
  climbs, each done four times in a row. Every surface says reps first, sets second (Marco,
  2026-10-25): the readout, the builder (Reps per set above Sets), the summaries. The sets are 1 to 10 climbs, the reps 2 to 10
  (`MIN_STAGE_REPS_PER_SET`, `MAX_STAGE_REPS_PER_SET`).
- `locateInRun` answers "where is the current climb". It orders by the queue, not by the
  run, and counts only uuids still queued, because climbers reorder and remove climbs.
  On a 4x4 the climb's place in its stage is its set, and the tick log gives the rep
  (`workoutClimbGo`), so the player reads "4x4 · Rep 3 of 4 · Set 2 of 4"
  (`formatWorkoutStagePositionWithGo`). The rep number stops at the set's last.
  A climb of a stage marked `coolDown` gets `isCoolDown`, and the card and the player name
  the stage "Cool-down". The mark comes from the plan, not the queue order, because the
  stage's climbs step down wherever they sit: a cool-down the climber moves in front of the
  workout, or one a mid-session block lands after, still reads "Cool-down". A warm-up that ramps up (one the climber drags behind
  the workout, or a partner warm-up with its own `targetGrade`) never does.
- The player shows it in its top bar, between ⌄ and the rest timer + ⋯, in the spot a
  list's "Projects · 4 of 23" uses (a climb in the workout shows its stage). The stage
  name and the numbers are two texts (`formatWorkoutStageParts`): with the timer up the
  name is cut, the numbers never are. It used to lead the header's stats line, where it
  pushed the sends and stars off a phone in German and Spanish (#6745).

Stage kinds use the partner API block names (`warmUp`, `volume`, `pyramid`, `ladder`,
`gradeFocus`, `onTheMinute`, `fourByFour`, `limitBouldering`; see `docs/partner-api.md`,
"Blocks"). A partner workout is a list of blocks in the same vocabulary, so nothing is
renamed or translated between two lists. The option fields keep the partner field names
too (`intervalSeconds`, `restSeconds`); only the partner's `climbCount` becomes
`numberOfClimbs`. A 4x4 is the exception: its fields name sets and reps (`sets`,
`repsPerSet`, `restBetweenRepsSeconds`, `restBetweenSetsSeconds`), since a set is one
climb done for every rep. The partner `fourByFour` block (`climbCount`, `rounds` and two
rests) is still freeform, and how its fields map onto sets and reps is settled when it runs
natively. `WORKOUT_STAGE_KINDS` lists every kind this bundle knows, and
`isWorkoutStageKind` checks stored data against it.

The three timed kinds are offered in dev builds and to testers with the
`workout-timed-blocks` flag until they launch (see "Timed blocks" below); a release bundle
with the flag off offers warm-up, volume, pyramid, ladder and grade focus.
Their fields: a 4x4 takes 1 to 10 sets and 2 to 10 reps per set (one queue item per set,
so the player never has the same climb on two pages); limit bouldering 1 to 10 climbs; on
the minute 1 to 40. Their rests use
the rest timer's own picker, where Off means no rest for a stage rest and an interval can
never be Off (`RestLengthPicker`'s `allowOff`).

Stage ids are uuids, never positions. Stages get added mid-session and runs get joined,
and a position-based id would collide.

## Where the run lives

The run stays on the phone. `packages/mobile/src/lib/workout-run-store.ts` keeps one
slot, keyed by session id, with the run inside it keyed by queue-item uuid. Nothing is
added to the queue item or the queue's wire format. A copy of the plan also goes to the
server once the workout starts, for the summary, session detail and feed cards (see
"Workouts on the server" below), but the live readout never reads it back.

There is no wire field because a new field on the queue item has three costs that a
phone-side readout does not justify:

- **The field contract.** `packages/backend/src/__tests__/queue-climb-field-contract.test.ts`
  guards every list a queue climb crosses (schema input, Zod shape, operation strings).
  A field missing from one of them flaps: a peer rebuilds the item without it and pushes
  the gap back to the whole crew.
- **Screenshot fixtures.** The recorded backend responses are pinned and checked by
  `screenshot-fixture-drift.test.ts`. A new field means a re-record.
- **Old clients.** An app on an older bundle strips fields it does not know when it
  rewrites the queue, so the stage would vanish the first time an older crew phone
  touched it.

The limits that follow:

- Only the phone that built the workout sees stages while the session runs. A crew
  member's phone shows the same climbs with no "Your workout" card. That is fine: the
  readout is for the climber following the workout. Once the plan is stored on the server,
  the session's own surfaces (summary, detail, feed card) show it to everyone who can open
  the session.
- Ticks carry no stage on the server. The stored workout attributes them instead: its tick
  map names the queue item each tick was logged on, and a tick missing from the map is
  matched by climb and angle (see "Workouts on the server").

## Workouts on the server

Issue [#6903](https://github.com/boardsesh/boardsesh/issues/6903). The phone's run is
enough for the player, but the session summary, session detail, feed cards and later
Strava need the workout after the phone has moved on. So a copy goes to the server.

**What is stored.** `session_workouts`, one row per climber per session (unique on
`(session_id, user_id)`, which also serves reads by session; both foreign keys cascade
on delete):

- `plan` (jsonb): `SessionWorkoutPlan` from `@boardsesh/workout-summary`. Per stage its
  id, kind, `coolDown`, `targetGrade` (difficulty id) and flattened pacing (a 4x4's
  `repsPerSet` and `restBetweenSetsSeconds` sit beside `restSeconds`), and per queued climb
  its queue-item uuid, climb uuid, angle and mirror. The climb fields are captured when the
  run is written, because the queue is gone by the time anyone reads the summary.
- `tick_map` (jsonb): `{ tickUuid, queueItemUuid }[]` from the run's tick log.
- `revision` (int): the phone's per-session write counter.

The kind is any camelCase identifier up to 32 characters (`^[a-zA-Z][a-zA-Z0-9]{0,31}$`),
so a kind newer than the server survives a round trip. Caps:
30 stages, 300 climbs, 4000 tick-map entries, strings up to 64 characters; anything over
is rejected, not trimmed. `parseSessionWorkoutPlan` and `parseSessionWorkoutTickMap`
check the input on write and every stored row on read.

**Who writes.** Only the climber, for their own row, with `recordSessionWorkout`. They must
have created the session or joined it (`board_session_participants`). A tick in the session
is not enough: `saveTick` takes any existing session id, so a tick proves nothing. Tick-map
entries that are not the caller's own ticks in that session are dropped on write. A write
lands only when its revision is higher than the stored one; an equal or lower revision is
a no-op that still answers true, so an outbox replay never rolls a newer plan back. Both
the mutation and the headline query are rate limited. An unknown session and a malformed plan answer `BAD_USER_INPUT` and a stranger
`FORBIDDEN`, which the offline outbox treats as final instead of retrying.

**How results are derived.** Nothing about results is stored. Each read takes the owner's
ticks in the session and runs `deriveWorkoutStages`: a tick in the tick map goes to that
queue item. Any other tick goes to a plan climb with the same climb and angle (and mirror
when both say): the first one in plan order that still has room (a 4x4 climb until it
holds its reps per set, any other climb until it holds one tick), else the last one. So a
climb queued twice fills its first slot before its second. A tick that matches nothing
counts as off plan.
Each climb's reps are its ticks in time order. Every tally counts ticks, the unit the
session totals use: `sent` is flash plus send ticks, `attempts` is attempt ticks, `skipped`
is the block's climbs with no tick. When every tick is on the plan, the blocks' `sent`
add up to the owner's session sends. A tick edited or deleted later changes the result on
the next read, with no rewrite. Mobile runs the same function on its local run and tick
log while the write is still in the outbox.

**What the queries answer.** `sessionWorkouts(sessionId)` gives one workout per climber:
stages with their tallies, climbs with name, grade, frames and the board to draw them on
(resolved like the summary's hardest climb), and the off-plan count. Each climb carries
`tickUuids`, the ticks behind its reps in rep order, and the workout carries
`offPlanTickUuids`, so a client groups the session's ticks under the right block without
guessing by climb and angle. Both list only ticks the viewer may see: they pass through
the same filter as the climbs and tallies.
`sessionWorkoutHeadlines(sessionIds)` gives feed cards one line per workout for up to 50
sessions: the main block's kind and grade, the second main block's kind, the block count
and how many main blocks follow the first. Warm-ups and cool-downs are main only when they
are all there is. Headlines read the plan alone, no ticks. Both are separate from
`sessionSummary`, `sessionDetail` and `sessionGroupedFeed` so the pinned screenshot
fixtures for those documents do not change.

**Privacy.** A workout follows `sessionDetail`. It appears only when the session opens for
the viewer (the same `canAccessResource` rule, nothing for a daily card), its climber is
someone the session's own surfaces name to the viewer (`sessionVisibleUserIds`: a private
account shows to approved followers and fellow members, a climber who stays anonymous on
boards they don't own does not show to strangers), and at least one of the climber's ticks
in the session is one the viewer may see. Inside it, a climb the viewer may not see goes
with all of its reps: a climb that fails the climb half of the tick rule (another
climber's draft, an unlisted climb, a spray climb on a wall they can't open; checked on the
climb itself, so a skipped climb is covered too), or a climb holding a tick the session's
own tick rule hides from them (`sessionTickVisibleCondition` plus the spray tick rule, the
pair the session summary's counts use). A climb goes whole, so a hidden tick never turns a
climb the owner did into one that reads as skipped. A block left with no climbs goes too,
and hidden off-plan ticks stop counting. Headlines apply the same rule for who appears,
batched across the page, but read only the plan. A per-session "Show workout" switch is a
follow-up.

**On the web.** The session page (`/session/[id]`) fetches `sessionWorkouts` on the
server beside the session, signed out like the detail fetch, and refetches signed in. It
shows the viewer's own workout, else the first one stored. The overview gets the headline
("Workout · 4x4 at V4 · 3 blocks") and the Climbs list is grouped: one section per block
with its name, detail line and tally, a 4x4 as one row per set ("Set 1 · 3 of 4" and a
glyph per rep), a planned climb with no visible tick dimmed as "Skipped", then "Off plan"
and the crew. Ticks are placed by the answer's uuids (`tickUuids` per climb,
`offPlanTickUuids`; `assignWorkoutTicks`): a crewmate's go on a planned climb stays with
the crew, and an owner tick the answer doesn't name (logged after it was read) is off plan.
An answer without the uuids falls back to matching the owner's ticks by climb and angle
the way the derivation did. A 4x4 set row lists its own ticks under the reps, for likes,
comments and delete. Feed cards on the web profile
Sessions page ask `sessionWorkoutHeadlines` once per loaded page. The copy lives in
`@boardsesh/workout-summary` (`format.ts`), which takes the caller's `t` over the `session`
catalog: block names, detail lines, tallies, climb outcomes and the headline. Mobile still
has its own copy under `mobile.workoutSummary.*` and can switch to it.

**On Strava.** An exported activity is named after the main block when the session
followed a workout, "4x4 at V4 — 13 sends" (the same sends number as before), and the
description starts with one line per block, "Workout: Warm-up 4/4 · 4x4 V4 9/16 reps ·
Cool-down 2/3": a 4x4 counts reps sent of reps planned, any other block climbs sent of
its climbs. The workout is the exporter's own, else the session creator's (a crew climbs
the creator's queue); either way it is tallied from the exporter's own ticks, and the
creator's tick map is never applied to them. Block names come from the en-US `session`
catalog; the rest of the activity text stays English. Reading the workout is best
effort: a failure exports the session with the board name, as before.

## Store lifecycle

- **Two slots, one run.** A run made only of the original kinds (warm-up, volume,
  pyramid, ladder, grade focus) is stored under `boardsesh_workout_run_v1`; a run with any
  other kind goes under `boardsesh_workout_run_v2`, and writing one slot removes the other.
  An OTA rollback lands on the bundle embedded in the binary by default, and a bundle from
  before the timed kinds passes an unknown kind straight through and crashes in "Add a
  block". It reads only `_v1`, so it never sees a timed run. From this bundle on, a stage
  of a kind the bundle does not know is dropped on read and the rest of the run kept, as
  is a stage's `pacing` it cannot read. A tester's 4x4 stored before sets (its pacing names
  `restBetweenRoundsSeconds`, beside `rounds` and `roundByUuid`) loses its pacing that way
  and its round fields with it: it queued every climb once per round, so read as sets it
  would ask four reps of each of sixteen climbs. Its climbs read as an ordinary block on
  the climber's own rest settings. Timed blocks are tester-only, so nobody else holds one.
  The rollback the other way is why a 4x4's pacing names its own advance rule, `set`. A
  bundle with the round model (#6727 until sets) reads `_v2`, knows only `tick` and `send`,
  and never looks at `sets`: a 4x4 stored on `tick` would pass its check and move the wall
  10 s after the first rep. On `set` it fails that check, so after
  a rollback mid-4x4 the stage loses its pacing and its climbs run as an ordinary block on the
  climber's own rest settings until the newer bundle is back.
- **Hydrate.** `WorkoutRunSessionSync` hydrates the slot when a session id appears, so a
  cold start mid-workout gets its stages back. Both slots are read, `_v2` first, and the
  one naming this session is the run. A stored run for another session misses. A read
  error on either slot leaves the store empty instead of taking the other slot alone:
  that slot may hold only part of the run (see below), and the next write of a part
  removes the other slot, so a slot that failed to read would be lost for good. With the
  store empty a tick is not logged and nothing is written; the next hydrate, which "Add
  a block" runs first, reads both again. When that read fails too (`hydrateWorkoutRun`
  resolves `'failed'`), "Add a block" queues and writes nothing and stays open with an
  error; another tap tries again.
- **Both slots, one session.** That happens only after a rollback mid-session. This
  bundle wrote a timed run to `_v2` and removed `_v1`; the older bundle, which never
  reads, writes or clears `_v2`, then saw no run and stored its "Add a block" alone in
  `_v1`. Neither copy is the whole run, so the hydrate merges them: `_v1`'s stages go
  after `_v2`'s (blocks mint fresh stage ids and queue-item uuids, and a uuid already in
  `_v2` is skipped) and the tick logs are joined: a tick with a uuid is kept once by that
  uuid, and one without is told apart by climb, status and time, so two attempts on one
  climb stay two. Nothing is written back until the next
  write, which stores the whole run under `_v2`, so a second rollback still finds its
  block in `_v1`.
- **Known limit: an older bundle's clears miss `_v2`.** A bundle from before the timed
  kinds clears only `_v1` when a session ends or the account signs out, so a timed run
  stored before the rollback stays in `_v2`. Only a hydrate for that same session id
  reads it, and the next write of any run replaces it.
- **Tick log.** The record also keeps the ticks logged on this phone on the run's climbs,
  by queue item, with their status (`flash`, `send` or `attempt`; `noteWorkoutRunTick`,
  `useWorkoutRunLog`). A tick on a hand-queued climb or for another session is ignored, and
  the tick path leaves out one dated more than a minute before it was logged (see "Which climb a
  tick is for").
  The log keeps the newest 2000 entries, survives "Add a block" (which rewrites the run for
  the same session) and goes with the run. It is how a 4x4 set's reps and a limit climb's
  falls get counted, since ticks carry no queue item on the server
  (`countWorkoutRunTicks`).
- **Clear on session end.** When the sync sees a session id go away or change, it clears
  that session's run, in memory and on disk (whichever slot names it). A hydrate still in
  flight for it cannot land afterwards.
- **Clear on sign-out.** `auth-provider` clears the store, both slots, with the rest of
  the per-user state (see the known limit above for an older bundle's sign-out).
- **No prune.** The run is never trimmed as climbs leave the queue. Undo in the queue
  sheet brings removed climbs back under their old uuids, and they must come back in
  their stage. Readers skip uuids that are not queued, so the stale ones cost nothing,
  and the whole run goes when the session ends.

## Pacing

A timed stage paces the rest timer itself (#5380, #6231): its own rest, its own cadence, and
its own rule for when a finished rest moves the wall. Every other stage, and a climb in no
stage, leaves the climber's own rest settings in charge, exactly as before. The rest timer side
(effective pacing, the advance rules, who may move the wall) is in `docs/rest-timer.md`.

- **What the climb on the wall gets.** `RestTimerPacingSync` (mounted with the rest timer, but
  outside its armed gate) locates the current climb in the run once per queue change, counts
  the ticks the run's log holds for it, and resolves both with `resolveStageRestPacing` into a
  `RestTimerStagePacing`: the stage, the queue item, the cadence, the rest after the climb's
  latest tick (`stageRestSeconds`: the 10 s changeover for a rest of 0, the interval on the
  minute, on a 4x4 the rest between reps until the set's last rep and then the set rest,
  `closesSet`) and the advance rule (`tick` for a 4x4, from its stored `set`; `send` for
  limit; `deadline` on the minute). A 4x4 also carries its rep count (`reps`: logged, capped at the set, and per set), and a rest of 0
  between reps is no rest (`targetSeconds` null): the pill counts up from the rep, and no cue
  plays. It sits in the rest-timer store, never in settings, and is not persisted; the readers
  merge it with the settings through `useEffectiveRestPacing()`. A stage auto-advances, except
  a 4x4 set with reps still to log (`stageHasRepsLeft`).
- **Moving on.** Under `tick` or `send` the wall moves only once the climb on it was logged
  (limit: flashed or sent; a 4x4: every rep of the set), and the fire clears the anchor, so the
  next climb rests only after its own tick. A 4x4 stays on its climb for every rep: a rest
  between reps runs out with the "rest over" cue and the climb stays up, the last rep starts
  the set rest, and only that one moves the wall (`restAdvanceAllowed` with the stage). A 4x4
  never walks on with nobody climbing, and a fall on a limit climb rests and stays on it, with
  the "rest over" cue. On the minute moves on every beat, logged or not. A rep logged during
  the set rest restarts it, as any tick restarts an after-tick rest. A climb the timer already
  moved the wall off never moves it on again on the same tick (`advancedFromQueueItemUuid`,
  docs/rest-timer.md): when a reconnect puts a finished 4x4 set back on the wall, it stays up
  until the climber logs another rep on it or taps Next.
- **Which climb a tick is for.** The tick path (`use-tick-saver.ts`) reads the committed
  current queue item when the save starts (`attributeTickToQueueItem`): a tick counts for it
  only when it is that climb's, at the angle the climb is up at (the queue item's
  `climb.angle`, which the queue keeps on the board's angle and lighting reports as the
  wall's). The status and queue item go to the rest timer (`lastTick`) and to the run's tick
  log. A tick on any other climb, or on this one at an angle picked in the ascent form, counts
  for no queue item: it still saves, and leaves the rest timer's last tick as it was, since it
  says nothing about the climb on the wall. So does any tick when the queue item carries no
  angle. Nor does a tick dated more than a minute back ever earn an advance, whatever it is on
  (docs/rest-timer.md, "Effective pacing"), and it stays out of the run's tick log, so it is
  never a 4x4 rep or a limit try either: yesterday's send of the climb on the wall, logged with
  the date picker, would otherwise close the set one real rep early. That is judged when the
  climber logs it, so a go whose save is slow still counts, and the rest timer is handed the same
  instant, so that go also earns the set rest's advance (docs/rest-timer.md has the crew
  exception). A save started on the previous climb keeps that
  climb's queue item when it finishes after the advance, but it never replaces a tick the new
  climb already has, so the new climb still moves on at its rest.
- **A stage change on a running timer** (`planRestTimerPacingTransition`). An on-the-minute
  stage starting, or changing interval, starts its beat at that moment, so its first climb gets
  a whole interval. A new climb of a `tick` or `send` stage, or on the minute ending, clears
  the anchor: the rest waits for the next tick. A paused timer takes the change too, so Resume
  starts a fresh rest instead of carrying the last climb's into the new stage: the first climb
  on the minute still gets a whole interval.
- **Arming.** "Start workout", and "Add a block" in a workout already started, arm the timer when the workout (for a mid-session
  block: the block) has a timed stage and the timer is off (`armRestTimerForWorkout`), so a
  timed block runs hands-free. A timer the climber already set up is left alone, and arming
  still never survives a cold start.
- **Logging every go.** While the climb on the wall is in a timed stage, the player's small row
  is one-tap Fell / Sent (`docs/climb-view-options.md` › One-tap Fell / Sent). Fell logs a 1-try
  attempt at once; Sent logs a flash or a send, and the tapped button says so for a moment (the
  player hides root toasts on iOS). Both reach the rest timer and the tick log through the same
  tick path as the sheet, and a save still lands there when the row is gone before it settles. A tap within 2 s of the wall moving on (an on-the-minute beat) logs for the climb it
  left, against that queue item.
- **The sheet.** While a stage paces the timer, the rest timer sheet and the Record tab's arm
  row show "Set by your workout" (`RestTimerWorkoutPacingRow`: the stage, its rests and how it
  moves on) in place of the rest length, cadence and auto-advance controls, which edit the
  climber's own settings. Pause, Reset and Turn off stay.
- **Crew.** Stage pacing lives on the phone that built the workout. In a crew only the phone
  holding the wall moves it (`docs/rest-timer.md`), stage or not; a passenger's sheet says so.
  The builder's phone hands each stage's pacing to the session's shared rest clock (#5382) as
  the climb on the wall changes, so every phone, the holder's included, counts that stage's
  rest and waits on its rule; if the builder's phone sleeps, the crew keeps the last pacing it
  sent. The crew clock counts no reps, so a 4x4 set reaches it as the `tick` rule with
  auto-advance off until the builder's phone logs the set's last rep, then the set rest with
  auto-advance on, once only (`autoAdvanceOnce`, `stageAdvancesOnce`; Marco, 2026-10-25): the
  server's FIRE at the end of the set rest moves the wall and turns auto-advance off, so the
  crew moves on once per set. A holder without the run never moves the wall mid-set; the
  builder's phone, when it holds the wall, also checks the count itself. If the builder's
  phone sleeps after a set's last rep, the wall still moves on once at the end of the set rest
  and then waits: the next climb stays up through its reps until the builder's phone sends the
  next set, or someone taps Next. A restart of the set rest keeps it once-only; the next set
  and the next block never carry it (docs/websocket-implementation.md, "The mobile client").
  A workout started over a crewmate's running clock takes it over on its first paced
  climb: on the minute the beat starts then, a tick or send rule waits for the climb's tick.

**The runner** (#6291). The Record tab's "Your workout" card runs the workout without a
separate engine: it reads the queue, the run, the run's tick log and the rest timer through
`useWorkoutRunner`, which feeds the pure `describeWorkoutRunner`
(`lib/workout-runner-readout.ts`). Any other runner surface reads the same hook, so they all
agree on these points:

- **Phase.** `climbing`; `resting`, when the current climb's stage paces the timer, the timer
  is armed with a rest to count from (paused counts), and its last tick was on the current climb;
  between two reps of a 4x4 with no rest between them there is none, so it reads `climbing`;
  or `done`, when the climber is past every staged climb, or on the last one and it met its
  stage's rule (sent on limit; every rep logged on a 4x4; on the minute, logged, or its last
  beat ran out with nothing after it, which latches `queueEnded`; logged anywhere else). The rest is the store's
  `stagePacing`, the value the timer runs on, and whether it moves the wall is the scheduler's
  own rule: this phone may move it (`useSessionTimerDriver().canAdvanceQueue`) and
  `restAdvanceAllowed`. After a fall on a limit climb it reads "Then try again", and between two
  reps of a 4x4 "Then rep 3 of 4" (`nextRep`); on a crew phone
  that does not hold the wall it says only the climber driving the wall moves the queue, and
  "Turn on" promises only to time the rests. A beat that found nothing to move on to stops the
  clock, and the last climb on the minute counts down to "Workout ends in".
- **What the card shows.** Where the current climb sits ("4x4 · Rep 3 of 4 · Set 2 of 4", and
  "· Try 3" on a limit climb, in the player's subtitle too; `current.go`) over the climb itself,
  which opens the player. A paced stage adds the rest line (the `RestTimerClock` leaf, then the
  next climb, "Set rest" after a 4x4 set's last rep) or, with the timer off, "Rest timer off ·
  Turn on" (`armRestTimerForWorkout`). The rest
  line is one element to a screen reader ("Set rest. Rest timer, 2:58 left. Then Crimp City",
  the overrun in words through `restTimerClockAccessibilityLabel`), so it is a leaf that reads
  the live display; nothing above it re-renders per second.
- **Over the board.** The player reads the same hook for the climb on the wall
  (`WorkoutRunnerOverlay`, mounted only with a run, so a crewmate without it sees nothing; a
  preview, the end-of-list card or the switch-board gate hides it until the climber is back on
  the climb on the wall). A solo swipe is not a preview: it moves the wall, so the rest ends as on
  Next (a tick or send stage's new climb rests from its own first log), and swiping back finds no
  rest and no card until the next go. In a crew a swipe is a preview, and the card comes back on
  the way back. While a timed
  block's rest runs (phase `resting`), a compact rest card sits low on the board, just above the
  Reset zoom corner so that control stays in view and tappable, its wording from the pure
  `resolveWorkoutRestCard`: what the rest is ("Set 2 done", "4x4 done", "Rest", "Next climb
  in"), the `RestTimerClock`, and what follows ("Next: Crimp City · V5", "Next: Limit
  Bouldering", or back on the same climb "Then rep 2 of 4 · Set 1 of 4" and "Then try again ·
  Try 3"). A screen reader hears it as one sentence, with spoken lines of its own where the
  visible ones join facts with "·" or shorten "rep" ("Next: Crimp City, V5"). It is not modal:
  the board, its swipes and Fell / Sent stay live, and it never takes screen-reader focus. A rest
  that keeps the climb up offers Go now, which only hides the card until the next go; the card
  also goes once that rest has run out (the clock's `exceeded` phase), since the climber is on
  the next go and nothing else would take it away. A rest that moves the wall offers Skip rest on
  an after-tick block (never on the minute, whose beat is the block) on the phone that may move
  the wall (`canAdvanceQueue`), and only where the tap would move it: `restSkipAllowed`, asked
  in render with the effective pacing (a crew clock wins over the stage, so a crew clock on the
  minute, one whose rule this go does not meet, or one this app cannot run offers none). Skip
  rest is the scheduler's own local advance with now as the deadline (`skipRestOnWall` in
  `lib/rest-timer-skip.ts`): the same check asked again against the climb on the wall at the
  tap, the cycle claimed before `nextClimb`, the climb remembered as moved off, so the wall moves
  once and the crew clock waits for the next tick. A paused rest ("Timer paused") skips too, and
  the pause goes with it: the timer resumes before the advance, so the next climb starts as after
  a rest that ran out rather than frozen on the old rest's seconds (a crew clock's CLEAR keeps a
  pause, so the crew hears RESUME first). A crew phone that does not hold the wall says
  whose phone moves it instead of naming the next climb. Untimed blocks get no rest card,
  whatever the climber's own rest timer does: the readout has no rest for them, and the pill
  already counts it. When the workout turns `done` while the player is up, "Workout done" opens
  over the board, modal in the end-of-list card's pattern (focus on the title, Android back
  closes it), with this phone's sent, tried and skipped (`totals`; "Nothing logged on this
  phone" instead of three zeros), See your workout (the Record tab) and Done. It opens once per
  run, never on a player that opened on a workout already done, and waits while the climber
  looks at another climb. Whether it is up is one answer for the whole app
  (`lib/workout-done-card-store.ts`), not each player's: a tablet keeps a play pane per tab, all
  of them show the one card, and Done, the scrim, Android back or See your workout closes it on
  every pane (See your workout closes it first, since the pane stays up beside the Record tab).
  It closes with the last player to unmount, so the phone's player opened again on a finished
  workout never finds it up.
- **Next** is what Next lands on (`selectNextQueueItemWithSuggestions`, with the scheduler's
  board rules), so a list the climber is walking counts. `startsStage` marks the boundary.
- **Outcomes.** Every queued staged climb is `sent` (a flash or send logged on it; on a 4x4,
  on any rep of the set), `tried` (ticks but no send), `skipped` (the current climb is past it
  with nothing logged) or
  `upcoming`, per stage (`climbs`, `tally`). One exception: a climb opened from a list or
  search goes in right after the climb on the wall, so with an off-plan climb up, the staged
  climb just before it is the one the climber left. With nothing logged on it, it stays
  `upcoming`, not `skipped`, until the climber moves on in the workout. A finished stage with anything logged on it
  (`logged`) shows its tally in place of the climb count; one passed with nothing logged keeps
  the count, since its climbs may have been logged elsewhere. `totals`, which "Workout done"
  carries, add up the `logged` stages only, by the same rule.
- **Off the plan.** When the climb on the wall is in no stage (Start ran while another climb
  was up, or the climber wandered off), the card offers "Start your workout" (or "Back to your
  workout"): it puts the first `upcoming` staged climb on the wall (the one the climber left,
  if nothing is logged on it) and stops walking any list.
- **Limits.** Outcomes come from this phone's tick log, so a tick logged on another device, or
  deleted later from the session detail, is not reflected. Tries and reps count ticks, so one
  tick saying "3 attempts" counts as one try, or one rep. A tick dated back with the date picker
  onto the climb on the wall counts as a rep too; it never moves the wall by itself (the last
  tick that does has to be fresh), but it can be the set's last.

## Building a workout

**Before Start.** The Record tab shows the workout as a list of block cards, and it
starts empty: no blocks means no workout, and the climber picks every climb. "Add a
block" appends a workout block at the last workout block's grade, with the next type. A
card's type chips turn any block into a warm-up or another workout type. A workout card
holds its target grade and counts; a warm-up card holds its length and names the block
it ramps to (`warmUpTarget`). After the last workout block it names the block it eases
off from instead (`coolDownSource`), and the preview heads its climbs "Cool-down". A
warm-up with no workout block on either side says it needs one. Any block can move up or down or be removed. The cap is five
blocks, warm-ups included (`MAX_WORKOUT_BLOCKS` in `workout-blocks.ts`).
A ladder block has a "Hardest first" switch (`descending` on `LadderOptions`): the steps run from the target grade down, the first step is the peak and the rest are decreasing, and a warm-up before it still ramps to the target grade.

Every block, warm-ups included, has its own climb filters, in a folded "Climb filters"
disclosure under the block's fields (`WorkoutBlockFilters`, rendered by
`WorkoutBlockFields`, so the mid-session sheet gets it too). The first block starts on
the generator defaults; "Add a block" copies the last block's filters; changing a
block's type keeps them. A closed card whose filters are not the defaults ends its
summary line with "· filtered". A board without smaller sizes turns tall/wide off on
every block.

The preview stamps every slot with its stage's filters and fetches one pool per grade
and filter set (`workout-preview-pool.ts`, `poolKeyForSlot`). Blocks with equal filters
share a pool at each grade; a block with its own filters gets its own pool even at a
grade another block uses. Signed out, climb bias and the two skip switches never reach
the search, so bias is set to `any` and `skipSent` and `skipTried` dropped in the pool key
(`fetchFilters`), and blocks that differ only in those share a pool; the run still records
what the climber picked.

Every pool at a grade is sized for all the slots at that grade, not only its own. Two
filter sets at one grade mostly return the same top-quality climbs: a V5 x20 block on
the defaults beside V5 x20 and x15 blocks on stricter filters would otherwise fetch 50
and 50 near-duplicates for 55 slots and leave about five empty. One used-climb set spans
every pool, so a climb two pools both return still fills one slot. A row refresh draws
from, and refetches with, its own slot's filters, and its refetch is sized past every
row at the grade.

An edit on the same board and sign-in reuses what the preview already has: a pool
whose key is still in the plan and was fetched for at least the demand it needs now is
kept, so one filter tap fetches only the changed block's pools, and a block whose
settings and filters did not change keeps its rows (same climbs, same queue-item
uuids) while their climbs still fit its pools. A board or sign-in change, and the
public `regenerate`, start fresh. Start creates the session, queues the reviewed
preview without taking the wall, and stays on Workout. The saved run carries
`pendingStart: true` until the climber taps **Start workout** in the floating timer
pill or the workout card (also available on iPad). Reopening the app keeps the
workout prepared; an older record without the marker keeps its existing behavior.
Adding a block preserves the marker and does not arm workout pacing.

Start workout opens the first remaining staged item in current queue order,
reusing its queue-item uuid, and then starts its pacing. On the minute gets a full
first interval; after-tick pacing waits for the climb's own tick. A failed player
open leaves Start available for retry without touching the timer. Manual or remote
climb selections never consume preparation. Existing personal or crew clocks keep
running while the workout is prepared, but its stages cannot take over pacing.
If every workout climb leaves the queue, the pill stays disabled with its space
reserved and the card offers Add a block.

**During a session.** The "Your workout" card has an "Add a block" button. A session
without a workout shows one row, "Add a workout block", in the same spot, so a session
started without the generator can turn into one. Both open `AddWorkoutBlockSheet`, a
`ModalSheet` over the session screen:

- It offers the workout types only, never a warm-up: mid-session the climber is already
  warm, and the sheet plans its one block alone, where a warm-up plans no climbs.
- The block opens on the run's last workout stage: same type, same target grade. With no
  run it opens on volume at the board's middle grade. A last stage of a type the sheet
  has no chip for (a timed block, read after a rollback to a bundle that does not offer
  them) opens on volume at that stage's grade.
- Its climb filters open on the last stage in the run that kept any, warm-ups included
  (`defaultMidSessionFilters`). Tall/wide are turned off on every render where the
  board has no smaller sizes, from the filters the climber asked for, so a board that
  loads or changes while the sheet is open switches them back on or off. A run with none (none yet, or stored before stages kept filters) opens
  on the generator defaults. The added stage keeps the filters the climber left.
- It reuses the pre-session pieces: the block card's fields (`WorkoutBlockFields`, given
  the workout types as `blockTypes`), the preview hook, the summary with Shuffle. The
  preview passes over climbs already in the queue while the pool has others.
- The preview lists every climb of the block with the Record tab's rows
  (`WorkoutPreviewListRow`): thumbnail, refresh button, and section headings, so a
  pyramid shows its way up and down. The rows sit in a `BottomSheetFlatList` whose header
  holds the fields and the summary. Tapping a row does nothing here, because the play
  drawer would open under the sheet. Only the refresh button responds, and it and Shuffle
  hold while "Add to session" runs. A refresh passes over climbs already in the queue,
  like the build does.
- "Add to session" appends the climbs to the end of the queue with no
  `activateFirstWhenIdle`, the same way the playlist "Add to queue" row does, so it does
  not move the wall on this phone. Then the block's stage is appended to the run (or
  becomes the run). That holds after a cool-down too: the new block lands after the
  cool-down, which keeps its "Cool-down" name, and the climber drags the cool-down
  climbs below the block to finish on them. Slotting the block in front of the cool-down
  would need a positioned insert the queue does not have: a per-item add carries no
  position and the server appends. Climbs cut by the queue's size cap get no stage; a
  climb whose wire send fails afterwards keeps its stage, which is harmless because
  readers count only queued climbs. A climb already in the queue (by queue-item uuid) is left
  out; a second tap during the slide-down does nothing. The pure part is
  `add-workout-block.ts`.
- Before it composes the run, the confirm waits for the store to finish reading this
  session's run after a cold start, so the run queued at Start is never overwritten.
- `Session Queue Generated` fires with `phase: 'in_session'`. Start sends
  `phase: 'pre_session'`. The event now fires once per mid-session block too, so
  "workouts generated" insights should filter on `phase = pre_session`.
- The append goes through the same queue path as Add to queue, so it reaches the crew
  and behaves the same offline. It shares that path's known limit: in a crew session
  with a climb on the wall, the append writes the whole queue with this phone's current
  climb, so a crew member's wall change that has not reached this phone yet can be
  reverted.

### Timed blocks

On the minute, 4x4 and limit bouldering are offered in dev builds and to testers until
they launch: `timedWorkoutBlocksOffered(flagEnabled)` in `workout-blocks.ts` is
`__DEV__ || flag('workout-timed-blocks')`. The flag is a positive rollout flag in the
mobile catalog, off by default and listed on the tester Feature Flags screen (see
`docs/feature-flags.md` → "Mobile flags"), so a release bundle, and with it every OTA,
shows the five chips climbers have today unless PostHog or a tester's override turns it
on. Screenshot mode runs dev builds too (the store captures, the E2E smokes), so there the
flag is ignored and the timed chips show only when `EXPO_PUBLIC_SCREENSHOT_WORKOUT` names a
timed type, and the store shots keep today's chips. `workoutBlockTypes(offered)` is the
block card's chip list, `addBlockTypes(offered)` the mid-session sheet's; both are pure, and
`WorkoutBlockFields` and `AddWorkoutBlockSheet` read the flag with
`useWorkoutTimedBlocksFlag` and hand it in. The launch removes the flag and the gate. The Record tab's "Add a block" never steps onto a timed type
(`nextBlockType` cycles the four untimed ones), so a timed block is always picked from its
chip. The mid-session sheet opened after a timed stage opens on that type where the build
offers it, and on volume at the stage's grade where it does not (`defaultMidSessionBlock`).

- **Preview.** A 4x4 previews one row per set, under a heading that says each row is done
  for every rep: "4x4 · 4 reps × 4 sets". `buildPreviewListRows` gives a 4x4 its heading
  even when it is the only block. The summary line counts the queue Start hands over (4 for
  the default 4x4), and for a workout with a timed block adds "about N min"
  (`estimateWorkoutMinutes` in `plan-summary.ts`): 45 s a try plus the rest the stage paces
  after it (`stageRestSeconds`, so the 10 s changeover counts), one interval a climb on the
  minute, every rep of a 4x4 set with the rests between them and then the set rest (the
  default 4 reps × 4 sets with 3:00 between sets reads "about 20 min"), three tries a climb
  where the stage moves on only after a send (3 × (45 s + rest), since the rest timer starts
  after every logged try, falls included, so the default limit block of 3 climbs at 3:00
  reads "about 30 min"), and two minutes a climb for a stage with no pacing of its own; no
  rest after the last climb; whole minutes under 10, then fives. An untimed workout gets no
  figure, since its length is the climber's own rests.
- **Start.** `toStagedQueueItems` (`stagePreviewQueue` in `workout-start-queue.ts`) queues
  each row once, under the row's own queue item, a 4x4's sets included. The queue's
  500-climb cap applies, and a climb it cuts gets no stage. "Add to session" queues a 4x4
  block the same way.
- **Arming.** Start and "Add to session" turn the rest timer on for a timed block (see
  "Pacing").
- **Analytics.** `SessionQueueGenerated.savedCount` counts the climbs queued, one per 4x4
  set. `failedCount` counts the planned slots with no climb, and is never negative.

### Borrowing from nearby grades

Issue [#6232](https://github.com/boardsesh/boardsesh/issues/6232). A slot whose grade has
no climb left takes one from a nearby grade instead of staying empty. `BORROW_GRADE_STEPS`
(`workout-preview-pool.ts`) is the order: one grade easier, one harder, two easier, two
harder. The steps walk the board's grade scale (`getGradesForBoard`) by position, since
MoonBoard and Woods skip difficulty ids. A borrowed climb keeps every filter of its slot
(Skip what I've sent, Skip what I've tried, Benchmarks only, min ascents and stars,
tall/wide), so borrowing never undoes a choice the climber made. A slot with nothing
nearby either stays empty and the shortfall shows as before. With top-ups ("Sent climbs and
benchmarks" below) a grade rarely runs short on the default filters; the skip switches and
Benchmarks only are what usually bring it here.

- **Picking.** `selectItemsFromPools` takes the grade scale. Kept rows go first, then every
  slot at its own grade, then one step at a time across every slot still empty, so each
  short slot gets the nearest grade before any slot takes one further away. At the planned
  grade a climb already in the live queue (mid-session) still beats borrowing. At a nearby
  grade it is the last resort: the steps run once for climbs that are not in the queue,
  then once more for a queued one, so a fresh climb two grades away beats a queued one
  next door, and a queued one still beats an empty row. One used-climb set spans every
  pool, so a borrowed climb never fills a second row, and the slots planned at a grade
  take its climbs before a neighbour borrows any. Rows keep plan order, stage and section.
- **Searching.** `borrowForShortSlots` runs between `buildPoolsReusing` and the final
  pick. It reaches one step further at a time. At each reach it fills the plan from the
  pools it has, using no step past that reach and no queued climb at a nearby grade, and
  for each slot still empty searches the nearest step whose pool can still grow, with its
  filters, sized by the slots planned at that grade or already taking from it plus the ones
  still short. So a slot searches one grade easier before a pool another block fetched one
  grade harder, or two away, can fill it. A plan that fills at its own grades sends no extra
  request. A nearby pool is searched again when slots still come up short there and its
  last search found more climbs, so a grade that blocks on both sides borrow from grows for
  both (a 40-climb block at 16 and one at 18 with every climb at 17: 17 is searched for 40,
  then for 80). It is never searched once it is read out (`exhausted`) or a search found
  nothing more, and a rebuild reuses it under the same rule as the plan's own pools, so
  editing another block does not search it again. A nearby search that fails is skipped
  (the next step can still fill the slot), never fails the preview, and is sent again by the
  next rebuild, the way a short plan pool is: remembering it would leave the block short
  after one network blip until Regenerate. A superseded build stops between steps.
- **Search budget.** `MAX_BORROW_SEARCHES_PER_BUILD` caps a build at 6 nearby searches,
  nearer steps first; a pool reused from the previous build costs none of them, so the next
  rebuild picks up the steps the cap left. Once the cap is spent, a short slot can still take
  a pool the build already has one step further out rather than stay empty. A thin grade
  reads one page per search tier, three tiers under the default Unfamiliar bias signed in,
  so the borrow pass sends at most about 18 requests a build on top of the plan's own pools.
  The search allows 120 a minute (`search-climbs`), shared with the climb list. One block
  whose filters leave every nearby grade thin costs up to 4 searches, about 12 requests,
  each time its filters change; past the limit the plan's own pool search fails and the
  preview shows its error toast.
- **Rows.** For a borrowed row `PreviewItem.slot.grade` is the grade the climb came from,
  and `borrowedFrom.plannedGrade` the grade planned. The row says "V4 for V5" under the
  climb, and its spoken label says it too. When both grades read the same in the climber's
  format (4a, 4b and 4c are all V0, 5a and 5b both V1), both labels add the Font grade
  ("V0 / 4B for V0 / 4A"), as the grade rail's chips do (`borrowedGradeLabels`).
- **Refresh.** A row refresh tries the planned grade first (its cached pool, then one
  refetch unless the pool is read out), then the nearby grades in step order the same
  way, for a climb not in the queue, then a queued climb at the nearest grade that has one.
  It never takes a climb another row shows, since Start would queue it twice: when no grade
  it may use has one left, the row keeps its climb and its caption, and a toast says every
  climb that fits the row is in the workout already. Refreshes search each pool again at
  most once until the preview rebuilds (`refetchedPoolKeys`), since a second search brings
  back the same climbs, so tapping that row again sends no request. A borrowed row whose
  planned grade has a climb free again goes back to it. A refresh no longer refetches a
  pool that is read out, at any grade. Shuffle borrows again from the pools it has, with no
  request.
- **Summary and Start.** `summarizePlanFill` counts `substituted`: filled slots whose grade
  differs from the planned slot with the same index. The card under the summary line says
  how many climbs came from a nearby grade, above the shortfall line when slots are still
  empty, and the grade span covers the grades the climbs are at. Start queues exactly the
  rows on screen, borrowed ones included, under their planned stage. `Session Queue
  Generated` carries `substitutedCount` on both Start and Add to session. The shortfall
  line says how many climbs were found. The card's lines sit a fiftieth of a point under
  the footnote line height (`NOTE_LINE_HEIGHT_SLACK`): deep in the session screen Yoga's
  float rounding gave a two-line note a 35.9999 pt frame, and iOS then drew one clipped line
  over an empty one.
- **Screenshot captures borrow nothing** (`borrowScaleFor`). The pinned fixture set has no
  answer for a nearby grade's search, nor for the stats of the climbs it would show, where
  a recorded grade came back short (Woods, and MoonBoard at the recorded grade). Remove
  that line and re-record the set to show borrowed rows there.

### Sent climbs and benchmarks

Issue [#6232](https://github.com/boardsesh/boardsesh/issues/6232). Under the default
Unfamiliar bias a pool takes the climbs you have not tried first and tops up with the ones
you have tried, then the ones you have sent. `fetchGradePool` (`select-climbs-for-plan.ts`)
reads the filters' search tiers (`searchTiers`) in order, each returning everything the one
before it does and more. The tiers live in one table, `SEARCH_TIERS_BY_BIAS`
(`workout-search-tiers.ts`), so a later preference is one more row or column there. The
first tier reads up to the pool's target (every slot at the
grade plus 10, at least 50), as the one request always did. A later tier is read only while
the pool holds fewer than every slot plus 10: the 50 floor is refresh headroom, and the
first tier's climbs already give a row somewhere to go.

| Climb bias           | Tiers, best first                                                                                               | With Skip what I've sent                                | With Skip what I've tried                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unfamiliar (default) | never tried (`hideAttempted` + `hideCompleted`), then tried but not sent (`hideCompleted`), then sent (no flag) | the first two                                           | never tried only                                                         |
| Attempted            | tried (`showOnlyAttempted`), one search as before                                                               | tried, not sent (`showOnlyAttempted` + `hideCompleted`) | does not apply; the switch is off and says why                           |
| Sent                 | sent at this angle (`showOnlyCompleted`), one search                                                            | does not apply; the switch is off and says why          | does not apply; the switch is off and says why                           |
| Liked                | hearted, at any angle (`onlyFavorited`), one search                                                             | liked, not sent (`onlyFavorited` + `hideCompleted`)     | liked, never tried (`onlyFavorited` + `hideAttempted` + `hideCompleted`) |
| Any                  | every climb (no flag), one search as before                                                                     | not sent (`hideCompleted`)                              | never tried (`hideAttempted` + `hideCompleted`)                          |

Sent and Liked came later ([#6739](https://github.com/boardsesh/boardsesh/issues/6739)); see
"Climbs you've tried, sent or liked" below. Tried but not sent is the Attempted row with Skip
what I've sent, not a bias of its own.

A climb a later tier adds is a top-up, named in the pool's `topUpTiers` with the tier it
came from. A pool is shuffled within each tier (`shuffleByTier`), on the first build and
on Shuffle, so the rows walk the unsent climbs first and take a sent one only when the
pool has nothing else. A row refresh picks from the earliest tier that still has a free
climb.

**Marks on top-ups.** A preview row reads its sent mark from the logbook, which the
preview never loads for its own rows, so a sent top-up whose ticks no other screen had
loaded showed no mark. The tier a climb came from already says what it is: a climb the
"tried but not sent" search added is tried, one the last Unfamiliar search added is sent.
Each tier in the table carries that (`adds`), each preview row gets it as
`PreviewItem.knownStatus` (`tierAscentStatus`), and the row draws it
(`ClimbListItemContent`'s `knownAscentStatus`) until the logbook has a status for the
climb, which then wins. No request is added. Two limits: a sent top-up shows the send mark
even if it was a flash, until its ticks load; and a board that mirrors keeps to the
logbook, since the search names no direction. A tier that does not pin the climb down
(Attempted's "tried", which may also be sent) marks nothing.

- **Default change.** Unfamiliar used to hide every climb you had tried or sent, so a
  grade you had climbed out came up short. It is now a preference: those climbs fill in
  after the new ones. Attempted and Any are picked on purpose, so they send the one
  search they always did, sent climbs mixed in.
- **Skip what I've sent** (`skipSent`) keeps only searches with `hideCompleted`, so a
  grade you have sent out shows a shortfall instead of sent climbs. It reads your
  logbook: signed out the switch is disabled and says why, and the fetch drops it.
- **Skip what I've tried** (`skipTried`) keeps only searches with `hideAttempted` and
  `hideCompleted`, so a flash block never tops up with a climb you have tried, now that
  Unfamiliar is a preference. It wins over Skip what I've sent, and the closed filters line
  shows "Skip tried" in its place. Under Attempted it cannot apply: the switch is disabled
  and says why, and the fetch drops it (`fetchFilters`). Signed out it behaves like Skip
  what I've sent. Optional and left off when off, like the others.
- **Benchmarks only** (`onlyBenchmarks`) adds `onlyBenchmarks: true` to every tier and
  never falls back to other climbs. It needs no account. It is hidden on spray walls,
  Woods, SoILL and Touchstone, which have no benchmarks, except while it is on, so a block
  brought over from another board can still turn it off. Benchmarks are scarce: a median of 10 per grade on
  Kilter layout 1, 13 to 41 on Tension and 28 to 65 on MoonBoard (the catalogue counts
  in [#6719](https://github.com/boardsesh/boardsesh/pull/6719),
  `docs/workout-catalogue-depth.md`), so a 20-climb block shows a shortfall on most boards.
- **Kilter rows that are not benchmarks.** The server's `onlyBenchmarks` was
  `benchmark_difficulty > 0`, which is true for NaN in Postgres, and NaN maps to no
  benchmark on the row. Kilter's stored stats hold NaN for many climbs: the filter counted
  45,327 benchmarks on layout 1 at 40° (size 10, sets 1 and 20) against a few hundred real
  ones, and a 20-climb V6 block got one benchmark. The server now also requires
  `<> 'NaN'` (`createClimbFilters`, tested in `benchmark-climbs-search.test.ts`), and the
  offline search requires a stored number (`typeof … IN ('integer', 'real')`), since SQLite
  ranks TEXT above every number the way Postgres ranks NaN. MoonBoard and Tension were never
  affected. Against a server from before that fix the workout still copes:
  `fetchGradePool` drops every row that is not a benchmark (`isBenchmarkClimb`, the
  ribbon's own test) and reads on within the usual page bound, and Benchmarks only sorts by
  ascents instead of quality (`BENCHMARK_SORT`). Benchmarks are among the most repeated
  climbs of their grade (119 of Kilter layout 1's 122 rank in the top 150 by ascents, 1 by
  quality), so they come up inside that bound, and a looser Min ascents keeps every climb a
  stricter one found. Sorted by quality, the leaked rows came first: QA found 10 benchmarks
  at 100+ ascents, 5 at 5+ and none at 1+ on Kilter V4.
- **Requests.** Every search shares the climber's 120-a-minute SearchClimbs budget with the
  Climbs list. A grade the first tier fills costs one request, the same one as before: a
  switch that is off adds no key, so the screenshot fixtures still replay it. A short
  grade costs one more request per tier it reads, each paged the usual way. A top-up tier
  that fails keeps what the earlier tiers found; a failing first tier fails the preview as
  before. Screenshot captures read the first tier only: the pinned fixture set has no
  answer for a second tier where the first came back short (Woods, and MoonBoard at the
  recorded grade). Remove that line and re-record the set to show top-ups there.
- **Short pools are searched once.** A pool whose last tier ran out holds every climb its
  grade has under its filters (`GradePool.exhausted`, kept per pool key in
  `exhaustedPoolKeys`). A rebuild reuses it whatever the demand, so a thin grade, a
  Benchmarks only block or Skip what I've sent do not search again each time another
  block changes. A pool is never marked so when a tier failed, the fetch stopped early,
  or a request went out offline (the empty offline answer says nothing about the grade):
  those are fetched again when they come up short, as before.
- **Superseded builds stop.** Every fetch carries `isCurrent`, false once a newer build
  or the debounce has moved past it. `fetchGradePool` checks it before each request, so
  quick edits do not send the top-up tiers of builds nobody will see, and a row refresh
  that is superseded mid-fetch leaves the cached pools alone.
- **Stored filters.** `skipSent`, `skipTried` and `onlyBenchmarks` are optional and left off when off. Filters stored
  before them still read (`isStageFilters`), the default filters, pool keys and preview
  keys are what they were, and an older bundle that reads a stored `true` ignores it.
- **Defaults stay global.** `minAscents 5` and `minRating 2` are unchanged; the
  measurement behind that is in
  [#6719](https://github.com/boardsesh/boardsesh/pull/6719) (`docs/workout-catalogue-depth.md`).
- **The closed filters line.** While Climb filters is closed, its line (min ascents,
  stars, climb bias, then Skip sent and Benchmarks when on) sits under the title and
  wraps across the card. Beside the title on one line it cut off at "Skip…" on a 393 pt
  phone, in English, before Benchmarks could show.

### Climbs you've tried, sent or liked

Issue [#6739](https://github.com/boardsesh/boardsesh/issues/6739), its first slice. A
training plan often wants climbs you already know: rehearsed problems on the minute,
projects for a sending day, a list you scouted last session. Climb bias now offers
**Sent** (`sent`) and **Liked** (`liked`) next to Attempted, so a block fills from your
own climbs at its grade. Each is one more row of `SEARCH_TIERS_BY_BIAS` (table above);
the fetch, the pools, the preview and Start are unchanged.

- **What each one reads.** Sent is `showOnlyCompleted`: a flash or send tick at this
  angle, the same test the logbook's sent mark uses, so every row it finds carries the
  sent mark before its ticks load (`adds: 'send'`). Liked is `onlyFavorited`: a heart
  belongs to the climb, not an angle, so a climb liked at 40° fills a block at 25° when
  it has a grade there. Both work offline on a downloaded board: the local search answers
  `showOnlyCompleted` from the synced ticks and `onlyFavorited` from `user_favorites`,
  once the phone's user data is this climber's (`canServeSearchLocal`).
- **No crowd floors under Sent and Liked.** Both are lists you made by sending or
  hearting (`biasDropsFloors`, the table's `dropsFloors` column), so min ascents and min
  rating do not apply: `fetchFilters` sets both to 0, which the search reads as no floor,
  and the block's filters hide those two rows while one of them is picked. A climb you
  scouted on a spray wall with two ascents still fills the block. The stored values are
  kept, so switching to another bias brings them back. Tall, wide and Benchmarks only
  still apply.
- **Attempted is unchanged.** It keeps the block's min ascents and min rating and sends
  the one search it always sent, byte for byte, so a stored run's Attempted stage and the
  "Add a block" defaults behave as before. Only Sent and Liked drop the floors. Tried but not sent is Attempted with Skip what I've sent (`showOnlyAttempted` +
  `hideCompleted`), floors and all. A sixth chip for it would send that same request under
  a second name and a second pool.
- **Skip switches.** Neither fits Sent, so both are disabled there and say why
  (`biasCanSkipSent`, `biasCanSkipTried`), and the fetch drops them. Under Liked both
  narrow the list: Skip what I've sent leaves the liked climbs you have not sent yet.
- **Thin lists.** A list holds what you have climbed or hearted at that grade, often a
  handful. A short one shows the usual shortfall line ("Found 3 of 10 climbs"), and the
  line under the chips says the block takes only the climbs you have sent or liked, so a
  short or empty preview explains itself. The pool runs out on its one search, so it is
  `exhausted` and a rebuild reuses it instead of asking again.
- **Signed out** there is no logbook or heart to read: every bias falls back to Any, as
  Unfamiliar and Attempted always did, with the floors applying. The chips show Any picked
  and every other bias off (`biasNeedsSignIn`), the closed filter line names Any, and the
  line under the chips says why. The stored bias is kept for when you sign in, like a
  stored skip switch.
- **Chips, not a segmented control.** Five biases cut "Unfamiliar" short in an iOS
  segment on a 393 pt phone, and "Déjà essayés" or "Encadenados" more, so the bias is a
  wrapping chip row like Min ascents, and it now comes first in the filters, since it
  decides which rows below it apply. A menu row would hide the five choices behind a tap;
  as chips they all stay in view, with the line under them saying what the picked one does.
- **Stored filters.** A new bias is a new value, not a new stage kind, so a run with one
  stays under `_v1`. A bundle from before Sent and Liked reads such a stage's filters as
  unreadable (`isStageFilters` checks the bias against `CLIMB_BIAS_OPTIONS`) and drops
  only the filters, keeping the stage and its climbs; its next "Add a block" starts from
  the default filters. Bundles from before #6650 never read stage filters at all.
- **Requests.** One search per pool, like Attempted. No new key reaches a default
  request, so the screenshot fixtures still replay.
- **Next.** The rest of #6739: a block filled from a playlist in list order, or from the
  climbs of this or your last session by outcome, and "Swap for a climb from…" on a row.

## What comes next

- **Launch the timed blocks** ([#5380](https://github.com/boardsesh/boardsesh/issues/5380)):
  4x4 reps and sets, limit bouldering and on the minute are built (see "Timed blocks") and offered
  in dev builds and to testers through `workout-timed-blocks`. The launch removes that flag
  and `timedWorkoutBlocksOffered`, so every climber gets the eight chips.
- **Repeats** ([#6734](https://github.com/boardsesh/boardsesh/issues/6734)): a 4x4 is now
  reps × sets on one climb, with a rest between reps and another between sets, which runs the
  doubles, triples, "four more" and laps shapes there (2 to 10 reps, rests from none to an
  hour), logs every go on the right climb and counts both rests in the time estimate. Still
  open there: a `repeats` partner block (and how the partner `fourByFour` fields map onto
  sets and reps), a name per shape ("Triples") in the readout, and a crew clock that counts
  reps itself instead of following the builder's phone.
- **Per-stage pacing for untimed blocks.** Timed blocks pace the rest timer (see "Pacing"); a
  volume, pyramid, ladder or grade-focus block still runs on the climber's own rest. A partner
  `restSeconds` on those blocks would reach the same `WorkoutRunStage.pacing`.
- **Partner `plan_snapshot`.** Partner workouts (`docs/partner-workouts-internal.md`) map
  their blocks onto these stages and report what was queued per block.
