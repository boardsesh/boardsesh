// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "ble_server.h"
#include "../led/led_controller.h"

// Global instance
BleServer bleServer;

BleServer::BleServer()
    : pServer(nullptr),
      pUartService(nullptr),
      pRxCharacteristic(nullptr),
      pTxCharacteristic(nullptr),
      pAdvertising(nullptr),
      deviceConnected(false),
      connectedDeviceHandle(BLE_HS_CONN_HANDLE_NONE),
      lastSentHash(0),
      ledDataCallback(nullptr) {}

bool BleServer::begin(const char* deviceName) {
    Serial.println("[BLE] Initializing BLE server...");

    // Use provided device name or default to direct mode name
    const char* name = deviceName ? deviceName : BLE_DEVICE_NAME_DIRECT;

    // Initialize NimBLE
    NimBLEDevice::init(name);

    // Set power level
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    // Create server
    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(this);

    // Create Nordic UART Service
    pUartService = pServer->createService(NORDIC_UART_SERVICE_UUID);

    // Create RX characteristic (for receiving data from app)
    pRxCharacteristic = pUartService->createCharacteristic(
        NORDIC_UART_RX_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    pRxCharacteristic->setCallbacks(this);

    // Create TX characteristic (for sending data to app - not used currently)
    pTxCharacteristic = pUartService->createCharacteristic(
        NORDIC_UART_TX_UUID,
        NIMBLE_PROPERTY::NOTIFY
    );

    // Start service
    pUartService->start();

    // Set up advertising
    setupAdvertising();

    Serial.println("[BLE] BLE server started");
    Serial.printf("[BLE] Device name: %s\n", name);

    return true;
}

void BleServer::setupAdvertising() {
    pAdvertising = NimBLEDevice::getAdvertising();

    // Add Aurora's custom advertised UUID
    pAdvertising->addServiceUUID(AURORA_ADVERTISED_UUID);

    // Add Nordic UART service UUID
    pAdvertising->addServiceUUID(NORDIC_UART_SERVICE_UUID);

    // Set scan response data
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06);  // Connection interval min
    pAdvertising->setMaxPreferred(0x12);  // Connection interval max

    // Start advertising
    pAdvertising->start();

    Serial.println("[BLE] Advertising started");
}

void BleServer::stop() {
    if (pAdvertising) {
        pAdvertising->stop();
    }
    NimBLEDevice::deinit();
    Serial.println("[BLE] BLE server stopped");
}

bool BleServer::isConnected() {
    return deviceConnected;
}

void BleServer::setLedDataCallback(void (*callback)(const LedCommand* commands, int count, int angle)) {
    ledDataCallback = callback;
}

void BleServer::onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) {
    // If already connected, disconnect existing device first (single device only)
    if (deviceConnected && connectedDeviceHandle != BLE_HS_CONN_HANDLE_NONE) {
        Serial.println("[BLE] New device connecting, disconnecting existing device");
        pServer->disconnect(connectedDeviceHandle);
        lastSentHash = 0;
    }

    deviceConnected = true;
    connectedDeviceHandle = desc->conn_handle;
    connectedDeviceAddress = NimBLEAddress(desc->peer_ota_addr).toString().c_str();

    Serial.printf("[BLE] Device connected: %s\n", connectedDeviceAddress.c_str());

    // Flash green to indicate connection
    ledController.blink(0, 255, 0, 2, 100);

    // Do NOT restart advertising - single device only
}

void BleServer::onDisconnect(NimBLEServer* pServer) {
    deviceConnected = false;
    Serial.printf("[BLE] Device disconnected: %s\n", connectedDeviceAddress.c_str());

    connectedDeviceAddress = "";
    connectedDeviceHandle = BLE_HS_CONN_HANDLE_NONE;
    lastSentHash = 0;

    // Restart advertising
    pAdvertising->start();
    Serial.println("[BLE] Advertising restarted");

    // Flash red to indicate disconnection
    ledController.blink(255, 0, 0, 2, 100);
}

bool BleServer::shouldSendLedData(uint32_t hash) {
    if (!deviceConnected || lastSentHash == 0) {
        Serial.println("[BLE] shouldSendLedData: no device or no previous hash, allowing");
        return true;
    }

    bool shouldSend = (lastSentHash != hash);
    Serial.printf("[BLE] shouldSendLedData: lastHash=%u, newHash=%u, send=%s\n",
                  lastSentHash, hash, shouldSend ? "yes" : "no");
    return shouldSend;
}

void BleServer::updateLastSentHash(uint32_t hash) {
    if (deviceConnected) {
        lastSentHash = hash;
    }
}

void BleServer::disconnectClient() {
    if (deviceConnected && connectedDeviceHandle != BLE_HS_CONN_HANDLE_NONE) {
        Serial.printf("[BLE] Disconnecting client %s due to web climb change\n",
                      connectedDeviceAddress.c_str());
        pServer->disconnect(connectedDeviceHandle);
    }
}

void BleServer::clearLastSentHash() {
    lastSentHash = 0;
    Serial.println("[BLE] Cleared last sent hash");
}

void BleServer::onWrite(NimBLECharacteristic* pCharacteristic) {
    if (pCharacteristic != pRxCharacteristic) return;

    std::string value = pCharacteristic->getValue();
    if (value.length() == 0) return;

    if (DEBUG_BLE) {
        Serial.printf("[BLE] Received %zu bytes\n", value.length());
    }

    // Process the packet through Aurora protocol decoder
    bool complete = protocol.processPacket(
        (const uint8_t*)value.data(),
        value.length()
    );

    if (complete) {
        // Get decoded LED commands
        const std::vector<LedCommand>& commands = protocol.getLedCommands();

        if (commands.size() > 0) {
            // Update LEDs directly
            ledController.setLeds(commands.data(), commands.size());
            ledController.show();

            Serial.printf("[BLE] Updated %zu LEDs from Bluetooth\n", commands.size());

            // If callback is set, forward to backend
            if (ledDataCallback) {
                ledDataCallback(commands.data(), commands.size(), protocol.getAngle());
            }
        }
    }
}
