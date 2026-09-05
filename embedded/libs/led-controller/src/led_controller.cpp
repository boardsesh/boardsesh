// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "led_controller.h"

// LED_CHIPSET / LED_DATA_PIN / LED_COLOR_ORDER are resolved from build flags in
// led_controller.h (the single source of truth).

LedController LEDs;

LedController::LedController() : numLeds(0), brightness(128), initialized(false) {
    memset(leds, 0, sizeof(leds));
}

void LedController::begin(uint16_t count) {
    numLeds = min(count, (uint16_t)MAX_LEDS);

#ifdef LED_POWER_ENABLE_PIN
    // Energize the gated LED output V+ terminal (see led_controller.h).
    pinMode(LED_POWER_ENABLE_PIN, OUTPUT);
    digitalWrite(LED_POWER_ENABLE_PIN, HIGH);
#endif
#ifdef LED_POWER_ENABLE_PIN_2
    pinMode(LED_POWER_ENABLE_PIN_2, OUTPUT);
    digitalWrite(LED_POWER_ENABLE_PIN_2, HIGH);
#endif

    // FastLED.addLeds requires compile-time constants; chipset, pin, and color
    // order are resolved from build flags in led_controller.h.
    FastLED.addLeds<LED_CHIPSET, LED_DATA_PIN, LED_COLOR_ORDER>(leds, numLeds);

    FastLED.setBrightness(brightness);

    clear();
    show();

    initialized = true;
}

void LedController::setLed(int index, CRGB color) {
    if (index >= 0 && index < numLeds) {
        leds[index] = color;
    }
}

void LedController::setLed(int index, uint8_t r, uint8_t g, uint8_t b) {
    setLed(index, CRGB(r, g, b));
}

void LedController::setLeds(const LedCommand* commands, int count) {
    for (int i = 0; i < count; i++) {
        if (commands[i].position >= 0 && commands[i].position < numLeds) {
            leds[commands[i].position] = CRGB(commands[i].r, commands[i].g, commands[i].b);
        }
    }
}

void LedController::clear() {
    FastLED.clear();
}

void LedController::show() {
    FastLED.show();
}

void LedController::setBrightness(uint8_t b) {
    brightness = b;
    FastLED.setBrightness(brightness);
}

uint8_t LedController::getBrightness() {
    return brightness;
}

uint16_t LedController::getNumLeds() {
    return numLeds;
}

void LedController::blink(uint8_t r, uint8_t g, uint8_t b, int count, int delayMs) {
    for (int i = 0; i < count; i++) {
        for (int j = 0; j < numLeds; j++) {
            leds[j] = CRGB(r, g, b);
        }
        show();
        delay(delayMs);
        clear();
        show();
        delay(delayMs);
    }
}
