# Homepage showcase video: recording the app footage

The homepage showcase video is three pieces that share one contract
(`scripts/lib/showcase-video/contract.ts`):

1. **`vp run video:record`** (this doc) drives iOS simulators (or, with
   `--platform android`, an Android emulator) and writes the app
   footage: a 30 fps JPEG sequence per take plus where each callout target sat
   on screen.
2. The mobile app, in screenshot mode, logs those callout positions
   (`useShowcaseAnchor`) and fakes a Bluetooth board so a session has a wall
   to light.
3. **`vp run video:render`** lays the footage into `marketing/showcase-video/`
   and encodes its targets: the homepage hero, social masters, a Reels / ad
   cut, an Apple App Preview and a Play promo (see [Targets](#targets)).

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

| Phone | Account | Env vars |
| --- | --- | --- |
| Primary (recorded) | `test@boardsesh.com`, the App Store account | `SCREENSHOT_USER_PASSWORD`; `SCREENSHOT_USER_EMAIL` overrides the email (default `test@boardsesh.com`) |
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
| `--boards "A\|B\|…"` | The seven walls by name, in slot order: kilter, tension, moonboard, woods, decoy, grasshopper, spray. |
| `--app-path <app>` | Install this dev-client instead of building one. |
| `--keep-raw` | Keep the raw `.mov` under `work/raw/` (otherwise deleted once the frames are out). |
| `--skip-anchor-check` | Record without requiring the callout anchors. |
| `--env-file <path>` | Where the credentials file is. |
| `--dry-run` | Print the plan and which credentials are set; touch nothing. |
| `--end-session <id>` | Record nothing: rejoin that session on the primary and end it (a crashed run's leftover; the crew take logs the id). |
| `--platform android` | Film on the Android emulator instead (see [Android recording](#android-recording)). |
| `--hold` | Stop once the phone is ready and wait for Ctrl-C, for calibrating flows by hand. |

Logs: `.boardsesh/showcase-video/work/logs/` (Metro per phone, the backend,
and every Maestro run's console and debug output).

## The takes

`scripts/lib/showcase-video/takes.ts` is the registry; each take's flow is in
`packages/mobile/.maestro/showcase/`, with a header naming what it records and
what every coordinate hits.

| Take | Deep links before recording | What the flow does |
| --- | --- | --- |
| `boards-<type>` (9) | `climbs?screenshotOpenFirst=1&screenshotBoardIndex=N`, or a board-config link | Holds a lit climb still for 7 s. |
| `spray` | `climbs?screenshotOpenFirst=1&screenshotBoardIndex=6` | The first climb on the spray wall's photo, then two swipes to the next climb. |
| `wall` | `climbs?screenshotBoardIndex=0` | Taps the board button; the sheet shows the climb on the wall, then drags up to "Lit on this wall". |
| `crew` | the first climb, then `record` | See below. |
| `workouts` | the first climb, then `record` | Picks Pyramid, arms a fixed-window 0:30 rest timer, taps Start (a private session, ended afterwards). |
| `lock-screen` | the first Tension climb, then `record` | See below. The id stays; the take shows the Dynamic Island. |
| `log` | `profile` | Scrolls to the activity calendar, filters Progress to Kilter, then Tension. |

### Walls

Kilter, Tension, MoonBoard, Woods, Decoy, Grasshopper and the spray wall are
seven walls on the App Store account, picked by name (`SHOWCASE_DEFAULT_BOARDS`
in `record.ts`, slot order in `SHOWCASE_BOARD_SLOTS`; the spray wall is slot 6).
The account has no Touchstone or So iLL wall,
so those takes deep-link a board CONFIG (`touchstone/1/1/1/40/list`,
`soill/1/2/1/40/list`, `SHOWCASE_BOARD_CONFIG_LINKS` in `takes.ts`). The app
resolves that the way a session join does: it reuses a matching board on the
account or ADDS one to the account's own boards list. So the first prod run
adds a Touchstone and a So iLL board to `test@boardsesh.com`; every later run
reuses them. The take checks the link's `Board Route Handoff` resolved.

The spray wall is filmed twice: held still as `boards-spray`, one of the nine
board phones, and with two swipes as `spray`, the scene of its own. Its photo is
fetched, so both takes give the last deep link 8 s to draw before recording
starts (`primeSettleMs` in `takes.ts`; every other take gets 3 s). The default
name is `Plywood Spray Wall`; point slot 6 at another wall with `--boards`.

The wall's photo is a crop of
[a Wikimedia Commons photo](https://commons.wikimedia.org/wiki/File:SZ_%E6%B7%B1%E5%9C%B3_Shenzhen_%E7%A6%8F%E7%94%B0_Futian_%E6%9C%83%E5%B1%95%E4%B8%AD%E5%BF%83%E5%9F%8E_Link_Central_Walk_Mall_shop_%E6%94%80%E7%9F%B3%E7%89%86_rock_climbing_wall_club_June_2025_R12S_03.jpg)
by WAOSNMAH wocnaprm, released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so it needs no
credit in the video or the store cuts. The crop (the right-hand panel, 2110 x 2090,
which leaves out the gym's logo and the camera's date stamp) is committed as
`marketing/showcase-video/spray-wall-photo.jpg`, so the wall can be rebuilt on
another account. Keep the wall private: a public wall copies the photo into the
world-readable media bucket and lists the wall.

The wall check reads the board type from the app's own log line, which ends
with it: `[screenshot] board[6] "Plywood Spray Wall" -> "<name>" (<layout> L..
S.. @..°, spray)`. A spray wall's name and layout are whatever its owner typed, so
the type is never taken from either (`findBoardSlotProblem` in `record.ts`).

On `--backend local` the dev DB has only the first three walls; the other
board takes and `spray` are skipped with a note.

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
  with the team-prefixed keychain group the native shared keychain uses.
  That group hardcodes the team ID (`9L3HKPZBH3`): a simulator build has no
  provisioning profile to expand `$(AppIdentifierPrefix)` in entitlements,
  while the app's Info.plist (`BoardseshKeychainAccessGroup`) gets it from the
  project's team. The recorder checks the two agree before any take and, for a
  run with the island take, stops with the fix if the team ID ever changes;
  the scripts tests hold the file to `appleTeamId` in `app.config.ts`. A
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
| `boards-*` | none (held still) |
| `spray` | `next-1`, `next-2` (the two swipes) |
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

The renderer corrects both per take in `SHOWCASE_TAKE_EDITS`
(`scripts/lib/showcase-video/render.ts`), next to each scene's footage ranges
and callout windows. Every time there is an offset from one of the take's
marks (a scroll correction applies from `scrolled`, the wall sheet's drag from
`history-shown`), so a re-record needs no edits. A render stops, naming the
take and the marks, when a mark the edit reads is missing or a segment runs
off the footage. The one exception is a scene's last segment running up to
1.5 s past the end of its take: the render holds the last frame and warns
instead. A segment can also hold its last frame on purpose (`hold`, in
seconds) where the screen is still, which is how a callout gets its reading
time when the app moves on sooner. `vp run video:render -- --stills --measure`
shows every callout box over the recorded frames when you want to look.

### Reading time

Every render prints the reading budget as a table: per scene, the headline
words, the callout words, how long the text is settled and how long it needs
(0.3 s a word, headline and callouts together); per callout, how long it sits
fully settled (box, leader and pill all in, until it or the scene's text starts
out) against max(1.6 s, 0.45 s a word). Callout entrances are at least 0.5 s
apart. `showcase-video-render.test` holds all of it on the recorded marks, so a
change to a scene's length, an edit window or the copy that leaves a callout
unread fails the tests before it reaches a render.

### The donation line

The outro's small line under the store pill, "Paid for by the climbers who use
it." (`copy.en-US.json` `outro.donation`), uses the homepage's `proofNoCount`
wording. It never claims tax relief or perks. Store listings must never mention
donations, so the store and ad targets (`reel`, `app-store`, `play-promo`) are
defined without it (`donationLine: false`) and their outros are 129 frames, the
length the shorter outro's reading budget needs. `homepage` and `social` keep it.

`--no-donation-line` still works as an override: it drops the line from every
target it renders and leaves out `homepage`, whose files always keep it (with a
warning; asking for `--target homepage` with it fails instead).

## Targets

`vp run video:render -- --target <name>` renders one target from the same
recorded takes; `--target all` renders every one, and `--target` repeats or
takes a comma list. With no `--target` it renders `homepage` and `social`,
which is what `vp run video` ships. The registry is
`scripts/lib/showcase-video/targets.ts`: per target the layout, size, scenes and
their order, length cap, donation line, audio, outputs, and whether it may write
into `packages/web/public` (only `homepage` may). `showcase-video-targets.test`
holds all of that, and pins `homepage` field for field so a refactor can't
change the hero.

| Target | Layout | Size | Scenes | Length | Donation line | Audio | Writes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `homepage` | motion | 1080x1920 → 720x1280 lite | all eight | 54.8 s | yes | none | `packages/web/public/videos/home/showcase-9x16-lite.{webm,mp4}`, `public/images/home/showcase-hero-9x16.webp` |
| `social` | motion | 1920x1080 and 1080x1920 | all eight | 54.8 s | yes | none | `out/social/brag.mp4`, `brag-9x16.mp4`, `brag*.jpg`, `share-copy.txt` |
| `reel` | motion, safe-area stage | 1080x1920 | boards, spray, crew, island, outro | 29.9 s | no | silent stereo AAC | `out/reel/reel-9x16.mp4`, `.jpg` |
| `app-store` | full-bleed | 886x1920 | five clips: spray, wall, crew, island, log | 28.5 s | no | silent stereo AAC, 256 kbit/s | `out/app-store/iphone-6.9.mp4`, `iphone-6.5.mp4` (same file), `iphone-poster.jpg` |
| `play-promo` | motion | 1920x1080 | boards, spray, crew, island, log, outro | 38.1 s | no | silent stereo AAC | `out/play/play-16x9.mp4`, `.jpg` |

`out/` is `.boardsesh/showcase-video/out/` (gitignored). Only the `homepage`
files are committed. `homepage` and `social` 9:16 render the same frames, so
the browser runs once for both. `--format 16x9|9x16` keeps only the renditions
of one format (a named target with no rendition in it fails; a default or
`all` target is left out with a warning); `--stills`, `--measure` and `--frame` work per target and write
under `out/stills/<target>/`.

**Motion vs full-bleed.** `motion` is the stage in `index.html`: the phone
mockup, callouts and motion-graphic scenes. `full-bleed` is `full-bleed.html`:
the recorded footage fills the frame (800x1738 footage scaled to cover
886x1920, about 1.1x, 2 px cropped top and bottom) with a one-line caption bar
(Inter Tight 800, five words at most, `copy.en-US.json` `appStore.captions`) and
nothing else. Each clip is cut on the take's marks like `SHOWCASE_TAKE_EDITS`.
The bar sits over the status bar, except on the island clip, where it sits over
the empty wallpaper below the Dynamic Island. Clips cut hard; a caption fades
out before its cut, so no transition suggests something the app doesn't do.
The island clip is the recorded Live Activity as it is.

**The reel's safe area.** Meta's Reels and Stories ads margins at 1080x1920:
14% top (270 px), 35% bottom (672 px, the caption, CTA and like rail), 6% each
side (65 px), from Meta's [Reels ad specs](https://www.facebook.com/business/ads-guide/update/image/instagram-reels)
and [text overlay safe zone](https://www.facebook.com/business/help/980593475366490),
checked 2026-10-01. These are stricter than the organic Reels overlays (~250 px
top, ~420 px bottom), so one file serves both. The `safe` stage variant puts
headlines at 300 px, shrinks the callout phone to 0.76 and lifts it so the
whole phone sits in the text band (520–1204 px), pulls the pills 72 px in from
the edges and clamps them inside the band, and fades the board labels before
the pile sinks. The renderer reads every text element's box from the page
(`textBoxes()`) on every third frame and on every still, and fails the render
if any word crosses a margin; `--measure` draws the band as a dashed box.

**Apple's App Preview spec**, from
[App preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications)
and [App previews](https://developer.apple.com/app-store/app-previews/), read
2026-10-01. `APPLE_APP_PREVIEW_SPEC` in `targets.ts` holds the numbers, and the
renderer probes the encode and fails when it misses any of them:

| Spec | Apple | What we render |
| --- | --- | --- |
| iPhone 6.9" and 6.5" portrait (also 6.7", 6.3", 6.1") | 886 x 1920 | 886 x 1920, one file copied to both slots |
| Length | 15–30 s | 28.5 s |
| Frame rate | 30 fps max | 30 fps, progressive |
| Video | H.264 up to High Profile Level 4.0, 10–12 Mbit/s target (or ProRes 422 HQ) | H.264 High 4.0, CBR 11 Mbit/s, `.mp4` |
| Audio | stereo; H.264 files 256 kbit/s AAC, 44.1 or 48 kHz; all tracks enabled | silent stereo AAC 256 kbit/s, 48 kHz |
| File size | 500 MB max | about 40 MB |
| Content | only content from within the app; no people or hands on a device; overlays and captions allowed, legible and on screen long enough to read; no prices or dated references | the recorded app footage only, no device frame; captions of five words or fewer, at least 1 s longer than 0.3 s a word |
| Poster frame | 5 s by default | `iphone-poster.jpg` is frame 150 (5 s) |

The 5.5" slot (1080 x 1920) and iPads (1200 x 1600) are not rendered: an iPhone
preview at 886 x 1920 covers every current iPhone slot.

## Android recording

```sh
SCREENSHOT_USER_PASSWORD=... vp run video:record -- --platform android
```

The same takes, filmed on an Android emulator, into
`.boardsesh/showcase-video/work/android/{footage,anchors,marks}/`
(`showcaseWorkDirs('android')` in `contract.ts`). iOS stays the default and
keeps `work/{footage,anchors,marks}/`. No manual steps:

1. **SDK.** `vp run mobile:android-doctor` once (SDK and JDK 21 under
   `~/.cache/boardsesh/`). The recorder installs the system image it needs
   (`android-36;google_apis`, arm64 on Apple silicon, about 1.5 GB) on first
   use.
2. **Emulator.** A dedicated AVD, `Boardsesh_Showcase`, created from the
   `pixel_7` profile with its screen set to a Pixel 9-class 1080 x 2424 at 420
   dpi, so 411 x 923 dp (`SHOWCASE_ANDROID_DEVICE` in
   `scripts/lib/showcase-video/android.ts`). `config.ini` is rewritten on every
   boot, so a hand edit cannot drift it. It boots headless on port 5580
   (`emulator-5580`), in UTC, cold, with dark system UI. An emulator already
   running on that port is reused and left running.
3. **App.** The dev-client APK (`com.boardsesh.app.dev`) from the latest
   `rn-android-dev-*` release (`scripts/mobile-android-apk.ts`), or
   `--app-path <apk>`. It is reinstalled every run with notifications allowed.
   Metro runs on 8081 with the same screenshot and fake-Bluetooth env as iOS;
   `adb reverse` maps the emulator's `localhost:8081` to it.
4. **Status bar.** SystemUI demo mode (09:41, full wifi and battery, no mobile
   signal, no notification icons), and the system's own notifications
   ("Serial console enabled") snoozed. Both are re-sent before every take:
   SystemUI drops them while it is still settling after boot, and nothing
   reports whether they took.
5. **Recording.** `adb shell screenrecord` at 12 Mbit/s. It stops itself at
   180 s, so a longer take records in parts that are pulled and joined without
   re-encoding. Stop is SIGINT to `screenrecord` on the device, which finalises
   the mp4. From there the pipeline is the iOS one: the same ffmpeg pass to
   constant 30 fps JPEGs at 800 px wide (800 x 1796), anchors from Metro's log
   (dp), marks from the signal server.

`--hold` stops after the device is ready (app at home, Metro up) and waits for
Ctrl-C, for calibrating a flow by hand against the same emulator.

**Flows.** A flow in `packages/mobile/.maestro/showcase/android/` replaces
the shared flow of the same name on Android (`showcaseFlowPathFor`), so the
two platforms never share a coordinate. Every flow the Android primary runs has
an Android file (a test checks this): Material UI puts things elsewhere, and
Maestro needs the dev-client's package as `appId`. Take-level differences
(setup flows, static anchors) live in each take's `platforms.android` entry in
`takes.ts` (`takeForPlatform`).

What changes per take:

| Take | On Android |
| --- | --- |
| `boards-*`, `spray`, `log`, `workouts` | Same story, own coordinates. The shorter screen keeps the workout preview below the fold. |
| `wall` | The Climbs header has no board glyph on the right ("+" is a new climb); the sheet opens from the board name ("Marco's Board", the `board-history-button` anchor) at half height. |
| `crew` | The queue sheet is dragged to full height (history rows can push the new row below the fold at half height), and there is no "Play next" beat (see the app bugs below). The second phone is the iOS simulator, see below. |
| `lock-screen` | The ongoing "session" notification in the shade instead of the Dynamic Island: Home, a swipe down from the status bar (the notification is expanded as the first one), Next by its label. No relaunch between setup and arm (a relaunch leaves the first climb without its thumbnail) and no home-screen cleanup (the shade covers it). |

**The crew take's second phone is the iOS simulator.** Nothing of the second
phone is filmed, so its platform does not show, and it reuses the iOS
`crew-join.yaml` / `crew-secondary.yaml` that already work against prod. A
second emulator would need its own 4 GB of RAM, a second cold boot (a minute or
two), and its own calibrated flows. The Android primary cannot hand the invite
link over by clipboard (`simctl pbpaste` has no emulator twin), so
`crew-start.yaml` only taps Start, the recorder relaunches the app, reads the
id from its `[session] restored from store: <id>` log line, and
`crew-invite.yaml` opens the invite sheet so recording starts on the QR.

**Two app bugs the recording found (not recorder ones).**

1. [#5922](https://github.com/boardsesh/boardsesh/issues/5922): the notification's Next moves the queue on the phone only in a session: on
   Android nothing sends the server mutation that the iOS widget intent sends
   (`dispatchWidgetNavigation` in
   `packages/mobile/src/providers/queue-provider.tsx` assumes native did), so
   a few seconds later the queue's hash check pulls the server state back and
   the climb reverts. The take ends before that happens.
2. [#5923](https://github.com/boardsesh/boardsesh/issues/5923): a long press on a row in the Android queue sheet lands as a tap: the row
   plays instead of opening the reaction menu. It happens with Maestro's long
   press and with adb's raw `DOWN` / `UP` 1.2 s apart, so the crew take skips
   "Play next" on Android. Worth checking on a real phone.

## Android cuts (renderer)

`vp run video:render -- --platform android` cuts the Android recording
(`vp run video:record -- --platform android`, same take ids) instead of the
iOS one. The platform decides four things and nothing else:

1. **Footage.** `work/android/{footage,anchors,marks}/` (`showcaseWorkDirs` in
   `contract.ts`), never `work/footage/`. `--placeholder-footage` builds iOS
   stand-ins, so the render refuses it with `--platform android`.
2. **The phone.** A Pixel-style body (`pixelPhone` in `render.ts`) instead of
   the iPhone 16 Pro Max: the same 900 px height, so every pose, shadow and
   board label lands where it does on iOS; a 390 x 876 screen, the width taken
   from the recorded frames' aspect (800 x 1796, the 1080 x 2424 emulator
   screen); a 3 px matte aluminium band, a 9 px bezel, 48 px outer corners
   (36 px on the screen against the iPhone's 57); a 12 px punch-hole camera
   centred 14 px from the top; power button and volume rocker on the right edge
   only. The stage draws both phones from one set of CSS variables
   (`data.phone`, `#stage[data-platform]`), so the iOS frames are unchanged.
3. **Copy.** The `android` block in `copy.en-US.json` overrides single scenes
   (`copyForPlatform`). Today that is the island scene, which on Android is the
   "Active climbing session" notification: headline "Control the wall from
   *notifications.*", and the bulb callout reads "Relight wall", the
   notification's own label. "Next" and "Mirror climb" are shared.
4. **Targets.** Android has its own registry (`SHOWCASE_ANDROID_TARGETS` in
   `targets.ts`), each an iOS target with the same scenes, stage, length,
   donation line and audio:

| Target | Follows | Size | Length | Writes |
| --- | --- | --- | --- | --- |
| `homepage-android` | `homepage` | 1080x1920 → 720x1280 lite | 54.8 s | `packages/web/public/videos/home/showcase-9x16-lite-android.{webm,mp4}`, `public/images/home/showcase-hero-9x16-android.webp` |
| `social-android` | `social` | 1920x1080 and 1080x1920 | 54.8 s | `out/android/social/brag.mp4`, `brag-9x16.mp4`, `brag*.jpg`, `share-copy.txt` |
| `reel-android` | `reel` | 1080x1920, safe-area stage | 29.9 s | `out/android/reel/reel-9x16.mp4`, `.jpg` |
| `play-promo-android` | `play-promo` | 1920x1080 | 38.1 s | `out/android/play/play-16x9.mp4`, `.jpg` |

`app-store` has no Android variant: an App Preview is iOS footage.
`homepage-android` is the only Android target that writes into
`packages/web/public`, and the homepage does not load its files yet.

**Which targets run.** `--platform` picks the registry and `--target` names
targets in it. `all` is every target of that platform, and no `--target` is
that platform's pair: `homepage` + `social` on iOS (what `vp run video` ships,
unchanged), `homepage-android` + `social-android` on Android. A name from the
other registry stops the render and says which `--platform` it needs, so one
run never mixes the two recordings.

```sh
vp run video:render -- --platform android                                  # homepage-android + social-android
vp run video:render -- --platform android --target reel-android,play-promo-android
vp run video:render -- --platform android --target all --stills --measure  # check every callout box
```

**The edit.** The Android takes raise the iOS marks (`home` is the Home
press, `island-expanded` the shade pulled down with the notification expanded,
`next-tapped` the Next tap), and the recorder writes `lock-next`,
`lock-relight` and `lock-mirror` for the notification's buttons (Next and
Relight wall move right when Next adds "Previous", so their rects change at
`next-tapped`). `SHOWCASE_ANDROID_TAKE_EDITS` in `render.ts` starts from the
iOS edit and replaces what the Android recording measured differently:

| Take | Android |
| --- | --- |
| `wall` | The sheet opens 1.8 s before `sheet-open` (2.75 s on iOS), so the list is too short for its callout alone: "Board history" stays up over the half-open sheet. Sheet top 510 dp at half height, 101 dp dragged up. |
| `crew` | The QR still holds 1.1 s. No `play-next` callout. Invite sheet top 510 dp; the queue sheet, dragged to full height, 100 dp. |
| `workouts` | The rest countdown starts 2.36 s after `rest-armed` (1.43 s on iOS); `restPill` follows it. The gap moved by a second between two recordings, so re-read it after a re-record. |
| `log` | The scroll moves the Filters row 353 dp, and the Kilter view lifts the calendar 27 dp more. |

`spray`, `lock-screen` and the boards cut on the iOS entries. Every number
was checked with `--platform android --target all --stills --measure`, and
`showcase-video-android-render.test` holds the reading budget on the Android
marks, as the iOS test does. The Android recording on disk predates the spray
takes: record `spray` and `boards-spray` on the emulator (and re-check the
`spray` cut against its marks) before an Android render.

**Trying a layout before the recording lands.** `--work-dir <dir>` reads
`<dir>/{footage,anchors,marks}` instead. A copy of the iOS takes with the first
one in `SHOWCASE_TAKE_IDS` (`boards-kilter`, whose first frame sizes the phone's
screen) scaled to 800 x 1796 is enough to check the Pixel mockup and the copy.

## Uploading

Nothing uploads automatically. After `vp run video:render -- --target all`:

1. **App Store Connect** (app-store). App Store Connect → the app → the version
   → App Store tab → Previews and Screenshots → iPhone 6.9" Display → drag in
   `out/app-store/iphone-6.9.mp4`, pick the poster frame, save. Do the same
   with `iphone-6.5.mp4` if the 6.5" slot is shown separately. Apple processes
   the preview for up to a day, and it goes live with the next version you
   submit.
2. **Google Play** (play-promo). Upload `out/play/play-16x9.mp4` to the
   Boardsesh YouTube channel as public or unlisted, with ads and end screens
   off. Then Play Console → Grow users → Store presence → Main store listing →
   Graphics → Video → paste the YouTube URL, save. The listing shows it once
   the change is reviewed.
3. **Meta Ads** (reel). Ads Manager → the campaign's ad → Media → upload
   `out/reel/reel-9x16.mp4` as a 9:16 Reels / Stories placement. Leave Meta's
   text overlays and music off; the file already keeps its words inside the
   safe area. For an organic Reel, post the same file from the Instagram app.
4. **Social** (social). `out/social/brag.mp4` (16:9) and `brag-9x16.mp4`, with
   `share-copy.txt`, for posts. They carry the donation line; never use them in
   a store listing.

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
`marketing/showcase-video/reference/<platform>/<take>.jpg` (`ios` or `android`:
the two never open on the same pixels); the recorder then fails a take whose
first frame differs in more than 35% of thumbnail pixels.

## When the self-check fails

Each failure names the take. The fixes:

| Message | Cause | Fix |
| --- | --- | --- |
| `footage is Xs, the scene needs Ys` | The flow ended too soon after the trim. | Lengthen the flow's last pause. |
| `the first frame is blank` | The app had not drawn when the footage starts. | Raise the flow's opening pause; check the raw with `--keep-raw`. |
| `differs from marketing/showcase-video/reference/<platform>/<take>.jpg` | The take opened on another screen: a moved button, a dialog, a changed deep link. | Fix the flow or deep links; replace the reference if the screen changed on purpose. |
| `wrong wall: slot N matched no wall (board roster: ...)` | The account has no wall by that name (renamed, unfollowed). | `--boards` with names from the roster, or update `SHOWCASE_DEFAULT_BOARDS` in `record.ts`. |
| `wrong wall: slot N landed on a non-<kind> wall` | The name matched a wall of another board type (read from the `(<boardType>: …)` the app logs, never from the wall's name). | Put a wall of that type in that slot. |
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
| `scripts/lib/showcase-video/android.ts` | The emulator spec and the adb / emulator / screenrecord argument vectors. |
| `packages/mobile/.maestro/showcase/` | One flow per take, plus the crew setup/teardown flows. |
| `packages/mobile/.maestro/showcase/android/` | The Android flows (same names; they replace the shared ones on Android). |
| `.boardsesh/showcase-video/work/` | Footage, anchors, raw recordings, logs (gitignored). Android's under `work/android/`. |

## Web delivery

How the rendered files reach the homepage (`packages/web/app/components/home/home-showcase-video.tsx`).

**English only.** The headlines are burned into the pixels, so es, fr and de keep the three-phone stack and the iOS/Android toggle in the hero. On the English page the toggle moves into the feature strip. The scene headlines also render as a visually hidden `<figcaption>` for screen readers and crawlers.

**The poster is the page's main paint.** The card is a plain `<img>` with `width`/`height` (720 x 1280), `fetchPriority="high"` and no `decoding="async"`, and the component calls `preload(poster, { as: 'image', fetchPriority: 'high' })` so the hint is in the server HTML. The `<video>` has no `poster` attribute: it sits on top of the image in the same box at opacity 0, and turns visible on its `playing` event. The video can never be bigger than the poster.

**The video loads late.** Nothing is requested until the window `load` event has fired and `requestIdleCallback` has run (3 s timeout, 200 ms timer where the API is missing). Then the component sets `src` (webm if `canPlayType('video/webm')`, else mp4) and `preload='auto'`, and the hook plays it. The IntersectionObserver (`rootMargin: 0px`, `threshold: 0.1`) only pauses it offscreen and resumes it. In autoplay mode the hook's effect is the single caller of `play()`/`pause()`; the pause button just flips `userPaused`, so a reader's pause survives scrolling.

**Data saver, reduced motion and refused autoplay.** If `navigator.connection.saveData` is set or the reader prefers reduced motion, the poster stays and a centred play button appears. Nothing is fetched until they press it, and the press calls `play()` itself so iOS accepts it inside the click. A browser that refuses autoplay gets the same treatment: the poster and the centred play button, with no native controls. The small corner toggle pauses and resumes once the video is playing.

**Files.** One cut serves every viewport: `showcase-9x16-lite.webm` and `.mp4` (720 x 1280, `SHOWCASE_WEB_LITE` in `scripts/lib/showcase-video/render.ts`, the `homepage` target), plus `showcase-hero-9x16.webp`. Caps: webm 1,750,000 bytes, mp4 1,900,000 bytes; the renderer fails the encode over its cap. The cut opens on the poster frame (`SHOWCASE_WEB_POSTER_FRAME`, frame 0: the boards trio settled under "Every board. One app."), so the first video frame equals the poster and nothing jumps when playback starts. `--poster-frame <n>` picks another frame and rotates the web encodes to start there; the loop closer lands the last frame on frame 0, so a rotated loop has no seam either.

**Analytics.** `Showcase Video Progress` fires once per quartile per page view with `{ quartile: 25 | 50 | 75 | 100, placement: 'hero', cut: '9x16-lite', autoplayed }`. `autoplayed` is false when the reader pressed play. Quartile 100 fires at 97% of the duration, because a looping video may never report its exact end.

**SEO.** `page.tsx` renders `VideoObject` JSON-LD next to the site JSON-LD, English only. Its `duration` (`PT54.8S`) must equal `SHOWCASE_TOTAL_FRAMES / SHOWCASE_FPS`. It is a literal in `packages/web/app/lib/showcase-video.ts` because the timeline module pulls in Node imports a client bundle can't take; `scripts/__tests__/showcase-video-web-duration.test.ts` fails when they drift. After changing the timeline, update the literal and bump `/` in the sitemap static entries.
