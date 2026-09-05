// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef BLE_CLIENT_H
#define BLE_CLIENT_H

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <vector>
#include <mutex>
#include "../config/board_config.h"
#include "../led/led_controller.h"

// Scan result structure for discovered boards
struct ScannedBoard {
    String address;      // MAC address
    String name;         // Device name
    int rssi;            // Signal strength
    bool hasAuroraUuid;  // Has Aurora advertised UUID
};

/**
 * BLE Client for Proxy Mode
 * Connects to official Kilter/Tension boards as a client and forwards LED commands
 */
class BleClient : public NimBLEClientCallbacks, public NimBLEAdvertisedDeviceCallbacks {
public:
    BleClient();

    // Initialize BLE client (call after NimBLEDevice::init())
    bool begin();

    // Stop BLE client
    void stop();

    // Scan for nearby Kilter boards
    // Returns list of discovered boards
    std::vector<ScannedBoard> scan(int durationSeconds = BLE_SCAN_DURATION_SECONDS);

    // Connect to a board by MAC address
    bool connect(const String& address);

    // Disconnect from currently connected board
    void disconnect();

    // Check if connected to a board
    bool isConnected();

    // Get connected board's MAC address
    String getConnectedAddress();

    // Send LED commands to connected board (encodes using Aurora protocol)
    bool sendLedCommands(const LedCommand* commands, int count);

    // Process loop - handles reconnection and keepalive
    void loop();

    // Client callbacks
    void onConnect(NimBLEClient* pClient) override;
    void onDisconnect(NimBLEClient* pClient) override;

    // Scan callbacks
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override;

private:
    NimBLEClient* pClient;
    NimBLERemoteService* pRemoteService;
    NimBLERemoteCharacteristic* pRemoteRxChar;  // The board's RX characteristic (we write to it)
    NimBLEScan* pScan;

    // Mutex to protect shared state accessed by both BLE callbacks and main thread
    std::mutex connectionMutex;

    // Note: clientConnected is marked volatile because it's modified by NimBLE callbacks
    // which may run in a different context (BLE task). This ensures visibility across contexts.
    volatile bool clientConnected;
    String targetAddress;        // MAC address we're trying to connect to
    String connectedAddress;     // MAC address we're currently connected to
    unsigned long lastReconnectAttempt;
    bool autoReconnect;

    // Scan state
    std::vector<ScannedBoard> scanResults;
    bool scanComplete;
    volatile bool scanInProgress;  // Guard against concurrent scans

    // Negotiated MTU size (updated after connection)
    uint16_t negotiatedMtu;

    // Internal methods
    bool connectToServer();
    void encodeAndSendPacket(NimBLERemoteCharacteristic* pChar, const uint8_t* data, size_t length, uint8_t command);
};

// Global BLE client instance
extern BleClient bleClient;

#endif // BLE_CLIENT_H
