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
"Climbs you've tried, sent or liked" below for them and for what Attempted changed with them.

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
- **No crowd floors.** Attempted, Sent and Liked draw from your own climbs
  (`biasDrawsOwnClimbs`, the table's `ownClimbs` column), so min ascents and min rating do
  not apply: `fetchFilters` sets both to 0, which the search reads as no floor, and the
  block's filters hide those two rows while one of these biases is picked. A climb you
  scouted on a spray wall with two ascents still fills the block. The stored values are
  kept, so switching back to Unfamiliar or Any brings them back. This also changes
  Attempted, which used to keep the floors. Tall, wide and Benchmarks only still apply.
- **Skip switches.** Neither fits Sent, so both are disabled there and say why
  (`biasCanSkipSent`, `biasCanSkipTried`), and the fetch drops them. Under Liked both
  narrow the list: Skip what I've sent leaves the liked climbs you have not sent yet.
- **Thin lists.** A list holds what you have climbed or hearted at that grade, often a
  handful. A short one shows the usual shortfall line ("Found 3 of 10 climbs"), and the
  line under the chips says the block takes only the climbs you have sent or liked, so a
  short or empty preview explains itself. The pool runs out on its one search, so it is
  `exhausted` and a rebuild reuses it instead of asking again.
- **Signed out** there is no logbook or heart to read: the bias falls back to Any, as
  Attempted always did, with the floors applying. The line under the chips says so.
- **Chips, not a segmented control.** Five biases cut "Unfamiliar" short in an iOS
  segment on a 393 pt phone, and "Déjà essayés" or "Encadenados" more, so the bias is a
  wrapping chip row like Min ascents, and it now comes first in the filters, since it
  decides which rows below it apply.
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
