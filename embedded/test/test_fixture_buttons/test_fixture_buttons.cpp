#include "../../projects/board-controller/src/gym/buttons.h"
#include <unity.h>

using gym_fixture::FixtureButtons;

void setUp() {
    Wire = {};
    Wire.registers[3] = 0x4A;
    fixtureClockMs = 0;
    fixturePinLevel = 1;
    fixtureConfiguredPin = -1;
}
void tearDown() {}

static int at(FixtureButtons& buttons, uint32_t time, int level) {
    fixtureClockMs = time;
    fixturePinLevel = level;
    return buttons.poll();
}

void test_short_release_debounce_and_no_repeat() {
    FixtureButtons buttons;
    TEST_ASSERT_TRUE(buttons.begin());
    TEST_ASSERT_EQUAL(18, fixtureConfiguredPin);
    TEST_ASSERT_EQUAL(0, at(buttons, 100, 0));
    TEST_ASSERT_EQUAL(0, at(buttons, 110, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 140, 1)); // Contact bounce is not a press.
    TEST_ASSERT_EQUAL(0, at(buttons, 200, 0));
    TEST_ASSERT_EQUAL(0, at(buttons, 230, 0));
    TEST_ASSERT_EQUAL(0, at(buttons, 300, 1));
    TEST_ASSERT_EQUAL(1, at(buttons, 330, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 400, 1));
}

void test_long_and_boot_held_keys_do_not_navigate() {
    fixturePinLevel = 0;
    FixtureButtons buttons;
    TEST_ASSERT_TRUE(buttons.begin());
    TEST_ASSERT_EQUAL(0, at(buttons, 100, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 130, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 200, 0));
    TEST_ASSERT_EQUAL(0, at(buttons, 230, 0));
    TEST_ASSERT_EQUAL(0, at(buttons, 1000, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 1030, 1));
}

void test_pmu_preserves_unrelated_register_bits() {
    Wire.registers[0x41] = 0xA4;
    Wire.registers[0x49] = 0xFC;
    FixtureButtons buttons;
    TEST_ASSERT_TRUE(buttons.begin());
    TEST_ASSERT_EQUAL_HEX8(0xAC, Wire.registers[0x41]);
    TEST_ASSERT_EQUAL_HEX8(0xF4, Wire.registers[0x49]);
    Wire.registers[0x49] |= 8;
    TEST_ASSERT_EQUAL(-1, at(buttons, 50, 1));
    TEST_ASSERT_EQUAL(0, at(buttons, 100, 1));
    TEST_ASSERT_EQUAL_HEX8(0xF4, Wire.registers[0x49]);
    TEST_ASSERT_EQUAL_HEX8(0x34, Wire.chip);
    for (const auto& write : Wire.writes) {
        TEST_ASSERT_TRUE(write.first == 0x41 || (write.first == 0x49 && write.second == 8));
    }
}

void test_simultaneous_events_and_failed_ack_are_retained() {
    FixtureButtons buttons;
    TEST_ASSERT_TRUE(buttons.begin());
    at(buttons, 100, 0);
    at(buttons, 130, 0);
    at(buttons, 200, 1);
    Wire.registers[0x49] = 8;
    TEST_ASSERT_EQUAL(1, at(buttons, 230, 1));
    Wire.failWrites = true;
    TEST_ASSERT_EQUAL(0, at(buttons, 250, 1));
    TEST_ASSERT_EQUAL_HEX8(8, Wire.registers[0x49]);
    Wire.failWrites = false;
    TEST_ASSERT_EQUAL(-1, at(buttons, 300, 1));
}

void test_bad_pmu_identity_never_writes_and_gpio_still_works() {
    Wire.registers[3] = 0;
    FixtureButtons buttons;
    TEST_ASSERT_FALSE(buttons.begin());
    TEST_ASSERT_TRUE(Wire.writes.empty());
    at(buttons, 100, 0);
    at(buttons, 130, 0);
    at(buttons, 200, 1);
    TEST_ASSERT_EQUAL(1, at(buttons, 230, 1));
}

void test_gpio_timestamps_survive_millis_wrap() {
    FixtureButtons buttons;
    TEST_ASSERT_TRUE(buttons.begin());
    at(buttons, UINT32_MAX - 100, 0);
    at(buttons, UINT32_MAX - 70, 0);
    at(buttons, 20, 1);
    TEST_ASSERT_EQUAL(1, at(buttons, 50, 1));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_short_release_debounce_and_no_repeat);
    RUN_TEST(test_long_and_boot_held_keys_do_not_navigate);
    RUN_TEST(test_pmu_preserves_unrelated_register_bits);
    RUN_TEST(test_simultaneous_events_and_failed_ack_are_retained);
    RUN_TEST(test_bad_pmu_identity_never_writes_and_gpio_still_works);
    RUN_TEST(test_gpio_timestamps_survive_millis_wrap);
    return UNITY_END();
}
