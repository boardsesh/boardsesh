# Android background session (BLE foreground service)

The Android counterpart to the iOS Live Activity. While a session is active it
keeps the `react-native-ble-plx` board connection alive in the background and
shows an ongoing custom notification with the current climb and its controls.

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
    try/catch for the API 34 permission rule); channel
    `boardsesh_session_active` (`IMPORTANCE_DEFAULT`, silent); a
    `DecoratedCustomViewStyle` notification. It is not a media session, so
    Android's full-bleed media card is not available to it.
  - `BoardSessionActionReceiver.kt` — turns the action taps into the module's
    `queueNavigate` event (same `{ action, currentIndex, correlationId }` shape
    as the iOS widget). Events wait in the bounded buffer until JS attaches.
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

## The lock screen card

JS sends `androidBokehJson` on every climb update: the bokeh blobs, the V-grade, its
colour and the angle (`src/lib/live-activity/android-card-payload.ts`). Geometry,
grade colours and contrast stay in tested TypeScript. Kotlin only paints
(`SessionCardArt.kt`) and binds the layouts (`notification_card_{collapsed,expanded}`).

- **The field is the switch.** Absent means the classic card: an older bundle, a
  service restarted with no JS, or the `android-notification-bokeh-kill` flag. Empty
  blob lists mean the new card on a plain surface. The classic layouts and
  `values-v31` colours stay until one stable release has shipped.
- **Collapsed is the main surface.** The lock screen shows the collapsed view by
  default, capped at 48dp, and the system draws no `addAction` buttons there. So the
  card's controls are content views, and a `WearableExtender` keeps a watch's actions.
- **Grey means no active drive** (`resolveLighting == Off`), the same test that writes
  "Driving the wall". Native decides, because a timed drive ends while Android has JS
  timers paused. Both tones are painted together, so that re-post needs no compose.
- **Holds glow behind the controls, not the text.** Spread behind the text, they need
  so much scrim for 4.5:1 that the pattern disappears.
- **A true full-bleed card needs a media session**, and that would cost the live rest
  clock and grade colour and need a permanently fake "playing" state.

## When the card can't be posted

The service keeps the Bluetooth link alive, so a card that fails to post must not
take the service down or fail silently.

- Bitmaps in one posted notification are capped at 700 KB, checked before posting.
  A Binder failure on the promotion path may never reach our `catch`, so the check
  can't wait for one. Over the cap the bokeh goes first, then the thumbnail.
- Every re-post goes through `postNotification()`, which retries once without art.
- A promotion that throws with the card retries with the plain fallback before the
  service stops. An oversized card doesn't reach this path, because
  `startForeground` swallows Binder errors. The 700 KB cap is what guards that case.
- Each failing stage emits `notificationPostFailed` once per service. JS reports it
  to Sentry as `Android session notification post failed`, tagged with the stage:
  `art-over-budget`, `promotion`, `thumbnail`, `card-art`, `rest-transition`,
  `lighting-transition` or `screen-on`. Only the exception's class name is sent.

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
