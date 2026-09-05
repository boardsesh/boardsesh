// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "moonboard_uart_ble.h"

#include <led_controller.h>
#include <log_buffer.h>

MoonBoardUartBLE MoonBLE;

MoonBoardUartBLE::MoonBoardUartBLE()
    : server(nullptr), txCharacteristic(nullptr), rxCharacteristic(nullptr), deviceConnected(false), advertising(false),
      advertisingEnabled(false), connectCallback(nullptr), dataCallback(nullptr), problemCallback(nullptr) {}

void MoonBoardUartBLE::begin(const char* deviceName, bool startAdv) {
    NimBLEDevice::init(deviceName);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    advertisingEnabled = startAdv;

    server = NimBLEDevice::createServer();
    server->setCallbacks(this);

    NimBLEService* service = server->createService(MOONBOARD_NUS_SERVICE_UUID);
    txCharacteristic = service->createCharacteristic(MOONBOARD_NUS_TX_CHARACTERISTIC, NIMBLE_PROPERTY::NOTIFY);
    rxCharacteristic = service->createCharacteristic(
        MOONBOARD_NUS_RX_CHARACTERISTIC,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    rxCharacteristic->setCallbacks(this);
    service->start();

    NimBLEAdvertising* bleAdvertising = NimBLEDevice::getAdvertising();
    bleAdvertising->addServiceUUID(MOONBOARD_NUS_SERVICE_UUID);
    bleAdvertising->setScanResponse(true);
    bleAdvertising->setMinPreferred(0x06);
    bleAdvertising->setMaxPreferred(0x12);

    server->start();

    if (startAdv) {
        bleAdvertising->start();
        advertising = true;
        advertisingEnabled = true;
    }

    Logger.logln("MoonBoard BLE: Server started as '%s'", deviceName);
}

void MoonBoardUartBLE::loop() {
    if (advertisingEnabled && !deviceConnected && !advertising) {
        delay(500);
        startAdvertising();
    }
}

void MoonBoardUartBLE::startAdvertising() {
    NimBLEAdvertising* bleAdvertising = NimBLEDevice::getAdvertising();
    bleAdvertising->start();
    advertising = true;
    advertisingEnabled = true;
    Logger.logln("MoonBoard BLE: Advertising started");
}

bool MoonBoardUartBLE::isConnected() {
    return deviceConnected;
}

void MoonBoardUartBLE::send(const uint8_t* data, size_t len) {
    if (deviceConnected && txCharacteristic) {
        txCharacteristic->setValue(data, len);
        txCharacteristic->notify();
    }
}

void MoonBoardUartBLE::send(const String& str) {
    send(reinterpret_cast<const uint8_t*>(str.c_str()), str.length());
}

void MoonBoardUartBLE::setConnectCallback(MoonBoardBLEConnectCallback callback) {
    connectCallback = callback;
}

void MoonBoardUartBLE::setDataCallback(MoonBoardBLEDataCallback callback) {
    dataCallback = callback;
}

void MoonBoardUartBLE::setProblemCallback(MoonBoardBLEProblemCallback callback) {
    problemCallback = callback;
}

void MoonBoardUartBLE::setProtocolDebug(bool enabled) {
    protocol.setDebug(enabled);
}

void MoonBoardUartBLE::onConnect(NimBLEServer* bleServer, ble_gap_conn_desc* desc) {
    (void)bleServer;
    (void)desc;
    deviceConnected = true;
    advertising = false;

    LEDs.blink(0, 255, 0, 2, 100);

    if (connectCallback) {
        connectCallback(true);
    }

    if (server->getConnectedCount() < CONFIG_BT_NIMBLE_MAX_CONNECTIONS) {
        NimBLEDevice::getAdvertising()->start();
        Logger.logln("MoonBoard BLE: Advertising restarted for more connections");
    }
}

void MoonBoardUartBLE::onDisconnect(NimBLEServer* bleServer, ble_gap_conn_desc* desc) {
    (void)bleServer;
    (void)desc;
    deviceConnected = false;

    LEDs.blink(255, 0, 0, 2, 100);

    if (connectCallback) {
        connectCallback(false);
    }

    startAdvertising();
}

void MoonBoardUartBLE::onWrite(NimBLECharacteristic* characteristic) {
    if (characteristic != rxCharacteristic) {
        return;
    }

    const std::string value = characteristic->getValue();
    if (value.empty()) {
        return;
    }

    if (dataCallback) {
        dataCallback(reinterpret_cast<const uint8_t*>(value.data()), value.length());
    }

    const bool complete = protocol.processPacket(reinterpret_cast<const uint8_t*>(value.data()), value.length());
    if (!complete) {
        return;
    }

    const MoonBoardDecodedProblem& problem = protocol.getDecodedProblem();

    LEDs.clear();
    if (!problem.ledCommands.empty()) {
        LEDs.setLeds(problem.ledCommands.data(), problem.ledCommands.size());
    }
    LEDs.show();

    Logger.logln("MoonBoard BLE: Updated %zu LEDs from MoonBoard payload", problem.ledCommands.size());

    if (problemCallback) {
        problemCallback(problem);
    }
}
