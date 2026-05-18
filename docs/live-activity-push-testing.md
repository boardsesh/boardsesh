# Testing Live Activity Push Notifications Locally

This guide covers how to test the full Live Activity push notification flow locally using Tailscale and a development-signed iOS build. It covers APNs delivery, widget navigation, and the background update flow.

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Apple Developer Setup](#apple-developer-setup)
4. [Backend Configuration](#backend-configuration)
5. [iOS Build Configuration](#ios-build-configuration)
6. [Running the Full Stack](#running-the-full-stack)
7. [Testing Push Delivery](#testing-push-delivery)
8. [Testing Widget Navigation](#testing-widget-navigation)
9. [Testing Background Updates](#testing-background-updates)
10. [Debugging](#debugging)
11. [Common Issues](#common-issues)

---

## Architecture

When the app is backgrounded, two channels replace the native WebSocket:

```
Server-to-device (push updates):

  Queue mutation
       |
  pubsub.publishQueueEvent()
       |
  APNs hook (fire-and-forget)
       |
  roomManager.getQueueState() --> build ContentState
       |
  apnsService.sendLiveActivityUpdate() (1s debounce)
       |
  Apple Push Notification Service (production)
       |
  iOS ActivityKit updates Live Activity
       |
  Lock screen widget renders new state


Device-to-server (widget buttons):

  User taps Next/Previous on lock screen
       |
  iOS performs the LiveActivityIntent in the MAIN APP process
  (the intent type is registered in both the App and BoardseshWidgets
   targets, so iOS background-launches the app when it's suspended
   instead of running the intent in the widget extension)
       |
  1. Save new currentIndex to App Group UserDefaults
  2. Optimistically update Live Activity content state
  3. In parallel (async let), both run concurrently:
     a. BoardBleManager.displayCurrentItemAwaitingReady
          - awaits CoreBluetooth state restoration
            (peripheral + write characteristic discovered)
          - issues the UART display write
          - all inside a UIApplication beginBackgroundTask window
            with an expiration handler
     b. HTTP POST /api/widget/navigate
          - propagates the new index to the backend so other party
            clients see it via WebSocket / APNs broadcast
       |
  Backend publishes CurrentClimbChanged
       |
  APNs push sent to all session tokens (other devices)

  User taps the lightbulb while not the party driver
       |
  iOS performs TakeControlIntent in the MAIN APP process
       |
  HTTP POST /api/widget/take-control
       - authenticated with the registered Live Activity bearer token
       - rejected unless the token row has a bound authenticated userId
       - claims that participant as the wall driver
       |
  On success, the widget stores local wall-control state, shows the
  lightbulb on, and enables Next/Previous.
```

Latency on the BLE side from a suspended-app cold-launch is ~1.5–2.5 s: background-launch (~0.5–1 s) + CoreBluetooth state restoration (~0.5–1 s) + UART chunk flush (~0.2–0.5 s). Subsequent taps inside the same wake window are faster because the peripheral stays connected.

Cross-device limitation: when _another_ user navigates and your phone is suspended, your board does **not** repaint — the WS connection is dead and the APNs Live Activity push reaches the widget extension, which can't open the CoreBluetooth connection. Tracked in issue #2174; ultimately solved by the planned WS-enabled board controller.

## Prerequisites

- macOS with Xcode 15+
- Apple Developer account (paid, $99/year) with the Boardsesh app registered
- iPhone running iOS 17+ connected via USB or on the same network
- Tailscale set up on both the Mac and iPhone
- Local dev environment running (`bun run db:up`, `bun run dev`, `bun run backend:dev`)

## Apple Developer Setup

### 1. Create an APNs Key

1. Go to [Apple Developer](https://developer.apple.com/account) > Certificates, Identifiers & Profiles > Keys
2. Click **+** to create a new key
3. Name it something like `Boardsesh APNs Key`
4. Check **Apple Push Notifications service (APNs)**
5. Click Continue, then Register
6. **Download the .p8 file** (you can only download it once)
7. Note the **Key ID** shown on the confirmation page (10-character string like `ABC123DEF4`)

### 2. Find Your Team ID

Your Team ID is shown at the top-right of the Apple Developer portal, or under Membership > Team ID. It's a 10-character string like `9A2B3C4D5E`.

### 3. Enable Push Notifications for the App ID

1. Go to Identifiers > App IDs
2. Find or create `com.boardsesh.app`
3. Under Capabilities, ensure **Push Notifications** is enabled
4. If using a wildcard App ID, you'll need an explicit App ID for push

### 4. Base64-encode the .p8 Key

```bash
# From the directory where you downloaded the .p8 file:
base64 -i AuthKey_ABC123DEF4.p8 | tr -d '\n'
```

This outputs a single base64 string — you'll paste this into `APNS_KEY_CONTENTS`.

## Backend Configuration

Add these to `packages/backend/.env.local` (create the file if it doesn't exist — it's gitignored):

```bash
# APNs Configuration for Live Activity push notifications
APNS_KEY_ID=ABC123DEF4              # Your Key ID from step 1
APNS_TEAM_ID=9A2B3C4D5E             # Your Team ID from step 2
APNS_KEY_CONTENTS=LS0tLS1CRUdJT...  # Base64-encoded .p8 key from step 4
APNS_BUNDLE_ID=com.boardsesh.app    # Must match your iOS app's bundle ID
APNS_PRODUCTION=true                 # true = production APNs (matches the app's aps-environment=production entitlement)

# Optional server-side product analytics for Live Activity usage
POSTHOG_PROJECT_KEY=phc_...          # Backend PostHog project key (preferred; falls back to NEXT_PUBLIC_POSTHOG_KEY)
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_ENVIRONMENT=production       # Defaults to SENTRY_ENVIRONMENT, then NODE_ENV, then development
```

When the backend starts, you should see:

```
[APNs] Initialized (production=false, bundleId=com.boardsesh.app)
```

If you see `[APNs] Missing one or more required env vars...`, double-check the values.

If both `POSTHOG_PROJECT_KEY` and `NEXT_PUBLIC_POSTHOG_KEY` are unset, Live Activity product analytics are skipped and APNs delivery still works.

## iOS Build Configuration

> **Two iOS apps, same setup.** The Live Activity stack lives in both the
> deprecating Capacitor app at repo-root `mobile/` and the React Native /
> Expo app at `packages/mobile/`. They share the bundle identifier
> `com.boardsesh.app`, the App Group `group.com.boardsesh.app`, and the
> keychain access group — so the Apple Developer Portal capabilities apply
> to both. Pick the section that matches the app you're testing.

### Capacitor app (repo-root `mobile/`)

#### 1. Signing and Capabilities

Open `mobile/ios/App/App.xcworkspace` in Xcode:

1. Select the **App** target > Signing & Capabilities
2. Set your Team (must match `APNS_TEAM_ID`)
3. Ensure Bundle Identifier is `com.boardsesh.app`
4. Click **+ Capability** and add:
   - **Push Notifications** (if not already present)
   - **Background Modes** > check **Remote notifications** (already in Info.plist, but Xcode needs to see it)
5. Ensure **App Groups** includes `group.com.boardsesh.app`

Do the same for the **BoardseshWidgets** target:

1. Set the same Team
2. Ensure **App Groups** includes `group.com.boardsesh.app`

#### 2. Set the Dev Server URL

```bash
# Set your Tailscale hostname so the iOS app connects to your local server
export CAPACITOR_DEV_URL=http://your-machine.tailscale-domain:3000
```

Then sync the Capacitor config:

```bash
cd mobile && npx cap sync ios
```

#### 3. Build and Run

Build to your iPhone from Xcode (Product > Run, or Cmd+R). The app must be a **development build** signed by your team — simulator builds do not support Live Activities or push notifications.

### React Native / Expo app (`packages/mobile/`)

The Expo app reaches the same Swift stack via two Expo Modules and a widget
target generated at prebuild time. `packages/mobile/app.config.ts` already
declares the App Group, keychain access group, `aps-environment`, the
`remote-notification` background mode, and the `appleTeamId` — so prebuild
produces a project that Xcode opens with the capabilities pre-wired. You do
not need to add them manually in Xcode.

Source locations:

- Main-app Swift (BoardBleManager, LiveActivityManager, SessionWebSocketManager, intents, helpers): `packages/mobile/modules/live-activity/ios/`
- Widget extension target (Live Activity SwiftUI, AppIntents, WidgetNetworking, plus byte-identical copies of ClimbSessionAttributes / SharedConstants / SharedKeychain / Intent files): `packages/mobile/targets/BoardseshWidgets/` — managed by `@bacons/apple-targets`
- Widget target build settings that @bacons/apple-targets does not expose directly, including `WIDGET_EXTENSION`: `packages/mobile/plugins/with-boardsesh-widget-build-settings.js`

#### 1. Generate the native project

```bash
# Regenerates packages/mobile/ios/ from app.config.ts + plugins, adding
# the BoardseshWidgets target. Run this whenever any Expo native config or
# the widget target's expo-target.config.js changes.
cd packages/mobile && bunx expo prebuild --platform ios --clean
```

For normal local simulator/device builds from `packages/mobile`, use `vp run mobile:ios`
instead of raw `expo run:ios`. It keeps `packages/mobile/ios/build` pointed at the
shared Boardsesh Xcode cache so separate git worktrees do not each rebuild from cold.

#### 2. Build to a device

Native code changes (Swift, entitlements, new Xcode targets, etc.) cannot
ship via EAS Update — testers need a fresh installable client:

```bash
vp run mobile:preview-build
```

This produces a development-signed build that bundles the native module
binary + the widget extension. Install it on a physical iPhone running
**iOS 17+** (Live Activities + AppIntents require it). The simulator can
exercise the lock-screen Live Activity but not the Dynamic Island or
ActivityKit push tokens — use a real device for the push-update path.

JS-only iterations after the first install ship via:

```bash
vp run mobile:publish
bunx eas-cli@16 channel:edit preview-1 --branch <your-branch>
```

#### 3. Point at a local backend

The Expo app reads the backend URL from `EXPO_PUBLIC_BACKEND_URL`. To point
at your machine over Tailscale:

```bash
EXPO_PUBLIC_BACKEND_URL=http://your-machine.tailscale-domain:3000 vp run dev:mobile
```

The dev server picks up `.boardsesh/qa-notes.md` automatically and exposes
it under the More tab via `DevMetadataPanel`.

#### 4. Verify in Console.app

Filter by `subsystem:com.boardsesh.app`. Useful categories:

- `BoardBleManager` — connect / write / reconnect
- `LiveActivityModule` — session lifecycle + push-token registration
- `LiveActivityManager` — ActivityKit start / update / end
- `LiveActivityIntent` — fires once per Dynamic Island button tap, prefix logs with `bundle=` so you can tell whether the intent ran in the main app or widget process

## Running the Full Stack

Start all services from the monorepo root:

```bash
# Terminal 1: Database
bun run db:up

# Terminal 2: Web dev server
bun run dev

# Terminal 3: Backend
bun run backend:dev
```

Verify the backend is reachable from your iPhone:

```bash
curl http://your-machine.tailscale-domain:8080/health
```

## Testing Push Delivery

### Step 1: Start a Session

1. Open the app on your iPhone
2. Start or join a party session
3. Add a few climbs to the queue
4. The Live Activity should appear on the lock screen (swipe down or check Dynamic Island)

### Step 2: Verify Token Registration

Check the backend logs for:

```
[APNs] Initialized (production=false, bundleId=com.boardsesh.app)
```

Check the database for the registered token:

```bash
# From the repo root
bun run db:studio
```

Then look at the `activity_push_tokens` table — you should see a row with your session ID and a hex token.

Or query directly:

```sql
SELECT token, session_id, created_at FROM activity_push_tokens;
```

### Step 3: Trigger a Push Update

From a second device or browser, join the same session and change the current climb. Or use curl to trigger the widget navigate endpoint:

```bash
# Replace SESSION_ID with your actual session ID
curl -X POST http://your-machine.tailscale-domain:8080/api/widget/navigate \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"SESSION_ID","action":"next","currentIndex":0}'
```

Backend logs should show:

```
[APNs] Sending Live Activity update for session SESSION_ID to 1 device(s)
[APNs] Results for session SESSION_ID: 1 sent, 0 failed
```

### Step 4: Verify Lock Screen Update

Lock your iPhone. The Live Activity widget should update within a few seconds showing the new current climb.

## Testing Widget Navigation

### Test Non-Driver Take Control

1. Start a party session with two signed-in participants and register Live Activities on both devices
2. Make device A the wall driver
3. Lock device B
4. Verify device B shows the lightbulb off and the Next/Previous buttons disabled
5. Tap the lightbulb on device B
6. Backend logs should show the `/api/widget/take-control` request
7. Device B should show the lightbulb on and enable Next/Previous after the request succeeds
8. Device A should show disabled navigation after its app/native state receives the driver update

### Test with App in Foreground

1. Lock your iPhone with the app still running
2. Tap the **Next** or **Previous** button on the Live Activity widget
3. The widget should update immediately (optimistic update)
4. Backend logs should show the `/api/widget/navigate` request
5. Unlock and verify the app's queue matches

### Test with App Suspended

1. Connect to a board (so there's a saved BLE config — required for the eager `CBCentralManager` init that makes state restoration work)
2. Lock your iPhone
3. Wait 30+ seconds for iOS to suspend the app
4. Tap Next/Previous on the widget
5. The widget UI updates optimistically (instant)
6. The board LEDs update within ~2–3 s — iOS background-launches the app, the intent runs in the main app process, BLE state restoration completes, and `BoardBleManager.displayCurrentItemAwaitingReady` issues the write
7. The HTTP POST to `/api/widget/navigate` should appear in backend logs (independent of the BLE write — they run in parallel)
8. Filter Console.app by subsystem `com.boardsesh.app`, category `LiveActivityIntent` to confirm the intent ran in the App process (DEBUG builds only)

> **Note on the state-restoration delegate-ordering race:** When iOS background-launches the app for state restoration, `centralManagerDidUpdateState(.poweredOn)` and per-peripheral `didDiscoverCharacteristicsFor` callbacks can fire in either order — including discovery before the central reports `.poweredOn`. Write paths must therefore wait on a readiness signal that handles both orderings rather than gating on observing `central.state == .poweredOn` first. `BoardBleManager.displayCurrentItemAwaitingReady` is the path that satisfies this requirement.

### Test with App Force-Killed

1. Force-kill the app from the app switcher
2. The Live Activity should still be visible
3. Tap Next/Previous — the widget updates optimistically
4. The HTTP request to `/api/widget/navigate` should appear in backend logs
5. Other connected clients should see the queue change
6. **The board will NOT repaint in this case.** iOS does not background-launch a user-killed app for `LiveActivityIntent`, so the intent falls back to the widget extension process, which cannot reach `BoardBleManager`. Re-opening the app on this device will re-sync the board via the foreground WS path.

## Testing Background Updates

This is the key test — verifying that APNs keeps the Live Activity alive when the app is backgrounded.

1. Start a session on your iPhone with climbs in the queue
2. Lock the phone (or background the app)
3. Wait 30+ seconds for iOS to fully suspend the app
4. From a **second device or browser**, change the current climb
5. Check your iPhone's lock screen — the Live Activity should update within a few seconds via APNs push
6. The stale date (3 minutes) should NOT trigger because APNs pushes refresh it

### Verify the Update Source

In the backend logs, look for:

```
[APNs] Sending Live Activity update for session ... to N device(s)
[APNs] Results for session ...: N sent, 0 failed
```

If you see `0 sent, N failed`, check the [Common Issues](#common-issues) section.

## Debugging

### Backend APNs Logs

All APNs activity is logged with the `[APNs]` prefix:

```
[APNs] Initialized (production=false, bundleId=com.boardsesh.app)
[APNs] Sending Live Activity update for session ... to 2 device(s)
[APNs] Results for session ...: 2 sent, 0 failed
[APNs] Stale token for session ... (BadDeviceToken): abc123...
```

### iOS Console Logs

Connect your iPhone and open Xcode > Window > Devices and Simulators > your device > Open Console. Filter for:

- `com.boardsesh.app` — main app logs
- `LiveActivityManager` — push token observation
- `LiveActivityPlugin` — token registration with backend
- `NativeWebSocketPlugin` — WebSocket connection state

### Inspect Push Token

The push token is logged (first 8 characters) when obtained:

```
Push token updated: a1b2c3d4...
Push token registered with backend
```

### Test APNs Directly with curl

If you have the push token from the database, you can send a test push directly:

```bash
# Generate a JWT for APNs auth (requires the .p8 key)
# Or use a tool like https://github.com/nicklama/apns-push-tester

# The payload must match ClimbSessionAttributes.ContentState exactly:
{
  "aps": {
    "timestamp": 1712345678,
    "event": "update",
    "content-state": {
      "climbName": "Test Climb",
      "climbDifficulty": "V5+",
      "angle": 40,
      "currentIndex": 1,
      "totalClimbs": 5,
      "hasNext": true,
      "hasPrevious": true,
      "climbUuid": "test-uuid-123"
    }
  }
}
```

## Common Issues

### "Missing one or more required env vars"

APNs env vars are not set in `packages/backend/.env.local`. Double-check all five vars are present.

Specifically, a missing `APNS_BUNDLE_ID` now produces a warn-and-abort at startup — APNs stays disabled, and there is no hardcoded `com.boardsesh.app` fallback. If the `[APNs] Initialized (... bundleId=...)` line is absent from the init log, that is likely the cause.

### Push token not appearing in database

- Verify the Live Activity started (check for "Started Live Activity" in Xcode console)
- The token may take a few seconds to arrive after `Activity.request()`
- Check the Xcode console for "Push token updated" log
- Check for "Failed to register push token" errors — the backend may not be reachable from the iPhone
- If you see "Skipping shared keychain auth token write: authToken was empty" or "Skipping shared keychain auth token write: authToken was not provided", the web app did not pass a usable backend auth token into `LiveActivityPlugin.startSession()`. Confirm `/api/internal/ws-auth` returns a token in the native webview before the Live Activity starts.
- If you see "Skipping push token registration: no auth token in keychain", the ActivityKit push token arrived, but the native plugin could not read a stored auth token when registering it. Check for the shared keychain auth-token write logs immediately before this message.

### "No registered Live Activity tokens"

The APNs hook fired for a queue change, but `activity_push_tokens` has no rows for that session. The log lives at `debug` level (because most party sessions don't have an iOS device watching, and at `info` the channel would be unreadable):

```
[APNs] No registered Live Activity tokens for session ...; skipping update
```

For a session you _expect_ to have an iOS device, this means ActivityKit emitted a push token but native registration failed before the backend stored it. Check iOS console logs for keychain write failures, missing auth-token warnings, GraphQL registration errors, or backend reachability errors. A common past failure mode: the plugin was POSTing the mutation to the web origin (`https://www.boardsesh.com/graphql`) instead of the backend host (`https://ws.boardsesh.com/graphql`) — every request 404'd silently. Verify `graphqlUrl` is passed in to `startSession` from JS and stored in `_currentGraphqlUrl`.

### "BadDeviceToken" in APNs results

- **Wrong environment**: All build configs (Debug + TestFlight + App Store) use `aps-environment=production`, so the backend must run with `APNS_PRODUCTION=true`. The sandbox APNs host (`api.sandbox.push.apple.com`) is not used by any current build.
- **Wrong bundle ID**: `APNS_BUNDLE_ID` must match the app's actual bundle identifier.
- **Stale token**: The activity may have ended. Start a new session.

### "ExpiredProviderToken" in APNs results

The .p8 key JWT has expired (tokens are valid for 1 hour). The `@parse/node-apn` library should handle rotation automatically. If this persists, restart the backend.

### Widget buttons don't send HTTP request

- Check that `bs_widget_navigate_url` (constant: `SharedConstants.widgetNavigateUrlKey`) is stored in SharedDefaults. `LiveActivityPlugin.startSession()` derives it from `graphqlUrl` (e.g. `https://ws.boardsesh.com/api/widget/navigate`) and writes it — verify in the Xcode console during session start. The widget reads this exact URL via `WidgetNetworking.sendNavigation`; if the key is missing the call silently no-ops. Earlier builds derived the URL from `bs_server_url` (the web origin), which is wrong because `/api/widget/navigate` is a backend route, not a Next.js route — if you're seeing the old key in SharedDefaults, the user is on a stale build.
- Check that `bs_widget_take_control_url` (constant: `SharedConstants.widgetTakeControlUrlKey`) is stored in SharedDefaults when debugging lightbulb take-control. It is derived from the same `graphqlUrl` as the navigation endpoint.
- The widget extension must have the App Group entitlement to read SharedDefaults.
- Check backend logs for incoming requests to `/api/widget/navigate` or `/api/widget/take-control`.

### Live Activity goes stale after 3 minutes

- APNs pushes are not reaching the device. Check backend logs for send failures.
- The APNs rate limit may be exceeded (~4/hr for non-prominent activities). When the activity is on the lock screen, the limit is much higher.
- Verify `APNS_PRODUCTION=true` — all builds (Debug + TestFlight + App Store) use `aps-environment=production`.

### CORS errors on widget HTTP request

The `/api/widget/navigate` endpoint includes CORS headers. If you see CORS errors, verify the backend's CORS handler allows the origin. Widget extension `URLSession` requests typically don't send an Origin header, so CORS shouldn't be an issue.
