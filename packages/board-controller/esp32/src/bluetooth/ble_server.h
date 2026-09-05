// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef BLE_SERVER_H
#define BLE_SERVER_H

#include <Arduino.h>
#include <NimBLEDevice.h>
#include "../config/board_config.h"
#include "aurora_protocol.h"

/**
 * BLE Server
 * Implements Nordic UART Service compatible with official Kilter/Tension apps
 * Supports only one active Bluetooth device at a time
 */
class BleServer : public NimBLEServerCallbacks, public NimBLECharacteristicCallbacks {
public:
    BleServer();

    // Initialize BLE server with optional custom device name
    // In proxy mode, use "Kilter BoardSesh" instead of "Kilter Board"
    bool begin(const char* deviceName = nullptr);

    // Stop BLE server
    void stop();

    // Check if a device is connected
    bool isConnected();

    // Set callback for when LED data is received from Bluetooth
    void setLedDataCallback(void (*callback)(const LedCommand* commands, int count, int angle));

    // Server callbacks
    void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override;
    void onDisconnect(NimBLEServer* pServer) override;

    // Characteristic callbacks
    void onWrite(NimBLECharacteristic* pCharacteristic) override;

private:
    NimBLEServer* pServer;
    NimBLEService* pUartService;
    NimBLECharacteristic* pRxCharacteristic;
    NimBLECharacteristic* pTxCharacteristic;
    NimBLEAdvertising* pAdvertising;

    AuroraProtocol protocol;
    bool deviceConnected;
    String connectedDeviceAddress;  // MAC address of currently connected device
    uint16_t connectedDeviceHandle; // Connection handle for programmatic disconnect
    uint32_t lastSentHash;          // Hash of last sent LED data for deduplication

    void (*ledDataCallback)(const LedCommand* commands, int count, int angle);

    void setupAdvertising();

public:
    // Get the current connected device's MAC address
    String getConnectedDeviceAddress() { return connectedDeviceAddress; }

    // Check if we should send this LED data (deduplication)
    bool shouldSendLedData(uint32_t hash);

    // Update the last sent hash for the connected device
    void updateLastSentHash(uint32_t hash);

    // Disconnect the current Bluetooth client (called when web changes climb)
    void disconnectClient();

    // Clear the last sent hash (called after web climb change)
    void clearLastSentHash();
};

// Global BLE server instance
extern BleServer bleServer;

#endif // BLE_SERVER_H
