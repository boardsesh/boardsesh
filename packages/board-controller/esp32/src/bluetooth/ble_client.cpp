// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "ble_client.h"
#include "aurora_encoding.h"

// Global instance
BleClient bleClient;

// Maximum scan results to prevent memory exhaustion in dense BLE environments
#define MAX_SCAN_RESULTS 50

// Default MTU data size (conservative, will be updated after MTU negotiation)
#define DEFAULT_MTU_DATA_SIZE 20
// Maximum MTU we'll request from the device
#define REQUESTED_MTU 185
// Frame overhead: SOH + length + checksum + STX + command + ETX = 6 bytes
#define FRAME_OVERHEAD 6

BleClient::BleClient()
    : pClient(nullptr),
      pRemoteService(nullptr),
      pRemoteRxChar(nullptr),
      pScan(nullptr),
      clientConnected(false),
      lastReconnectAttempt(0),
      autoReconnect(true),
      scanComplete(false),
      scanInProgress(false),
      negotiatedMtu(DEFAULT_MTU_DATA_SIZE) {}

bool BleClient::begin() {
    Serial.println("[BLE-Client] Initializing BLE client...");

    // Create BLE client
    pClient = NimBLEDevice::createClient();
    pClient->setClientCallbacks(this);

    // Set connection parameters for reliability
    pClient->setConnectionParams(12, 12, 0, 51);  // min, max interval, latency, timeout

    Serial.println("[BLE-Client] BLE client initialized");
    return true;
}

void BleClient::stop() {
    if (clientConnected) {
        disconnect();
    }
    if (pClient) {
        NimBLEDevice::deleteClient(pClient);
        pClient = nullptr;
    }
    Serial.println("[BLE-Client] BLE client stopped");
}

std::vector<ScannedBoard> BleClient::scan(int durationSeconds) {
    // Guard against concurrent scans
    if (scanInProgress) {
        Serial.println("[BLE-Client] Scan already in progress, returning empty results");
        return std::vector<ScannedBoard>();
    }

    scanInProgress = true;
    Serial.printf("[BLE-Client] Starting scan for %d seconds...\n", durationSeconds);

    scanResults.clear();
    scanComplete = false;

    pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(this);
    pScan->setActiveScan(true);
    pScan->setInterval(97);
    pScan->setWindow(37);

    // Start blocking scan
    NimBLEScanResults results = pScan->start(durationSeconds, false);

    scanInProgress = false;
    Serial.printf("[BLE-Client] Scan complete, found %d devices\n", scanResults.size());

    // Filter to only return boards with Aurora UUID
    std::vector<ScannedBoard> kilterBoards;
    for (const auto& board : scanResults) {
        if (board.hasAuroraUuid) {
            kilterBoards.push_back(board);
            Serial.printf("[BLE-Client]   Kilter board: %s (%s) RSSI: %d\n",
                          board.name.c_str(), board.address.c_str(), board.rssi);
        }
    }

    return kilterBoards;
}

void BleClient::onResult(NimBLEAdvertisedDevice* advertisedDevice) {
    // Prevent memory exhaustion in dense BLE environments
    if (scanResults.size() >= MAX_SCAN_RESULTS) {
        return;
    }

    ScannedBoard board;
    board.address = advertisedDevice->getAddress().toString().c_str();
    board.name = advertisedDevice->haveName() ? advertisedDevice->getName().c_str() : "";
    board.rssi = advertisedDevice->getRSSI();
    board.hasAuroraUuid = advertisedDevice->haveServiceUUID() &&
                          advertisedDevice->isAdvertisingService(NimBLEUUID(AURORA_ADVERTISED_UUID));

    // Only add boards with Aurora UUID or "Kilter" in the name
    if (board.hasAuroraUuid ||
        board.name.indexOf("Kilter") >= 0 ||
        board.name.indexOf("Tension") >= 0) {
        scanResults.push_back(board);
    }
}

bool BleClient::connect(const String& address) {
    Serial.printf("[BLE-Client] Connecting to %s...\n", address.c_str());

    targetAddress = address;

    // Disconnect if already connected to something else
    if (clientConnected && connectedAddress != address) {
        disconnect();
    }

    if (clientConnected && connectedAddress == address) {
        Serial.println("[BLE-Client] Already connected to this board");
        return true;
    }

    return connectToServer();
}

bool BleClient::connectToServer() {
    if (!pClient) {
        Serial.println("[BLE-Client] Client not initialized");
        return false;
    }

    NimBLEAddress addr(targetAddress.c_str());

    // Connect to the board
    if (!pClient->connect(addr)) {
        Serial.println("[BLE-Client] Connection failed");
        return false;
    }

    Serial.println("[BLE-Client] Connected, negotiating MTU...");

    // Negotiate MTU for larger packet sizes
    uint16_t mtu = pClient->getMTU();
    if (mtu < REQUESTED_MTU) {
        // Request larger MTU
        if (pClient->exchangeMTU(REQUESTED_MTU)) {
            mtu = pClient->getMTU();
        }
    }
    // MTU includes 3 bytes ATT overhead, usable data is MTU - 3
    negotiatedMtu = (mtu > 3) ? (mtu - 3) : DEFAULT_MTU_DATA_SIZE;
    Serial.printf("[BLE-Client] Negotiated MTU: %d, usable data size: %d\n", mtu, negotiatedMtu);

    Serial.println("[BLE-Client] Discovering services...");

    // Use local variables for discovery to avoid holding mutex during BLE operations
    NimBLERemoteService* service = pClient->getService(NORDIC_UART_SERVICE_UUID);
    if (!service) {
        Serial.println("[BLE-Client] Failed to find Nordic UART service");
        pClient->disconnect();
        return false;
    }

    // Get RX characteristic (we write LED data to this)
    NimBLERemoteCharacteristic* rxChar = service->getCharacteristic(NORDIC_UART_RX_UUID);
    if (!rxChar) {
        Serial.println("[BLE-Client] Failed to find RX characteristic");
        pClient->disconnect();
        return false;
    }

    // Verify we can write to it
    if (!rxChar->canWrite() && !rxChar->canWriteNoResponse()) {
        Serial.println("[BLE-Client] RX characteristic is not writable");
        pClient->disconnect();
        return false;
    }

    // Update shared state under lock
    {
        std::lock_guard<std::mutex> lock(connectionMutex);
        pRemoteService = service;
        pRemoteRxChar = rxChar;
        connectedAddress = targetAddress;
        clientConnected = true;
    }
    autoReconnect = true;

    Serial.printf("[BLE-Client] Successfully connected to %s\n", connectedAddress.c_str());

    return true;
}

void BleClient::disconnect() {
    autoReconnect = false;

    if (pClient && pClient->isConnected()) {
        pClient->disconnect();
    }

    {
        std::lock_guard<std::mutex> lock(connectionMutex);
        clientConnected = false;
        connectedAddress = "";
        pRemoteService = nullptr;
        pRemoteRxChar = nullptr;
    }

    Serial.println("[BLE-Client] Disconnected");
}

bool BleClient::isConnected() {
    return clientConnected && pClient && pClient->isConnected();
}

String BleClient::getConnectedAddress() {
    return connectedAddress;
}

void BleClient::onConnect(NimBLEClient* pClient) {
    Serial.println("[BLE-Client] Connected callback");
    clientConnected = true;
}

void BleClient::onDisconnect(NimBLEClient* pClient) {
    Serial.println("[BLE-Client] Disconnected callback");
    {
        std::lock_guard<std::mutex> lock(connectionMutex);
        clientConnected = false;
        pRemoteService = nullptr;
        pRemoteRxChar = nullptr;
    }
}

void BleClient::loop() {
    // Handle auto-reconnection
    if (autoReconnect && !clientConnected && targetAddress.length() > 0) {
        unsigned long now = millis();
        if (now - lastReconnectAttempt > BLE_CLIENT_RECONNECT_INTERVAL) {
            lastReconnectAttempt = now;
            Serial.println("[BLE-Client] Attempting reconnection...");
            connectToServer();
        }
    }
}

void BleClient::encodeAndSendPacket(NimBLERemoteCharacteristic* pChar, const uint8_t* ledData, size_t ledDataLength, uint8_t command) {
    // Frame format: [SOH, length, checksum, STX, command, ...ledData..., ETX]
    // Length = 1 (command) + ledDataLength
    size_t dataLength = 1 + ledDataLength;  // command + LED data

    // Build the data portion (command + LED data)
    std::vector<uint8_t> data(dataLength);
    data[0] = command;
    memcpy(&data[1], ledData, ledDataLength);

    // Calculate checksum over data using shared function
    uint8_t checksum = aurora_calculateChecksum(data.data(), dataLength);

    // Build complete frame
    std::vector<uint8_t> frame;
    frame.push_back(AURORA_FRAME_SOH);
    frame.push_back(static_cast<uint8_t>(dataLength));
    frame.push_back(checksum);
    frame.push_back(AURORA_FRAME_STX);
    frame.insert(frame.end(), data.begin(), data.end());
    frame.push_back(AURORA_FRAME_ETX);

    // Send frame using the captured characteristic pointer
    if (pChar->canWriteNoResponse()) {
        pChar->writeValue(frame.data(), frame.size(), false);
    } else {
        pChar->writeValue(frame.data(), frame.size(), true);
    }

    if (DEBUG_BLE) {
        Serial.printf("[BLE-Client] Sent packet: cmd='%c', %zu LED bytes, %zu total bytes\n",
                      command, ledDataLength, frame.size());
    }
}

bool BleClient::sendLedCommands(const LedCommand* commands, int count) {
    // Capture characteristic pointer under lock to avoid race with disconnect callback
    NimBLERemoteCharacteristic* pChar = nullptr;
    uint16_t mtuDataSize = 0;
    {
        std::lock_guard<std::mutex> lock(connectionMutex);
        if (!clientConnected || !pRemoteRxChar) {
            Serial.println("[BLE-Client] Not connected, cannot send LED commands");
            return false;
        }
        pChar = pRemoteRxChar;
        mtuDataSize = negotiatedMtu;
    }

    if (count == 0) {
        Serial.println("[BLE-Client] No LED commands to send");
        return true;
    }

    Serial.printf("[BLE-Client] Encoding and sending %d LED commands\n", count);

    // Encode LED commands to API v3 format (3 bytes per LED)
    // Format: [pos_low, pos_high, color_byte]
    std::vector<uint8_t> ledData;
    ledData.reserve(count * 3);

    for (int i = 0; i < count; i++) {
        uint8_t encoded[3];
        aurora_encodeLedCommand(
            static_cast<uint16_t>(commands[i].position),
            commands[i].r,
            commands[i].g,
            commands[i].b,
            encoded
        );
        ledData.push_back(encoded[0]);
        ledData.push_back(encoded[1]);
        ledData.push_back(encoded[2]);
    }

    // Calculate how many LEDs fit per packet based on negotiated MTU
    // Account for frame overhead and command byte
    size_t maxDataPerPacket = (mtuDataSize > FRAME_OVERHEAD) ? (mtuDataSize - FRAME_OVERHEAD) : 20;
    size_t maxLedsPerPacket = maxDataPerPacket / 3;
    if (maxLedsPerPacket == 0) maxLedsPerPacket = 1;  // At least one LED per packet

    size_t totalLeds = count;
    size_t packetCount = (totalLeds + maxLedsPerPacket - 1) / maxLedsPerPacket;

    if (packetCount == 1) {
        // Single packet - use AURORA_CMD_V3_PACKET_ONLY ('T')
        encodeAndSendPacket(pChar, ledData.data(), ledData.size(), AURORA_CMD_V3_PACKET_ONLY);
    } else {
        // Multi-packet sequence
        size_t ledsSent = 0;
        for (size_t pkt = 0; pkt < packetCount; pkt++) {
            size_t ledsInPacket = std::min(maxLedsPerPacket, totalLeds - ledsSent);
            size_t byteOffset = ledsSent * 3;
            size_t byteCount = ledsInPacket * 3;

            uint8_t command;
            if (pkt == 0) {
                command = AURORA_CMD_V3_PACKET_FIRST;  // 'R'
            } else if (pkt == packetCount - 1) {
                command = AURORA_CMD_V3_PACKET_LAST;   // 'S'
            } else {
                command = AURORA_CMD_V3_PACKET_MIDDLE; // 'Q'
            }

            encodeAndSendPacket(pChar, &ledData[byteOffset], byteCount, command);
            ledsSent += ledsInPacket;

            // Small delay between packets
            delay(10);
        }
    }

    Serial.printf("[BLE-Client] Sent %zu LED commands in %zu packet(s)\n",
                  totalLeds, packetCount);

    return true;
}
