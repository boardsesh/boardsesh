// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef WS_CLIENT_H
#define WS_CLIENT_H

#include <Arduino.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "../config/board_config.h"
#include "../config/config_manager.h"
#include "../led/led_controller.h"
#include "../utils/log_buffer.h"

/**
 * WebSocket Client State
 */
enum class WsState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    SUBSCRIBING,
    SUBSCRIBED
};

/**
 * WebSocket Client
 * Connects to BoardSesh backend using graphql-ws protocol
 */
class WsClient {
public:
    WsClient();

    // Initialize and start connection
    bool begin();

    // Process WebSocket events (call in loop)
    void loop();

    // Check connection state
    bool isConnected();
    bool isSubscribed();
    WsState getState();

    // Manually reconnect
    void reconnect();

    // Disconnect
    void disconnect();

    // Send heartbeat to backend
    void sendHeartbeat();

    // Send LED positions from Bluetooth to backend (to match climb)
    // Backend converts positions to frames string for matching
    void sendLedPositions(const LedCommand* commands, int count, int angle);

    // Buffer a log entry for sending to backend
    void bufferLog(const char* level, const char* component, const char* message);

    // Send buffered logs to backend (called periodically)
    void sendLogs();

    // Set session ID
    void setSessionId(const String& sessionId);

    // Get current session ID
    String getSessionId();

    // Set callback for when LED commands are received from backend
    // In proxy mode, this forwards to BLE client instead of local LEDs
    void setLedUpdateCallback(void (*callback)(const LedCommand* commands, int count));

private:
    WebSocketsClient webSocket;
    WsState state;
    String sessionId;
    String apiKey;
    String subscriptionId;
    unsigned long lastPingTime;
    unsigned long lastPongTime;
    unsigned long reconnectTime;
    uint32_t lastSentLedHash;      // Hash of last sent LED positions (to avoid duplicates)
    uint32_t currentDisplayHash;   // Hash of currently displayed LEDs (from backend LedUpdate)
    unsigned long lastLogSendTime; // Last time logs were sent to backend

    // Callback for LED updates (for proxy mode)
    void (*ledUpdateCallback)(const LedCommand* commands, int count);

    // Log send interval (10 seconds)
    static const unsigned long LOG_SEND_INTERVAL = 10000;

    // Parse URL into host, port, path
    void parseUrl(const String& url, String& host, uint16_t& port, String& path, bool& useSSL);

    // WebSocket event handler
    static void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);

    // GraphQL-WS protocol handlers
    void handleMessage(const String& message);
    void sendConnectionInit();
    void sendSubscribe();
    void sendPing();
    void handleLedUpdate(JsonObject& data);

    // Generate unique subscription ID
    String generateSubscriptionId();

    // Compute hash of LED positions for deduplication
    uint32_t computeLedHash(const LedCommand* commands, int count);
};

// Global WebSocket client instance
extern WsClient wsClient;

#endif // WS_CLIENT_H
