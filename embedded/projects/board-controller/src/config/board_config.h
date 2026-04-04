#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

#include "version.h"

// Device identification
#define DEVICE_NAME "Boardsesh Controller"

// LED configuration
// Note: GPIO 5 conflicts with LCD_RST on T-Display-S3
// Use TDISPLAY_LED_PIN or WAVESHARE_LED_PIN build flag to override for display builds
#ifdef TDISPLAY_LED_PIN
#define LED_PIN TDISPLAY_LED_PIN
#elif defined(WAVESHARE_LED_PIN)
#define LED_PIN WAVESHARE_LED_PIN
#else
#define LED_PIN 5  // GPIO pin for LED data (default for non-display builds)
#endif
#define NUM_LEDS 200      // Total number of LEDs
#define LED_TYPE WS2812B  // LED strip type
#define COLOR_ORDER GRB   // Color order

// Default brightness (0-255)
#define DEFAULT_BRIGHTNESS 128

// Button configuration (T-Display-S3 built-in buttons)
// Waveshare uses touch instead of physical buttons, and GPIO14 is an RGB data pin
#if defined(ENABLE_DISPLAY) && !defined(ENABLE_WAVESHARE_DISPLAY)
#define BUTTON_1_PIN 0   // GPIO0 - Boot button
#define BUTTON_2_PIN 14  // GPIO14 - User button
#endif

// BLE configuration
#define BLE_DEVICE_NAME "Kilter Boardsesh"

// Backend configuration (defaults)
#define DEFAULT_BACKEND_HOST "ws.boardsesh.com"
#define DEFAULT_BACKEND_PORT 443
#define DEFAULT_BACKEND_PATH "/graphql"

// Web server
#define WEB_SERVER_PORT 80

// Debug options
#define DEBUG_SERIAL true
#define DEBUG_BLE true

#endif
