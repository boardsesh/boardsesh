## Bluetooth Integration

### Connection Flow

The BLE connection is managed by `useBoardBluetooth` hook and exposed via `BluetoothProvider` context.

**Step-by-step:**

1. **User initiates connection** -- taps lightbulb or connect button.
2. **Adapter creation** -- `createBluetoothAdapter(boardName, devicePicker)` creates a platform-appropriate adapter:
   - Web: uses Web Bluetooth API (`navigator.bluetooth.requestDevice`).
   - Capacitor (native iOS/Android): uses `react-native-ble-plx` equivalent with a custom `DevicePickerDialog` rendered as a bottom sheet (`Dialog` on web).
3. **Availability check** -- `adapter.isAvailable()` confirms BLE is supported.
4. **Existing adapter cleanup** -- on mobile, if a prior adapter exists, ends that generation with `reason: 'user'` and `disconnectTrigger: 'connection_replacement'`, then disconnects it before the new scan.
5. **Device request and connect** -- `adapter.requestAndConnect(targetSerial)` opens the device picker (OS native on web, custom dialog on Capacitor with RSSI-based signal indicators).
6. **Device name parsing** -- `parseApiLevel(deviceName)` extracts the Aurora API level from the device name (e.g., `Kilter Board#751737@3` yields API level 3). `parseSerialNumber(deviceName)` extracts the serial (e.g., `751737`).
7. **Tracked adapter generation** -- mobile installs the adapter identity and `onDisconnect` listener, then starts one transport lifetime with a snapshot of the full board config (including set IDs) and session state. The connection handle carries that immutable config snapshot, and board presence later attaches its resolved board ID only if that adapter generation is still live.
8. **Board configuration** -- adapters with a native background writer call `adapter.configureBoard()` with board name, layout ID, size ID, API level, device name, and colour overrides.
9. **Initial frames** -- if provided, `sendFramesToBoard(initialFrames, mirrored)` sends the first climb immediately. A link drop during this write still ends the generation even though the UI never reached `isConnected: true`.
10. **Serial recording** -- for Aurora boards, `recordBoardSerial()` POSTs the serial-to-config mapping to `/api/internal/board-serials` for future auto-matching.
11. **Session serial broadcast** -- `onConnectSuccess(parsedSerial, connectionHandle)` fires. `BluetoothProvider` resolves the board using the handle's snapshotted config and calls `setSessionBoardSerial(serial)` if a session is active. An unchanged binding returns its cached ID, while same-key reconnects share an in-flight resolve. Ambiguous serial resolution stays pending through the picker choice. This lets the newest generation attach and later release the holder; stale, cancelled, invalidated, and failed resolutions return `null` and cannot populate another config.
12. **Wake lock** -- `useWakeLock(isConnected)` keeps the screen on while connected.

**Device picker dialog (`DevicePickerDialog`):**

- MUI `Dialog` with "Select a board" title and `BluetoothSearching` icon.
- Lists discovered BLE devices with:
  - Board thumbnail: `BoardThumbnail` for resolved saved boards, `BoardRenderer` for recorded configs, `UnknownBoardPreview` with `HelpOutline` overlay for unknown serials.
  - Board name: saved board name, recorded config display name, or raw device name.
  - Board details: layout/size/set info, location, last connected time.
  - Signal strength: icon (`SignalCellularAlt`) + label (Strong/Good/Weak/Very weak based on RSSI thresholds: -50/-70/-85).
- "Cancel" button in actions.
- Board config mismatch detection: if the resolved config doesn't match the current route's board, a `BoardConfigMismatchDialog` offers "Switch" (navigate to matching route with `?autoConnect` param), "Connect anyway", or "Cancel".

**Auto-connect (`AutoConnectHandler`):**

- Reads `?autoConnect={serialNumber}` from URL search params.
- When present and BLE is supported and first search fetch is done: auto-selects the first available climb, initiates BLE connection to the target serial, and removes the param from the URL.
- Fires once per mount via `triggeredRef`.

### Frame Sending

`sendFramesToBoard(frames, mirrored, signal, climbUuid)`:

**Aurora boards:**

1. If `frames` is empty string, sends a clear-all-LEDs packet (no placement data needed).
2. If `mirrored` and board supports mirroring: `convertToMirroredFramesString` maps each hold ID to its `mirroredHoldId` via `holdsData`.
3. Loads LED placement positions via dynamic import of `@boardsesh/board-constants/led-placements` (cached after first load).
4. Calls `getAuroraBluetoothPacket(frames, placementPositions, boardName, apiLevel, ledColorOverrides)`.
5. Handles skipped placements:
   - All placements skipped: shows error snackbar "This climb is for a different board configuration", returns `false`.
   - Partial skip: shows warning snackbar with count, sends remaining holds.
   - Captures Sentry warnings for both cases with context (climbUuid, layoutId, sizeId, setIds, skip counts).
6. Writes packet via `adapter.write(packet, signal)`.
7. Increments BLE send counter and checks feedback prompt threshold.

**MoonBoard:**

1. Empty frames send MoonBoard's clear-all `l##` frame (deliberate clear only — verified against the ArduinoMoonBoardLED community firmware, which clears every LED on each incoming frame; unverified on official Moon controllers, where it is at worst a no-op). An all-placements-skipped climb still refuses to write rather than fall through to this clear.
2. `getMoonboardBluetoothPacket(frames)` produces the packet.
3. If all placements are skipped, shows error snackbar and returns `false`.
4. Partial skips are logged to Sentry.
5. User colour overrides are not sent to MoonBoard controllers because the protocol does not carry arbitrary RGB colours; they still affect in-app rendering.

**Mobile accessibility colour overrides:**

- Mobile stores hold-role colour overrides in `useHoldColorOverrides()` for STARTING, HAND, FINISH, and FOOT.
- Default mode stores no value, so Aurora-family packets use the canonical board colours.
- User mode stores RGB colours as hex strings, passes them to `getAuroraBluetoothPacket()`, and pushes the same map through native iOS `configureBoard()` so widget/background sends match the app.
- The auto-sender includes the colour override signature in its dedupe key so changing a colour repaints the currently loaded climb even when the frames did not change.

**Error handling:**

- `AbortError` (from unmount-mid-write) is swallowed silently -- the AutoSender's drain loop handles this.
- Other errors are logged and return `false`.

### Light Control Drawer

Long-pressing the lightbulb opens the `LightControlDrawer` (`light-control-drawer.tsx`), a bottom `SwipeableDrawer` with height `"auto"`.

**Menu items (MUI `List`):**

| Action              | Icon                                 | Behaviour                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turn off all LEDs   | `LightbulbOutlined`                  | Calls `clearBoard()`. If a light show is active, stops it first (the stop effect auto-clears). Disabled when not connected.                                                                                                                                                                                              |
| Disco mode          | `AutoAwesome` / `StopCircleOutlined` | Toggles `partyMode` between `'disco'` and `'off'`. Requires a climb to be loaded (`hasClimbLoaded`). Randomizes HAND hold colours every 450ms (`DISCO_TICK_MS`). START/FOOT/FINISH holds keep their canonical colours.                                                                                                   |
| Party mode (Glyphs) | `Celebration` / `StopCircleOutlined` | Toggles `partyMode` between `'glyphs'` and `'off'`. Cycles through letters "BOARDSESH" at 600ms per letter (`PARTY_TICK_MS`). Each letter is snapped to hold IDs via `mapGlyphToHolds`. Not available on MoonBoard.                                                                                                      |
| Customise colours   | `Palette`                            | Opens a colour picker `Dialog`. Four customisable LED roles (START, HAND, FOOT, FINISH from `CUSTOMISABLE_LED_ROLES`). Each shows a colour swatch (`<input type="color">`), defaults to the board's canonical role colour from `STATE_TO_PRIMARY_CODE`. "Reset" button clears all overrides. Not available on MoonBoard. |
| Disconnect          | `BluetoothDisabledOutlined`          | Calls `disconnect()` then `onClose()`. Disabled when not connected.                                                                                                                                                                                                                                                      |

**Disco mode effect:**

- Extracts HAND-role placement IDs from the current climb's frames.
- Builds base frames (non-HAND segments preserved as-is).
- Every tick: appends randomized role codes for HAND placements.
- Sends combined frames with the climb's mirrored flag.

**Glyphs mode effect:**

- Pre-computes bitmap-to-hold-ID mapping for each unique letter in "BOARDSESH".
- Cycles through letters, rotating through the board's available role colours.
- Sends frames via `buildPartyFrames(holdIds, stateCode)`.

**Cleanup:**

- Light shows stop automatically when the board disconnects (`useEffect` watches `isConnected`).
- When a light show stops, the wall is cleared once via `clearBoard()`, then the auto-sender resumes and repaints the current climb.

### Disconnect Handling

**User-initiated disconnect (`disconnect` callback):**

- Updates state synchronously for immediate UI feedback.
- Consumes the active adapter generation exactly once, unsubscribes the adapter disconnect listener, and nulls the adapter ref.
- Fires `Bluetooth Disconnected` analytics with `reason: 'user'`, a low-cardinality `disconnectTrigger` (`explicit_user`, `config_switch`, or `connection_replacement`), and `connectionDurationSec`.
- Uses the board config and analytics session state captured when that generation started. Its board ID is attached only through the matching generation's guarded resolve, including cached identities for already-bound reconnects, so every holder is released while a config switch still releases the old wall, never the newly rendered route.
- Calls session wall-disconnect cleanup unconditionally against the current queue session (a no-op in solo). This safely handles a connection that opened solo and joined later, or moved from one session to another; the snapshotted session boolean remains analytics-only.

**Unexpected disconnect (`handleDisconnection` callback):**

- Fires when native iOS or ble-plx reports a link drop, or when a write failure tears down the connection.
- Consumes only when both adapter identity and generation match, so duplicate or stale callbacks cannot end a replacement link.
- Fires analytics with `reason: 'unexpected'`, `disconnectTrigger: 'link_drop'`, the available platform-specific `disconnect*` fields, and the same `connectionDurationSec` lifetime property. Platform fields and `disconnectCategory` are absent from deliberate disconnects.

**Unmount cleanup:**

- Rejects any pending picker promise.
- Silently consumes the generation, unsubscribes the adapter disconnect listener, aborts pending writes, and calls `adapter.disconnect()`.
- Does not emit `Bluetooth Disconnected` for component teardown; tracked mobile disconnects remain `user` or `unexpected`.

**Status store (`bluetooth-status-store.ts`):**

- Module-level store registers active BLE connections via `registerBluetoothConnection(disconnect)`.
- Allows consumers outside the `BluetoothProvider` tree (root tab bar, board switch guard) to observe connection state and trigger disconnect.

### Mobile Adaptation

- **Web Bluetooth API** is replaced by `react-native-ble-plx` on mobile.
- **Device picker**: custom bottom sheet listing discovered BLE devices with board thumbnails, signal strength, and names. Not the OS-level picker.
- **Auto-pairing**: remembers the last connected serial. When the session's `lastConnectedBoardSerial` is set, mobile clients can auto-connect without manual selection.
- **Haptic feedback**: on unexpected disconnect, trigger haptic feedback via `expo-haptics`.
- **Background BLE**: handle BLE state restoration for iOS background mode.

---
