// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit tests for Aurora protocol encoding
 *
 * Tests the LED command encoding used in proxy mode to communicate
 * with official Kilter boards.
 *
 * These tests use the shared aurora_encoding.h header which is also used
 * by production code, ensuring tests verify the actual encoding implementation.
 */

#include <unity.h>
#include <vector>
#include <cstring>

// Use the shared encoding header (no Arduino dependencies)
#include "../src/bluetooth/aurora_encoding.h"

// LED command structure (mirrors led_controller.h)
struct LedCommand {
    int position;
    uint8_t r;
    uint8_t g;
    uint8_t b;
};

// Create a complete Aurora protocol frame using shared encoding functions
static std::vector<uint8_t> createFrame(const uint8_t* ledData, size_t ledDataLength, uint8_t command) {
    // Data portion: command + LED data
    size_t dataLength = 1 + ledDataLength;

    // Build data portion
    std::vector<uint8_t> data(dataLength);
    data[0] = command;
    if (ledDataLength > 0) {
        memcpy(&data[1], ledData, ledDataLength);
    }

    // Calculate checksum using shared function
    uint8_t checksum = aurora_calculateChecksum(data.data(), dataLength);

    // Build complete frame
    std::vector<uint8_t> frame;
    frame.push_back(AURORA_FRAME_SOH);
    frame.push_back(static_cast<uint8_t>(dataLength));
    frame.push_back(checksum);
    frame.push_back(AURORA_FRAME_STX);
    frame.insert(frame.end(), data.begin(), data.end());
    frame.push_back(AURORA_FRAME_ETX);

    return frame;
}

// ============================================
// Test Cases
// ============================================

void test_checksum_empty_data() {
    uint8_t data[] = {};
    uint8_t checksum = aurora_calculateChecksum(data, 0);
    TEST_ASSERT_EQUAL_UINT8(0xFF, checksum);
}

void test_checksum_single_byte() {
    uint8_t data[] = {0x00};
    uint8_t checksum = aurora_calculateChecksum(data, 1);
    TEST_ASSERT_EQUAL_UINT8(0xFF, checksum);

    uint8_t data2[] = {0xFF};
    uint8_t checksum2 = aurora_calculateChecksum(data2, 1);
    TEST_ASSERT_EQUAL_UINT8(0x00, checksum2);
}

void test_checksum_multiple_bytes() {
    uint8_t data[] = {0x01, 0x02, 0x03};
    uint8_t checksum = aurora_calculateChecksum(data, 3);
    // Sum = 1 + 2 + 3 = 6, checksum = 6 ^ 0xFF = 0xF9
    TEST_ASSERT_EQUAL_UINT8(0xF9, checksum);
}

void test_color_encoding_black() {
    uint8_t color = aurora_encodeColor(0, 0, 0);
    TEST_ASSERT_EQUAL_UINT8(0x00, color);
}

void test_color_encoding_white() {
    uint8_t color = aurora_encodeColor(255, 255, 255);
    // r3=7 (255/32=7), g3=7 (255/32=7), b2=3 (255/64=3)
    // (7 << 5) | (7 << 2) | 3 = 224 | 28 | 3 = 0xFF
    TEST_ASSERT_EQUAL_UINT8(0xFF, color);
}

void test_color_encoding_red() {
    uint8_t color = aurora_encodeColor(255, 0, 0);
    // r3=7, g3=0, b2=0
    // (7 << 5) | 0 | 0 = 224 = 0xE0
    TEST_ASSERT_EQUAL_UINT8(0xE0, color);
}

void test_color_encoding_green() {
    uint8_t color = aurora_encodeColor(0, 255, 0);
    // r3=0, g3=7, b2=0
    // (0 << 5) | (7 << 2) | 0 = 28 = 0x1C
    TEST_ASSERT_EQUAL_UINT8(0x1C, color);
}

void test_color_encoding_blue() {
    uint8_t color = aurora_encodeColor(0, 0, 255);
    // r3=0, g3=0, b2=3
    // (0 << 5) | (0 << 2) | 3 = 3 = 0x03
    TEST_ASSERT_EQUAL_UINT8(0x03, color);
}

void test_color_encoding_cyan() {
    // Cyan (0, 255, 255) - used for hand holds in Kilter
    uint8_t color = aurora_encodeColor(0, 255, 255);
    // r3=0, g3=7, b2=3
    // (0 << 5) | (7 << 2) | 3 = 28 | 3 = 31 = 0x1F
    TEST_ASSERT_EQUAL_UINT8(0x1F, color);
}

void test_color_encoding_magenta() {
    // Magenta (255, 0, 255) - used for finish holds in Kilter
    uint8_t color = aurora_encodeColor(255, 0, 255);
    // r3=7, g3=0, b2=3
    // (7 << 5) | 0 | 3 = 224 | 3 = 227 = 0xE3
    TEST_ASSERT_EQUAL_UINT8(0xE3, color);
}

void test_led_command_encoding() {
    uint8_t output[3];
    aurora_encodeLedCommand(123, 255, 0, 0, output);

    TEST_ASSERT_EQUAL_UINT8(123, output[0]);  // Position low
    TEST_ASSERT_EQUAL_UINT8(0, output[1]);    // Position high
    TEST_ASSERT_EQUAL_UINT8(0xE0, output[2]); // Red color
}

void test_led_command_encoding_large_position() {
    uint8_t output[3];
    aurora_encodeLedCommand(500, 0, 255, 0, output);

    // 500 = 0x01F4 -> low=0xF4, high=0x01
    TEST_ASSERT_EQUAL_UINT8(0xF4, output[0]); // Position low
    TEST_ASSERT_EQUAL_UINT8(0x01, output[1]); // Position high
    TEST_ASSERT_EQUAL_UINT8(0x1C, output[2]); // Green color
}

void test_position_encoding() {
    uint8_t output[2];

    // Test position 0
    aurora_encodePosition(0, output);
    TEST_ASSERT_EQUAL_UINT8(0x00, output[0]);
    TEST_ASSERT_EQUAL_UINT8(0x00, output[1]);

    // Test position 255 (fits in one byte)
    aurora_encodePosition(255, output);
    TEST_ASSERT_EQUAL_UINT8(0xFF, output[0]);
    TEST_ASSERT_EQUAL_UINT8(0x00, output[1]);

    // Test position 256 (needs two bytes)
    aurora_encodePosition(256, output);
    TEST_ASSERT_EQUAL_UINT8(0x00, output[0]);
    TEST_ASSERT_EQUAL_UINT8(0x01, output[1]);

    // Test position 65535 (max)
    aurora_encodePosition(65535, output);
    TEST_ASSERT_EQUAL_UINT8(0xFF, output[0]);
    TEST_ASSERT_EQUAL_UINT8(0xFF, output[1]);
}

void test_frame_structure() {
    uint8_t ledData[] = {0x00, 0x00, 0xE0};  // Position 0, red
    std::vector<uint8_t> frame = createFrame(ledData, 3, AURORA_CMD_V3_PACKET_ONLY);

    // Frame: SOH + length + checksum + STX + command + ledData + ETX
    // Length = 1 (cmd) + 3 (led data) = 4
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_SOH, frame[0]);
    TEST_ASSERT_EQUAL_UINT8(4, frame[1]);  // Length
    // frame[2] is checksum
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_STX, frame[3]);
    TEST_ASSERT_EQUAL_UINT8(AURORA_CMD_V3_PACKET_ONLY, frame[4]);  // 'T'
    TEST_ASSERT_EQUAL_UINT8(0x00, frame[5]);  // LED data
    TEST_ASSERT_EQUAL_UINT8(0x00, frame[6]);
    TEST_ASSERT_EQUAL_UINT8(0xE0, frame[7]);
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_ETX, frame[8]);
}

void test_frame_checksum_verification() {
    uint8_t ledData[] = {0x00, 0x00, 0xE0};
    std::vector<uint8_t> frame = createFrame(ledData, 3, AURORA_CMD_V3_PACKET_ONLY);

    // Extract the data portion (command + LED data)
    std::vector<uint8_t> dataPortion(frame.begin() + 4, frame.end() - 1);

    // Verify checksum matches
    uint8_t expectedChecksum = aurora_calculateChecksum(dataPortion.data(), dataPortion.size());
    TEST_ASSERT_EQUAL_UINT8(expectedChecksum, frame[2]);
}

void test_multi_packet_commands() {
    // Verify the command bytes for multi-packet sequences
    TEST_ASSERT_EQUAL_UINT8('R', AURORA_CMD_V3_PACKET_FIRST);
    TEST_ASSERT_EQUAL_UINT8('Q', AURORA_CMD_V3_PACKET_MIDDLE);
    TEST_ASSERT_EQUAL_UINT8('S', AURORA_CMD_V3_PACKET_LAST);
    TEST_ASSERT_EQUAL_UINT8('T', AURORA_CMD_V3_PACKET_ONLY);
}

void test_frame_minimum_size() {
    // Empty LED data - just command
    uint8_t ledData[] = {};
    std::vector<uint8_t> frame = createFrame(ledData, 0, AURORA_CMD_V3_PACKET_ONLY);

    // Minimum frame: SOH + len + checksum + STX + cmd + ETX = 6 bytes
    TEST_ASSERT_EQUAL(6, frame.size());
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_SOH, frame[0]);
    TEST_ASSERT_EQUAL_UINT8(1, frame[1]);  // Just the command byte
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_STX, frame[3]);
    TEST_ASSERT_EQUAL_UINT8(AURORA_CMD_V3_PACKET_ONLY, frame[4]);
    TEST_ASSERT_EQUAL_UINT8(AURORA_FRAME_ETX, frame[5]);
}

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // Checksum tests
    RUN_TEST(test_checksum_empty_data);
    RUN_TEST(test_checksum_single_byte);
    RUN_TEST(test_checksum_multiple_bytes);

    // Color encoding tests
    RUN_TEST(test_color_encoding_black);
    RUN_TEST(test_color_encoding_white);
    RUN_TEST(test_color_encoding_red);
    RUN_TEST(test_color_encoding_green);
    RUN_TEST(test_color_encoding_blue);
    RUN_TEST(test_color_encoding_cyan);
    RUN_TEST(test_color_encoding_magenta);

    // Position encoding tests
    RUN_TEST(test_position_encoding);

    // LED command encoding tests
    RUN_TEST(test_led_command_encoding);
    RUN_TEST(test_led_command_encoding_large_position);

    // Frame structure tests
    RUN_TEST(test_frame_structure);
    RUN_TEST(test_frame_checksum_verification);
    RUN_TEST(test_multi_packet_commands);
    RUN_TEST(test_frame_minimum_size);

    return UNITY_END();
}
