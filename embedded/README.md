# Embedded Firmware

This directory contains ESP32 firmware projects and shared libraries for Boardsesh hardware controllers.

## Structure

```
embedded/
├── libs/                          # Shared PlatformIO libraries
│   ├── aurora-protocol/           # Kilter/Tension BLE protocol decoder
│   ├── moonboard-protocol/        # MoonBoard BLE ASCII protocol decoder
│   ├── led-controller/            # FastLED abstraction
│   ├── config-manager/            # NVS persistence
│   ├── log-buffer/                # Ring buffer logging
│   ├── wifi-utils/                # WiFi connection wrapper
│   ├── graphql-ws-client/         # WebSocket client
│   ├── nordic-uart-ble/           # BLE GATT server (Nordic UART Service)
│   ├── moonboard-uart-ble/        # BLE GATT server for MoonBoard UART payloads
│   └── esp-web-server/            # HTTP configuration server
│
└── projects/
    ├── board-controller/          # Main firmware for LED board control
    └── moonboard-dev-server/      # MoonBoard BLE controller + local preview UI
```

## Development Setup

### Prerequisites

- [PlatformIO](https://platformio.org/) (install via VS Code extension or CLI)
- ESP32 development board (ESP32-S3 recommended)

### Building

```bash
cd embedded/projects/board-controller
pio run
```

### Flashing

```bash
cd embedded/projects/board-controller
pio run -t upload
```

### Monitoring Serial Output

```bash
cd embedded/projects/board-controller
pio device monitor
```

## Shared Libraries

Libraries in `libs/` are shared across firmware projects using PlatformIO's symlink feature. Each project references them in `platformio.ini`:

```ini
lib_deps =
    aurora-protocol=symlink://../../libs/aurora-protocol
    led-controller=symlink://../../libs/led-controller
    ; ... etc
```

### Library Structure

Each library follows PlatformIO conventions:

```
libs/my-library/
├── library.json          # Library manifest
└── src/
    ├── my_library.h      # Public header
    └── my_library.cpp    # Implementation
```

## Projects

### board-controller

Main firmware for controlling Kilter/Tension climbing board LEDs. Features:

- **BLE Server**: Exposes Nordic UART Service for direct board control
- **Aurora Protocol**: Decodes Kilter/Tension BLE commands
- **LED Control**: Drives addressable LEDs via FastLED
- **WiFi Connectivity**: Connects to backend for party mode
- **GraphQL-WS Client**: Real-time sync with Boardsesh backend
- **Web Config**: HTTP server for WiFi and device setup

#### Build variants

`board-controller` builds for several boards via PlatformIO envs (see
`projects/board-controller/platformio.ini`): `esp32s3dev` (default),
`esp32s3dev-proxy`, `tdisplay-s3`, `waveshare-7inch`, `waveshare-amoled-216`,
`esp32dev` (legacy), and **`gledopto-c015`** (below).

#### Waveshare 2.16-inch AMOLED variant

`waveshare-amoled-216` targets the ESP32-S3-Touch-AMOLED-2.16 (480×480).
Its current platform requires **pioarduino Core 6.2 or newer**; system
PlatformIO 6.1.19 fails with `IncompatiblePlatform`.
The controller accepts and previews climbs over Bluetooth without WiFi setup.
WiFi remains available for configuration and optional backend sync.

Capture the display over USB from the repo root:

```bash
vp run controller:screenshot --port /dev/cu.usbmodem101 --output /tmp/preview.png
```

The task uses `uv` with pinned `pyserial==3.5`. Close any serial monitor before
capturing. Pass flags directly as shown: a standalone `--` is forwarded literally
by `vp` and breaks argument parsing.

At 115200 baud, the serial commands `display-status` and `screenshot` return
preview diagnostics and the tagged RGB565 screen stream, respectively. The
capture task converts that stream into a PNG. It captures the logical framebuffer;
physical orientation or electrical display faults still need a photo or a check
of the panel itself.

#### Production QA gym fixture

`waveshare-amoled-gym` is a separate firmware target for a gym with one to three
simulated boards. It fetches the gym's current serials, layouts, JPEGs and exact
LED-position maps at startup. Kilter, Tension and MoonBoard advertise independent
connectable identities concurrently; each connection has its own protocol parser.
The legacy controller and proxy targets keep their existing BLE configuration.

The latest complete Bluetooth send selects its board automatically. Short presses
of GPIO18/KEY advance through the boards; a short PWR press selects the previous
board. Long PWR behavior and the reset button are preserved. Each board retains
its latest preview during the current boot; previews start empty after reboot.

Use the existing local settings page to choose a gym link, slug or UUID and enter
the registered controller key. Keys are write-only in the fixture configuration
API. Settings changes restart the device and fetch the selected gym. Validated
configuration and assets support an offline boot with a visible saved-gym status.
Explicit access rejection stops the advertisements and remains effective across
an offline reboot.

The fixture reserves only the blank tail at `0xF20000` for its cache. It verifies
the partition and every byte before first initialization, never formats existing
factory storage, and commits complete asset generations atomically. Back up the
connected device before changing firmware or its partition table.

```sh
vp run controller:build -e waveshare-amoled-gym
vp run controller:upload -e waveshare-amoled-gym --upload-port /dev/cu.usbmodem2101
vp run controller:screenshot --port /dev/cu.usbmodem2101 --output /tmp/gym-preview.png
vp run controller:fixture:test --sanitize
```

USB commands `fixture-status`, `fixture-next`, `fixture-prev` and
`fixture-refresh` support diagnostics without changing BLE connections merely to
browse a preview. `fixture-config <JSON>` supports private USB setup using
`fixture_gym_ref`, `fixture_endpoint`, `fixture_api_key`, and optional `wifi_ssid`
and `wifi_password`; it saves settings and restarts without echoing secrets.

The local two-phone runner uses a separate, memory-only USB QA protocol:

```text
fixture-qa {"action":"status","requestId":"inspect"}
fixture-qa {"action":"start","requestId":"start-1","runId":"local-run-1"}
fixture-qa {"action":"status","requestId":"poll-1","runId":"local-run-1"}
fixture-qa {"action":"drop","requestId":"drop-1","runId":"local-run-1","boardUuid":"<fixture-board-uuid>"}
fixture-qa {"action":"end","requestId":"end-1","runId":"local-run-1"}
```

Each reply is one `BOARDSESH_QA `-prefixed JSON line with `schemaVersion: 1`,
the request ID, `ok`, an optional `error`, a per-boot ID, firmware build identity,
the owning run ID, the active `policy`, and `leaseRemainingMs`. `boards` contains
UUIDs, active writer handles, counters, latest completed sequence and writer
generation, angle, and decoded `{position,r,g,b}` commands sorted by position
then RGB. The decoded payload remains available after the display consumes it;
an incomplete packet never replaces it. Complete tagged replies are built before
one HWCDC enqueue. The gym target disables NimBLE console logs because IDF's
secondary USB console can otherwise write the same FIFO during deferred HWCDC
transmission; a stdout lock does not protect that later drain. Short writes and
exceptional console output still fail the strict host parser. No keys, WiFi settings or phone addresses
are included. Request IDs contain 1–80 letters, digits, dots, hyphens or underscores;
run IDs use the same bounds without dots.

Starting requires an active fixture with zero existing Bluetooth connections.
During QA, a newer central evicts older centrals only for that simulated board;
old handles lose write permission before disconnection. `drop` targets one board
and is owner-only. A matching status request renews the 30-second lease. Status
without a run ID is read-only and does not renew a lease; another run cannot
renew, end or drop it. Ending, lease expiry, reset or firmware reconfiguration
restores the normal concurrent connection policy without changing persisted
configuration or cached gym data. End/expiry do not disconnect the current links.
The radio still has three total connection slots; this two-phone mode does not
establish stock-controller takeover behavior or a fourth-connection guarantee.

Keep DTR asserted and RTS released before opening USB to avoid resetting the
device. Keep one serial owner; screenshot capture must share that owner's port
or wait until the QA run releases it.

`waveshare-amoled-gym-proof` is an explicit hardware feasibility build with three
synthetic identities and connection-specific echo probes. It does not fetch or
represent production gym data. Complete its discovery, simultaneous connection
and routing checks before production provisioning. See
[the production QA gym runbook](../docs/prod-qa-gym.md) for release order,
idempotent provisioning and credential handling.

#### GLEDOPTO GL-C-015WL-D variant

`gledopto-c015` targets the [GLEDOPTO GL-C-015WL-D](https://gledopto.com/h-pd-125.html) —
a cheap WLED-style controller (classic ESP32, 4 MB flash, DC 5–24 V in) used as a
standalone LED driver for a Kilter board. No display, no proxy; it decodes climbs
over BLE (the board appears to the Kilter app as `Kilter Board#123456@3`) and via
party-mode GraphQL, then lights the string.

**Wiring** (verified with a 12 V WS2811 pixel string; 3 wires: V+/GND/data):

- **Data** → the controller's **`IO16`** output terminal (the middle pin of output
  group 1 — order is `V+ | IO16 | GND`). This is GPIO16, which the firmware drives.
- **Power**: the strip's V+/GND can run off the controller's output terminals
  (rated 10 A per channel / 15 A total). The output `V+` is **gated behind a
  high-side MOSFET on GPIO18** (active high — found by a pin sweep on real
  hardware; GLEDOPTO's manual documents GPIO12 for other revisions of the
  family). The firmware drives both high at boot (`-D LED_POWER_ENABLE_PIN=18`,
  `-D LED_POWER_ENABLE_PIN_2=12`), so the terminal carries the input voltage
  once the controller has started. Older firmware builds never drove the enable
  pin and the output `V+` read ~0 V — reflash if you see that. For strings that
  draw more than the terminal rating, run V+/GND straight from the PSU to the
  strip instead.
- **Tie all grounds common** — PSU `−` ↔ controller `GND` ↔ strip `GND`. The data
  line needs a shared ground reference or nothing lights, even with power present.
  (Automatic when the strip is powered from the controller's own terminals.)
- USB-C powers only the ESP32 (flashing/serial); it never powers the LED rail.

**Chipset / color order** are build flags, defaulting to `WS2811` / `RGB` (both
verified on the Setter-Closet 12 V string). They're consumed by
`libs/led-controller/src/led_controller.cpp`. If a different string looks wrong,
adjust in `platformio.ini`:

- Red/green swapped → `-D LED_COLOR_ORDER=GRB`.
- Nothing lights (and power/ground are confirmed good) → try `-D GLEDOPTO_LED_PIN=2`
  (the "D2"/`IO2` output).
- Flicker / wrong pixels → `-D LED_CHIPSET=WS2812B`.
- String length → `-D NUM_LEDS=<n>` (default 200, max 500).

**Spraywall LED controller** (`gledopto-c015-spraywall`): the same hardware and
firmware, built for the Boardsesh app's Bluetooth Spraywall lighting
(`docs/spray-wall-led-ble.md`). It extends `gledopto-c015` with
`-D SPRAYWALL_LED_CONTROLLER=1`, which:

- advertises `Boardsesh Spraywall XXXX` (last two bytes of the Bluetooth MAC) with no Aurora
  service UUID, so the Kilter app and Boardsesh's board pickers never list it;
  the Nordic UART service and Aurora v3 decoder are unchanged, and the app sends
  LED indices as Aurora positions;
- starts Bluetooth at boot, with or without Wi-Fi (the setup AP
  `Boardsesh-Setup` opens beside it when no Wi-Fi is saved);
- turns the string off 30 minutes after the last climb
  (`-D SPRAYWALL_AUTO_OFF_MINUTES=<n>`, 0 never);
- disconnects a phone that has not written for 90 s
  (`-D SPRAYWALL_IDLE_DISCONNECT_SECONDS=<n>`), so one idle phone cannot hold it;
- applies every frame in `loop()` (one task writes the strip; nordic-uart-ble's
  `setFrameCallback`), where the Kilter builds still show it on the NimBLE task;
- sets `NUM_LEDS=500` (the library's `MAX_LEDS`).

No pairing: any phone in range can light it, like a Kilter board. Brightness is
the setup page's "LED Brightness" (applied after a restart).

**Current limit** (Spraywall build, set at build time). The controller cannot
measure its supply, so every frame's draw is estimated before it is shown
(`sum((r+g+b)/765 × per-pixel mA) × brightness/255`, `libs/led-controller/src/power_limit.h`)
and the brightness scaled down until it fits. Two flags in the
`gledopto-c015-spraywall` env of `platformio.ini`:

| Flag | Default | Meaning |
| --- | --- | --- |
| `SPRAYWALL_MAX_CURRENT_MA` | `5000` | The most the string may draw, in mA |
| `SPRAYWALL_PIXEL_FULL_WHITE_MA` | `60` | What one pixel (node) draws at full white, in mA |

The defaults are the safe worst case: a 5 A budget and 5 V WS2812B pixels
(3 × 20 mA each). Choose both from the supply and the strip's datasheet, and
never above the controller: **10 A per output, 15 A in total**.

| String | Per pixel at full white | Example settings |
| --- | --- | --- |
| 5 V WS2812B, 5 V 10 A supply | ~60 mA | `MAX_CURRENT_MA=9000`, `PIXEL_FULL_WHITE_MA=60` (keep a margin under 10 A) |
| 12 V WS2811, 3 LEDs per node | ~20 mA | `MAX_CURRENT_MA=8000`, `PIXEL_FULL_WHITE_MA=20` |
| 24 V WS2811 / WS2814, one node per segment | ~12–20 mA (datasheet) | `MAX_CURRENT_MA=6000`, `PIXEL_FULL_WHITE_MA=15` |

A higher voltage moves the same light with less current, which is why 12 V and
24 V pixels draw fewer mA. Changing either value means rebuilding and
reflashing. The setup page's status (`/api/status`) shows the values built in
(`led_max_current_ma`, `led_pixel_full_white_ma`), the last estimate
(`led_estimated_ma`) and whether the cap dimmed it (`led_power_limited`); the
serial log says so too. The startup animation's all-blue flash is capped as well.
The Kilter builds have no cap (`show()` is unchanged).

**Back up the factory firmware before flashing.** Connect the controller's
USB/UART port and read the whole 4 MB flash with PlatformIO's bundled esptool
(replace `COM5` with the controller's port; `/dev/ttyUSB0` on Linux):

```sh
pio pkg exec --package platformio/tool-esptoolpy -- esptool.py --chip esp32 --port COM5 --baud 460800 read_flash 0 0x400000 gledopto-backup.bin
```

Keep `gledopto-backup.bin`. It brings the controller back exactly as it was:

```sh
pio pkg exec --package platformio/tool-esptoolpy -- esptool.py --chip esp32 --port COM5 --baud 460800 write_flash 0 gledopto-backup.bin
```

**Going back to WLED.** This firmware replaces WLED: a controller running it
works over Bluetooth only, not with the app's Wi-Fi (WLED) controller type. To
return to WLED, flash the backup above, or official WLED: the web installer at
<https://install.wled.me> (Chrome or Edge, over USB) or an ESP32 image from
<https://github.com/wled/WLED/releases>. Then, in WLED's **Config → LED
Preferences**:

- LED output **data GPIO 16**;
- **Relay GPIO 18**, active high (leave "Invert" unticked): it switches the output
  V+ MOSFET, so without it the strip gets no power. GPIO 12 on other revisions
  of the family, per GLEDOPTO's manual;
- set the LED count, chipset (WS2811/WS2812B) and colour order of the string, and
  WLED's own current limiter.


**Bench-supply tip:** if the supply reads its set voltage at the input but the LEDs
are dead, check the current limit isn't clamped near 0 A (that collapses the output
to ~0.2 V), and that barrel polarity is center-positive.

**Build & flash** (over the controller's USB/UART download port):

```bash
cd embedded/projects/board-controller
pio run -e gledopto-c015              # build
pio run -e gledopto-c015 -t upload   # flash
pio device monitor                   # serial (confirms "LED_PIN = 16" + startup blink)
```

### moonboard-dev-server

Development firmware for MoonBoard BLE decoding and browser-based previewing. Features:

- **MoonBoard BLE UART**: Accepts MoonBoard app payloads over Nordic UART
- **MoonBoard Protocol**: Parses `l#...#` ASCII payloads into LEDs + Boardsesh frames
- **Headless Preview UI**: Local page at `/moonboard` with layout and set selection
- **Remote Renderer Integration**: Reloads preview images from `www.boardsesh.com/api/internal/board-render`

## Adding a New Project

1. Create directory: `mkdir -p projects/my-project/{src,data,test,scripts}`
2. Create `platformio.ini` with shared library references
3. Create `src/main.cpp`
4. Build: `pio run`

## Code Formatting

This project uses [clang-format](https://clang.llvm.org/docs/ClangFormat.html) for consistent C++ code formatting. The configuration is in `.clang-format`.

### Prerequisites

Install clang-format:

```bash
# macOS
brew install clang-format

# Ubuntu/Debian
sudo apt install clang-format

# Windows (via LLVM)
choco install llvm
```

### Format Code

```bash
# Format all C++ files in-place
vp run controller:format

# Check formatting without modifying (useful for CI)
vp run controller:format:check
```

### Editor Integration

Most editors support clang-format:

- **VS Code**: Install the "C/C++" or "Clang-Format" extension
- **PlatformIO IDE**: Uses clang-format automatically when configured
- **CLion**: Built-in support (Settings > Editor > Code Style > C/C++ > Set from... > ClangFormat)

## Convenience Scripts (from repo root)

```bash
vp run controller:build         # Build board-controller
vp run controller:upload        # Flash board-controller
vp run controller:monitor       # Serial monitor
vp run controller:screenshot --port /dev/cu.usbmodem101 --output /tmp/preview.png
vp run moonboard:build          # Build moonboard-dev-server
vp run moonboard:upload         # Flash moonboard-dev-server
vp run moonboard:monitor        # Serial monitor for moonboard-dev-server
vp run controller:format        # Format all C++ code
vp run controller:format:check  # Check C++ formatting
```
