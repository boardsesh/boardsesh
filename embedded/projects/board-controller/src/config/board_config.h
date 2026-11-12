#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

#include "version.h"

// Device identification
#define DEVICE_NAME "Boardsesh Controller"

// LED configuration.
// The data pin, chipset, and color order are single-sourced from the
// led-controller library (LED_DATA_PIN / LED_CHIPSET / LED_COLOR_ORDER in
// led_controller.h, resolved from build flags per board variant — see the
// *_LED_PIN / LED_CHIPSET / LED_COLOR_ORDER flags there). Consumers include
// led_controller.h and read LED_DATA_PIN directly.

// Number of LEDs on the string. Override per variant with -D NUM_LEDS=<n>.
#ifndef NUM_LEDS
#define NUM_LEDS 200
#endif

// Default brightness (0-255)
#define DEFAULT_BRIGHTNESS 128

// Button configuration (T-Display-S3 built-in buttons)
// Waveshare uses touch instead of physical buttons, and GPIO14 is an RGB data pin
#if defined(ENABLE_DISPLAY) && !defined(ENABLE_WAVESHARE_DISPLAY)
#define BUTTON_1_PIN 0   // GPIO0 - Boot button
#define BUTTON_2_PIN 14  // GPIO14 - User button
#endif

// BLE configuration
#ifdef SPRAYWALL_LED_CONTROLLER
// Spraywall LED controller (env gledopto-c015-spraywall): the Boardsesh app
// drives it with the same Aurora API v3 frames over Nordic UART, but it must
// never pass for a Kilter board. It advertises this prefix plus the last two
// MAC bytes ("Boardsesh Spraywall 1A2B"), no Aurora service UUID and no
// "#serial@api" suffix. Lockstep with SPRAY_LED_CONTROLLER_NAME_PREFIX in
// packages/shared/ble-protocol/src/advertised-identity.ts.
#define BLE_DEVICE_NAME_PREFIX "Boardsesh Spraywall"
// Turn the string off this many minutes after the last climb arrived (0: never).
#ifndef SPRAYWALL_AUTO_OFF_MINUTES
#define SPRAYWALL_AUTO_OFF_MINUTES 30
#endif
// Current cap, set at build time (platformio.ini, env gledopto-c015-spraywall):
// the most the supply may deliver, and what one pixel draws at full white. The
// board cannot measure its supply. The defaults are the safe worst case, 5 A
// and 60 mA (5 V WS2812B); whoever builds for a 12 V / 24 V string raises them
// from its datasheet. The GL-C-015WL-D carries 10 A per output, 15 A in total.
#ifndef SPRAYWALL_MAX_CURRENT_MA
#define SPRAYWALL_MAX_CURRENT_MA 5000
#endif
#ifndef SPRAYWALL_PIXEL_FULL_WHITE_MA
#define SPRAYWALL_PIXEL_FULL_WHITE_MA 60
#endif
#else
// Match the Aurora/Kilter board name format so the official app discovers this
// debug controller as a test board.
#define BLE_DEVICE_NAME "Kilter Board#123456@3"
#endif

// Backend configuration (defaults)
#define DEFAULT_BACKEND_HOST "ws.boardsesh.com"
#define DEFAULT_BACKEND_PORT 443
#define DEFAULT_BACKEND_PATH "/graphql"
#ifndef DEFAULT_RENDER_BASE_URL
#define DEFAULT_RENDER_BASE_URL "https://www.boardsesh.com"
#endif

// Local BLE preview configuration for the 2.1" debug controller.
// These values can be overridden from the ESP32 configuration page.
#define DEFAULT_PREVIEW_BOARD_NAME "kilter"
#define DEFAULT_PREVIEW_LAYOUT_ID 8
#define DEFAULT_PREVIEW_SIZE_ID 25
#define DEFAULT_PREVIEW_SET_IDS "26,27,28,29"

// Web server
#define WEB_SERVER_PORT 80

// Debug options
#define DEBUG_SERIAL true
#define DEBUG_BLE true

#endif
