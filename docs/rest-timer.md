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

Today only `settings` is wired, so the hook returns exactly the three settings with
`advanceOn: 'deadline'` and `source: 'settings'`.

The advance rule:

| Rule | A finished rest moves the wall when | After the move, an `afterTick` rest |
| --- | --- | --- |
| `deadline` | always | starts again at the fire |
| `tick` | a tick was logged on the climb on the wall | waits for the next tick |
| `send` | that tick was a flash or a send | waits for the next tick |

`onTheMinute` keeps its beat whatever the rule (`anchorAfterFire`). `restAdvanceAllowed` is the
pure check; it only lets a tick count when it was logged against the queue item on the wall, so a
tick on the previous climb, or one from a list, never lights the next.

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

The cues beep through `expo-audio` (57.0.5), a native module, so the sound ships with the store
binary built from `release/next` (#5395) and never by OTA. Until the merge-back, only the
`[native-train]` PR edits this section and `packages/mobile/src/lib/sounds.ts`.

What a binary without the module does. The same JavaScript reaches every store binary built
before this train, older dev clients and the Expo web app, and importing `expo-audio` throws on
all of them. `sounds.ts` touches nothing native when it loads. On the first cue that wants a
sound, `isSoundSupported()` asks `requireOptionalNativeModule('ExpoAudio')` (iOS and Android
only, answered once per app run), and only a yes leads to `require('expo-audio')`. A no means
every cue is the haptic alone and the Sound row stays hidden.

The climber's music:

- The audio mode is set once, before the first beep: `playsInSilentMode: true`,
  `interruptionMode: 'duckOthers'`, `shouldPlayInBackground: false`, `allowsRecording: false`.
  Their music dips under the beep and keeps playing. iOS only ducks from the `.playback`
  category, which is what `playsInSilentMode` selects, so the beep also plays through the silent
  switch. If the mode cannot be set, that beep is skipped: the default session would stop the
  music.
- Both players are made with `keepAudioSessionActive`. On iOS a countdown keeps the session from
  its first tick to its final tone, so the music dips once, not once a second. 1.2 s after the
  last beep (`SOUND_SESSION_IDLE_MS`), `setIsAudioActiveAsync(false)` hands the session back and
  the music returns to full volume. Leaving the foreground hands it back at once.
- Android is different. expo-audio 57.0.5 takes `keepAudioSessionActive` and never uses it, and
  gives up audio focus as soon as no player is playing. So on Android the music dips under each
  beep and comes back between ticks: a countdown makes it pump once a second. That is expected,
  not a bug.
- Coming back to the foreground hands the session back once more, 1.2 s later, when the last
  hand-back happened while the app was away: in the background, or inactive through a phone call.
  iOS expo-audio turns the session back on by itself at those moments. It resumes the rest of a
  tone it paused on the way out, and it reactivates the session when a call ends. Without this
  the music would stay dipped until the next rest's beeps.
- After a hand-back, the next beep calls `setIsAudioActiveAsync(true)` first. Android refuses
  every play until audio is turned back on; on iOS `play()` reactivates the session anyway.
- Native calls run one at a time, in order, and each gets 1 s to answer
  (`SOUND_NATIVE_CALL_DEADLINE_MS`), so one stuck call costs one beep, not every beep after it.
  Each failing step (`create`, `play`, `release`) reports once per app run, as a warning.
- A player that cannot be built throws (after its report) instead of returning null, so the cue
  module builds a fresh one on the next cue. If the tick player was built and the final one
  failed, the tick player is removed first. Each build first removes the previous build's two
  native players and replaces its `AppState` listener, so rebuilds never pile up either.
- Foreground only. A beep starts only while `AppState` is `active`, checked when the cue asks for
  it and again just before it plays, so one queued as the app leaves is dropped. `inactive`
  counts as away (a phone call, Control Center, the app switcher). The missing `audio` background
  mode is not enough on its own: iOS keeps running the JavaScript timers that fire the cues for a
  while after the app leaves (the simulator played a tick and a final tone 7 to 15 s after another
  app came forward), and expo-audio 57.0.5's `play()` turns the session on without checking. The
  rest of the cue (the haptic call, the wall advancing) is unchanged. A locked-phone alert is
  #6530's local notification.

The config plugin entry in `app.config.ts` turns off background playback and background
recording (their defaults add the `audio` UIBackgroundMode and the Android media-playback
foreground service) and does not ask for `RECORD_AUDIO`. It leaves `microphonePermission` unset on
purpose: the binary already carries `NSMicrophoneUsageDescription` from `expo-image-picker`,
`expo-audio` links the recording APIs that App Store processing checks for it (ITMS-90683), and
`false` would delete the string whenever this plugin's Info.plist step runs after the image
picker's. Nothing records. Android gains `MODIFY_AUDIO_SETTINGS`, a normal permission with no
prompt.

The sounds are two generated sine tones in `packages/mobile/assets/sounds/`, 16-bit PCM mono
WAV at 44,100 Hz, with raised-cosine fades so they start and stop without a click:

| File | Cue | Tone | Length | Peak | Fade in / out |
| --- | --- | --- | --- | --- | --- |
| `rest-timer-tick.wav` | `countdownTick`, `warning` | 880 Hz | 100 ms | -6 dBFS | 5 ms / 30 ms |
| `rest-timer-final.wav` | `advance`, `reached` | 1,320 Hz, a fifth above the tick | 450 ms | -3 dBFS | 5 ms / 120 ms |

To change one, regenerate it with the same parameters and check the length still fits under
`SOUND_SESSION_IDLE_MS`.

Testing: the iOS simulator plays the beeps through the Mac's speakers, but its screen recordings
are silent. These can only be checked on a phone:

- Ducking another app's music, and the music coming back about a second after the final tone.
- Android: the music pumps once per tick through a countdown. Expected.
- Locking the phone during the final tone, then unlocking: the music is back to full volume about
  a second later.
- A phone call during a countdown: after hanging up, the music is back to full volume.
- The silent switch, and Bluetooth headphones.

The beep is on by default and plays through the silent switch, so the Sound switch on
Settings › Timers is the only way to mute it. The `[native-train]` PR therefore merges into
`release/next` only after the Timers page is on `main` and the Release Train Sync has brought it
into the train.

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
