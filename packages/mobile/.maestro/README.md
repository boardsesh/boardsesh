# Maestro screenshot flows

Native App Store / onboarding screenshot capture for the Boardsesh mobile app.
Driven by [Maestro](https://maestro.mobile.dev). Don't run these by hand — the
orchestrator (`scripts/mobile-screenshots.ts`, exposed as `vp run
mobile:screenshots`) prepares the simulator/emulator, applies a clean status bar,
installs the native app artifact, captures each screen, and collects the PNGs
into the store screenshot folders. Apple captures go to
`app-stores/apple/screenshots/<app-store-locale>/<device>/`; Google Play captures
go to `app-stores/google/screenshots/<device>/`.

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

By default the orchestrator captures one device size (`--devices common`: the
6.9" iPhone 16 Pro Max — App Store Connect scales it down to every smaller iPhone,
so extra sizes add no value) across every app locale (`--locales all`: en-US, es,
fr). Spanish is written to both App Store Connect Spanish folders (`es-ES` and
`es-MX`).

## Flows

There is no login flow. The screenshot build auto-signs-in on boot — the auth provider's
`EXPO_PUBLIC_SCREENSHOT_MODE` branch (`auth-provider.tsx`, fed by `screenshot-mode.ts` `SCREENSHOT_USER_*`)
signs in during its initial auth check, before the loading gate clears, so the app renders
straight into Home: no login screen ever mounts, no form is typed, and iOS never offers to
save the password. The orchestrator launches the app and waits for the `$screen /home` log
before running Maestro (replacing the old `login.yaml` readiness gate), so each flow opens
directly into its shots — no Maestro element races a transient auth screen.

- `app-store.yaml` (iOS) — capture Home, Discover, Profile, Logbook, session detail,
  Climbs, the workout generator, playlist detail, and the board view (10 store slots; the
  `03` live-party slot is filled by the party flow, PR2).
- `app-store-android.yaml` — the eight Play Store shots: Home, Discover, Profile,
  session detail, Climbs, the workout generator, board view, and the board sheet.
- `onboarding.yaml` / `onboarding-android.yaml` — capture app screens for
  onboarding-card illustrations (`--flow onboarding`).

## Required env

- `SCREENSHOT_USER_EMAIL` — test account email (default `test@boardsesh.com`).
- `SCREENSHOT_USER_PASSWORD` — test account password. **Not committed** — pass it
  at runtime (prod differs from the local-DB `test`).
- `EXPO_PUBLIC_SCREENSHOT_LOCALE` — the app locale baked into the bundle for the
  current capture pass (the orchestrator reruns the flow once per locale; see
  `screenshot-mode.ts`).

The orchestrator bakes the credentials into the bundle as `EXPO_PUBLIC_SCREENSHOT_USER_EMAIL` /
`_PASSWORD` (iOS via the Metro env, Android via the CI `.env`) so the app auto-signs-in
on boot. They live only in screenshot-only builds; the separate prod-stripping of
`EXPO_PUBLIC_SCREENSHOT_*` keeps them out of shipped bundles.

## Notes

- The iOS app is a Debug dev-client that auto-loads Metro on a plain launch through the
  screenshot build's `DEV_CLIENT_DEFAULT_LAUNCHER_URL` Info.plist value, so the
  orchestrator just `simctl launch`es it — no `simctl openurl`, which on a fresh CI sim
  raises an "Open in 'Boardsesh'?" confirmation Maestro can't reliably dismiss. The
  build auto-signs-in on boot and lands straight on home: the orchestrator pre-warms the
  Metro bundle (once per locale), then launches the app and waits for the `$screen /home`
  log — up to 180s as a safety net for a cold bundle on a slow CI runner — before running
  Maestro. It uninstalls + reinstalls and resets the keychain first, so the app cold-loads
  with fresh app data and the auth provider re-signs-in (no Maestro `clearState` needed).
  `MAESTRO_DEV_CLIENT_URL` (an `expo-development-client` deep link at the Metro port,
  default 8081, override with `BOARDSESH_METRO_PORT`) is still passed for flows that need
  to reload the JS runtime mid-run; the iOS app-store flow no longer does (the board view
  is a deep link shot last, and the board-sheet shot is Android-only), while Android
  relaunches before its board-sheet shot.
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
- **Board activation**: the active board is auto-selected on boot in screenshot
  mode — `auth-provider.tsx` activates the user's first saved board (Marco's board)
  right after the auto-sign-in, so board-backed screens (Climbs, Board View) render
  real content. This replaced a fragile board-picker coordinate tap that missed on a
  loaded runner and left those screens stuck on the "No board selected" empty state.
- **Coordinate taps**: on this iOS 26 / RN Fabric build Maestro's accessibility
  tree only exposes native text inputs and system dialogs — plain Views, Text,
  reanimated pressables and gesture rows don't surface, so app buttons can't be
  matched by id/text. The iOS flow now has **no** `point:` taps (every screen is a
  deep link, the board is active from boot). Android keeps just the board-switcher
  tap (`78%,10%`) for its board-sheet shot; re-check it if the emulator layout
  differs. There's no login step at all — the app auto-signs-in on boot and never
  shows a login screen.
- Screenshot mode (the build-time `EXPO_PUBLIC_SCREENSHOT_MODE=1` flag) auto-signs-in
  on boot with the baked `SCREENSHOT_USER_*` credentials, locks the theme to dark, the
  locale to `EXPO_PUBLIC_SCREENSHOT_LOCALE`, and the platform variant, pre-selects the
  Record-tab workout, drives the deep-link params above, and stops the onboarding gate
  from auto-presenting the tour. See `packages/mobile/src/lib/screenshot-mode.ts`.
