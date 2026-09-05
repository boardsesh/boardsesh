// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LED_CONTROLLER_H
#define LED_CONTROLLER_H

#include <Arduino.h>
#include <FastLED.h>

// LED hardware configuration — the single source of truth, resolved from build
// flags at compile time. FastLED needs chipset, data pin, and color order as
// compile-time tokens, so they live here: led_controller.cpp's addLeds<> call
// consumes them, and consumers (e.g. main.cpp logging) include this header and
// read LED_DATA_PIN directly. Override per board variant with -D LED_CHIPSET /
// -D LED_COLOR_ORDER / a *_LED_PIN flag.
#ifndef LED_CHIPSET
#define LED_CHIPSET WS2812B
#endif
#ifndef LED_COLOR_ORDER
#define LED_COLOR_ORDER GRB
#endif

#if defined(TDISPLAY_LED_PIN)
#define LED_DATA_PIN TDISPLAY_LED_PIN
#elif defined(WAVESHARE_LED_PIN)
#define LED_DATA_PIN WAVESHARE_LED_PIN
#elif defined(WAVESHARE_AMOLED_LED_PIN)
#define LED_DATA_PIN WAVESHARE_AMOLED_LED_PIN
#elif defined(GLEDOPTO_LED_PIN)
#define LED_DATA_PIN GLEDOPTO_LED_PIN
#else
#define LED_DATA_PIN 5
#endif

// Some WLED-style controllers gate the LED output V+ terminal behind a
// high-side MOSFET "relay" on a GPIO (WLED's "Relay GPIO"). Define
// LED_POWER_ENABLE_PIN (and optionally LED_POWER_ENABLE_PIN_2) to drive the
// pin(s) HIGH in begin() so the output terminal is energized; without it the
// strip's V+ terminal stays at ~0V. On the GLEDOPTO GL-C-015WL-D the enable
// pin is GPIO18 (active high — verified with a pin sweep on real hardware);
// GLEDOPTO's manual documents GPIO12 for other revisions of the family, so
// the gledopto env drives both. GPIO12 is the ESP32 MTDI strapping pin, so
// it must only be driven high AFTER boot — begin() runs from setup(), which
// is safe; never strap it high in hardware.

#define MAX_LEDS 500

/**
 * LED command structure matching GraphQL LedCommand type.
 *
 * IMPORTANT: This struct is duplicated here and in graphql_types.h.
 * - This copy enables native tests (which can't include Arduino.h from graphql_types.h)
 * - The graphql_types.h copy is auto-generated from the GraphQL schema
 * - Both use LEDCOMMAND_DEFINED include guard to prevent redefinition
 *
 * If fields change, update BOTH:
 *   1. packages/shared-schema/src/schema.ts (source of truth)
 *   2. Run `vp run controller:codegen` to regenerate graphql_types.h
 *   3. Update this struct to match
 */
#ifndef LEDCOMMAND_DEFINED
#define LEDCOMMAND_DEFINED
struct LedCommand {
    int32_t position;
    uint8_t r;
    uint8_t g;
    uint8_t b;
};
#endif

class LedController {
  public:
    LedController();

    // The data pin is the compile-time LED_DATA_PIN (FastLED templates it);
    // begin() only takes the strip length.
    void begin(uint16_t numLeds);

    void setLed(int index, CRGB color);
    void setLed(int index, uint8_t r, uint8_t g, uint8_t b);
    void setLeds(const LedCommand* commands, int count);

    void clear();
    void show();

    void setBrightness(uint8_t brightness);
    uint8_t getBrightness();

    uint16_t getNumLeds();

    // Run quick blink (for feedback)
    void blink(uint8_t r, uint8_t g, uint8_t b, int count = 3, int delayMs = 100);

  private:
    CRGB leds[MAX_LEDS];
    uint16_t numLeds;
    uint8_t brightness;
    bool initialized;
};

extern LedController LEDs;

#endif
