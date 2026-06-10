# Embedded Architecture

This document describes the ESP32 firmware that powers BoardSesh's physical board controllers. The firmware provides BLE communication with climbing boards, real-time backend sync via WebSocket, a captive portal for device setup, and optional display support for queue navigation.

## Directory Structure

```
embedded/
├── libs/                          # Shared PlatformIO libraries
│   ├── aurora-protocol/           # Kilter/Tension BLE protocol codec
│   ├── ble-proxy/                 # BLE proxy for app↔board forwarding
│   ├── board-data/                # Generated board images & hold mappings
│   ├── climb-history/             # Circular buffer for recent climbs (NVS)
│   ├── config-manager/            # NVS key-value persistence wrapper
│   ├── display-base/              # Abstract base class for display drivers
│   ├── display-ui/                # Shared UI components (grades, QR, colors)
│   ├── esp-web-server/            # HTTP config server & captive portal
│   ├── graphql-types/             # Auto-generated C++ types from GraphQL schema
│   ├── graphql-ws-client/         # WebSocket GraphQL subscriptions client
│   ├── led-controller/            # FastLED abstraction for WS2812B LEDs
│   ├── lilygo-display/            # LilyGo T-Display-S3 driver (170x320)
│   ├── log-buffer/                # Ring buffer logger (2KB)
│   ├── nordic-uart-ble/           # BLE GATT server (Nordic UART Service)
│   ├── waveshare-display/         # Waveshare 7" touch driver (480x800)
│   └── wifi-utils/                # WiFi manager with AP mode & auto-reconnect
├── projects/
│   └── board-controller/          # Main firmware project
│       ├── src/
│       │   ├── main.cpp           # Entry point & state machine
│       │   └── config/            # Board-specific defaults
│       └── platformio.ini         # Build environments & variants
├── test/                          # Native unit tests (no hardware)
│   ├── lib/mocks/                 # Hardware API mocks (Arduino, BLE, WiFi, etc.)
│   └── test_*/                    # Test suites per library
└── scripts/
    ├── prebuild.py                # Triggers codegen before build
    ├── generate-graphql-types.mjs # GraphQL schema → C++ header
    └── generate-board-data.mjs    # Board image & hold data codegen
```

## Build Variants

The project uses PlatformIO with multiple build environments defined in `embedded/projects/board-controller/platformio.ini`:

| Environment        | Target Hardware         | Display     | BLE Proxy | Board Image |
| ------------------ | ----------------------- | ----------- | --------- | ----------- |
| `esp32s3dev`       | ESP32-S3 DevKit         | No          | No        | No          |
| `esp32s3dev-proxy` | ESP32-S3 DevKit         | No          | Yes       | No          |
| `tdisplay-s3`      | LilyGo T-Display-S3     | 170x320 LCD | Yes       | No          |
| `waveshare-7inch`  | Waveshare 7" Touch LCD  | 480x800 RGB | Yes       | Yes         |
| `esp32dev`         | Original ESP32 (legacy) | No          | No        | No          |

Feature flags are controlled via build defines: `ENABLE_BLE_PROXY`, `ENABLE_DISPLAY`, `ENABLE_WAVESHARE_DISPLAY`, `ENABLE_BOARD_IMAGE`.

## Operating Modes

### Direct Mode (Default)

The ESP32 acts as a drop-in board controller:

1. Exposes a BLE GATT server (Nordic UART Service) compatible with official Kilter/Tension apps
2. Receives LED commands from the app via BLE and drives WS2812B LEDs directly
3. Optionally forwards BLE LED data to the BoardSesh backend for climb identification

### Proxy Mode

The ESP32 bridges between the official app and an existing board:

1. Acts as a BLE server (appears as "Kilter Boardsesh" to the app)
2. Acts as a BLE client connected to the actual climbing board
3. Forwards all BLE traffic bidirectionally between app and board
4. Additionally syncs with the BoardSesh backend via WebSocket

The proxy's state machine:

```
DISABLED → IDLE → SCANNING → CONNECTING → CONNECTED
                                  ↑              ↓
                                  └── RECONNECTING
```

## Captive Portal & WiFi Setup

When no WiFi credentials are stored (first boot or after reset), the device enters AP mode:

1. Creates a WiFi access point named "Boardsesh-Setup"
2. Starts a DNS server that redirects all requests to `192.168.4.1`
3. Serves a configuration web page via the built-in HTTP server
4. User connects to the AP, gets redirected to the setup page, and enters WiFi credentials
5. On successful connection, credentials are persisted to NVS and the device reconnects automatically on future boots

The web server (`esp-web-server`) provides these endpoints in both AP and station modes:

| Endpoint                | Method   | Purpose                    |
| ----------------------- | -------- | -------------------------- |
| `/`                     | GET      | Configuration web page     |
| `/api/config`           | GET/POST | Read/write device settings |
| `/api/wifi/scan`        | GET      | Scan available networks    |
| `/api/wifi/connect`     | POST     | Connect to a WiFi network  |
| `/api/wifi/status`      | GET      | Current connection state   |
| `/api/restart`          | POST     | Reboot the device          |
| `/api/firmware/version` | GET      | Current firmware version   |
| `/api/firmware/upload`  | POST     | OTA firmware update        |

## Settings Screen (Waveshare Display)

The Waveshare 7" touch display includes an interactive settings screen accessible via a touch gesture from the main climb view. The settings screen displays:

- **Current WiFi SSID** and IP address
- **Reset WiFi** button — clears stored credentials and restarts in AP mode for reconfiguration
- **BLE Proxy toggle** — enables/disables proxy mode with immediate effect

Settings changes are persisted to NVS via `ConfigManager`. On the LilyGo display (which lacks touch), a long press (3s) on Button 1 performs a full configuration reset instead.

## Configuration Persistence

All device settings are stored in ESP32 NVS (Non-Volatile Storage) via the `ConfigManager` class, which wraps the ESP32 `Preferences` API under the `"boardsesh"` namespace.

Key stored values:

| Key            | Type   | Purpose                       |
| -------------- | ------ | ----------------------------- |
| `wifi_ssid`    | String | WiFi network name             |
| `wifi_pass`    | String | WiFi password                 |
| `backend_host` | String | GraphQL WebSocket server host |
| `backend_port` | Int    | Server port                   |
| `backend_path` | String | Server path                   |
| `api_key`      | String | Authentication key            |
| `session_id`   | String | BoardSesh session ID          |
| `backend_sync` | Bool   | Enable optional session sync  |
| `render_base_url` | String | Web app host for rendered previews |
| `preview_board_name` | String | Local BLE preview board name |
| `preview_layout_id` | Int | Local BLE preview layout ID |
| `preview_size_id` | Int | Local BLE preview size ID |
| `preview_set_ids` | String | Local BLE preview hold set IDs |
| `proxy_en`     | Bool   | BLE proxy enabled             |
| `proxy_mac`    | String | Target board MAC address      |
| `brightness`   | Int    | LED brightness                |
| `disp_br`      | Int    | Display brightness            |

All setter methods (`setString`, `setBool`, `setInt`, `setBytes`) return `bool` indicating whether the write succeeded, allowing callers to detect and log persistence failures.

## Backend Integration

The device connects to the BoardSesh backend via a WebSocket GraphQL subscription (`graphql-ws-client`):

1. **Connection**: When `backend_sync` is enabled, establishes WebSocket to the configured backend with API key in `connection_init`
2. **Subscription**: Subscribes to `controllerEvents` for the configured session ID
3. **Events received**:
   - `LedUpdate` — LED commands, climb metadata, navigation context
   - `ControllerQueueSync` — Full queue state (up to 150 items with current index)
   - `ControllerPing` — Keepalive
4. **Mutations sent**:
   - `navigateQueue` — Queue navigation (previous/next) triggered by touch or buttons
   - `sendLedPositions` — Forward BLE-received LED data for climb identification

Navigation mutations are debounced (100ms) to coalesce rapid button presses into a single backend call. The display updates optimistically while the mutation is in flight.

## Display Architecture

Display support uses an abstract base class (`DisplayBase`) with multiple concrete implementations:

### LilyGo T-Display-S3 (170x320)

- Parallel 8-bit interface via LovyanGFX
- Layout: status bar, climb info, QR code, navigation indicator, history
- Input: 2 physical buttons (GPIO 0 & GPIO 14) with debouncing

### Waveshare 7" Touch (480x800)

- RGB bus interface with bounce buffer for DMA transfers
- GT911 capacitive touch via I2C with CH422G IO expander
- All LilyGo features plus: touch navigation, settings screen, board image rendering
- Board image: JPEG decoded to PSRAM sprite with LED hold overlay

### Waveshare 2.1" AMOLED (480x480)

- SPI/QSPI AMOLED display for the portable debug controller
- Uses the web app board thumbnail endpoint instead of local hold rendering
- BLE payloads are decoded on-device and rendered directly with the local preview board config (`preview_board_name`, `preview_layout_id`, `preview_size_id`, `preview_set_ids`)
- The web route accepts compact `led_positions` data and uses `@boardsesh/board-constants` placement data to convert LED positions into renderable frames
- The firmware fetches `https://www.boardsesh.com/api/internal/board-render?...&thumbnail=1&include_background=1&format=jpg` and displays the JPEG from PSRAM
- `render_base_url` should point at the web app host (`https://www.boardsesh.com`)
- Backend/session sync is optional; when enabled, `backend_host` should point at the GraphQL WebSocket host (`ws.boardsesh.com`)

Display implementations share common state management in `DisplayBase`:

- Current climb (name, grade, color, angle)
- Queue state (local copy of 150 items, current index)
- Navigation context (previous/next climb previews)
- Climb history (last 5 climbs)
- Status indicators (WiFi, BLE, backend connection)
- QR code (session URL, Version 6)

## Memory Budget

| Component          | Size      | Notes                                     |
| ------------------ | --------- | ----------------------------------------- |
| Queue buffer       | ~13 KB    | 150 items x ~88 bytes (static allocation) |
| Log buffer         | 2 KB      | Circular ring buffer                      |
| Climb history      | ~1 KB     | 5 entries                                 |
| QR code            | 211 bytes | 41x41 module grid                         |
| Board image sprite | ~768 KB   | PSRAM only (Waveshare)                    |

## Testing

Native unit tests run on the host machine without hardware, using mock implementations of Arduino, BLE, WiFi, and other ESP32 APIs. Test suites exist for all core libraries.

Run tests from `embedded/test/`:

```bash
pio test -e native
```

## Code Generation

The prebuild script (`scripts/prebuild.py`) runs before each firmware build:

1. **GraphQL types**: Converts `packages/shared-schema/src/schema.ts` into `libs/graphql-types/src/graphql_types.h`
2. **Board data** (if `ENABLE_BOARD_IMAGE`): Generates board images and hold position mappings from the web package's database into `libs/board-data/src/board_hold_data.h`
