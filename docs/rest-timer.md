# Rest timer

The mobile rest timer (#5378) counts a climber's rest between climbs and, when they ask for it,
moves the wall to the next climb when the rest runs out. This page covers the three seams every
timer feature plugs into: what the timer is paced by, how it tells the climber the rest is ending,
and which phone may move the wall. The workout stages that pace it are in
`docs/workout-stages.md`.

## Where the code lives

| Piece | File |
| --- | --- |
| Runtime state (armed, anchor, cycle id). Module store, nothing persisted | `packages/mobile/src/lib/rest-timer-store.ts` |
| Deadline maths, the stale-deadline guard | `packages/mobile/src/lib/rest-timer-auto-advance.ts` |
| The one `setTimeout` that fires the advance | `packages/mobile/src/components/queue-control/RestTimerAutoAdvanceScheduler.tsx` |
| The pill, the hero clock and their 1 Hz ticker | `packages/mobile/src/components/queue-control/RestTimerPill.tsx` |
| The options sheet and the Record tab's arm row | `RestTimerSheet.tsx`, `session-screen/RestTimerArmRow.tsx` |
| Effective pacing | `packages/mobile/src/lib/rest-timer-pacing.ts`, `src/hooks/use-effective-rest-pacing.ts` |
| Workout stage pacing: the sync, the arm at Start, "Set by your workout" | `src/components/queue-control/RestTimerPacingSync.tsx`, `src/lib/rest-timer-effective.ts`, `RestTimerWorkoutPacingRow.tsx` |
| Which queue item a tick counts for | `packages/mobile/src/lib/tick-attribution.ts`, read by `play-drawer/use-tick-saver.ts` |
| Cues | `packages/mobile/src/lib/rest-timer-cues.ts`, `src/lib/sounds.ts` |
| Wall-driver rule | `packages/mobile/src/lib/session-timer/driver-rule.ts`, `src/hooks/use-session-timer-driver.ts` |
| Session timer: snapshot, commands, command queue, tick bus | `packages/mobile/src/lib/session-timer/` |
| Rogue gym timer: connection, scan slot, the sink | `packages/mobile/src/providers/rogue-timer-provider.tsx`, `rogue-timer-context.ts` |

The durable preferences (rest length, cadence, auto-advance, sound, countdown cues) live in
`packages/mobile/src/settings`. Arming never survives a cold start, with one exception: a live crew
clock comes back from the session's seed, whoever set it (see "The crew's clock" under "Which phone moves the wall").

## Effective pacing

The timer runs on an `EffectiveRestPacing`: a rest length, a cadence (`afterTick` or
`onTheMinute`), an auto-advance switch, an advance rule and the source it came from.
`resolveEffectiveRestPacing` picks the source, highest first:

1. `crew`: the session's shared clock (#5382).
2. `stage`: the workout stage the current climb belongs to (#5380, #6231). A stage
   auto-advances, except a 4x4 set with reps still to log: its rests never move the wall, and
   saying so is also what keeps the crew clock, which counts no reps, from firing mid-set.
3. `settings`: the climber's own preferences. These never carry an advance rule, so they run on
   the deadline, as the timer always has.

`useEffectiveRestPacing()` (and `getEffectiveRestPacing()` outside React) is the only way to read
it. The scheduler, the pill and hero clock, `RestTimerSessionSync` and the arm row read through
it today; the tick path, the workout runner, the crew publisher and the Lock Screen countdown join
as they land. A new source changes `rest-timer-pacing.ts` and the hook, never those readers. The
sheet's controls keep writing the settings directly: they edit the climber's preferences, not the
effective value.

All three are wired. With no crew clock and no workout stage on the wall the hook returns exactly the
three settings with `advanceOn: 'deadline'` and `source: 'settings'`. The stage input is the
`stagePacing` that `RestTimerPacingSync` keeps in the store for the climb on the wall (see
"Pacing" in `docs/workout-stages.md`). The crew input is the clock this phone follows, held
in the store's `crew` field (see "The crew's clock" under "Which phone moves the wall").

The advance rule:

| Rule | A finished rest moves the wall when | After the move, an `afterTick` rest |
| --- | --- | --- |
| `deadline` | always | starts again at the fire |
| `tick` | a tick was logged on the climb on the wall | waits for the next tick |
| `send` | that tick was a flash or a send | waits for the next tick |

`onTheMinute` keeps its beat whatever the rule (`anchorAfterFire`). `restAdvanceAllowed` is the
pure check; it only lets a tick count when it was logged against the queue item on the wall, so a
tick on the previous climb, or one from a list, never lights the next. A 4x4 set adds one more
condition to `tick`: every rep of the set is logged on the climb on the wall (the stage pacing's
`reps`, counted from the run's tick log). Until then a rest between reps runs out with the
reached cue and the climb stays up for the next rep; with no rest between reps nothing counts
down at all.

The scheduler asks `restAdvanceAllowed` when it schedules and again when the timeout fires, with the
store's `lastTick`. A tick that counts for no queue item leaves `lastTick` as it was, so it never
cancels an advance the climb on the wall already earned. Nor does a late tick on another queue item:
a save started on the previous climb that finishes after the advance never replaces a tick the climb
on the wall (`stagePacing.queueItemUuid`) already has. A refilled queue under a tick rule also waits
for the next tick and forgets the last one, as the fire does (`clearRestTimerQueueEnded` with
`anchorAfterFire`): that tick's rest already ran out at the dead end.

The tick that moved the wall is spent. The store remembers the climb the timer last moved the wall
off (`advancedFromQueueItemUuid`, set by `noteRestTimerAdvancedFrom` just before `nextClimb`, on
the local path and on an applied crew FIRE), and `restAdvanceAllowed` never lets a last tick on
that climb move the wall again. A fresh tick logged on this phone on that climb clears it: the
climber went again, and that go earns its own rest. Found in simulator QA during a backend deploy
(#5380): the set rest's FIRE got no answer, so the solo phone moved the wall itself; that move
never reached the server, the rejoin put the old climb back, and the session seed brought back
the crew clock with the set's last rep on that climb. Without the guard the scheduler restarted
the rest that had run out and moved the wall a second time. Arm and disarm forget it.

A tick never starts a rest earlier than the rest already running or the last advance, and never
in the future (`noteRestTimerTick`'s floor:
`min(now, max(tick, anchor, lastFiredDeadlineMs))`). The `afterTick` deadline is the anchor plus
the rest, so without the floor a send saved 2 s after an advance but dated 55 s back would move
the wall again 7 s later and skip the climb it just lit. The one
change a climber sees: a back-dated tick (the tick sheet's date picker, or a slow save of the
previous climb) can no longer shorten a running rest. It still shows as the last tick. On the
minute keeps its beat; a tick only fills a missing anchor, with the same floor.

The floor is for a slow save, not for history. A tick dated more than
`AUTO_ADVANCE_MAX_BACKDATE_MS` (60 s) before it was logged, judged on its own `climbedAt`
(`isTickFreshEnoughToArm`), is history: yesterday's session logged with the date picker. It
never replaces `lastTick`, so it never moves the wall under a tick or send rule, and the tick
path keeps it out of the workout's tick log by the same test, so it is never a 4x4 rep either
(`use-tick-saver.ts`). Both tests are made at the instant the climber logged the tick, which the
tick path hands `noteRestTimerTick` as `loggedAtMs`, so one go is judged the same way twice: a
rep whose save lands 90 s later (an offline queue, the gym's wifi) still counts, still becomes
`lastTick`, and the set rest after it still moves the wall. The landing time only caps the
anchor. A tick with no log instant (one read back from the session) is judged on landing. Under a
crew clock's tick or send rule the phone judges on landing too, because the server judges the
TICK by its `elapsedMs` and would refuse every beat the phone fired for a tick it read as
history. On a running
rest it goes through the floor, so it never rewinds it. A paused rest stays paused. With no
anchor it anchors at its own time, as every tick did before the floor, so its deadline is
usually long gone and nothing is scheduled. Floored there instead, it would start a rest at the
last advance: after a workout advance, yesterday's send on the climb just lit would read as fresh
and walk the wall on after the rest with that climb never climbed. A cold start still picks the
rest up from the session's last tick, however old.

One guard backs both up, whatever set the anchor (`getAfterTickRestFloorMs`). A running
`afterTick` rest whose anchor is more than 3 s before the last advance counts from 3 s before
that advance instead, so the next advance waits a whole rest from it, less 3 s
(`AUTO_ADVANCE_REST_FLOOR_SLACK_MS`). Two paths reach such an anchor without a fresh tick, and
each used to move the wall again seconds after the last advance:

- History on a long rest. With no anchor (after a tick or send rule's advance onto a climb outside
  the workout, or after an on-the-minute stage hands over), a send from 85 s ago on a 1:30 rest
  anchors at its own time and runs out 7 s after the advance. Now it moves the wall 87 s after it.
- A longer rest set over history. A send from 5 min ago is long gone on 1:30; set the rest to
  5:10 and it runs out 12 s after the advance. Now it moves the wall 5:07 after it.

The guard only delays. A rest that has already run out stays run out, so it never gives yesterday's
send a live deadline. Set to 5:00 instead of 5:10, that send ran out 2 s after the advance and
moves nothing. The deadline uses the rule directly, and the scheduler writes the moved anchor into
the store the first time the rule applies
(`floorRestTimerAnchorAtLastAdvance`), so the pill reaches 0:00 as the wall moves, a pause freezes
that rest, and the rest never flips back once its own anchor's end goes by. Re-arming clears the
last advance, so a new arm counts from its own ticks. The 3 s slack leaves alone a rest that
starts just before an advance for an ordinary reason: a fire that reads the clock a moment before
its deadline, and a crew clock's whole-second pause rounding and early FIRE.

## Cues

The scheduler names a moment and `playRestTimerCue` decides what it feels and sounds like:

| Cue | When | Haptic | Sound |
| --- | --- | --- | --- |
| `countdownTick` | each second of the final countdown | selection | tick |
| `warning` | once, where the countdown would start, when per-second cues are off | light | tick |
| `advance` | the scheduler called `nextClimb()` | medium | final |
| `reached` | the rest ran out and the wall did not move | success | final |

`warning`, `advance` and `reached` are the timer's original three haptics, unchanged.
`countdownTick` is the countdown's (#5396); see `## Countdown` for when each plays.

Rules the scheduler keeps:

- One terminal cue per deadline: `advance` when `nextClimb()` ran, `reached` when the rest ran
  out and the wall did not move, including at a dead end (the end of the queue or the list), where
  the toast says why.
- Countdown ticks and the single `warning` never both play for one rest.
- `playRestTimerCue` never throws. The haptic always plays. The sound plays only when
  `isRestTimerSoundAvailable()` and the `restTimerSound` setting are both true, and the player is
  built on the first cue that wants it and kept while it works. One that throws is dropped, so
  the next cue builds a fresh one.

## Sound (native train)

On `main` there is no sound: `packages/mobile/src/lib/sounds.ts` is a placeholder whose
`isSoundSupported()` returns false and `createSoundPlayer()` returns null, so every cue is the
haptic alone and the Sound setting row stays hidden. Playing a sound needs `expo-audio`, a native
module, so the body ships in a `[native-train]` PR on `release/next` (#5395). Only that PR edits
this section and `sounds.ts`.

## Which phone moves the wall

`deriveSessionTimerDriver` is the one rule, read through `useSessionTimerDriver()`:

| Role | When | May advance the queue |
| --- | --- | --- |
| `solo` | no crew in the session | yes, with or without a board connected |
| `holder` | a crew, and this phone holds the wall | yes |
| `passenger` | a crew, and a crewmate holds the wall | no, `blockedReason: 'crewPassenger'`, `pacerDisplayName` names the holder |
| `unheld` | a crew, and nobody holds the wall | no, `blockedReason: 'crewPassenger'` |

The scheduler fires only where `canAdvanceQueue` is true, and the sheet's auto-advance switch is
disabled with the reason everywhere else, so the two can never disagree.

**The crew's clock (#5382).** In a session the backend keeps one rest clock every member
follows (wire and reducer: "Crew rest clock" in `docs/websocket-implementation.md`). A phone
follows it once it arms the timer, or once another member does: the pill appears on every phone
in the crew.

| Piece | File |
| --- | --- |
| Taking a change: revision floor, adoption rule, inputs, the FIRE plan | `packages/mobile/src/lib/crew-rest-cadence.ts` |
| The server clock offset | `packages/mobile/src/lib/server-clock.ts` |
| Sending this phone's actions | `src/lib/crew-rest-publisher.ts`, `RestTimerCrewPublisher.tsx` |
| "Sam is pacing the wall", the crew notes | `RestTimerPacerCaption.tsx`, `RestTimerCrewNote.tsx` |

- **Who moves the wall.** Still only `holder`, and `solo`, by the table above. With a crew clock
  the scheduler asks the server to take the beat first (FIRE, compare-and-set) and moves the
  wall only when it did, so two phones that both think they hold the board can never both move
  it. A phone alone in its session moves the wall itself only when the server cannot be reached.
- **A beat nobody claimed.** On the minute, a beat the holder lets go (no answer, refused, too
  late, or slept through) is marked spent on that phone (`crewBeatSkippedMs`), so the next beat is
  claimed as usual. It is never recorded as an advance: the tick and rest floors read only the
  beats the server took, so a rest after a switch to after-tick starts where the crew's does.
  After a tick, a deadline nobody can claim any more (more than 5 s gone) is restarted by the
  phone pacing it: back from the background, after a FIRE that failed or came back refused or
  late, and when a phone takes the board over with the deadline already past.
- **A beat the server would never take.** The server refuses a beat too close to the last one it
  took (#6754): after a tick, closer than one rest less 3 s; on the minute, closer than 12 s. The
  phone checks that against the crew clock before it sends a FIRE, and lets such a beat go as a
  refused one, with no FIRE and no retry (`crewBeatFenced`).
- **Who changes it.** Anyone in the session (Marco, 2026-10-25). While a crew clock runs, the
  sheet's and the Record tab's length, cadence and auto-advance controls show the crew's values,
  not the climber's own, and an edit changes the crew clock: `editCrewRestPacing` sends a
  CONFIGURE with the crew's config and only that change, at once. Its advance rule stays; its
  source becomes `settings`. A change of cadence starts the beat now on the minute and waits for
  the next tick after a tick, as a stage boundary does. The controls show the edit
  (`crewPacingDraft`) until the server answers, so a second tap steps on from the first; the
  timer keeps running on the crew's config meanwhile. The climber's settings take the crew's
  values with the change too, so the length they picked is theirs after the session. The sheet
  says so ("Changes here go to everyone"). "Set by your workout" stays only while the crew clock
  runs a workout's pacing. In a crew, a settings edit pushes nothing: Settings › Timers changes
  the climber's own defaults only. Alone in a session, a Settings › Timers edit still moves the
  running timer. Auto-advance becomes the crew's setting: a passenger can switch it, and its
  line names whose phone moves the wall.
- **A workout started over a crewmate's clock.** Start and "Add a block" arm nothing when the
  timer is on. They mark the workout's paced climbs instead, and the first of them to reach the
  wall is a stage boundary: on the minute the beat starts then, a tick or send rule waits for
  that climb's tick. Stage changes under a crewmate's clock are planned from that clock, so the
  workout's pacing wins from its first climb (`rest-timer-effective.ts`).
- **What a passenger sees.** The crew's rest, counted from the crew's anchor, with "Sam is
  pacing the wall" under the digits (one capped line on the pill; under the sheet's clock it
  grows with Dynamic Type and wraps). If the holder's phone sleeps the rest runs past zero and
  nothing moves; the holder's phone restarts it when it comes back.
- **The clock offset.** Every crew instant is converted to the phone's clock when the change is
  taken. A later sample, even one on a change too old to take (a FIRE's reply), that moves the
  offset by more than 250 ms converts the held clock again, unless this phone has an action of its
  own waiting for its echo.
- **A tick under a tick or send rule** counts only on the climb on the wall, on every phone: a
  late tick on the previous climb, or one from a list, neither replaces the wall climb's tick nor
  moves the rest, and never reaches the server.
- **A cold start** takes the crew's live clock back from the session's seed (Marco,
  2026-10-25): one another member set, and one this phone set, so the setter keeps pacing the
  wall. Not a clock the climber turned off on this phone since launch, and never from an echo of
  this phone's own ARM, so turning the timer off sticks.
- **An unknown mode or rule** (a newer app set it) is held but never fired on, and the sheet asks
  for an update. A cadence or settings change on that phone never re-arms or configures the
  session, so it cannot replace the crew's clock. The hold goes with the session.

Stories: `rest-timer-crew--crew-passenger` (also `--crew-holder`, `--crew-unheld`,
`--sheet-crew-passenger` and `--sheet-crew-holder`) fake a crew and Sam's clock on one simulator.

"A crew" is `useIsCrewSession()`: someone else is on the session roster, past the arming dwell.
It is the same roster rule as `useIsSharedSession()` without the `shared-session-browse` flag.
That flag decides how gestures behave in a crew. It never decides who may move the wall: with the
flag off, every armed phone in a crew used to be able to advance it.

`canDriveGymTimer` is the Rogue gym timer's gate and keeps its old answer: this phone holds the
board's Bluetooth link. A virtual hold on a wall with no lights never widens it, so a phone
without the LED link never scans for the timer.

## Countdown

The last seconds of a rest count down on screen and in cues (#5396), so the climber is on the holds
when the rest runs out. The lead scales with the rest (`getRestTimerCountdownLeadSeconds`):

| Rest | Countdown |
| --- | --- |
| up to 1:00 | 3 s |
| 1:01 to 2:59 | 4 s |
| 3:00 and longer | 5 s |

It is never longer than the rest minus one second, and there is none with no rest set.

On screen, the pill, the Record tab's clock and the sheet's hero go to the `final` phase for the
lead through 0:00: the brand tint (`systemColors.accent`, at least 4.5:1 on every opaque surface
they draw on, in both schemes and under Increase Contrast), the same semibold digits, and nothing
animates, so Reduce Motion has nothing to turn off. Past 0:00 the digits go red as before. The
readout is never a live region. The 1 Hz ticker waits to the anchor's next whole second, not a
flat 1000 ms, so the digits flip on the instants the cues land on.

A pause freezes the readout at the pause instant (`getRestTimerCycleElapsedSeconds`). The store
keeps the seconds since the anchor (`pausedElapsedSeconds`), and so does the crew clock's
`PAUSE`. On the minute the readout takes that total within its window, as the running clock
does: paused 3:50 into a 1:00 cadence reads 0:10 left, never -2:50. Resume rebases the anchor on
the total, so it counts on from the same 0:10 and the next beat is 10 s away.

The cues, from the scheduler:

- `restTimerCountdownCues` on (the default): one `countdownTick` per second of the lead, then
  the terminal cue.
- Off: one `warning` where the countdown would start, then the terminal cue.
- The choice is made by the first cue that lands for a rest and kept for that rest, so a toggle
  mid-countdown never plays ticks and the warning together. A change before the countdown starts
  applies to that rest. Resume counts on from a new anchor, so a change made while paused applies
  to the seconds left.
- The countdown plays before `reached` too: auto-advance off, a crew passenger, a dead end. On the
  minute with nothing moving the wall, every beat counts down and buzzes. The latch is the instant
  that was cued, and a beat an advance fired on counts as cued, so a beat never gets `advance` and
  `reached`. After a dead end, no further beat counts down until the queue moves again.
- The `reached` latch belongs to one rest, and a rest is its anchor: a re-arm (the cadence switch
  is one), a Reset, a new tick, an `afterTick` advance and a Resume each start a new one, so
  nothing an earlier rest cued silences the next, whichever way the phone's clock moved. A rest
  starts handled through the moment the scheduler first saw its anchor, so a mark that went by
  before then never plays: the mark a paused rest already passed (Resume rebases the anchor on the
  paused elapsed), one the last mount played before a disarm and re-arm brought the same tick
  back, or one behind a back-dated tick (the advance never fires for those either).
- A countdown tick or the warning that lands more than 750 ms late (`REST_TIMER_CUE_LATE_MS`)
  says nothing. That is a timeout flushed on a resume from the background, for a second the
  climber never saw.
- The terminal cue keeps the advance's 5 s grace (`AUTO_ADVANCE_OVERDUE_GRACE_MS`,
  `isRestTimerReachedCueLate`). A rest end that lands up to 5 s late, from a JS stall or a dead
  end the deadline found late, still gets `advance` or `reached`. Past that it gets neither.
- One rest holds at most six timeouts: five cues and the advance (or the `reached`).

The wake lock (one `rest-timer` tag, in the scheduler): `scheduled || (reached cue pending &&
pacing.source !== 'settings')`. A pending advance keeps the screen up, as it always did. A rest
a workout stage or the crew paces also keeps it up until its `reached` cue, so limit
bouldering's "go" after a fall lands on a lit screen. A climber's own rest with auto-advance off
never held the screen and still does not.

One case still plays no terminal cue inside an awake app: a dead end found more than 5 s after
the rest ran out, which only happens when the beat waited that long for the next page of a list
and that page ended the list. The toast is the signal there.

The sound half needs nothing here: once the native train's `sounds.ts` reports a player, every
cue above is audible, behind the `restTimerSound` switch.

Story: `rest-timer-pill--final-countdown` (also `--running` and `--over`) draws every readout
against the live timer; shoot it with the clock frozen for a still.

## Settings

| Key | Default | Read by |
| --- | --- | --- |
| `restTimerTargetSeconds` | Off | effective pacing |
| `restTimerMode` | `afterTick` | effective pacing |
| `restTimerAutoAdvance` | off | effective pacing |
| `restTimerSound` | on | `playRestTimerCue`, on a binary that can play sound |
| `restTimerCountdownCues` | on | the countdown (#5396) |

## Settings › Timers

Settings › Timers (`/settings/timers`, the last page of the climbing group) holds the rest timer's
saved defaults and its cues, over the same settings the in-session sheet writes, so the two always
agree. The root row shows the rest length (or Off).

| Section | Rows |
| --- | --- |
| Rest | Rest length (a menu: Off, 0:30 to 10:00 in 30 s rungs, plus a saved length that sits between rungs), cadence, auto-advance |
| Cues | Sound, only when `isRestTimerSoundAvailable()` |
| Gym timer | One row per board the climber owns, with its paired Rogue timer (under the board's name past text size 1.3); Remove under a paired one. Signed out: no section |

- A cadence change goes through `changeRestTimerMode` (`lib/rest-timer-mode-change.ts`), the one
  re-arm rule the sheet's cadence control uses too: choosing the saved cadence does nothing, and a
  running timer is re-armed on the new one.
- Auto-advance is disabled with the reason when a crewmate drives the wall (`useSessionTimerDriver`)
  or no rest length is set, crew first. This is the sheet's rule.
- The Sound row is absent on a binary that cannot play sound, so the mute lives here and the native
  train needs no UI edit.
- `keepScreenAwake` was deleted: nothing read it. The rest timer and the play drawer keep the screen
  awake through `useKeepAwakeWhile`.
- Copy lives in `common.json` under `mobile.settings.timers`, the settings-page convention, not in
  `settings.json` as #5398 first said.
- Gym timer pairing is covered under "Rogue gym timer" below.

## Session timer

`packages/mobile/src/lib/session-timer/` turns the rest timer into one value a display can follow
(#5397). Pure, apart from the tick bus.

| Module | What it does |
| --- | --- |
| `snapshot.ts` | `buildSessionTimerSnapshot`: `off`, `waiting`, `paused`, or a live clock (`running`, `countUp`, `queueEnded`) with its cycle start, deadline and fixed-window period, plus `lastAdvanceMs` and `lastTickAt`. Same phase order as the pill and the Lock Screen payload. `getSessionTimerWakeMs` is the one moment it changes with no store write: a fixed window's end |
| `commands.ts` | `deriveSessionTimerCommands(prev, next, nowMs)` diffs two snapshots into `restartCountUp` or `reset`; `deriveSessionTimerTickCommand` covers a tick with the rest timer off |
| `command-queue.ts` | `createLatestWinsQueue`: one command at a time, the newest waiting one wins, and a command the one in flight already delivers is dropped |
| `tick-events.ts` | `noteSessionTimerTick`: the tick saver tells the sinks about a committed tick, just before the rest timer hears of it, with the timestamp the rest timer stores as `lastTickAt`. Never from outbox replay |

The command rules:

- A sink that just connected sends nothing. Connecting is never a reason to restart a clock.
- The timer going off (disarmed, or armed for a session this phone left) sends `reset`, once.
- A new rest sends `restartCountUp`: the live clock's cycle start or the last auto-advance moved
  forward, and that instant is fresh. One rule covers a tick, Reset, an auto-advance (also when a
  tick or send rule clears the anchor), a fixed-window beat, a refilled queue and a rest restarted
  after the background.
- Fresh depends on what moved it, because the gym timer can only count from 0 now. A climb this
  phone just saved (a new `lastTickAt` the tick bus stamped) or an auto-advance (a new
  `lastAdvanceMs`) may be up to 60 s old: a tick is dated when it was submitted and lands when the
  save returns. Anything else (Reset, arming, a
  refilled queue, a fixed-window beat) must be at most 5 s old (`AUTO_ADVANCE_OVERDUE_GRACE_MS`). An
  older one was seen late, like a beat whose wake was held while the phone was locked or a window
  re-cut by a new rest length, so the clock waits for the next beat instead of starting off the
  window. A tick never moves a running fixed window, so it never excuses a late beat. The one tick
  that counts in a fixed window is the one that starts it: with the timer waiting for a tick (a
  stage change, or a tick or send rule's advance, left no anchor) the store anchors the window on
  it, so it gets the 60 s allowance while that is still the current window. One backdated past the
  window it would have started waits for the next beat.
- A new `lastTickAt` the tick bus did not stamp was read back, not logged now: the session's last
  tick that `RestTimerSessionSync` hands the rest timer when it is switched on or after a cold
  start. It restarts nothing, however fresh. The gym clock already counted that climb (with the
  rest timer off its own tick restarted it) or never heard of it (logged on another device). The
  sink stamps a tick only when the rest timer is on for it, and keeps the stamp until a snapshot
  shows the rest timer storing it, or off.
- Pause and resume send nothing. A resume carries at least a second of rest already counted. A tick
  logged while paused is told apart by its new `lastTickAt`, however long its save took, and starts
  a new rest.
- A tick with the rest timer off restarts the count-up from now, unless it is backdated by more
  than a minute. "Off" is `isArmedForThisPhone`, the snapshot's own rule, read from the store as
  the tick lands: the sink's last snapshot is rebuilt in an effect after React renders a store
  write, so a tick right after arming would still read it as off.

What changed for the gym timer, which used to restart on every logged climb:

- An auto-advance and every fixed-window beat restart it.
- In a fixed window a logged climb no longer restarts it: the window holds, as the pill does.
- A climb backdated by more than a minute, or a tick read back from the session on a cold start or
  when the rest timer is switched on, no longer restarts it.

The pill stays on `useRestTimerDisplay`. The Lock Screen countdown moves onto the snapshot after
the release train's merge-back.

## Rogue gym timer

- `RogueTimerProvider` connects only while `canDriveGymTimer` (this phone holds the board's
  Bluetooth link) and the active board has a `timerName`. A crew passenger never holds the link, so
  a passenger's phone never touches the timer, and nothing scans at launch.
- `RogueSessionTimerSink` is a null-render leaf, mounted only while connected. It rebuilds the
  snapshot on rest-timer store writes and pacing changes, plus one wake per fixed window (no
  per-second work), and pushes commands into a latest-wins queue around `pressButton`.
  `restartCountUp` is STOPWATCH, 180 ms, RESET, 180 ms, OK. `reset` is RESET.
- OK is an unconfirmed start/stop toggle, so two restarts must never interleave. A restart whose OK
  has not gone out yet absorbs any restart asked for meanwhile: a tick and an auto-advance 100 ms
  apart press one STOPWATCH, RESET, OK, and a double tick within 0.3 s still ends counting.
- Pause leaves the gym timer running: stopping it would mean pressing OK blind. Countdown
  programming and a stop are unverified on the hardware (`docs/ROGUE_TIMER_BLE_SPEC.md` §6, §7), so
  the timer only ever counts up.
- Key presses are at least 180 ms apart across commands too: a reset queued behind a restart waits
  out the gap after the restart's OK.
- The radio has one scan slot. `schedulePairingScan` starts a pairing scan only after any reconnect
  in flight has settled (a reconnect stops every scan on its way out), and no reconnect starts while
  a pairing scan holds the slot. A reconnect held back runs when the pairing scan stops, by itself
  or with the sheet. `TimerPairingSheet` asks for the slot whenever it renders inside the provider.
- One connect at a time on the provider's controller. A connect asked for while another is still
  scanning or connecting (the paired timer changed, say) waits for it to settle: the first one's
  scan stop and its cancelled-path disconnect would otherwise end the second's scan or link.
- `TimerPairingSheet` checks permission and the radio itself before it scans, because the scan
  says nothing when either is missing. It shows "Turn on Bluetooth to scan", the Android "allow
  permissions" copy, or the blocked state with Open Settings, and hands the scan slot back. A scan
  that ends without its stop callback (an error, most often the radio switched off) is given up 3 s
  after its 30 s window, so the sheet never spins with the slot held.
- Pairing lives in Settings › Timers under "Gym timer", one row per board the climber owns, never
  a spray wall. Owned is `ownerId` equal to the climber's id, the rule the server uses before it
  sends `timerName`. There is no `isOwned` fallback: the server sends a followed board with a
  private owner as `ownerId: null, isOwned: true`. The section walks every page of `myBoards`
  (`fetchAllMyBoards`), since one page mixes followed boards in. It stays in the board form too. A
  pair or a remove saves `timerName` through `updateBoard`, then re-saves the stored active board
  when it is that board: `updateBoard` never refreshes the stored copy the provider connects from.
- `lib/ble/**` and `packages/shared/ble-protocol` are untouched: the release train rewrote
  `rogue-timer-ble.ts`.

Checks only a phone and a Rogue Echo can do: a tick restarts it, an auto-advance restarts it, a
fixed-window beat restarts it, switching the rest timer off shows 0:00, pause leaves it running, a
double tick within 0.3 s still ends counting, and a passenger's phone never touches it. Also: a
timer that drops and reconnects is not restarted by the reconnect; the link holds while the pairing
sheet scans, and a link that dropped meanwhile reconnects when it closes; a phone locked through a
fixed-window beat does not restart it late on unlock, and the next beat does; a climb dated more
than a minute back does not restart it; and whether RESET on a running stopwatch stops it as well as
zeroing it, which decides whether switching off really shows a still 0:00.

## Who edits what

Several PRs change these files at once, so each owns its region:

| File or section | Owner |
| --- | --- |
| `rest-timer-pacing.ts`, `use-effective-rest-pacing.ts` | the seam PR; the workout pacing PR adds the stage input, the crew PR the crew input |
| `rest-timer-cues.ts`, `driver-rule.ts` and their hooks | the seam PR |
| `sounds.ts` and the `## Sound (native train)` section | the native train PR only, until the merge-back |
| Scheduler: the pacing and driver reads, the cue calls | the seam PR |
| Scheduler: the fire's anchor and the advance-rule check | the workout pacing PR |
| Scheduler: the warning, reached and keep-awake region | the countdown PR |
| Scheduler: the fire's crew compare-and-set, the AppState effect | the crew PR |
| `RestTimerSheet.tsx` lines the release train changed | nobody on `main` until the merge-back |
| A `## Countdown` section, directly above `## Settings` | the countdown PR |
| `## Settings`, and a Timers page section directly after it | the Timers page PR |
| The session timer and Rogue sections, directly above `## Who edits what` | the Rogue timer PR |

New sections go at those anchors, never at the end of the file and never against
`## Sound (native train)`. The Release Train Sync merges `main` into `release/next` on every push
to `main` and hourly, and git reads a `main` edit that touches the train's lines, or sits directly
against them, as a conflict. One untouched line between the two edits is enough for a clean merge.
