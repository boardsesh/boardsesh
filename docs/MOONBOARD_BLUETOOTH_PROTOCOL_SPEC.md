# MoonBoard Bluetooth Protocol Specification

**Source app**: Moon Climbing (`com.trainingboard.moon`) **v1.2.45** (build 265)
**Later package check**: v1.3.68 (build 368), 2026-10-14; see §9 for coverage
**Current package check**: v1.3.77 (build 377), 2026-11-20; ARM64 call-path findings in §10 supersede earlier string-only classifications
**Stack**: Flutter (Dart AOT; Dart `3.8.1`, stable channel) + [`flutter_reactive_ble`](https://pub.dev/packages/flutter_reactive_ble)
**Transport**: Bluetooth Low Energy (BLE)

> **Legal basis & scope.** This document describes only the **BLE interoperability interface** — the unencrypted Bluetooth protocol used to drive a MoonBoard's LEDs — and exists solely to build and verify a compatible client for the same hardware. That is the interoperability rationale set out in [`LEGAL.md`](../LEGAL.md) (§ Interoperability & Hardware Compatibility; _Sega v. Accolade_, EU Directive 2009/24/EC Art. 6), the same basis as [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](./AURORA_BLUETOOTH_PROTOCOL_SPEC.md) and [`LED_BOX_BLE_CONNECTION_PROTOCOL.md`](./LED_BOX_BLE_CONNECTION_PROTOCOL.md). It covers the LED-control protocol only; the app's accounts, backend services, and other internals are out of scope and intentionally omitted. "MoonBoard" and "Moon Climbing" are trademarks of their owner; Boardsesh is not affiliated with or endorsed by the manufacturer.

---

## What this document is

Boardsesh already ships a working MoonBoard BLE client (`packages/shared/ble-protocol/src/moonboard.ts`). That implementation was reconstructed from **open-source MoonBoard LED projects** — community Arduino/ESP controllers and third-party apps — and originally knew only the Nordic-UART hardware path. (Acting on this document, the client now also discovers and writes the original RedBearLab service as a fallback — see §8.)

This spec is a **separate, independent read** of the protocol taken from the **official Moon Climbing app**, written to:

1. **Cross-validate** the format Boardsesh already emits, and
2. **Capture what the open-source-derived implementation was missing** — most importantly, a second controller hardware generation (the original RedBearLab-based boards) the client did not recognise. That path is now wired as a fallback (see §8).

It is a companion to the working code, not a replacement for it. Where the official app and the open-source format agree, that is noted; where they diverge, the divergence is the point.

### Provenance tags

Each claim is tagged so you can separate what was observed in the app from what is inherited from the shared hardware behaviour:

- ✅ **Observed in the official app** — present directly in the shipped app's manifest or compiled Dart assets. §10 distinguishes instruction-level observations from string-only evidence; neither establishes execution on a physical controller.
- 🔁 **Corroborated wire format** — the byte-level LED encoding the app must speak to the same controllers. Cross-checked against Boardsesh's working `moonboard.ts`, the open-source controller firmware, and the physical LED wiring; not the part that is uniquely attributable to the official app.
- ❓ **Present, role unconfirmed** — an artefact is present but its exact purpose is not proven by static inspection. Flagged for a live BLE capture.

---

## TL;DR

| Question                               | Answer                                                                                                                               | Tag  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| BLE library                            | `flutter_reactive_ble` (not `flutter_blue_plus`).                                                                                    | ✅   |
| Controller profiles                    | v1.3.77 defines **three legacy service profiles and one Pro profile**; profiles do not establish physical hardware generations.       | ✅   |
| Original-hardware service / write char | `713d0000-…` service, write to `713d0003-…`.                                                                                         | ✅   |
| Newer-hardware service / write char    | `6e400001-…` (Nordic UART) service, write to `6e400002-…` (Nordic UART RX).                                                          | ✅   |
| Subscribes to board notifications?     | No legacy notify path established; v1.3.77 defines Pro notification characteristics, including `authState` (§10).                       | ✅❓ |
| Bonds / pairs with the board?          | The older v1.2.45 app warns _"DO NOT pair your phone to the board"_. Newer-app bonding behavior remains unverified.                   | ❓   |
| Board PIN?                            | v1.3.77 implements a controller PIN challenge/unlock flow for its Pro profile; physical-controller behavior remains untested (§10).  | ✅❓ |
| Per-board LED version?                 | **Yes.** Boards persist a `led_version`; the app tracks LED hardware generation per board.                                           | ✅   |
| Legacy LED payload format              | ASCII `l#<marker><pos>,<marker><pos>,…#`; Pro payload compatibility is not established.                                              | 🔁   |
| LED position numbering                 | Column-major **serpentine** over the 11×18 grid (positions 0–197).                                                                   | 🔁   |
| Clearing the board                     | Empty frame `l##` clears all LEDs (community firmware); Boardsesh sends it only on a deliberate clear (§5.5).                        | 🔁❓ |
| "V2" additional-LED feature            | Optional `~D` prefix asks community firmware to also light a firmware-defined neighbour LED per hold (§5.6). Opt-in, off by default. | 🔁❓ |
| Two extra 128-bit UUIDs in the binary  | `2c9285bc-…` is a third legacy service and `5b2bf25f-…` its `pixelSingle` characteristic (§2.4).                                         | ✅   |

---

## 1. BLE stack & permissions

✅ The app drives BLE through `flutter_reactive_ble`. Its method-channel surface is intact in the compiled assets: `flutter_reactive_ble_method`, `flutter_reactive_ble_scan`, `flutter_reactive_ble_status`, `flutter_reactive_ble_connected_device`, `flutter_reactive_ble_char_update`, plus the request/response types `ScanForDevicesRequest`, `ConnectToDeviceRequest`, `ConnectionStateUpdate(deviceId: …)`, `DiscoveredDevice(id: …)`, `DiscoveredService(serviceId: …)`, `WriteCharacteristicRequest`, and both `writeCharacteristicWithoutResponse` / `writeCharacteristicWithResponse`.

✅ Android permissions (from the app manifest):

```
android.permission.BLUETOOTH_SCAN
android.permission.BLUETOOTH_CONNECT
android.permission.BLUETOOTH
android.permission.BLUETOOTH_ADMIN
android.permission.ACCESS_FINE_LOCATION
android.permission.ACCESS_COARSE_LOCATION
android.permission.WAKE_LOCK
```

`minSdk 26`, `targetSdk 35`. Permission-prompt copy: _"Bluetooth and location access is required to connect to the MoonBoard."_

The later v1.3.68 package targets SDK 36 and still declares Bluetooth scan/connect and location permissions. Its base APK and ARM64 split share signer SHA-256 `9903070fe6cf4674e1a8875c07c911aa859a4fee666a8c83a409084d3ec94caf`.

For completeness on the stack (not part of the LED path): the app is Flutter (Dart 3.8.1, stable channel), stores its board database with `drift` over `sqlcipher`, and uses Firebase for its backend. None of that is needed for interop.

---

## 2. Service & Characteristic UUIDs

✅ The original inspection identified the RedBearLab and Nordic UART UUID families. v1.3.77's profile-construction instructions establish two additional profiles (§2.4–§2.5). Profile names do not identify the physical model of a connected controller.

### 2.1 Original hardware — RedBearLab service

| Name                 | UUID                                   | Used as                             | Tag |
| -------------------- | -------------------------------------- | ----------------------------------- | --- |
| RedBearLab service   | `713d0000-503e-4c75-ba94-3148f18d941e` | Data service on the original boards | ✅  |
| Write characteristic | `713d0003-503e-4c75-ba94-3148f18d941e` | App **writes** LED commands here    | ✅  |

This is the well-known **RedBearLab BLE Shield** UUID family, and `713d0003` is that module's central→peripheral write characteristic. The original MoonBoard LED kit is widely documented as having shipped on a RedBearLab BLE module, so this is the original-hardware path (the "original vs. newer" split is an inference from the two UUID families + that public history, not something the static inspection proves on its own). This was the single biggest gap this document identified; Boardsesh now discovers and writes this service as a fallback after the Nordic UART one (`REDBEARLAB_SERVICE_UUID` / `REDBEARLAB_WRITE_CHARACTERISTIC_UUID` in [`transport.ts`](../packages/shared/ble-protocol/src/transport.ts)), though the path is not yet verified on an original board (see §8).

### 2.2 Newer hardware — Nordic UART service

| Name                      | UUID                                   | Used as                          | Tag |
| ------------------------- | -------------------------------------- | -------------------------------- | --- |
| Nordic UART Service       | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Data service on newer boards     | ✅  |
| Write characteristic (RX) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | App **writes** LED commands here | ✅  |

This is the path Boardsesh already implements (see `UART_SERVICE_UUID` / `UART_WRITE_CHARACTERISTIC_UUID` in [`transport.ts`](../packages/shared/ble-protocol/src/transport.ts)).

### 2.3 Legacy notify channels remain unconfirmed

✅ Neither notify/TX characteristic appears among the readable literals in the inspected package:

- `713d0002-…` (RedBearLab peripheral→central notify) — **absent**.
- `6e400003-…` (Nordic UART TX) — **absent**.

The identified LED path uses the two **write** characteristics. Static literal absence does not rule out dynamically constructed UUIDs or a separate notification path; no such path was established by this check.

### 2.4 Third legacy service profile

Two other 128-bit UUIDs are present in the binary:

```
2c9285bc-dfd0-4fd8-a13d-393660f8a060
5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4
```

✅ The v1.3.77 constructor at ARM64 address `0x79292c` places `2c9285bc-dfd0-4fd8-a13d-393660f8a060` in the same service field used by the RedBearLab and Nordic profiles, and maps `pixelSingle` to `5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4`. It tags this object `legacy`.

The earlier classification of these UUIDs as non-BLE identifiers was incorrect: it inferred a role from string proximity without tracing references. Boardsesh currently probes neither this service nor its characteristic. Its physical controller model and wire compatibility remain unverified.

### 2.5 Pro service and authentication characteristics

✅ The fourth profile is explicitly tagged `pro`. Its service is `7a112233-4455-6677-8899-aabbccddee01`. The following suffixes share the prefix `7a112233-4455-6677-8899-aabbccddee`:

| Suffix | Profile key | Static role |
| ------ | ----------- | ----------- |
| `02` | `pixelSingle` | Single-pixel command characteristic |
| `30` | `authClaim` | Claim characteristic; exact initialization semantics unverified |
| `31` | `authSalt` | Read during PIN unlock |
| `32` | `authChallenge` | Read during PIN unlock |
| `33` | `authUnlock` | Written with the derived unlock response |
| `28` | `authState` | Declared in the Pro notification map |

These are recovered application mappings and call paths, not a hardware capture. Boardsesh does not implement this service or its PIN flow. The `pro` enum does not establish current product availability, a default controller model, or equivalence with the V5 retail product.

---

## 3. Device discovery (scan)

✅ The app scans with `flutter_reactive_ble` (symbols `ScanForDevicesRequest`, `scanMode`, `requireLocationServicesEnabled`). Discovered devices arrive as `DiscoveredDevice(id: …)`; services and characteristics are resolved per `DiscoveredService(serviceId: …)` after connect.

Boardsesh recognizes the name prefixes **`MoonBoard`** and **`Moonboard`**, or either supported service UUID, when scanning for MoonBoards. The official app's exact scan service filter remains unverified; its v1.3.77 service resolver recognizes the four profiles in §2. Do not assume every controller uses an immutable name: the Pro profile includes an `advertisingname` configuration characteristic, suffix `0C`.

### Controller identification

[Moon Climbing's V5 product page](https://us.moonclimbing.com/products/moonboard-led-control-box) describes a unique 12-digit identifier for selecting among multiple controllers. This establishes the intended identification feature, but not how those digits are transported or whether the identifier denotes Pro hardware.

The v1.3.77 scan-row builder (`0x855090`) displays the discovered name and a subtitle containing `device.id` plus RSSI (`0x855110`–`0x855188`, text widgets at `0x8552dc` / `0x855304`). Its Android plugin obtains that ID from `BluetoothDevice.getAddress()` (`ReactiveBleClient.scanForDevices$lambda$1`); the advertised name is a separate field. The inspected row does not strip address separators or parse a twelve-digit serial. Whether the product identifier equals the Bluetooth address or is contained in the advertised name remains unresolved. An iOS peripheral UUID is not the Android address and cannot be converted into that identifier.

An additional row path (`0xde33b8`) reads service data under `0000fff0-0000-1000-8000-00805f9b34fb`. Parser `0x855830` accepts 13 bytes with version byte `1`, then reads three little-endian 32-bit words:

| Byte offset | Static consumer | Interpretation and limit |
| ----------- | --------------- | ------------------------ |
| `1` | `0xde3860` → `0xde3950` → `0xdced10` → `0xda3f1c` → predicate `0x735e34`; serialized field mapping `0xaf4978`–`0xaf49b8` | Generic-board `api_id` lookup; not a physical controller serial. |
| `5` | Configuration selector in `0xd9fa4c`, comparison `0xd9fe34`–`0xd9fe5c`; serialized `configuration` mapping `0xb055c8`–`0xb05604` | Configuration API identifier in the branch where the setup word is positive; equivalence to a Boardsesh layout ID requires explicit mapping. |
| `9` | Third record field `0xde390c`, argument `0xde3930`, positive-value branch `0xde398c`; serialized `setup` mapping `0xaf4abc`–`0xaf4af8` | Setup selector/flag; exact domain and hardware meaning remain unverified. |

These fields offer a potential configuration-recognition path, not evidence of the advertised twelve-digit serial. No matching MoonBoard service-data records were returned by the bounded 30-day PostHog check; the property was absent from the project taxonomy. Hardware generation, advertisement availability and real payloads therefore remain unverified.

---

## 4. Connection lifecycle

The original legacy-path model, inferred from symbols and `flutter_reactive_ble` semantics, is below. The Pro authorization path recovered from v1.3.77 is described in §10.

```
request BLE + location permissions
        │   "Bluetooth and location access is required to connect to the MoonBoard."
        ▼
scan for devices            (ScanForDevicesRequest)
        │
        ▼
connect to chosen board     (ConnectToDeviceRequest)
        │   "Do you want to connect to the board (DO NOT pair your phone to the board)?"
        ▼
discover services           → RedBearLab 713d0000…  OR  Nordic UART 6e400001…
        │
        ▼
locate write characteristic → 713d0003…              OR  6e400002…
        │
        ▼
READY → write LED frames     (write type depends on characteristic — see §5.4)
        │
        ▼
disconnect
```

✅ **Older-app pairing warning.** The v1.2.45 package contains the explicit warning _"Do you want to connect to the board (DO NOT pair your phone to the board)?"_. Boardsesh uses a plain GATT connection without requesting an OS-level bond. This warning alone does not establish the bonding behavior of every controller or newer app version.

✅ The v1.3.68 check established only PIN-related strings. The v1.3.77 investigation now establishes an application-level BLE challenge/unlock path for the Pro profile (§10). The app reads a salt and challenge, writes an authentication response and checks the resulting controller status. This is separate from an Android pairing passkey. No direct `createBond`, `removeBond`, or `setPin` reference was found in the inspected DEX files; OS-initiated pairing and indirect/native paths are not ruled out.

An Android disconnect reported by Boardsesh as ble-plx `201` with `androidErrorCode: 5` is connection-level authentication failure. It is not evidence of an ATT authentication response or a board-PIN challenge. The [native error patch](../patches/react-native-ble-plx@3.5.1.patch) preserves link statuses separately from `attErrorCode`. To establish a PIN requirement, observe the official app on the affected phone/controller and capture the relevant Bluetooth exchange; package strings and a disconnect label cannot answer that question alone.

> **Boardsesh compatibility:** the client now probes Nordic UART and then RedBearLab, with the iOS write type selected from the characteristic properties. The RedBearLab path still needs a check on an original board.

---

## 5. Wire protocol (LED command format)

🔁 The byte format below is the shared MoonBoard LED wire format. It is the protocol the official app must speak to the same controllers, cross-checked against Boardsesh's working `moonboard.ts`, open-source controller firmware, and the physical LED wiring. The `l#` frame literal is present in the app binary; the exact field layout is corroborated rather than uniquely re-derived from the app (see [limitations](#8-methodology--limitations)).

### 5.1 Frame structure

A single ASCII string, written to the chosen write characteristic:

```
l# <marker><pos> , <marker><pos> , … #
```

- Prefix `l#`, suffix `#`.
- Hold records are comma-separated.
- No checksum, no length header, no binary framing — it is plain ASCII.

Example for a three-hold problem (start at LED 0, a hand hold at LED 35, finish at LED 197):

```
l#S0,P35,E197#
```

### 5.2 Hold markers

Each record is a one-letter **marker** followed by the LED **position**:

| Marker | Role                          | Canonical colour |
| ------ | ----------------------------- | ---------------- |
| `S`    | Start hold                    | green            |
| `P`    | Intermediate ("problem") hold | blue             |
| `E`    | End / finish hold             | red              |

✅ The app's own data model is richer than these three wire markers — it carries `hold_type`, `hold_number`, `hold_layout`, and a per-hold `HoldDirection` — but the on-wire LED command collapses to the start/intermediate/finish trichotomy above. Foot-only holds are not separately lit in this format.

### 5.3 LED position numbering (serpentine)

🔁 The standard 11-column × 18-row board (columns A–K, rows 1–18) is wired as a single **serpentine** LED string: up column A, down column B, up column C, and so on. Boardsesh's `getMoonboardSerialPosition` implements this mapping. The Mini has 11 columns × 12 rows and uses the same formula with `numRows = 12`; the v1.3.68 package contains Mini MoonBoard 2020 and 2025 board assets. The exact official-app coordinate-to-packet call path remains unverified.

Pseudocode (`//` is integer division / floor, `%` is modulo; `#` starts a comment):

```text
numRows   = 18              # standard; 12 for Mini
holdId    = 1..11*numRows   # row-major: A1=1, B1=2, … K1=11, A2=12, …
z         = holdId - 1
col       = z % 11          # column index 0..10  (modulo)
row       = floor(z / 11)   # row index 0..numRows-1

if col is even:  position = col*numRows + row
if col is odd:   position = col*numRows + (numRows - 1 - row)

# position range: 0..197 (standard), 0..131 (Mini)
```

The position index represents the **physical LED string**. The official app's use of this exact mapping still needs a packet check. Worked checks for Boardsesh (matching `moonboard.test.ts`): `holdId 1 → 0`, `holdId 2 → 35`, `holdId 12 → 1`, `holdId 198 → 197`.

### 5.4 BLE chunking

🔁 The ASCII string is split into BLE writes. The classic transport size is **20 bytes per write** (`MAX_BLUETOOTH_MESSAGE_SIZE` in `transport.ts`); chunking is a transport detail and does not change the message.

**Write type depends on the controller generation.** The newer Nordic-UART RX characteristic (`6e400002`) supports **Write Without Response**. The original RedBearLab write characteristic (`713d0003`), however, advertises only the plain `.write` property — on iOS, CoreBluetooth **silently drops** a write-without-response to a characteristic that lacks the no-response property, leaving the wall dark. So an interoperable iOS client must use **write-with-response** for the RedBearLab box (pacing on the GATT write ack), and may use write-without-response for the Nordic-UART boards. Android's GATT stack issues no-response writes regardless of the advertised property, so the same write call works on both there. Boardsesh implements exactly this gating (`BoardBleEncoding.preferredWriteType` in `packages/mobile/modules/live-activity/ios/`): MoonBoard falls back to write-with-response whenever the chosen write characteristic doesn't advertise `.writeWithoutResponse`.

### 5.5 Clearing the board

🔁 A frame with no holds — `l##` (the prefix and suffix with an empty payload) — is the clear-all. The ArduinoMoonBoardLED community firmware clears every LED at the start of each incoming frame before lighting the holds it names, so an empty frame darks the whole wall.

❓ Unconfirmed on official Moon controllers (flagged for a live BLE capture); at worst it is a no-op there.

Boardsesh sends `l##` **only on a deliberate clear** (the "Turn off all lights" control, or advancing the queue past the last compatible climb). A climb whose holds all drop out (unrecognised roles / out-of-range ids) is **never** cleared this way — it refuses to write and surfaces an incompatible-climb error instead, so a corrupt climb can't silently dark the wall.

### 5.6 "V2" config prefix — the additional-LED feature

🔁 Community controller firmware ([`FabianRig/ArduinoMoonBoardLED`](https://github.com/FabianRig/ArduinoMoonBoardLED), an open-source LED box the app's own README describes as compatible with "the 'new' MoonBoard app") accepts an **optional config prefix** immediately before the `l#…#` frame:

```
~D l# <marker><pos> , … #
```

The community firmware's serial parser is a small state machine: state 0 waits for either `~` (config) or `l` (frame start). Seeing `~` moves to state 1, which reads exactly one config character — `D` sets a `useadditionalled` flag for the _next_ frame only — before falling through to normal frame parsing. A client that never sends `~` sees the plain V1 `l#…#` path unchanged, and old Boardsesh clients therefore keep working against firmware that understands the prefix. Behavior on firmware without the state-1 branch is not established: a controller might ignore the entire write or recover when it reaches the later `l` frame marker.

When `useadditionalled` is set, the firmware renders each hold twice: its normal role colour (§5.2) at its own LED position, **and** a second, dimmer LED lit yellow at `ledmapping[hold] + additionalledmapping[hold]` — an installation-specific offset table baked into that board's `config.h`, conventionally pointing at the physical LED for the hold above. Finish holds (`E`) never get a second LED. The flag is consumed once per frame (reset to false after rendering), so a client must resend `~D` on every write it wants the effect on.

**What Boardsesh does with this.** `getMoonboardBluetoothPacket(frames, numRows, { lightAdjacentHolds: true })` (`packages/shared/ble-protocol/src/moonboard.ts`, mirrored in `BoardBleEncoding.makeMoonboardPacket` for the native iOS re-light path) prepends `~D` to a non-empty frame. Boardsesh has no way to read a given board's `additionalledmapping[]` table, so this only toggles the firmware's own behaviour — it does not compute or claim a specific "above" vs "below" direction itself, which is why the user-facing copy says "light the hold above" (the README's own framing: "show lights above holds") rather than promising an exact offset. The clear-all `l##` frame never gets the prefix (prefixing it has no visible effect and would exercise the firmware's empty-string parsing edge case for no benefit). The feature is opt-in per user (a persisted preference, off by default) since it depends on firmware most controllers don't ship.

**Unconfirmed on official Moon controllers** — like §5.5's clear-all, this is corroborated against the open-source firmware and Boardsesh's own working client, not captured from the official app (see [§9](#9-methodology--limitations)). Unsupported-prefix behavior must be verified on RedBearLab and Nordic controllers before release: they may ignore the whole write or continue at the normal `l#…#` frame.

The v1.3.68 package contains the UI strings _"Display light above and below holds (MoonBoard only)"_ and _"Display beta colours (dual lights will be disabled)"_. They indicate a dual-light option in the newer app, but do not identify its wire command or validate the community firmware's `~D` prefix on an official controller.

---

## 6. `led_version` — per-board hardware generation

✅ Boards persist a `led_version` column (drift symbols `led_version` / `ledVersion`, with a `ledVersion: ` field in the board model's `toString`). The app keys per-board LED behaviour off this value, which is consistent with it choosing the RedBearLab vs. Nordic UART service and any version-specific LED handling. The open-source-derived client has no equivalent concept — it assumes one hardware generation.

This is the hook an interoperable client should adopt: **record which service a given board exposed**, so reconnects target the right write characteristic instead of probing.

---

## 7. Data pipeline: problem → LED positions

✅ The app ships a bundled (sqlcipher-encrypted) board database. Relevant model symbols recovered from the binary: `board_problems`, `board_holdsets`, `board_configuration_id`, `board_setup_id`, `draft_problems`, and per-hold `hold_number` / `hold_type` / `hold_layout` / `HoldDirection`. Compatibility between a problem and a physical board is gated by its hold layout and installed hold sets (`board_holdsets`), the MoonBoard analogue of the Aurora "hold set mask".

🔁 End to end: pick a problem → resolve each hold to its grid coordinate for the board's layout → map the hold's role to a marker (§5.2) and its coordinate to an LED position (§5.3) → join into the `l#…#` string (§5.1) → write to the board's write characteristic (§2). The app also exposes two convenience toggles, `light_on_tap` and `light_on_swipe`, that push the current problem to the wall on a tap/swipe gesture — UX, not a protocol change.

---

## 8. Differences from the open-source-derived client — summary

| Aspect                                | Boardsesh today (`moonboard.ts` + adapters)                                             | Official Moon Climbing app                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Controller profiles                   | RedBearLab `713d0000` and Nordic UART `6e400001` (discovery wired)¹                         | Three legacy profiles and one Pro profile in v1.3.77           |
| Original-hardware boards              | Discovers + writes `713d0003` (write-with-response on iOS); **unverified on hardware**¹ | Writes to `713d0003` on the RedBearLab service                |
| Per-board hardware version            | None (probes UART → RedBearLab on each connect)                                         | `led_version` persisted per board                             |
| Notify channel                        | None in Boardsesh's LED path                                                            | Pro notification map includes `authState`; legacy use unverified |
| Bonding                               | Plain GATT connect; app does not request a bond                                           | Older app warns against pairing; v1.3.77 DEX has no direct bonding/PIN API calls |
| Legacy payload (`l#…#`, markers, serpentine) | As documented here                                                                  | Corroborated legacy format; Pro encoding remains unverified 🔁 |
| Additional controller support         | Third legacy service and Pro authorization are not implemented                           | Explicit service profiles and Pro challenge/unlock path (§10) |

¹ The RedBearLab discovery/write path (scan filter, characteristic-discovery fallback, write-with-response gating) is implemented across web, React Native, and native iOS and unit-tested, but has **not** been verified against an original MoonBoard LED box. See the constants `REDBEARLAB_SERVICE_UUID` / `REDBEARLAB_WRITE_CHARACTERISTIC_UUID` in `packages/shared/ble-protocol/src/transport.ts`.

Boardsesh supports the Nordic UART LED path and also discovers and writes the **RedBearLab `713d0000` / `713d0003`** service, with write type selected from characteristic properties. The RedBearLab path still needs hardware verification. The third legacy profile and Pro service require separate interoperability work and hardware validation; adding their UUIDs alone would not implement Pro authorization.

---

## 9. Methodology & limitations

This protocol was reconstructed by **static inspection of the shipped Moon Climbing app** for interoperability: identifying the BLE services, characteristics, connection model, and messages an independent client needs to drive compatible LED hardware. Earlier inspections used readable strings and symbols. v1.3.77 obfuscates Dart names and strips much method metadata; §10 uses recovered object-pool entries and ARM64 instructions instead. Readable strings alone do not establish a call path.

**Why the byte-level encoding is tagged 🔁, not ✅.** The original v1.2.45 distribution analysed for this document bundles only 32-bit (`armeabi-v7a`) native code, while the available Dart-AOT method-body tooling for that check targeted 64-bit snapshots. Static inspection confirms _that_ the app frames LED commands (the `l#` literal and the hardware UUIDs are present) and selects per-board behaviour (`led_version`), but the exact field layout in §5 is taken from the corroborating sources — Boardsesh's shipped `moonboard.ts`, open-source controller firmware, and the physical LED wiring.

**Later package coverage.** The APKPure v1.3.68 base APK (SHA-256 `dd0c8affe7675bfbb4fdaf3d0969b245b1c8524a4ededfbf734ed9d53fbf78ec`) and its ARM64 `libapp.so` (SHA-256 `03532ef1c5b38d4b558b271368a2dd036b45c6cd06c30af8f774789363953634`) retain the RedBearLab and Nordic UART service/write-characteristic literals, `l#`, `led_version`, and both characteristic-write API names. That corroborates their presence in the newer client. The app's call paths and exact packets were not established from this package, so earlier byte-format and controller-behavior limits still apply. A package string alone does not prove a BLE operation was executed.

**Hardware validation still required:** capture a live BLE session against each relevant controller profile and compare on-wire bytes with §5. §2.4's application mapping is now established, but its controller identity and behavior remain unverified.

## 10. Android v1.3.77 investigation (2026-11-20)

### Artifact identity and tools

Downloaded the ARM64 XAPK from [APKPure's MoonBoard package listing](https://apkpure.net/moon-climbing-moonboard/com.trainingboard.moon/download). The package is `com.trainingboard.moon`, version `1.3.77`, build `377`, minimum SDK 26 and target SDK 36. It bundles Dart `3.12.0`, snapshot `41be3daaabd524b8aa7423bc24584957`.

| Artifact | SHA-256 |
| -------- | ------- |
| XAPK | `331c930b0b463487897296a98400e7585e592aaf4b41b2687d91f3bdd52112bf` |
| Base APK | `afb221bb58a6cb711bc510cf6816c21386331eb987e7bc63f49238781fbc3dd9` |
| ARM64 split APK | `fb3f32e89b39ccc3f20881750b587bb06162528f6d5dc30e433005e7460c9636` |
| ARM64 `libapp.so` | `521724ec57cd94024989f7d5f57927988a15b7d52ec1b6e75787c9ca27e6dc2c` |

Android `ApkVerifier` verified both APKs under signature schemes v2 and v3, without errors or warnings. Their signer SHA-256 is `9903070fe6cf4674e1a8875c07c911aa859a4fee666a8c83a409084d3ec94caf`, matching the earlier inspected release. This verifies signature integrity and signer continuity; the download was from a mirror, not a direct Play Store extraction.

REA inventoried and safely extracted the package. Retained Evidence:

- XAPK inventory: `ev_84941e06a99d322616ae1989182dc9f67df43a04bf9bbea363f69b3d1c69185d`.
- XAPK extraction: `ev_db4efe9ea7e621b45fbc8de5354c824991a0a5f35c10c3896a26677ab2335d91`.
- Native split extraction: `ev_24a5a95e25b3259f77e36c163884bb63c53a236c9d7d77164a2ce358c480dc21`.

REA's Android adapter lacked its configured JADX MCP JAR, and macOS denied Hopper Apple Events. The code evidence therefore comes from the installed JADX 1.5.6 CLI, Blutter commit `4a60ac648bf448c5a7596437243bcd0b9376fdf0` for Dart object-pool recovery, and LLVM ARM64 disassembly. These are shell-tool observations, not REA native-analysis Evidence. Blutter's stripped-function export failed; raw instruction references below do not rely on that export. A local annotation helper resolves direct and adjacent add/load references through Dart's pool register; it does not recover every reference or infer control flow. Frame-prologue ranges are navigation aids, not guaranteed function boundaries. The APK was not launched.

### Findings and evidence limits

| Question | Static finding | Instruction or class evidence | Remaining limit |
| -------- | -------------- | ----------------------------- | --------------- |
| Are the extra UUIDs Bluetooth-related? | Yes: a third `legacy` service/write pair; a fourth profile is `pro`. | Constructor `0x79292c`; Pro enum store `0x793284`; returned profile list `0x7932a0`–`0x7932b8`. | No physical model or compatibility test for the third legacy profile. |
| Is the PIN only UI copy? | No: the unlock path requests `authSalt` and `authChallenge`, validates lengths, derives a response and writes `authUnlock`. It refreshes status and can report an incorrect PIN. | `0xd73550`; reads `0xd736d4` / `0xd73708`; unlock write `0xd7399c`; status refresh `0xd739b0`; failure copy `0xd739f0`. | Controller enforcement and the exact cryptographic construction need independent/live validation. |
| What are the observed sizes? | Salt and challenge checks use tagged length `0x20` (16 bytes each); the HMAC output check uses unboxed `0x20` (32 bytes). | `0xd736f4`, `0xd73728`, `0xd73980`; distinct tagged/unboxed length handling. | These checks describe client expectations, not a captured exchange. |
| Which operations require a PIN? | A six-digit validator and configuration/LED-mapping authorization path are present. A protected LED action checks authorization before dispatch. | Validator `0x8f0ef4` and `^\d{6}$`; LED-action closures `0xe2f794` / `0xe2f354`; status check `0xe2f27c`. | Whether ordinary climb lighting requires a PIN on a particular controller is unproven. |
| Does Android explicitly pair or set a PIN? | No direct bonding/PIN API references were found in the DEX string tables. The plugin checks whether bonding is already in progress. | `ReactiveBleClient.discoverServices` and `setupNotification`; full DEX search for `createBond`, `removeBond`, `setPin` and pairing receiver names. | OS-initiated security, JNI and indirect reflection are not ruled out. JADX reported 63 method errors; the inspected bridge methods decompiled successfully. |
| Is every authentication error proof of a PIN? | No. The official app itself maps several GATT permission/authentication text patterns to a generic PIN-required error. | Error mapper `0xdc609c`, return branch `0xdc625c`–`0xdc627c`. | A user-facing label does not establish the peripheral's security exchange. |

**Cryptographic identification.** The hash constructor loads the eight SHA-256 initial-state words at `0x691e0c`. The response path initializes matching hash states and calls a padding helper with `0x36` at `0x691710` / `0x691714` and `0x5c` at `0x691870` / `0x691874`. Helper `0x691954` XORs input bytes with that pad (`0x691a04`) and fills the remaining block with pad bytes, consistent with [HMAC's inner/outer padding](https://www.rfc-editor.org/rfc/rfc2104). This strongly supports HMAC-SHA-256. The PIN encoder copies ASCII code units directly (`0xb4a694`–`0xb4a6c4`), covering the six decimal digits accepted by the validator.

The traced input construction copies encoded PIN bytes, appends the salt (`0xd73734`–`0xd7374c`), then hashes (`0xd7375c`). The resulting digest is wrapped at `0xd73770`–`0xd737b4`; it and the challenge are passed separately into the MAC path at `0xd737bc`–`0xd737c4`. This is consistent with a SHA-256 PIN-and-salt digest used as the HMAC key over the challenge. Treat that full derivation as a static inference until independently checked with a synthetic test vector or an authorized hardware exchange; the native app was not executed, and no PIN implementation is shipped by this investigation.

### Relevance to the Sofia disconnect

The inspected Boardsesh connection path probes Nordic UART and RedBearLab, then reports connection success after service setup. The recorded Sofia sequence contains successful setup followed by ble-plx `201` / Android `5` disconnects. The sampled success/drop records do not carry the selected service UUID or controller firmware identity.

A controller exposing only the recovered Pro service should fail the current service probes before that success event. This makes the newly found Pro PIN protocol a poor match for a **Pro-only** explanation of the recorded sequence. Dual-service firmware, another legacy security mechanism, stale Android bonding state and controller behavior remain open hypotheses. The MoonBoard hold layout year does not identify its controller model.

The next discriminating evidence is the affected controller's discovered services and an official-app connection attempt on the same Pixel, including any PIN/pairing prompt. Do not add automatic pairing, guessed PINs, or broad retries based on `201/5` alone. The existing Boardsesh recovery change explains the disconnect and preserves a deliberate retry; it does not repair controller authentication.

### Implementation requirements for controller IDs and Pro authorization

These are follow-up requirements, not implemented capabilities. Full Pro support also needs its LED command format and mapping validated; adding a PIN dialog alone would not establish compatibility.

1. **Verify the identity encoding.** Compare the physical controller label with the official app's device name/address and a BLE advertisement/service inventory. Preserve leading zeroes and the verified source. Add a distinct MoonBoard controller identity rather than reusing Aurora's `#serial` parser or deriving an ID from iOS's peripheral UUID.
2. **Carry identity through both scanners.** The connection adapters retain manufacturer/service data, but `/boards` drops it and combines unknown MoonBoards into one row. Preserve verified identity through scan caching, show separate selectable controllers, and update remembered recognition. A newly received identity must trigger a scan-row update even when RSSI is unchanged. Controller identity does not establish hold layout or gym board configuration.
3. **Gate Pro operations on positive authorization.** Discover the Pro service before offering PIN entry; do not infer it from a name, layout year or status `5`. Validate PIN encoding, derivation and controller acceptance against an independent test vector or hardware exchange. Keep protected operations unavailable until authorization succeeds, and discard submissions after cancellation, disconnect or connection replacement.
4. **Cover native reconnects and credential handling.** Native iOS needs a capability-gated authorization bridge and a gate before ready/persist/relight when authorization is required. A JS-only prompt cannot cover background reconnects. Keep credentials in memory initially; any remembered credentials require account/controller-scoped secure storage and sign-out cleanup. PINs and authentication payloads must never enter analytics or error logs.
5. **Validate the behavior on hardware.** Test two same-name controllers, identifier stability across phones, wrong/correct PIN, cancellation and reconnect, legacy controllers, and ordinary climb lighting. Keep authorization scope and protocol support explicit until those checks pass.

---

## Appendix — UUID reference

| UUID                                   | Classification                         | In LED path?            |
| -------------------------------------- | -------------------------------------- | ----------------------- |
| `713d0000-503e-4c75-ba94-3148f18d941e` | RedBearLab service (original hardware) | yes (service)           |
| `713d0003-503e-4c75-ba94-3148f18d941e` | RedBearLab write characteristic        | yes (write)             |
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Nordic UART service (newer hardware)   | yes (service)           |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Nordic UART RX (write)                 | yes (write)             |
| `713d0002-…` / `6e400003-…`            | Notify characteristics                 | No readable literal found; use unverified |
| `6ba7b811-9dad-11d1-80b4-00c04fd430c8` | `uuid` package NAMESPACE_URL constant  | no                      |
| `2c9285bc-dfd0-4fd8-a13d-393660f8a060` | Third legacy service (v1.3.77)        | yes (profile service)   |
| `5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4` | Third legacy `pixelSingle` characteristic | yes (profile command) |
| `7a112233-4455-6677-8899-aabbccddee01` | Pro service (v1.3.77)                 | yes (profile service)   |
| `7a112233-…-aabbccddee31` / `32` / `33` | Pro salt / challenge / unlock        | authorization path      |
| `00000000-0000-0000-0000-000000000000` | Nil UUID                               | no                      |
