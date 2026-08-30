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
vp run moonboard:build          # Build moonboard-dev-server
vp run moonboard:upload         # Flash moonboard-dev-server
vp run moonboard:monitor        # Serial monitor for moonboard-dev-server
vp run controller:format        # Format all C++ code
vp run controller:format:check  # Check C++ formatting
```
