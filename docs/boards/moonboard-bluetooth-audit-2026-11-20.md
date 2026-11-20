# MoonBoard Bluetooth compatibility audit

MoonBoard app **1.3.77 (377)** constructs four controller profiles. Boardsesh at [5e01cb95](https://github.com/boardsesh/boardsesh/tree/5e01cb95b62573da799ac9059566c4b86a0abaa1) implements two of them. Additional gaps include legacy option framing, Pro binary commands and status handling, and extraction of the manufacturer's documented 12-digit controller identifier.

This audit complements the [independent identity and Pro authorization investigation](MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md#10-android-v1377-investigation-2026-11-20) merged separately into the protocol specification. Its source comparison remains scoped to the commit above.

This is an interoperability assessment. It changes documentation, not the Bluetooth client. Static code findings establish packet construction and selected call paths; physical controller behavior remains unverified. Hardware model names cannot be inferred solely from these profiles.

## Findings to review first

| Priority | Finding | Consequence |
| --- | --- | --- |
| High | Third legacy profile missing | Its service and write characteristic are not discovered by our transports. |
| High | Pro protocol missing | A new UUID alone cannot enable its binary writes, client registration, configuration and session/status lifecycle. |
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

Our [shared UUIDs](../../packages/shared/ble-protocol/src/transport.ts), [Web discovery and optionalServices](../../packages/shared/ble-protocol/src/web-transport.ts), [React Native adapter](../../packages/mobile/src/lib/ble/adapter.ts), and [native iOS manager](../../packages/mobile/modules/live-activity/ios/BoardBleManager.swift) support Nordic and RedBear only at the audited commit. Appearing in a name-based picker does not grant Web Bluetooth access to an omitted service.

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

## Settings, controller management and the setup PIN

The follow-up trace gives the PIN a concrete purpose. UI methods 13492 (`0x6970dc`) and 20852 (`0x8f1258`) describe a setup PIN that protects device settings and LED mapping and is needed for later configuration changes. This is stronger evidence than inferring purpose from the authentication characteristic names.

| Message group | Recovered operations | Evidence and limits |
| --- | --- | --- |
| Persistent settings | Advertising name (`…ee0C`), LED count (`…ee0D`), brightness (`…ee0A`), screensaver (`…ee0B`) | Writers 42012, 42017, 43049 and 41893 dispatch named BLE writes; registration alone is no longer the only evidence for these operations. |
| Board/LED mapping | `holdAssign` (`…ee07`) and `chrBoardConfig` (`…ee20`) | Mapping save/send actions 43051 and 43058 check gate 43053 (`0xe2f27c`); predicate 24939 (`0xa00be8`) requires authorization state `unlocked`. Save closure 43054 checks again before dispatch. |
| Session management | Disconnect one selected user or all users through `chrControl` (`…ee22`); multi-user mode has a separate mapped characteristic (`…ee25`) | Confirmation dialogs 40777/40789 call senders 19024/19046. Multi-user mode's mapping alone does not prove its complete UI lifecycle. |
| Factory reset | Reset controller settings through `chrControl` (`…ee22`) | Factory Reset widget 22132 → dialog 22133 → Reset closure 22134 → sender 22136. Its settings panel is behind the shared authorization widget; peripheral enforcement remains unverified. |
| Security provisioning | Set an initial PIN with `authClaim` (`…ee30`); later unlock with salt/challenge/response (`…ee31`–`…ee33`) | The `unclaimed` branch in 37981 calls 38050, which encodes the supplied PIN and writes `authClaim` through 13421, then refreshes security status. |

The shared security widget 18992 (`0x84f3c8`) displays PIN entry for locked/unclaimed states and invokes its child builder for `unlocked`. The settings-panel path 24921 → child builder 24924 → panel 24972 includes the `wlb` class that owns the Factory Reset callbacks. This binds that UI to the authorization gate. It does not establish that every settings/control writer independently checks authorization, or that the peripheral rejects unauthenticated writes. Ordinary climb lighting's `pixelBatch` path has not been shown to require the setup PIN; the protected “send LED data” action traced here belongs to the mapping editor.

**Initial PIN setup is a distinct message.** Method 38050 (`0xd74d8c`) passes the encoded PIN bytes directly to `authClaim`; there is no hash/MAC construction on that branch. For the six accepted decimal digits, these are the six ASCII bytes. The later `authUnlock` path uses the derived response described in the protocol specification. This finding is about the GATT payload, not whether the BLE link is encrypted. It does not establish an existing-PIN change or recovery procedure.

The controller-management payloads are three bytes. Builder 19025 (`0x852140`) constructs a selected-user disconnect message; builder 19047 (`0x8544d4`) constructs disconnect-all and factory-reset messages with distinct call-site arguments. The reset event requests a write response; that transport acknowledgement is not evidence the reset completed. The disconnect-all sender also has a legacy command branch. These are statically recovered commands, not commands sent to a controller during this investigation.

Settings also have an application-level completion mechanism. Helper 41894 (`0xdef2a8`) registers a pending result keyed by operation kind and command before dispatching the write, then waits with a timeout. Name, LED-count, brightness and screensaver writers use it. This differs from an ATT write acknowledgement and does not establish a per-climb-frame acknowledgement. The follow-up below traces reply completion and a status-coded timeout; meanings of the controller's numeric result codes remain unresolved.

**Firmware updates remain unestablished.** No dedicated firmware-transfer characteristic appeared in the recovered four-profile registry. Bounded searches of recovered Dart strings, all 36,638 base-DEX strings and the APK member names did not establish a controller updater. The `bootloader` reference resolves to Android phone metadata (method 16325), and the DEX `Firmware Revision String` literal is in a static characteristic-name initializer; neither is an update call path. Filename searches for firmware/update terms and `.bin`/`.hex`/`.uf2` assets matched only Flutter's asset manifest and Kotlin debug-probe metadata. This does not rule out an updater in another build, an external tool or a dynamically constructed path.

The evidence therefore supports a settings/mapping purpose for the PIN. Firmware updating is not needed to explain it. These management capabilities remain absent from the audited Boardsesh client and should be assessed separately from basic climb-lighting compatibility.

## Further interoperability findings

### Automatic client registration and multi-user sessions

`chrUserName` (`…ee26`) carries a **16-byte UUID**, despite its name. Builder 19083 (`0x856710`) removes hyphens, requires 32 hexadecimal characters and decodes sixteen byte pairs. Writer 40808 (`0xde3d14`) sends those bytes with a response requested. Callback 19082 (`0x85650c`) triggers it once the connection is `connected` and `discoveredReady`, provided an application identity object exists. Its one-shot guard resets when disconnected. The source field's semantic name is not recovered; do not equate this client/user identity with a display name or the manufacturer's 12-digit controller identifier.

This is additional application traffic after service discovery and belongs in a Pro interoperability implementation. Static evidence does not prove that the controller requires registration before accepting every climb write. The official callback sets its one-shot guard before checking whether the identity is available, so a client implementation should distinguish registration attempted from registration completed and allow a safe retry when the identity becomes available.

The multi-user toggle calls 40791 (`0xde3260`) and writes two bytes to `cfgMultiUserMode` (`…ee25`): a generated token byte and a boolean mode byte, with a response requested. The token derives from a native integer divided by 1,000 and masked to eight bits; its exact meaning is not established. `chrSessionStatus` (`…ee24`) reports single-climber versus multi-climber mode through byte zero. Neither the configuration-like key nor its name proves the operation requires the setup PIN.

`connectionStatus` (`…ee05`) carries fragmented connected-client lists. Reassembler 17421 (`0x7a365c`) reads a five-byte header containing transfer ID, little-endian offset and little-endian total length. Body parser 17422 (`0x7a3cd4`) reads a three-byte header and entries containing a slot, identity length and UUID bytes. Nonempty identities must be 16 bytes. This connects session membership to the previously traced disconnect-by-slot command; it is more than a generic connected/disconnected flag.

### Settings replies, timeouts and reconnect cleanup

The `cfgStatus` (`…ee09`) callback 17426 (`0x7a4730`) requires at least five bytes and constructs a result from kind, command, status and two additional bytes. Registered handler 17283 → 17284 (`0x79cb38`) removes the pending request with key `(kind << 8) | command`, completes it with the result and publishes status into state. The last two bytes' meanings and the complete controller status-code table remain unresolved. This matching key has no request sequence or connection identifier; a new implementation should account for late replies and reconnects instead of assuming any matching response belongs to the newest attempt.

**Static success-reporting issue in the official app:** timeout callback 21939 (`0x92c8d0`) removes the pending entry and returns a synthetic result with status `255`; it does not throw. The inspected name writer 42012, LED-count writer 42017 and screensaver writer 41893 await that result and then report success without checking its status. These paths can therefore display success without a timely matching acknowledgement. This does not establish that the controller failed to save: its reply could have been delayed or lost. Other thrown errors have separate failure paths. An independent client should explicitly validate returned status and handle timeout as an uncertain outcome, rather than copy the success-message behavior.

The app does have useful cleanup. Method 39907 (`0xdc5cb0`) cancels the three automatic status subscriptions, fails pending requests with `Disconnected` and clears their map. Method 17287 (`0x79cd04`) clears discovered characteristic maps, restores the 20-byte payload default and replaces the serial-write future tail. Clearing a queue tail alone does not establish cancellation of old in-flight work; Boardsesh's existing connection-generation guards remain relevant when adding this protocol.

**Reassembly robustness to preserve:** the inspected connection-status reassembler invokes the full-body parser after copying each fragment into a zero-filled buffer, without first checking complete byte coverage. A structurally valid partial body can therefore be a candidate for premature parsing. Its transfer ID and accumulator also use static storage; no clearing of those fields was found in the inspected disconnect/reset methods. The session-status callback reads four indices without an explicit minimum-length check. These are static edge-case candidates, not observed controller failures. Implement explicit length/coverage checks and connection-scoped reassembly state, and test truncation, fragmentation, transfer-ID reuse and reconnects.

### Richer LED roles and conditional neighbouring LEDs

The ordinary Pro converter 17909 (`0x7c7708`) actively consumes marker map 17912 and numeric-value map 17914. It distinguishes start, end, left, right, foot and match roles. These are richer than our legacy start/intermediate/end model. The numeric values are neither proven displayed colors nor Boardsesh's persisted role IDs. A dual value exists in the table, but the inspected marker mapper does not emit that role, so the table alone does not establish full dual-role input coverage.

The same converter can insert a same-column neighbouring LED before the original pixel. It checks an additional argument and geometry, uses 12-row or 18-row layouts and prevents crossing the column boundary. This is an actual packet-construction path, not merely a configuration string. Its upstream preference/capability meaning remains unresolved; do not enable it unconditionally or assume its physical effect from the arithmetic alone.

### Preview commands and names are separate from identity

Brightness has a separate `brightnessPreview` characteristic (`…ee0E`) and a saved brightness setting (`…ee0A`). The traced UI helper 41291 calls preview builder 20578 → writer 24929 and then save callback 43049. The preview contains brightness plus three color-like components; exact channel order and displayed colors remain unverified. The saved-setting path uses the settings reply mechanism. The existence of a preview command does **not** mean all slider changes are preview-only or that saving is deferred until release.

The advertising-name writer accepts 2–12 UTF-8 bytes and lets users rename the controller. That byte limit is not evidence for the 12-digit manufacturer ID. Profile discovery should use verified service capabilities as well as names, and identity persistence should not assume the advertised name is immutable.

Finally, the concrete `chrBasePixelBatch` caller traced in 43067 (`0xe2fdfc`) belongs to the LED mapping editor. It does not establish a mandatory base layer for ordinary climbs. `frameCommit` and `maskSet` still have registered characteristics but no established invocation in this bounded pass; a client should not append guessed commit or mask messages.

## Legacy flags and Mini behavior

Method 23913 (`0x9ac694`) constructs an empty prefix or `~` + comma-joined flags + `*`. Wrappers 23912, 24001 and 24016 concatenate that prefix with `l#`, payload and `#` into one string. Separate ATT writes for the flags are not required by this evidence.

```text
Boardsesh D option:  ~Dl#S0,P35,E197#
App D format:        ~D*l#S0,P35,E197#
Conditional M:       ~M*l#S0,P23#
Combined flags:      ~D,M*l#...#
```

Both our [TypeScript](../../packages/shared/ble-protocol/src/moonboard.ts) and [Swift](../../packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift) encoders use `~D` and never emit `M` or `B`. Ordinary frames without flags are unaffected by this finding. Our current D feature is optional and explicitly unverified on official controllers.

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

1. [parseSerialNumber](../../packages/shared/ble-protocol/src/aurora.ts) extracts `/#([^@]+)/` from the device name. A 12-character suffix after `#` already fits; there is no dedicated MoonBoard ID decoder.
2. [Quickstart classification](../../packages/mobile/src/lib/ble/quickstart-scan-device.ts) preserves the full name, but uses a serial key only when that parser succeeds. Otherwise the MoonBoard path uses the BLE device ID and `serial: null`.
3. [Connection persistence](../../packages/mobile/src/lib/ble/use-board-bluetooth.ts) records that parsed serial or remembers the peripheral ID. Manufacturer/service advertisement bytes are telemetry only in this path.
4. [Backend validation](../../packages/backend/src/validation/schemas/boards.ts) accepts MoonBoard serial strings of 1–64 characters, so storage length is sufficient.

For illustration, `MoonBoard#123456789012` is parsed; `MoonBoard 123456789012` is not. These are hypothetical examples, not captured manufacturer names. A full displayed name can still help a person select a board even when automatic identity extraction fails.

The [onboarding copy](../../packages/shared/i18n/locales/en-US/boards.json) says “MoonBoards don't send a serial number.” That blanket claim should be replaced with a description of whether this scan identified the board. The documented controller identifier is not automatically proven to be a factory serial number.

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

The [gym fixture wrapper](../../embedded/projects/board-controller/src/gym/ble.h), around lines 707–755, accepts D/M while parsing configuration but resets on `*` or `,`. It then accepts the following `l#…#` as a bare frame. Consequently official `~D*l#S1#` loses the D option, while our `~Dl#S1#` retains it. The standalone shared parser tolerates extra configuration characters; the gym wrapper is the stricter component. Existing inline-form tests miss this difference.

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
