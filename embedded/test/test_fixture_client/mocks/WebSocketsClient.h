#pragma once

#include "Arduino.h"
#include <functional>
#include <string>

enum WStype_t {
    WStype_ERROR, WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT,
    WStype_FRAGMENT_TEXT_START, WStype_FRAGMENT, WStype_FRAGMENT_FIN
};

class WebSocketsClient {
  public:
    enum class Outcome { WaitingForUpgrade, RejectUpgrade, FailTcp };
    inline static WebSocketsClient* latest = nullptr;

    WebSocketsClient() { latest = this; }
    void onEvent(std::function<void(WStype_t, uint8_t*, size_t)> handler) { callback = handler; }
    void setExtraHeaders(const char* headers) { extraHeaders = headers ? headers : ""; }
    void setReconnectInterval(unsigned long interval) { reconnectInterval = interval; }
    void enableHeartbeat(unsigned long, unsigned long, unsigned int) {}
    void beginSslWithBundle(const char* newHost, uint16_t newPort, const char* newPath,
                            const uint8_t* newBundle, size_t newBundleSize, const char* newProtocol) {
        ++beginCount;
        host = newHost;
        port = newPort;
        path = newPath;
        bundle = newBundle;
        bundleSize = newBundleSize;
        protocol = newProtocol;
        configured = true;
        allocated = connected = pendingUpgrade = false;
        lastConnectionFail = 0; // The installed library resets this in begin().
    }
    void loop() {
        if (!configured)
            return;
        if (allocated && !connected) {
            allocated = false;
            lastConnectionFail = millis();
            emitDisconnected();
            // The real library continues after this callback. A zero cooldown
            // permits another TCP attempt even if the owner stopped running.
        }
        if (!connected) {
            if (millis() - lastConnectionFail < reconnectInterval)
                return;
            ++connectionAttempts;
            allocated = true;
            if (outcome == Outcome::FailTcp) {
                lastConnectionFail = millis();
                return; // connectFailedCb() does not emit an event.
            }
            connected = true;
            pendingUpgrade = true;
            return;
        }
        if (pendingUpgrade && outcome == Outcome::RejectUpgrade) {
            pendingUpgrade = false;
            lastConnectionFail = millis();
            allocated = connected = false;
            emitDisconnected();
        }
    }
    void disconnect() {
        const bool wasConnected = connected;
        configured = allocated = connected = pendingUpgrade = false;
        if (wasConnected)
            emitDisconnected();
    }
    bool sendTXT(const String&) { return connected; }

    std::string extraHeaders = "Origin: file://";
    unsigned long reconnectInterval = 60000;
    Outcome outcome = Outcome::WaitingForUpgrade;
    unsigned beginCount = 0;
    unsigned connectionAttempts = 0;
    std::string host, path, protocol;
    uint16_t port = 0;
    const uint8_t* bundle = nullptr;
    size_t bundleSize = 0;

  private:
    std::function<void(WStype_t, uint8_t*, size_t)> callback;
    bool configured = false;
    bool allocated = false;
    bool connected = false;
    bool pendingUpgrade = false;
    unsigned long lastConnectionFail = 0;
    void emitDisconnected() {
        if (callback)
            callback(WStype_DISCONNECTED, nullptr, 0);
    }
};
