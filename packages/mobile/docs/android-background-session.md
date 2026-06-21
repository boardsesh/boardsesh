# Android background session (BLE foreground service)

The Android counterpart to the iOS Live Activity. While a session is active it
keeps the `react-native-ble-plx` board connection alive in the background and
shows an ongoing media-style notification with Previous/Next controls.

## Pieces

- **`modules/live-activity/android/` (Kotlin Expo module `SessionPresence`)** —
  mirrors the iOS `LiveActivity` method names (`isAvailable` / `startSession` /
  `updateActivity` / `updateActivityClimb` / `endSession`) and the
  `queueNavigate` event, so the shared JS seam drives both platforms with no
  branching.
  - `SessionPresenceModule.kt` — starts/updates/stops the service via intents;
    buffers `queueNavigate` events (bounded at 32) until JS subscribes; holds a
    `WeakReference` to itself so the receiver can reach it without leaking.
  - `BoardSessionService.kt` — `startForeground` with
    `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` (guarded for API < 30, wrapped in
    try/catch for the API 34 permission rule); channel `boardsesh_session`
    (`IMPORTANCE_LOW`); `MediaStyle` notification with Previous/Next actions
    gated on `hasPrevious`/`hasNext`.
  - `BoardSessionActionReceiver.kt` — turns the action taps into the module's
    `queueNavigate` event (same `{ action, currentIndex, correlationId }` shape
    as the iOS widget). If the JS process is dead it launches the app instead.
- **`plugins/with-android-session-service.js`** — injects the `<service>` +
  `<receiver>` into the generated `AndroidManifest.xml` (managed Expo has no
  committed `android/`). The FGS permissions live in `app.config.ts`
  `android.permissions`.
- **JS seam** — `modules/live-activity/src/index.ts` exposes
  `sessionPresenceNative`; `src/lib/live-activity/live-activity-plugin.ts`
  selects the platform module behind one API; `use-live-activity.ts` runs the
  same start/update/stop lifecycle on iOS and Android;
  `live-activity-bridge.tsx` maps `queueNavigate → nextClimb()/previousClimb()`
  and supplies the localized notification strings.

## Lifecycle

The service is **coupled to session presence** (the existing `useLiveActivity`
gate: board selected + queue has content), so it starts when a session becomes
active and stops via `endSession` when it clears — keeping the process
foregrounded (and BLE alive) during real use. `POST_NOTIFICATIONS` (Android 13+)
is requested at board-connect time in `use-ble-permissions.ts`, decoupled from
the BLE gate: a denial only hides the notification; the service still runs.

## Caveats / follow-ups

- **Requires a fresh native build** (prebuild + Gradle / EAS) — the Kotlin and
  the manifest plugin do **not** ship over OTA. First compile signal is CI
  (`android-pr-rn.yml` debug build / `android-apk-rn.yml` release build); behavior
  must then be verified on a device (Android 13+ and 10–12, plus a real board).
- **FGS keeps the process alive, which is necessary but may not be sufficient** —
  `react-native-ble-plx` monitors connections foreground-only and has open
  Android-14 reconnect issues; explicit reconnect hardening and tying the service
  to the raw BLE connect/disconnect (rather than only session presence) is a
  device-tested follow-up.
- **OEM battery killers** (Samsung/Xiaomi) can still kill a connectedDevice FGS;
  an in-app battery-optimization explainer is a possible later mitigation.
- **Play policy**: `FOREGROUND_SERVICE_CONNECTED_DEVICE` needs a Foreground
  Service declaration in the Play Console (justification: keep a BLE-connected
  climbing board controllable in the background).
