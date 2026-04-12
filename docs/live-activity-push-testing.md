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
  apnsService.sendLiveActivityUpdate() (5s debounce)
       |
  Apple Push Notification Service (sandbox)
       |
  iOS ActivityKit updates Live Activity
       |
  Lock screen widget renders new state


Device-to-server (widget buttons):

  User taps Next/Previous on lock screen
       |
  NextClimbIntent / PreviousClimbIntent (widget extension process)
       |
  1. Optimistic: update Live Activity locally (instant)
  2. HTTP POST /api/widget/navigate (background-safe)
  3. Darwin notification (secondary, if main app is awake)
       |
  Backend publishes CurrentClimbChanged
       |
  APNs push sent to all session tokens
```

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
APNS_PRODUCTION=false                # false = sandbox APNs (for development builds)
```

When the backend starts, you should see:

```
[APNs] Initialized (production=false, bundleId=com.boardsesh.app)
```

If you see `[APNs] Missing one or more required env vars...`, double-check the values.

## iOS Build Configuration

### 1. Signing and Capabilities

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

### 2. Set the Dev Server URL

```bash
# Set your Tailscale hostname so the iOS app connects to your local server
export CAPACITOR_DEV_URL=http://your-machine.tailscale-domain:3000
```

Then sync the Capacitor config:
```bash
cd mobile && npx cap sync ios
```

### 3. Build and Run

Build to your iPhone from Xcode (Product > Run, or Cmd+R). The app must be a **development build** signed by your team — simulator builds do not support Live Activities or push notifications.

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

### Test with App in Foreground

1. Lock your iPhone with the app still running
2. Tap the **Next** or **Previous** button on the Live Activity widget
3. The widget should update immediately (optimistic update)
4. Backend logs should show the `/api/widget/navigate` request
5. Unlock and verify the app's queue matches

### Test with App Suspended

1. Lock your iPhone
2. Wait 30+ seconds for iOS to suspend the app
3. Tap Next/Previous on the widget
4. The widget should still update (optimistic + HTTP fallback)
5. Check backend logs for the POST request

### Test with App Force-Killed

1. Force-kill the app from the app switcher
2. The Live Activity should still be visible
3. Tap Next/Previous — the widget updates optimistically
4. The HTTP request to `/api/widget/navigate` should appear in backend logs
5. Other connected clients should see the queue change

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
[APNs] Removing stale token abc123... (reason: BadDeviceToken)
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

### Push token not appearing in database

- Verify the Live Activity started (check for "Started Live Activity" in Xcode console)
- The token may take a few seconds to arrive after `Activity.request()`
- Check the Xcode console for "Push token updated" log
- Check for "Failed to register push token" errors — the backend may not be reachable from the iPhone

### "BadDeviceToken" in APNs results

- **Wrong environment**: Development-signed app requires `APNS_PRODUCTION=false` (sandbox APNs). Production/TestFlight builds require `APNS_PRODUCTION=true`.
- **Wrong bundle ID**: `APNS_BUNDLE_ID` must match the app's actual bundle identifier.
- **Stale token**: The activity may have ended. Start a new session.

### "ExpiredProviderToken" in APNs results

The .p8 key JWT has expired (tokens are valid for 1 hour). The `@parse/node-apn` library should handle rotation automatically. If this persists, restart the backend.

### Widget buttons don't send HTTP request

- Check that `serverUrl` is stored in SharedDefaults. The `LiveActivityPlugin.startSession()` stores it — verify by checking Xcode console logs during session start.
- The widget extension must have the App Group entitlement to read SharedDefaults.
- Check backend logs for incoming requests to `/api/widget/navigate`.

### Live Activity goes stale after 3 minutes

- APNs pushes are not reaching the device. Check backend logs for send failures.
- The APNs rate limit may be exceeded (~4/hr for non-prominent activities). When the activity is on the lock screen, the limit is much higher.
- Verify `APNS_PRODUCTION=false` for development builds.

### CORS errors on widget HTTP request

The `/api/widget/navigate` endpoint includes CORS headers. If you see CORS errors, verify the backend's CORS handler allows the origin. Widget extension `URLSession` requests typically don't send an Origin header, so CORS shouldn't be an issue.
