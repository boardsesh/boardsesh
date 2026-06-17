# Maestro screenshot flows

Native App Store / onboarding screenshot capture for the Boardsesh mobile app.
Driven by [Maestro](https://maestro.mobile.dev). Don't run these by hand — the
orchestrator (`scripts/mobile-screenshots.ts`, exposed as `vp run
mobile:screenshots`) prepares the simulator/emulator, applies a clean status bar,
installs the native app artifact, captures each screen, and collects the PNGs
into `app-stores/<apple|google>/screenshots/<device>/`.

On iOS, the artifact is a Debug **dev-client** `.app` (prebuilt/cached, or built
on the fly when no `--app-path` is given). The flow starts **Metro** with
`EXPO_PUBLIC_SCREENSHOT_MODE=1` and opens the expo-development-client deep link.
The screenshot behaviour lives in the **Metro JS bundle**, not the native binary,
so the `.app` is reusable and CI caches it (keyed on native inputs) — a JS-only
run skips the ~30-min native build. See `scripts/mobile-build-sim-app.ts`.

On Android, the artifact is a standalone screenshot APK built with the same
`EXPO_PUBLIC_SCREENSHOT_*` values present during Gradle's JS bundle step. The
Android flows use `launchApp`, not the iOS dev-client deep link.

## Backend

App Store captures run against **prod** (`vp run mobile:screenshots -- --backend
prod`), signed in as a curated test user (real feed, sessions, boards). The
orchestrator builds with the prod `EXPO_PUBLIC_BACKEND_URL` and resets the
simulator keychain first so login authenticates cleanly against prod.
`--backend local` (the default) points at the seeded dev DB instead.

## Flows

- `login.yaml` — reusable subflow. The screenshot build auto-signs-in on boot (see
  `screenshot-mode.ts` `SCREENSHOT_USER_*` + `app/auth/login.tsx`), so this no longer
  types credentials — it waits for the app to land on the home tab (the native tab
  bar's "Discover" label, which only appears once signed in; not "Climbs" — that tab
  is a search glyph with no text). It deliberately does NOT wait on the auth form:
  auto sign-in redirects faster than Maestro can catch the field, and typing the form
  would pop iOS's "Save Password?" dialog over every shot.
- `app-store.yaml` (iOS) — log in, then capture Home, Discover, Profile, Logbook,
  session detail, Climbs, the workout generator, playlist detail, and the board view
  (nine of the ten store slots; the `03` live-party slot is the separate
  `app-store-party.yaml` below).
- `app-store-android.yaml` — the eight Play Store shots: Home, Discover, Profile,
  session detail, Climbs, the workout generator, board view, and the board sheet.
- `app-store-party.yaml` (iOS) — the live multi-user party shot (slot `03`). Run by
  the orchestrator as a second pass with `--party` against a backend
  `createScreenshotSession` fixture; see "Party shot" below.
- `onboarding.yaml` / `onboarding-android.yaml` — capture app screens for
  onboarding-card illustrations (`--flow onboarding`).

## Party shot (slot 03)

The live multi-user in-session shot needs a real ACTIVE session, so the orchestrator
stands one up on the backend and tears it down per run (enable with
`vp run mobile:screenshots -- --party`, iOS app-store only):

1. `scripts/screenshot-session-fixture.ts create` authenticates as the test user and
   calls the backend `createScreenshotSession` mutation, which seeds an active session
   (test user + a dedicated "Demo Climber" participant, a queue, and ticks from both)
   and returns its id.
2. `app-store-party.yaml` reloads the JS runtime (clearing the prior board-view
   drawer), deep-links `://join/<id>`, and the app auto-confirms the join in screenshot
   mode, landing on the in-session view. The seeded ticks render the multi-user
   analytics + leaderboard; screenshot mode also surfaces the seeded crew in the
   presence row (`InSessionView`'s `SCREENSHOT_MODE` branch).
3. `screenshot-session-fixture.ts end <id>` tears the session (and its ticks) down.

It's best-effort: `createScreenshotSession` is **inert unless the backend has
`SCREENSHOT_FIXTURE_USER_ID` set to the test user's id**, so on a backend without that
env the party shot is skipped and the nine-shot set is captured unchanged. The fixture
authenticates against `--backend prod`'s `https://ws.boardsesh.com` (override with
`SCREENSHOT_BACKEND_URL`).

## Required env

- `SCREENSHOT_USER_EMAIL` — test account email (default `test@boardsesh.com`).
- `SCREENSHOT_USER_PASSWORD` — test account password. **Not committed** — pass it
  at runtime (prod differs from the local-DB `test`).

The orchestrator bakes these into the bundle as `EXPO_PUBLIC_SCREENSHOT_USER_EMAIL` /
`_PASSWORD` (iOS via the Metro env, Android via the CI `.env`) so the app auto-signs-in
on boot. They live only in screenshot-only builds; the separate prod-stripping of
`EXPO_PUBLIC_SCREENSHOT_*` keeps them out of shipped bundles.

## Notes

- The iOS app is a dev-client, so each iOS flow first loads its JS from Metro with
  `openLink: ${MAESTRO_DEV_CLIENT_URL}` instead of `launchApp` — a bare launch
  would land on the launcher. The orchestrator passes that env via `maestro test
-e` (an `expo-development-client` deep link pointing at its Metro port, default
  8081, override with `BOARDSESH_METRO_PORT`), so the flow isn't pinned to a port.
  Re-opening the deep link reloads the JS runtime (clears the play drawer between
  drawer-opening shots; iOS now shoots the board view last so it doesn't need it,
  while Android relaunches before its board-sheet shot). The orchestrator pre-warms
  the Metro bundle before
  Maestro runs, but the first load still waits up to 300s as a safety net for a
  cold bundle on a slow CI runner. The orchestrator uninstalls + reinstalls and
  resets the keychain, so the app cold-loads signed out with fresh app data (no
  Maestro `clearState` needed).
- The Android app is a standalone screenshot APK, so Android flows use
  `launchApp`. The orchestrator uninstalls + reinstalls the APK and clears app
  data before capture.
- Navigation uses custom-scheme deep links (`com.boardsesh.app://<route>`); Expo
  Router maps tab routes with the `(tabs)` group stripped (`://climbs`, `://home`,
  `://boards`, …). Each iOS `openLink` is followed by an optional `tapOn "Open"` to
  clear iOS's "Open in 'Boardsesh'?" confirmation (Android has no such dialog).
- Detail screens Maestro can't tap into are reached with screenshot-mode deep-link
  params the build only honours when `EXPO_PUBLIC_SCREENSHOT_MODE=1`:
  `://climbs?screenshotOpenFirst=1` auto-opens the first climb's board view (this
  replaced a flaky `50%,26%` tap that was duplicating the climb-list shot),
  `://profile?screenshotTab=logbook` opens the Logbook tab, and
  `://profile?screenshotTab=sessions` opens the Sessions tab and auto-opens the
  newest session's detail. For any screen shot twice, the plain visit runs before
  the param visit so no stale param leaks in.
- **Coordinate taps**: on this iOS 26 / RN Fabric build Maestro's accessibility
  tree only exposes native text inputs and system dialogs — plain Views, Text,
  reanimated pressables and gesture rows don't surface, so app buttons can't be
  matched by id/text. After moving the board view to a deep link, iOS keeps just
  **one** `point:` tap — the board pick (`24%,45%`) — **pinned to the iPhone 16 Pro
  Max**; Android additionally keeps the board-switcher tap (`78%,10%`) for its
  board-sheet shot. Re-check them if the device changes. There's no login tap at all
  — the screenshot build auto-signs-in on boot, so the flow never touches the form.
- Screenshot mode (the build-time `EXPO_PUBLIC_SCREENSHOT_MODE=1` flag) auto-signs-in
  on boot with the baked `SCREENSHOT_USER_*` credentials, locks the theme to dark + the
  platform variant, pre-selects the Record-tab workout, drives the deep-link params
  above, and stops the onboarding gate from auto-presenting the tour. See
  `packages/mobile/src/lib/screenshot-mode.ts`.
