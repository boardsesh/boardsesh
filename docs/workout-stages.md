# Workout stages

How the mobile app knows that a queued climb is part of a workout, and which part:
"Warm-up · 2 of 5" in the player, and the "Your workout" card on the session screen.
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
  skipping any warm-ups in between. With no workout stage after it, it plans no climbs
  (partner warm-ups carry their own `targetGrade` and use that instead). A warm-up plus
  one workout plans exactly what the single-type generator always planned.
- `WorkoutRun` is what actually got queued: per stage, the queue-item uuids that belong
  to it (`buildWorkoutRun`). A stage with no climbs is left out. A workout stage also
  keeps its `targetGrade`, and every stage keeps its `filters`, so a block added later
  can start from them. Both are optional: a run stored before they existed still loads
  under the same storage key. A stage whose stored `filters` this bundle cannot read
  (a malformed field, or a climb bias it does not know) loses just that field; the
  stage and the run load, so the next mid-session block cannot overwrite the stages
  queued at Start.
- A timed stage also keeps its **pacing** (`WorkoutStagePacing`, `pacing.ts`), and a 4x4
  its **rounds**. Pacing is worked out from the block's options by `pacingForOptions` and
  stored only on the run stage, because a run keeps no options. On the minute paces
  `onTheMinute` with its interval (15 s to an hour). A 4x4 paces `afterTick` with its
  between-climbs rest, its between-rounds rest after a round's last climb, and moves on
  after any tick. Limit bouldering paces `afterTick` with its rest and moves on only after
  a flash or a send, so a fall rests and stays on the climb. Every other kind has no
  pacing: the climber's own rest-timer settings apply. `stageRestSeconds` never runs an
  `afterTick` rest under `STAGE_CHANGEOVER_SECONDS` (10 s), a rest of 0 included, so a
  tick saved a few seconds late can't land past the timer's 5 s overdue grace.
- A 4x4 plans one slot per climb of a round, not one per climb it will climb: one climb
  fills each slot, and Start queues the round's climbs once per round, round-major
  (`expandRounds`: A B C D, A B C D, ...). Every copy has its own queue-item uuid, and the
  stage stores each one's round in `roundByUuid`, never worked out from positions,
  because removals and reorders move positions. `rounds` is the count it was planned
  with. All three fields are optional, threaded through `buildWorkoutRun` (from
  `WorkoutRunEntry.round`), `appendStageToRun` (the added climbs' rounds, merged into a
  stage already in the run) and `pruneRun`.
- `locateInRun` answers "where is the current climb". It orders by the queue, not by the
  run, and counts only uuids still queued, because climbers reorder and remove climbs.
  For a climb with a round it also gives `round`: the round's rank among the stage's
  rounds with queued climbs (ranked by the stored number, so a reordered queue still
  says round 2 for a round-2 climb) and the climb's place in it, so the player reads
  "4x4 · Round 2 of 4 · 3 of 4".

Stage kinds use the partner API block names (`warmUp`, `volume`, `pyramid`, `ladder`,
`gradeFocus`, `onTheMinute`, `fourByFour`, `limitBouldering`; see `docs/partner-api.md`,
"Blocks"). A partner workout is a list of blocks in the same vocabulary, so nothing is
renamed or translated between two lists. The option fields keep the partner field names
too (`rounds`, `restBetweenClimbsSeconds`, `restBetweenRoundsSeconds`, `intervalSeconds`,
`restSeconds`); only the partner's `climbCount` becomes `numberOfClimbs`, or
`climbsPerRound` on a 4x4. `WORKOUT_STAGE_KINDS` lists every kind this bundle knows, and
`isWorkoutStageKind` checks stored data against it.

The three timed kinds are modelled end to end but not offered yet: the type chips, "Add a
block" and the mid-session sheet still offer warm-up, volume, pyramid, ladder and grade
focus only (`WORKOUT_BLOCK_TYPES`, and `nextBlockType` cycles the four untimed types). Their
fields exist for when they are: a 4x4 takes 2 to 10 climbs per round (the player keys its
swipe pages by climb, so one climb per round would put the same climb on three pages) and
1 to 10 rounds; limit bouldering 1 to 10 climbs; on the minute 1 to 40. Their rests use
the rest timer's own picker, where Off means no rest for a stage rest and an interval can
never be Off (`RestLengthPicker`'s `allowOff`).

Stage ids are uuids, never positions. Stages get added mid-session and runs get joined,
and a position-based id would collide.

## Where the run lives

The run stays on the phone. `packages/mobile/src/lib/workout-run-store.ts` keeps one
slot, keyed by session id, with the run inside it keyed by queue-item uuid. Nothing is
added to the queue item, the GraphQL schema or the wire.

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

- Only the phone that built the workout sees stages. A crew member's phone shows the same
  climbs with no "Your workout" card. That is fine: the readout is for the climber
  following the workout.
- Ticks carry no stage on the server. Anything that attributes a tick to a stage (partner
  results, per-stage stats) works from the queued climbs, not from the tick.

## Store lifecycle

- **Two slots, one run.** A run made only of the original kinds (warm-up, volume,
  pyramid, ladder, grade focus) is stored under `boardsesh_workout_run_v1`; a run with any
  other kind goes under `boardsesh_workout_run_v2`, and writing one slot removes the other.
  An OTA rollback lands on the bundle embedded in the binary by default, and a bundle from
  before the timed kinds passes an unknown kind straight through and crashes in "Add a
  block". It reads only `_v1`, so it never sees a timed run. From this bundle on, a stage
  of a kind the bundle does not know is dropped on read and the rest of the run kept, as
  is a stage's `pacing`, `rounds` or `roundByUuid` it cannot read.
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
  `useWorkoutRunLog`). A tick on a hand-queued climb or for another session is ignored.
  The log keeps the newest 2000 entries, survives "Add a block" (which rewrites the run for
  the same session) and goes with the run. It is how a 4x4's rounds and a limit climb's
  falls get counted, since ticks carry no queue item on the server.
- **Clear on session end.** When the sync sees a session id go away or change, it clears
  that session's run, in memory and on disk (whichever slot names it). A hydrate still in
  flight for it cannot land afterwards.
- **Clear on sign-out.** `auth-provider` clears the store, both slots, with the rest of
  the per-user state (see the known limit above for an older bundle's sign-out).
- **No prune.** The run is never trimmed as climbs leave the queue. Undo in the queue
  sheet brings removed climbs back under their old uuids, and they must come back in
  their stage. Readers skip uuids that are not queued, so the stale ones cost nothing,
  and the whole run goes when the session ends.

## Building a workout

**Before Start.** The Record tab shows the workout as a list of block cards, and it
starts empty: no blocks means no workout, and the climber picks every climb. "Add a
block" appends a workout block at the last workout block's grade, with the next type. A
card's type chips turn any block into a warm-up or another workout type. A workout card
holds its target grade and counts; a warm-up card holds its length and names the block
it ramps to, or says nothing follows it. Any block can move up or down or be removed. The cap is five
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
grade another block uses. Signed out, climb bias never reaches the search, so it is set
to `any` in the pool key (`fetchFilters`) and blocks that differ only in bias share a
pool; the run still records the bias the climber picked.

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
public `regenerate`, start fresh. Start queues the preview with
`activateFirstWhenIdle` so the first climb goes on the wall, then writes the run, each
stage with its filters, for the new session.

**During a session.** The "Your workout" card has an "Add a block" button. A session
without a workout shows one row, "Add a workout block", in the same spot, so a session
started without the generator can turn into one. Both open `AddWorkoutBlockSheet`, a
`ModalSheet` over the session screen:

- It offers the workout types only, never a warm-up: mid-session the climber is already
  warm, and a warm-up with no workout block after it would plan no climbs.
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
  becomes the run). Climbs cut by the queue's size cap get no stage; a climb whose wire
  send fails afterwards keeps its stage, which is harmless because readers count only
  queued climbs. Climbs already in the queue are left out, and a second tap during the
  slide-down does nothing. The pure part is `add-workout-block.ts`.
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

## What comes next

- **4x4 rounds** ([#5380](https://github.com/boardsesh/boardsesh/issues/5380)): a
  `fourByFour` stage that knows it is four climbs repeated four times, and which round a
  tick belongs to.
- **Per-stage pacing.** `RestTimerAutoAdvanceScheduler` runs one rest length for the whole
  session. A stage could carry its own rest and cadence, so a warm-up rests less than a
  limit block. Every rest-timer reader already goes through `useEffectiveRestPacing()`, so a
  stage's pacing plugs in there (`docs/rest-timer.md`).
- **Limit bouldering** ([#6231](https://github.com/boardsesh/boardsesh/issues/6231)) as its
  own stage kind.
- **Partner `plan_snapshot`.** Partner workouts (`docs/partner-workouts-internal.md`) map
  their blocks onto these stages and report what was queued per block.
