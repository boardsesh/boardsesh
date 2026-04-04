#ifndef NORDIC_UART_BLE_H
#define NORDIC_UART_BLE_H

#include <Arduino.h>
#include <NimBLEDevice.h>

#include <aurora_protocol.h>
#include <led_controller.h>
#include <map>

// Aurora boards advertise this service UUID for discovery by Kilter/Tension apps
#define AURORA_ADVERTISED_SERVICE_UUID "4488b571-7806-4df6-bcff-a2897e4953ff"

// Nordic UART Service UUIDs - used for actual communication
#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHARACTERISTIC "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_TX_CHARACTERISTIC "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

typedef void (*BLEConnectCallback)(bool connected);
typedef void (*BLEDataCallback)(const uint8_t* data, size_t len);
typedef void (*BLELedDataCallback)(const LedCommand* commands, int count, int angle);
typedef void (*BLERawForwardCallback)(const uint8_t* data, size_t len);

class NordicUartBLE : public NimBLEServerCallbacks, public NimBLECharacteristicCallbacks {
  public:
    NordicUartBLE();

    // Initialize BLE server. If startAdvertising is false, call startAdvertising() later.
    void begin(const char* deviceName, bool startAdv = true);
    void loop();

    // Start BLE advertising (public so proxy can call after board connection)
    void startAdvertising();

    bool isConnected();

    // Send data to connected client
    void send(const uint8_t* data, size_t len);
    void send(const String& str);

    // Callbacks
    void setConnectCallback(BLEConnectCallback callback);
    void setDataCallback(BLEDataCallback callback);
    void setLedDataCallback(BLELedDataCallback callback);

    // Raw data forwarding callback (called before Aurora protocol processing)
    // Used by BLE proxy to forward data to the actual board
    void setRawForwardCallback(BLERawForwardCallback callback);

    // Enable protocol decoder debug logging for packet/frame inspection.
    void setProtocolDebug(bool enabled);

    // NimBLE callbacks
    void onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) override;
    void onDisconnect(NimBLEServer* server, ble_gap_conn_desc* desc) override;
    void onWrite(NimBLECharacteristic* characteristic) override;

    // Get the current connected device's MAC address
    String getConnectedDeviceAddress() { return connectedDeviceAddress; }

    // Check if we should send this LED data for this MAC (deduplication per device)
    bool shouldSendLedData(uint32_t hash);

    // Update the last sent hash for the connected device
    void updateLastSentHash(uint32_t hash);

    // Disconnect the currently connected BLE client (when web takes over)
    void disconnectClient();

    // Clear the last sent hash (after disconnect)
    void clearLastSentHash();

  private:
    NimBLEServer* pServer;
    NimBLECharacteristic* pTxCharacteristic;
    NimBLECharacteristic* pRxCharacteristic;

    bool deviceConnected;
    bool advertising;
    bool advertisingEnabled;  // Whether advertising is allowed (false until proxy connects)
    String connectedDeviceAddress;                 // MAC address of currently connected device
    uint16_t connectedDeviceHandle;                // Connection handle for disconnect
    std::map<String, uint32_t> lastSentHashByMac;  // Track last sent hash per MAC address

    AuroraProtocol protocol;

    BLEConnectCallback connectCallback;
    BLEDataCallback dataCallback;
    BLELedDataCallback ledDataCallback;
    BLERawForwardCallback rawForwardCallback;
};

extern NordicUartBLE BLE;

#endif
