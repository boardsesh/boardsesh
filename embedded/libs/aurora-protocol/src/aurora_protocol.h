#ifndef AURORA_PROTOCOL_H
#define AURORA_PROTOCOL_H

#include <Arduino.h>

#include <led_controller.h>
#include <vector>

// Framing constants
#define FRAME_SOH 0x01  // Start of header
#define FRAME_STX 0x02  // Start of text
#define FRAME_ETX 0x03  // End of text

// Hold role codes (Kilter board)
#define ROLE_STARTING 42
#define ROLE_HAND 43
#define ROLE_FINISH 44
#define ROLE_FOOT 45
#define ROLE_UNKNOWN 0

/**
 * Convert RGB color to hold role code
 * Based on Kilter color scheme:
 * - Green (0, 255, 0) → STARTING
 * - Cyan (0, 255, 255) → HAND
 * - Magenta (255, 0, 255) → FINISH
 * - Orange (255, 170, 0) → FOOT
 */
inline uint8_t colorToRole(uint8_t r, uint8_t g, uint8_t b) {
    // Use thresholds since colors are quantized (2-bit per channel)
    bool hasRed = r > 127;
    bool hasGreen = g > 127;
    bool hasBlue = b > 127;

    if (!hasRed && hasGreen && !hasBlue) {
        return ROLE_STARTING;  // Green
    } else if (!hasRed && hasGreen && hasBlue) {
        return ROLE_HAND;  // Cyan
    } else if (hasRed && !hasGreen && hasBlue) {
        return ROLE_FINISH;  // Magenta
    } else if (hasRed && hasGreen && !hasBlue) {
        return ROLE_FOOT;  // Orange/Yellow
    }
    return ROLE_UNKNOWN;
}

// Command bytes (inside the framed message)
// API v2 commands (2 bytes per LED)
#define CMD_V2_PACKET_ONLY 'P'    // 80 - Single packet (complete message)
#define CMD_V2_PACKET_FIRST 'N'   // 78 - First packet of multi-packet sequence
#define CMD_V2_PACKET_MIDDLE 'M'  // 77 - Middle packet of multi-packet sequence
#define CMD_V2_PACKET_LAST 'O'    // 79 - Last packet of multi-packet sequence

// API v3 commands (3 bytes per LED)
#define CMD_V3_PACKET_ONLY 'T'    // 84 - Single packet (complete message)
#define CMD_V3_PACKET_FIRST 'R'   // 82 - First packet of multi-packet sequence
#define CMD_V3_PACKET_MIDDLE 'Q'  // 81 - Middle packet of multi-packet sequence
#define CMD_V3_PACKET_LAST 'S'    // 83 - Last packet of multi-packet sequence

/**
 * Aurora Protocol Decoder
 * Decodes LED data packets from official Kilter/Tension apps
 *
 * Protocol based on reverse engineering of Aurora Climbing's Bluetooth communication.
 *
 * BLE Packet Framing:
 * [0x01, length, checksum, 0x02, command, ...LED_data..., 0x03]
 *
 * Where:
 * - 0x01 (SOH): Start of header
 * - length: Length of data (command + LED data)
 * - checksum: XOR of all data bytes with 0xFF
 * - 0x02 (STX): Start of text
 * - command: Q (middle), R (first), S (last), T (only)
 * - LED data: Position and color bytes
 * - 0x03 (ETX): End of text
 *
 * Command types:
 * - 'T' (84): Single packet (complete message)
 * - 'R' (82): First packet of multi-packet sequence
 * - 'Q' (81): Middle packet of multi-packet sequence
 * - 'S' (83): Last packet of multi-packet sequence
 *
 * Data format (3 bytes per LED):
 * - Byte 0-1: Position (little-endian)
 * - Byte 2: Color (RRRGGGBB format - 3 bits red, 3 bits green, 2 bits blue)
 */
class AuroraProtocol {
  public:
    AuroraProtocol();

    // Add incoming BLE data to buffer
    // Returns true if a complete LED update is ready
    bool addData(const uint8_t* data, size_t length);

    // Process incoming packet (legacy - calls addData internally)
    bool processPacket(const uint8_t* data, size_t length);

    // Get the decoded LED commands
    const std::vector<LedCommand>& getLedCommands() const;

    // Clear accumulated data and reset state
    void clear();

    // Get detected angle (if available)
    int getAngle() const;

    // Enable/disable debug output
    void setDebug(bool enabled);

    /**
     * Encode LED commands into Aurora protocol format for sending to a board.
     * Creates one or more BLE packets in the proper framed format.
     *
     * @param commands Array of LED commands to encode
     * @param count Number of commands
     * @param packets Output vector that will be filled with encoded packets
     *                Each packet is a complete framed message ready for BLE transmission
     */
    static void encodeLedCommands(const LedCommand* commands, int count, std::vector<std::vector<uint8_t>>& packets);

  private:
    // Raw data buffer for incoming BLE packets
    std::vector<uint8_t> rawBuffer;

    // Decoded LED commands
    std::vector<LedCommand> ledCommands;

    // Pending commands for multi-packet sequences
    std::vector<LedCommand> pendingCommands;

    int currentAngle;
    bool multiPacketInProgress;
    bool debugEnabled;
    unsigned long lastBufferAppendAt;

    // Try to extract and process a complete framed message from the buffer
    // Returns true if a complete LED update is ready
    bool tryProcessBuffer();

    // Drop stale/corrupt buffered bytes so interrupted BLE writes cannot block
    // later complete frames.
    void resyncBufferIfNeeded(unsigned long now);

    // Calculate checksum for data
    uint8_t calculateChecksum(const uint8_t* data, size_t length);

    // Decode LED data - API v2 (2 bytes per LED)
    void decodeLedDataV2(const uint8_t* data, size_t length, std::vector<LedCommand>& output);

    // Decode LED data - API v3 (3 bytes per LED)
    void decodeLedDataV3(const uint8_t* data, size_t length, std::vector<LedCommand>& output);

    // Process a complete unframed message (command byte + LED data)
    // Returns true if this completes an LED update
    bool processMessage(uint8_t command, const uint8_t* data, size_t length);
};

extern AuroraProtocol Aurora;

#endif  // AURORA_PROTOCOL_H
