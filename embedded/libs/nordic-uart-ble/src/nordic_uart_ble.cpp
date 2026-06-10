#include "nordic_uart_ble.h"

#include <log_buffer.h>

NordicUartBLE BLE;

NordicUartBLE::NordicUartBLE()
    : pServer(nullptr), pTxCharacteristic(nullptr), pRxCharacteristic(nullptr), deviceConnected(false),
      advertising(false), advertisingEnabled(false), lastAdvertisingEnsureAt(0),
      connectedDeviceHandle(BLE_HS_CONN_HANDLE_NONE), connectCallback(nullptr), dataCallback(nullptr),
      ledDataCallback(nullptr), rawForwardCallback(nullptr) {}

void NordicUartBLE::begin(const char* deviceName, bool startAdv) {
    NimBLEDevice::init(deviceName);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    // Set whether advertising is allowed (proxy mode delays this)
    advertisingEnabled = startAdv;

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(this, false);

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
    // A legacy BLE advertisement only has 31 bytes. Advertising both 128-bit UUIDs
    // overflows the packet, so expose Aurora for discovery and keep NUS in GATT.
    pAdvertising->enableScanResponse(true);
    pAdvertising->setName(deviceName);
    pAdvertising->setPreferredParams(0x06, 0x12);

    // Always start the GATT server (required before advertising can work)
    // This registers the services - must be done even if not advertising yet
    // Use pServer->start() instead of ble_gatts_start() directly to set NimBLE's
    // internal m_gattsStarted flag, preventing duplicate start errors (rc=15)
    pServer->start();

    if (startAdv) {
        startAdvertising();
    }

    Logger.logln("BLE: Server started as '%s'", deviceName);
}

void NordicUartBLE::loop() {
    if (!advertisingEnabled || deviceConnected) {
        return;
    }

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    advertising = pAdvertising->isAdvertising();

    if (!advertising) {
        startAdvertising();
    }
}

bool NordicUartBLE::isConnected() {
    return deviceConnected;
}

bool NordicUartBLE::isAdvertising() {
    return advertising;
}

bool NordicUartBLE::isAdvertisingEnabled() const {
    return advertisingEnabled;
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

void NordicUartBLE::onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) {
    deviceConnected = true;
    advertising = false;

    // Get the connected device's MAC address and connection handle
    connectedDeviceAddress = connInfo.getAddress().toString().c_str();
    connectedDeviceHandle = connInfo.getConnHandle();
    Logger.logln("BLE: Device connected: %s (total: %d)", connectedDeviceAddress.c_str(), pServer->getConnectedCount());

    if (connectCallback) {
        connectCallback(true);
    }

    // Restart advertising to allow more connections
    if (pServer->getConnectedCount() < CONFIG_BT_NIMBLE_MAX_CONNECTIONS) {
        startAdvertising();
        Logger.logln("BLE: Advertising restarted for more connections");
    }
}

void NordicUartBLE::onDisconnect(NimBLEServer* server, NimBLEConnInfo& connInfo, int reason) {
    (void)server;
    (void)connInfo;

    Logger.logln("BLE: Device disconnected: %s (reason: %d)", connectedDeviceAddress.c_str(), reason);
    connectedDeviceAddress = "";
    connectedDeviceHandle = BLE_HS_CONN_HANDLE_NONE;
    deviceConnected = false;
    advertising = false;

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

void NordicUartBLE::onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) {
    (void)connInfo;

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

    if (pAdvertising->isAdvertising()) {
        advertising = true;
        lastAdvertisingEnsureAt = millis();
        return;
    }

    // Start advertising (UUIDs and settings already configured in begin())
    pAdvertising->start();
    advertising = pAdvertising->isAdvertising();
    advertisingEnabled = true;  // Enable for future restarts in loop()
    lastAdvertisingEnsureAt = millis();

    if (advertising) {
        Logger.logln("BLE: Advertising started");
    } else {
        Logger.logln("BLE: Advertising start requested but stack is not active");
    }
}
