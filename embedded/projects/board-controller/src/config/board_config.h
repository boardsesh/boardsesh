// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
// Match the Aurora/Kilter board name format so the official app discovers this
// debug controller as a test board.
#define BLE_DEVICE_NAME "Kilter Board#123456@3"

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
