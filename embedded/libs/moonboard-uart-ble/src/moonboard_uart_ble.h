// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef MOONBOARD_UART_BLE_H
#define MOONBOARD_UART_BLE_H

#include <Arduino.h>
#include <NimBLEDevice.h>

#include <moonboard_protocol.h>

#define MOONBOARD_NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define MOONBOARD_NUS_RX_CHARACTERISTIC "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define MOONBOARD_NUS_TX_CHARACTERISTIC "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

typedef void (*MoonBoardBLEConnectCallback)(bool connected);
typedef void (*MoonBoardBLEDataCallback)(const uint8_t* data, size_t len);
typedef void (*MoonBoardBLEProblemCallback)(const MoonBoardDecodedProblem& problem);

class MoonBoardUartBLE : public NimBLEServerCallbacks, public NimBLECharacteristicCallbacks {
  public:
    MoonBoardUartBLE();

    void begin(const char* deviceName, bool startAdv = true);
    void loop();
    void startAdvertising();

    bool isConnected();

    void send(const uint8_t* data, size_t len);
    void send(const String& str);

    void setConnectCallback(MoonBoardBLEConnectCallback callback);
    void setDataCallback(MoonBoardBLEDataCallback callback);
    void setProblemCallback(MoonBoardBLEProblemCallback callback);
    void setProtocolDebug(bool enabled);

    void onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) override;
    void onDisconnect(NimBLEServer* server, ble_gap_conn_desc* desc) override;
    void onWrite(NimBLECharacteristic* characteristic) override;

  private:
    NimBLEServer* server;
    NimBLECharacteristic* txCharacteristic;
    NimBLECharacteristic* rxCharacteristic;
    bool deviceConnected;
    bool advertising;
    bool advertisingEnabled;
    MoonBoardProtocol protocol;
    MoonBoardBLEConnectCallback connectCallback;
    MoonBoardBLEDataCallback dataCallback;
    MoonBoardBLEProblemCallback problemCallback;
};

extern MoonBoardUartBLE MoonBLE;

#endif
