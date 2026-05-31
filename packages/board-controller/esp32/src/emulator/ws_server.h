#ifndef EMULATOR_WS_SERVER_H
#define EMULATOR_WS_SERVER_H

#ifdef EMULATOR_BUILD

#include <Arduino.h>
#include <functional>

#include "ble_emulator.h"

// Callback when the web client requests a configuration change.
using ConfigChangeCallback = std::function<void(const EmulatorConfig& cfg)>;

class EmulatorWsServer {
public:
    bool begin(uint16_t port);
    void loop();

    // Broadcast a raw BLE write payload (in hex) to every connected client.
    void broadcastBleWrite(const uint8_t* data, size_t length);

    // Broadcast BLE central connection status.
    void broadcastBleConnection(bool connected);

    // Broadcast a fresh hello (used after re-config so clients display
    // current state). Includes the current config.
    void broadcastHello(const EmulatorConfig& cfg);

    void setMdnsHost(const String& host) { mdnsHost = host; }

    void setOnConfigChange(ConfigChangeCallback cb) { onConfig = std::move(cb); }

    // Internal — called by the file-scope WS callback in ws_server.cpp.
    void handleClientMessage(uint8_t clientId, const String& payload);
    void handleClientConnected(uint8_t clientId);

private:
    ConfigChangeCallback onConfig;
    String mdnsHost;
};

extern EmulatorWsServer wsServer;

#endif // EMULATOR_BUILD
#endif // EMULATOR_WS_SERVER_H
