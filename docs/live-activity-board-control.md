# Live Activity Board Control Roadmap

Control the climbing board from the lock screen while the app is backgrounded. The Live Activities widget should keep queue state current via WebSocket and illuminate LEDs on the physical board as you navigate climbs.

## Current State

**What works today:**
- Single native `URLSessionWebSocketTask` owned by `SessionWebSocketManager`, shared between webview and Live Activity
- Widget shows current climb name, grade, angle, queue position, and board thumbnail
- Next/Previous buttons navigate the queue optimistically (App Group UserDefaults) and send `setCurrentClimb` mutation via native WS
- All queue delta events (FullSync, ItemAdded, ItemRemoved, CurrentClimbChanged, Reordered) are processed natively and persisted to App Group
- Message buffering when webview is backgrounded, with flush or resync on foreground
- Rust board renderer (`packages/board-renderer-wasm/`) compiles to WASM, used in both Node.js backend (server-rendered thumbnails) and web frontend (Web Worker). Already has `HoldData` types, frame string parsing (`p<hold_id>r<state_code>`), and Aurora hold state color mapping

**What's missing for full lock-screen board control:**
1. No native BLE (CoreBluetooth) -- LED commands can only be sent from the webview's JS context via `@capacitor-community/bluetooth-le`
2. Widget can only do prev/next -- no add, remove, reorder, or mirror mutations from lock screen
3. No LED illumination when app is backgrounded (BLE connection drops with the webview)
4. Widget extension runs in a separate process with no access to the main app's BLE connection
5. Rust board renderer has no Swift/iOS bindings -- only targets WASM today

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

**Hold data requirement:** To illuminate LEDs, the native layer needs hold positions and LED mappings. For Phase 1, the webview can write the current climb's hold data to App Group when the climb changes. Phase 3 replaces this with compiled-in static data generated from the same pipeline that produces the TypeScript and C++ constants, so the native layer can resolve any climb's LEDs independently.

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

### Phase 3: Embedded Hold/LED Placement Data in Native Code

The native layer needs hold positions and LED mappings to illuminate the board. Rather than sending this over the WebSocket (which would bloat every message), embed the static board data directly in the compiled Swift code -- the same approach already used for TypeScript and the ESP32 controller.

**Existing generated data pipeline:**
- `packages/web/scripts/generate-size-edges.ts` queries PostgreSQL and generates:
  - `packages/web/app/lib/__generated__/product-sizes-data.ts` -- hold placements as `HoldTuple[]` (`[placementId, mirroredPlacementId, x, y]`), indexed by `boardName` → `"layoutId-setId"`
  - `packages/web/app/lib/__generated__/led-placements-data.ts` -- LED strip positions as `Record<placementId, ledIndex>`, indexed by `boardName` → `"layoutId-sizeId"`
- `packages/board-controller/esp32/scripts/generate-led-mapping.js` reads the TS LED data and generates a C++ header (`led_placement_map.h`) for the embedded controller

**Key work:**
- Extend the generator script to also output a portable format (JSON) alongside the TypeScript files
- Add a second codegen step that converts the JSON to a Swift file (e.g., `mobile/ios/App/App/__generated__/BoardPlacementData.swift`) with static dictionaries
- Include both hole placements (for rendering/BLE) and LED placements (for UART packet encoding)
- The Swift data is compiled into the app binary -- no runtime fetching, no App Group, no WebSocket overhead
- Each climb's `frames` string (already in `SharedQueueItem`) contains `p<placementId>r<stateCode>` pairs. The native BLE manager looks up each placementId in the embedded data to get the LED index, then encodes the UART packet.

**Generator output structure:**
```
packages/web/scripts/generate-size-edges.ts
  → packages/web/app/lib/__generated__/product-sizes-data.ts     (existing, TypeScript)
  �� packages/web/app/lib/__generated__/led-placements-data.ts    (existing, TypeScript)
  → packages/shared-data/board-placements.json                   (new, portable)
  → mobile/ios/App/App/__generated__/BoardPlacementData.swift    (new, from JSON)
  → packages/board-controller/esp32/src/config/led_placement_map.h (existing, C++)
```

**Trade-off:** Board data changes require regenerating and recompiling the app. This is fine -- board hardware configurations are static and change at most once per board revision (years). The generator already runs manually (`bunx tsx scripts/generate-size-edges.ts`), adding one more output target is trivial.

**Definition of done:** The native layer can look up LED positions for any hold placement without the webview, using data compiled into the app binary. `BoardBleManager` can encode a UART packet from a frames string alone.

### Phase 4: Expanded Widget Controls

Add more actions to the Lock Screen widget, including workout support.

**Queue controls:**
- Mirror toggle (flip the current climb)
- Skip/remove current climb from queue
- Tick/log the current climb as sent

**Workout controls (future):**
When workouts land in Boardsesh, the Live Activity becomes the primary workout interface on the wall. The widget will need to display and control:
- Current set and rep within the workout (e.g., "Set 2/4, Rep 3/6")
- Rest timer countdown between sets (Live Activities support timer rendering natively via `Text.DateStyle.timer`)
- Start/complete rep buttons
- Skip set or end workout early

The workout state lives server-side and arrives via the same WebSocket subscription. The widget complexity grows (more UI states, timer logic, conditional layouts) but the underlying transport stays the same: WS event → `SessionWebSocketManager` → App Group → Live Activity update. The native Swift state machine may need a workout-specific event type alongside the existing queue events, but the plumbing is identical.

**Design constraints:**
- iOS widget interaction is buttons only, no complex input
- Each action follows the same pattern: optimistic App Group update → Darwin notification → main app sends mutation → server confirms → all clients update
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

| Action | Reducer case | Behavior |
|--------|-------------|----------|
| `DELTA_ADD_QUEUE_ITEM` | Idempotent insert at position or end |
| `DELTA_REMOVE_QUEUE_ITEM` | Filter by uuid, clear current if removed |
| `DELTA_REORDER_QUEUE_ITEM` | Validate indices, splice-based reorder |
| `DELTA_UPDATE_CURRENT_CLIMB` | Echo detection via correlationId/clientId |
| `DELTA_MIRROR_CURRENT_CLIMB` | Toggle mirrored on current climb + queue copy |
| `INITIAL_QUEUE_DATA` | Full state replacement (maps to FullSync) |

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
- **Darwin notification handling**: runs briefly in the main app process, enough to send a WS mutation and a BLE write
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
