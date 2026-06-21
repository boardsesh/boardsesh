## Party Mode

### Wall Control (always-live)

Group sessions are always-live. There is no driver role and no preview-only gating: any participant who changes the current climb broadcasts it to everyone, and whoever holds a BLE connection relays it to the board — same as solo. The lightbulb is wired through the persistent session context (`PersistentSessionContext`) and the Bluetooth context (`BluetoothContext`).

**State model (`PersistentSessionStateType`):**

- `participantId: string | null` -- the local user's participant ID (user UUID for authenticated, equals `clientId` for anonymous).
- Wall-confirmed state is tracked from `WallConfirmedClimb` (lit) and `WallDisconnected` (unlit) session events, not from a driver claim.

**Lightbulb button states:**

The lightbulb is a send / re-assert affordance. Lit means our session's climb is confirmed on the wall; unlit means the relaying connection dropped and we no longer know the board still shows our climb. The current climb is preserved either way.

1. **Disconnected (no BLE):** Tapping initiates Bluetooth pairing. The `BluetoothProvider` creates a fresh adapter, shows the device picker (Web Bluetooth's `requestDevice` on web, custom `DevicePickerDialog` on Capacitor), and connects, then sends the current climb.

2. **Connected, unlit:** Tapping re-asserts (re-sends) the current climb to the board.

3. **Pending:** After tapping the lightbulb, a 2-second watcher timer starts. If `confirmClimbOnWall` arrives within that window (via the `wall-confirm-bus`), the timer is dismissed and the lightbulb lights. If not, the timer just clears the pulse. The tap already initiated the connect above, so the watcher is armed **pulse-only** (`pulseOnly: true`) and never fires its own connect fallback — a second connect while the device picker is still open would start a duplicate scan (the iOS "Already scanning" failure). The controller's `auto_connect` / `picker` fallbacks remain for callers that arm without first connecting.

4. **Lit:** Our session's climb is confirmed on the wall. A `WallDisconnected` event turns it back off for everyone when the relaying connection drops.

**Wall confirmation flow:**

1. A participant changes the current climb; it broadcasts to all members and whoever has BLE relays it.
2. `BluetoothAutoSender` sends LED frames to the board via BLE (`sendFramesToBoard`).
3. On successful BLE write:
   - `emitWallConfirm(climbUuid)` fires on the local wall-confirm bus so the same phone's drawer dismisses its timer.
   - If a session exists, `confirmClimbOnWall(climbUuid)` mutation broadcasts to all participants.
4. All participants receive the `WallConfirmedClimb` event via their session-event subscription. The event is republished onto the wall-confirm bus and lights the lightbulb.
5. The session records `confirmedAt` and `confirmedByParticipantId`.
6. When the relaying device's BLE drops, it calls `reportWallDisconnect`, which publishes a `WallDisconnected { disconnectedByParticipantId }` event; every member turns the lightbulb off while the current climb stays put. (If that device's WebSocket closes uncleanly, the room manager publishes `WallDisconnected` with `disconnectedByParticipantId: null` as a backstop.)

**BLE write serialization (`BluetoothAutoSender`):**

The auto-sender uses a latest-wins queue pattern to avoid overlapping GATT operations:

- While a BLE write is in flight, new climbs are stored in `pendingClimbRef`.
- When the current write completes, the drain loop picks up whatever is pending.
- Same-UUID re-broadcasts are deduplicated via `lastSentUuidRef` to avoid double-firing analytics and wall-confirm.
- A single `AbortController` scoped to the AutoSender's lifetime aborts in-flight writes on unmount.

### Participant Tracking

**User list (`Session.users: SessionUser[]`):**

- Populated via the `joinSession` response and kept in sync via `SessionEvent` subscription events.
- Each user has: `id` (participant ID), `username`, `avatarUrl`, `isLeader`.
- The `PartyContext` (`party-context.tsx`) converts `SessionUser[]` to `ConnectedUser[]`, filtering out the current user and mapping `isLeader` to `isHost`.

**Avatar group:**

- Tick badges on avatars show who has sent the current climb (from `tickedBy` on `ClimbQueueItem`).
- Tapping the avatar group expands to a full participant list with display names.

**Invite sharing:**

- Share link format: `{origin}/join/{sessionId}`.
- Share button uses `shareWithFallback` (Web Share API with clipboard fallback).
- QR code via `QRCodeSVG` component: 180px, level M, with 4px margin. Toggle via `QrCode2Outlined` icon button.
- During onboarding tour, a non-URL QR payload (`boardsesh:onboarding-tour-preview`) is shown so scanned codes don't navigate anywhere.

### Angle Sync

When any participant changes the board angle:

1. The angle-selector component pushes the new URL locally via `router.push` for instant feedback.
2. `setSessionBoardPath(boardPath)` mutation broadcasts the new path to all session members.
3. Other participants receive `SessionBoardPathChanged` event.
4. The `BoardSessionBridge` component's session-event subscription calls `router.replace(event.boardPath)` to sync the URL, preserving query string.
5. Self-originated events are suppressed via `changedByParticipantId` comparison.

### Board Serial Sharing

- `setSessionBoardSerial(serial)` mutation stores the serial on the session. Called from `BluetoothProvider.handleConnectSuccess` after a successful BLE connect.
- `SessionBoardSerialChanged` event notifies all participants, updating `session.lastConnectedBoardSerial`.
- Other mobile participants can use this serial to auto-connect to the same physical board.
- Duplicate serial broadcasts are suppressed when the new serial matches the existing one.
- The serial is parsed from the BLE device name via `parseSerialNumber()`.

### Connection Management

**WebSocket connection manager (`websocket-connection-manager.ts`):**

- Singleton `WebSocketConnectionManager` class tracks all registered `graphql-ws` clients.
- Connection states: `idle`, `connecting`, `connected`, `reconnecting`, `stale`, `error`.
- Health check runs every 1s (`HEALTH_CHECK_INTERVAL_MS`).
- Keep-alive: 5s (`KEEP_ALIVE_MS`). Stale grace: 25s (`STALE_GRACE_MS`).
- Handles `visibilitychange` events for background/foreground transitions.

**Persistent session lifecycle:**

- Session data persisted in IndexedDB via `ACTIVE_SESSION_KEY`.
- On restore: checks if the session was auto-finished by the backend due to inactivity, and shows the summary dialog if so.
- Corruption detection: 30-second cooldown (`CORRUPTION_RESYNC_COOLDOWN_MS`) between corruption-triggered resyncs.
- Split context architecture: `PersistentSessionActionsContext` (stable function references) and `PersistentSessionStateContext` (frequently-changing state) to minimise re-renders.

### Data Layer

| Operation               | Type         | Purpose                                                                                        |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `confirmClimbOnWall`    | Mutation     | Confirms a climb was sent to the board via BLE (lights the lightbulb for all members)          |
| `reportWallDisconnect`  | Mutation     | Reports the relaying BLE link dropped (unlights the lightbulb for all members)                 |
| `setSessionBoardPath`   | Mutation     | Broadcasts angle/board path change to all members                                              |
| `setSessionBoardSerial` | Mutation     | Shares which physical board serial is connected                                                |
| `sessionUpdates`        | Subscription | Real-time session events (wall confirm/disconnect, path changes, serial changes, joins/leaves) |
| `queueUpdates`          | Subscription | Real-time queue state changes (add, remove, reorder, current climb)                            |

---
