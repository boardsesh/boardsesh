# Woods Board Bluetooth Protocol Specification

**Version**: Derived from Woods Board Android app v1.6
**Transport**: Bluetooth Low Energy (BLE), Nordic UART Service
**Boards**: Woods Board (12×12) and Woods Board (8×10)

---

## Table of Contents

1. [Overview](#1-overview)
2. [BLE Service & Characteristic UUIDs](#2-ble-service--characteristic-uuids)
3. [Device Discovery](#3-device-discovery)
4. [Connection Lifecycle](#4-connection-lifecycle)
5. [LED Command Format](#5-led-command-format)
6. [Hold Role Codes](#6-hold-role-codes)
7. [Hold Position → LED Index Mapping](#7-hold-position--led-index-mapping)
8. [BLE Transmission](#8-ble-transmission)
9. [Data Pipeline: Climb to LEDs](#9-data-pipeline-climb-to-leds)
10. [Worked Example](#10-worked-example)
11. [Differences from the Aurora Protocol](#11-differences-from-the-aurora-protocol)

---

## 1. Overview

The Woods Board lights up holds to display a climbing problem on an addressable LED array
driven by an Arduino-class controller. A client sends the set of lit holds to the board over
Bluetooth Low Energy; the board colours each LED according to the hold's role (start / hand /
foot / finish).

Like the Aurora boards (see [AURORA_BLUETOOTH_PROTOCOL_SPEC.md](./AURORA_BLUETOOTH_PROTOCOL_SPEC.md)),
the Woods Board uses the **Nordic UART Service (NUS)** as a BLE serial transport. Unlike Aurora's
binary, checksummed framing, the Woods command is a **plain ASCII string** of comma-separated
`ledIndex,roleCode` pairs — the board's firmware parses the text directly.

**Key characteristics:**

- Unidirectional for LED control: the client writes a command to the board's RX characteristic.
- Payload is ASCII text, terminated by `,!`.
- Colour is **not** transmitted — the board derives each LED's colour from the hold role code.
- Two board sizes (12×12 and 8×10), each with its own hold-position → LED-index table.

## 2. BLE Service & Characteristic UUIDs

The board exposes the standard Nordic UART Service:

| Role                                      | UUID                                   |
| ----------------------------------------- | -------------------------------------- |
| Service (NUS)                             | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX characteristic (client → board, write) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |

LED commands are written to the RX characteristic. (The board does not need to be paired/bonded —
a plain GATT connect + service discovery is sufficient.)

## 3. Device Discovery

Scan for peripherals advertising the NUS service UUID (`6E400001-…`) and match the advertised
**device name** against these patterns:

| Pattern (case-insensitive) | Board generation |
| -------------------------- | ---------------- |
| `Woods Board`              | v1               |
| `Woods Board v2`           | v2               |

Both generations speak the same LED command format described here. A short scan window
(~2.5 s) is sufficient.

## 4. Connection Lifecycle

1. Stop scanning.
2. GATT connect to the selected peripheral.
3. Discover services (retrieve the NUS service + RX characteristic).
4. Write LED commands to the RX characteristic as the selected problem changes.

No bonding, authentication, or handshake is required before sending LED commands.

## 5. LED Command Format

A command lists every lit hold and ends with a terminator token:

```
<ledIndex>,<roleCode>,<ledIndex>,<roleCode>, … ,<ledIndex>,<roleCode>,!
```

- For each lit hold, emit two comma-separated integers: the **physical LED index** (from the
  position→LED table for the board size, §7) followed by the hold's **role code** (§6).
- Pairs are concatenated with `,`.
- The whole message is terminated with the literal token `,!`.
- Holds whose role is "off" are omitted.

The resulting ASCII string is encoded to bytes (UTF-8 / one byte per character) and written to
the RX characteristic.

```
message = holds
  .filter(h => h.role !== OFF)
  .map(h => `${ledIndex(h.baseHoldLocation, boardSize)},${roleCode(h.role)}`)
  .join(',') + ',!'
```

## 6. Hold Role Codes

| Role   | Code |
| ------ | ---- |
| Foot   | `1`  |
| Hand   | `2`  |
| Finish | `3`  |
| Start  | `4`  |

The board firmware maps these codes to LED colours; colour is therefore never present in the
wire format.

## 7. Hold Position → LED Index Mapping

A hold's logical position (`baseHoldLocation`, the same identifier used by the Woods data API's
`holdList`) is translated to a **physical LED index** on the strip via a per-board-size lookup
table. The board size determines which table to use:

| Board size | Lookup table                                                                               | Entries | `baseHoldLocation` range | LED index range |
| ---------- | ------------------------------------------------------------------------------------------ | ------: | ------------------------ | --------------- |
| 8×10       | [`woods-board-led-maps/light-map-8x10.json`](./woods-board-led-maps/light-map-8x10.json)   |     485 | 0–484                    | 0–484           |
| 12×12      | [`woods-board-led-maps/light-map-12x12.json`](./woods-board-led-maps/light-map-12x12.json) |     894 | 0–893                    | 0–897           |

Each file is a JSON object mapping `baseHoldLocation` (as a string key) to the LED index, e.g.
the 12×12 table begins:

```json
{ "0": 28, "1": 29, "2": 132, "3": 133, "4": 236, "5": 237, "6": 340, "7": 341, "8": 444, "9": 445 }
```

A lookup that returns no entry means that position has no LED on that board size and should be
skipped.

## 8. BLE Transmission

- Commands are written to the RX characteristic with a **write request** (acknowledged write).
- The encoded string is split into **20-byte** chunks (the default GATT write payload size); the
  board reassembles the chunks until it sees the `,!` terminator.
- A new full command replaces the previous one (send the complete lit-hold list each time the
  displayed problem changes); there is no incremental/delta update.

## 9. Data Pipeline: Climb to LEDs

1. Take the problem's holds (each a `baseHoldLocation` + role). From the Woods data API these
   come from a problem's `holdList` (`{ type, baseHoldLocation }`).
2. Drop any hold whose role is "off".
3. For each remaining hold, look up its LED index in the table for the board size (§7) and pair
   it with its role code (§6).
4. Join the pairs with `,` and append `,!`.
5. Encode to bytes and write to the RX characteristic (§8).

## 10. Worked Example

Problem on the **12×12** board with three holds:

| `baseHoldLocation` | Role   | LED index (12×12 table) | Role code |
| ------------------ | ------ | ----------------------- | --------- |
| 0                  | Start  | 28                      | 4         |
| 5                  | Hand   | 237                     | 2         |
| 7                  | Finish | 341                     | 3         |

Command string:

```
28,4,237,2,341,3,!
```

Written (chunked at 20 bytes) to characteristic `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`.

## 11. Differences from the Aurora Protocol

|                | Aurora (Kilter/Tension/…)                                  | Woods Board                                               |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Transport      | Nordic UART Service                                        | Nordic UART Service                                       |
| Payload        | Binary, length-prefixed, checksummed frames                | Plain ASCII `,`-separated pairs + `,!`                    |
| Colour         | Per-LED RGB in the payload                                 | Implicit — board colours by role code                     |
| Position model | LED position + colour                                      | `baseHoldLocation` → LED index via lookup table           |
| Multi-part     | Explicit `MIDDLE/FIRST/LAST/ONLY` command bytes + checksum | Single string, chunked at the GATT layer, `,!` terminator |

Both can share the NUS scan/connect plumbing in `@boardsesh/ble-protocol`; only the
command-encoding layer differs.
