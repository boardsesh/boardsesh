# Quantum Board Bluetooth Protocol Specification

**Source**: eWalls Android 2.6.5 research ([#7926](https://github.com/boardsesh/boardsesh/pull/7926)) and the codec in this package
**Transport**: Bluetooth Low Energy, one complete GATT write per command
**Controllers**: binary Quantum Board controllers advertising `QB_` or `QBB_` names

Every byte layout below is what `src/codec.ts` encodes or accepts. Physical
controller acceptance is a separate question: the
[verification limits](../../../../docs/boards/quantumboard.md#verification-limits)
in the product notes still apply, and firmware layer capacity is unknown. The
model table includes the Belay Board; which models an application offers is
its own policy. This is an independent compatibility implementation, not
manufacturer-endorsed software.

---

## Table of Contents

1. [Services and characteristics](#1-services-and-characteristics)
2. [Device names and write modes](#2-device-names-and-write-modes)
3. [Command frames](#3-command-frames)
4. [Controller frames](#4-controller-frames)
5. [Controller metadata](#5-controller-metadata)
6. [Roster transactions](#6-roster-transactions)
7. [Portable session](#7-portable-session)
8. [Boardsesh limits and transport notes](#8-boardsesh-limits-and-transport-notes)

---

## 1. Services and characteristics

| UUID | Name | Use |
| --- | --- | --- |
| `0000fff0-0000-1000-8000-00805f9b34fb` | Service | Current controller generation; tried first |
| `0000ffe0-0000-1000-8000-00805f9b34fb` | Legacy service | Tried only when FFF0 is absent |
| `0000fff1-…` | FFF1 notify | Controller frames, one complete frame per notification |
| `0000fff2-…` | FFF2 write | Command frames |
| `0000fff4-…` | FFF4 state | Read after `0x47` for the route list (§6) |
| `0000fff5-…` | FFF5 metadata | Read: 41-byte controller description |

All four characteristics must come from the same service; they are never
combined across FFF0 and FFE0. A controller without FFF5 speaks the older JSON
protocol, which is unsupported.

## 2. Device names and write modes

| Advertised name | Serial | FFF2 write mode |
| --- | --- | --- |
| `QB_<12 hex digits>` | Text after the last `_` | Write with response |
| `QBB_<12 hex digits>` | Text after the last `_` | Write without response |

The prefixes are case-sensitive and the serial must be exactly 12 hexadecimal
digits (`parseQuantumDeviceSerial`). Both modes need roster confirmation (§6):
a successful write proves only that the transport accepted the bytes.

## 3. Command frames

```
01 <command> <payload…> <crc hi> <crc lo>
```

The CRC is CRC-16/MODBUS (initial `0xFFFF`, reflected polynomial `0xA001`) over
every byte before it, sent big-endian. Multi-byte integers are big-endian. A
UUID is its 16 bytes in textual order.

| Command | Name | Payload | Frame bytes |
| --- | --- | --- | --- |
| `0x41` | Activate wall | Activation (below) | 43 + 2 per diode |
| `0x42` | Turn off by route | Route UUID | 20 |
| `0x43` | Turn off by user | User UUID | 20 |
| `0x44` | Board swipe | Activation (below) | 43 + 2 per diode |
| `0x45` | Turn off all | `00 01 00 00` | 8 |
| `0x47` | Request user route list | Row byte, always `00` | 5 |
| `0x64` | Turn on all | RGB, duration | 9 |

Activation payload, 41 bytes plus the diodes:

| Offset in frame | Bytes | Field |
| --- | --- | --- |
| 2 | 16 | Route UUID |
| 18 | 16 | User UUID (the layer owner) |
| 34 | 3 | RGB colour; default `00 FF FF` |
| 37 | 2 | Duration in seconds, 1–65535; `FF FF` means the board default |
| 39 | 1 | Animation, 0–255; bit 7 is ORed in for any duration other than `FF FF` |
| 40 | 1 | Byte count of the diode list (2 × diodes) |
| 41 | 2 each | Diode addresses, 0–65535 |

An activation carries 1 to 92 diodes, so the largest frame is 227 bytes. The
documented one-minute fixture is
`014100112233445566778899aabbccddeeffffeeddccbbaa9988776655443322110000ff00003c8004000101026eea`
(route `00112233-…`, user `ffeeddcc-…`, green, 60 s, diodes 1 and 258). The route
request is `01 47 00 f0 13`.

## 4. Controller frames

Controller frames start with `01`. The parser does not check a CRC on them.
FFF1 delivers one frame per notification value: a payload is never scanned for
a second frame, because UUIDs and trailers can contain marker bytes. Values the
parser does not recognise are ignored.

| Byte 1 | Meaning | Minimum length | Fields |
| --- | --- | --- | --- |
| `0x41`, `0x44`, `0x47` | Roster | 4 + 37 × players | Byte 2 player count, byte 3 reserved, then 37-byte records |
| `0x43` | User removed | 21 | User UUID at offset 2 |
| `0x45` | Wall cleared | 6 | — |
| `0x64` | Wall lit | 3 | Byte 2 `FF` means white |
| bit 7 set | Controller error | 3 | Failed command in the low 7 bits; byte 2 is the code |

A roster record is route UUID (16), user UUID (16), remaining seconds (2),
RGB (3). Trailing bytes after the last record are ignored.

| Error code | Failure |
| --- | --- |
| 5 | `route-in-use` |
| 6 | `spot-unavailable` |
| 7 | `color-taken` |
| 8 | `user-id-in-use` |
| 9 | `board-full` |
| 10 | `routesetter-mode` |
| 11 | `diode-missing` |
| 254 | `ack-timeout` |
| other | `refused` |

## 5. Controller metadata

FFF5 returns exactly 41 bytes. Byte 34 is the controller type; bytes 35–36 are
the column count and bytes 37–38 the row count. A value is accepted only when
all three match one row of this table (`parseQuantumControllerMetadata`):

| Model id | Product | Controller type | Columns × rows |
| --- | --- | ---: | --- |
| `xl` | XL | 0 | 15 × 15 |
| `l` | L | 4 | 15 × 12 |
| `m` | M | 1 | 12 × 12 |
| `s` | S Fitness | 2 | 8 × 12 |
| `belay` | Belay Board | 3 | 8 × 12 |

Diode addresses are model-specific. A caller that selected one model must refuse
a controller reporting another before sending any diode address.

## 6. Roster transactions

`QuantumRosterTransactionMachine` serializes refreshes and layer mutations. It
never updates the roster from write success, never fragments a frame, and
rejects a frame that does not fit one transport write before sending anything.

**Fresh roster.** Write `0x47`, wait 50 ms, read FFF4. Only a `0x47` roster is
accepted; a controller error fails the transaction. If the read fails or FFF4
holds any other frame, wait up to 3 s for a `0x47` roster or a controller error that arrived on
FFF1 after the request was written. A roster with more than four players is
refused as `board-full`.

**Activate** (`0x41`, or `0x44` for a swipe):

1. Refuse the zero user UUID and encode the full frame.
2. Read a fresh roster. When the caller supplied the roster it checked, it must
   still match, ignoring countdowns.
3. Ownership: without `expectedOwnedRouteId` the user must own no layer; with it
   the user must own exactly that route.
4. A new player on a four-layer wall is `board-full`. A route or colour held by
   another user is `roster-changed` or `color-in-use`.
5. If the user owns a layer, write `0x43` for that user, wait 50 ms, read a
   fresh roster and confirm the user's layer is gone and every other layer survived.
6. Write the activation, wait 250 ms and read a fresh roster. It must show
   exactly one layer for the user, with the requested route and colour, and every
   other layer must have survived.

**Remove**: read a fresh roster. If the user owns nothing, return it without
writing. Otherwise the user must own exactly the given route; write `0x43`, read
a fresh roster without the extra 50 ms wait, and confirm as in step 5.

A layer survives when its route, user and colour are unchanged. A layer may
disappear only if its last reported remaining seconds are at most the elapsed
monotonic seconds since the first roster, rounded up. A controller error for the
mutation, buffered on FFF1 since it was written, fails the transaction as
`controller-refused`. The caller's eligibility check runs before every write,
after the optional pre-write check, and around every read. The portable session
(§7) keeps that check tied to the connection and applies a caller's
`AbortSignal` only to frames not yet written.

No transaction sends `0x45`. Clearing the wall would remove other climbers' layers.

## 7. Portable session

`createQuantumBleProtocol({ expectedModelId }).open(transport)` takes a
connected `BleTransport` from `@boardsesh/ble-core` and writes nothing.
`expectedModelId` is required and must be a model id from §5:

1. Refuse a non-positive `maxWriteBytes`, one below 45 bytes (a single-diode
   activation, `QUANTUM_MIN_WRITE_BYTES`) and a name outside §2.
2. Look up FFF1, FFF2, FFF4 and FFF5 one at a time, on FFF0 and then on FFE0.
   Only `BleError('service-missing')` moves on to FFE0; other errors close the link.
3. Check FFF2 supports the write mode for the name.
4. Read FFF5. Missing or invalid metadata, or another model, throws
   `QuantumControllerModelMismatchError`.
5. Enable FFF1 notifications; `subscribe()` resolves once they are on.

Aborting the signal passed to `open()` closes the link and rejects with
`BleError('cancelled')`.

The session's `show()` and `clear()` always reject `BleError('unsupported')`.
`refreshRoster()`, `activateLayer()` and `removeLayer()` run §6 through one queue.
FFF2 accepts only `0x41`, `0x43`, `0x44` and `0x47`; any other command is
refused with `BleError('unsupported')` before a write. Each FFF2 write, FFF4
read and FFF5 read has a 5 s deadline, and each setup lookup or subscription
another 5 s. A timed-out write or read, or a roster notification wait that
expires, closes the link: nothing proves the platform cancelled the operation.
An FFF1 notification error also closes the session. The 50 ms and 250 ms
delays and every deadline run on the injected `BleScheduler`; elapsed time
for the layer-survival rule uses `performance.now()`.

`rosterState` is the last roster a transaction confirmed. FFF1 roster and
wall-cleared broadcasts do not update it; `onBroadcast()` delivers them.

The caller's `isEligible` and `assertTargetAvailable` checks run inside the
queue with no deadline, as in the app adapters. One that never settles holds
later calls until `disconnect()`.

**Cancellation.** Aborting a layer call's signal rejects the call with
`BleError('cancelled')` at once. The transaction then sends no mutation it had
not yet written. If it had already written one (`0x41`, `0x43` or `0x44`), its
`0x47` read-back still runs under the connection, so `rosterState` shows what
the wall holds. For the wall, a cancelled call either changed nothing, or made
the change and confirmed it, or (a replacement cancelled after `0x43`) removed
the climber's old layer without lighting the new one. The next call starts from
its own fresh roster; `refreshRoster()` queues behind the read-back.

**Differences from the Boardsesh app adapters** (`quantum-adapter.ts`,
`quantum-adapter.web.ts` and `QuantumBoardController` in `packages/mobile`):

| Behaviour | This session | App adapters today |
| --- | --- | --- |
| FFF1 notification error | Closes the session | Native ignores monitor errors |
| Roster notification wait expires (3 s) | Closes the link | Native closes it; web does not |
| Deadlines | 5 s per write, read and setup step | Native: the same 5 s; web: none |
| FFF4 read times out | Always closes the link | Native stops using FFF4 for that link when it could cancel the read, and closes only when it could not |
| FFE0 fallback | Only after `service-missing` | After any FFF0 error |
| Write size | Refuses `maxWriteBytes` below 45 | No floor; Android gives up only when even an MTU 185 request fails |
| `rosterState` | Confirmed transaction rosters only | `QuantumBoardController` also folds FFF1 rosters and wall-cleared broadcasts into its roster |
| Caller cancellation | `AbortSignal`, as above | None; `isEligible` turns false only while the link is abandoned |
| Commands written | `0x41`, `0x43`, `0x44`, `0x47` only | Any frame passed in |
| Link failures | `BleError` (`disconnected`, `timeout`, `cancelled`) | Plain `Error`, or the machine's `transport-failed` |
| Transaction delays | The injected scheduler | Global `setTimeout` |

A connector must report the payload sizes the adapters use: Android 182 or more
after requesting MTU 512, 247 and 185 in turn; iOS `QB_` 512 (acknowledged long
writes); otherwise the negotiated MTU minus 3; Web Bluetooth 509. Above the
45-byte floor, an activation longer than the limit is refused as
`frame-too-large` before any write.

## 8. Boardsesh limits and transport notes

Moved from the Quantum product notes:

Boardsesh currently understands four simultaneous colored layers and caps activation
at 92 distinct diode addresses. Each player controls one layer. These are current application limits; the
firmware's layer capacity and repeated-chunk behavior are unverified. The
provider and encoder reject oversized activation before any command. Commands
must fit one complete, mode-appropriate GATT write; frames are not silently
fragmented. Persistent binary `QB_` boards use writes with response and `QBB_`
boards use writes without response; both require separate roster confirmation.

Discovery prefers the actual `fff0` service over `ffe0` and probes `fff5` for
binary configuration. The older JSON protocol and unknown model types are
explicitly unsupported. Finite activation durations set the explicit-duration
flag; the board-default sentinel remains `ffff`. Scoped removal frames are 20
bytes. Android tries MTUs 512, 247, and 185 and still checks actual write capacity.
Whole notification values accept the documented reserved byte and trailers;
oversized rosters cannot be truncated or reinterpreted as embedded packets.
