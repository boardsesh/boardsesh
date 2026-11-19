# Quantum Board Bluetooth protocol

Static analysis only, from `com.walltopia.ewalls2.apk`, SHA-256 `20c4e15e81491499e4487fe0b786c74734ca120bd9960defd10e81bc1537827f`. No device was connected and no radio commands were sent. This describes the shipped client, not a manufacturer-guaranteed firmware contract.

See the [API integration notes](QUANTUM_API_SPEC.md) for authentication,
catalog sync, APK provenance, tool versions, and reproduction commands.
`Fnnn +0xoffset` refers to a function ordinal and instruction offset in the
pinned Hermes bundle. The official Hermes v98 dump corroborates the encoder,
CRC, and packet construction. The earlier Python decoder's builtin-name and
undefined-literal annotations are not authoritative.

The app supports a binary protocol and an older JSON protocol. Discover the
peripheral's services and configuration before choosing an encoder. The
binary format described here is separate from Aurora's Bluetooth protocol.

## Discovery, GATT and protocol selection

| Role | UUID suffix | Evidence |
|---|---|---|
| Service candidate | `ffe0` | F829 constants |
| Preferred candidate when discovered | `fff0` | F829, F8341 |
| Notifications | `fff1` | same; F8342/F21669 resolve characteristic |
| Command write | `fff2` | same; F8342/F21669 |
| State read | `fff4` | same; persistent connection path F28691 |
| Configuration read | `fff5` | same; F8997 endpoint resolution |

Expand four-digit UUIDs with the Bluetooth base UUID (`0000xxxx-0000-1000-8000-00805f9b34fb`) in APIs requiring full UUIDs. The client normalizes discovery strings to lowercase. F8341 `resolveServiceUuid` at `0x003c27c6` prefers `fff0` when discovered, otherwise `ffe0`; use actual discovered service/characteristic relationships rather than hard-coding all characteristics beneath `ffe0`.

F9021 `isQuantumBoardName` (`0x003d0d35`) recognizes `QB_` and `QBB_` prefixes. F8450 `macAddressFromName` takes the final underscore-separated component, accepts exactly 12 hexadecimal characters, and inserts colons; invalid names return an empty string. This derived MAC is not necessarily the OS's peripheral identifier, especially on iOS.

F28670 `connectAndProbeProtocol` +0x89–0xa2 probes discovered `fff5`: presence selects `binary`, absence selects `json`. A name alone does not select the protocol. F8365 `shouldUseWriteWithResponse` (`0x003c2dca`) returns true only when the connection is persistent and binary, its peripheral ID matches the persistent peripheral ID, and its advertised local name (falling back to name) begins `QB_`. F28675 `write` +0xdce uses that result; +0x701 selects the native `write` or `writeWithoutResponse` method. Do not assume every binary board uses writes without response.

No application authentication/challenge was identified in these inspected connection paths. This does not establish whether any firmware requires OS pairing, bonding, or link encryption. Persistent connection establishes notifications and reads state/config; exact firmware compatibility requires hardware validation.

### Connection sequence for an integration

This is a proposed implementation sequence based on the traced client paths:

1. Request the platform's Bluetooth permissions, scan, and let the climber
   select a matching `QB_`/`QBB_` peripheral. Keep its OS identifier separate
   from any MAC address parsed out of its name.
2. Connect and discover services/characteristics. Resolve the actual `fff0`
   or `ffe0` service and `fff1`/`fff2` endpoints; inspect whether `fff5` exists.
3. Subscribe to notifications before writing. On the binary branch, read and
   validate the 41-byte `fff5` configuration; resolve the matching API board
   configuration and diode map.
4. Choose the branch's write mode, negotiate MTU where supported, and send a
   route-list request before an approved test activation. Treat the GATT write
   result and the board's application-level response as separate events.
5. Reconcile notifications with your own route/user state. Serialize commands,
   stop pending writes on disconnect, and rediscover/revalidate the controller
   after reconnecting.

The table and packet sections below provide the exact observed fields. This
sequence needs a real board before it can be considered a tested connection
recipe.

## Binary commands

All shown integer fields are unsigned big-endian. The device-address byte is `01` (F8459 constructor, shape 392 `DEVICE_ADDRESS`, numeric value 1; F8473 `writeHeader`). UUIDs are 16 bytes in displayed hexadecimal order after removing hyphens (F8476), not .NET mixed-endian GUID order. RGB is raw red, green, blue from `#RRGGBB` (F8475). Every command below ends in CRC16, **high byte then low byte** (F8477 → F8474).

| Command | Hex | Complete frame before CRC | Total bytes | Evidence |
|---|---:|---|---:|---|
| ACTIVATE_WALL | `41` | `01 41`, route UUID (16 bytes), user UUID (16 bytes), RGB (3 bytes), duration (2 bytes), flags (1 byte), diode-byte-count (1 byte), N diode IDs ×2 | `43+2N` | F8463,F8472 |
| TURN_OFF_ROUTE | `42` | `01 42`, route UUID (16 bytes) | 20 | F8466 |
| TURN_OFF_USER | `43` | `01 43`, user UUID (16 bytes) | 20 | F8467 |
| BOARD_SWIPE | `44` | same payload as ACTIVATE_WALL | `43+2N` | F8464,F8472 |
| TURN_OFF_ALL | `45` | `01 45 00 01 00 00` | 8 | F8468 +0x0f,+0x3c–0x6a |
| CHANGE_ROUTE_COLOR | `46` | `01 46`, route UUID (16 bytes), RGB (3 bytes), duration (2 bytes) | 25 | F8469 |
| REQUEST_ROUTE_LIST | `47` | `01 47`, row-number (1 byte) (default 0) | 5 | F8470 |
| TURN_ON_ALL | `64` | `01 64`, RGB (3 bytes), duration (2 bytes) | 9 | F8471 |
| SET_START_HOLDS | `65` | `01 65`, RGB (3 bytes), speed (2 bytes), diode-byte-count (1 byte), diode IDs ×2 | `10+2N` | F8465 |
| SET_STEP_HOLDS | `66` | same as above | `10+2N` | F8465 |
| SET_FINISH_HOLDS | `67` | same as above | `10+2N` | F8465 |

The command enumeration is F835 +0xd3–0x190. For `65/66/67`, missing speed defaults to 1000 (F836 +0x9f; F8465). The speed unit is not established by this analysis. Whole-board commands affect other climbers too; an integration should normally use the route/user-scoped commands for its own session.

ACTIVATE_WALL/BOARD_SWIPE offsets (F8472, absolute `0x003c45a7`; official dump line 580082):

| Offset | Length | Field |
|---:|---:|---|
| 0 | 1 | Device address `01` |
| 1 | 1 | Command `41` or `44` |
| 2 | 16 | routeId UUID |
| 18 | 16 | userId UUID |
| 34 | 3 | RGB |
| 37 | 2 | Duration |
| 39 | 1 | Flags / enableAnimation |
| 40 | 1 | `2*N`, NOT the diode count |
| 41 | `2*N` | Big-endian diode identifiers |
| `41+2*N` | 2 | Big-endian CRC |

The public encoder F8461 converts caller duration in minutes for ACTIVATE_WALL, BOARD_SWIPE and CHANGE_ROUTE_COLOR with F8492 `routeLightWireSeconds`: for finite duration below 65535, `clamp(round(minutes*60),1,65534)`; otherwise `65535`. For activation/swipe flags F8493 adds bit `0x80` for a finite explicit duration below 65535, retaining existing animation bits. Otherwise it retains flags and sends `ffff`, the client's board-default sentinel. Low animation-bit semantics are unknown. TURN_ON_ALL does not use that conversion in F8461; do not apply the minutes-to-seconds rule to it without validation. CHANGE_ROUTE_COLOR has no flags byte.

### CRC and packet construction pseudocode

F8478 `calculateCRC` starts at `0xffff`, visits all bytes except the final two allocated CRC bytes, and returns a 16-bit result. F8479 `crc16Update` XORs each byte, shifts right eight times, conditionally XORs `0xa001`. Thus the polynomial/update is CRC-16/MODBUS, but the client serializes the CRC big-endian. Official dump lines 580295–580357 corroborate the arithmetic and F8474 at line 580173 corroborates byte order.

```text
crc16(payload):
  crc = 0xffff
  for byte in payload:
    crc = crc XOR (byte AND 0xff)
    repeat 8 times:
      crc = ((crc >>> 1) XOR (0xa001 if crc AND 1 else 0)) AND 0xffff
  return crc

encodeActivate(routeUuid, userUuid, rgb, minutes, animation, diodeIds):
  require len(diodeIds) <= 92
  explicit = finite(minutes) and minutes < 65535
  seconds = clamp(round(minutes * 60), 1, 65534) if explicit else 65535
  flags = (animation OR (0x80 if explicit else 0)) AND 0xff
  payload = [0x01, 0x41]
  payload += uuidHexBytes(routeUuid) + uuidHexBytes(userUuid)
  payload += [red, green, blue] + u16be(seconds) + [flags, 2*len(diodeIds)]
  for id in diodeIds: payload += u16be(id)
  return payload + u16be(crc16(payload))
```

### Synthetic packet fixture

For route UUID `00112233-4455-6677-8899-aabbccddeeff`, user UUID
`ffeeddcc-bbaa-9988-7766-554433221100`, green `#00ff00`, one minute,
animation `0`, and diode addresses `[1, 258]`, the reconstructed encoder
produces this 47-byte activation frame:

```text
01 41 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff
ff ee dd cc bb aa 99 88 77 66 55 44 33 22 11 00
00 ff 00 00 3c 80 04 00 01 01 02 6e ea
```

The duration is `00 3c`, flags `80`, diode-byte-count `04`, diode addresses
`00 01 01 02`, and CRC `6e ea`. As a separate checksum sanity check,
ASCII `123456789` produces numeric CRC `0x4b37`, serialized here as `4b 37`.
These values were computed locally against the decoded algorithm; neither
packet was sent to hardware.

### Chunking

F835 defines `BLE_MAX_DIODES=92` for `41,44,65,66,67`; hard maximum 92 is separately defined for `41,44`. F8462 `chunkRequest` slices the diode list into groups of 92, copying the other request properties unchanged. F28673 `sendModbusData` +0x123–0x138 calls that method, encodes the resulting requests, and sends them sequentially. These are complete independently checksummed commands with repeated UUID/color/duration/header fields; there is no continuation index in the encoder. This is not slicing one encoded frame into 20-byte fragments. The firmware's append-versus-replace behavior across complete repeated commands, especially BOARD_SWIPE, remains a required validation point.

F32544 forwards each byte array and its full length as native write's maximum-byte-size argument. Android MTU candidates are `[512,247,185]` (F829 environment slot 36). Native writes have a 3000 ms timeout in this path (F829 slot 39, F32544). Exact lower-level native fragmentation behavior and effective firmware MTU must be checked on hardware; do not claim the whole 227-byte maximum activate frame always fits a negotiated ATT write.

The binary chunk loop (`F34675 +0x7b–0xcd`) waits for each result, accepts
`true` or `BleResult.SUCCESS`, aborts on another result, and sleeps **100 ms**
after a successful non-final chunk (`F829` slot 48). Preserve that sequencing;
do not send all chunks concurrently.

## Notifications and board state

F8331 `handleUpdateValueForCharacteristic` (`0x003c21c7`) converts each event's value to an array, forwards it to registered notification collectors, and calls F8499 `parseBroadcast` for values of at least three bytes. F8499 reads function code at byte 1; bit `0x80` marks an exception, original command is `fc & 0x7f`, and exception code is byte 2. Otherwise it dispatches through the handler table in F838 +0x101–0x17d.

F8505 `handleRouteSnapshotWithColor` (`0x003c4d60`, official function name same) handles `41`, `44`, and `47`. It requires at least four bytes. Byte2 is record count, byte 3 is skipped. Required length is `4 + count*37`. Each record is route UUID (16 bytes), user UUID (16 bytes), remaining seconds (2 bytes, BE), RGB (3 bytes). Zero count produces an empty active-player list. It ignores trailing bytes rather than establishing whether they are a CRC. Do not invent meaning for byte 3 or claim incoming CRC validation. The function parses one supplied notification value as a whole snapshot, with no fragment reassembly in this parser. Firmware notification fragmentation and row pagination semantics remain unknown.

| Other response | Observed decoder |
| --- | --- |
| `43`, user removed | `F8506` requires at least 21 bytes and reads the user UUID at offsets 2–17 |
| `45`, board cleared | `F8507` requires at least 6 bytes; no further payload validation in that handler |
| `64`, board lit | `F8508` requires at least 3 bytes and treats byte 2 equal to `255` as lit |

These decoders do not validate an incoming CRC. Fields beyond those described
remain unknown. Client state contains multiple active-player records with
userId, routeId, color, and remaining seconds; its maximum simultaneous
user/layer count is not established by these parsers.

For polling, `F28690 readRouteListViaGattRead` reads `fff4` through `F32550`
and feeds the returned bytes into the same broadcast parser. `F28689` avoids
passive reads while transmission/GATT work or a recent-write cooldown is
active. Serialize these reads with writes; do not assume every GATT read can
run concurrently with a route change.

F838's exception-code enumeration is: 1 illegal function, 2 illegal data address, 3 illegal data value, 4 device failure, 5 route in use, 6 spot unavailable, 7 color taken, 8 user ID in use, 9 no more users accepted, 10 user ID in routesetter mode, 11 ACAD ID not in map, 254 write-ack timeout. F8452 maps codes 5/6/7 to client results CONFLICT_ROUTE/CONFLICT_SPOT/CONFLICT_COLOR; other codes map COMMAND_REFUSED. Code 254 may be synthesized by the client; do not assume it is emitted by firmware.

## Configuration read (FFF5)

F8991 `parseBoardConfig` (`0x003d01ba`; official line596269) requires exactly 41 bytes, with name capacity 24 (module F1085 +0x2f–0x39).

| Offset | Length | Parsed property |
|---:|---:|---|
| 0 | 24 | NUL-terminated local name |
| 24 | 6 | MAC address bytes, lower-case colon-joined hex |
| 30 | 1 | protocolVersion |
| 31 | 3 | firmware major/minor/patch |
| 34 | 1 | boardType |
| 35 | 2 | width, BE |
| 37 | 2 | height, BE |
| 39 | 2 | autoTurnOffDuration, BE |

Units of autoTurnOffDuration are not established here. `F8992` maps the type
byte to the following strings; unknown values produce `undefined`:

| Type byte | Name |
| ---: | --- |
| 0 | `big` |
| 1 | `small` |
| 2 | `xsmall` |
| 3 | `belay` |
| 4 | `medium` |
| 5 | `shome` |

`F8993` converts the parsed structure into application board configuration.
Do not treat an unknown type as the default layout.

## Older JSON protocol

F28674 `sendJsonData` calls F8363 `jsonBoardBody`, removes fields `id,name,routeName,command,diodesCount,userId`, removes falsey diode entries, obtains `jsonWriteLimit`, and calls F8526 `packJsonDiodeWrites`. F21784 serializes `JSON.stringify({...body,diodes:chunk})`. F34676 +0x1da calls `stringToBytes` on that exact JSON string, with no appended delimiter in this path. F34964 passes those bytes to the common write method.

Each chunk is a complete JSON object with repeated common properties. F8524's `jsonWireLength` is JavaScript string length, not a general UTF-8 byte-length calculation. F841 defines ATT header 3 bytes and fallback JSON maximum 182 bytes. F28678 `jsonWriteLimit` uses negotiated Android MTU minus 3 when available, otherwise fallback 182. F8526 packs whole diode entries according to that budget and an optional count limit. Restrict synthetic examples to ASCII until the exact imported string conversion is traced; the bundle contains both ASCII-style F21731 and UTF-8 F21733 helpers.

`F8363` drops `duration` when color is black; `F8494` recognizes `#000000`
or `000000` after trimming. Otherwise the final JSON body helper only caps a
supplied finite numeric duration with `Math.min(1092, duration)`; it does not
itself round fractions or reject negative values. The upstream duration
helpers `F8496`/`F8497` perform rounding and the 1..1092-minute clamp.
The default is 31 minutes, using board configuration
`minutesToAutoDisconnect ?? activationDuration` when present (`F837
+0x21d–0x253`). A new integration should validate duration before serialization.
`F8363` warns that absent duration leaves the board's last duration; omission
does not establish a reset to a default.

## Hold identifiers and color mapping

The route-swipe caller `F33607 +0x332–0x366` explicitly selects the mapping:

| Protocol | Helper | Source property used as the wire address |
| --- | --- | --- |
| Binary | `F9225 diodesToAcadIds` → `F21973` | `autocadId` |
| JSON | `F9227 diodesToLedNodeIds` → `F21975` | `idLedNode` |

`F9226 diodesToLedIds` is another helper returning `ledId ?? 0`, but it is not
the binary branch selected by this caller. Preserve the upstream diode record
and route-to-diode association when importing the catalog. For a binary swipe,
resolve the route's referenced diodes to their `autocadId` values, validate
them as unsigned 16-bit addresses, then encode those addresses. A climb ID,
diode database `id`, `ledId`, and on-screen coordinate are not interchangeable.
The synthetic packet uses invented addresses and does not establish that those
addresses exist on a real controller.

F7033 `toBleColor` uses a palette map including UI `#396147` → wire `#00ff00`, UI `#005694` → wire `#00ffff`, UI `#DE0000` → wire `#ff00ff`, `#0000FF`→`#00ffff`, `#FF0000`→`#ff00ff`, and `#EEA70E`→`#ffff00`. The binary encoder accepts RGB generally; this is an application palette mapping, not proof firmware forbids other colors.

## Required partner/hardware confirmation

1. Exact firmware versions for the binary/JSON branches, pairing requirements, and whether FFF4/FFF1 responses match the decoded layouts.
2. Whether repeated activation chunks append, maximum active users/layers, and which conflict codes are emitted.
3. MTU/long-write behavior, whether the observed 100 ms pacing suffices, retry idempotency, write acknowledgment semantics, and code 254 provenance.
4. Meaning of notification byte 3, snapshot row pagination, incoming CRC presence, animation bits and hold-type speed units.
5. Confirm the traced `autocadId`/`idLedNode` mapping on each supported layout, including unavailable holds and variant changes.
