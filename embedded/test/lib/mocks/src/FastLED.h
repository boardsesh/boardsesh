// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * FastLED Mock Header for Native Unit Testing
 *
 * Provides minimal CRGB and FastLED implementations for testing
 * LED controller code without actual hardware.
 */

#ifndef FASTLED_MOCK_H
#define FASTLED_MOCK_H

#include <cstdint>
#include <cstring>

// LED types (not used in mock but needed for compilation)
#define WS2812B 0
#define WS2811 1
#define WS2812 2
#define NEOPIXEL 3
#define GRB 0
#define RGB 1

/**
 * Mock CRGB color structure
 */
struct CRGB {
    union {
        struct {
            uint8_t b;
            uint8_t g;
            uint8_t r;
        };
        uint8_t raw[3];
    };

    CRGB() : b(0), g(0), r(0) {}
    CRGB(uint8_t red, uint8_t green, uint8_t blue) : b(blue), g(green), r(red) {}
    CRGB(uint32_t colorcode) {
        r = (colorcode >> 16) & 0xFF;
        g = (colorcode >> 8) & 0xFF;
        b = colorcode & 0xFF;
    }

    CRGB& operator=(const CRGB& rhs) {
        r = rhs.r;
        g = rhs.g;
        b = rhs.b;
        return *this;
    }

    bool operator==(const CRGB& rhs) const { return r == rhs.r && g == rhs.g && b == rhs.b; }

    bool operator!=(const CRGB& rhs) const { return !(*this == rhs); }

    // Common colors
    static const CRGB Black;
    static const CRGB White;
    static const CRGB Red;
    static const CRGB Green;
    static const CRGB Blue;
};

/**
 * Mock FastLED controller class
 */
class CFastLED {
  public:
    CFastLED() : brightness_(255), numLeds_(0), leds_(nullptr) {}

    // Template method to add LEDs - stores reference for later
    template <uint8_t DATA_PIN> static CRGB* addLeds(CRGB* data, int nLeds) {
        instance().leds_ = data;
        instance().numLeds_ = nLeds;
        return data;
    }

    // Overload with LED type template params
    template <uint8_t CHIPSET, uint8_t DATA_PIN, uint8_t COLOR_ORDER> static CRGB* addLeds(CRGB* data, int nLeds) {
        instance().leds_ = data;
        instance().numLeds_ = nLeds;
        return data;
    }

    static void setBrightness(uint8_t brightness) { instance().brightness_ = brightness; }

    static uint8_t getBrightness() { return instance().brightness_; }

    static void show() {
        // Mock - does nothing in tests
    }

    static void clear() {
        if (instance().leds_ && instance().numLeds_ > 0) {
            memset(instance().leds_, 0, instance().numLeds_ * sizeof(CRGB));
        }
    }

    static CFastLED& instance() {
        static CFastLED inst;
        return inst;
    }

    // For test inspection
    static CRGB* getLeds() { return instance().leds_; }
    static int getNumLeds() { return instance().numLeds_; }

  private:
    uint8_t brightness_;
    int numLeds_;
    CRGB* leds_;
};

// Global FastLED instance
extern CFastLED FastLED;

#endif  // FASTLED_MOCK_H
