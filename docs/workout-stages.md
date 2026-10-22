# Workout stages

How the mobile app knows that a queued climb is part of a workout, and which part:
"Warm-up · 2 of 5" in the player, and the "Your workout" card on the session screen.
Issue [#5379](https://github.com/boardsesh/boardsesh/issues/5379), part of epic
[#5399](https://github.com/boardsesh/boardsesh/issues/5399).

## The model

A workout is an ordered list of **blocks**, and every part of it is one, the warm-up
included. A block (`WorkoutBlockSpec`) is either a warm-up of one length (standard or
extended) or one run of the generator (volume, pyramid, ladder or grade focus) at one
target grade, plus its own climb filters (`WorkoutStageFilters`: climb bias, min
ascents, min rating, tall only, wide only). Each block becomes one **stage**. The code lives in
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
- `locateInRun` answers "where is the current climb". It orders by the queue, not by the
  run, and counts only uuids still queued, because climbers reorder and remove climbs.

Stage kinds use the partner API block names (`warmUp`, `volume`, `pyramid`, `ladder`,
`gradeFocus`; see `docs/partner-api.md`, "Blocks"). A partner workout is a list of blocks
in the same vocabulary, so `onTheMinute`, `fourByFour` and `limitBouldering` can become
stage kinds later without renaming anything or translating between two lists.

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

- **Hydrate.** `WorkoutRunSessionSync` hydrates the slot when a session id appears, so a
  cold start mid-workout gets its stages back. A stored run for another session misses.
- **Clear on session end.** When the sync sees a session id go away or change, it clears
  that session's run, in memory and on disk. A hydrate still in flight for it cannot land
  afterwards.
- **Clear on sign-out.** `auth-provider` clears the store with the rest of the per-user
  state.
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
  run it opens on volume at the board's middle grade.
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
  limit block.
- **Limit bouldering** ([#6231](https://github.com/boardsesh/boardsesh/issues/6231)) as its
  own stage kind.
- **Partner `plan_snapshot`.** Partner workouts (`docs/partner-workouts-internal.md`) map
  their blocks onto these stages and report what was queued per block.
