# Aurora Bluetooth Protocol Specification

**Version**: Derived from Kilter Board Android App v3.6.4 (Build 202)
**Protocol Versions**: API v2 and API v3
**Transport**: Bluetooth Low Energy (BLE)

---

## Table of Contents

1. [Overview](#1-overview)
2. [BLE Service & Characteristic UUIDs](#2-ble-service--characteristic-uuids)
3. [Device Discovery](#3-device-discovery)
4. [Device Name Format](#4-device-name-format)
5. [Connection Lifecycle](#5-connection-lifecycle)
6. [Message Framing Protocol](#6-message-framing-protocol)
7. [LED Command Protocol](#7-led-command-protocol)
   - [API v2 (2 bytes per LED)](#71-api-v2-2-bytes-per-led)
   - [API v3 (3 bytes per LED)](#72-api-v3-3-bytes-per-led)
8. [Multi-Part Message Sequencing](#8-multi-part-message-sequencing)
9. [BLE Transmission](#9-ble-transmission)
10. [Power Management (API v2)](#10-power-management-api-v2)
11. [Data Pipeline: Climb to LEDs](#11-data-pipeline-climb-to-leds)
12. [Auto-Disconnect](#12-auto-disconnect)
13. [Observer Events](#13-observer-events)
14. [Command Queue](#14-command-queue)
15. [Error Handling](#15-error-handling)
16. [Constants Reference](#16-constants-reference)
17. [Worked Examples](#17-worked-examples)
18. [Board Size Handling & LED Kit Variants](#18-board-size-handling--led-kit-variants)

---

## 1. Overview

The Aurora Bluetooth protocol is used by Aurora Climbing products (Kilter Board, Tension Board, Decoy Board, etc.) to control LED arrays on climbing walls via Bluetooth Low Energy. The app sends LED position+color data to the board, which lights up specific holds to display climbing routes ("problems").

The protocol is built on top of the **Nordic UART Service (NUS)**, a widely-used BLE serial emulation profile. Communication is unidirectional for LED control: the app writes commands to the board's RX characteristic.

**Key characteristics:**

- Uses Nordic UART Service for serial-over-BLE communication
- Custom message framing with SOH/STX/ETX delimiters and checksum
- Two encoding versions: v2 (compact, 10-bit positions) and v3 (extended, 16-bit positions)
- Multi-part message support for large LED sets
- Client-side power budget management (v2 only)
- Serialized command queue with GATT write completion callbacks

---

## 2. BLE Service & Characteristic UUIDs

| Name                     | UUID                                   | Purpose                                                             |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------- |
| **Aurora Board Service** | `4488B571-7806-4DF6-BCFF-A2897E4953FF` | Primary advertisement service UUID; used to filter BLE scan results |
| **Nordic UART Service**  | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | Data transport service (NUS)                                        |
| **RX Characteristic**    | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | App writes LED commands here (Write Without Response)               |
| **TX Characteristic**    | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | Board sends data to app (Notify)                                    |
| **CCCD**                 | `00002902-0000-1000-8000-00805f9b34fb` | Client Characteristic Configuration Descriptor                      |

**Note:** The app scans using the Aurora Board Service UUID (`4488B571...`) as a filter, but communicates over the Nordic UART Service (`6E400001...`). The board advertises both services.

---

## 3. Device Discovery

### Scan Initiation

```
BluetoothAdapter.startLeScan(
    serviceUUIDs: [4488B571-7806-4DF6-BCFF-A2897E4953FF],
    callback: LeScanCallback
)
```

### Scan Parameters

| Parameter           | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| Scan period         | 600,000 ms (10 minutes)                                       |
| Service UUID filter | `4488B571-7806-4DF6-BCFF-A2897E4953FF`                        |
| Name filter         | Device name must contain product substring (e.g., `"Kilter"`) |
| Deduplication       | Devices tracked in list; duplicates ignored                   |

### Discovery Flow

1. Start BLE scan filtered by Aurora Board Service UUID
2. Post a timeout runnable for 10 minutes
3. On each `onLeScan` callback:
   - Check if device already discovered (deduplicate)
   - Get device name (handle `SecurityException`)
   - Verify name contains required substring (e.g., `"Kilter"`)
   - If valid: create `StdLEDWall` instance, notify observers via `onDidDiscoverWall()`
4. On timeout: call `reset()` which stops scanning and clears discovered devices

### Product Name Substrings

The name substring is product-specific and configured at service construction time:

- **Kilter Board**: `"Kilter"`
- **Tension Board**: `"Tension"` (presumed)
- **Decoy Board**: `"Decoy"` (presumed)

---

## 4. Device Name Format

BLE device names follow the pattern:

```
{DisplayName}#{SerialNumber}@{APILevel}
```

### Components

| Component     | Regex                           | Example          | Description                                       |
| ------------- | ------------------------------- | ---------------- | ------------------------------------------------- |
| Display Name  | Everything before `#` or `@`    | `"Kilter Board"` | Human-readable board name                         |
| Serial Number | `#[a-z0-9]+` (case-insensitive) | `#abc123`        | Unique device identifier (without the `#` prefix) |
| API Level     | `@[0-9]+`                       | `@3`             | Protocol version number                           |

### Parsing Rules

- **Display Name**: `name.substring(0, firstIndexOf('#' or '@'))` - if no `#` or `@`, the entire name is the display name
- **Serial Number**: First match of `/#[a-z0-9]+/i`, then strip the leading `#`; returns `null` if not present
- **API Level**: First match of `/@[0-9]+/i`, then strip the leading `@` and parse as integer; defaults to **2** if not present

### Examples

| Device Name             | Display Name   | Serial   | API Level   |
| ----------------------- | -------------- | -------- | ----------- |
| `Kilter Board#abc123@3` | `Kilter Board` | `abc123` | 3           |
| `Kilter Board@2`        | `Kilter Board` | `null`   | 2           |
| `Kilter Board`          | `Kilter Board` | `null`   | 2 (default) |

---

## 5. Connection Lifecycle

### State Machine

```
                     +--------------+
                     | DISCONNECTED |  (gattState = 0)
                     |  (Initial)   |
                     +------+-------+
                            |
                      connect()
                     [guard: not scanning]
                            |
                            v
                     +--------------+
                     |  CONNECTING  |  (gattState = 1)
                     |              |<--- 8s tolerance timer starts
                     +------+-------+
                            |
              onConnectionStateChange(newState=2)
                            |
                            v
                    +----------------+
                    |   DISCOVERING  |  gatt.discoverServices()
                    |   SERVICES     |
                    +-------+--------+
                            |
                  onServicesDiscovered(status=0)
                            |
                            v
                    +----------------+
                    |   DISCOVERING  |  Find UART Service -> Find RX Characteristic
                    | CHARACTERISTICS|
                    +-------+--------+
                            |
                     rxCharacteristic != null
                            |
                            v
                    +----------------+
                    | FULLY CONNECTED|  (rxCharacteristic set)
                    |                |<--- auto-disconnect timer starts
                    +-------+--------+
                            |
                      disconnect()
                     [or timeout]
                            |
                            v
                     +--------------+
                     | DISCONNECTED |  gatt.close(), cleanup state
                     +--------------+
```

### Connection Flow Detail

1. **Pre-check**: Abort if currently scanning (`scanning == true`)
2. **Notify**: `onWillConnectToWall()`
3. **Store wall match bits** (layoutId + productSizeId) for validation
4. **Set GATT state to CONNECTING** (1)
5. **Start 8-second connecting tolerance timer**
6. **Initiate GATT connection**: `device.connectGatt(context, autoConnect=false, callback)`
7. **Wait for** `onConnectionStateChange(status, newState)`:
   - If previous state was CONNECTING (1) and newState is CONNECTED (2): call `gatt.discoverServices()`
   - Otherwise: notify failure and disconnect
8. **Wait for** `onServicesDiscovered(status)`:
   - If status == 0 (success): proceed to characteristic discovery
   - Store the GATT reference
9. **Discover characteristics**:
   - Get UART service: `gatt.getService(6E400001-...)`
   - Get RX characteristic: `service.getCharacteristic(6E400002-...)`
   - If found: clear tolerance timer, store rxCharacteristic
10. **Announce fully connected**: `onDidConnectToWall()`
11. **Set up auto-disconnect timer** if user has configured one

### Connecting Tolerance

- **Period**: 8,000 ms (8 seconds)
- If the full connection (through characteristic discovery) is not established within this period, the connection is aborted and `onDidFailToConnectToWall()` is notified

### Disconnect Cleanup

On disconnect (whether intentional or due to error):

1. Notify `onWillDisconnectFromWall()`
2. Call `gatt.disconnect()`
3. Call `gatt.close()`
4. Clear all state: `wallMatchBits = null`, `gatt = null`, `gattState = 0`, `rxCharacteristic = null`, `autoDisconnectInterval = null`
5. Cancel auto-disconnect and tolerance timers
6. Notify `onDidDisconnectFromWall()`

---

## 6. Message Framing Protocol

All LED commands are wrapped in a framing protocol before transmission.

### Frame Structure

```
+-----+--------+----------+-----+-----------------+-----+
| SOH | LENGTH | CHECKSUM | STX |    PAYLOAD      | ETX |
+-----+--------+----------+-----+-----------------+-----+
| 0x01| 1 byte | 1 byte   | 0x02| 0-255 bytes     | 0x03|
+-----+--------+----------+-----+-----------------+-----+
```

| Field    | Size        | Value    | Description                             |
| -------- | ----------- | -------- | --------------------------------------- |
| SOH      | 1 byte      | `0x01`   | Start of Header - marks frame beginning |
| LENGTH   | 1 byte      | 0-255    | Number of bytes in PAYLOAD              |
| CHECKSUM | 1 byte      | computed | Integrity check of PAYLOAD              |
| STX      | 1 byte      | `0x02`   | Start of Text - marks payload beginning |
| PAYLOAD  | 0-255 bytes | variable | Command byte + LED data                 |
| ETX      | 1 byte      | `0x03`   | End of Text - marks frame end           |

### Checksum Calculation

The checksum is the **bitwise NOT of the 8-bit sum** of all payload bytes:

```
checksum = (~(sum of all payload bytes)) & 0xFF
```

**Algorithm:**

```python
def checksum(payload: list[int]) -> int:
    total = 0
    for byte in payload:
        total = (total + byte) & 0xFF
    return (~total) & 0xFF
```

### Maximum Payload Size

- **Maximum**: 255 bytes per frame
- If payload exceeds 255 bytes, the `wrapBytes()` function returns an **empty list** and logs an error
- Callers must split data across multiple frames using the multi-part protocol (see Section 8)

### Frame Size

Total frame size = 4 (header) + payload_length + 1 (ETX) = **payload_length + 5** bytes

---

## 7. LED Command Protocol

### 7.1 API v2 (2 bytes per LED)

Used when `getAPILevel() < 3` (or API level not specified in device name, defaulting to 2).

#### Payload Format

```
+----------+----------+----------+----------+----------+-----+
| CMD_BYTE | POS_LO_1 | COLOR_1  | POS_LO_2 | COLOR_2  | ... |
+----------+----------+----------+----------+----------+-----+
| 1 byte   |     2 bytes/LED     |     2 bytes/LED     |
```

**Command byte**: First byte of payload (see Section 8)

**Per-LED encoding (2 bytes):**

```
Byte 1 (POS_LO): Position[7:0]
                  Lower 8 bits of LED position

Byte 2 (COLOR):  Red[1:0] | Green[1:0] | Blue[1:0] | Position[9:8]

  color_byte = (scaled_red << 6) | (scaled_green << 4) | (scaled_blue << 2) | position_hi

  Where:
  - scaled_red << 6                        (bits 7:6)
  - scaled_green << 4                      (bits 5:4)
  - scaled_blue << 2                       (bits 3:2)
  - position_hi = (position >> 8) & 0x03   (bits 1:0)
```

**Bit layout of Byte 2:**

```
  Bit 7   Bit 6   Bit 5   Bit 4   Bit 3   Bit 2   Bit 1   Bit 0
+-------+-------+-------+-------+-------+-------+-------+-------+
| Red_1 | Red_0 | Grn_1 | Grn_0 | Blu_1 | Blu_0 | Pos_9 | Pos_8 |
+-------+-------+-------+-------+-------+-------+-------+-------+
```

#### Position Encoding (v2)

- **Range**: 0-1023 (10 bits)
- Positions > 1023 are **skipped** with a log warning
- Lower 8 bits in Byte 1
- Upper 2 bits in Byte 2, bits [1:0]

#### Color Encoding (v2)

Colors are derived from a 6-character hex string (e.g., `"FF0000"` for red):

1. Parse hex to get 8-bit R, G, B values (0-255)
2. Apply power scale factor (see Section 10): `scaled = floor(value * scale) / 64`
3. Result: 2-bit values (0-3) for each channel

```python
def scaled_color_v2(value_8bit: int, scale: float) -> int:
    return int(value_8bit * scale) // 64  # Result: 0-3
```

#### Maximum LEDs per v2 Frame

- Available payload after command byte: 254 bytes
- Bytes per LED: 2
- **Max LEDs per frame: 127**

### 7.2 API v3 (3 bytes per LED)

Used when `getAPILevel() >= 3`.

#### Payload Format

```
+----------+----------+----------+----------+----------+----------+----------+-----+
| CMD_BYTE | POS_LO_1 | POS_HI_1 | COLOR_1  | POS_LO_2 | POS_HI_2 | COLOR_2  | ... |
+----------+----------+----------+----------+----------+----------+----------+-----+
| 1 byte   |       3 bytes/LED              |       3 bytes/LED              |
```

**Per-LED encoding (3 bytes):**

```
Byte 1 (POS_LO):  Position[7:0]   - Lower 8 bits of position
Byte 2 (POS_HI):  Position[15:8]  - Upper 8 bits of position
Byte 3 (COLOR):   Packed RGB

  Bit layout of Byte 3:
  +----+----+----+----+----+----+----+----+
  | R2 | R1 | R0 | G2 | G1 | G0 | B1 | B0 |
  +----+----+----+----+----+----+----+----+
    7    6    5    4    3    2    1    0

  color_byte = (red_3bit << 5) | (green_3bit << 2) | blue_2bit
```

#### Position Encoding (v3)

- **Range**: 0-65535 (16 bits)
- Positions > 65535 are **skipped** with a log warning
- Little-endian: low byte first, high byte second

#### Color Encoding (v3)

Colors are derived from a 6-character hex string:

1. Parse hex to get 8-bit R, G, B values (0-255)
2. Divide down to fit:
   - **Red**: `value / 32` -> 3 bits (0-7), shifted left 5
   - **Green**: `value / 32` -> 3 bits (0-7), shifted left 2
   - **Blue**: `value / 64` -> 2 bits (0-3), no shift

```python
def encode_color_v3(r: int, g: int, b: int) -> int:
    return ((r // 32) << 5) | ((g // 32) << 2) | (b // 64)
```

**Note:** No power scaling is applied in v3; presumably handled by the board firmware.

#### Maximum LEDs per v3 Frame

- Available payload after command byte: 254 bytes
- Bytes per LED: 3
- **Max LEDs per frame: 84**

### Color Fallback

If a placement role is not found (unknown `roleId`), the color defaults to **white** (`"FFFFFF"`).

---

## 8. Multi-Part Message Sequencing

When LED data exceeds a single frame's capacity (255 bytes), it is split across multiple frames using command byte markers.

### Command Bytes

| Purpose                         | API v2 | API v3 | ASCII     |
| ------------------------------- | ------ | ------ | --------- |
| **Single** (one frame only)     | `80`   | `84`   | `P` / `T` |
| **Start** (first of multi-part) | `78`   | `82`   | `N` / `R` |
| **Continue** (middle frames)    | `77`   | `81`   | `M` / `Q` |
| **End** (last of multi-part)    | `79`   | `83`   | `O` / `S` |

### Sequencing Algorithm

1. Initialize all message buffers with the **Continue** command byte (M=77 / Q=81) as placeholder
2. Pack LED data into buffers, splitting when `buffer.size + bytes_per_led > 255`
3. After all LED data is packed:
   - If **1 buffer total**: Change command byte to **Single** (P=80 / T=84)
   - If **>1 buffers**: Change first buffer's command to **Start** (N=78 / R=82), last buffer's to **End** (O=79 / S=83); middle buffers remain **Continue**
4. Wrap each buffer using the framing protocol (Section 6)
5. Concatenate all wrapped frames into a single byte sequence

### Example Sequence (v3, 200 LEDs)

```
Frame 1: [SOH][LEN][CHK][STX][R][pos0_lo][pos0_hi][color0]...[pos83_lo][pos83_hi][color83][ETX]
Frame 2: [SOH][LEN][CHK][STX][Q][pos84_lo][pos84_hi][color84]...[pos167_lo][pos167_hi][color167][ETX]
Frame 3: [SOH][LEN][CHK][STX][S][pos168_lo][pos168_hi][color168]...[pos199_lo][pos199_hi][color199][ETX]
```

---

## 9. BLE Transmission

### Chunking

BLE has a maximum transmission unit (MTU) constraint. The protocol chunks framed data into **20-byte segments** before writing to the RX characteristic.

```
bluetoothChunkSize = 20
```

Each 20-byte chunk is written to the RX characteristic as a separate GATT write operation, sequenced through the command queue (Section 14).

### Write Properties

- **Write type**: Write Without Response (implied by Nordic UART RX characteristic)
- Each chunk is enqueued as a separate `writeCharacteristic()` command
- The command queue ensures serial execution with GATT write completion callbacks

### Data Flow

```
LED Placement Data
    |
    v
prepBytesV2() / prepBytesV3()    -- Encode positions + colors
    |
    v
wrapBytes()                       -- Frame with SOH/STX/ETX/checksum (per message part)
    |
    v
concat all frames                 -- Single byte array
    |
    v
chunked(20)                       -- Split into 20-byte BLE packets
    |
    v
writeCharacteristic() x N         -- Queued GATT writes
```

---

## 10. Power Management (API v2)

API v2 includes client-side power budget enforcement. **API v3 does not have this; power management is assumed to be handled by board firmware.**

### Power Budget Constants

| Constant              | Value      |
| --------------------- | ---------- |
| Max total board power | 18.0 watts |
| Max power per LED     | 0.1 watts  |

### Scale Computation Algorithm

The algorithm tries progressively lower brightness scale factors until total power consumption fits within the 18W budget:

```python
SCALES = [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05]

def compute_v2_scale(placements, placement_roles, leds_per_hold):
    for scale in SCALES:
        total_power = 0.0
        for placement in placements:
            role = placement_roles.get(placement.role_id)
            color = role.led_color if role else "FFFFFF"
            r = scaled_color(parse_hex(color[0:2]), scale)
            g = scaled_color(parse_hex(color[2:4]), scale)
            b = scaled_color(parse_hex(color[4:6]), scale)
            total_power += (r + g + b) / 30.0
        if leds_per_hold * total_power <= 18.0:
            return scale
    return 0.0  # All LEDs off as last resort

def scaled_color(value_8bit, scale):
    return int(value_8bit * scale) // 64
```

**`leds_per_hold`**: A product-specific constant passed to `StdBluetoothService` at construction time. It acts as a multiplier on power consumption, accounting for boards where each hold position has multiple physical LEDs.

---

## 11. Data Pipeline: Climb to LEDs

### Database Schema (Relevant Tables)

```
Climb
  |- uuid: String (PK)
  |- layout_id: Integer
  |- ...

ClimbPlacement (join table)
  |- climb_uuid: String (FK -> Climb)
  |- placement_id: Integer (FK -> Placement)
  |- frame: Integer (animation frame number)
  |- role_id: Integer (FK -> PlacementRole)

Placement
  |- id: Integer (PK)
  |- layout_id: Integer (FK -> Layout)
  |- hole_id: Integer (FK -> Hole)
  |- set_id: Integer (FK -> HoldSet)

Hole
  |- id: Integer (PK)
  |- product_id: Integer
  |- x: Integer (coordinate)
  |- y: Integer (coordinate)
  |- mirrored_hole_id: Integer (FK -> Hole, nullable)

Led
  |- id: Integer (PK)
  |- product_size_id: Integer
  |- hole_id: Integer (FK -> Hole)
  |- position: Integer (LED index on the board)

PlacementRole
  |- id: Integer (PK)
  |- product_id: Integer
  |- name: String (e.g., "Start", "Finish", "Move")
  |- led_color: String (6-char hex, e.g., "00FF00")
  |- screen_color: String (for UI display)

Layout
  |- id: Integer (PK)
  |- product_id: Integer
  |- is_mirrored: Boolean

Wall
  |- uuid: String (PK)
  |- product_id: Integer
  |- layout_id: Integer (FK -> Layout)
  |- product_size_id: Integer
  |- angle: Integer
```

### Transformation Query (Non-Mirrored)

```sql
SELECT holes.x, holes.y, leds.position, climb_placements.frame, climb_placements.role_id
FROM climb_placements
INNER JOIN placements ON climb_placements.placement_id = placements.id
INNER JOIN holes ON placements.hole_id = holes.id
INNER JOIN leds ON holes.id = leds.hole_id
WHERE climb_placements.climb_uuid = ?
  AND placements.layout_id = ?
  AND leds.product_size_id = ?
  AND climb_placements.frame = ?
```

### Transformation Query (Mirrored Wall)

```sql
SELECT mirrored_holes.x, mirrored_holes.y, leds.position, climb_placements.frame, climb_placements.role_id
FROM climb_placements
INNER JOIN placements ON climb_placements.placement_id = placements.id
INNER JOIN holes ON placements.hole_id = holes.id
INNER JOIN holes AS mirrored_holes ON holes.mirrored_hole_id = mirrored_holes.id
INNER JOIN leds ON mirrored_holes.id = leds.hole_id
WHERE climb_placements.climb_uuid = ?
  AND placements.layout_id = ?
  AND leds.product_size_id = ?
  AND climb_placements.frame = ?
```

### Result: ClimbPlacementMinimalData

Each row produces a display-ready record:

```
{
  x: int,          // Hole X coordinate (for UI rendering)
  y: int,          // Hole Y coordinate (for UI rendering)
  position: int,   // LED index (THE value sent to the board)
  frame: int,      // Animation frame
  roleId: int      // Determines LED color via PlacementRole lookup
}
```

### End-to-End Flow

```
1. User selects climb
   |
2. Query ClimbPlacementMinimalData for (climbUUID, layoutId, productSizeId, frame)
   |
3. Verify wall match (layoutId + productSizeId must match connected board)
   |
4. Load all PlacementRoles into map: {roleId -> PlacementRole}
   |
5. For each ClimbPlacementMinimalData:
   |  a. Get LED position (integer)
   |  b. Look up PlacementRole by roleId -> get ledColor hex string
   |  c. Parse hex color to RGB
   |  d. Encode position + color into 2 bytes (v2) or 3 bytes (v3)
   |
6. Split into message parts if > 255 bytes
   |
7. Assign command bytes (Single/Start/Continue/End)
   |
8. Wrap each part in frame (SOH/LEN/CHK/STX/.../ETX)
   |
9. Concatenate all frames
   |
10. Chunk into 20-byte BLE packets
    |
11. Enqueue as sequential GATT writes to RX characteristic
```

---

## 12. Auto-Disconnect

### Configuration

- Stored per-user in SharedPreferences as seconds
- Available intervals: Off, 1, 5, 10, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600 seconds

### Behavior

- Timer starts when connection is fully established (`announceFullyConnected()`)
- Timer is **reset** (rescheduled) on every `display()` call
- When timer expires: `disconnect()` is called automatically
- Converted to milliseconds: `intervalSeconds * 1000`
- If interval is `null` (not configured): no auto-disconnect

### Timer Management

- `rescheduleAutoDisconnectTimeout()`: Clears existing timer, posts new delayed runnable
- `clearAutoDisconnectTimeout()`: Removes pending auto-disconnect callback
- `autoDisconnectTimedOut()`: Called when timer fires; initiates full disconnect

---

## 13. Observer Events

The Bluetooth service uses an observer pattern. UI components register as observers to receive lifecycle events.

### Scanning Events

| Event                            | When                      |
| -------------------------------- | ------------------------- |
| `onWillStartScanForWalls()`      | Just before scan begins   |
| `onDidStartScanForWalls()`       | Scan successfully started |
| `onDidFailToStartScanForWalls()` | Scan failed to start      |
| `onWillStopScanForWalls()`       | Just before scan stops    |
| `onDidStopScanForWalls()`        | Scan stopped              |

### Discovery Events

| Event                        | When                                      |
| ---------------------------- | ----------------------------------------- |
| `onDidDiscoverWall(LEDWall)` | Valid board device discovered during scan |

### Connection Events

| Event                               | When                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `onWillConnectToWall(LEDWall)`      | Connection attempt starting                                     |
| `onDidConnectToWall(LEDWall)`       | Full connection established (GATT + services + characteristics) |
| `onDidFailToConnectToWall(LEDWall)` | Connection failed or timed out                                  |
| `onWillDisconnectFromWall(LEDWall)` | Disconnect initiated                                            |
| `onDidDisconnectFromWall(LEDWall)`  | Fully disconnected and cleaned up                               |

### Data Events

| Event                       | When                                               |
| --------------------------- | -------------------------------------------------- |
| `onCharacteristicUpdated()` | Board sent data via TX characteristic notification |

---

## 14. Command Queue

BLE GATT operations must be serialized (only one outstanding operation at a time). The protocol implements a FIFO command queue.

### Queue Properties

- Type: `ConcurrentLinkedQueue<Runnable>`
- Busy flag prevents concurrent execution
- Commands execute on main thread via `Handler.post()`

### Queue Operations

1. **Enqueue**: `commandQueue.add(runnable)` then call `nextCommand()`
2. **Dequeue**: `nextCommand()` checks busy flag, peeks at head, sets busy=true, executes on main handler
3. **Complete**: `completedCommand()` sets busy=false, removes head, calls `nextCommand()` for next item
4. **Error**: On GATT null, queue is cleared entirely

### What Gets Queued

- `setNotify()` - Enable/disable characteristic notifications (CCCD write)
- `writeCharacteristic()` - Each 20-byte chunk of LED data

### Completion Triggers

- `onCharacteristicWrite()` callback -> `completedCommand()`
- `onDescriptorWrite()` callback -> `completedCommand()`
- Exception during command execution -> `completedCommand()`
- GATT null during command execution -> `completedCommand()`

---

## 15. Error Handling

### SecurityException

Caught at every BLE API call site (scan, connect, disconnect, write, read name). When caught:

- Operation is considered failed
- Log message recorded
- Graceful fallback (e.g., null name, failed connection notification)

### Connection Failures

- GATT null after `connectGatt()`: Notify failure
- Service discovery failure (status != 0): No action (connection stalls, tolerance timer handles it)
- UART service not found: Connection stalls until tolerance timeout
- RX characteristic not found: Connection stalls until tolerance timeout
- Tolerance timeout (8s): Auto-disconnect + notify failure

### Write Failures

- `writeCharacteristic()` returns false: Log failure, call `completedCommand()` to proceed to next
- `writeDescriptor()` returns false: Log failure, call `completedCommand()`
- GATT null during write: Clear entire queue, log error

### Wall Mismatch

- `display()` validates `WallMatchBits` (layoutId + productSizeId) before sending
- If mismatch: Silently abort display, log warning

---

## 16. Constants Reference

| Constant                  | Value                                  | Source                               |
| ------------------------- | -------------------------------------- | ------------------------------------ |
| Aurora Board Service UUID | `4488B571-7806-4DF6-BCFF-A2897E4953FF` | `BluetoothServiceKt.java:229`        |
| UART Service UUID         | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | `BluetoothServiceKt.java:234`        |
| RX Characteristic UUID    | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | `BluetoothServiceKt.java:237`        |
| TX Characteristic UUID    | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | (from NUS standard)                  |
| CCCD UUID                 | `00002902-0000-1000-8000-00805f9b34fb` | `BluetoothServiceKt.java:240`        |
| BLE Chunk Size            | 20 bytes                               | `BluetoothServiceKt.java:243`        |
| Max Payload Length        | 255 bytes                              | `BluetoothServiceKt.java:31`         |
| Scan Period               | 600,000 ms (10 min)                    | `StdBluetoothService.java:42`        |
| Connection Tolerance      | 8,000 ms (8 sec)                       | `BasicLEDWall.java:87`               |
| Max Board Power (v2)      | 18.0 watts                             | `BluetoothServiceKt.java:232`        |
| Max Power Per LED (v2)    | 0.1 watts                              | `BluetoothServiceKt.java:233`        |
| SOH                       | `0x01` (1)                             | Protocol constant                    |
| STX                       | `0x02` (2)                             | Protocol constant                    |
| ETX                       | `0x03` (3)                             | Protocol constant                    |
| v2 Single                 | `0x50` (80, 'P')                       | `BluetoothServiceKt.java:155`        |
| v2 Start                  | `0x4E` (78, 'N')                       | `BluetoothServiceKt.java:158`        |
| v2 Continue               | `0x4D` (77, 'M')                       | `BluetoothServiceKt.java:115`        |
| v2 End                    | `0x4F` (79, 'O')                       | `BluetoothServiceKt.java:159`        |
| v3 Single                 | `0x54` (84, 'T')                       | `BluetoothServiceKt.java:213`        |
| v3 Start                  | `0x52` (82, 'R')                       | `BluetoothServiceKt.java:216`        |
| v3 Continue               | `0x51` (81, 'Q')                       | `BluetoothServiceKt.java:176`        |
| v3 End                    | `0x53` (83, 'S')                       | `BluetoothServiceKt.java:217`        |
| Default API Level         | 2                                      | `BasicLEDWall.java:306`              |
| Default LED Color         | `"FFFFFF"` (white)                     | `BluetoothServiceKt.java:83,134,193` |

---

## 17. Worked Examples

### Example 1: Single LED, API v3

Display one hold at position 42 with color `"00FF00"` (green):

**Step 1: Encode LED data**

```
position = 42
pos_lo = 42 & 0xFF = 0x2A
pos_hi = (42 >> 8) & 0xFF = 0x00

color = "00FF00"
R = 0x00 / 32 = 0  -> 0 << 5 = 0x00
G = 0xFF / 32 = 7  -> 7 << 2 = 0x1C
B = 0x00 / 64 = 0  -> 0
color_byte = 0x00 | 0x1C | 0x00 = 0x1C
```

**Step 2: Build payload (Single command)**

```
payload = [0x54, 0x2A, 0x00, 0x1C]
           T     pos_lo pos_hi color
```

**Step 3: Compute checksum**

```
sum = (0x54 + 0x2A + 0x00 + 0x1C) & 0xFF = 0x9A
checksum = ~0x9A & 0xFF = 0x65
```

**Step 4: Wrap in frame**

```
frame = [0x01, 0x04, 0x65, 0x02, 0x54, 0x2A, 0x00, 0x1C, 0x03]
         SOH   LEN   CHK   STX   T     pos_lo pos_hi color  ETX
```

**Step 5: Transmit** (9 bytes < 20, fits in one BLE packet)

### Example 2: Three LEDs, API v2 with scaling

Display three holds:

- Position 10, role "Start" (green `"00FF00"`)
- Position 256, role "Move" (blue `"0000FF"`)
- Position 500, role "Finish" (red `"FF0000"`)

Assume `leds_per_hold = 1`, `scale = 1.0` (power OK).

**Step 1: Encode each LED**

LED 1 (pos=10, color="00FF00"):

```
pos_lo = 10 & 0xFF = 0x0A
pos_hi = (10 >> 8) & 0x03 = 0x00
R = floor(0x00 * 1.0) / 64 = 0
G = floor(0xFF * 1.0) / 64 = 3
B = floor(0x00 * 1.0) / 64 = 0
color_byte = (0 << 6) | (3 << 4) | (0 << 2) | 0x00 = 0x30
bytes: [0x0A, 0x30]
```

LED 2 (pos=256, color="0000FF"):

```
pos_lo = 256 & 0xFF = 0x00
pos_hi = (256 >> 8) & 0x03 = 0x01
R = 0, G = 0, B = floor(0xFF * 1.0) / 64 = 3
color_byte = (0 << 6) | (0 << 4) | (3 << 2) | 0x01 = 0x0D
bytes: [0x00, 0x0D]
```

LED 3 (pos=500, color="FF0000"):

```
pos_lo = 500 & 0xFF = 0xF4
pos_hi = (500 >> 8) & 0x03 = 0x01
R = floor(0xFF * 1.0) / 64 = 3
G = 0, B = 0
color_byte = (3 << 6) | (0 << 4) | (0 << 2) | 0x01 = 0xC1
bytes: [0xF4, 0xC1]
```

**Step 2: Build payload (Single, fits in one frame)**

```
payload = [0x50, 0x0A, 0x30, 0x00, 0x0D, 0xF4, 0xC1]
           P     LED1        LED2        LED3
```

**Step 3: Checksum**

```
sum = (0x50 + 0x0A + 0x30 + 0x00 + 0x0D + 0xF4 + 0xC1) & 0xFF = 0x4C
checksum = ~0x4C & 0xFF = 0xB3
```

**Step 4: Frame**

```
[0x01, 0x07, 0xB3, 0x02, 0x50, 0x0A, 0x30, 0x00, 0x0D, 0xF4, 0xC1, 0x03]
 SOH   LEN   CHK   STX   P     ---------- LED data ----------        ETX
```

---

## 18. Board Size Handling & LED Kit Variants

This section explains how the protocol supports different physical board sizes and LED kit configurations. This is critical for implementations targeting the **Kilter Board Homewall** product line.

### 18.1 Core Concept: productSizeId

The entire LED addressing scheme is parameterized by `productSizeId`. The same physical hole on a board can have a **completely different LED position index** depending on which board size/kit is in use. The `leds` table maps `(productSizeId, holeId) -> position`, and this `position` value is what gets encoded into the Bluetooth commands.

**The protocol itself is size-agnostic** - it just sends position+color pairs. All size-specific logic lives in the database lookup layer that resolves which LED positions to send.

### 18.2 Product Size Database (from bundled db.sqlite3)

#### Kilter Board Original (product_id=1)

| productSizeId | Name                      | Description | LEDs | Max Position | Edge Coords (L,R,B,T) |
| :-----------: | ------------------------- | ----------- | :--: | :----------: | --------------------- |
|       7       | 12 x 14                   | Commercial  | 527  |     527      | 0, 144, 0, 180        |
|       8       | 8 x 12                    | Home        | 311  |     311      | 24, 120, 0, 156       |
|      10       | 12 x 12 with kickboard    | Square      | 476  |     476      | 0, 144, 0, 156        |
|      14       | 7 x 10                    | Small       | 225  |     224      | 28, 116, 36, 156      |
|      27       | 12 x 12 without kickboard | Square      | 441  |     440      | 0, 144, 12, 156       |
|      28       | 16 x 12                   | Super Wide  | 641  |     641      | -24, 168, 0, 156      |

#### Kilter Board Homewall (product_id=7)

| productSizeId | Size     | LED Kit       |  LEDs   | Max Position | Edge Coords (L,R,B,T) |
| :-----------: | -------- | ------------- | :-----: | :----------: | --------------------- |
|      17       | 7x10     | Full Ride     |   305   |     304      | -44, 44, 24, 144      |
|      18       | 7x10     | Mainline      |   165   |     164      | -44, 44, 24, 144      |
|      19       | 7x10     | Auxiliary     |   140   |     139      | -44, 44, 24, 144      |
|      21       | 10x10    | Full Ride     |   391   |     390      | -56, 56, 24, 144      |
|      22       | 10x10    | Mainline      |   195   |     194      | -56, 56, 24, 144      |
|      29       | 10x10    | Auxiliary     |   196   |     195      | -56, 56, 24, 144      |
|    **23**     | **8x12** | **Full Ride** | **389** |   **389**    | -44, 44, -12, 144     |
|    **24**     | **8x12** | **Mainline**  | **219** |   **219**    | -44, 44, -12, 144     |
|      25       | 10x12    | Full Ride     |   499   |     499      | -56, 56, -12, 144     |
|      26       | 10x12    | Mainline      |   261   |     261      | -56, 56, -12, 144     |

### 18.3 Hold Set Mask (HSM) - The Bitmask System

Each wall tracks which hold sets are physically installed via a **bitmask** field called `hsm` (Hold Set Mask). Each hold set has a power-of-2 HSM value:

| Set ID | Name                | HSM Bit |   Bitmask    |
| :----: | ------------------- | :-----: | :----------: |
|   26   | Mainline            |    0    | `0b0001` = 1 |
|   27   | Auxiliary           |    1    | `0b0010` = 2 |
|   28   | Mainline Kickboard  |    2    | `0b0100` = 4 |
|   29   | Auxiliary Kickboard |    3    | `0b1000` = 8 |

A wall's `hsm` field is the OR of all installed sets. The `sqliteReadHSM()` function computes this by querying:

```sql
SELECT sets.hsm FROM sets WHERE sets.id IN (installed_set_ids)
-- Results are OR'd together: hsm = row1.hsm | row2.hsm | ...
```

#### LED Kit to Hold Set Mapping

The `product_sizes_layouts_sets` junction table defines which hold sets belong to each LED kit variant:

| LED Kit (productSizeId)  | Contains Sets                                                   |
| ------------------------ | --------------------------------------------------------------- |
| **8x12 Full Ride** (23)  | Mainline (26) + Auxiliary (27) + Mainline KB (28) + Aux KB (29) |
| **8x12 Mainline** (24)   | Mainline (26) + Mainline KB (28) + Aux KB (29)                  |
| **10x12 Full Ride** (25) | Mainline (26) + Auxiliary (27) + Mainline KB (28) + Aux KB (29) |
| **10x12 Mainline** (26)  | Mainline (26) + Mainline KB (28) + Aux KB (29)                  |

**Key insight**: Full Ride = Mainline + Auxiliary. The "Mainline" kit is a subset of "Full Ride":

- 8x12: Full Ride has **389 LEDs**, Mainline has **219 LEDs**, the Auxiliary-only difference is **170 LEDs**
- All 219 Mainline holes are a subset of the Full Ride holes

### 18.4 LED Position Differences Between Kit Variants

**Critical for implementations**: The same hole can have a **different LED position** on the Full Ride vs Mainline kit for the same board size. Of the 219 shared holes between 8x12 Full Ride (23) and 8x12 Mainline (24):

- **40 holes** share the same position on both kits (positions 0-39)
- **179 holes** have **different** position values

This means: **you cannot use Mainline LED positions on a Full Ride board or vice versa**. The `productSizeId` must exactly match the physical LED kit installed.

Example divergence (8x12):

```
Hole ID | Full Ride Position | Mainline Position
--------|-------------------|------------------
4157    | 0                 | 0                  (same)
4197    | 58                | 56                 (DIFFERENT)
3727    | 60                | 54                 (DIFFERENT)
4204    | 92                | 58                 (DIFFERENT)
```

### 18.5 WallMatchBits Validation

Before any LED command is sent, the protocol validates that the connected wall matches the climb's requirements:

```java
// WallMatchBits = (layoutId, productSizeId)
// Both must match exactly
public boolean equals(WallMatchBits other) {
    return this.layoutId == other.getLayoutId()
        && this.productSizeId == other.getProductSizeId();
}
```

In `BasicLEDWall.display()`:

```java
if (!this.wallMatchBits.equals(wallMatchBits)) {
    // Log: "wall match bits don't match, bailing out"
    return;  // Silently refuses to display
}
```

This means a climb designed for `productSizeId=23` (8x12 Full Ride) will **not display** on a wall configured as `productSizeId=24` (8x12 Mainline), even though they are the same physical board dimensions.

### 18.6 ledsPerHold Parameter

The `StdBluetoothService` takes a `ledsPerHold` constant at construction time, loaded from the app's resources:

```xml
<!-- resources/res/values/integers.xml -->
<integer name="leds_per_hold">2</integer>
```

For Kilter Board, this is **2** (each hold position has 2 physical LEDs). This value is:

- Used as a multiplier in the v2 power budget calculation: `if (ledsPerHold * totalPower <= 18.0)`
- Passed to `prepBytesV2()` for power scaling
- **Not used** in v3 (no power scaling)

### 18.7 Implementation Checklist for Board Size Support

To correctly support different board sizes:

1. **Store the user's wall configuration**: `productSizeId` + `layoutId` + `hsm` bitmask
2. **Query LED positions with the correct productSizeId**: The SQL join through `leds` MUST filter by `product_size_id = ?`
3. **Never mix LED positions from different productSizeIds**: Even for the same physical board size, Full Ride and Mainline have different position mappings
4. **Validate before sending**: Use WallMatchBits to ensure the climb's layout/size matches the connected board
5. **Filter available climbs by compatible hold sets**: A climb that uses Auxiliary holds cannot be displayed on a Mainline-only board
6. **Use the correct coordinate system**: Edge coordinates (edgeLeft, edgeRight, edgeBottom, edgeTop) differ per productSizeId and define the UI rendering bounds

### 18.8 Debugging 8x12 Homewall Issues

Given that 8x12 Homewall boards have reported issues while 10x10 and 10x12 work fine, here are likely root causes to investigate:

1. **Wrong productSizeId**: Using `productSizeId=8` (Original 8x12) instead of `23` (Homewall Full Ride) or `24` (Homewall Mainline). The Original and Homewall are different products with different LED mappings.

2. **Kit mismatch**: Sending Full Ride positions (productSizeId=23) to a board wired as Mainline (productSizeId=24) or vice versa. Since 179 of 219 shared holes have different positions, this would light up wrong holds.

3. **Position range**: 8x12 Full Ride has max position 389, 8x12 Mainline has max 219. Both fit in API v2's 10-bit limit (1023) and v3's 16-bit limit, so this shouldn't be an encoding issue.

4. **Hold set filtering**: Climbs that include Auxiliary-set holds would have missing LEDs on a Mainline-only board. The missing positions would simply be absent from the query results (since the LED row doesn't exist for that productSizeId).

---

## Appendix A: Relationship to Other Aurora Products

This protocol is shared across the Aurora Climbing product family. The `StdBluetoothService` is parameterized by:

- **`ledKitNameSubstring`**: Product-specific name filter (e.g., `"Kilter"`, `"Tension"`)
- **`ledsPerHold`**: Number of physical LEDs per hold position (affects v2 power calculation)

The same framing, command bytes, and encoding apply to all products. Only the scan filter, power parameters, and database content (placements, roles, colors) differ.

## Appendix B: Notification Setup

While the primary data flow is app-to-board (writes to RX), the protocol also supports board-to-app communication via TX characteristic notifications:

1. Get TX characteristic from UART service
2. Check properties: bit 16 (Notify) or bit 32 (Indicate)
3. Call `setCharacteristicNotification(characteristic, true)` on the GATT client
4. Write to CCCD descriptor:
   - If Notify: `ENABLE_NOTIFICATION_VALUE`
   - If Indicate: `ENABLE_INDICATION_VALUE`
5. Wait for `onDescriptorWrite` callback before proceeding

The `handleCharacteristicChanged()` method in `BasicLEDWall` is a no-op, suggesting board-to-app communication is either unused or handled by subclasses (like `StdLEDWall`).
