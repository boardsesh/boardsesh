# Help clip flows

One Maestro flow per clip on the `/help` topic pages. Each file is named after
its clip in `HELP_CLIPS` (`scripts/lib/help-clips.ts`), and its header says what
the clip records, which deep link the caller must be on before recording starts,
and what every coordinate in the flow is aiming at.

These flows do not record anything themselves. They drive the app while
`xcrun simctl io <udid> recordVideo` runs beside them. Conversion, encoder
settings and the size budget live in [docs/help-clips.md](../../../../docs/help-clips.md).

## Booting the simulator

```sh
export JAVA_HOME=$HOME/.cache/boardsesh/jdk-21
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
BOARDSESH_METRO_PORT=8191 vp run mobile:ios-shots -- --backend local --device "Boardsesh Release Help 20261031" --app-path <cached dev-client .app>
```

That holds a simulator and Metro open for the whole session. Use a dedicated
iPhone 16 Pro Max, dark appearance, at 1320 × 2868 for the release wall-control
captures. `mobile:ios-shots` uses the store-capture environment even without
`--flow`, so `EXPO_PUBLIC_SCREENSHOT_DRIVING=1` and
`EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1` already enable the real wall-button gesture
with the existing simulated board. No new runtime override is needed. Keep
`--backend local`: screenshot mode by itself does not isolate server writes.
The full `mobile:screenshots --flow help` pipeline also enables the paired
environment. Its tail captures the driving player (10), holds the wall button
for real Board controls (09), then stops driving before the preview (12).
The filenames are unchanged; the old board-history deep link is not used for 09.
Simulated-board footage shows the app's actual controls, not a physical BLE test.
The refreshed help takes use main source `3b1d9be90c`, captured 2026-11-02
on the dedicated `Boardsesh Help 7208` simulator against local Docker data.
See [capture provenance and omissions](../../../../docs/help-screenshots.md).
Normalize raw `recordVideo` takes to constant 30 fps before choosing trims:
the variable-frame-rate sources do not seek accurately during conversion.

The original recordings in this set used a throwaway iPhone 16 Pro Max (iOS 26.5) named
"Boardsesh Help Clips": dark theme, Aura board drawing, status bar pinned to
9:41, signed in as `test@boardsesh.com` against **production**, active wall
Boardsesh HQ (Kilter). Capture at the same device and appearance as the help
stills so a clip and a still in one row look like one session.

### Two gotchas that cost an afternoon

- **Foreground `screenshot` / `navigate` calls need a lease token.** The
  background `run` owns the simulator lease. Any foreground call has to pass
  `BOARDSESH_SIMULATOR_LEASE_TOKEN`, set to the token in
  `~/Library/Caches/boardsesh/simulator-leases/<UDID>.lock/owner.json`, or it
  refuses with "is leased by".
- **Maestro will not parse a fractional percentage.** `point: "50%,34.5%"` fails
  the whole flow with a parse error that points at the *next* line. Whole
  numbers only.

## Recording one clip

1. Navigate to the flow's starting screen **first**, so the deep-link
   "Open in Boardsesh?" dialog and any Metro reload stay out of the take. A deep
   link to the route you are already on does not remount it, so hop through
   `://home` on the way.
2. Start `xcrun simctl io <udid> recordVideo --codec h264 --force .boardsesh/help-clips/raw/<name>.mov`.
3. Run the flow.
4. Stop the recording with SIGINT (Ctrl-C). `simctl` finalises the container on
   the interrupt; killing it harder leaves a file nothing can play.

`simctl` records variable frame rate, which reports nonsense durations and plays
back wrong in some players. Every raw take here was trimmed to the gesture
window with ffmpeg and re-encoded to constant 30 fps before conversion, so the
`trim` fields in `HELP_CLIPS` describe only reviewed source takes.

## What the timing actually looks like

- **A tap costs about 1.5 s of real time** — Maestro dumps the view hierarchy
  before every step. That latency is most of a clip's length: a five-state clip
  runs long before you add a single pause. Keep explicit pauses short and let
  the tap latency be the dwell.
- **Maestro has no `sleep`.** The pauses in these flows are
  `extendedWaitUntil: {visible: "zzz-help-clip-pause", timeout: N, optional: true}`
  — it waits the full timeout for text that is never there, warns, and carries on.
- **Maestro needs 6–7 s to attach** before its first step. That dead head is
  what the ffmpeg trim removes.

## Why every step is a coordinate

The accessibility tree on this RN Fabric build only exposes native text inputs
and system dialogs. Nothing in the app is matchable by text or id, so each flow
targets percentage points and its header lists what each one is. The exceptions
are native: the delete confirm in `logbook-swipe-edit-delete` (an iOS Alert), the
Start playlist? action sheet in `start-playlist-queue` (both match Cancel by
text), and the playlist header Play button. The setup flow taps the native switch
at its measured coordinates: tapping its text label matched but left it off.
Verify it is ON before recording. Header Play invokes the first-climb callback;
coordinate row taps did not activate on this cached iOS client. The refreshed
take uses the compatible seeded Aurora Circuit 5 list, because Five Stars can
select a MoonBoard climb while Tension is active.

## Per-clip traps

- **`preview-browsing` must not drive.** Stop any drive first (tap You are
  driving the wall; a timed one shows a clock), and leave both tap and swipe
  lighting off in Settings → Board (the 2.7 default, so a tap previews). Open a
  tracked row and use one illustrative board swipe. Check the take for the arrow
  + face back chip, Preview · not on the wall in the top bar, a plain Put on
  board, and, after closing, the MiniPlayer showing the previewed climb. One
  swipe is a teaching choice, not a limit on list navigation.
- **`wall-swipe-to-drive` starts stopped.** Do not use `screenshotDrive=1` when
  opening the player: that parameter starts driving automatically for stills.
  Do not press Put on board first either: it starts a timed drive, whose clock and
  shrinking frost replace the full frost this clip teaches.
  The clip needs the chevrons first, then a left swipe on the wall button,
  Let go to light every climb, the You are driving the wall label, a board
  swipe, and a tap on You are driving the wall to stop. Disconnect board at the
  end, on a plain button, confirms the link is retained. Frost means driving:
  during the swipe a flat amber wipe shows progress, and the frost appears on
  release. Leave Disconnect Bluetooth when driving ends off, or the stop ends on
  Put on board. Never tap Disconnect board during this take.
- **`://climbs?screenshotOpenPreview=1` opens a drawer that cannot swipe** (no
  suggestion source, so no swipe track), which is why this clip taps a row.
  `screenshotOpenFirst=1` lands the same chrome but is one-shot per active
  board, so it is no good for a retake.
- **`start-playlist-queue` needs a non-empty Up next.** The three-way Start
  playlist? prompt only appears when Up next already has climbs. Seed the queue
  first by swiping two or three climb rows left-to-right, or the tap loads the
  list and opens a preview with no prompt. Turn on Tapping a playlist loads it
  into my queue and leave Always drive the wall off, so nothing drives the wall. Cancel then
  opens the tapped climb as a preview; Start playlist would load Up next and keep
  the wall's climb.
- **The lifted climb menu is a full-window overlay above the navigator.**
  Navigating away does not dismiss it. Add to Playlist closes it and opens the
  playlist sheet, where the old reaction card swapped to an inline picker, so
  `remove-from-playlist`'s menu and playlist coordinates need re-measuring on
  its next recording.
- **`logbook-swipe-edit-delete` targets a single-climb day.** `LogbookRow`
  commits past 96 pt of translation, so the two reveal swipes are 79 pt (18 % of
  the 440 pt width) and only the last one crosses. The row at y=35 % is the
  "An easy problem" entry under a day with one climb, so the delete request goes
  straight to the confirm instead of the multi-entry chooser sheet.
- **`grade-range-tap` teaches the gesture, not a pair of grades.** The rail opens
  near the last-used grade, so which grades the taps land on varies between
  takes. Nothing on the help page may name them.

## What a session leaves behind

Nothing on the account, by design: every clip that writes something undoes it
inside the same take (the playlist is unticked, the delete is cancelled, the
filters are cleared). Check at the end anyway, and empty the session queue from
the queue sheet's Clear.

One setting matters between takes: whether the climbs list's grade row is open
(`gradeRowShown`) persists across launches. `grade-range-tap` opens the row with
its first tap and hides it with its last, so a finished take leaves it hidden.
A take that stopped part-way leaves it OPEN, and the next take's first tap would
then hide the row and land the grade taps on the climb list. Check the row is
hidden before recording that clip, and tap Grade to hide it if not.

Four things change on the simulator: the session queue picks up climbs from the
swipe clip, `alwaysDrive` and `browseNoticeSeen` get written by the
`://climbs?screenshotOpenPreview=1` deep link (deliberately, see the comment in
`app/(tabs)/climbs/index.tsx`), the hold filter's paint colour is left on Finish
rather than Hand, and `start-playlist-queue-setup.yaml` turns on Tapping a
playlist loads it into my queue (`playlistTapLoadsQueue`), which changes every
later playlist tap. The throwaway clip simulator takes them with it; the
wall-control simulator is a named one that gets reused, so reset them there.

The wall-control captures also change that simulator's connection and drive
state. Stop driving before the preview take. After recording, put Settings ›
Board back to the defaults: Always drive the wall off, Stop driving after 45 seconds,
In a session too on, Disconnect Bluetooth when driving ends off, and
Tapping a playlist loads it into my queue off. Keep each refreshed take's source commit and capture date in
[the capture notes](../../../../docs/help-clips.md#capturing-the-wall-controls).
