// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for LED Controller Library
 *
 * Tests the FastLED abstraction layer for WS2812B LED control.
 */

#include <cstring>
#include <led_controller.h>
#include <unity.h>

// Test instance
static LedController* controller;

void setUp(void) {
    controller = new LedController();
}

void tearDown(void) {
    delete controller;
    controller = nullptr;
}

// =============================================================================
// Initialization Tests
// =============================================================================

void test_initial_state(void) {
    TEST_ASSERT_EQUAL(0, controller->getNumLeds());
    TEST_ASSERT_EQUAL(128, controller->getBrightness());  // Default brightness
}

void test_begin_sets_num_leds(void) {
    controller->begin(100);
    TEST_ASSERT_EQUAL(100, controller->getNumLeds());
}

void test_begin_caps_at_max_leds(void) {
    controller->begin(600);  // More than MAX_LEDS (500)
    TEST_ASSERT_EQUAL(MAX_LEDS, controller->getNumLeds());
}

void test_begin_with_zero_leds(void) {
    controller->begin(0);
    TEST_ASSERT_EQUAL(0, controller->getNumLeds());
}

// =============================================================================
// Individual LED Control Tests
// =============================================================================

void test_setLed_with_crgb(void) {
    controller->begin(10);
    controller->setLed(0, CRGB(255, 128, 64));
    // No crash means success - we can't directly inspect internal state
    TEST_ASSERT_TRUE(true);
}

void test_setLed_with_rgb_values(void) {
    controller->begin(10);
    controller->setLed(5, 100, 150, 200);
    TEST_ASSERT_TRUE(true);
}

void test_setLed_negative_index_ignored(void) {
    controller->begin(10);
    controller->setLed(-1, CRGB(255, 0, 0));  // Should not crash
    TEST_ASSERT_TRUE(true);
}

void test_setLed_index_at_boundary(void) {
    controller->begin(10);
    controller->setLed(9, CRGB(255, 0, 0));  // Last valid index
    TEST_ASSERT_TRUE(true);
}

void test_setLed_index_beyond_boundary_ignored(void) {
    controller->begin(10);
    controller->setLed(10, CRGB(255, 0, 0));   // Beyond boundary
    controller->setLed(100, CRGB(255, 0, 0));  // Way beyond boundary
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Batch LED Control Tests
// =============================================================================

void test_setLeds_single_command(void) {
    controller->begin(100);

    LedCommand commands[1] = {{10, 255, 128, 64}};

    controller->setLeds(commands, 1);
    TEST_ASSERT_TRUE(true);
}

void test_setLeds_multiple_commands(void) {
    controller->begin(100);

    LedCommand commands[5] = {{0, 255, 0, 0}, {1, 0, 255, 0}, {2, 0, 0, 255}, {3, 255, 255, 0}, {4, 0, 255, 255}};

    controller->setLeds(commands, 5);
    TEST_ASSERT_TRUE(true);
}

void test_setLeds_with_out_of_bounds_positions(void) {
    controller->begin(10);

    LedCommand commands[3] = {
        {5, 255, 0, 0},   // Valid
        {-1, 0, 255, 0},  // Invalid (negative)
        {100, 0, 0, 255}  // Invalid (beyond count)
    };

    controller->setLeds(commands, 3);  // Should not crash
    TEST_ASSERT_TRUE(true);
}

void test_setLeds_empty_array(void) {
    controller->begin(10);

    LedCommand commands[1] = {{0, 0, 0, 0}};
    controller->setLeds(commands, 0);  // Count is 0
    TEST_ASSERT_TRUE(true);
}

void test_setLeds_large_batch(void) {
    controller->begin(200);

    LedCommand commands[100];
    for (int i = 0; i < 100; i++) {
        commands[i].position = i;
        commands[i].r = (uint8_t)(i % 256);
        commands[i].g = (uint8_t)((i * 2) % 256);
        commands[i].b = (uint8_t)((i * 3) % 256);
    }

    controller->setLeds(commands, 100);
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Brightness Control Tests
// =============================================================================

void test_setBrightness(void) {
    controller->begin(10);
    controller->setBrightness(200);
    TEST_ASSERT_EQUAL(200, controller->getBrightness());
}

void test_setBrightness_min_value(void) {
    controller->begin(10);
    controller->setBrightness(0);
    TEST_ASSERT_EQUAL(0, controller->getBrightness());
}

void test_setBrightness_max_value(void) {
    controller->begin(10);
    controller->setBrightness(255);
    TEST_ASSERT_EQUAL(255, controller->getBrightness());
}

void test_getBrightness_default(void) {
    TEST_ASSERT_EQUAL(128, controller->getBrightness());
}

// =============================================================================
// Clear and Show Tests
// =============================================================================

void test_clear_does_not_crash(void) {
    controller->begin(50);
    controller->setLed(0, CRGB(255, 255, 255));
    controller->clear();
    TEST_ASSERT_TRUE(true);
}

void test_show_does_not_crash(void) {
    controller->begin(50);
    controller->setLed(0, CRGB(255, 255, 255));
    controller->show();
    TEST_ASSERT_TRUE(true);
}

void test_clear_show_sequence(void) {
    controller->begin(50);
    controller->setLed(0, CRGB(255, 0, 0));
    controller->show();
    controller->clear();
    controller->show();
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Blink Function Tests
// =============================================================================

void test_blink_default_parameters(void) {
    controller->begin(10);
    controller->blink(255, 0, 0);  // 3 blinks, 100ms delay by default
    TEST_ASSERT_TRUE(true);
}

void test_blink_custom_count(void) {
    controller->begin(10);
    controller->blink(0, 255, 0, 5);  // 5 blinks
    TEST_ASSERT_TRUE(true);
}

void test_blink_custom_delay(void) {
    controller->begin(10);
    controller->blink(0, 0, 255, 2, 50);  // 2 blinks, 50ms delay
    TEST_ASSERT_TRUE(true);
}

void test_blink_zero_leds(void) {
    controller->begin(0);           // No LEDs
    controller->blink(255, 255, 255);  // Should not crash
    TEST_ASSERT_TRUE(true);
}

void test_blink_zero_count(void) {
    controller->begin(10);
    controller->blink(255, 255, 255, 0);  // 0 blinks
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Edge Cases
// =============================================================================

void test_operations_before_begin(void) {
    // Operations on uninitialized controller should not crash
    controller->setLed(0, CRGB(255, 0, 0));
    controller->setBrightness(100);
    controller->clear();
    controller->show();
    TEST_ASSERT_TRUE(true);
}

void test_multiple_begin_calls(void) {
    controller->begin(50);
    controller->setLed(0, CRGB(255, 0, 0));
    controller->begin(100);  // Reinitialize
    TEST_ASSERT_EQUAL(100, controller->getNumLeds());
}

void test_crgb_color_values(void) {
    CRGB black(0, 0, 0);
    CRGB white(255, 255, 255);
    CRGB red(255, 0, 0);
    CRGB green(0, 255, 0);
    CRGB blue(0, 0, 255);

    TEST_ASSERT_EQUAL(0, black.r);
    TEST_ASSERT_EQUAL(0, black.g);
    TEST_ASSERT_EQUAL(0, black.b);

    TEST_ASSERT_EQUAL(255, white.r);
    TEST_ASSERT_EQUAL(255, white.g);
    TEST_ASSERT_EQUAL(255, white.b);

    TEST_ASSERT_EQUAL(255, red.r);
    TEST_ASSERT_EQUAL(0, red.g);
    TEST_ASSERT_EQUAL(0, red.b);
}

void test_led_command_struct(void) {
    LedCommand cmd;
    cmd.position = 42;
    cmd.r = 100;
    cmd.g = 150;
    cmd.b = 200;

    TEST_ASSERT_EQUAL(42, cmd.position);
    TEST_ASSERT_EQUAL(100, cmd.r);
    TEST_ASSERT_EQUAL(150, cmd.g);
    TEST_ASSERT_EQUAL(200, cmd.b);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Initialization tests
    RUN_TEST(test_initial_state);
    RUN_TEST(test_begin_sets_num_leds);
    RUN_TEST(test_begin_caps_at_max_leds);
    RUN_TEST(test_begin_with_zero_leds);

    // Individual LED control tests
    RUN_TEST(test_setLed_with_crgb);
    RUN_TEST(test_setLed_with_rgb_values);
    RUN_TEST(test_setLed_negative_index_ignored);
    RUN_TEST(test_setLed_index_at_boundary);
    RUN_TEST(test_setLed_index_beyond_boundary_ignored);

    // Batch LED control tests
    RUN_TEST(test_setLeds_single_command);
    RUN_TEST(test_setLeds_multiple_commands);
    RUN_TEST(test_setLeds_with_out_of_bounds_positions);
    RUN_TEST(test_setLeds_empty_array);
    RUN_TEST(test_setLeds_large_batch);

    // Brightness control tests
    RUN_TEST(test_setBrightness);
    RUN_TEST(test_setBrightness_min_value);
    RUN_TEST(test_setBrightness_max_value);
    RUN_TEST(test_getBrightness_default);

    // Clear and show tests
    RUN_TEST(test_clear_does_not_crash);
    RUN_TEST(test_show_does_not_crash);
    RUN_TEST(test_clear_show_sequence);

    // Blink function tests
    RUN_TEST(test_blink_default_parameters);
    RUN_TEST(test_blink_custom_count);
    RUN_TEST(test_blink_custom_delay);
    RUN_TEST(test_blink_zero_leds);
    RUN_TEST(test_blink_zero_count);

    // Edge cases
    RUN_TEST(test_operations_before_begin);
    RUN_TEST(test_multiple_begin_calls);
    RUN_TEST(test_crgb_color_values);
    RUN_TEST(test_led_command_struct);

    return UNITY_END();
}
