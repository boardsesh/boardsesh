#include "nordic_uart_ble.h"

#include <log_buffer.h>

NordicUartBLE BLE;

NordicUartBLE::NordicUartBLE()
    : pServer(nullptr), pTxCharacteristic(nullptr), pRxCharacteristic(nullptr), deviceConnected(false),
      advertising(false), advertisingEnabled(false), connectedDeviceHandle(BLE_HS_CONN_HANDLE_NONE),
      connectCallback(nullptr), dataCallback(nullptr), ledDataCallback(nullptr), rawForwardCallback(nullptr) {}

void NordicUartBLE::begin(const char* deviceName, bool startAdv) {
    NimBLEDevice::init(deviceName);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    // Set whether advertising is allowed (proxy mode delays this)
    advertisingEnabled = startAdv;

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(this);

    // Create Nordic UART Service
    NimBLEService* pService = pServer->createService(NUS_SERVICE_UUID);

    // Create TX characteristic (notify)
    pTxCharacteristic = pService->createCharacteristic(NUS_TX_CHARACTERISTIC, NIMBLE_PROPERTY::NOTIFY);

    // Create RX characteristic (write)
    pRxCharacteristic =
        pService->createCharacteristic(NUS_RX_CHARACTERISTIC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    pRxCharacteristic->setCallbacks(this);

    pService->start();

    // Always configure advertising data (even if not starting yet)
    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(AURORA_ADVERTISED_SERVICE_UUID);
    pAdvertising->addServiceUUID(NUS_SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06);
    pAdvertising->setMaxPreferred(0x12);

    // Always start the GATT server (required before advertising can work)
    // This registers the services - must be done even if not advertising yet
    // Use pServer->start() instead of ble_gatts_start() directly to set NimBLE's
    // internal m_gattsStarted flag, preventing duplicate start errors (rc=15)
    pServer->start();

    if (startAdv) {
        pAdvertising->start();
        advertising = true;
        advertisingEnabled = true;
        Logger.logln("BLE: Advertising started");
    }

    Logger.logln("BLE: Server started as '%s'", deviceName);
}

void NordicUartBLE::loop() {
    // Restart advertising if disconnected, not currently advertising, and allowed
    if (advertisingEnabled && !deviceConnected && !advertising) {
        delay(500);  // Small delay before re-advertising
        startAdvertising();
    }
}

bool NordicUartBLE::isConnected() {
    return deviceConnected;
}

void NordicUartBLE::send(const uint8_t* data, size_t len) {
    if (deviceConnected && pTxCharacteristic) {
        pTxCharacteristic->setValue(data, len);
        pTxCharacteristic->notify();
    }
}

void NordicUartBLE::send(const String& str) {
    send((const uint8_t*)str.c_str(), str.length());
}

void NordicUartBLE::setConnectCallback(BLEConnectCallback callback) {
    connectCallback = callback;
}

void NordicUartBLE::setDataCallback(BLEDataCallback callback) {
    dataCallback = callback;
}

void NordicUartBLE::setLedDataCallback(BLELedDataCallback callback) {
    ledDataCallback = callback;
}

void NordicUartBLE::setRawForwardCallback(BLERawForwardCallback callback) {
    rawForwardCallback = callback;
}

void NordicUartBLE::setProtocolDebug(bool enabled) {
    protocol.setDebug(enabled);
}

void NordicUartBLE::onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) {
    deviceConnected = true;
    advertising = false;

    // Get the connected device's MAC address and connection handle
    connectedDeviceAddress = NimBLEAddress(desc->peer_ota_addr).toString().c_str();
    connectedDeviceHandle = desc->conn_handle;
    Logger.logln("BLE: Device connected: %s (total: %d)", connectedDeviceAddress.c_str(), pServer->getConnectedCount());

    // Flash green to indicate connection
    LEDs.blink(0, 255, 0, 2, 100);

    if (connectCallback) {
        connectCallback(true);
    }

    // Restart advertising to allow more connections
    if (pServer->getConnectedCount() < CONFIG_BT_NIMBLE_MAX_CONNECTIONS) {
        NimBLEDevice::getAdvertising()->start();
        Logger.logln("BLE: Advertising restarted for more connections");
    }
}

void NordicUartBLE::onDisconnect(NimBLEServer* server, ble_gap_conn_desc* desc) {
    Logger.logln("BLE: Device disconnected: %s", connectedDeviceAddress.c_str());
    connectedDeviceAddress = "";
    connectedDeviceHandle = BLE_HS_CONN_HANDLE_NONE;
    deviceConnected = false;

    // Flash red to indicate disconnection
    LEDs.blink(255, 0, 0, 2, 100);

    if (connectCallback) {
        connectCallback(false);
    }

    // Restart advertising
    startAdvertising();
}

bool NordicUartBLE::shouldSendLedData(uint32_t hash) {
    if (connectedDeviceAddress.length() == 0) {
        Logger.logln("BLE: shouldSendLedData: no device address, allowing");
        return true;
    }

    auto it = lastSentHashByMac.find(connectedDeviceAddress);
    if (it == lastSentHashByMac.end()) {
        Logger.logln("BLE: shouldSendLedData: first time from %s, allowing", connectedDeviceAddress.c_str());
        return true;  // Never sent from this device before
    }

    bool shouldSend = (it->second != hash);
    Logger.logln("BLE: shouldSendLedData: %s, lastHash=%u, newHash=%u, send=%s", connectedDeviceAddress.c_str(),
                 it->second, hash, shouldSend ? "yes" : "no");
    return shouldSend;
}

void NordicUartBLE::updateLastSentHash(uint32_t hash) {
    if (connectedDeviceAddress.length() > 0) {
        lastSentHashByMac[connectedDeviceAddress] = hash;
    }
}

void NordicUartBLE::disconnectClient() {
    if (deviceConnected && connectedDeviceHandle != BLE_HS_CONN_HANDLE_NONE) {
        Logger.logln("BLE: Disconnecting client %s due to web climb change", connectedDeviceAddress.c_str());
        pServer->disconnect(connectedDeviceHandle);
    }
}

void NordicUartBLE::clearLastSentHash() {
    if (connectedDeviceAddress.length() > 0) {
        lastSentHashByMac.erase(connectedDeviceAddress);
    }
    Logger.logln("BLE: Cleared last sent hash");
}

void NordicUartBLE::onWrite(NimBLECharacteristic* characteristic) {
    if (characteristic != pRxCharacteristic)
        return;

    std::string value = characteristic->getValue();
    if (value.length() == 0)
        return;

    Logger.logln("BLE: Received %zu bytes", value.length());

    // Forward raw data to proxy if callback is set (before protocol processing)
    if (rawForwardCallback) {
        rawForwardCallback((const uint8_t*)value.data(), value.length());
    }

    // Process the packet through Aurora protocol decoder
    bool complete = protocol.processPacket((const uint8_t*)value.data(), value.length());

    if (complete) {
        // Get decoded LED commands
        const std::vector<LedCommand>& commands = protocol.getLedCommands();

        if (commands.size() > 0) {
            // Update LEDs directly
            LEDs.setLeds(commands.data(), commands.size());
            LEDs.show();

            Logger.logln("BLE: Updated %zu LEDs from Bluetooth", commands.size());

            // If callback is set, forward to backend
            if (ledDataCallback) {
                ledDataCallback(commands.data(), commands.size(), protocol.getAngle());
            }
        }
    }

    // Also call user callback if set
    if (dataCallback) {
        dataCallback((const uint8_t*)value.data(), value.length());
    }
}

void NordicUartBLE::startAdvertising() {
    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();

    // Start advertising (UUIDs and settings already configured in begin())
    pAdvertising->start();
    advertising = true;
    advertisingEnabled = true;  // Enable for future restarts in loop()

    Logger.logln("BLE: Advertising started");
}
