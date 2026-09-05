// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef AURORA_ENCODING_H
#define AURORA_ENCODING_H

/**
 * Aurora Protocol Encoding Functions
 *
 * This header contains pure encoding logic without Arduino dependencies,
 * allowing it to be used in both production code and native unit tests.
 *
 * The encoding matches the TypeScript implementation in:
 *   packages/web/app/components/board-bluetooth-control/bluetooth.ts
 */

#include <stdint.h>
#include <stddef.h>

// Framing constants
#define AURORA_FRAME_SOH 0x01  // Start of header
#define AURORA_FRAME_STX 0x02  // Start of text
#define AURORA_FRAME_ETX 0x03  // End of text

// API v3 command bytes (3 bytes per LED)
#define AURORA_CMD_V3_PACKET_ONLY   'T'  // 84 - Single packet (complete message)
#define AURORA_CMD_V3_PACKET_FIRST  'R'  // 82 - First packet of multi-packet sequence
#define AURORA_CMD_V3_PACKET_MIDDLE 'Q'  // 81 - Middle packet of multi-packet sequence
#define AURORA_CMD_V3_PACKET_LAST   'S'  // 83 - Last packet of multi-packet sequence

/**
 * Calculate Aurora protocol checksum
 *
 * @param data Pointer to data bytes
 * @param length Number of bytes
 * @return Checksum byte (sum of bytes XOR 0xFF)
 */
inline uint8_t aurora_calculateChecksum(const uint8_t* data, size_t length) {
    uint8_t sum = 0;
    for (size_t i = 0; i < length; i++) {
        sum = (sum + data[i]) & 0xFF;
    }
    return sum ^ 0xFF;
}

/**
 * Encode RGB color to Aurora RRRGGGBB format
 *
 * Matches the TypeScript encoding in bluetooth.ts:
 *   Math.floor(r / 32) << 5 | Math.floor(g / 32) << 2 | Math.floor(b / 64)
 *
 * @param r Red component (0-255)
 * @param g Green component (0-255)
 * @param b Blue component (0-255)
 * @return Packed color byte (RRRGGGBB)
 */
inline uint8_t aurora_encodeColor(uint8_t r, uint8_t g, uint8_t b) {
    uint8_t r3 = r / 32;  // 0-7 (3 bits)
    uint8_t g3 = g / 32;  // 0-7 (3 bits)
    uint8_t b2 = b / 64;  // 0-3 (2 bits)
    return (r3 << 5) | (g3 << 2) | b2;
}

/**
 * Encode LED position to little-endian bytes
 *
 * @param position LED position (0-65535)
 * @param output Output buffer (must be at least 2 bytes)
 */
inline void aurora_encodePosition(uint16_t position, uint8_t* output) {
    output[0] = position & 0xFF;          // Low byte
    output[1] = (position >> 8) & 0xFF;   // High byte
}

/**
 * Encode a single LED command to bytes (3 bytes per LED)
 *
 * @param position LED position
 * @param r Red component (0-255)
 * @param g Green component (0-255)
 * @param b Blue component (0-255)
 * @param output Output buffer (must be at least 3 bytes)
 */
inline void aurora_encodeLedCommand(uint16_t position, uint8_t r, uint8_t g, uint8_t b, uint8_t* output) {
    aurora_encodePosition(position, output);
    output[2] = aurora_encodeColor(r, g, b);
}

#endif // AURORA_ENCODING_H
