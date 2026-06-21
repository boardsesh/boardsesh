---
name: ios-screenshots
description: Capture screenshots of the Boardsesh React Native app (packages/mobile/) running on an iOS simulator, driven against Metro with a cached dev-client .app. Use when asked to screenshot / see / visually verify the mobile app on iOS / iPhone, or to share mobile screenshots in chat. macOS only; the Linux/KVM-friendly counterpart is `vp run mobile:android-shots`. Full reference: docs/ios-simulator-screenshots.md.
---

# iOS simulator screenshots

Boots an iPhone simulator, installs a cached **dev-client** `.app` (no bundled JS — it
loads from Metro), launches it (auto-connecting to Metro), and captures with
`xcrun simctl io screenshot`. The `.app` is built once and reused; only the JS
regenerates per run. macOS only (uses `xcrun simctl` + Xcode).

## Workflow (preferred: boot once, shoot many)

1. **First run builds the `.app` (~30 min, cached after).** With no `--app-path`, the
   first `run` does a Debug simulator build (`vp run mobile:build-sim-app`) and caches it
   at `packages/mobile/.app-cache/Boardsesh.app`. Later runs reuse it; only native changes
   force a rebuild. Pass `--app-path <Boardsesh.app>` to use a prebuilt one.

2. **Pick login/data state:**
   - **Prod test account (default):** export `SCREENSHOT_USER_PASSWORD=<prod test pw>` so the
     app auto-logs-in `test@boardsesh.com` and shows real content. Without it, the app stops
     on the login screen.
   - **Local seeded data:** run `vp run dev` first, then add `--backend local` (seeded `test`/`test`).
   - **Plain app (drive login yourself):** add `--no-screenshot-mode`. On iOS this only changes
     the JS/auth behaviour — the cached `.app` still auto-loads Metro (see gotchas).

3. **Boot in the BACKGROUND.** The bare command holds Metro and blocks, so launch it with the
   Bash tool's `run_in_background: true`:
   `vp run mobile:ios-shots` (plus `--backend local` / `--no-screenshot-mode` as chosen).
   It builds/reuses the `.app`, boots the simulator, installs, resets the keychain, starts
   Metro, launches the app, and primes the iOS scheme dialog so later navigations land cleanly.

4. **Wait for "Ready".** Poll the background task's output file (returned when you launched it)
   with a second `run_in_background` Bash `until`-loop so you get one notification:
   `until grep -qE "Ready\. Emulator|Ready\. Simulator|FAILED" <output-file>; do sleep 3; done`

5. **Capture (foreground).** For each screen:
   `vp run mobile:ios-shots -- screenshot --to <screen> --label <name>`
   It navigates via deep link, captures, and prints the absolute PNG path. Screen names:
   `home`, `climbs`, `board-view`, `board-sheet`, `discover`, `record`, `profile`,
   `session-detail`, `logbook`, `progress` — or pass a raw route, e.g.
   `--to 'climbs?screenshotBoardIndex=1'`. (`home`/no `--to` captures the current screen
   without navigating.)

6. **Share.** `SendUserFile` each printed PNG path.

7. **Stop when done.** `vp run mobile:ios-shots -- shutdown` (shuts down the simulator + Metro),
   and stop the backgrounded boot task.

## One-shot alternative (simplest, slower per shot)

`vp run mobile:ios-shots -- --to climbs --label climbs --shutdown` — boots, captures one
screen, tears down, and exits in a single (long) foreground call. No simulator reuse, so prefer
the background workflow for multiple shots.

## Useful flags & env

- `--flow app-store|onboarding` runs the committed Maestro flows instead of ad-hoc capture.
- `--device "<name>"` picks a simulator (default `iPhone 16 Pro Max`).
- `--app-path <Boardsesh.app>` uses a prebuilt app instead of building one.
- `--keep-keychain` skips the (device-wide) keychain reset so a manual login survives.
- `--settle <seconds>` waits after navigation before capturing (default 3; `board-view`,
  `board-sheet`, `session-detail`, `progress` default to 5 since `simctl` has no animation hook).
- Env: `SCREENSHOT_USER_PASSWORD` / `SCREENSHOT_USER_EMAIL` (prod test account credentials).

## Requirements & troubleshooting

- **macOS only** — needs Xcode + Command Line Tools and an installed simulator runtime. On
  Linux/CI use `vp run mobile:android-shots`. Navigation, `--to <screen>`, and `--flow` also
  need **Maestro** (`curl -Ls "https://get.maestro.mobile.dev" | bash`); plain `home` capture
  does not.
- **Metro must be on port 8081.** The cached `.app` bakes its Metro launcher URL to
  `localhost:8081` (there's no `adb reverse` on iOS), so a non-8081 `BOARDSESH_METRO_PORT`
  makes `run` error — unset it or rebuild the `.app` for that port.
- **The "Open in 'Boardsesh'?" scheme dialog** blocks deep-link navigation until tapped. `run`
  primes it away once (after the fresh install) via Maestro, so foreground `screenshot --to` /
  `navigate` runs land cleanly. If you booted the simulator some other way (not via `run`), the
  first navigation may catch the dialog.
- **`--no-screenshot-mode` only changes the JS/auth half.** With the cached screenshot `.app` it
  still auto-loads Metro (you just land on the login screen). A non-screenshot `--app-path` loses
  auto-load and can hit the scheme dialog on the initial load too.
- **"No booted simulator":** start one with `vp run mobile:ios-shots` in the background first.
- Screenshots land in `.boardsesh/ios-screenshots/NN-<label>.png` (gitignored).
