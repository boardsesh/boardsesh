// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef GRAPHQL_WS_CLIENT_H
#define GRAPHQL_WS_CLIENT_H

#include <Arduino.h>
#include <ArduinoJson.h>

#include <WebSocketsClient.h>
#include <config_manager.h>
#include <led_controller.h>
#include <log_buffer.h>

// Forward declaration
class NordicUartBLE;

#define GQL_WS_PROTOCOL "graphql-transport-ws"

// WebSocket timing constants
#define WS_PING_INTERVAL 30000
#define WS_PONG_TIMEOUT 10000
#define WS_RECONNECT_INTERVAL 5000

enum class GraphQLConnectionState { DISCONNECTED, CONNECTING, CONNECTED, CONNECTION_INIT, CONNECTION_ACK, SUBSCRIBED };

// Forward declaration for queue sync data
struct ControllerQueueSyncData {
    static const int MAX_ITEMS = 150;
    struct Item {
        char uuid[37];
        char climbUuid[37];
        char name[32];
        char grade[12];
        char gradeColor[8];  // Hex color string
    };
    Item items[MAX_ITEMS];
    int count;
    int currentIndex;
};

typedef void (*GraphQLMessageCallback)(JsonDocument& doc);
typedef void (*GraphQLStateCallback)(GraphQLConnectionState state);
typedef void (*GraphQLQueueSyncCallback)(const ControllerQueueSyncData& data);
typedef void (*GraphQLLedUpdateCallback)(const LedCommand* commands, int count);

class GraphQLWSClient {
  public:
    GraphQLWSClient();

    void begin(const char* host, uint16_t port, const char* path = "/graphql", const char* apiKey = nullptr);
    void loop();
    void disconnect();

    // Connection state
    bool isConnected();
    bool isSubscribed();
    GraphQLConnectionState getState();

    // Subscribe to a GraphQL subscription
    void subscribe(const char* subscriptionId, const char* query, const char* variables = nullptr);
    void unsubscribe(const char* subscriptionId);

    // Send a GraphQL query/mutation
    void send(const char* query, const char* variables = nullptr);

    // Send a named GraphQL mutation (for tracking completion)
    void sendMutation(const char* mutationId, const char* mutation, const char* variables = nullptr);

    // Send LED positions from Bluetooth to backend (to match climb)
    void sendLedPositions(const LedCommand* commands, int count, int angle);

    // Callbacks
    void setMessageCallback(GraphQLMessageCallback callback);
    void setStateCallback(GraphQLStateCallback callback);
    void setQueueSyncCallback(GraphQLQueueSyncCallback callback);
    void setLedUpdateCallback(GraphQLLedUpdateCallback callback);

    // Handle LED update from backend
    void handleLedUpdate(JsonObject& data);

    // Handle queue sync from backend
    void handleQueueSync(JsonObject& data);

    // Config keys
    static const char* KEY_HOST;
    static const char* KEY_PORT;
    static const char* KEY_PATH;

    // Get current display hash (for deduplication)
    uint32_t getCurrentDisplayHash() { return currentDisplayHash; }

    // Check if a mutation is currently in flight
    bool isMutationInFlight() { return mutationInFlight; }

    // Set the controller ID for comparison with incoming clientId
    void setControllerId(const String& id) { controllerId = id; }

    // Get the controller ID
    const String& getControllerId() { return controllerId; }

  private:
    WebSocketsClient ws;
    GraphQLConnectionState state;
    GraphQLMessageCallback messageCallback;
    GraphQLStateCallback stateCallback;
    GraphQLQueueSyncCallback queueSyncCallback;
    GraphQLLedUpdateCallback ledUpdateCallback;

    String serverHost;
    uint16_t serverPort;
    String serverPath;
    String apiKey;
    bool useSSL;
    String sessionId;
    String subscriptionId;
    String controllerId;  // Controller ID for comparison with incoming clientId (deprecated, use deviceMac)
    String deviceMac;     // Device MAC address for clientId comparison (auto-detected)

    unsigned long lastPingTime;
    unsigned long lastPongTime;
    unsigned long reconnectTime;
    uint32_t lastSentLedHash;     // Hash of last sent LED positions (to avoid duplicates)
    uint32_t currentDisplayHash;  // Hash of currently displayed LEDs (from backend LedUpdate)
    bool mutationInFlight;        // True if a mutation is pending completion
    unsigned long mutationSentTime;  // When the current mutation was sent (for timeout)

    void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length);
    void sendConnectionInit();
    void handleMessage(uint8_t* payload, size_t length);
    void setState(GraphQLConnectionState newState);
    void sendPing();
    String generateSubscriptionId();
    uint32_t computeLedHash(const LedCommand* commands, int count);
};

extern GraphQLWSClient GraphQL;

#endif
