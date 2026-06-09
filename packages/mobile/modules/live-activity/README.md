# @boardsesh/live-activity-module

iOS-native Expo Module hosting the Dynamic Island / lock-screen Live
Activity stack **and** the `BoardBleManager` Bluetooth code that backs the
widget intent's wall-write path. Ported verbatim from the deprecating
Capacitor app at repo-root `mobile/` — only the Capacitor `CAPPlugin` shell
was rewritten as Expo `Module` / `AsyncFunction` / `Events` calls.

## Exposed Module classes

| Class                | JS lookup                                     | What it wraps                                                                                                                                                   |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BoardBleModule`     | `requireOptionalNativeModule('BoardBle')`     | The `BoardBleManager` singleton — scan, connect, write, configureBoard, plus `scanResult` and `disconnected` listener events                                    |
| `LiveActivityModule` | `requireOptionalNativeModule('LiveActivity')` | The Live Activity lifecycle (start/end/update), push-token registration with the backend, and the widget `queueNavigate` event the Darwin notification surfaces |

Both classes register independently via `expo-module.config.json`. JS
callers import them from `src/index.ts` and check for null
(`requireOptionalNativeModule` returns null in Expo Go, on Android, or in
any preview build that predates the module — the
`src/lib/ble/adapter-factory.ts` factory and
`src/lib/live-activity/live-activity-plugin.ts` wrapper handle the fallback).

## Why the BLE code lives here too

The widget's Next/Previous AppIntents call into Swift
`LiveActivityBleBridge.writeBoardForIntent` to light up the wall when the
user taps Dynamic Island. That bridge lives in the main-app target (the
widget extension can't link CoreBluetooth use cases) and calls directly
into `BoardBleManager.shared`. Both files must compile into the same
binary, so they live in the same Expo Module.

Side benefit: iOS BLE traffic that goes through the JS adapter also runs
through the same Swift singleton, so the App Group's queue state and
`BoardBleManager.configuration` stay coherent for the widget intent path.

## Widget extension target — duplicated files

The widget bundle is a **separate Xcode target** at
`packages/mobile/targets/BoardseshWidgets/` (configured via
`@bacons/apple-targets`). Xcode targets each compile their own binary, so
the files listed below have **byte-identical copies** in both folders:

- `ClimbNavigationIntent.swift`, `NextClimbIntent.swift`, `PreviousClimbIntent.swift`
- `ClimbSessionAttributes.swift`
- `ReconnectBoardIntent.swift`
- `SharedConstants.swift`
- `SharedKeychain.swift`
- `TakeControlIntent.swift`
- `WidgetNetworking.swift`

When you change one, change the other. The
`src/lib/live-activity/__tests__/widget-target-drift.test.ts` vitest
suite sha-compares the two copies and fails CI on drift. Do not
"deduplicate" with a build-time symlink — Xcode's project file recording
plus EAS Build's cache behavior make symlinks unreliable across CI hosts.

The widget target also defines the `WIDGET_EXTENSION` Swift compilation
flag (via `packages/mobile/plugins/with-boardsesh-widget-build-settings.js`)
so the `#if !WIDGET_EXTENSION` blocks in `ClimbNavigationIntent.swift`
skip the `LiveActivityBleBridge` reference when compiled into the widget
process (it can't link `BoardBleManager`).

## Darwin notification pattern (widget → main app)

The widget intent runs in either the main-app process (preferred — iOS
background-launches the suspended app to handle `LiveActivityIntent`s) or
the widget extension process (fallback when iOS can't wake the app).
Either way, the intent writes the new queue index to
`SharedConstants.sharedDefaults` and then posts a Darwin notification:

- Name: `SharedConstants.queueNavigateNotification` (`com.boardsesh.app.queueNavigate`)
- Payload: passed via UserDefaults keys (`widgetNavigateActionKey`, `widgetNavigateCorrelationIdKey`, plus the updated queue state under `queueItemsKey` / `currentIndexKey`) — Darwin notifications themselves carry no userInfo.

The main app's `LiveActivityModule` registers an observer on
`OnStartObserving` (when the first JS listener attaches) — actually on
`OnCreate` for the Darwin observer; `OnStartObserving` controls event
buffering. See "Event buffering" below.

A second Darwin notification, `pushRegistrationStaleNotification`
(`com.boardsesh.app.pushRegistrationStale`), fires from the widget when
`/api/widget/navigate` returns 410 Gone (the cached push token is bound
to a different session). The main app responds by re-registering its
APNs Live Activity push token.

## Event buffering (replaces Capacitor `retainUntilConsumed`)

Capacitor's `notifyListeners(..., retainUntilConsumed: true)` buffered
events until a JS listener attached. Expo Modules' `sendEvent` does not.
`BoardBleModule` and `LiveActivityModule` both buffer their events in a
serial queue when `hasListener == false` and flush on `OnStartObserving`.
Bounded to 200 scan results / 32 navigate events to avoid unbounded
growth if JS never attaches.

## App Group + keychain access group

Both modules and the widget target read/write through:

- `UserDefaults(suiteName: SharedConstants.appGroupId)` — `group.com.boardsesh.app`
- `SharedKeychain` keyed by the access group resolved from the
  `BoardseshKeychainAccessGroup` Info.plist value (`$(AppIdentifierPrefix)group.com.boardsesh.app`)

The Expo config at `packages/mobile/app.config.ts` declares both:

```ts
ios: {
  entitlements: {
    'com.apple.security.application-groups': ['group.com.boardsesh.app'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)group.com.boardsesh.app'],
    'aps-environment': 'production',
  },
  infoPlist: {
    BoardseshKeychainAccessGroup: '$(AppIdentifierPrefix)group.com.boardsesh.app',
    // ...
  },
}
```

Apple Developer Portal: the App Group must be registered against both
`com.boardsesh.app` and `com.boardsesh.app.BoardseshWidgets`. The
deprecating Capacitor app already has the same App Group on the same
primary bundle ID, so EAS Build's profile regeneration covers it without
manual portal work.

## Lifecycle expectations

- `BoardBleModule.OnCreate` — installs scan/disconnect event handlers on
  `BoardBleManager.shared`. Stays installed for the module lifetime; JS
  pickers fire `addListener('scanResult', …)` to subscribe.
- `LiveActivityModule.startSession` — registers the Darwin observers,
  connects the native `SessionWebSocketManager`, calls
  `LiveActivityManager.startActivity`, and persists the auth token to
  the shared keychain so the widget intent can attach it as a Bearer
  header on `/api/widget/navigate`.
- `LiveActivityModule.endSession` — symmetric teardown plus
  `unregisterActivityPushToken` GraphQL mutation. Drops in-flight
  push-token registration retries via the generation counter.

## Local development

Native code changes in this module require a fresh preview build — JS-only
OTA cannot deliver them:

```bash
bunx expo prebuild --platform ios --clean
vp run mobile:preview-build
```

Subsequent JS-only iterations ship via `vp run mobile:publish`. Console
debugging filters to `subsystem:com.boardsesh.app` with categories
`BoardBleManager`, `LiveActivityModule`, `LiveActivityManager`,
`LiveActivityIntent`.

See `docs/live-activity-push-testing.md` for the Tailscale-backed end-to-end
push delivery test, and `.boardsesh/qa-notes.md` (generated per branch)
for the on-device QA flow.
