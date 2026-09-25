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
SCREENSHOT_USER_PASSWORD=<prod test password> \
  vp run mobile:ios-shots -- --device "Boardsesh Help Clips" --app-path <screenshot dev-client .app>
```

That holds a simulator and Metro open for the whole session. The recordings this
set came from used a throwaway iPhone 16 Pro Max (iOS 26.5) named
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
`trim` field in `HELP_CLIPS` is empty for all nine.

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
targets percentage points and its header lists what each one is. The one
exception is the delete confirm in `logbook-swipe-edit-delete`: that is a native
iOS Alert, so its Cancel button is matched by text.

## Per-clip traps

- **`preview-browsing` gets exactly one swipe.** The seeded preview track offers
  a single peek; after the first swipe both directions go dead and every later
  drag is swallowed (verified both ways and after a 6 s settle). A second swipe
  step records three seconds of nothing. Also confirm `lightOnSwipe` is off
  before recording, or each swipe puts a climb on the wall.
- **`://climbs?screenshotOpenPreview=1` opens a drawer that cannot swipe** (no
  suggestion source, so no swipe track), which is why this clip taps a row.
  `screenshotOpenFirst=1` lands the same chrome but is one-shot per active
  board, so it is no good for a retake.
- **`start-playlist-queue` needs a non-empty forward queue.** The confirm only
  appears when `futureQueueCount > 0`. Seed the queue first by swiping two or
  three climb rows left-to-right, or the tap just opens the climb.
- **The reaction menu is a `Modal` above the navigator.** Navigating away does
  not dismiss it; `remove-from-playlist` takes two scrim taps to get from the
  playlist view back to the list.
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

Three things change only on the throwaway simulator and go away with it: the
session queue picks up climbs from the swipe clip, `lightOnSwipe` and
`browseNoticeSeen` get written by the `://climbs?screenshotOpenPreview=1` deep
link (deliberately, see the comment in `app/(tabs)/climbs/index.tsx`), and the
hold filter's paint colour is left on Finish rather than Hand.
