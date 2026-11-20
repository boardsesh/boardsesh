# MoonBoard Bluetooth compatibility audit

MoonBoard app **1.3.77 (377)** constructs four controller profiles. Boardsesh at [5e01cb95](https://github.com/boardsesh/boardsesh/tree/5e01cb95b62573da799ac9059566c4b86a0abaa1) implements two of them. Additional gaps include legacy option framing, Pro binary commands and status handling, and extraction of the manufacturer's documented 12-digit controller identifier.

This audit complements the [independent identity and Pro authorization investigation](MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md#10-android-v1377-investigation-2026-11-20) merged separately into the protocol specification. Its source comparison remains scoped to the commit above.

This is an interoperability assessment. It changes documentation, not the Bluetooth client. Static code findings establish packet construction and selected call paths; physical controller behavior remains unverified. Hardware model names cannot be inferred solely from these profiles.

## Findings to review first

| Priority | Finding | Consequence |
| --- | --- | --- |
| High | Third legacy profile missing | Its service and write characteristic are not discovered by our transports. |
| High | Pro protocol missing | A new UUID alone cannot enable its binary writes, configuration and status lifecycle. |
| High for optional features | Legacy flags omit `*`; conditional `M` and `B` absent | Our optional commands differ from the analyzed app's format. |
| Identity evidence needed | Documented 12-digit controller ID lacks a dedicated parser | Automatic board identification depends on the generic name suffix or peripheral ID. |
| Medium | Gym fixture drops official flags and mishandles partial retries | Existing fixture tests can miss compatibility and recovery problems. |

The [capability comparison](moonboard-bluetooth-audit-2026-11-20/comparison.csv) contains 25 entries. [Protocol evidence](moonboard-bluetooth-audit-2026-11-20/protocol-evidence.json) records UUID maps, packet fields and method addresses.

## Controller profiles

The constructor at `libapp.so:0x79292c` (instruction-table method 17101, `init:cwi`) returns four profiles:

| Protocol | Service | Primary LED characteristic |
| --- | --- | --- |
| Legacy / RedBear | `713d0000-503e-4c75-ba94-3148f18d941e` | `713d0003-503e-4c75-ba94-3148f18d941e` |
| Legacy / Nordic UART | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| Third legacy profile | `2c9285bc-dfd0-4fd8-a13d-393660f8a060` | `5b2bf25f-9a69-4a5a-8788-6f3ddcb97fc4` |
| Pro | `7a112233-4455-6677-8899-aabbccddee01` | Named map including `pixelBatch` at `…ee03` |

The first three receive the `legacy` enum; the fourth receives `pro`. The third pair's UUID loads occur at `0x792a9c` and `0x792acc`, followed by assignment to the service and `pixelSingle` map. The registry is consumed by discovery method 17427 (`0x7a4934`), called by handler 39946 (`0xdc80fc`). These are assignments and call paths, not a conclusion from nearby strings.

Our [shared UUIDs](../packages/shared/ble-protocol/src/transport.ts), [Web discovery and optionalServices](../packages/shared/ble-protocol/src/web-transport.ts), [React Native adapter](../packages/mobile/src/lib/ble/adapter.ts), and [native iOS manager](../packages/mobile/modules/live-activity/ios/BoardBleManager.swift) support Nordic and RedBear only at the audited commit. Appearing in a name-based picker does not grant Web Bluetooth access to an omitted service.

The old specification's classification of the third pair as unrelated SDK identifiers was incorrect for this artifact. Add the third legacy profile across platforms independently of the larger Pro integration.

## Pro protocol and lifecycle

Pro has 20 primary characteristic mappings and four notification mappings. The primary map serves reads as well as writes. It includes pixel operations, board configuration, brightness, advertising name, LED count, multi-user mode, user name, screensaver, and authentication. Map registration alone does not prove every operation is invoked by the UI.

The pixel path is traced from sender 17908 (`0x7c73dc`) through converter 17909 (`0x7c7708`), the `pixelBatch` event, its registered handler 39943, closure 39945, and writer 39935 (`0xdc772c`). Connected/protocol state and discovered-characteristic readiness are checked.

Packets contain a header byte, a one-byte count, then four bytes per update:

```text
header, count, index_low, index_high, value_low, value_high, ...
```

The single-batch converter uses header `03`, with count 1–255. The segmented base-pixel converter 24966 (`0xa027b4`) uses first/last flags: `02` first, `00` middle, `01` last, or `03` for a single packet. Its destination is `chrBasePixelBatch` (`…ee27`). Entry capacity derives from `(payloadBytes - 2) / 4`, bounded to 1–255, with an error for a payload smaller than six bytes. Header `03` should not be called an opcode. Values are 16-bit numeric values, not our persisted role codes; the recovered constants are in the evidence JSON.

After discovery, method 17402 (`0x7a23f8`) cancels old subscriptions and conditionally subscribes to `cfgStatus` (`…ee09`), `connectionStatus` (`…ee05`) and `chrSessionStatus` (`…ee24`). Missing connection status returns before the session subscription. `authState` (`…ee28`) is registered but is not subscribed by that routine. These channels do not establish a per-frame acknowledgement contract.

`frameCommit` (`…ee04`) is registered; its invocation and payload semantics were not established. This extraction also registers `authClaim`, `authSalt`, `authChallenge` and `authUnlock` at `…ee30`–`…ee33`. The independent trace in [protocol specification §10](MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md#10-android-v1377-investigation-2026-11-20) establishes salt/challenge reads, an unlock write and status checking; it supports a SHA-256/HMAC derivation with explicit inference limits. That work extends this extraction, which did not complete the PIN path. Full authorization scope and controller acceptance still need validation. Do not infer a commit or unlock sequence from characteristic names alone.

Boardsesh has no corresponding Pro integration in the audited paths. Implement profile discovery, configuration/mapping, required authorization, binary encoding and notification cleanup before exposing Pro as ready. Controller-management features can then be scoped separately.

## Legacy flags and Mini behavior

Method 23913 (`0x9ac694`) constructs an empty prefix or `~` + comma-joined flags + `*`. Wrappers 23912, 24001 and 24016 concatenate that prefix with `l#`, payload and `#` into one string. Separate ATT writes for the flags are not required by this evidence.

```text
Boardsesh D option:  ~Dl#S0,P35,E197#
App D format:        ~D*l#S0,P35,E197#
Conditional M:       ~M*l#S0,P23#
Combined flags:      ~D,M*l#...#
```

Both our [TypeScript](../packages/shared/ble-protocol/src/moonboard.ts) and [Swift](../packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift) encoders use `~D` and never emit `M` or `B`. Ordinary frames without flags are unaffected by this finding. Our current D feature is optional and explicitly unverified on official controllers.

The app appends flags in D, B, M order. Recovered conditions, using the obfuscated configuration object's field offsets, are:

| Flag | Condition |
| --- | --- |
| D | third argument and configuration booleans at `0x2b` and `0x1f` |
| B | configuration boolean at `0x37` |
| M | second argument and configuration boolean at `0x2b` |

Method 24000 passes a predicate involving the literal `mini` from method 17924 into the M gate via 24001. Two other wrappers disable the D/M argument gates. This supports a conditional Mini path, not a rule to send M for every 12-row operation. Exact configuration field meanings need further tracing or a device capture. D/dual and B/beta are plausible setting interpretations, not established field-to-storage mappings.

## The documented 12-digit controller identifier

Moon's [control-box product page](https://eu.moonclimbing.com/moonboard-control-box-v5.html) and [Mini LED system page](https://eu.moonclimbing.com/mini-moonboard-led-system-v5.html), read on 2026-11-20, document a unique 12-digit ID shown during Bluetooth connection so users can select the correct board among nearby controllers.

The documentation does not specify the advertisement field, byte encoding, GATT characteristic, or relationship to authentication. Twelve characters do not establish that it is a MAC address. Preserve it as an opaque string, including leading zeros, when the format is verified.

Our current behavior is narrower:

1. [parseSerialNumber](../packages/shared/ble-protocol/src/aurora.ts) extracts `/#([^@]+)/` from the device name. A 12-character suffix after `#` already fits; there is no dedicated MoonBoard ID decoder.
2. [Quickstart classification](../packages/mobile/src/lib/ble/quickstart-scan-device.ts) preserves the full name, but uses a serial key only when that parser succeeds. Otherwise the MoonBoard path uses the BLE device ID and `serial: null`.
3. [Connection persistence](../packages/mobile/src/lib/ble/use-board-bluetooth.ts) records that parsed serial or remembers the peripheral ID. Manufacturer/service advertisement bytes are telemetry only in this path.
4. [Backend validation](../packages/backend/src/validation/schemas/boards.ts) accepts MoonBoard serial strings of 1–64 characters, so storage length is sufficient.

For illustration, `MoonBoard#123456789012` is parsed; `MoonBoard 123456789012` is not. These are hypothetical examples, not captured manufacturer names. A full displayed name can still help a person select a board even when automatic identity extraction fails.

The [onboarding copy](../packages/shared/i18n/locales/en-US/boards.json) says “MoonBoards don't send a serial number.” That blanket claim should be replaced with a description of whether this scan identified the board. The documented controller identifier is not automatically proven to be a factory serial number.

The inspected APK scan mapper preserves plugin ID, name, manufacturer data and service data; no dedicated 12-character decoder was established in it. Selected Pro parsers consume a 13-byte numeric board configuration, a variable-length UTF-8 configuration name, 16-byte connection-status entries, and a one-byte authentication state. None was established as the documented ID. This does not prove the ID is absent: the app could simply display the existing name without a special parser.

The independent [scan-row and service-data trace](MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md#controller-identification) adds that the inspected row displays the name and plugin device ID, with Android obtaining that ID from `BluetoothDevice.getAddress()`. It also traces numeric board/configuration/setup fields in service data. Neither establishes their equivalence to the documented 12-digit identifier.

**Identity compatibility remains unresolved.** Obtain one real controller's name and advertisement bytes, followed by GATT reads if needed, before defining a parser. Verify stability across reconnects and platforms, and keep this identity separate from the platform connection handle and setup PIN.

## Transport behavior

The app's writer selects without-response only when the discovered characteristic supports it and the event does not force a response. The support bit is traced from bridge field `isWritableWithoutResponse` through methods 32544, 39925 and 17427 to writer 39935. Each chunk is awaited. The without-response branch requests a 5,000-microsecond delay after every chunk, including the last; this is a code constant, not measured scheduling.

Connected handler 39962 (`0xdc8534`) resets payload size to 20, waits 250 ms, requests MTU 242, and stores `clamp(negotiatedMTU - 3, 20, 242)`. Successful negotiation of 242 normally gives 239 payload bytes. Failure and disconnect fall back to 20. The writer separately clamps chunk size to 20–242.

Our fixed 20-byte MoonBoard chunks are conservative and match the app's fallback size. Skipping MTU negotiation is a throughput difference, not an established legacy failure. Property-based writes, pacing, serialized sends, connection generation guards, cleanup and native watchdogs already provide useful protections.

The app scans its profile services with a balanced scan setting. Our mobile scan is broader and filters in the app; Web uses service and name filters. Neither a generic UART service nor a MoonBoard-like name authenticates the manufacturer.

Native iOS has a conditional fallback limitation: a present Nordic service without its expected write characteristic prevents a RedBear fallback, unlike the React Native/Web probes. No stock controller with this mixed layout was established. See `BoardBleManager.swift` around lines 2672–2681 at the audited commit.

## Fixture and malformed-input findings

The [gym fixture wrapper](../embedded/projects/board-controller/src/gym/ble.h), around lines 707–755, accepts D/M while parsing configuration but resets on `*` or `,`. It then accepts the following `l#…#` as a bare frame. Consequently official `~D*l#S1#` loses the D option, while our `~Dl#S1#` retains it. The standalone shared parser tolerates extra configuration characters; the gym wrapper is the stricter component. Existing inline-form tests miss this difference.

The same wrapper does not resynchronize on a new `l` inside a partial payload. With less than two seconds between writes on one connection, `l#S0` followed by `l#P35#` closes a malformed old frame and ignores the remainder of the new one. Disconnect or the idle timeout clears it. This is a source finding about our fixture, not stock firmware. A regression should fail a later chunk and retry the complete frame immediately.

TypeScript and Swift also disagree on malformed stored frames: `p1r42r99` is accepted as S0 in TypeScript and rejected in Swift; `p1rr42` is rejected in TypeScript and accepted in Swift because empty split pieces are omitted. Well-formed `p1r42` is unaffected. Align rejection rather than silently accepting extra separators.

Keep the existing guard that refuses a non-empty climb with no encodable holds. Deliberate empty input sends `l##`; its effect on stock firmware remains unverified. The production gym path uses raw wire positions and configured rows, so the older shared parser's 18-row helper is not evidence of a Mini rendering defect in that path.

## Provenance and verification

The input was the supplied `com.trainingboard.moon` XAPK, version 1.3.77 (377). The ARM64 APK was independently extracted and its `libapp.so` matched the analyzed bytes. This extraction did not verify publisher signatures. The separate investigation in protocol specification §10 records APK signature integrity and signer continuity for these same artifact hashes; it does not claim a direct Play Store download.

| Artifact | SHA-256 |
| --- | --- |
| XAPK | `331c930b0b463487897296a98400e7585e592aaf4b41b2687d91f3bdd52112bf` |
| Base APK | `afb221bb58a6cb711bc510cf6816c21386331eb987e7bc63f49238781fbc3dd9` |
| ARM64 split | `fb3f32e89b39ccc3f20881750b587bb06162528f6d5dc30e433005e7460c9636` |
| libapp.so | `521724ec57cd94024989f7d5f57927988a15b7d52ec1b6e75787c9ca27e6dc2c` |

REA established package/build/snapshot evidence. Its configured engines did not provide method decompilation, so a bounded offline parser derived from the [Dart 3.12.0 SDK](https://github.com/dart-lang/sdk/tree/3.12.0/runtime/vm) decoded snapshot references through the global object pool, including VM strings. System Capstone annotated ARM64 instructions. Method numbers here are instruction-table indices; they are not recovered original Dart names. No target code was executed.

Independent review verified snapshot alignment, selected raw UUID loads, flag punctuation, batch flags and call targets. It checked 2,295 instructions and 243 direct BL targets in eight critical methods, plus 9,101 DEX instruction records in selected methods. Conservative tracer branch-state and bounds fixes were re-reviewed. These checks validate the cited paths, not every indirect call or UI route.

The package, extracted binaries, full method dumps and SDK sources remain in the local investigation artifacts; this PR contains the interoperability conclusions and address ledger. No physical board, runtime capture, HCI trace or repository unit suite was available. The required `vp` executable was missing; attempted validation returned exit 127. Authentication completeness, ID wire format, notification payload meaning, exhaustive role/color mapping and physical behavior remain open.

## Follow-up sequence

1. Add the third legacy profile to all transports and Web service authorization.
2. Establish controller-ID encoding and capability gates for manufacturer flags.
3. Update fixture framing/recovery and malformed-frame parity with regression cases.
4. Build Pro as a separate protocol with configuration, authorization and status handling.
5. Verify the available controller matrix with exact GATT UUIDs and captured bytes.
