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

The durable preferences (rest length, cadence, auto-advance, sound, countdown cues) live in
`packages/mobile/src/settings`. Arming never survives a cold start.

## Effective pacing

The timer runs on an `EffectiveRestPacing`: a rest length, a cadence (`afterTick` or
`onTheMinute`), an auto-advance switch, an advance rule and the source it came from.
`resolveEffectiveRestPacing` picks the source, highest first:

1. `crew`: the session's shared clock (#5382).
2. `stage`: the workout stage the current climb belongs to (#5380, #6231). A stage always
   auto-advances.
3. `settings`: the climber's own preferences. These never carry an advance rule, so they run on
   the deadline, as the timer always has.

`useEffectiveRestPacing()` (and `getEffectiveRestPacing()` outside React) is the only way to read
it. The scheduler, the pill and hero clock, `RestTimerSessionSync` and the arm row read through
it today; the tick path, the workout runner, the crew publisher and the Lock Screen countdown join
as they land. A new source changes `rest-timer-pacing.ts` and the hook, never those readers. The
sheet's controls keep writing the settings directly: they edit the climber's preferences, not the
effective value.

`settings` and `stage` are wired. With no workout stage on the wall the hook returns exactly the
three settings with `advanceOn: 'deadline'` and `source: 'settings'`. The stage input is the
`stagePacing` that `RestTimerPacingSync` keeps in the store for the climb on the wall (see
"Pacing" in `docs/workout-stages.md`). The crew input lands with #5382's mobile PR.

The advance rule:

| Rule | A finished rest moves the wall when | After the move, an `afterTick` rest |
| --- | --- | --- |
| `deadline` | always | starts again at the fire |
| `tick` | a tick was logged on the climb on the wall | waits for the next tick |
| `send` | that tick was a flash or a send | waits for the next tick |

`onTheMinute` keeps its beat whatever the rule (`anchorAfterFire`). `restAdvanceAllowed` is the
pure check; it only lets a tick count when it was logged against the queue item on the wall, so a
tick on the previous climb, or one from a list, never lights the next.

The scheduler asks `restAdvanceAllowed` when it schedules and again when the timeout fires, with the
store's `lastTick`. A tick that counts for no queue item leaves `lastTick` as it was, so it never
cancels an advance the climb on the wall already earned. Nor does a late tick on another queue item:
a save started on the previous climb that finishes after the advance never replaces a tick the climb
on the wall (`stagePacing.queueItemUuid`) already has. A refilled queue under a tick rule also waits
for the next tick and forgets the last one, as the fire does (`clearRestTimerQueueEnded` with
`anchorAfterFire`): that tick's rest already ran out at the dead end.

A tick never starts a rest earlier than the rest already running or the last advance, and never
in the future (`noteRestTimerTick`'s floor:
`min(now, max(tick, anchor, lastFiredDeadlineMs))`). The `afterTick` deadline is the anchor plus
the rest, so without the floor a send saved 2 s after an advance but dated 55 s back would move
the wall again 7 s later and skip the climb it just lit. The one
change a climber sees: a back-dated tick (the tick sheet's date picker, or a slow save of the
previous climb) can no longer shorten a running rest. It still shows as the last tick. On the
minute keeps its beat; a tick only fills a missing anchor, with the same floor.

The floor is for a slow save, not for history. A tick dated more than
`AUTO_ADVANCE_MAX_BACKDATE_MS` (60 s) before it lands, judged on its own `climbedAt`
(`isTickFreshEnoughToArm`), is history: yesterday's session logged with the date picker. It
never replaces `lastTick`, so it never moves the wall under a tick or send rule. On a running
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
  `settings.json` as #5398 first said. The Rogue pairing row joins the page in a later PR.

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
