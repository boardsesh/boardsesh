// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "aurora_protocol.h"

AuroraProtocol::AuroraProtocol()
    : currentAngle(0), multiPacketInProgress(false), multiPacketStartTime(0) {}

void AuroraProtocol::clear() {
    rawBuffer.clear();
    ledCommands.clear();
    pendingCommands.clear();
    currentAngle = 0;
    multiPacketInProgress = false;
    multiPacketStartTime = 0;
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
    // Check for buffer overflow - clear if adding would exceed max
    if (rawBuffer.size() + length > MAX_RAW_BUFFER_SIZE) {
        if (DEBUG_BLE) {
            Serial.printf("[BLE] Buffer overflow prevented: %zu + %zu > %d, clearing\n",
                          rawBuffer.size(), length, MAX_RAW_BUFFER_SIZE);
        }
        clear();
    }

    // Check for multi-packet timeout
    if (multiPacketInProgress) {
        unsigned long now = millis();
        if (now - multiPacketStartTime > MULTI_PACKET_TIMEOUT_MS) {
            if (DEBUG_BLE) {
                Serial.println("[BLE] Multi-packet sequence timed out, clearing");
            }
            clear();
        }
    }

    // Add new data to buffer
    for (size_t i = 0; i < length; i++) {
        rawBuffer.push_back(data[i]);
    }

    if (DEBUG_BLE) {
        Serial.printf("[BLE] Buffer size: %zu bytes (added %zu)\n", rawBuffer.size(), length);

        // Print first few bytes for debugging
        Serial.print("[BLE] Buffer start: ");
        for (size_t i = 0; i < min((size_t)20, rawBuffer.size()); i++) {
            Serial.printf("%02X ", rawBuffer[i]);
        }
        Serial.println();
    }

    // Try to extract and process complete messages
    return tryProcessBuffer();
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
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Skipping byte 0x%02X (not SOH)\n", rawBuffer[0]);
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

        if (DEBUG_BLE) {
            Serial.printf("[BLE] Frame: SOH found, dataLength=%d, frameSize=%zu, bufferSize=%zu\n",
                          dataLength, frameSize, rawBuffer.size());
        }

        // Check if we have the complete frame
        if (rawBuffer.size() < frameSize) {
            if (DEBUG_BLE) {
                Serial.println("[BLE] Incomplete frame, waiting for more data");
            }
            break;  // Wait for more data
        }

        // Verify STX at position 3
        if (rawBuffer[3] != FRAME_STX) {
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Invalid frame: expected STX at pos 3, got 0x%02X\n", rawBuffer[3]);
            }
            // Skip SOH and try again
            rawBuffer.erase(rawBuffer.begin());
            continue;
        }

        // Verify ETX at end
        if (rawBuffer[frameSize - 1] != FRAME_ETX) {
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Invalid frame: expected ETX at pos %zu, got 0x%02X\n",
                              frameSize - 1, rawBuffer[frameSize - 1]);
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
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Checksum mismatch: expected 0x%02X, got 0x%02X\n",
                              expectedChecksum, actualChecksum);
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

            if (DEBUG_BLE) {
                Serial.printf("[BLE] Valid frame: cmd='%c' (0x%02X), ledDataLen=%zu\n",
                              command, command, ledDataLength);
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

    if (DEBUG_BLE) {
        Serial.printf("[BLE] Decoding V2: %d LEDs from %zu bytes\n", ledCount, length);
    }

    for (int i = 0; i < ledCount; i++) {
        if (i * 2 + 1 >= length) break;

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

        if (DEBUG_BLE && i < 3) {
            Serial.printf("[BLE]   LED %d: pos=%d, R=%d G=%d B=%d\n",
                          i, position, r, g, b);
        }
    }
}

void AuroraProtocol::decodeLedDataV3(const uint8_t* data, size_t length, std::vector<LedCommand>& output) {
    // API v3 format: 3 bytes per LED
    // Byte 0: position_low
    // Byte 1: position_high
    // Byte 2: color (RRRGGGBB - 3 bits red, 3 bits green, 2 bits blue)

    int ledCount = length / 3;

    if (DEBUG_BLE) {
        Serial.printf("[BLE] Decoding V3: %d LEDs from %zu bytes\n", ledCount, length);
    }

    for (int i = 0; i < ledCount; i++) {
        if (i * 3 + 2 >= length) break;

        // Position is little-endian (low byte first)
        uint16_t position = data[i * 3] | (data[i * 3 + 1] << 8);
        uint8_t color = data[i * 3 + 2];

        // Decode color: RRRGGGBB format
        uint8_t r = ((color >> 5) & 0x07) * 36;  // 0-7 -> 0-252
        uint8_t g = ((color >> 2) & 0x07) * 36;  // 0-7 -> 0-252
        uint8_t b = (color & 0x03) * 85;          // 0-3 -> 0-255

        LedCommand cmd;
        cmd.position = position;
        cmd.r = r;
        cmd.g = g;
        cmd.b = b;
        output.push_back(cmd);

        if (DEBUG_BLE && i < 3) {
            Serial.printf("[BLE]   LED %d: pos=%d, R=%d G=%d B=%d\n",
                          i, position, r, g, b);
        }
    }
}

bool AuroraProtocol::processMessage(uint8_t command, const uint8_t* data, size_t length) {
    std::vector<LedCommand> commands;

    // Determine API version from command and decode accordingly
    bool isV2 = (command == CMD_V2_PACKET_ONLY || command == CMD_V2_PACKET_FIRST ||
                 command == CMD_V2_PACKET_MIDDLE || command == CMD_V2_PACKET_LAST);

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
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Single packet complete: %zu LEDs\n", ledCommands.size());
            }
            return true;

        // First packet of multi-packet sequence
        case CMD_V2_PACKET_FIRST:  // 'N' (78)
        case CMD_V3_PACKET_FIRST:  // 'R' (82)
            pendingCommands = commands;
            multiPacketInProgress = true;
            multiPacketStartTime = millis();  // Start timeout timer
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Multi-packet START: %zu LEDs\n", pendingCommands.size());
            }
            return false;

        // Middle packet of multi-packet sequence
        case CMD_V2_PACKET_MIDDLE:  // 'M' (77)
        case CMD_V3_PACKET_MIDDLE:  // 'Q' (81)
            if (multiPacketInProgress) {
                // Check bounds before adding more commands
                if (pendingCommands.size() + commands.size() > MAX_LED_COMMANDS) {
                    if (DEBUG_BLE) {
                        Serial.printf("[BLE] WARNING: Too many LEDs (%zu + %zu > %d), truncating\n",
                                      pendingCommands.size(), commands.size(), MAX_LED_COMMANDS);
                    }
                    size_t canAdd = MAX_LED_COMMANDS - pendingCommands.size();
                    pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.begin() + canAdd);
                } else {
                    pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.end());
                }
                if (DEBUG_BLE) {
                    Serial.printf("[BLE] Multi-packet MIDDLE: +%zu LEDs (total: %zu)\n",
                                  commands.size(), pendingCommands.size());
                }
            } else if (DEBUG_BLE) {
                Serial.println("[BLE] WARNING: Middle packet without start");
            }
            return false;

        // Last packet of multi-packet sequence
        case CMD_V2_PACKET_LAST:  // 'O' (79)
        case CMD_V3_PACKET_LAST:  // 'S' (83)
            if (multiPacketInProgress) {
                // Check bounds before adding final commands
                if (pendingCommands.size() + commands.size() > MAX_LED_COMMANDS) {
                    if (DEBUG_BLE) {
                        Serial.printf("[BLE] WARNING: Too many LEDs (%zu + %zu > %d), truncating\n",
                                      pendingCommands.size(), commands.size(), MAX_LED_COMMANDS);
                    }
                    size_t canAdd = MAX_LED_COMMANDS - pendingCommands.size();
                    pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.begin() + canAdd);
                } else {
                    pendingCommands.insert(pendingCommands.end(), commands.begin(), commands.end());
                }
                ledCommands = pendingCommands;
                pendingCommands.clear();
                multiPacketInProgress = false;
                multiPacketStartTime = 0;
                if (DEBUG_BLE) {
                    Serial.printf("[BLE] Multi-packet END: %zu total LEDs\n", ledCommands.size());
                }
                return true;
            } else if (DEBUG_BLE) {
                Serial.println("[BLE] WARNING: End packet without start");
            }
            return false;

        default:
            if (DEBUG_BLE) {
                Serial.printf("[BLE] Unknown command: '%c' (0x%02X)\n", command, command);
            }
            return false;
    }
}
