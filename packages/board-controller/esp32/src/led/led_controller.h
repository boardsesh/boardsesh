// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LED_CONTROLLER_H
#define LED_CONTROLLER_H

#include <Arduino.h>
#include <FastLED.h>
#include "../config/board_config.h"
#include "../config/config_manager.h"

// Maximum supported LEDs
#define MAX_LED_COUNT 500

/**
 * LED command structure matching GraphQL LedCommand type
 */
struct LedCommand {
    int position;
    uint8_t r;
    uint8_t g;
    uint8_t b;
};

/**
 * LED Controller
 * Controls WS2811 LEDs via FastLED library
 */
class LedController {
public:
    LedController();

    // Initialize LED strip
    bool begin(int pin = -1, int numLeds = -1);

    // Update configuration (reinitializes if changed)
    void updateConfig(int pin, int numLeds);

    // Clear all LEDs
    void clear();

    // Set a single LED
    void setLed(int position, uint8_t r, uint8_t g, uint8_t b);

    // Set multiple LEDs from command array
    void setLeds(const LedCommand* commands, int count);

    // Update the LED strip (show changes)
    void show();

    // Set global brightness (0-255)
    void setBrightness(uint8_t brightness);

    // Get current brightness
    uint8_t getBrightness();

    // Run test pattern
    void testPattern();

    // Run quick blink (for feedback)
    void blink(uint8_t r, uint8_t g, uint8_t b, int count = 3, int delayMs = 100);

    // Get LED count
    int getLedCount();

    // Get LED pin
    int getLedPin();

    // Check if initialized
    bool isInitialized();

private:
    CRGB* leds;
    int numLeds;
    int ledPin;
    uint8_t brightness;
    bool initialized;

    // Internal initialization
    void initStrip();
};

// Global LED controller instance
extern LedController ledController;

#endif // LED_CONTROLLER_H
