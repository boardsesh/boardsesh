// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "led_controller.h"

// Global instance
LedController ledController;

LedController::LedController()
    : leds(nullptr), numLeds(0), ledPin(DEFAULT_LED_PIN),
      brightness(DEFAULT_BRIGHTNESS), initialized(false) {}

bool LedController::begin(int pin, int count) {
    // Use provided values or load from config
    ledPin = (pin >= 0) ? pin : configManager.getLedPin();
    numLeds = (count > 0) ? count : configManager.getLedCount();
    brightness = configManager.getBrightness();

    // Validate
    if (numLeds <= 0 || numLeds > MAX_LED_COUNT) {
        Serial.printf("[LED] Invalid LED count: %d (max: %d)\n", numLeds, MAX_LED_COUNT);
        numLeds = DEFAULT_LED_COUNT;
    }

    Serial.printf("[LED] Initializing %d LEDs on pin %d\n", numLeds, ledPin);

    initStrip();
    return initialized;
}

void LedController::initStrip() {
    // Free existing array if any
    if (leds != nullptr) {
        delete[] leds;
    }

    // Allocate new array
    leds = new CRGB[numLeds];

    // Initialize FastLED
    // Note: We use a template-based approach, but pin must be known at compile time
    // For dynamic pin, we'd need a switch statement or use the non-template API
    FastLED.addLeds<LED_TYPE, DEFAULT_LED_PIN, LED_COLOR_ORDER>(leds, numLeds);
    FastLED.setBrightness(brightness);

    // Clear all LEDs
    clear();
    show();

    initialized = true;
    Serial.println("[LED] LED strip initialized");
}

void LedController::updateConfig(int pin, int count) {
    bool needsReinit = false;

    if (pin != ledPin && pin >= 0) {
        ledPin = pin;
        configManager.setLedPin(pin);
        needsReinit = true;
    }

    if (count != numLeds && count > 0 && count <= MAX_LED_COUNT) {
        numLeds = count;
        configManager.setLedCount(count);
        needsReinit = true;
    }

    if (needsReinit && initialized) {
        Serial.println("[LED] Configuration changed, reinitializing...");
        initStrip();
    }
}

void LedController::clear() {
    if (!initialized || leds == nullptr) return;

    for (int i = 0; i < numLeds; i++) {
        leds[i] = CRGB::Black;
    }
}

void LedController::setLed(int position, uint8_t r, uint8_t g, uint8_t b) {
    if (!initialized || leds == nullptr) return;

    if (position >= 0 && position < numLeds) {
        leds[position] = CRGB(r, g, b);
    }
}

void LedController::setLeds(const LedCommand* commands, int count) {
    if (!initialized || leds == nullptr) return;

    // Clear first
    clear();

    // Set specified LEDs
    for (int i = 0; i < count; i++) {
        const LedCommand& cmd = commands[i];
        if (cmd.position >= 0 && cmd.position < numLeds) {
            leds[cmd.position] = CRGB(cmd.r, cmd.g, cmd.b);
        }
    }
}

void LedController::show() {
    if (!initialized) return;
    FastLED.show();
}

void LedController::setBrightness(uint8_t b) {
    brightness = b;
    FastLED.setBrightness(brightness);
    configManager.setBrightness(brightness);
}

uint8_t LedController::getBrightness() {
    return brightness;
}

void LedController::testPattern() {
    if (!initialized || leds == nullptr) return;

    Serial.println("[LED] Running test pattern...");

    // Red sweep
    Serial.println("[LED] Red sweep...");
    for (int i = 0; i < min(50, numLeds); i++) {
        clear();
        leds[i] = CRGB::Red;
        show();
        delay(30);
    }

    // All green
    Serial.println("[LED] All green...");
    for (int i = 0; i < numLeds; i++) {
        leds[i] = CRGB::Green;
    }
    show();
    delay(500);

    // All blue
    Serial.println("[LED] All blue...");
    for (int i = 0; i < numLeds; i++) {
        leds[i] = CRGB::Blue;
    }
    show();
    delay(500);

    // Rainbow
    Serial.println("[LED] Rainbow...");
    for (int i = 0; i < numLeds; i++) {
        leds[i] = CHSV((i * 255 / numLeds), 255, 255);
    }
    show();
    delay(1000);

    // Clear
    clear();
    show();
    Serial.println("[LED] Test complete");
}

void LedController::blink(uint8_t r, uint8_t g, uint8_t b, int count, int delayMs) {
    if (!initialized || leds == nullptr) return;

    for (int i = 0; i < count; i++) {
        // On
        for (int j = 0; j < numLeds; j++) {
            leds[j] = CRGB(r, g, b);
        }
        show();
        delay(delayMs);

        // Off
        clear();
        show();
        delay(delayMs);
    }
}

int LedController::getLedCount() {
    return numLeds;
}

int LedController::getLedPin() {
    return ledPin;
}

bool LedController::isInitialized() {
    return initialized;
}
