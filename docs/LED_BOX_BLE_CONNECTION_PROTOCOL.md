# LED Box Bluetooth Connection Protocol

**Source app**: Kilter Board (`com.kiltergrips.kilter_board_app`) **v2.5.2** (build 48)
**Distribution**: APKPure (XAPK), analysed 2026-06-27
**Stack**: Flutter (Dart AOT, engine Dart `3.10.4` stable) + [`flutter_blue_plus`](https://pub.dev/packages/flutter_blue_plus)
**Transport**: Bluetooth Low Energy (BLE), Nordic UART Service

> **Legal basis & scope.** This analysis is limited to the **BLE interoperability interface** — the unencrypted Bluetooth protocol used to drive the Kilter Board's LEDs — and was produced solely to build and verify a compatible client for the same hardware. That purpose is the interoperability rationale set out in [`LEGAL.md`](../LEGAL.md) (§ Interoperability & Hardware Compatibility; _Sega v. Accolade_, EU Directive 2009/24/EC Art. 6), the same basis as [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](./AURORA_BLUETOOTH_PROTOCOL_SPEC.md). It documents only the LED-control protocol; the app's accounts, backend services, and other internals are out of scope and intentionally omitted. "Kilter Board" is a trademark of its owner; Boardsesh is not affiliated with or endorsed by the manufacturer.

---

## What this document is

This is a **second, independent read** of the Aurora LED-box BLE protocol, reconstructed from the official Kilter Grips Flutter app rather than from the Aurora Climbing Android app. It exists to **cross-validate** the protocol Boardsesh already implements and to capture what this newer, separately-built app does differently.

It is a companion to:

- [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](./AURORA_BLUETOOTH_PROTOCOL_SPEC.md) — the detailed wire-format spec derived from the **Aurora** Kilter app (v3.6.4 / build 202).
- [`packages/shared/ble-protocol/src/aurora.ts`](../packages/shared/ble-protocol/src/aurora.ts) — Boardsesh's shipped, working implementation.

The two apps are built by different teams on different stacks (this one is Flutter; the Aurora one is native Android), yet they drive the **same controller boxes**, so the wire format is necessarily the same. Every byte-level claim below was checked against both the existing spec and the working `aurora.ts`.

### Provenance tags

Each claim is tagged so you can tell evidence from inheritance:

- ✅ **Verified from this APK** — found directly in `libapp.so` (string table, ELF `.rodata`, Dart symbol names) or the APK manifest/assets.
- 🔁 **Shared Aurora wire format** — the byte-level framing/encoding this app must speak to the same hardware. Not independently re-derived from this app's machine code (see [Methodology & limitations](#methodology--limitations)); cross-referenced from the Aurora spec + `aurora.ts`.
- ❓ **Observed, unconfirmed** — present in the binary, exact role not proven by static analysis. Flagged for a live BLE capture.

---

## TL;DR

| Question                                      | Answer                                                                                                                                                       | Tag     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Same protocol as Aurora app?                  | **Yes.** Identical service/characteristic UUIDs and advertised-service scan filter.                                                                          | ✅      |
| BLE library                                   | `flutter_blue_plus`                                                                                                                                          | ✅      |
| Writes LED data to                            | RX char `6E400002-…` (Nordic UART RX); **write-with-response, unconditionally** (see §6.5)                                                                   | ✅      |
| Subscribes to board notifications?            | **No.** TX char `6E400003-…` does **not** appear anywhere in the binary — the app is write-only.                                                             | ✅      |
| Negotiates MTU?                               | **No.** `flutter_blue_plus` exposes the MTU API (`BmMtuChangeRequest`) but the app never calls `requestMtu`; it uses fixed **20-byte** chunks, 100 ms apart. | ✅      |
| Picks which board?                            | Ranks scan results, reads RSSI per device (`BmReadRssiResult`) to surface the nearest.                                                                       | ✅ / ❓ |
| Frame framing / checksum / v2-v3 LED encoding | SOH·LEN·CHK·STX·payload·ETX, `~sum` checksum, 2-byte (v2) / 3-byte (v3) LED records.                                                                         | ✅      |
| Extra UUIDs                                   | Three 128-bit UUIDs present that are **not** part of the LED write path; role unconfirmed.                                                                   | ❓      |

---

## 1. BLE stack & permissions

✅ The app talks BLE through `flutter_blue_plus`. The binary carries the library's full message surface — `BmScanSettings`, `BmScanResponse`, `BmScanAdvertisement`, `BmBluetoothAdapterState`, `BmMtuChangeRequest`, `BmMtuChangedResponse`, `BmReadRssiResult`, `BmTurnOnResponse`, `BluetoothCharacteristic`, `BluetoothService`, `BluetoothDevice` — and `[FBP] …` log lines.

✅ Android permissions (from `manifest.json`):

```
android.permission.BLUETOOTH_SCAN
android.permission.BLUETOOTH_CONNECT
android.permission.BLUETOOTH
android.permission.BLUETOOTH_ADMIN
android.permission.ACCESS_FINE_LOCATION
android.permission.ACCESS_COARSE_LOCATION
android.permission.FOREGROUND_SERVICE
```

`minSdk 24`, `targetSdk 36`. The permission prompt copy: _"Bluetooth access is needed to find and connect to your Kilter Board Climbing Wall."_

The app's own BLE layer (Dart) sits on top of `flutter_blue_plus`:

| Dart symbol (from `libapp.so`)                        | Role                                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `_ensureBluetoothPermissions`                         | Permission gate before scanning                       |
| `_initAndScan`, `_startScan`                          | Start a filtered BLE scan                             |
| `_ranked`, `_rrPool`                                  | Rank/track discovered controller boxes (RSSI-ordered) |
| `_connectToBoardByName`                               | Connect to a chosen board                             |
| `_showBluetoothScanDialog`, `_showOpenSettingsDialog` | Scan UI / "open settings" fallback                    |
| `_displayClimb`, `_displayClimbFrame`                 | Push a climb (or one animation frame) to the wall     |
| `_colorFromHex`, `_brightnessFor`                     | Resolve LED colour + brightness                       |

---

## 2. Service & Characteristic UUIDs

✅ All of these literals are present in `libapp.so` `.rodata`:

| Name                                  | UUID                                   | Used as                                                                                       | Tag |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- | --- |
| **Aurora Board Service** (advertised) | `4488B571-7806-4DF6-BCFF-A2897E4953FF` | BLE scan filter (`withServices`)                                                              | ✅  |
| **Nordic UART Service**               | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | Data service discovered after connect                                                         | ✅  |
| **RX characteristic**                 | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | App **writes** LED commands here                                                              | ✅  |
| **TX characteristic**                 | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | **Absent from the binary** — not used                                                         | ✅  |
| **CCCD**                              | `00002902-0000-1000-8000-00805f9b34fb` | Standard descriptor constant (from `flutter_blue_plus`; no notify subscription on this board) | ✅  |

> **Difference vs. the Aurora-app spec:** the Aurora spec documents a (no-op) notification setup path on TX `6E400003`. **This app contains no reference to `6E400003` at all** — confirming LED control is strictly **app → board**, write-only. There is no board-to-app channel in use.

### 2.1 Three additional UUIDs ❓

These 128-bit UUIDs also appear in `libapp.so` (each exactly once, `.rodata`), and are **not** part of the LED write path above:

| UUID                                   | `.rodata` vaddr |
| -------------------------------------- | --------------- |
| `d9b1fad4-0d22-4d20-8521-04166b28cd24` | `0x002b4bd4`    |
| `191b6169-b8ea-47b6-bf19-4c0c08da7207` | `0x002bc4ec`    |
| `73a2a497-3dd3-46d1-b34b-00d0de25ccc3` | `0x002f8bd4`    |

They do not match any standard GATT service, Nordic DFU, or a known analytics SDK namespace, and they appear in neither `classes.dex` nor the Flutter assets. **Their purpose is unconfirmed.** Plausible candidates, in rough order of likelihood:

1. A secondary service/characteristic set exposed by newer **controller-box firmware** (e.g. serial-number / firmware-version / config read — the app surfaces a _"Controller Box Serial Number"_ field).
2. Non-BLE app constants (a generated namespace, default identifier, etc.).

**To confirm, capture a live session** (nRF Connect, Android HCI snoop log, or Boardsesh's own Web Bluetooth path) and check whether the app ever does GATT discovery/IO against these UUIDs. Until then, an interoperable client only needs the five UUIDs in §2.

---

## 3. Device discovery (scan)

✅ The app starts a `flutter_blue_plus` scan filtered by the **advertised Aurora service** `4488B571-…` (`BmScanSettings` + `android_scan_mode`). Discovered devices are passed through `_ranked` / `_rrPool`, and the app issues `readRssi` (`BmReadRssiResult`, `…, rssi: …`) so the scan UI can order controller boxes by proximity and pre-select the nearest one.

Connect-flow UI strings (✅): _"Choose Kilter Board"_, _"Connect to Board"_, _"Connect to Kilter Board"_, _"Could not connect to …"_.

> **Difference vs. the Aurora-app spec:** the Aurora app filters scan results by a product **name substring** (`"Kilter"`). This app's primary filter is the **advertised service UUID**; RSSI ranking of candidates is a UX addition not described in the older spec.

---

## 4. Device name format

🔁 Aurora controller boxes advertise a BLE name of the form:

```
{DisplayName}#{SerialNumber}@{APILevel}
```

- **Display name** — e.g. `Kilter Board` (this app knows the product variants _"Kilter Board Original"_ and _"Kilter Board Homewall"_ ✅).
- **Serial number** — `#…`; this is the **Controller Box Serial Number** the app displays ✅ and persists (`walls.serial_number`, see §7).
- **API level** — `@2` or `@3`; selects the LED encoding (see §6). Defaults to **2** when absent.

Boardsesh parses exactly this format today — see `parseApiLevel` / `parseSerialNumber` / `parseBoardTypeFromDeviceName` in [`aurora.ts`](../packages/shared/ble-protocol/src/aurora.ts).

---

## 5. Connection lifecycle

✅ Symbols + `flutter_blue_plus` semantics give this sequence:

```
ensure BLE permissions  (_ensureBluetoothPermissions)
        │
        ▼
scan, filtered by service 4488B571…   (_initAndScan / _startScan)
        │   rank candidates by RSSI    (_ranked / _rrPool / readRssi)
        ▼
user picks a board → connect by name  (_connectToBoardByName)
        │   autoConnect supported; FBP "[FBP] connection timeout" on failure
        ▼
discover services → Nordic UART (6E400001…)
        │
        ▼
locate RX characteristic (6E400002…)   (no MTU request — fixed 20-byte writes)
        │
        ▼
READY → write LED frames               (_displayClimb / _displayClimbFrame)
        │
        ▼
disconnect                             ("[FBP] disconnect: enforcing")
```

✅ Notable `[FBP]` log lines in the binary: `[FBP] connection timeout`, `[FBP] [AutoConnect] connection failed:`, `[FBP] disconnect: enforcing`, `[FBP] stopScan: already stopped`.

> **Same as the Aurora-app spec here:** this app does **not** negotiate MTU — the arm64 method bodies show no `requestMtu` call, and it writes fixed **20-byte** chunks (100 ms apart), matching the Aurora Android app (`com.auroraclimbing.tensionboard2` v5.0.6, independently decompiled: 20-byte hardcoded chunks, no `requestMtu()`, same UUIDs). The earlier "explicit MTU negotiation" reading was inferred from the presence of `flutter_blue_plus`'s `BmMtuChangeRequest` symbol, which the app never actually calls. Boardsesh is the outlier that negotiates MTU (see §6.5).

---

## 6. Wire protocol (LED command format)

✅ The byte format below is now confirmed from this app's **arm64 method bodies** (`convertMessage` / `addBoilerPlate` / `encodePositionV2` / `encodePositionV3` / `encodeColorV3`; see [Methodology](#methodology--limitations)) and matches the shared Aurora wire format in the Aurora spec and the shipped `aurora.ts`. Corroborating symbols: `_checkSum`, `_colorFromHex`, `_brightnessFor`, `_displayClimb`, `_displayClimbFrame`. (The v2 power-budget scaling in §6.6 is the one part not located as explicit constants in the snapshot — it stays 🔁, inherited from `aurora.ts`.)

### 6.1 Frame structure

```
+-----+--------+----------+-----+-----------------+-----+
| SOH | LENGTH | CHECKSUM | STX |    PAYLOAD      | ETX |
| 0x01| 1 byte | 1 byte   | 0x02| 0-255 bytes     | 0x03|
+-----+--------+----------+-----+-----------------+-----+
```

`LENGTH` is the payload byte count (max 255). Total frame = payload + 5 bytes.

### 6.2 Checksum

Bitwise-NOT of the 8-bit running sum of the payload:

```python
def checksum(payload: list[int]) -> int:
    total = 0
    for b in payload:
        total = (total + b) & 0xFF
    return (~total) & 0xFF
```

Matches `wrapBytes` / `checksum` in `aurora.ts`:

```ts
const checksum = (data) => data.reduce((acc, v) => (acc + v) & 255, 0) ^ 255;
const wrapBytes = (data) => [1, data.length, checksum(data), 2, ...data, 3];
```

### 6.3 Payload = command byte + LED records

First payload byte is a **command byte** that doubles as a multi-part marker:

| Marker        | API v2 | ASCII | API v3 | ASCII |
| ------------- | ------ | ----- | ------ | ----- |
| Single frame  | `0x50` | `P`   | `0x54` | `T`   |
| First of many | `0x4E` | `N`   | `0x52` | `R`   |
| Middle        | `0x4D` | `M`   | `0x51` | `Q`   |
| Last          | `0x4F` | `O`   | `0x53` | `S`   |

### 6.4 LED record encoding

**API v2 — 2 bytes/LED** (used when device name API level `< 3`, i.e. `@2` or absent):

```
byte0 = position[7:0]
byte1 = (red2 << 6) | (green2 << 4) | (blue2 << 2) | position[9:8]
```

- Position 0–1023 (10-bit). Colour channels scaled to 2 bits (0–3) after a power-budget brightness scale (§6.6).
- Max 127 LEDs/frame.

**API v3 — 3 bytes/LED** (device name API level `>= 3`, i.e. `@3`):

```
byte0 = position[7:0]
byte1 = position[15:8]
byte2 = (red/32 << 5) | (green/32 << 2) | (blue/64)      # 3:3:2 RGB
```

- Position 0–65535 (16-bit, little-endian). No client-side power scaling (handled by firmware).
- Max 84 LEDs/frame.

Colour comes from the placement role's 6-hex LED colour (`_colorFromHex`); unknown role → white `FFFFFF`. See `encodePositionAndColorV2` / `encodePositionAndColorV3` in `aurora.ts`.

### 6.5 Multi-part + transport chunking

- LED records are packed into frames; when a frame would exceed 255 payload bytes a new frame is started. One frame → `Single`; many → `First` / `Middle…` / `Last`.
- All frames are concatenated, then the byte stream is split into BLE writes of **20 bytes each**. The app **never negotiates a larger MTU** — there is no `requestMtu` call anywhere in the snapshot — and it waits **100 ms between chunks** (a `Duration` of 100000 µs in `writeData`). Each chunk is awaited before the next, so a large climb lights slowly but reliably.
- ✅ **Write type is write-WITH-response, unconditionally, for every box.** Confirmed from the arm64 method bodies (see §10): `BluetoothProvider.writeData` calls `flutter_blue_plus`'s `write(chunk)` with **no** `withoutResponse` argument, so it takes the library default `BmWriteType.withResponse`, and awaits each write. The compiled snapshot's object pool contains **only** the `withResponse` enum instance — the `withoutResponse` variant is tree-shaken out, which happens only if no code path ever constructs it. The `, writeWithoutResponse: …` string in the binary is just `CharacteristicProperties.toString()` (a capability label), not a write-mode selection. So the app does **not** adapt to what the box advertises: it drives the common `bleCharProperties=12` box and the write-only `bleCharProperties=8` box identically, with-response. That is why it lights **both** generations on iOS. See the two-generation split and the iOS silent-drop consequence in `AURORA_BLUETOOTH_PROTOCOL_SPEC.md` §9 (Write Properties).

> **Boardsesh implementation note (#3230):** Boardsesh deliberately does **not** copy this app's uniform with-response transport, because without-response is much faster on the common healthy box and this app's 100 ms-per-20-byte pacing is slow for a large climb. Instead Boardsesh negotiates MTU and clamps the without-response chunk to **[20, 244]** (ATT 247) — iOS-26.5 field telemetry showed write failures clustering at the full ATT 512. Android requests ATT 247 explicitly (`requestMTU(247)`); iOS clamps whatever CoreBluetooth auto-negotiated. For Aurora write type, Boardsesh keeps the live iOS decision behavior-driven: start with without-response, switch to with-response only after a stalled no-response write on a `.write`-only characteristic, then persist that learned path only after a with-response drain succeeds.
>
> As a proactive shortcut, Boardsesh **also** starts on with-response from the first connect when the box advertises a **bare Aurora name with no `#serial@apiLevel` suffix** (`isKilterBuiltBox` in `packages/shared/ble-protocol/src/aurora.ts`, mirrored in `BoardBleEncoding.isKilterBuiltBox`). A bare name is the signature of the write-only Kilter-built box, so it lights on the first attempt instead of eating a stall first. This is a **name** signal, not the GATT property bit: a healthy box that carries a serial never matches, so it keeps the faster without-response path and cannot re-introduce the stale-property regression (#3228). For a bare-name Kilter box Boardsesh mirrors the app's pacing too — each with-response chunk is spaced **100 ms** apart on top of the `didWriteValueFor` ack (`connectedBoxIsKilterBuilt` gates `kilterBoxChunkDelay` in `BoardBleManager`); an Aurora box that reached with-response via the stall fallback stays **ack-only** (no fixed delay, faster). The with-response chunk collapses to 20 bytes automatically (see `effectiveChunkSizeForMtu` in `packages/shared/ble-protocol/src/transport.ts` and its Swift twin `BoardBleEncoding.effectiveChunkSize`).

### 6.6 Power budget (API v2 only)

🔁 v2 caps total board draw at **18 W** by trying brightness scales `[1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05]` until it fits, with Kilter counting **2 LEDs per hold**. v3 omits this (firmware-managed). `_brightnessFor` in this app is the analogue. Full algorithm: `computeV2Scale` in `aurora.ts`.

---

## 7. Data pipeline: climb → LED positions

✅ The app ships a bundled SQLite board database. Relevant `walls` schema captured from `libapp.so`:

```sql
CREATE TABLE walls(
  id, wall_uuid, name, gym_uuid,
  product_name, product_layout_uuid,
  is_adjustable, min_angle, max_angle, angle_increments,
  serial_number,                       -- controller-box serial
  accumulated_hold_set_value,          -- Hold Set Mask bitmask (see below)
  is_listed, created_at, angle
);
```

✅ **Hold Set Mask (HSM).** Each wall stores `accumulated_hold_set_value`, the OR of the hold-set bits physically installed. Climb compatibility is filtered with a bitmask test seen verbatim in the binary:

```sql
AND (accumulated_hold_set_value & ?) = accumulated_hold_set_value
```

i.e. a climb is displayable only if all of its required hold-set bits are present on the wall. This is the same HSM concept documented in [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md` §18](./AURORA_BLUETOOTH_PROTOCOL_SPEC.md#18-board-size-handling--led-kit-variants).

✅ Board-size bounds are stored per product layout with `edge_left / edge_right / edge_bottom / edge_top` and keyed by `(product_name, edge_left, edge_right, edge_bottom, edge_top)` — the per-`productSizeId` coordinate system from the Aurora spec.

🔁 End to end: pick climb → resolve its placements to LED **positions** for the wall's product size → map each placement role to an RGB hex → encode (§6.4) → frame (§6.1) → write to RX. The **position index depends on the exact LED kit / product size**; never mix positions across sizes (Aurora spec §18.4).

---

## 8. Frame animation player ✅

Unlike a single static "light the holds" push, this app has a per-frame animation player (library `@1170206211`): `_displayClimbFrame`, `_nextFrame`, `_previousFrame`, `_maxFrame`, `_framePace`, `_startFramePlayer` / `_stopFramePlayer`, `_togglePlay`, `_syncPlaybackClockToFrame`. Each climb can carry multiple frames (animation steps); the player walks frames at a configurable pace and pushes each one to the wall via the same §6 path. This matches the `frame` column in the climb-placement model from the Aurora spec §11.

---

## 9. Differences from the Aurora-app spec — summary

| Aspect                                      | Aurora app (v3.6.4 spec)                                       | This app (Kilter Grips v2.5.2)                            |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Stack                                       | Native Android (Kotlin/Java)                                   | Flutter / Dart + `flutter_blue_plus`                      |
| Scan filter                                 | Product **name** substring (`"Kilter"`)                        | Advertised **service UUID** `4488B571…`                   |
| Board selection                             | First match                                                    | **RSSI-ranked**, nearest-first                            |
| MTU                                         | Implicit 20-byte writes                                        | **Also 20-byte** — no `requestMtu`; 100 ms between chunks |
| TX `6E400003` notify                        | Documented (no-op handler)                                     | **Not referenced at all** — write-only                    |
| Connection tolerance/auto-disconnect timers | App-managed timers (8 s connect, configurable auto-disconnect) | 5 s connect timeout; `flutter_blue_plus` timeouts         |
| Wire format (framing, checksum, v2/v3)      | —                                                              | **Same** ✅                                               |
| Extra UUIDs                                 | —                                                              | Three present, role unconfirmed ❓                        |

**Bottom line for interop:** Boardsesh's existing `ble-protocol` implementation is correct against this app too. Nothing here requires a change to the wire format. The only genuinely new, unexplained artifacts are the three UUIDs in §2.1.

---

## 10. Methodology & limitations

**How this was produced.** First pass: the XAPK was pulled from APKPure (`apkeep`), the base + `armeabi-v7a` split unpacked, and `libapp.so` (the Dart AOT snapshot) analysed with `strings` + `rabin2` (radare2). The snapshot is **not obfuscated** — full Dart class/method names and string literals are intact — which is what makes §1–§3, §5, §7–§8 directly verifiable. Second pass (the one that upgraded §6 to ✅): the **arm64-v8a** `libapp.so` was pulled from a device (`adb pull split_config.arm64_v8a.apk`) and decompiled with `blutter` (Dart 3.10.4) to recover the BLE method bodies.

**Byte-level encoding is now ✅ — confirmed from the arm64 method bodies.** The APKPure/apkcombo distributions bundle **only 32-bit `armeabi-v7a`** libraries (their crawlers report a 32-bit ABI to Play, so Play only ever hands them that split), and [`blutter`](https://github.com/worawit/blutter) is **ARM64-only** (`Disassembler_arm64.cpp`, `#ifdef TARGET_ARCH_ARM64`), so the 32-bit snapshot yields symbols/strings but not method bodies. The **arm64-v8a `libapp.so` was obtained by installing the app from Google Play on an arm64 device and `adb pull`-ing `split_config.arm64_v8a.apk`**, then decompiled with `blutter` (Dart 3.10.4). That recovered the BLE method bodies, which directly confirm §6: `BluetoothService.convertMessage` / `addBoilerPlate` build the `[SOH(1), len, checksum, STX(2), cmd, …, ETX(3)]` frame (integers appear Smi-tagged in the asm, i.e. ×2), with command byte `0x50` (`'P'`, v2 Single) / `0x54` (`'T'`, v3 Single); `encodePositionV2` (2-byte) / `encodePositionV3` (16-bit LE) + `encodeColorV3`; and the `"v3"` vs `"v2"` selection keyed on the advertised name containing `"@3"` (default `"v2"`). It also settled the write-type question (§6.5): uniformly write-with-response, 20-byte chunks, 100 ms apart.

**Still open:** the three §2.1 UUIDs (`d9b1fad4…` / `191b6169…` / `73a2a497…`). The arm64 decompile shows **no LED writes** to them — they appear only as object-pool string constants, consistent with non-LED use (dynamic-link / analytics identifiers). A **live BLE session** (Android HCI snoop log / nRF Connect) would confirm there is no GATT activity on them.

---

## Appendix A — evidence index

UUIDs (`rabin2 -z libapp.so`):

```
0x002f7ec4  6E400002-B5A3-F393-E0A9-E50E24DCCA9E   (RX, write)
0x0038b4ac  4488B571-7806-4DF6-BCFF-A2897E4953FF   (advertised service / scan filter)
            6E400001-B5A3-F393-E0A9-E50E24DCCA9E   (Nordic UART service)
            00002902-0000-1000-8000-00805f9b34fb   (CCCD)
            6E400003-…                              (NOT PRESENT)
0x002b4bd4  d9b1fad4-0d22-4d20-8521-04166b28cd24   (unknown)
0x002bc4ec  191b6169-b8ea-47b6-bf19-4c0c08da7207   (unknown)
0x002f8bd4  73a2a497-3dd3-46d1-b34b-00d0de25ccc3   (unknown)
```

Dart symbols of interest (`strings libapp.so`):

```
_ensureBluetoothPermissions  _initAndScan  _startScan  _ranked  _rrPool
_connectToBoardByName  _showBluetoothScanDialog  _showOpenSettingsDialog
_displayClimb  _displayClimbFrame  _colorFromHex  _brightnessFor  _checkSum
BmScanSettings  BmScanResponse  BmScanAdvertisement  BmMtuChangeRequest
BmMtuChangedResponse  BmReadRssiResult  BmTurnOnResponse
[FBP] connection timeout   [FBP] disconnect: enforcing
```

App identity:

```
package   com.kiltergrips.kilter_board_app
version   2.5.2 (48)   minSdk 24   targetSdk 36
engine    Dart 3.10.4 (stable)     BLE  flutter_blue_plus
```
