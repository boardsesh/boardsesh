# Spraywall LEDs over Bluetooth (BLE)

Status: **design + unbuilt reference code**. The app side is implemented and unit
tested against a fake transport; the WLED usermod in
`firmware/wled-usermod-boardsesh-ble/` has **never been compiled or run on a
device**. Bluetooth changes need a Fable review before merge.

This document covers the second way the app can light a Spraywall: over
Bluetooth Low Energy, straight from the phone to the Spraywall's controller,
without the phone and the controller sharing a Wi-Fi network. The Wi-Fi path
(`docs/spray-wall-led.md`, driver `wled`) is unchanged.

## 1. Approach

- **Keep WLED on the controller.** The Gledopto GL-C-015WL-D ships with WLED,
  and its web UI, presets, LED settings, OTA updates and Wi-Fi API all keep
  working. Climbers who share the Spraywall's Wi-Fi keep using the `wled`
  driver.
- **Add one WLED usermod** that exposes a small GATT service with NimBLE. Every
  BLE frame is translated in the usermod into the same WLED JSON state command
  the Wi-Fi driver sends (`deserializeState`), so brightness, the nightlight
  auto-off, segments and "do not sync" behave identically on both paths.
- **A new controller type `wled-ble`** in `@boardsesh/led-controller`. It
  implements `LedControllerDriver` over an injected transport, so the shared
  package has no React Native or Bluetooth dependency. The mobile app registers
  a transport built on `react-native-ble-plx`, the BLE library it already ships,
  so there is no new native module and no app config plugin.

### Relation to issue #7306

[#7306](https://github.com/boardsesh/boardsesh/issues/7306) ("Custom LED
climbing boards — DIY board support through a generic BLE protocol") asks for a
generic, documented BLE protocol for DIY controllers: discovery and connection,
sending climbs (hold ids with colours), clearing, brightness, independent of the
LED chip and microcontroller, with an ESP32 reference implementation. It does
**not** define a GATT service, characteristics or frames (no comments at the time
of writing), so there was nothing concrete to follow.

This protocol is a compatible minimal answer to that request:

| #7306 asks for | Here |
| --- | --- |
| Discovery and connection | Advertised service UUID, info characteristic with name, firmware version, LED count and protocol version |
| Sending climbs (hold ids and colours) | `SET_PIXELS`: LED index ranges + RGB. The app maps holds to LEDs with the Spraywall layout (`buildSprayLedMapping`), so a controller never needs hold ids |
| Clearing the board | `OFF` |
| Brightness | A byte in `LIGHT_ALL`, `PREVIEW_BEGIN`, `WAKE` |
| Independent of LED technology | Nothing in the frames is WLED-specific; WLED is just the first implementation |
| ESP32 reference implementation | The WLED usermod |

Auto-off (WLED's nightlight) is an addition #7306 did not ask for. Any other DIY
firmware can implement the same four characteristics without WLED.

## 2. GATT service

All multi-byte integers are little-endian. UUIDs are random 128-bit values
sharing one base (`7e10xxxx-69ea-4190-8731-75eec7496aed`).

| Role | UUID | Properties | Security |
| --- | --- | --- | --- |
| Service (advertised) | `7e100001-69ea-4190-8731-75eec7496aed` | | |
| Info | `7e100002-69ea-4190-8731-75eec7496aed` | Read | None, so a phone can tell what it found before pairing |
| Control | `7e100003-69ea-4190-8731-75eec7496aed` | Write (with response) | Encrypted + authenticated (MITM): bonded with the passkey |
| Status | `7e100004-69ea-4190-8731-75eec7496aed` | Notify | Encrypted + authenticated |

The controller advertises the service UUID in the advertising packet (128-bit
UUID + flags = 21 of 31 bytes) and its name in the scan response.

### 2.1 Info (read)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Protocol version, `1` |
| 1 | 1 | Flags. Bit 0: the strip is on with brightness > 0 |
| 2 | 2 | LED count (whole cable, `strip.getLengthTotal()`) |
| 4 | 2 | Largest control frame the controller buffers, in bytes |
| 6 | 1 + n | Name: length, then UTF-8 (WLED's "Server description") |
| 7 + n | 1 + m | Firmware version: length, then UTF-8 (WLED's `versionString`) |

Bytes after the version are reserved. A phone that reads a protocol version it
does not know stops before writing anything and shows "update the app or the
controller" (`unsupported-version`). Only the first byte is guaranteed in every
future version.

### 2.2 Control (write with response)

Each write is one complete frame; nothing is reassembled across writes.

```
[protocol version = 1][opcode][sequence][payload…]
```

The sequence is any byte; the status notification echoes it.

| Opcode | Name | Payload | WLED JSON it becomes |
| --- | --- | --- | --- |
| `0x10` | `LIGHT_ALL` | brightness (1–255), auto-off minutes (0 = never) | `{on:true, bri, tt:0, live:false, lor:1, nl, udpn:{nn:true}, seg:[segment 0 over the whole cable, every segment solid white]}` |
| `0x11` | `OFF` | — | `{on:false, tt:0, live:false, udpn:{nn:true}}` |
| `0x12` | `PREVIEW_BEGIN` | brightness | Wake at brightness, nightlight off, segment 0 = whole cable, solid black; other segments off (not deleted) |
| `0x13` | `SET_PIXELS` | runs of 6 bytes: start (u16), count (1–255), r, g, b | `{tt:0, udpn:{nn:true}, seg:[{id:0, i:[start, start+count, "RRGGBB", …]}]}` |
| `0x14` | `AUTO_OFF` | minutes (0 stops it) | `{nl:{on:true, dur, mode:0, tbri:0}}` or `{nl:{on:false}}` |
| `0x15` | `WAKE` | brightness | `{on:true, bri, tt:0, nl:{on:false}, udpn:{nn:true}}` |

These are the operations `LedControllerDriver` needs: `probe` reads Info,
`lightAll` sends `LIGHT_ALL`, `turnOff` sends `OFF` (also "clear"), and a preview
sends `PREVIEW_BEGIN` once, `WAKE` before later updates when auto-off is set,
then `SET_PIXELS` (blacking the previously lit LEDs and colouring the new ones),
then `AUTO_OFF` so the countdown runs from the latest write. That is the same
sequence the Wi-Fi driver sends as JSON.

**Chunking.** A frame never exceeds `min(ATT MTU − 3, info max frame)`. The app
asks for ATT MTU 247 on Android (iOS negotiates by itself) and falls back to the
default 23:

| ATT MTU | Bytes per write | Runs per `SET_PIXELS` |
| --- | --- | --- |
| 23 (default) | 20 | 2 |
| 247 | 244 | 40 |
| 517, controller buffer 512 | 512 | 84 |

Neighbouring LEDs with the same colour share one run, so the two LEDs behind one
hold cost 6 bytes, not 12.

### 2.3 Status (notify)

```
[protocol version = 1][sequence][result][reserved = 0]
```

| Result | Meaning | App error |
| --- | --- | --- |
| 0 | Applied | — |
| 1 | Unsupported protocol version | `unsupported-version` |
| 2 | Malformed frame | `command-failed` |
| 3 | An LED range is past the cable; nothing applied | `invalid-indices` |
| 4 | Busy (queue full) | `command-failed` |
| 5 | Unknown opcode | `command-failed` |

The app waits for the status of each frame before writing the next, so one
phone never has more than one frame in flight. A frame without a status within
3 s is a `timeout`; a failed GATT write is `command-failed`; a failed connect is
`unavailable`.

## 3. Test vectors

Asserted byte for byte in
`packages/shared/led-controller/src/__tests__/wled-ble.test.ts`.

| Frame | Bytes (hex) |
| --- | --- |
| `LIGHT_ALL`, seq 1, brightness 64, auto-off 30 min | `01 10 01 40 1e` |
| `OFF`, seq 2 | `01 11 02` |
| `PREVIEW_BEGIN`, seq 3, brightness 128 | `01 12 03 80` |
| `SET_PIXELS`, seq 4, LEDs 10–11 red, LED 20 green | `01 13 04 0a 00 02 ff 00 00 14 00 01 00 ff 00` |
| `SET_PIXELS`, seq 5, LED 300 blue | `01 13 05 2c 01 01 00 00 ff` |
| `AUTO_OFF`, seq 6, 15 min | `01 14 06 0f` |
| `WAKE`, seq 7, brightness 64 | `01 15 07 40` |
| Status, seq 4, applied | `01 04 00 00` |
| Status, seq 5, out of range | `01 05 03 00` |
| Info: lit, 150 LEDs, buffer 512, "WLED", "0.15.3" | `01 01 96 00 00 02 04 57 4c 45 44 06 30 2e 31 35 2e 33` |

## 4. Security

- **Writes need a bonded phone.** Control and Status require an encrypted,
  authenticated (MITM) link. The usermod sets NimBLE to bonding + MITM + Secure
  Connections with IO capability "display only" and a **static 6-digit
  passkey**. The first time a phone writes, iOS/Android show the system pairing
  dialog and the climber types the passkey. Nothing in the app handles the
  passkey; it never leaves the OS.
- **The passkey is shown in WLED's UI**: Settings → Usermods → Boardsesh BLE,
  next to a "Forget all phones" switch and a "Pairing open" switch. It is
  random on first boot (stored in WLED's `cfg.json`, never all zeros) and can be
  changed there. Anyone who can open WLED's UI on the Wi-Fi can already control
  the LEDs, so this keeps the same trust boundary.
- **New phones only while pairing is open.** "Pairing open" is on for 10 minutes
  after boot and whenever it is switched on in the UI; outside that window the
  usermod refuses to start new pairings, so an already bonded phone keeps working
  but a stranger in range cannot even try passkeys. Up to 4 bonds are kept.
- **Info is public**: name, firmware version, LED count. This is the same data
  WLED's `/json/info` shows to anyone on the Wi-Fi.
- **Bluetooth ids stay on the phone.** iOS gives every phone a different id for
  the same peripheral, so the chosen controller is stored on the phone only
  (`sprayWallLedBleDevice:<wall>`), and erased with the rest of the Spraywall LED
  copy on sign-out or when the wall is withdrawn. The server stores only
  `controller_type = 'wled-ble'`.

Not covered: a hostile device that advertises the same service near the
Spraywall. The worst it can do is receive route colours the phone sends it.

## 5. Sharing, range and coexistence

- **One phone at a time over Bluetooth.** The usermod allows one connection and
  stops advertising while connected. The app drops its link after 60 s without
  writes, so the next climber's phone can connect. Climbers on the Spraywall's
  Wi-Fi keep using the `wled` driver at the same time; both end up as the same
  WLED state changes, and the last write wins, exactly as two Wi-Fi phones do
  today.
- **Every phone picks the controller once**, from the LED section on the edit
  screen ("Find Bluetooth controller"). A phone without a stored controller that
  sends a route looks for one: if exactly one controller advertises the service
  nearby, it uses and remembers it; otherwise lighting fails with the usual
  toast.
- **Range.** BLE indoors through a plastic enclosure is typically 5–15 m with a
  clear line of sight. The Gledopto's antenna is a PCB trace inside a metal-free
  box, so the Spraywall should be in range from the mat; this **needs measuring**.
- **Wi-Fi/BLE coexistence.** The ESP32 shares one 2.4 GHz radio between Wi-Fi and
  BLE by time slicing (ESP-IDF software coexistence). ESP-IDF requires Wi-Fi
  modem sleep while Bluetooth is enabled, and WLED's "Disable WiFi sleep"
  setting (on by default on ESP32) asks for the opposite. The usermod switches
  Wi-Fi sleep back on at start-up and the README tells the builder to untick
  that option; **whether WLED 0.15 then logs or misbehaves needs checking on the
  device.** Expect slightly higher Wi-Fi latency while a phone is connected.
- **Aurora boards.** Kilter, Tension and MoonBoard keep their own adapters and,
  on iOS, their own native Bluetooth manager. The Spraywall transport only uses
  the shared `getBleManager()` for its own device id: it never stops another
  connection, and it scans only when the climber taps "Find Bluetooth
  controller" or when a route needs a controller and none is stored (a few
  seconds). ble-plx has one scan slot, so a Spraywall scan started while the
  board picker is scanning would replace that scan; the two are on different
  screens.

## 6. Memory and flash budget on the GL-C-015WL-D

| Item | Known | Source |
| --- | --- | --- |
| SoC | ESP32 (classic, dual-core 240 MHz), which has BLE 4.2 | Retailer spec pages (see README) |
| Module, flash size, PSRAM | **Unknown**: not published. Most ESP32 WLED controllers carry 4 MB flash and no PSRAM | Needs `esptool.py flash_id` or WLED's Info page |
| Shipped WLED version | **Unknown**: listings say only "WLED pre-installed" | Check Info in the WLED UI |
| Partition layout | **Unknown** for the factory image | Read with `esptool.py read_flash 0x8000 0xc00` |

Estimates, **to be measured**: NimBLE-Arduino adds roughly 200–350 KB of flash
and 40–70 KB of heap (controller + host, one connection). A WLED 0.15 ESP32
build is about 1.3 MB; with WLED's 4 MB layout (two ~1.5 MB app slots) there is
little margin, so the override env drops a few unused features. If the factory
partition table has smaller app slots, OTA will refuse the image and only a USB
flash with WLED's layout works. Heap: WLED shows free heap on its Info page;
keep at least ~40 KB free with the LED count of the Spraywall.

## 7. Files

- `packages/shared/led-controller/src/wled-ble-protocol.ts`: frames, UUIDs.
- `packages/shared/led-controller/src/wled-ble.ts`: the driver and its
  transport interface; `registerWledBleTransport`.
- `packages/mobile/src/lib/spray/spray-led-ble-transport.ts`: the ble-plx
  transport, scan and idle disconnect.
- `packages/mobile/src/lib/spray/spray-wall-led-ble-device.ts`: the phone's
  chosen controller per Spraywall.
- `firmware/wled-usermod-boardsesh-ble/`: the usermod, build override, README.
