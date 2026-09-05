// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * WebSocketsClient Mock Header for Native Unit Testing
 *
 * Provides a mock WebSocket client to simulate WebSocket functionality
 * for testing GraphQL WebSocket client code.
 */

#ifndef WEBSOCKETSCLIENT_MOCK_H
#define WEBSOCKETSCLIENT_MOCK_H

#include "Arduino.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// WebSocket event types
typedef enum {
    WStype_ERROR,
    WStype_DISCONNECTED,
    WStype_CONNECTED,
    WStype_TEXT,
    WStype_BIN,
    WStype_FRAGMENT_TEXT_START,
    WStype_FRAGMENT_BIN_START,
    WStype_FRAGMENT,
    WStype_FRAGMENT_FIN,
    WStype_PING,
    WStype_PONG
} WStype_t;

typedef std::function<void(WStype_t type, uint8_t* payload, size_t length)> WebSocketClientEvent;

class WebSocketsClient {
  public:
    WebSocketsClient()
        : connected_(false), eventHandler_(nullptr), heartbeatInterval_(0), heartbeatTimeout_(0), heartbeatRetries_(0),
          reconnectInterval_(0) {}

    void onEvent(WebSocketClientEvent handler) { eventHandler_ = handler; }

    void begin(const char* host, uint16_t port, const char* path = "/", const char* protocol = "") {
        (void)protocol;
        host_ = host ? host : "";
        port_ = port;
        path_ = path ? path : "/";
    }

    void beginSSL(const char* host, uint16_t port, const char* path = "/", const char* protocol = "") {
        (void)protocol;
        host_ = host ? host : "";
        port_ = port;
        path_ = path ? path : "/";
        ssl_ = true;
    }

    void loop() {
        // In mock, do nothing - tests control events
    }

    void disconnect() {
        if (connected_) {
            connected_ = false;
            if (eventHandler_) {
                eventHandler_(WStype_DISCONNECTED, nullptr, 0);
            }
        }
    }

    bool isConnected() { return connected_; }

    void setExtraHeaders(const char* headers) { extraHeaders_ = headers ? headers : ""; }

    void enableHeartbeat(unsigned long interval, unsigned long timeout, unsigned int retries) {
        heartbeatInterval_ = interval;
        heartbeatTimeout_ = timeout;
        heartbeatRetries_ = retries;
    }

    void setReconnectInterval(unsigned long interval) { reconnectInterval_ = interval; }

    bool sendTXT(const String& payload) { return sendTXT(payload.c_str()); }

    bool sendTXT(const char* payload) {
        if (!connected_)
            return false;
        lastSentMessage_ = payload ? payload : "";
        sentMessages_.push_back(lastSentMessage_);
        return true;
    }

    bool sendBIN(const uint8_t* payload, size_t length) {
        if (!connected_)
            return false;
        (void)payload;
        (void)length;
        return true;
    }

    // Test control methods
    void mockConnect() {
        connected_ = true;
        if (eventHandler_) {
            std::string url = path_;
            eventHandler_(WStype_CONNECTED, (uint8_t*)url.c_str(), url.length());
        }
    }

    void mockDisconnect() {
        connected_ = false;
        if (eventHandler_) {
            eventHandler_(WStype_DISCONNECTED, nullptr, 0);
        }
    }

    void mockReceiveText(const char* message) {
        if (eventHandler_) {
            eventHandler_(WStype_TEXT, (uint8_t*)message, strlen(message));
        }
    }

    void mockReceivePing() {
        if (eventHandler_) {
            eventHandler_(WStype_PING, nullptr, 0);
        }
    }

    void mockReceivePong() {
        if (eventHandler_) {
            eventHandler_(WStype_PONG, nullptr, 0);
        }
    }

    void mockError() {
        if (eventHandler_) {
            eventHandler_(WStype_ERROR, nullptr, 0);
        }
    }

    void mockReset() {
        connected_ = false;
        lastSentMessage_ = "";
        sentMessages_.clear();
        host_ = "";
        port_ = 0;
        path_ = "/";
        ssl_ = false;
        extraHeaders_ = "";
    }

    // Test inspection methods
    const std::string& getLastSentMessage() const { return lastSentMessage_; }
    const std::vector<std::string>& getSentMessages() const { return sentMessages_; }
    const std::string& getHost() const { return host_; }
    uint16_t getPort() const { return port_; }
    const std::string& getPath() const { return path_; }
    bool isSSL() const { return ssl_; }
    const std::string& getExtraHeaders() const { return extraHeaders_; }
    unsigned long getHeartbeatInterval() const { return heartbeatInterval_; }
    unsigned long getReconnectInterval() const { return reconnectInterval_; }
    size_t getSentMessageCount() const { return sentMessages_.size(); }
    void clearSentMessages() {
        sentMessages_.clear();
        lastSentMessage_ = "";
    }

  private:
    bool connected_;
    bool ssl_ = false;
    WebSocketClientEvent eventHandler_;
    std::string lastSentMessage_;
    std::vector<std::string> sentMessages_;
    std::string host_;
    uint16_t port_ = 0;
    std::string path_;
    std::string extraHeaders_;
    unsigned long heartbeatInterval_;
    unsigned long heartbeatTimeout_;
    unsigned int heartbeatRetries_;
    unsigned long reconnectInterval_;
};

#endif  // WEBSOCKETSCLIENT_MOCK_H
