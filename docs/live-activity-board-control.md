# Live Activity Board Control Roadmap

Control the climbing board from the lock screen while the app is backgrounded. The Live Activities widget should keep queue state current via WebSocket and illuminate LEDs on the physical board as you navigate climbs.

## Current State

**What works today:**
- Single native `URLSessionWebSocketTask` owned by `SessionWebSocketManager`, shared between webview and Live Activity
- Widget shows current climb name, grade, angle, queue position, and board thumbnail
- Next/Previous buttons navigate the queue optimistically (App Group UserDefaults) and send `setCurrentClimb` mutation via native WS
- All queue delta events (FullSync, ItemAdded, ItemRemoved, CurrentClimbChanged, Reordered) are processed natively and persisted to App Group
- Message buffering when webview is backgrounded, with flush or resync on foreground

**What's missing for full lock-screen board control:**
1. No native BLE (CoreBluetooth) -- LED commands can only be sent from the webview's JS context via `@capacitor-community/bluetooth-le`
2. Widget can only do prev/next -- no add, remove, reorder, or mirror mutations from lock screen
3. No LED illumination when app is backgrounded (BLE connection drops with the webview)
4. Widget extension runs in a separate process with no access to the main app's BLE connection

## Architecture Decision: Where Does BLE Live?

The widget extension **cannot** hold a CoreBluetooth connection (extensions have strict memory/runtime limits and Apple kills them after ~30s). The main app process must own the BLE connection.

The flow for lock-screen LED control:

```
Widget (Next/Previous tap)
  │ posts Darwin notification
  ▼
Main app process (even if backgrounded)
  │ LiveActivityPlugin receives Darwin notification
  │ sends setCurrentClimb mutation via native WS
  │ waits for CurrentClimbChanged confirmation
  ▼
Native BLE manager (CoreBluetooth, main app process)
  │ looks up hold positions for the new current climb
  │ writes UART LED packet to the board
  ▼
Physical board LEDs update
```

The main app process can maintain a CoreBluetooth connection in the background if it declares the `bluetooth-central` background mode. This is the critical enabler.

## Phases

### Phase 1: Native CoreBluetooth Manager

Move BLE from JS-only to a native Swift layer that can run when the webview is suspended.

**Files to create:**
- `mobile/ios/App/App/BoardBleManager.swift` -- CoreBluetooth central manager, scan/connect/disconnect, UART write
- `mobile/ios/App/App/BoardBlePlugin.swift` -- Capacitor plugin exposing native BLE to JS (replaces or wraps `@capacitor-community/bluetooth-le` on iOS)
- `mobile/ios/App/App/BoardBlePlugin.m` -- ObjC bridge

**Key work:**
- Port the UART packet encoding from `packages/web/app/lib/ble/` (Aurora protocol: placement data → LED bytes)
- Implement CoreBluetooth scan, connect, service/characteristic discovery for Aurora boards
- Declare `bluetooth-central` in `Info.plist` background modes
- Keep the existing JS Capacitor BLE adapter as a fallback for non-iOS or when native BLE is unavailable
- `BoardBleManager` is a singleton like `SessionWebSocketManager`, owns the `CBCentralManager` and `CBPeripheral` connection

**Hold data requirement:** To illuminate LEDs, the native layer needs the hold positions for the current climb. Options:
- **Option A:** Store the current climb's hold placements in App Group when the climb changes (simplest, widget-compatible)
- **Option B:** Query the local database from native code (requires SQLite/Drizzle access from Swift, complex)
- **Option C:** Include hold data in the GraphQL subscription payload (increases message size but keeps everything in the WS stream)

Recommend **Option A** for Phase 1. The webview already knows the holds -- serialize them to App Group when the current climb changes. The native BLE manager reads them from there.

**Definition of done:** Board LEDs light up when navigating climbs via the Lock Screen widget while the app is in the background.

### Phase 2: Background BLE Connection Persistence

Ensure the CoreBluetooth connection survives app backgrounding and can recover.

**Key work:**
- `bluetooth-central` background mode in `Info.plist` (allows CoreBluetooth to run in background)
- State preservation and restoration (`CBCentralManager` `restoreState` option)
- Handle `centralManager(_:willRestoreState:)` to reconnect to known peripherals after process termination
- Reconnection logic: if the BLE connection drops while backgrounded, attempt to reconnect with exponential backoff
- Battery impact assessment: CoreBluetooth in background is efficient (no scanning needed, just maintaining an existing connection), but test real-world drain

**Definition of done:** BLE connection persists through backgrounding and app suspension. LED writes work reliably after returning from background.

### Phase 3: Hold Data in the WebSocket Stream

Remove the dependency on the webview for hold data by including placements in the subscription payload.

**Key work:**
- Extend the `queueUpdates` GraphQL subscription to include hold placement data in `FullSync` and `ItemAdded` events
- Alternatively, add a `currentClimbHolds` field to `CurrentClimbChanged` events
- Update `SessionWebSocketManager` to parse and store hold placements alongside queue items
- Persist hold data to App Group so the BLE manager can read it
- Update `SharedQueueItem` to include hold placement data (or store separately keyed by climb UUID)

**Trade-off:** This increases WebSocket message size. A typical climb has 10-30 holds, each with position + color + role = ~50 bytes. So ~500-1500 bytes per climb. For a full sync of 20 climbs, that's ~10-30KB -- acceptable for a one-time sync.

**Definition of done:** The native layer can illuminate any climb's LEDs without the webview being active, using hold data received purely through the WebSocket stream.

### Phase 4: Expanded Widget Controls (Optional)

Add more queue management actions to the Lock Screen widget.

**Possible additions:**
- Mirror toggle (flip the current climb)
- Skip/remove current climb from queue
- Tick/log the current climb as sent

**Constraints:**
- iOS widget interaction is limited (buttons only, no complex input)
- Each action follows the same pattern: optimistic App Group update → Darwin notification → main app sends mutation → server confirms → all clients update
- Keep the widget focused -- too many buttons make it cluttered

### Phase 5: Android Parity (Future)

If/when the Android app needs the same capabilities:
- Kotlin `BluetoothGattCallback` for BLE (mirrors `BoardBleManager`)
- Android foreground service for background BLE persistence
- Media notification or custom notification for lock-screen controls (Android doesn't have Live Activities)
- Same WebSocket consolidation pattern as iOS (native WS → Capacitor bridge)

## Technical Notes

### Aurora Board BLE Protocol

The board BLE communication uses a UART service. Key characteristics:
- Service UUID and characteristic UUIDs are in `packages/web/app/lib/ble/uuid.ts`
- Packet format is in `packages/web/app/lib/ble/` -- holds are encoded as placement data with position, color, and role bytes
- The native Swift implementation needs to replicate this encoding exactly

### Background Execution Budget

iOS gives backgrounded apps limited execution time. For our use case:
- **CoreBluetooth background mode**: unlimited for maintaining connections and responding to peripheral events
- **Darwin notification handling**: runs briefly in the main app process, enough to send a WS mutation and a BLE write
- **URLSessionWebSocketTask**: continues receiving messages in the background for a limited time, then iOS may suspend it. The `isDisconnectedCallback` and reconnection logic handle this gracefully

### State Synchronization

The App Group UserDefaults is the shared state layer between the main app, widget extension, and (in the future) the BLE manager. All writes must be atomic and the widget must tolerate stale reads. The current `SharedQueueState.save()`/`load()` pattern handles this correctly.

### What We Decided Not To Do

**Shared Rust/WASM queue engine**: The queue state machine is ~200 lines in Swift and ~150 in TypeScript. The Rust + UniFFI + WASM build complexity isn't justified for this amount of code. If the shared logic grows significantly (optimistic mutations, conflict resolution, offline queue editing), revisit this decision.
