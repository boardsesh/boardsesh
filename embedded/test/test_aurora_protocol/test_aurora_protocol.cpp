// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for Aurora Protocol Library
 *
 * Tests the BLE protocol decoder for Kilter/Tension board communication.
 * Covers frame parsing, checksum validation, V2/V3 LED decoding, and
 * multi-packet message handling.
 */

#include <aurora_protocol.h>
#include <cstring>
#include <unity.h>

// Test instance - use a fresh instance for each test
static AuroraProtocol* protocol;

void setUp(void) {
    protocol = new AuroraProtocol();
}

void tearDown(void) {
    delete protocol;
    protocol = nullptr;
}

// =============================================================================
// colorToRole Tests
// =============================================================================

void test_colorToRole_green_returns_starting(void) {
    // Pure green (0, 255, 0) -> STARTING hold
    uint8_t role = colorToRole(0, 255, 0);
    TEST_ASSERT_EQUAL_UINT8(ROLE_STARTING, role);
}

void test_colorToRole_cyan_returns_hand(void) {
    // Cyan (0, 255, 255) -> HAND hold
    uint8_t role = colorToRole(0, 255, 255);
    TEST_ASSERT_EQUAL_UINT8(ROLE_HAND, role);
}

void test_colorToRole_magenta_returns_finish(void) {
    // Magenta (255, 0, 255) -> FINISH hold
    uint8_t role = colorToRole(255, 0, 255);
    TEST_ASSERT_EQUAL_UINT8(ROLE_FINISH, role);
}

void test_colorToRole_orange_returns_foot(void) {
    // Orange/Yellow (255, 170, 0) -> FOOT hold
    uint8_t role = colorToRole(255, 170, 0);
    TEST_ASSERT_EQUAL_UINT8(ROLE_FOOT, role);
}

void test_colorToRole_black_returns_unknown(void) {
    // Black (0, 0, 0) -> UNKNOWN
    uint8_t role = colorToRole(0, 0, 0);
    TEST_ASSERT_EQUAL_UINT8(ROLE_UNKNOWN, role);
}

void test_colorToRole_white_returns_unknown(void) {
    // White (255, 255, 255) -> UNKNOWN (all channels high)
    uint8_t role = colorToRole(255, 255, 255);
    TEST_ASSERT_EQUAL_UINT8(ROLE_UNKNOWN, role);
}

void test_colorToRole_threshold_boundary_low(void) {
    // Just below threshold (127) - should not trigger
    uint8_t role = colorToRole(0, 127, 0);
    TEST_ASSERT_EQUAL_UINT8(ROLE_UNKNOWN, role);
}

void test_colorToRole_threshold_boundary_high(void) {
    // Just above threshold (128) - should trigger green
    uint8_t role = colorToRole(0, 128, 0);
    TEST_ASSERT_EQUAL_UINT8(ROLE_STARTING, role);
}

// =============================================================================
// Clear and State Tests
// =============================================================================

void test_clear_resets_state(void) {
    // Add some data first
    uint8_t dummyData[] = {0x01, 0x02, 0x03};
    protocol->addData(dummyData, sizeof(dummyData));

    // Clear should reset
    protocol->clear();

    // LEDs should be empty
    const auto& leds = protocol->getLedCommands();
    TEST_ASSERT_EQUAL(0, leds.size());

    // Angle should be reset
    TEST_ASSERT_EQUAL_INT(0, protocol->getAngle());
}

void test_initial_state_empty(void) {
    const auto& leds = protocol->getLedCommands();
    TEST_ASSERT_EQUAL(0, leds.size());
    TEST_ASSERT_EQUAL_INT(0, protocol->getAngle());
}

// =============================================================================
// Frame Parsing Tests
// =============================================================================

/**
 * Helper to build a valid Aurora protocol frame
 * Frame format: [SOH, length, checksum, STX, command, ...data..., ETX]
 */
static std::vector<uint8_t> buildFrame(uint8_t command, const uint8_t* data, size_t dataLen) {
    std::vector<uint8_t> frame;

    // Calculate total data length (command + data)
    uint8_t contentLen = 1 + dataLen;

    // Calculate checksum over command + data
    uint8_t checksum = command;
    for (size_t i = 0; i < dataLen; i++) {
        checksum = (checksum + data[i]) & 0xFF;
    }
    checksum ^= 0xFF;

    frame.push_back(FRAME_SOH);   // Start of header
    frame.push_back(contentLen);  // Length
    frame.push_back(checksum);    // Checksum
    frame.push_back(FRAME_STX);   // Start of text
    frame.push_back(command);     // Command byte

    for (size_t i = 0; i < dataLen; i++) {
        frame.push_back(data[i]);
    }

    frame.push_back(FRAME_ETX);  // End of text

    return frame;
}

void test_parse_empty_single_packet_v3(void) {
    // Build a valid V3 single packet frame with no LED data
    auto frame = buildFrame(CMD_V3_PACKET_ONLY, nullptr, 0);

    bool result = protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_TRUE(result);  // Should complete (even if empty)
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_parse_single_led_v3(void) {
    // V3 format: position_low, position_high, color
    // Position 5, Green color (0b00011100 = 0x1C -> G=7, R=0, B=0)
    uint8_t ledData[] = {
        0x05, 0x00,  // Position 5 (little-endian)
        0x1C         // Color: 00 011 100 (R=0, G=7, B=0) -> G=252
    };

    auto frame = buildFrame(CMD_V3_PACKET_ONLY, ledData, sizeof(ledData));

    bool result = protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());

    const auto& leds = protocol->getLedCommands();
    TEST_ASSERT_EQUAL_INT(5, leds[0].position);
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].r);    // R=0
    TEST_ASSERT_EQUAL_UINT8(252, leds[0].g);  // G=7*36=252
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].b);    // B=0
}

void test_parse_multiple_leds_v3(void) {
    // Three LEDs in V3 format
    uint8_t ledData[] = {
        // LED 0: Position 10, Red
        0x0A, 0x00, 0xE0,  // Position 10, R=7 G=0 B=0 -> 0b11100000

        // LED 1: Position 20, Green
        0x14, 0x00, 0x1C,  // Position 20, R=0 G=7 B=0 -> 0b00011100

        // LED 2: Position 30, Blue
        0x1E, 0x00, 0x03  // Position 30, R=0 G=0 B=3 -> 0b00000011
    };

    auto frame = buildFrame(CMD_V3_PACKET_ONLY, ledData, sizeof(ledData));

    bool result = protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(3, protocol->getLedCommands().size());

    const auto& leds = protocol->getLedCommands();

    // LED 0: Red at position 10
    TEST_ASSERT_EQUAL_INT(10, leds[0].position);
    TEST_ASSERT_EQUAL_UINT8(252, leds[0].r);  // R=7*36
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].g);
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].b);

    // LED 1: Green at position 20
    TEST_ASSERT_EQUAL_INT(20, leds[1].position);
    TEST_ASSERT_EQUAL_UINT8(0, leds[1].r);
    TEST_ASSERT_EQUAL_UINT8(252, leds[1].g);  // G=7*36
    TEST_ASSERT_EQUAL_UINT8(0, leds[1].b);

    // LED 2: Blue at position 30
    TEST_ASSERT_EQUAL_INT(30, leds[2].position);
    TEST_ASSERT_EQUAL_UINT8(0, leds[2].r);
    TEST_ASSERT_EQUAL_UINT8(0, leds[2].g);
    TEST_ASSERT_EQUAL_UINT8(255, leds[2].b);  // B=3*85
}

void test_parse_single_led_v2(void) {
    // V2 format: position_low, colorPos (RRGGBBPP)
    // Position 5, Green color
    // PP=position high bits, BB=blue, GG=green, RR=red
    // Green max: RR=0, GG=3, BB=0, PP=0 -> 0b00110000 = 0x30
    uint8_t ledData[] = {
        0x05,  // Position low byte (5)
        0x30   // 00 11 00 00 -> R=0, G=3, B=0, P=0
    };

    auto frame = buildFrame(CMD_V2_PACKET_ONLY, ledData, sizeof(ledData));

    bool result = protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());

    const auto& leds = protocol->getLedCommands();
    TEST_ASSERT_EQUAL_INT(5, leds[0].position);
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].r);
    TEST_ASSERT_EQUAL_UINT8(255, leds[0].g);  // G=3*85=255
    TEST_ASSERT_EQUAL_UINT8(0, leds[0].b);
}

void test_parse_v2_with_high_position_bits(void) {
    // V2 format with position > 255 (uses PP bits)
    // Position 300 = 0x12C -> low=0x2C, high=0x01 (bits 0-1 of colorPos)
    // Green color: RR=0, GG=3, BB=0, PP=01 -> 0b00110001 = 0x31
    uint8_t ledData[] = {
        0x2C,  // Position low byte (44)
        0x31   // 00 11 00 01 -> R=0, G=3, B=0, P=1
    };

    auto frame = buildFrame(CMD_V2_PACKET_ONLY, ledData, sizeof(ledData));

    bool result = protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());

    const auto& leds = protocol->getLedCommands();
    // Position = 0x2C | (0x01 << 8) = 44 + 256 = 300
    TEST_ASSERT_EQUAL_INT(300, leds[0].position);
}

// =============================================================================
// Multi-Packet Tests
// =============================================================================

void test_multi_packet_v3_first_middle_last(void) {
    // First packet
    uint8_t firstData[] = {0x01, 0x00, 0xE0};  // Position 1, Red
    auto firstFrame = buildFrame(CMD_V3_PACKET_FIRST, firstData, sizeof(firstData));

    bool result1 = protocol->addData(firstFrame.data(), firstFrame.size());
    TEST_ASSERT_FALSE(result1);  // Not complete yet

    // Middle packet
    uint8_t middleData[] = {0x02, 0x00, 0x1C};  // Position 2, Green
    auto middleFrame = buildFrame(CMD_V3_PACKET_MIDDLE, middleData, sizeof(middleData));

    bool result2 = protocol->addData(middleFrame.data(), middleFrame.size());
    TEST_ASSERT_FALSE(result2);  // Still not complete

    // Last packet
    uint8_t lastData[] = {0x03, 0x00, 0x03};  // Position 3, Blue
    auto lastFrame = buildFrame(CMD_V3_PACKET_LAST, lastData, sizeof(lastData));

    bool result3 = protocol->addData(lastFrame.data(), lastFrame.size());
    TEST_ASSERT_TRUE(result3);  // Now complete!

    // Should have all 3 LEDs
    TEST_ASSERT_EQUAL(3, protocol->getLedCommands().size());

    const auto& leds = protocol->getLedCommands();
    TEST_ASSERT_EQUAL_INT(1, leds[0].position);
    TEST_ASSERT_EQUAL_INT(2, leds[1].position);
    TEST_ASSERT_EQUAL_INT(3, leds[2].position);
}

void test_multi_packet_v3_first_last_no_middle(void) {
    // First packet
    uint8_t firstData[] = {0x01, 0x00, 0xE0};
    auto firstFrame = buildFrame(CMD_V3_PACKET_FIRST, firstData, sizeof(firstData));

    bool result1 = protocol->addData(firstFrame.data(), firstFrame.size());
    TEST_ASSERT_FALSE(result1);

    // Last packet (skip middle)
    uint8_t lastData[] = {0x02, 0x00, 0x03};
    auto lastFrame = buildFrame(CMD_V3_PACKET_LAST, lastData, sizeof(lastData));

    bool result2 = protocol->addData(lastFrame.data(), lastFrame.size());
    TEST_ASSERT_TRUE(result2);

    // Should have both LEDs
    TEST_ASSERT_EQUAL(2, protocol->getLedCommands().size());
}

void test_multi_packet_v2(void) {
    // First packet (V2)
    uint8_t firstData[] = {0x01, 0xC0};  // Position 1, Red (RR=3)
    auto firstFrame = buildFrame(CMD_V2_PACKET_FIRST, firstData, sizeof(firstData));

    bool result1 = protocol->addData(firstFrame.data(), firstFrame.size());
    TEST_ASSERT_FALSE(result1);

    // Last packet (V2)
    uint8_t lastData[] = {0x02, 0x30};  // Position 2, Green (GG=3)
    auto lastFrame = buildFrame(CMD_V2_PACKET_LAST, lastData, sizeof(lastData));

    bool result2 = protocol->addData(lastFrame.data(), lastFrame.size());
    TEST_ASSERT_TRUE(result2);

    TEST_ASSERT_EQUAL(2, protocol->getLedCommands().size());
}

// =============================================================================
// Error Handling Tests
// =============================================================================

void test_invalid_checksum_rejected(void) {
    // Build a frame manually with wrong checksum
    uint8_t frame[] = {
        FRAME_SOH,           // SOH
        0x04,                // Length (command + 3 bytes)
        0x00,                // Wrong checksum!
        FRAME_STX,           // STX
        CMD_V3_PACKET_ONLY,  // Command
        0x01,
        0x00,
        0xE0,      // LED data
        FRAME_ETX  // ETX
    };

    bool result = protocol->addData(frame, sizeof(frame));
    (void)result;  // Return value not important - we're testing no LEDs produced

    // Should not produce valid output with bad checksum
    // The frame will be rejected and buffer searched for next valid frame
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_missing_stx_skipped(void) {
    // Frame with wrong byte at STX position
    uint8_t frame[] = {FRAME_SOH,
                       0x01,  // Length
                       0xFE,  // Checksum for just command 'T'
                       0xFF,  // Wrong! Should be STX (0x02)
                       CMD_V3_PACKET_ONLY,
                       FRAME_ETX};

    // Should skip the invalid frame
    bool result = protocol->addData(frame, sizeof(frame));
    (void)result;  // Return value not important - we're testing no LEDs produced
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_missing_etx_skipped(void) {
    // Frame with wrong byte at ETX position
    uint8_t frame[] = {
        FRAME_SOH,
        0x01,  // Length
        0xAB,  // Some checksum (will be recalculated)
        FRAME_STX, CMD_V3_PACKET_ONLY,
        0xFF  // Wrong! Should be ETX (0x03)
    };

    // Recalculate correct checksum for the test
    frame[2] = CMD_V3_PACKET_ONLY ^ 0xFF;

    bool result = protocol->addData(frame, sizeof(frame));
    (void)result;  // Return value not important - we're testing no LEDs produced
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_garbage_before_frame_skipped(void) {
    // Some garbage followed by a valid frame
    uint8_t ledData[] = {0x05, 0x00, 0xE0};
    auto validFrame = buildFrame(CMD_V3_PACKET_ONLY, ledData, sizeof(ledData));

    std::vector<uint8_t> dataWithGarbage;
    // Add some garbage bytes
    dataWithGarbage.push_back(0xFF);
    dataWithGarbage.push_back(0xAB);
    dataWithGarbage.push_back(0xCD);
    // Add the valid frame
    dataWithGarbage.insert(dataWithGarbage.end(), validFrame.begin(), validFrame.end());

    bool result = protocol->addData(dataWithGarbage.data(), dataWithGarbage.size());

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());
    TEST_ASSERT_EQUAL_INT(5, protocol->getLedCommands()[0].position);
}

void test_fragmented_frame_assembly(void) {
    // Build a complete valid frame
    uint8_t ledData[] = {0x0A, 0x00, 0xE0};  // Position 10, Red
    auto frame = buildFrame(CMD_V3_PACKET_ONLY, ledData, sizeof(ledData));

    // Send in two chunks
    size_t splitPoint = frame.size() / 2;

    bool result1 = protocol->addData(frame.data(), splitPoint);
    TEST_ASSERT_FALSE(result1);  // Incomplete

    bool result2 = protocol->addData(frame.data() + splitPoint, frame.size() - splitPoint);
    TEST_ASSERT_TRUE(result2);  // Now complete

    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());
    TEST_ASSERT_EQUAL_INT(10, protocol->getLedCommands()[0].position);
}

void test_orphan_middle_packet_ignored(void) {
    // Send a middle packet without a first packet
    uint8_t middleData[] = {0x01, 0x00, 0xE0};
    auto middleFrame = buildFrame(CMD_V3_PACKET_MIDDLE, middleData, sizeof(middleData));

    bool result = protocol->addData(middleFrame.data(), middleFrame.size());
    TEST_ASSERT_FALSE(result);  // Should not produce output
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_orphan_last_packet_ignored(void) {
    // Send a last packet without a first packet
    uint8_t lastData[] = {0x01, 0x00, 0xE0};
    auto lastFrame = buildFrame(CMD_V3_PACKET_LAST, lastData, sizeof(lastData));

    bool result = protocol->addData(lastFrame.data(), lastFrame.size());
    TEST_ASSERT_FALSE(result);
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

// =============================================================================
// Color Decoding Tests
// =============================================================================

void test_v3_color_decoding_full_range(void) {
    // Test V3 color format: RRRGGGBB
    // Max values: R=7 (0xE0), G=7 (0x1C), B=3 (0x03)
    // Full white would be 0xFF = 11111111 = R7 G7 B3

    // Test full red: 11100000 = 0xE0
    uint8_t redData[] = {0x01, 0x00, 0xE0};
    auto redFrame = buildFrame(CMD_V3_PACKET_ONLY, redData, sizeof(redData));
    protocol->addData(redFrame.data(), redFrame.size());

    TEST_ASSERT_EQUAL_UINT8(252, protocol->getLedCommands()[0].r);  // 7*36
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].g);
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].b);

    protocol->clear();

    // Test full green: 00011100 = 0x1C
    uint8_t greenData[] = {0x02, 0x00, 0x1C};
    auto greenFrame = buildFrame(CMD_V3_PACKET_ONLY, greenData, sizeof(greenData));
    protocol->addData(greenFrame.data(), greenFrame.size());

    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].r);
    TEST_ASSERT_EQUAL_UINT8(252, protocol->getLedCommands()[0].g);  // 7*36
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].b);

    protocol->clear();

    // Test full blue: 00000011 = 0x03
    uint8_t blueData[] = {0x03, 0x00, 0x03};
    auto blueFrame = buildFrame(CMD_V3_PACKET_ONLY, blueData, sizeof(blueData));
    protocol->addData(blueFrame.data(), blueFrame.size());

    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].g);
    TEST_ASSERT_EQUAL_UINT8(255, protocol->getLedCommands()[0].b);  // 3*85
}

void test_v2_color_decoding_full_range(void) {
    // Test V2 color format: RRGGBBPP in second byte
    // Max values: R=3 (0xC0), G=3 (0x30), B=3 (0x0C)

    // Test full red: 11000000 = 0xC0 (with PP=00)
    uint8_t redData[] = {0x01, 0xC0};
    auto redFrame = buildFrame(CMD_V2_PACKET_ONLY, redData, sizeof(redData));
    protocol->addData(redFrame.data(), redFrame.size());

    TEST_ASSERT_EQUAL_UINT8(255, protocol->getLedCommands()[0].r);  // 3*85
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].g);
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].b);

    protocol->clear();

    // Test full green: 00110000 = 0x30
    uint8_t greenData[] = {0x02, 0x30};
    auto greenFrame = buildFrame(CMD_V2_PACKET_ONLY, greenData, sizeof(greenData));
    protocol->addData(greenFrame.data(), greenFrame.size());

    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].r);
    TEST_ASSERT_EQUAL_UINT8(255, protocol->getLedCommands()[0].g);  // 3*85
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].b);

    protocol->clear();

    // Test full blue: 00001100 = 0x0C
    uint8_t blueData[] = {0x03, 0x0C};
    auto blueFrame = buildFrame(CMD_V2_PACKET_ONLY, blueData, sizeof(blueData));
    protocol->addData(blueFrame.data(), blueFrame.size());

    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, protocol->getLedCommands()[0].g);
    TEST_ASSERT_EQUAL_UINT8(255, protocol->getLedCommands()[0].b);  // 3*85
}

// =============================================================================
// Position Tests
// =============================================================================

void test_v3_high_position_value(void) {
    // V3 uses full 16-bit position
    // Position 1000 = 0x03E8 -> low=0xE8, high=0x03
    uint8_t ledData[] = {0xE8, 0x03, 0xE0};  // Position 1000, Red
    auto frame = buildFrame(CMD_V3_PACKET_ONLY, ledData, sizeof(ledData));

    protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());
    TEST_ASSERT_EQUAL_INT(1000, protocol->getLedCommands()[0].position);
}

void test_v2_max_position_value(void) {
    // V2 uses 10-bit position (max 1023)
    // Position 1023 = 0x3FF -> low=0xFF, PP=0x03
    // Color with PP=3: 0xC3 = 11000011 -> R=3, G=0, B=0, P=3
    uint8_t ledData[] = {0xFF, 0xC3};
    auto frame = buildFrame(CMD_V2_PACKET_ONLY, ledData, sizeof(ledData));

    protocol->addData(frame.data(), frame.size());

    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());
    TEST_ASSERT_EQUAL_INT(1023, protocol->getLedCommands()[0].position);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // colorToRole tests
    RUN_TEST(test_colorToRole_green_returns_starting);
    RUN_TEST(test_colorToRole_cyan_returns_hand);
    RUN_TEST(test_colorToRole_magenta_returns_finish);
    RUN_TEST(test_colorToRole_orange_returns_foot);
    RUN_TEST(test_colorToRole_black_returns_unknown);
    RUN_TEST(test_colorToRole_white_returns_unknown);
    RUN_TEST(test_colorToRole_threshold_boundary_low);
    RUN_TEST(test_colorToRole_threshold_boundary_high);

    // State tests
    RUN_TEST(test_clear_resets_state);
    RUN_TEST(test_initial_state_empty);

    // Frame parsing tests
    RUN_TEST(test_parse_empty_single_packet_v3);
    RUN_TEST(test_parse_single_led_v3);
    RUN_TEST(test_parse_multiple_leds_v3);
    RUN_TEST(test_parse_single_led_v2);
    RUN_TEST(test_parse_v2_with_high_position_bits);

    // Multi-packet tests
    RUN_TEST(test_multi_packet_v3_first_middle_last);
    RUN_TEST(test_multi_packet_v3_first_last_no_middle);
    RUN_TEST(test_multi_packet_v2);

    // Error handling tests
    RUN_TEST(test_invalid_checksum_rejected);
    RUN_TEST(test_missing_stx_skipped);
    RUN_TEST(test_missing_etx_skipped);
    RUN_TEST(test_garbage_before_frame_skipped);
    RUN_TEST(test_fragmented_frame_assembly);
    RUN_TEST(test_orphan_middle_packet_ignored);
    RUN_TEST(test_orphan_last_packet_ignored);

    // Color decoding tests
    RUN_TEST(test_v3_color_decoding_full_range);
    RUN_TEST(test_v2_color_decoding_full_range);

    // Position tests
    RUN_TEST(test_v3_high_position_value);
    RUN_TEST(test_v2_max_position_value);

    return UNITY_END();
}
