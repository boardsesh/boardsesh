#include "aurora_protocol.h"

#include <log_buffer.h>

AuroraProtocol Aurora;

namespace {
const size_t MAX_RAW_BUFFER_BYTES = 512;
const unsigned long RAW_BUFFER_STALE_MS = 750;
}  // namespace

AuroraProtocol::AuroraProtocol()
    : currentAngle(0), multiPacketInProgress(false), debugEnabled(false), lastBufferAppendAt(0) {}

void AuroraProtocol::clear() {
    rawBuffer.clear();
    ledCommands.clear();
    pendingCommands.clear();
    currentAngle = 0;
    multiPacketInProgress = false;
    lastBufferAppendAt = 0;
}

void AuroraProtocol::setDebug(bool enabled) {
    debugEnabled = enabled;
}

const std::vector<LedCommand>& AuroraProtocol::getLedCommands() const {
    return ledCommands;
}

int AuroraProtocol::getAngle() const {
    return currentAngle;
}

uint8_t AuroraProtocol::calculateChecksum(const uint8_t* data, size_t length) {
    uint8_t sum = 0;
    for (size_t i = 0; i < length; i++) {
        sum = (sum + data[i]) & 0xFF;
    }
    return sum ^ 0xFF;
}

bool AuroraProtocol::addData(const uint8_t* data, size_t length) {
    unsigned long now = millis();
    resyncBufferIfNeeded(now);

    // Add new data to buffer
    for (size_t i = 0; i < length; i++) {
        rawBuffer.push_back(data[i]);
    }
    lastBufferAppendAt = now;
    resyncBufferIfNeeded(now);

    if (debugEnabled) {
        Logger.logln("[Aurora] Buffer size: %zu bytes (added %zu)", rawBuffer.size(), length);

        // Print first few bytes for debugging
        Serial.print("[Aurora] Buffer start: ");
        for (size_t i = 0; i < min((size_t)20, rawBuffer.size()); i++) {
            Serial.printf("%02X ", rawBuffer[i]);
        }
        Serial.println();
    }

    // Try to extract and process complete messages
    return tryProcessBuffer();
}

void AuroraProtocol::resyncBufferIfNeeded(unsigned long now) {
    if (rawBuffer.empty()) {
        return;
    }

    bool staleBuffer = lastBufferAppendAt > 0 && now - lastBufferAppendAt > RAW_BUFFER_STALE_MS;
    if (staleBuffer) {
        if (debugEnabled) {
            Logger.logln("[Aurora] Clearing stale partial buffer (%zu bytes)", rawBuffer.size());
        }
        rawBuffer.clear();
        pendingCommands.clear();
        multiPacketInProgress = false;
        return;
    }

    if (rawBuffer.size() <= MAX_RAW_BUFFER_BYTES) {
        return;
    }

    size_t lastSoh = rawBuffer.size();
    for (size_t index = rawBuffer.size(); index > 0; index--) {
        if (rawBuffer[index - 1] == FRAME_SOH) {
            lastSoh = index - 1;
            break;
        }
    }

    if (lastSoh < rawBuffer.size()) {
        rawBuffer.erase(rawBuffer.begin(), rawBuffer.begin() + lastSoh);
    }

    if (rawBuffer.size() > MAX_RAW_BUFFER_BYTES) {
        rawBuffer.clear();
        pendingCommands.clear();
        multiPacketInProgress = false;
    }
}

bool AuroraProtocol::processPacket(const uint8_t* data, size_t length) {
    return addData(data, length);
}

bool AuroraProtocol::tryProcessBuffer() {
    bool ledUpdateReady = false;

    // Keep processing while we have potential messages in the buffer
    while (rawBuffer.size() >= 6) {  // Minimum frame: SOH + len + checksum + STX + cmd + ETX = 6 bytes

        // Look for SOH (start of frame)
        if (rawBuffer[0] != FRAME_SOH) {
            if (debugEnabled) {
                Logger.logln("[Aurora] Skipping byte 0x%02X (not SOH)", rawBuffer[0]);
            }
            // Skip this byte and try again
            rawBuffer.erase(rawBuffer.begin());
            continue;
        }

        // We have SOH at position 0
        // Frame format: [SOH, length, checksum, STX, ...data..., ETX]
        // Where length is the size of data (between STX and ETX, inclusive of data but not STX/ETX)

        uint8_t dataLength = rawBuffer[1];

        // Total frame size: SOH(1) + length(1) + checksum(1) + STX(1) + data(dataLength) + ETX(1)
        size_t frameSize = 4 + dataLength + 1;  // header(4) + data + ETX(1)

        if (debugEnabled) {
            Logger.logln("[Aurora] Frame: SOH found, dataLength=%d, frameSize=%zu, bufferSize=%zu", dataLength,
                         frameSize, rawBuffer.size());
        }

        // Check if we have the complete frame
        if (rawBuffer.size() < frameSize) {
            if (debugEnabled) {
                Logger.logln("[Aurora] Incomplete frame, waiting for more data");
            }
            break;  // Wait for more data
        }

        // Verify STX at position 3
        if (rawBuffer[3] != FRAME_STX) {
            if (debugEnabled) {
                Logger.logln("[Aurora] Invalid frame: expected STX at pos 3, got 0x%02X", rawBuffer[3]);
            }
            // Skip SOH and try again
            rawBuffer.erase(rawBuffer.begin());
            continue;
        }

        // Verify ETX at end
        if (rawBuffer[frameSize - 1] != FRAME_ETX) {
            if (debugEnabled) {
                Logger.logln("[Aurora] Invalid frame: expected ETX at pos %zu, got 0x%02X", frameSize - 1,
                             rawBuffer[frameSize - 1]);
            }
            // Skip SOH and try again
            rawBuffer.erase(rawBuffer.begin());
            continue;
        }

        // Extract data (between STX and ETX)
        // Data starts at position 4 and has length dataLength
        const uint8_t* messageData = &rawBuffer[4];

        // Verify checksum
        uint8_t expectedChecksum = rawBuffer[2];
        uint8_t actualChecksum = calculateChecksum(messageData, dataLength);

        if (expectedChecksum != actualChecksum) {
            if (debugEnabled) {
                Logger.logln("[Aurora] Checksum mismatch: expected 0x%02X, got 0x%02X", expectedChecksum,
                             actualChecksum);
            }
            // Skip SOH and try again (checksum mismatch)
            rawBuffer.erase(rawBuffer.begin());
            continue;
        }

        // Valid frame! Extract command and LED data
        if (dataLength >= 1) {
            uint8_t command = messageData[0];
            const uint8_t* ledData = messageData + 1;
            size_t ledDataLength = dataLength - 1;

            if (debugEnabled) {
                Logger.logln("[Aurora] Valid frame: cmd='%c' (0x%02X), ledDataLen=%zu", command, command,
                             ledDataLength);
            }

            // Process the message
            if (processMessage(command, ledData, ledDataLength)) {
                ledUpdateReady = true;
            }
        }

        // Remove processed frame from buffer
        rawBuffer.erase(rawBuffer.begin(), rawBuffer.begin() + frameSize);
    }

    return ledUpdateReady;
}

void AuroraProtocol::decodeLedDataV2(const uint8_t* data, size_t length, std::vector<LedCommand>& output) {
    // API v2 format: 2 bytes per LED
    // Byte 0: position_low (8 bits)
    // Byte 1: position_high (2 bits) | blue (2 bits) | green (2 bits) | red (2 bits)
    //         Format: RRGGBBPP where PP = position high bits

    int ledCount = length / 2;

    if (debugEnabled) {
        Logger.logln("[Aurora] Decoding V2: %d LEDs from %zu bytes", ledCount, length);
    }

    for (int i = 0; i < ledCount; i++) {
        if ((size_t)(i * 2 + 1) >= length)
            break;

        uint8_t posLow = data[i * 2];
        uint8_t colorPos = data[i * 2 + 1];

        // Position: 10 bits (lower 8 from byte 0, upper 2 from byte 1 bits 0-1)
        uint16_t position = posLow | ((colorPos & 0x03) << 8);

        // Colors: 2 bits each, scaled to 8-bit (0, 85, 170, 255)
        // Byte 1 format: RRGGBBPP (R=red, G=green, B=blue, P=position high bits)
        uint8_t r = ((colorPos >> 6) & 0x03) * 85;  // bits 7-6
        uint8_t g = ((colorPos >> 4) & 0x03) * 85;  // bits 5-4
        uint8_t b = ((colorPos >> 2) & 0x03) * 85;  // bits 3-2

        LedCommand cmd;
        cmd.position = position;
        cmd.r = r;
        cmd.g = g;
        cmd.b = b;
        output.push_back(cmd);

        if (debugEnabled && i < 3) {
            Logger.logln("[Aurora]   LED %d: pos=%d, R=%d G=%d B=%d", i, position, r, g, b);
        }
    }
}

void AuroraProtocol::decodeLedDataV3(const uint8_t* data, size_t length, std::vector<LedCommand>& output) {
    // API v3 format: 3 bytes per LED
    // Byte 0: position_low
    // Byte 1: position_high
    // Byte 2: color (RRRGGGBB - 3 bits red, 3 bits green, 2 bits blue)

    int ledCount = length / 3;

    if (debugEnabled) {
        Logger.logln("[Aurora] Decoding V3: %d LEDs from %zu bytes", ledCount, length);
    }

    for (int i = 0; i < ledCount; i++) {
        if ((size_t)(i * 3 + 2) >= length)
            break;

        // Position is little-endian (low byte first)
        uint16_t position = data[i * 3] | (data[i * 3 + 1] << 8);
        uint8_t color = data[i * 3 + 2];

        // Decode color: RRRGGGBB format
        uint8_t r = ((color >> 5) & 0x07) * 36;  // 0-7 -> 0-252
        uint8_t g = ((color >> 2) & 0x07) * 36;  // 0-7 -> 0-252
        uint8_t b = (color & 0x03) * 85;         // 0-3 -> 0-255

        LedCommand cmd;
        cmd.position = position;
        cmd.r = r;
        cmd.g = g;
        cmd.b = b;
        output.push_back(cmd);

        if (debugEnabled && i < 3) {
            Logger.logln("[Aurora]   LED %d: pos=%d, R=%d G=%d B=%d", i, position, r, g, b);
        }
    }
}

void AuroraProtocol::encodeLedCommands(const LedCommand* commands, int count,
                                        std::vector<std::vector<uint8_t>>& packets) {
    packets.clear();

    if (count == 0) {
        return;
    }

    // Use V3 format (3 bytes per LED) - most compatible with current boards
    // Max BLE packet size is ~240 bytes, with framing overhead we can fit ~75 LEDs per packet
    // To be safe, use 60 LEDs per packet
    const int LEDS_PER_PACKET = 60;

    int totalPackets = (count + LEDS_PER_PACKET - 1) / LEDS_PER_PACKET;
    int ledIndex = 0;

    for (int packetNum = 0; packetNum < totalPackets; packetNum++) {
        int ledsInThisPacket = min(LEDS_PER_PACKET, count - ledIndex);

        // Determine command byte based on packet position
        uint8_t command;
        if (totalPackets == 1) {
            command = CMD_V3_PACKET_ONLY;  // 'T' - single packet
        } else if (packetNum == 0) {
            command = CMD_V3_PACKET_FIRST;  // 'R' - first packet
        } else if (packetNum == totalPackets - 1) {
            command = CMD_V3_PACKET_LAST;  // 'S' - last packet
        } else {
            command = CMD_V3_PACKET_MIDDLE;  // 'Q' - middle packet
        }

        // Build the data portion (command + LED data)
        std::vector<uint8_t> data;
        data.push_back(command);

        for (int i = 0; i < ledsInThisPacket; i++) {
            const LedCommand& cmd = commands[ledIndex + i];

            // Position (little-endian)
            data.push_back(cmd.position & 0xFF);
            data.push_back((cmd.position >> 8) & 0xFF);

            // Color: RRRGGGBB format (3 bits red, 3 bits green, 2 bits blue)
            // Convert 8-bit colors to packed format
            uint8_t r3 = (cmd.r * 7) / 255;  // Scale 0-255 to 0-7
            uint8_t g3 = (cmd.g * 7) / 255;  // Scale 0-255 to 0-7
            uint8_t b2 = (cmd.b * 3) / 255;  // Scale 0-255 to 0-3
            uint8_t color = (r3 << 5) | (g3 << 2) | b2;
            data.push_back(color);
        }

        // Build the complete framed packet
        // Format: [SOH, length, checksum, STX, ...data..., ETX]
        uint8_t dataLength = data.size();

        // Calculate checksum (XOR of all data bytes with 0xFF)
        uint8_t checksum = 0;
        for (uint8_t byte : data) {
            checksum = (checksum + byte) & 0xFF;
        }
        checksum ^= 0xFF;

        std::vector<uint8_t> packet;
        packet.push_back(FRAME_SOH);      // 0x01
        packet.push_back(dataLength);     // Length of data
        packet.push_back(checksum);       // Checksum
        packet.push_back(FRAME_STX);      // 0x02
        packet.insert(packet.end(), data.begin(), data.end());
        packet.push_back(FRAME_ETX);      // 0x03

        packets.push_back(packet);
        ledIndex += ledsInThisPacket;
    }
}

bool AuroraProtocol::processMessage(uint8_t command, const uint8_t* data, size_t length) {
    std::vector<LedCommand> commands;

    // Determine API version from command and decode accordingly
    bool isV2 = (command == CMD_V2_PACKET_ONLY || command == CMD_V2_PACKET_FIRST || command == CMD_V2_PACKET_MIDDLE ||
                 command == CMD_V2_PACKET_LAST);

    if (isV2) {
        decodeLedDataV2(data, length, commands);
    } else {
        decodeLedDataV3(data, length, commands);
    }

    switch (command) {
        // Single packet commands (complete message)
        case CMD_V2_PACKET_ONLY:  // 'P' (80)
        case CMD_V3_PACKET_ONLY:  // 'T' (84)
            ledCommands = commands;
            if (debugEnabled) {
                Logger.logln("[Aurora] Single packet complete: %zu LEDs", ledCommands.size());
            }
            return true;

        // First packet of multi-packet sequence
        case CMD_V2_PACKET_FIRST:  // 'N' (78)
        case CMD_V3_PACKET_FIRST:  // 'R' (82)
            pendingCommands = commands;
            multiPacketInProgress = true;
            if (debugEnabled) {
                Logger.logln("[Aurora] Multi-packet START: %zu LEDs", pendingCommands.size());
            }
            return false;

        // Middle packet of multi-packet sequence
        case CMD_V2_PACKET_MIDDLE:  // 'M' (77)
        case CMD_V3_PACKET_MIDDLE:  // 'Q' (81)
            if (multiPacketInProgress) {
                pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.end());
                if (debugEnabled) {
                    Logger.logln("[Aurora] Multi-packet MIDDLE: +%zu LEDs (total: %zu)", commands.size(),
                                 pendingCommands.size());
                }
            } else if (debugEnabled) {
                Logger.logln("[Aurora] WARNING: Middle packet without start");
            }
            return false;

        // Last packet of multi-packet sequence
        case CMD_V2_PACKET_LAST:  // 'O' (79)
        case CMD_V3_PACKET_LAST:  // 'S' (83)
            if (multiPacketInProgress) {
                pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.end());
                ledCommands = pendingCommands;
                pendingCommands.clear();
                multiPacketInProgress = false;
                if (debugEnabled) {
                    Logger.logln("[Aurora] Multi-packet END: %zu total LEDs", ledCommands.size());
                }
                return true;
            } else if (debugEnabled) {
                Logger.logln("[Aurora] WARNING: End packet without start");
            }
            return false;

        default:
            if (debugEnabled) {
                Logger.logln("[Aurora] Unknown command: '%c' (0x%02X)", command, command);
            }
            return false;
    }
}
