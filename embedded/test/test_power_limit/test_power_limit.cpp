/**
 * Unit Tests for the Spraywall current cap (led-controller power_limit.h).
 *
 * The estimate: each pixel draws perPixel mA at full white, proportionally less
 * for dimmer colours, all scaled by the master brightness.
 */

#include <power_limit.h>
#include <unity.h>

#include <vector>

void setUp(void) {}
void tearDown(void) {}

static std::vector<uint8_t> whitePixels(size_t count, uint8_t level = 255) {
    return std::vector<uint8_t>(count * 3, level);
}

void test_channel_sum_adds_every_channel(void) {
    const uint8_t pixels[] = {255, 0, 0, 0, 255, 0, 1, 2, 3};
    TEST_ASSERT_EQUAL_UINT64(516, PowerLimit::channelSum(pixels, 3));
    TEST_ASSERT_EQUAL_UINT64(0, PowerLimit::channelSum(pixels, 0));
}

void test_estimate_full_white_at_full_brightness(void) {
    std::vector<uint8_t> white = whitePixels(100);
    uint64_t channels = PowerLimit::channelSum(white.data(), 100);
    // 100 pixels x 60 mA.
    TEST_ASSERT_EQUAL_UINT32(6000, PowerLimit::estimateMilliamps(channels, 60, 255));
    // Half brightness, about half the draw.
    TEST_ASSERT_UINT32_WITHIN(30, 3000, PowerLimit::estimateMilliamps(channels, 60, 128));
}

void test_estimate_counts_colour_channels_separately(void) {
    // One pure red pixel draws a third of full white.
    const uint8_t red[] = {255, 0, 0};
    TEST_ASSERT_EQUAL_UINT32(20, PowerLimit::estimateMilliamps(PowerLimit::channelSum(red, 1), 60, 255));
}

void test_frame_within_the_cap_keeps_its_brightness(void) {
    std::vector<uint8_t> white = whitePixels(50);
    uint64_t channels = PowerLimit::channelSum(white.data(), 50);
    // 50 x 60 mA x 128/255 = ~1506 mA < 5000 mA.
    TEST_ASSERT_EQUAL_UINT8(128, PowerLimit::limitBrightness(channels, 60, 128, 5000));
}

void test_light_all_on_500_pixels_is_dimmed_under_the_cap(void) {
    std::vector<uint8_t> white = whitePixels(500);
    uint64_t channels = PowerLimit::channelSum(white.data(), 500);
    // 500 x 60 mA = 30 A at full brightness; brightness 128 is still ~15 A.
    uint8_t shown = PowerLimit::limitBrightness(channels, 60, 128, 5000);
    TEST_ASSERT_TRUE(shown < 128);
    TEST_ASSERT_TRUE(PowerLimit::estimateMilliamps(channels, 60, shown) <= 5000);
    // The highest brightness that fits: one step up would not.
    TEST_ASSERT_TRUE(PowerLimit::estimateMilliamps(channels, 60, shown + 1) > 5000);
}

void test_no_cap_means_unchanged(void) {
    std::vector<uint8_t> white = whitePixels(500);
    uint64_t channels = PowerLimit::channelSum(white.data(), 500);
    TEST_ASSERT_EQUAL_UINT8(200, PowerLimit::limitBrightness(channels, 60, 200, 0));
    TEST_ASSERT_EQUAL_UINT8(200, PowerLimit::limitBrightness(0, 60, 200, 5000));
}

void test_a_tiny_cap_can_dim_to_off(void) {
    std::vector<uint8_t> white = whitePixels(500);
    uint64_t channels = PowerLimit::channelSum(white.data(), 500);
    TEST_ASSERT_EQUAL_UINT8(0, PowerLimit::limitBrightness(channels, 60, 255, 1));
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_channel_sum_adds_every_channel);
    RUN_TEST(test_estimate_full_white_at_full_brightness);
    RUN_TEST(test_estimate_counts_colour_channels_separately);
    RUN_TEST(test_frame_within_the_cap_keeps_its_brightness);
    RUN_TEST(test_light_all_on_500_pixels_is_dimmed_under_the_cap);
    RUN_TEST(test_no_cap_means_unchanged);
    RUN_TEST(test_a_tiny_cap_can_dim_to_off);
    return UNITY_END();
}
