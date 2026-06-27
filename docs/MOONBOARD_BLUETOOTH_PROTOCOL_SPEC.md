# MoonBoard Bluetooth Protocol Specification

**Source app**: Moon Climbing (`com.trainingboard.moon`) **v1.2.45** (build 265)
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

- ✅ **Observed in the official app** — present directly in the shipped app's manifest or its compiled Dart assets (string/symbol table).
- 🔁 **Corroborated wire format** — the byte-level LED encoding the app must speak to the same controllers. Cross-checked against Boardsesh's working `moonboard.ts`, the open-source controller firmware, and the physical LED wiring; not the part that is uniquely attributable to the official app.
- ❓ **Present, role unconfirmed** — an artefact is present but its exact purpose is not proven by static inspection. Flagged for a live BLE capture.

---

## TL;DR

| Question                               | Answer                                                                                                                  | Tag |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --- |
| BLE library                            | `flutter_reactive_ble` (not `flutter_blue_plus`).                                                                       | ✅  |
| How many controller generations?       | **Two.** The app carries UUIDs for both an original **RedBearLab** service and the newer **Nordic UART** one.           | ✅  |
| Original-hardware service / write char | `713d0000-…` service, write to `713d0003-…`.                                                                            | ✅  |
| Newer-hardware service / write char    | `6e400001-…` (Nordic UART) service, write to `6e400002-…` (Nordic UART RX).                                             | ✅  |
| Subscribes to board notifications?     | **No.** Neither notify characteristic (`713d0002`, `6e400003`) is referenced — the app is write-only.                   | ✅  |
| Bonds / pairs with the board?          | **No.** The app explicitly tells users _"DO NOT pair your phone to the board"_ — a plain GATT connect, no bond.         | ✅  |
| Per-board LED version?                 | **Yes.** Boards persist a `led_version`; the app tracks LED hardware generation per board.                              | ✅  |
| LED payload format                     | ASCII `l#<marker><pos>,<marker><pos>,…#` over the chosen write characteristic.                                          | 🔁  |
| LED position numbering                 | Column-major **serpentine** over the 11×18 grid (positions 0–197).                                                      | 🔁  |
| Two extra 128-bit UUIDs in the binary  | Present, but match **neither** BLE service family; they live in the app's `uuid`-package / SDK realm, not the LED path. | ❓  |

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

For completeness on the stack (not part of the LED path): the app is Flutter (Dart 3.8.1, stable channel), stores its board database with `drift` over `sqlcipher`, and uses Firebase for its backend. None of that is needed for interop.

---

## 2. Service & Characteristic UUIDs

✅ Two distinct controller hardware generations are addressed by the app. Both UUID families are present verbatim in the shipped Dart assets:

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

### 2.3 Write-only — no notify channel

✅ Neither notify/TX characteristic appears anywhere in the binary:

- `713d0002-…` (RedBearLab peripheral→central notify) — **absent**.
- `6e400003-…` (Nordic UART TX) — **absent**.

The app references only the two **write** characteristics, on either hardware generation. With no notify characteristic referenced, LED control is one-way, **app → board**.

### 2.4 Two further 128-bit UUIDs ❓

Two other 128-bit UUIDs are present in the binary:

```
2c9285bc-dfd0-4fd8-a13d-393660f8a060
5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4
```

Neither matches the RedBearLab or Nordic UART families, and neither is part of the LED write path. They sit alongside the app's embedded `uuid` package (the `Namespace` / `ValidationMode` / RFC-4122 machinery) and its SDK identifiers — note the standard `uuid` namespace constant `6ba7b811-9dad-11d1-80b4-00c04fd430c8` (NAMESPACE_URL) and the nil UUID are present for the same reason. **Treat these two as non-BLE app identifiers** unless a live capture proves otherwise. An interoperable client needs only the four UUIDs in §2.1–§2.2.

---

## 3. Device discovery (scan)

✅ The app scans with `flutter_reactive_ble` (symbols `ScanForDevicesRequest`, `scanMode`, `requireLocationServicesEnabled`). Discovered devices arrive as `DiscoveredDevice(id: …)`; services and characteristics are resolved per `DiscoveredService(serviceId: …)` after connect.

MoonBoard controllers advertise a BLE name beginning with **`MoonBoard`** (the app's user-facing copy and Boardsesh's existing `MOONBOARD_DEVICE_NAME_PREFIXES = ['MoonBoard', 'Moonboard']` both key on this prefix). The exact membership of the scan's service-UUID filter is not provable from static strings; what is certain is that the app carries **both** service UUIDs from §2 and resolves the right write characteristic after connecting.

---

## 4. Connection lifecycle

✅ Symbols + `flutter_reactive_ble` semantics give this sequence:

```
request BLE + location permissions
        │   "Bluetooth and location access is required to connect to the MoonBoard."
        ▼
scan for devices            (ScanForDevicesRequest)
        │
        ▼
connect to chosen board     (ConnectToDeviceRequest)  ← NOT bonded
        │   "Do you want to connect to the board (DO NOT pair your phone to the board)?"
        ▼
discover services           → RedBearLab 713d0000…  OR  Nordic UART 6e400001…
        │
        ▼
locate write characteristic → 713d0003…              OR  6e400002…
        │
        ▼
READY → write LED frames     (Write Without Response — see §5.4)
        │
        ▼
disconnect
```

✅ **Unbonded by design.** The app surfaces an explicit warning — _"Do you want to connect to the board (DO NOT pair your phone to the board)?"_ — and connects without creating an OS-level bond. An interoperable client should likewise **GATT-connect without pairing**; bonding these controllers is a known source of broken connections.

> **Difference vs. the open-source-derived client:** the existing Boardsesh client connects, discovers the Nordic UART service, and writes. It has no branch for the RedBearLab service, so it cannot drive an original-hardware board even though the official app can.

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

🔁 The 11-column × 18-row board (columns A–K, rows 1–18) is wired as a single **serpentine** WS2812B string: up column A, down column B, up column C, and so on. The app converts a hold's grid coordinate to its position on that string exactly as Boardsesh's `getMoonboardSerialPosition` does:

Pseudocode (`//` is integer division / floor, `%` is modulo; `#` starts a comment):

```text
holdId    = 1..198          # row-major: A1=1, B1=2, … K1=11, A2=12, …
z         = holdId - 1
col       = z % 11          # column index 0..10  (modulo)
row       = floor(z / 11)   # row index 0..17     (z // 11)

if col is even:  position = col*18 + row
if col is odd:   position = col*18 + (17 - row)

# position range: 0..197
```

The position index is a property of the **physical LED string**, so it is identical between the official app and Boardsesh. Worked checks (matching `moonboard.test.ts`): `holdId 1 → 0`, `holdId 2 → 35`, `holdId 12 → 1`, `holdId 198 → 197`.

### 5.4 BLE chunking

🔁 The ASCII string is split into BLE writes. The classic transport size is **20 bytes per write** (`MAX_BLUETOOTH_MESSAGE_SIZE` in `transport.ts`); chunking is a transport detail and does not change the message.

**Write type depends on the controller generation.** The newer Nordic-UART RX characteristic (`6e400002`) supports **Write Without Response**. The original RedBearLab write characteristic (`713d0003`), however, advertises only the plain `.write` property — on iOS, CoreBluetooth **silently drops** a write-without-response to a characteristic that lacks the no-response property, leaving the wall dark. So an interoperable iOS client must use **write-with-response** for the RedBearLab box (pacing on the GATT write ack), and may use write-without-response for the Nordic-UART boards. Android's GATT stack issues no-response writes regardless of the advertised property, so the same write call works on both there. Boardsesh implements exactly this gating (`BoardBleEncoding.preferredWriteType` in `packages/mobile/modules/live-activity/ios/`): MoonBoard falls back to write-with-response whenever the chosen write characteristic doesn't advertise `.writeWithoutResponse`.

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
| Controller generations                | **Two**: RedBearLab `713d0000` **and** Nordic UART `6e400001` (discovery wired)¹        | **Two**: RedBearLab `713d0000` **and** Nordic UART `6e400001` |
| Original-hardware boards              | Discovers + writes `713d0003` (write-with-response on iOS); **unverified on hardware**¹ | Writes to `713d0003` on the RedBearLab service                |
| Per-board hardware version            | None (probes UART → RedBearLab on each connect)                                         | `led_version` persisted per board                             |
| Notify channel                        | None — write-only                                                                       | None — write-only on both generations                         |
| Bonding                               | Plain GATT connect, no bond                                                             | Explicitly **unbonded** ("DO NOT pair")                       |
| Payload (`l#…#`, markers, serpentine) | As documented here                                                                      | **Same** 🔁                                                   |
| Extra UUIDs                           | Ignored                                                                                 | Two present, non-BLE (uuid-package / SDK realm) ❓            |

¹ The RedBearLab discovery/write path (scan filter, characteristic-discovery fallback, write-with-response gating) is implemented across web, React Native, and native iOS and unit-tested, but has **not** been verified against an original MoonBoard LED box. See the constants `REDBEARLAB_SERVICE_UUID` / `REDBEARLAB_WRITE_CHARACTERISTIC_UUID` in `packages/shared/ble-protocol/src/transport.ts`.

**Bottom line for interop:** the `l#<marker><pos>,…#` payload Boardsesh emits is correct for the Nordic UART boards, and the client now also discovers and writes the **RedBearLab `713d0000` / `713d0003`** service (with the iOS write-with-response gating that path requires) and **connects without bonding**. Remaining work: **verify the RedBearLab path on an original board** and optionally persist which service a board exposed (mirroring the app's `led_version`) to skip the probe on reconnect.

---

## 9. Methodology & limitations

This protocol was reconstructed by **static inspection of the shipped Moon Climbing app** for the sole purpose of interoperability — identifying the BLE services, characteristics, connection model, and message shape an independent client must use to drive the same LED hardware. The app's compiled Dart assets are **not obfuscated**, so service/characteristic UUIDs, the BLE library surface, the data-model symbols, and the user-facing connection copy are all directly readable; the items in §1–§4, §6, §7 are tagged ✅ on that basis.

**Why the byte-level encoding is tagged 🔁, not ✅.** The distribution analysed bundles only 32-bit (`armeabi-v7a`) native code, and the available Dart-AOT method-body tooling targets 64-bit snapshots. Static inspection confirms _that_ the app frames LED commands (the `l#` literal and the hardware UUIDs are present) and selects per-board behaviour (`led_version`), but the exact field layout in §5 is taken from the corroborating sources — Boardsesh's shipped `moonboard.ts`, open-source controller firmware, and the physical LED wiring — all of which the shared hardware guarantees the app must match.

**To upgrade 🔁 → ✅ and resolve §2.4:** capture a **live BLE session** against each board generation (Android HCI snoop log / nRF Connect, or Boardsesh's own Web Bluetooth path) and diff the on-wire bytes against §5, watching for any GATT activity on the two unidentified UUIDs.

---

## Appendix — UUID reference

| UUID                                   | Classification                         | In LED path?            |
| -------------------------------------- | -------------------------------------- | ----------------------- |
| `713d0000-503e-4c75-ba94-3148f18d941e` | RedBearLab service (original hardware) | yes (service)           |
| `713d0003-503e-4c75-ba94-3148f18d941e` | RedBearLab write characteristic        | yes (write)             |
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Nordic UART service (newer hardware)   | yes (service)           |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Nordic UART RX (write)                 | yes (write)             |
| `713d0002-…` / `6e400003-…`            | Notify characteristics                 | **absent** — write-only |
| `6ba7b811-9dad-11d1-80b4-00c04fd430c8` | `uuid` package NAMESPACE_URL constant  | no                      |
| `2c9285bc-dfd0-4fd8-a13d-393660f8a060` | Non-BLE app identifier (unconfirmed)   | no                      |
| `5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4` | Non-BLE app identifier (unconfirmed)   | no                      |
| `00000000-0000-0000-0000-000000000000` | Nil UUID                               | no                      |
