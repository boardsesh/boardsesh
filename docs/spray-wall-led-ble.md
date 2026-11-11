# Spraywall LEDs over Bluetooth (BLE)

Status: **app side implemented and unit tested; firmware builds but has not run
on a Spraywall yet.** Bluetooth changes need a Fable review before merge.

This is the second way the app lights a Spraywall: straight from the phone to
the controller over Bluetooth Low Energy, with no Wi-Fi network shared between
them. The Wi-Fi path (`docs/spray-wall-led.md`, controller type `wled`) is
unchanged.

## 1. Approach: reuse what already exists

Nothing new on the wire. The phone speaks to the Spraywall controller exactly as
it speaks to a Kilter or Tension board:

| Piece | Reused from |
| --- | --- |
| Frames | Aurora API v3 (`packages/shared/ble-protocol/src/aurora.ts`): `wrapBytes` framing with checksum, commands `T` (only) / `R` (first) / `Q` (middle) / `S` (last), 3 bytes per LED (16-bit position, one 3-3-2 colour byte) |
| Transport | Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`, write characteristic `6e400002-…`, chunked with `effectiveChunkSizeForMtu` + `splitMessages` (`transport.ts`) |
| Clear | The empty `T` message, `01 01 ab 02 54 03`: the same packet `getAuroraBluetoothPacket('')` sends a Kilter board |
| Firmware | `embedded/projects/board-controller`, env `gledopto-c015-spraywall`: the existing GL-C-015WL-D firmware (NimBLE Nordic UART server, Aurora decoder, FastLED), verified on that hardware for Kilter strings |

The only new encoder is `getAuroraV3LedPacket(leds)` in `aurora.ts`: the same
packing as `getAuroraBluetoothPacket`, but taking LED positions and RGB
directly, because a Spraywall has no Aurora placements. The app maps holds to
LEDs with the Spraywall layout (`buildSprayLedMapping`), and the Aurora
position **is** the LED index on the string.

The controller type is `ble` (`@boardsesh/led-controller`, `src/ble.ts`). It
implements `LedControllerDriver` over an injected transport, so the shared
package has no React Native dependency; the app registers a transport built on
`react-native-ble-plx`, the BLE library it already ships. No new native module
or config plugin.

### Relation to issue #7306

[#7306](https://github.com/boardsesh/boardsesh/issues/7306) asks for a generic
BLE protocol for DIY boards (discovery, sending climbs, clearing, brightness,
an ESP32 reference firmware) but defines no frames. This answers it by
reusing the Aurora v3 protocol any DIY controller can implement, with the
board-controller firmware as the ESP32 reference.

## 2. Operations

| `LedControllerDriver` | Bluetooth |
| --- | --- |
| `probe` | Connect and find the Nordic UART write characteristic. Name = the advertised name. The protocol reports no LED count or version (`ledCount: 0`) |
| preview `show(indices, colours)` | One Aurora v3 packet with every LED to light; it replaces what was lit, as on a Kilter board, so nothing is blanked first |
| `lightAll` | White on positions 0–499 (the firmware's `MAX_LEDS`); positions past the string are ignored by the firmware |
| `turnOff` / clear | The empty packet |

Writes are with response, chunk by chunk (MTU 247 asked for on Android, chunks
clamp to 244 bytes; 20 bytes at the default MTU). A write that fails is
`command-failed`, one that is not acknowledged in 3 s is `timeout`, a failed
connect is `unavailable`.

### Brightness and auto-off: no protocol extension

Aurora frames carry no brightness or timer, and none was added. The firmware
keeps its own:

- **Brightness**: the existing "LED Brightness" on the controller's setup page
  (`brightness` in NVS, applied at boot: save, then restart).
- **Auto-off**: the `gledopto-c015-spraywall` build turns the string off 30
  minutes after the last climb arrived (`-D SPRAYWALL_AUTO_OFF_MINUTES=30`, 0
  disables). Small new code in `main.cpp`, flagged here as the one behaviour the
  Kilter build does not have.

For a Bluetooth Spraywall the app hides its brightness slider and auto-off
choice and says the controller keeps its own.

## 3. Test vectors

Asserted byte for byte in `packages/shared/ble-protocol/src/__tests__/aurora.test.ts`
and `packages/shared/led-controller/src/__tests__/ble.test.ts`.

| Packet | Bytes (hex) |
| --- | --- |
| Clear (empty `T`) | `01 01 ab 02 54 03` |
| LED 0 white | `01 04 ac 02 54 00 00 ff 03` |
| LED 300 blue | `01 04 7b 02 54 2c 01 03 03` |
| LEDs 10–11 red, LED 20 green | `01 0a a6 02 54 0a 00 e0 0b 00 e0 14 00 1c 03` |
| LED 11 blue | `01 04 9d 02 54 0b 00 03 03` |
| 85 LEDs | `R` message with 84 LEDs (body 253 bytes), then `S` with one |

Framing: `[0x01][body length][checksum][0x02][body][0x03]`, checksum =
`(sum of body bytes & 0xff) ^ 0xff`, body = command byte + LEDs, ≤ 255 bytes.
Colour byte = `RRRGGGBB` (`r >> 5`, `g >> 5`, `b >> 6`).

## 4. Advertising and the board pickers

The Spraywall build advertises **`Boardsesh Spraywall XXXX`** (the last two MAC
bytes) and **no service UUID**: neither the Aurora service
`4488b571-…` nor Nordic UART (which stays in GATT). Its name has no
`#serial@api` suffix. So:

- Aurora pickers and the quickstart (`isLikelyBoardDevice`, scan family
  `aurora`) need the Aurora service UUID, an Aurora board name or a
  `#serial@N` suffix: none match.
- MoonBoard pickers accept Nordic UART in the advertisement or a
  MoonBoard/Woods name: none match. On iOS the native MoonBoard scan filters
  on UART/RedBearLab UUIDs, which the controller does not advertise.
- `parseAnyBoardTypeFromDeviceName` returns nothing for the name.

Tests pin this in `board-device-filter.test.ts`, `quickstart-scan-device.test.ts`
and `advertised-identity.test.ts`. The Spraywall scan (`Find Bluetooth
controller`) is unfiltered and keeps names starting with
`SPRAY_LED_CONTROLLER_NAME_PREFIX`, the way the pickers match Kilter-built boxes
by name.

## 5. No pairing

Any phone in range can connect and light the Spraywall, as with a Kilter board in
a gym. The Nordic UART characteristics need no encryption, and there is no
bond, passkey or token. Over Bluetooth there is only LED lighting; the
controller's settings, Wi-Fi and firmware updates stay on its own setup page
(its Wi-Fi access point or the Spraywall's Wi-Fi) or the USB cable.

One phone at a time: the firmware stops advertising while a phone is connected
and starts again when it leaves. The app lets go after 60 s without writes, so
the next climber's phone can connect. Climbers on the Wi-Fi path are unaffected.

Bluetooth ids stay on the phone (iOS gives every phone a different id for the
same peripheral): `sprayWallLedBleDevice:<wall>`, erased with the rest of the
Spraywall LED copy. The server stores only `controller_type = 'ble'`
(`controller_type` is text, so no migration). A phone with no stored controller
that sends a climb uses the only controller advertising nearby and remembers
it; with none or several, lighting fails with the usual toast.

## 6. No Wi-Fi network

The Kilter build starts Bluetooth only once Wi-Fi has connected. The Spraywall
build starts it **at boot**, whatever Wi-Fi does:

- **No saved Wi-Fi**: the firmware opens its setup access point
  `Boardsesh-Setup` (open, captive portal to the setup page at 192.168.4.1) and
  keeps it up. Bluetooth runs beside it on the shared 2.4 GHz radio (ESP-IDF
  software coexistence).
- **Saved Wi-Fi that is gone**: it keeps retrying the saved network and does
  not open the access point by itself (current board-controller behaviour);
  Bluetooth still works. To reach the setup page then, clear Wi-Fi over USB or
  bring the network back.
- **Recommended for a Bluetooth-only gym**: leave Wi-Fi unconfigured. Setup,
  brightness and firmware updates (`/api/firmware/upload` on the setup page)
  then go through `Boardsesh-Setup` or the USB cable. The access point is open,
  as the Kilter build's is; anyone who joins it can reach the setup page.

## 7. Range, sharing, coexistence with boards

- Range: BLE indoors is typically 5–15 m; **needs measuring** on the Spraywall.
- Kilter/Tension/MoonBoard connections are untouched: the Spraywall transport uses
  the shared `getBleManager()` only for its own device id and never stops
  another connection. ble-plx has one scan slot, so a Spraywall scan started
  while a board picker is scanning would replace that scan; they live on
  different screens.

## 8. Files

- `packages/shared/ble-protocol/src/aurora.ts`: `getAuroraV3LedPacket`.
- `packages/shared/ble-protocol/src/advertised-identity.ts`:
  `SPRAY_LED_CONTROLLER_NAME_PREFIX`, `isSprayLedControllerName`.
- `packages/shared/led-controller/src/ble.ts`: the `ble` driver.
- `packages/mobile/src/lib/spray/spray-led-ble-transport.ts` (+ `-loader.ts`):
  the ble-plx transport, name scan and idle disconnect, loaded only for a
  Bluetooth Spraywall.
- `packages/mobile/src/lib/spray/spray-wall-led-ble-device.ts`: the phone's
  chosen controller per Spraywall.
- `embedded/projects/board-controller` env `gledopto-c015-spraywall`, and the
  `advertiseAuroraService` option in `embedded/libs/nordic-uart-ble`.
