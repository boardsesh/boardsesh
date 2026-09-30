# Homepage showcase video: recording the app footage

The homepage showcase video is three pieces that share one contract
(`scripts/lib/showcase-video/contract.ts`):

1. **`vp run video:record`** (this doc) drives iOS simulators and writes the app
   footage: a 30 fps JPEG sequence per take plus where each callout target sat
   on screen.
2. The mobile app, in screenshot mode, logs those callout positions
   (`useShowcaseAnchor`) and fakes a Bluetooth board so the bulb lights.
3. **`vp run video:render`** lays the footage into `marketing/showcase-video/`
   and encodes the web video.

`vp run video` runs both. After any native release, or any change to a screen a
take shows, re-record: the footage is a picture of the app, and it goes stale
the moment the app changes.

## Prerequisites (macOS only)

- Xcode with an iOS 26 simulator runtime.
- Maestro (`curl -Ls "https://get.maestro.mobile.dev" | bash`) and a JDK 21 at
  `~/.cache/boardsesh/jdk-21` (the recorder sets `JAVA_HOME` to it when it
  exists). On Apple silicon that is a macOS aarch64 Temurin 21.
- `ffmpeg` (`brew install ffmpeg`, or `FFMPEG_BIN`).
- The screenshot dev-client `.app`. `--app-path` takes a built one; without it
  the recorder builds one into `packages/mobile/.app-cache/` (about 30 min, once).
- Port 8081 free: the dev-client loads its bundle from `localhost:8081`.
- A few GB of free disk. Raw recordings, Metro caches and Maestro's debug output
  all land on it; a full disk shows up as Postgres or Maestro failing, not as a
  clear error.

### Credentials

The default backend is **prod**, for real content. Two accounts sign in:

| Phone | Account | Where the password comes from |
| --- | --- | --- |
| Primary (recorded) | `test@boardsesh.com`, the App Store account | `SCREENSHOT_USER_PASSWORD` |
| Secondary (crew take only) | Marco's own account | `SHOWCASE_SECONDARY_EMAIL`, `SHOWCASE_SECONDARY_PASSWORD` |

The recorder reads these from the environment, and from `--env-file`
(default `~/.config/boardsesh/showcase-secrets.env`, mode 600, outside the
repo). The file may only set those four keys; anything else in it is ignored.
Never commit either password, and never paste them into a PR.

To fill the env file from 1Password without the values touching disk, keep
`op://` references in a file and let `op run` resolve them:

```sh
cat > ~/.config/boardsesh/showcase-secrets.op.env <<'EOF'
SCREENSHOT_USER_PASSWORD=op://<vault>/<App Store test account item>/password
SHOWCASE_SECONDARY_EMAIL=op://<vault>/Boardsesh Login/username
SHOWCASE_SECONDARY_PASSWORD=op://<vault>/Boardsesh Login/password
EOF
op run --env-file ~/.config/boardsesh/showcase-secrets.op.env -- vp run video:record
```

Both passwords are baked into the screenshot JS bundle (that is how screenshot
mode signs in without a login screen), exactly like every App Store capture.
The second phone's bundle is built in its own Metro cache under
`.boardsesh/showcase-video/work/secondary-metro-tmp/`, and teardown deletes that
cache and uninstalls the app from the second simulator.

`--backend local` uses the seeded dev DB instead (`test@boardsesh.com` / `test`,
plus a crew account the recorder registers). No credentials needed, but the
content is fixture data.

## Re-record everything

```sh
SCREENSHOT_USER_PASSWORD=... vp run video:record -- --app-path <Boardsesh.app>
```

One command, no manual steps. It:

1. creates (once) and boots two dedicated simulators, "Boardsesh Showcase" and,
   for the crew take, "Boardsesh Showcase 2" (iPhone 16 Pro Max, status bar at
   9:41, app in UTC), resets their keychains and installs the dev-client;
2. starts Metro with the screenshot-mode env (`EXPO_PUBLIC_SCREENSHOT_MODE=1`,
   `EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1`, the walls in `EXPO_PUBLIC_SCREENSHOT_BOARDS`,
   the account) and waits for the app to reach home. The second phone gets its
   own Metro and a copy of the `.app` whose launcher URL points at it;
3. per take: relaunches the app (so the one-shot deep-link params fire again),
   opens the take's deep links, starts `simctl io recordVideo`, runs the take's
   Maestro flow while collecting `[showcase-anchor]` lines from Metro's output,
   stops the recording with SIGINT, and cuts Maestro's attach time off the head;
4. writes `.boardsesh/showcase-video/work/footage/<take>/%05d.jpg` (800 px wide,
   constant 30 fps) and `.boardsesh/showcase-video/work/anchors/<take>.json`;
5. checks every take (below), prints a summary, and tears everything down:
   the crew take's live session is ended, Metro, the backend it started and the
   simulators are stopped. Ctrl-C does the same.

Useful flags:

| Flag | What it does |
| --- | --- |
| `--only crew` | Record one take (repeat or comma-separate for more). Other takes' footage is left alone. |
| `--backend local` | Seeded dev DB: runs `vp run db:up`, starts a backend of its own on 8180+, seeds a MoonBoard and a crew account. `SHOWCASE_LOCAL_BACKEND_URL` reuses a running backend. |
| `--boards "A\|B\|…"` | The kilter, tension, moonboard, woods, decoy and grasshopper walls, by name, in that order. |
| `--app-path <app>` | Install this dev-client instead of building one. |
| `--keep-raw` | Keep the raw `.mov` under `work/raw/` (otherwise deleted once the frames are out). |
| `--skip-anchor-check` | Record without requiring the callout anchors. |
| `--env-file <path>` | Where the credentials file is. |
| `--dry-run` | Print the plan and which credentials are set; touch nothing. |
| `--end-session <id>` | Record nothing: rejoin that session on the primary and end it (a crashed run's leftover; the crew take logs the id). |

Logs: `.boardsesh/showcase-video/work/logs/` (Metro per phone, the backend,
and every Maestro run's console and debug output).

## The takes

`scripts/lib/showcase-video/takes.ts` is the registry; each take's flow is in
`packages/mobile/.maestro/showcase/`, with a header naming what it records and
what every coordinate hits.

| Take | Deep links before recording | What the flow does |
| --- | --- | --- |
| `light` | `climbs?screenshotOpenFirst=1&screenshotBoardIndex=0` | Taps the bulb (the fake board lights at once), swipes to the next climb twice. |
| `boards-<type>` (8) | `climbs?screenshotOpenFirst=1&screenshotBoardIndex=N`, or a board-config link | Holds a lit climb still for 6.5 s. |
| `wall` | `climbs?screenshotBoardIndex=0` | Taps the board button; the sheet shows the climb on the wall, then drags up to "Lit on this wall". |
| `crew` | the first climb, then `record` | See below. |
| `workouts` | the first climb, then `record` | Picks Pyramid, arms a fixed-window 0:30 rest timer, taps Start (a private session, ended afterwards). |
| `lock-screen` | the first Tension climb, then `record` | See below. The id stays; the take shows the Dynamic Island. |
| `log` | `profile` | Scrolls to the activity calendar, filters Progress to Kilter, then Tension. |

### Walls

Kilter, Tension, MoonBoard, Woods, Decoy and Grasshopper are walls on the App
Store account, picked by name (`SHOWCASE_DEFAULT_BOARDS` in `record.ts`, slot
order in `SHOWCASE_BOARD_SLOTS`). The account has no Touchstone or So iLL wall,
so those takes deep-link a board CONFIG (`touchstone/1/1/1/40/list`,
`soill/1/2/1/40/list`, `SHOWCASE_BOARD_CONFIG_LINKS` in `takes.ts`). The app
resolves that the way a session join does: it reuses a matching board on the
account or ADDS one to the account's own boards list. So the first prod run
adds a Touchstone and a So iLL board to `test@boardsesh.com`; every later run
reuses them. The take checks the link's `Board Route Handoff` resolved.

On `--backend local` the dev DB has only the first three walls; the other
board takes are skipped with a note.

### Live sessions

`crew`, `workouts` and `lock-screen` start a live session on the account. Each
first runs `session-private.yaml` ("Show this session live" off; the recorder
stops unless the app logged it) and afterwards `session-end.yaml`, on a fresh
relaunch so no sheet covers Stop. Teardown runs it again on a failure or
Ctrl-C, and a take that finds a session restored on launch ends it first.

### The lock-screen take (the Dynamic Island)

A private session on the Tension wall with two more climbs queued and the fake
board connected, then Home, onto an empty home screen (dark wallpaper only):
the Live Activity sits in the island; a long press expands it (climb, grade, "2 of 4", Prev / relight / Mirror / Next), and
Next changes the climb from outside the app. The simulator is set to dark
appearance so the wallpaper behind the island is dark.

The empty home screen is made once per run by `home-screen-clean.yaml` (the
take's `deviceSetupFlows`, after the install). It first sets Settings > Home
Screen & App Library to "App Library Only", so apps installed later (Maestro
reinstalls its runner on every run) stay off the home screen; then it takes
every widget, app,
folder and dock icon off the home screen of the dedicated "Boardsesh Showcase"
simulator, Boardsesh and Maestro's own runner included ("Remove from Home
Screen" only; everything stays installed and in the App Library, and
`simctl launch` still opens Boardsesh). It is idempotent, so an empty screen
costs one lookup.

Three things make the Live Activity work on a simulator:

- **The Live Activity starts only with the push entitlement.** It is requested
  with `pushType: .token`, and ActivityKit refuses that without
  `aps-environment` (`LA_START_FAILED … ActivityInput error 0`). The screenshot
  simulator build carries it (`scripts/screenshot-sim.entitlements`), together
  with the team-prefixed keychain group the native shared keychain uses. A
  dev-client built before that change needs a rebuild:
  `vp run mobile:build-sim-app -- --app-out packages/mobile/.app-cache`.
- **Screenshot builds drive the island's Next locally.** In a party session the
  intent authorises each tap with the Live Activity's APNs token; prod pushes
  through production APNs, rejects the simulator's sandbox token and deletes
  it, and every tap is a 401. `live-activity-bridge.tsx` passes
  `isPartySession: false` in screenshot mode, so the tap updates the activity
  and hands the move to JS, which sends the queue mutation over the socket.
- **The island's buttons can't log anchors** (they are SpringBoard's). The flow
  raises the `island-expanded` mark and the recorder writes `lock-relight`,
  `lock-mirror` and `lock-next` from the rects in the take registry, measured
  on a recorded frame. Re-measure them if the widget layout changes.

### The crew take

Two phones in one live session. Replay fixtures cannot animate a subscription,
so this needs a live backend.

1. Primary: switches "Show this session live" off (the recorder refuses to go
   on unless the app logged that), starts the session, opens the invite sheet
   and taps Copy link (`session-private.yaml`, `crew-start.yaml`).
2. The recorder reads the link with `xcrun simctl pbpaste`, and sends the second
   phone to `com.boardsesh.app://join/<id>`, where `crew-join.yaml` taps Join.
3. The second phone starts `crew-secondary.yaml`, which polls the recorder's
   signal server. Recording starts on the primary's QR.
4. `crew.yaml` closes the sheet, opens the queue, raises the `crew-add` signal;
   the second phone swipes a climb into the queue and its row lands on the
   primary with the second account's avatar. A long press on it shows
   "Play next". The row's place depends on the queue's history, so the flow
   reads it from the row's anchor, which the recorder republishes on the signal
   server (`/value/anchor-<name>-x|-y|-cy`).
5. `session-end.yaml` ends the session, after a relaunch so no sheet swallows the
   Stop tap. It also runs on a failure or Ctrl-C, and a crew take that finds a
   session restored on launch ends it before starting its own.

Why a signal server: two Maestro processes each take 4-7 s to attach, so a
timed wait cannot line them up. The flows `GET` the recorder's local server
(`/mark/<name>`, `/set/<name>`, `/signal/<name>`) with Maestro's JavaScript
`http.get`. The same `/mark/flow-start` request, the first step of every take's
flow, tells the recorder exactly where to cut the head.

### Marks: when things happen

Besides footage and anchors, every take writes
`.boardsesh/showcase-video/work/marks/<take>.json` (`ShowcaseMarksFile` in
`contract.ts`): `{ "takeId", "marks": { "<name>": <seconds> } }`, seconds from
the start of the trimmed footage, sorted by time. Place cuts and callouts on
these instead of hand-read frame numbers; a re-record moves them with the
footage.

The flows raise them on the recorder's signal server
(`- evalScript: ${http.get(SHOWCASE_SIGNAL_URL + '/mark/<name>')}`) right after
the step's action, so a mark is the moment the action was sent; allow a few
frames for the app to draw it.

| Take | Marks |
| --- | --- |
| `light` | `bulb-tapped`, `next-1`, `next-2` |
| `boards-*` | none (held still) |
| `wall` | `sheet-open`, `history-shown` |
| `crew` | `invite-closed`, `queue-open`, `crew-added` (the second phone's swipe), `row-landed` (derived: the new row's anchor first logged), `play-next-menu` |
| `workouts` | `pyramid-picked`, `rest-armed`, `rest-pill`, `started` |
| `lock-screen` | `home`, `island-expanded`, `next-tapped` |
| `log` | `scrolled`, `filter-kilter`, `filter-tension` |

A mark the flow never reached is simply absent. To add one, raise it in the
flow and list it in the flow header and this table; a mark derived from an
anchor goes in the take's `anchorMarks`.

### What the anchors files do and do not say

- Every anchor the app logged since the take's relaunch is in the file, pinned
  to `t = 0` if it came before the footage starts. Hidden tabs mount at boot, so
  a take's file also holds anchors from screens it never shows
  (`workout-type` in a board take). Read only the callouts the scene draws.
- An anchor inside a native sheet (`invite-qr`, `queue-row-avatar`,
  `now-on-wall`, `wall-history`) is measured in the SHEET's window, so its `y`
  is from the sheet's top, not the screen's (the queue sheet's top is 322 pt
  down at its detent).
- An anchor re-logs on layout, not on scroll. After the log take's scroll,
  `profile-board-filter` and `activity-calendar` still carry their pre-scroll
  `y`.

## Adding or changing a take

1. Add the id to `SHOWCASE_TAKE_IDS` in `contract.ts` and give a scene in
   `timeline.ts` the take; its length there sets the take's minimum duration.
2. Add an entry to `SHOWCASE_TAKES` in `takes.ts`: deep links, flow, board slot
   (checked against the app's `[screenshot] board[N]` log), setup/teardown flows.
3. Write the flow in `packages/mobile/.maestro/showcase/`. The first step must be
   `- evalScript: ${http.get(SHOWCASE_SIGNAL_URL + '/mark/flow-start')}`.
   Coordinates are whole-number percentages (Maestro will not parse `34.5%`);
   pauses are `extendedWaitUntil` on text that is never on screen, since Maestro
   has no `sleep` and each step costs about 1.5 s of hierarchy dumping anyway.
4. `vp run video:record -- --only <take> --keep-raw`, then look at a few frames.
   `vp test run --project scripts --reporter=agent` checks the registry, flows
   and pure logic.

To pin a take's opening screen, drop its first frame at
`marketing/showcase-video/reference/<take>.jpg`; the recorder then fails a take
whose first frame differs in more than 35% of thumbnail pixels.

## When the self-check fails

Each failure names the take. The fixes:

| Message | Cause | Fix |
| --- | --- | --- |
| `footage is Xs, the scene needs Ys` | The flow ended too soon after the trim. | Lengthen the flow's last pause. |
| `the first frame is blank` | The app had not drawn when the footage starts. | Raise the flow's opening pause; check the raw with `--keep-raw`. |
| `differs from marketing/showcase-video/reference/<take>.jpg` | The take opened on another screen: a moved button, a dialog, a changed deep link. | Fix the flow or deep links; replace the reference if the screen changed on purpose. |
| `wrong wall: slot N matched no wall (board roster: ...)` | The account has no wall by that name (renamed, unfollowed). | `--boards` with names from the roster, or update `SHOWCASE_DEFAULT_BOARDS` in `record.ts`. |
| `wrong wall: slot N landed on a non-<kind> wall` | The name matched a different board type. | Put a wall of that type in that slot. |
| `never logged anchor(s) ...` | The flow never reached the screen, or the bundle lacks the anchor hooks. | Check the flow's coordinates against a screenshot; `--skip-anchor-check` only while the hooks are missing. |
| `its flow ... failed (Maestro exit N)` | A Maestro step failed. | Read `work/logs/maestro/<run>/console.log`. |
| `"Show this session live" was not switched off` | The switch tap missed, or a session was already running. | End any running session on the account; check the point in `session-private.yaml`. |
| `could not confirm the live session ended` | The end tap missed or the backend refused. Teardown retries once on exit. | `vp run video:record -- --end-session <id>` with the id from `hidden session <id> started`. "Session not found" there means the backend already closed it. |
| `never reached home` | Sign-in failed or the bundle did not load. | Read `work/logs/metro-<phone>.log`: a wrong password shows as `auto sign-in FAILED`. |
| `Port 8081 is taken` | Another Metro is running. | Stop it; the dev-client only loads from 8081. |

## Where things live

| Path | What |
| --- | --- |
| `scripts/showcase-video-record.ts` | The orchestrator (processes, simulators, files). |
| `scripts/lib/showcase-video/record.ts` | Pure logic: args, ffmpeg args, anchor stamping, self-check. |
| `scripts/lib/showcase-video/takes.ts` | The take registry. |
| `packages/mobile/.maestro/showcase/` | One flow per take, plus the crew setup/teardown flows. |
| `.boardsesh/showcase-video/work/` | Footage, anchors, raw recordings, logs (gitignored). |
