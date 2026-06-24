# Live Activity Board Control Roadmap

Control the climbing board from the lock screen while the app is backgrounded. The Live Activities widget should keep queue state current via WebSocket and illuminate LEDs on the physical board as you navigate climbs.

## BLE ownership

Two BLE layers exist in the codebase. The **React Native layer** (`packages/mobile/src/lib/ble/`) owns BLE for the Expo app — it uses `react-native-ble-plx` with `restoreStateIdentifier: 'boardsesh-ble-restore'` and AppState-based foreground reconnection. The **Capacitor/Swift layer** described below (`mobile/ios/`) owns BLE for the legacy Capacitor app and will be retired once the RN app ships (see `docs/mobile-app-plan.md` for the retirement criteria).

## Current State

**What works today:**

- A native `URLSessionWebSocketTask` owned by `SessionWebSocketManager` feeds the Live Activity while the app is backgrounded (the JS-side `graphql-ws` socket suspends on lock). The JS webview owns its own `graphql-ws` client — the same one web and Android use — separate from this native connection; they are not shared. See `docs/websocket-implementation.md` (iOS Live Activity Integration).
- Widget shows current climb name, grade, angle, queue position, and board thumbnail, restyled to the Velvet Send design system (see `docs/ai-design-guidelines.md`) — `targets/BoardseshWidgets/ClimbSessionLiveActivity.swift`.
- Widget reflects **connection ownership** (see below): the lightbulb is lit and Previous/Next are shown only while _this_ device holds the BLE link; once a peer takes the board the bulb goes out, the controls hide, and the card just shows the climb on the wall ("<name> is on the wall").
- Next/Previous buttons navigate the queue optimistically (App Group UserDefaults) and POST the backend `/api/widget/navigate` REST endpoint (not the native WS) with the registered Live Activity bearer token. They are only shown when this device holds the board (the App Intent's `navigationAllowed` guard and the widget's `boardConnection == connectedByMe` agree). The endpoint rejects a stale token whose session ended (410) or whose user is no longer a participant (403).
- Tapping the widget lightbulb POSTs `/api/widget/take-control` with the registered Live Activity bearer token. The endpoint requires the token row to have a bound `userId` and re-asserts (re-broadcasts `CurrentClimbChanged` for) the current climb; it returns 200.
- All queue delta events (FullSync, ItemAdded, ItemRemoved, CurrentClimbChanged, Reordered) are processed natively and persisted to App Group
- Message buffering when webview is backgrounded, with flush or resync on foreground
- Rust board renderer (`packages/board-renderer-wasm/`) compiles to WASM, used in both Node.js backend (server-rendered thumbnails) and web frontend (Web Worker). Already has `HoldData` types, frame string parsing (`p<hold_id>r<state_code>`), and Aurora hold state color mapping
- Native iOS `BoardBle` owns the CoreBluetooth connection for Aurora boards, writes UART packets from Swift, and stays additive so old app shells without the plugin keep using the existing Capacitor BLE adapter
- The native BLE manager reads queue state from App Group, stores the board configuration in App Group, and uses generated Swift placement data for LED lookup and mirroring

**What's still missing for full lock-screen board control:**

1. Widget can only do prev/next -- no add, remove, reorder, or mirror mutations from lock screen
2. Rust board renderer has no Swift/iOS bindings -- only targets WASM today
3. MoonBoard remains on the existing Capacitor BLE path; the native background BLE path currently targets Aurora boards only
4. Cross-device repaint when _another_ user navigates: if your phone is suspended, your board stays stale until you unlock the phone. Tracked in issue #2174 (presence/ack design) and ultimately solved by the planned WS-enabled board controller.

## Connection ownership (lightbulb + Previous/Next)

The Live Activity reflects a tri-state `boardConnection`, from **this device's** point of view, in `ClimbSessionAttributes.ContentState` (optional fields `boardConnection` + `holderDisplayName`, so older binaries decoding a newer push — and vice-versa — never fail; `nil` ⇒ `connectedByMe`):

- **`connectedByMe`** — this device holds the BLE link → lightbulb lit (warm amber glow), Previous/Next shown and active (they write BLE to the wall).
- **`heldByPeer`** — a session member I can id-match drives the board → lightbulb out, Previous/Next hidden, card shows the wall climb + "<name> is on the wall". An **anonymous** holder (a `conn:` holder with no `userId`) is treated as `heldByPeer` **only on the foreground/JS derivation** — via the session wall-lit flag in `deriveBoardConnection`. The **APNs push path can't attribute an anonymous holder**: `resolveBoardHolder` normalises it to `null`, so `board-connection.ts` returns no usable state and `sendGroupedNotification` **omits `boardConnection` entirely** (the fallback path below), rather than emitting `heldByPeer`. The device then keeps its last-known App-Group state — which may be a **stale `connectedByMe`** for the previous holder until a foreground update or a re-resolvable push corrects it.
- **`disconnected`** — nobody we can tie to is driving → lightbulb out (tap to reconnect via `ReconnectBoardIntent`), Previous/Next hidden.

The derivation is shared with the in-app lightbulb so they can never disagree: `deriveBoardConnection(...)` in `packages/mobile/src/components/play-drawer/lightbulb-control.ts` (the existing `deriveLightbulbLit` is re-expressed as `deriveBoardConnection(...) !== 'disconnected'`), surfaced by the `useBoardConnectionState` hook (`packages/mobile/src/components/ble/use-board-connection-state.ts`), which both `useLightbulbControl` and `LiveActivityBridge` consume.

Three update paths set `boardConnection`:

1. **Foreground (JS)** — `LiveActivityBridge` → `useLiveActivity` threads it through to `updateActivity`/`startSession`; the native module mirrors it into the App Group (`SharedWidgetWallControlState.saveBoardConnection`) so widget intents and the native-WS builder have a fallback.
2. **Backgrounded (APNs push)** — the backend stamps it **per token**: it resolves the session's board holder once per send (`session:{id}:board` → `resolveBoardHolder`) and groups tokens by derived state, so the holder's device gets `connectedByMe` and peers get `heldByPeer`. See `packages/backend/src/services/apns/board-connection.ts` + `sendGroupedNotification` in `apns/index.ts`. A board hand-off (peer takes over) isn't a queue event, so `reportBoardClimb` kicks a debounced push when the writer changes. When the holder/board can't be resolved (no Redis, no mapping, anonymous holder) the fields are omitted and the device keeps its own App-Group state.
3. **Native WebSocket (backgrounded queue events)** — `LiveActivityManager.buildContentState` preserves the last-known `boardConnection` from the App Group so a peer's climb change doesn't reset the bulb.

The widget resolves the effective state per render with `resolveBoardState(...)`: pushed `context.state.boardConnection` → App Group mirror → derive from `navigationAllowed` (true ⇒ connectedByMe).

## Architecture Decision: Where Does BLE Live?

The widget extension **cannot** hold a CoreBluetooth connection (extensions have strict memory/runtime limits and Apple kills them after ~30s). The main app process must own the BLE connection.

`LiveActivityIntent` is the iOS 17+ mechanism that lets us drive the main app from a Live Activity button tap. When the intent type is compiled into **both** targets (widget extension + main app) and the user taps a button on the Live Activity, iOS performs the intent in the main app's process — background-launching the app if it was suspended or terminated. The widget acts as the UI host; the actual work runs where the BLE connection lives.

The flow for lock-screen LED control:

```
Widget (lightbulb tap)
  │ system invokes LiveActivityIntent
  ▼
Main app process (background-launched if needed)
  │ LiveActivityIntent.perform() runs here, not in the widget
  │ POSTs to /api/widget/take-control with the registered Live Activity token
  │ the endpoint re-asserts the session's current climb (no driver to claim)
  │ updates ActivityKit so the lightbulb turns on
  ▼
Navigation is always available — sessions are always-live, any member may navigate

Widget (Next/Previous tap)
  │ system invokes LiveActivityIntent
  ▼
Main app process (background-launched if needed)
  │ LiveActivityIntent.perform() runs here, not in the widget
  │ saves new currentIndex to App Group UserDefaults
  │ optimistically updates ActivityKit content state
  │ ┌─────────────────────────────────────────────────┐
  │ │ BoardBleManager.displayCurrentItemAwaitingReady │
  │ │   awaits CoreBluetooth state restoration        │
  │ │   issues UART write inside beginBackgroundTask  │
  │ │   awaits write-queue drain                      │
  │ └─────────────────────────────────────────────────┘
  │ POSTs to /api/widget/navigate so backend / other party clients see the change
  ▼
Physical board LEDs update
```

Two critical enablers in `mobile/ios/App/App.xcodeproj/project.pbxproj`:

- `NextClimbIntent.swift`, `PreviousClimbIntent.swift`, and `WidgetNetworking.swift` are members of **both** the `App` and `BoardseshWidgets` targets. Without `App`-target membership the intent type is not registered in the main app's `AppIntents` package and iOS has no candidate process to background-launch.
- The widget target sets `OTHER_SWIFT_FLAGS = "$(inherited) -D WIDGET_EXTENSION"`. The intent files gate the main-app-only paths (BLE writes, `UIApplication.beginBackgroundTask`) behind `#if !WIDGET_EXTENSION` so the widget-extension compile excludes symbols it cannot link.

The main app process can maintain a CoreBluetooth connection in the background if it declares the `bluetooth-central` background mode (already done in `Info.plist`). State restoration via `CBCentralManagerOptionRestoreIdentifierKey` makes the peripheral connection survive a process restart — but for the restore callback to actually fire, `CBCentralManager` must be constructed **during launch**, before the run loop services other events. `AppDelegate.didFinishLaunchingWithOptions` eagerly accesses `BoardBleManager.shared` whenever there's a saved BLE board configuration in the App Group, gated to avoid an early Bluetooth permission prompt on fresh installs.

## Phases

### Phase 1: Native CoreBluetooth Manager [IMPLEMENTED FOR AURORA]

Move BLE from JS-only to a native Swift layer that can run when the webview is suspended.

**Files to create:**

- `mobile/ios/App/App/BoardBleManager.swift` -- CoreBluetooth central manager, scan/connect/disconnect, UART write
- `mobile/ios/App/App/BoardBlePlugin.swift` -- Capacitor plugin exposing native BLE to JS (replaces or wraps `@capacitor-community/bluetooth-le` on iOS)
- `mobile/ios/App/App/BoardBlePlugin.m` -- ObjC bridge

**Key work:**

- Implement CoreBluetooth scan, connect, service/characteristic discovery for Aurora boards
- Port the UART packet encoding from `packages/web/app/lib/ble/` (Aurora protocol: placement data → LED bytes)
- Declare `bluetooth-central` in `Info.plist` background modes
- Keep the existing JS Capacitor BLE adapter as a fallback for non-iOS or when native BLE is unavailable
- `BoardBleManager` is a singleton like `SessionWebSocketManager`, owns the `CBCentralManager` and `CBPeripheral` connection

**UART encoding approach -- Rust vs Swift:**

The UART packet encoding (frame string → LED bytes) already exists in the TypeScript BLE layer (`packages/web/app/lib/ble/`). Two options for the native side:

- **Option A: Rewrite in Swift.** The encoding is ~100-150 lines. Simple byte packing, no complex logic. Easiest to debug and maintain alongside the existing Swift codebase. No new build dependencies.
- **Option B: Add UniFFI bindings to the Rust board-renderer crate.** The crate (`packages/board-renderer-wasm/`) already has `HoldData` types and frame string parsing. Adding a `ble_encode(frame_string, holds) -> Vec<u8>` function plus UniFFI `.udl` definition would generate Swift bindings automatically. This shares the frame parsing logic with the WASM build and creates a single source of truth for the Aurora protocol.

Recommend **Option A** for Phase 1 -- keep it simple, ship fast. Revisit Option B if we add more shared logic to the Rust crate (see Phase 3b).

**Hold data requirement:** To illuminate LEDs, the native layer needs hold positions and LED mappings. The implementation uses compiled-in Swift placement data generated from the board constants package, so the native layer can resolve any queued Aurora climb's LEDs independently without a live webview.

**Definition of done:** Board LEDs light up when navigating climbs via the Lock Screen widget while the app is in the background.

### Phase 2: Background BLE Connection Persistence [PARTIALLY IMPLEMENTED]

Ensure the CoreBluetooth connection survives app backgrounding and can recover.

**Key work:**

- `bluetooth-central` background mode in `Info.plist` (allows CoreBluetooth to run in background)
- State preservation and restoration (`CBCentralManager` `restoreState` option)
- Handle `centralManager(_:willRestoreState:)` to reconnect to known peripherals after process termination
- Reconnection logic: if the BLE connection drops while backgrounded, attempt to reconnect with exponential backoff
- Battery impact assessment: CoreBluetooth in background is efficient (no scanning needed, just maintaining an existing connection), but test real-world drain

**Definition of done:** BLE connection persists through backgrounding and app suspension. LED writes work reliably after returning from background.

### Phase 3: Embedded Hold/LED Placement Data in Native Code [IMPLEMENTED FOR iOS BLE]

> **Historical note (Capacitor retired):** the pipeline below originally targeted the
> Capacitor app via `generate-ios-board-placement-data.ts` →
> `mobile/ios/App/App/BoardPlacementData.swift`. That app, its Swift file, and the
> generator have been removed from the repo. The React Native app keeps its own copy at
> `packages/mobile/modules/live-activity/ios/BoardPlacementData.swift`. The design below is
> retained for reference.

The native layer needs hold positions and LED mappings to illuminate the board. Rather than sending this over the WebSocket (which would bloat every message), embed the static board data directly in the compiled Swift code -- the same approach already used for TypeScript and the ESP32 controller.

**Generated data pipeline:**

- `packages/board-constants/scripts/generate-board-constants.ts` produces the committed TypeScript board constants:
  - `packages/board-constants/src/generated/product-sizes-data.ts` -- hold placements as `HoldTuple[]` (`[placementId, mirroredPlacementId, x, y]`), indexed by `boardName` → `"layoutId-setId"`
  - `packages/board-constants/src/generated/led-placements-data.ts` -- LED strip positions as `Record<placementId, ledIndex>`, indexed by `boardName` → `"layoutId-sizeId"`
- `packages/board-constants/scripts/generate-ios-board-placement-data.ts` reads those committed constants and writes `mobile/ios/App/App/BoardPlacementData.swift`
- `packages/board-controller/esp32/scripts/generate-led-mapping.js` reads the TS LED data and generates a C++ header (`led_placement_map.h`) for the embedded controller

**Key work:**

- Add a second codegen step that converts the TypeScript constants to a Swift file (`mobile/ios/App/App/BoardPlacementData.swift`) with static dictionaries
- Include mirrored hole placements and LED placements
- The Swift data is compiled into the app binary -- no runtime fetching, no App Group, no WebSocket overhead
- Each climb's `frames` string (already in `SharedQueueItem`) contains `p<placementId>r<stateCode>` pairs. The native BLE manager looks up each placementId in the embedded data to get the LED index, then encodes the UART packet.

**Generator output structure:**

```
packages/board-constants/scripts/generate-board-constants.ts
  -> packages/board-constants/src/generated/product-sizes-data.ts (existing, TypeScript)
  -> packages/board-constants/src/generated/led-placements-data.ts (existing, TypeScript)
packages/board-constants/scripts/generate-ios-board-placement-data.ts
  -> mobile/ios/App/App/BoardPlacementData.swift (new, Swift)
packages/board-controller/esp32/scripts/generate-led-mapping.js
  -> packages/board-controller/esp32/src/config/led_placement_map.h (existing, C++)
```

**Trade-off:** Board data changes require regenerating and recompiling the app. This is fine -- board hardware configurations are static and change at most once per board revision (years). Run the board-constants generator or its iOS-only generator script to refresh the Swift output after board-constant changes.

**Definition of done:** The native layer can look up LED positions for any hold placement without the webview, using data compiled into the app binary. `BoardBleManager` can encode a UART packet from a frames string alone.

### Phase 4: Expanded Widget Controls

Add more actions to the Lock Screen widget, including workout support.

**Queue controls:**

- Mirror toggle (flip the current climb)
- Skip/remove current climb from queue
- Tick/log the current climb as sent

**Variable-speed playback (future, issue #2232 follow-up):**
The web client now drives multi-frame Aurora climbs through a JS-side playback engine and broadcasts a `PlaybackStateChanged` WebSocket event so party peers stay in sync. The Live Activity does NOT yet consume those events — the widget will still show only the climb's first frame. When this lands on the widget, the native handler should: (a) decode the new event in `SessionWebSocketManager`, (b) drive `BoardBle` to send the active frame on each tick, and (c) optionally render a frame counter in the expanded layout. The pace clamp (50 ms minimum) lives on the engine side in `packages/web/app/components/board-renderer/util.ts` (`MIN_PACE_MS`) — mirror that constant when the native side schedules its own writes.

**Workout controls (future):**
When workouts land in Boardsesh, the Live Activity becomes the primary workout interface on the wall. The widget will need to display and control:

- Current set and rep within the workout (e.g., "Set 2/4, Rep 3/6")
- Rest timer countdown between sets (Live Activities support timer rendering natively via `Text.DateStyle.timer`)
- Start/complete rep buttons
- Skip set or end workout early

The workout state lives server-side and arrives via the same WebSocket subscription. The widget complexity grows (more UI states, timer logic, conditional layouts) but the underlying transport stays the same: WS event → `SessionWebSocketManager` → App Group → Live Activity update. The native Swift state machine may need a workout-specific event type alongside the existing queue events, but the plumbing is identical.

**Design constraints:**

- iOS widget interaction is buttons only, no complex input
- Each action follows the same pattern: optimistic App Group update → `LiveActivityIntent.perform()` in main app → BLE write (if owner) + HTTP POST to backend → server confirms → all clients update
- Lock Screen expanded view has ~160pt height -- plan layouts for queue mode and workout mode

### Phase 5: Android Parity (Future)

If/when the Android app needs the same capabilities:

- Kotlin `BluetoothGattCallback` for BLE (mirrors `BoardBleManager`)
- Android foreground service for background BLE persistence
- Media notification or custom notification for lock-screen controls (Android doesn't have Live Activities)
- Same WebSocket consolidation pattern as iOS (native WS → Capacitor bridge)

## Pre-Phase 1: Golden Test Fixtures for Queue State Machine

Before reimplementing the queue state machine in Swift, establish a shared test suite that both implementations run against. This catches drift between platforms without shared code.

### What to test

The pure `queueReducer(state, action) => state` in `packages/web/app/components/queue-control/reducer.ts` is the primary target. It handles all delta event types:

| Action                       | Reducer case                                  | Behavior |
| ---------------------------- | --------------------------------------------- | -------- |
| `DELTA_ADD_QUEUE_ITEM`       | Idempotent insert at position or end          |
| `DELTA_REMOVE_QUEUE_ITEM`    | Filter by uuid, clear current if removed      |
| `DELTA_REORDER_QUEUE_ITEM`   | Validate indices, splice-based reorder        |
| `DELTA_UPDATE_CURRENT_CLIMB` | Echo detection via correlationId/clientId     |
| `DELTA_MIRROR_CURRENT_CLIMB` | Toggle mirrored on current climb + queue copy |
| `INITIAL_QUEUE_DATA`         | Full state replacement (maps to FullSync)     |

Secondary targets:

- `insertQueueItemIdempotent(queue, item, position?)` in `persistent-session/event-utils.ts`
- `evaluateQueueEventSequence(lastSequence, eventSequence)` returning `'apply' | 'ignore-stale' | 'gap'`

### Fixture format

A JSON file with an array of test cases:

```json
[
  {
    "name": "add item to empty queue",
    "initialState": { "queue": [], "currentClimbQueueItem": null, "lastReceivedSequence": 0 },
    "event": { "type": "DELTA_ADD_QUEUE_ITEM", "item": { "uuid": "a", "climb": { ... } }, "position": 0 },
    "expectedState": { "queue": [{ "uuid": "a", ... }], "currentClimbQueueItem": null, "lastReceivedSequence": 1 }
  }
]
```

### How both platforms consume fixtures

- **TypeScript (Vitest):** Load JSON, loop through cases, call `queueReducer(initialState, action)`, deep-equal against `expectedState`
- **Swift (XCTest):** Load same JSON from test bundle, decode into Swift types, apply the equivalent Swift state machine function, assert equality

The fixture file lives in `packages/shared-schema/test-fixtures/queue-state-machine.json` (or similar shared location accessible to both test targets).

### Existing test coverage

- `packages/web/app/components/queue-control/__tests__/reducer.test.ts` -- existing Vitest tests for the reducer
- `packages/web/app/components/persistent-session/__tests__/event-utils.test.ts` -- tests for utility functions
- These should be refactored to load from the golden fixtures instead of inline test data

## Technical Notes

### Aurora Board BLE Protocol

The board BLE communication uses a UART service. Key characteristics:

- Service UUID and characteristic UUIDs are in `packages/web/app/lib/ble/uuid.ts`
- Packet format is in `packages/web/app/lib/ble/` -- holds are encoded as placement data with position, color, and role bytes
- The native Swift implementation needs to replicate this encoding exactly

### Background Execution Budget

iOS gives backgrounded apps limited execution time. For our use case:

- **CoreBluetooth background mode**: unlimited for maintaining connections and responding to peripheral events
- **`LiveActivityIntent.perform()`**: iOS gives the intent a few seconds of background runtime to complete. `BoardBleManager.displayCurrentItemAwaitingReady` wraps the BLE write in `UIApplication.beginBackgroundTask` to extend that window through state restoration + UART chunk flushing
- **URLSessionWebSocketTask**: continues receiving messages in the background for a limited time, then iOS may suspend it. The `isDisconnectedCallback` and reconnection logic handle this gracefully

### State Synchronization

The App Group UserDefaults is the shared state layer between the main app, widget extension, and (in the future) the BLE manager. All writes must be atomic and the widget must tolerate stale reads. The current `SharedQueueState.save()`/`load()` pattern handles this correctly.

### Existing Rust Crate

The board renderer at `packages/board-renderer-wasm/` is a production Rust → WASM pipeline:

- **Crate:** `board-renderer-wasm`, edition 2024, `tiny-skia` for 2D rendering
- **Build:** `wasm-pack build --target web`, output in `pkg/` (~465KB WASM binary)
- **Backend:** `packages/web/app/api/internal/board-render/route.ts` loads WASM server-side, renders hold overlays, composites with `sharp` to WebP
- **Frontend:** `packages/web/app/lib/board-render-worker/board-render.worker.ts` runs WASM in a Web Worker with OffscreenCanvas
- **Types:** `HoldData { id, mirrored_hold_id, cx, cy, r }`, `HoldStateInfo { color }`, frame string parser
- UniFFI could be added to generate Swift/Kotlin bindings if needed for BLE encoding, but not planned currently

### What We Decided Not To Do

**Shared Rust/WASM state machine**: The queue state machine is ~200 lines in Swift and ~150 in TypeScript. The queue is an ordered list with a cursor -- comparable to a collaborative Spotify or YouTube playlist, not a document editor. Operations are add, remove, reorder, and change current position. The server is authoritative, conflicts resolve trivially (last write wins), and there are no concurrent character-level edits requiring OT or CRDTs. This will stay simple even with workouts (just another event type through the same transport). Maintaining two small, language-idiomatic implementations is simpler than UniFFI bindings and cross-compilation CI for code that rarely changes.
