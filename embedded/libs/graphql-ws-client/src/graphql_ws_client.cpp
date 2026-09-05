// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "graphql_ws_client.h"

#include <WiFi.h>
#include <aurora_protocol.h>
#include <nordic_uart_ble.h>

GraphQLWSClient GraphQL;

const char* GraphQLWSClient::KEY_HOST = "gql_host";
const char* GraphQLWSClient::KEY_PORT = "gql_port";
const char* GraphQLWSClient::KEY_PATH = "gql_path";

GraphQLWSClient::GraphQLWSClient()
    : state(GraphQLConnectionState::DISCONNECTED), messageCallback(nullptr), stateCallback(nullptr), queueSyncCallback(nullptr),
      ledUpdateCallback(nullptr), serverPort(443), useSSL(true), lastPingTime(0), lastPongTime(0), reconnectTime(0), lastSentLedHash(0), currentDisplayHash(0),
      mutationInFlight(false), mutationSentTime(0) {}

void GraphQLWSClient::begin(const char* host, uint16_t port, const char* path, const char* apiKeyParam) {
    // Parse protocol prefix from host (ws:// or wss://)
    String hostStr = host;
    useSSL = true;  // Default to SSL

    if (hostStr.startsWith("wss://")) {
        useSSL = true;
        hostStr = hostStr.substring(6);  // Remove "wss://"
    } else if (hostStr.startsWith("ws://")) {
        useSSL = false;
        hostStr = hostStr.substring(5);  // Remove "ws://"
    } else if (hostStr.startsWith("https://")) {
        useSSL = true;
        hostStr = hostStr.substring(8);  // Remove "https://"
    } else if (hostStr.startsWith("http://")) {
        useSSL = false;
        hostStr = hostStr.substring(7);  // Remove "http://"
    }
    // If no prefix, default to SSL (production behavior)

    serverHost = hostStr;
    serverPort = port;
    serverPath = path;
    this->apiKey = apiKeyParam ? apiKeyParam : "";
    this->sessionId = Config.getString("session_id");

    // Set up WebSocket event handler
    ws.onEvent(
        [this](WStype_t type, uint8_t* payload, size_t length) { this->onWebSocketEvent(type, payload, length); });

    // Enable heartbeat
    ws.enableHeartbeat(WS_PING_INTERVAL, WS_PONG_TIMEOUT, 2);

    // Set subprotocol for graphql-ws
    ws.setExtraHeaders("Sec-WebSocket-Protocol: graphql-transport-ws");

    // Connect with or without SSL based on protocol prefix
    if (useSSL) {
        ws.beginSSL(serverHost.c_str(), port, path);
    } else {
        ws.begin(serverHost.c_str(), port, path);
    }

    ws.setReconnectInterval(WS_RECONNECT_INTERVAL);

    setState(GraphQLConnectionState::CONNECTING);
}

void GraphQLWSClient::loop() {
    ws.loop();

    // Handle ping interval
    if (state == GraphQLConnectionState::SUBSCRIBED) {
        unsigned long now = millis();
        if (now - lastPingTime > WS_PING_INTERVAL) {
            sendPing();
            lastPingTime = now;
        }
    }

    // Handle reconnection
    if (state == GraphQLConnectionState::DISCONNECTED && reconnectTime > 0) {
        if (millis() > reconnectTime) {
            Logger.logln("GraphQL: Attempting reconnection...");
            begin(serverHost.c_str(), serverPort, serverPath.c_str(), apiKey.c_str());
            reconnectTime = 0;
        }
    }
}

void GraphQLWSClient::disconnect() {
    ws.disconnect();
    setState(GraphQLConnectionState::DISCONNECTED);
}

bool GraphQLWSClient::isConnected() {
    return state == GraphQLConnectionState::CONNECTION_ACK || state == GraphQLConnectionState::SUBSCRIBED;
}

bool GraphQLWSClient::isSubscribed() {
    return state == GraphQLConnectionState::SUBSCRIBED;
}

GraphQLConnectionState GraphQLWSClient::getState() {
    return state;
}

void GraphQLWSClient::subscribe(const char* subId, const char* query, const char* variables) {
    subscriptionId = subId;

    JsonDocument doc;
    doc["id"] = subId;
    doc["type"] = "subscribe";

    JsonObject payload = doc["payload"].to<JsonObject>();
    payload["query"] = query;

    if (variables) {
        JsonDocument varsDoc;
        deserializeJson(varsDoc, variables);
        payload["variables"] = varsDoc;
    }

    String msg;
    serializeJson(doc, msg);
    ws.sendTXT(msg);

    setState(GraphQLConnectionState::SUBSCRIBED);
    Logger.logln("GraphQL: Subscribed to %s", subId);
}

void GraphQLWSClient::unsubscribe(const char* subId) {
    JsonDocument doc;
    doc["id"] = subId;
    doc["type"] = "complete";

    String msg;
    serializeJson(doc, msg);
    ws.sendTXT(msg);
}

void GraphQLWSClient::send(const char* query, const char* variables) {
    static int queryId = 0;

    JsonDocument doc;
    doc["id"] = String(++queryId);
    doc["type"] = "subscribe";

    JsonObject payload = doc["payload"].to<JsonObject>();
    payload["query"] = query;

    if (variables) {
        JsonDocument varsDoc;
        deserializeJson(varsDoc, variables);
        payload["variables"] = varsDoc;
    }

    String msg;
    serializeJson(doc, msg);
    ws.sendTXT(msg);
}

void GraphQLWSClient::sendMutation(const char* mutationId, const char* mutation, const char* variables) {
    if (state != GraphQLConnectionState::SUBSCRIBED && state != GraphQLConnectionState::CONNECTION_ACK) {
        Logger.logln("GraphQL: Cannot send mutation - not connected");
        return;
    }

    // Check if a mutation is already in flight (prevent overlapping mutations)
    if (mutationInFlight) {
        unsigned long elapsed = millis() - mutationSentTime;
        if (elapsed < 5000) {  // 5 second timeout for mutations
            Logger.logln("GraphQL: Skipping mutation - previous still in flight (%lu ms)", elapsed);
            return;
        }
        // Timeout - clear the flag and allow new mutation
        Logger.logln("GraphQL: Previous mutation timed out, allowing new one");
        mutationInFlight = false;
    }

    JsonDocument doc;
    doc["id"] = mutationId;
    doc["type"] = "subscribe";  // graphql-ws uses subscribe for mutations too

    JsonObject payload = doc["payload"].to<JsonObject>();
    payload["query"] = mutation;

    if (variables) {
        JsonDocument varsDoc;
        deserializeJson(varsDoc, variables);
        payload["variables"] = varsDoc;
    }

    String msg;
    serializeJson(doc, msg);
    ws.sendTXT(msg);

    mutationInFlight = true;
    mutationSentTime = millis();
    Logger.logln("GraphQL: Sent mutation %s", mutationId);
}

void GraphQLWSClient::setMessageCallback(GraphQLMessageCallback callback) {
    messageCallback = callback;
}

void GraphQLWSClient::setStateCallback(GraphQLStateCallback callback) {
    stateCallback = callback;
}

void GraphQLWSClient::setQueueSyncCallback(GraphQLQueueSyncCallback callback) {
    queueSyncCallback = callback;
}

void GraphQLWSClient::setLedUpdateCallback(GraphQLLedUpdateCallback callback) {
    ledUpdateCallback = callback;
}

void GraphQLWSClient::onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Logger.logln("GraphQL: Disconnected");
            setState(GraphQLConnectionState::DISCONNECTED);
            // Schedule reconnection
            reconnectTime = millis() + WS_RECONNECT_INTERVAL;
            // Clear mutation in-flight flag on disconnect
            mutationInFlight = false;
            // Clear LEDs on disconnect
            LEDs.clear();
            LEDs.show();
            break;

        case WStype_CONNECTED:
            Logger.logln("GraphQL: Connected to %s", serverHost.c_str());
            setState(GraphQLConnectionState::CONNECTED);
            sendConnectionInit();
            break;

        case WStype_TEXT:
            handleMessage(payload, length);
            break;

        case WStype_ERROR:
            Logger.logln("GraphQL: WebSocket error");
            break;

        case WStype_PING:
            Logger.logln("GraphQL: Ping received");
            break;

        case WStype_PONG:
            lastPongTime = millis();
            break;

        default:
            break;
    }
}

void GraphQLWSClient::sendConnectionInit() {
    JsonDocument doc;
    doc["type"] = "connection_init";

    // Include controller API key and MAC address in connection payload
    if (apiKey.length() > 0) {
        JsonObject payload = doc["payload"].to<JsonObject>();
        payload["controllerApiKey"] = apiKey;
        // Send MAC address for clientId matching (so backend can use it as clientId)
        payload["controllerMac"] = WiFi.macAddress();
    }

    // Store our own MAC for comparison with incoming clientId
    deviceMac = WiFi.macAddress();
    Logger.logln("GraphQL: Device MAC for clientId comparison: %s", deviceMac.c_str());

    String msg;
    serializeJson(doc, msg);
    ws.sendTXT(msg);

    Logger.logln("GraphQL: Sent connection_init");
    setState(GraphQLConnectionState::CONNECTION_INIT);
}

void GraphQLWSClient::handleMessage(uint8_t* payload, size_t length) {
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, payload, length);

    if (error) {
        Logger.logln("GraphQL: JSON parse error: %s", error.c_str());
        return;
    }

    const char* type = doc["type"];

    if (strcmp(type, "connection_ack") == 0) {
        Logger.logln("GraphQL: Connection acknowledged");
        setState(GraphQLConnectionState::CONNECTION_ACK);
    } else if (strcmp(type, "next") == 0) {
        // Subscription data
        JsonObject payloadObj = doc["payload"];
        if (payloadObj["data"].is<JsonObject>()) {
            JsonObject data = payloadObj["data"];
            if (data["controllerEvents"].is<JsonObject>()) {
                JsonObject event = data["controllerEvents"];
                const char* typename_ = event["__typename"];

                if (typename_ && strcmp(typename_, "LedUpdate") == 0) {
                    handleLedUpdate(event);
                } else if (typename_ && strcmp(typename_, "ControllerQueueSync") == 0) {
                    handleQueueSync(event);
                } else if (typename_ && strcmp(typename_, "ControllerPing") == 0) {
                    Logger.logln("GraphQL: Received ping from server");
                }
            }
        }
        if (messageCallback) {
            messageCallback(doc);
        }
    } else if (strcmp(type, "error") == 0) {
        Logger.logln("GraphQL: Subscription/mutation error");
        JsonArray errors = doc["payload"];
        for (JsonObject err : errors) {
            Logger.logln("GraphQL: Error: %s", err["message"].as<const char*>());
        }
        // Clear mutation in-flight flag on error (allows next mutation to proceed)
        mutationInFlight = false;
    } else if (strcmp(type, "complete") == 0) {
        const char* msgId = doc["id"];
        // Only reset state if main subscription completed, not mutations
        if (msgId && subscriptionId == String(msgId)) {
            Logger.logln("GraphQL: Main subscription completed");
            setState(GraphQLConnectionState::CONNECTION_ACK);
        } else {
            Logger.logln("GraphQL: Mutation completed");
            // Clear mutation in-flight flag
            mutationInFlight = false;
            // Don't change state - subscription is still active
        }
    } else if (strcmp(type, "pong") == 0) {
        lastPongTime = millis();
    }
}

void GraphQLWSClient::handleLedUpdate(JsonObject& data) {
    // Check if this update was initiated by this controller (self-initiated from BLE)
    // Compare incoming clientId with our device's MAC address
    const char* updateClientId = data["clientId"];
    bool isSelfInitiated = updateClientId && deviceMac.length() > 0 &&
                           (String(updateClientId) == deviceMac);

    JsonArray commands = data["commands"];

    if (commands.isNull() || commands.size() == 0) {
        // Clear LEDs command
        if (BLE.isConnected() && !isSelfInitiated) {
            // Web user cleared - disconnect phone (BLE client), keep proxy
            Logger.logln("GraphQL: Web user cleared climb, disconnecting BLE client");
            BLE.disconnectClient();
            BLE.clearLastSentHash();
        } else if (isSelfInitiated) {
            // Self-initiated (unknown climb from BLE) - keep phone connected
            Logger.logln("GraphQL: Self-initiated clear/unknown climb, maintaining BLE client connection");
        }
        LEDs.clear();
        LEDs.show();
        currentDisplayHash = 0;
        Logger.logln("GraphQL: Cleared LEDs (no commands)");
        return;
    }

    int count = commands.size();

    // Convert to LedCommand array
    LedCommand* ledCommands = new LedCommand[count];

    int i = 0;
    for (JsonObject cmd : commands) {
        ledCommands[i].position = cmd["position"];
        ledCommands[i].r = cmd["r"];
        ledCommands[i].g = cmd["g"];
        ledCommands[i].b = cmd["b"];
        i++;
    }

    // Compute hash of incoming LED data for deduplication
    uint32_t incomingHash = computeLedHash(ledCommands, count);

    // Check if we should disconnect the BLE client (phone using official app)
    if (BLE.isConnected()) {
        if (isSelfInitiated) {
            // Self-initiated from this controller's BLE - keep phone connected
            Logger.logln("GraphQL: Self-initiated update, maintaining BLE client connection");
        } else {
            // Web user changed climb - disconnect phone (BLE client), keep proxy
            Logger.logln("GraphQL: Web user changed climb, disconnecting BLE client");
            BLE.disconnectClient();
            BLE.clearLastSentHash();
        }
    }

    // Each LedUpdate carries the FULL LED state for a climb, so clear the
    // previous climb before applying the new one (same contract as the BLE
    // path in nordic_uart_ble.cpp). Without this, switching climbs from the
    // web queue accumulates holds from the previous climb on the strip.
    LEDs.clear();
    LEDs.setLeds(ledCommands, count);
    LEDs.show();

    // Store hash of currently displayed LEDs (to detect if BLE sends the same climb)
    currentDisplayHash = incomingHash;

    // Log climb info if available
    const char* climbName = data["climbName"];
    if (climbName) {
        Logger.logln("GraphQL: Displaying climb: %s (%d LEDs, clientId: %s)", climbName, count, updateClientId ? updateClientId : "null");
    } else {
        Logger.logln("GraphQL: Updated %d LEDs (clientId: %s)", count, updateClientId ? updateClientId : "null");
    }

    // Call LED update callback (for proxy forwarding)
    if (ledUpdateCallback) {
        ledUpdateCallback(ledCommands, count);
    }

    delete[] ledCommands;
}

void GraphQLWSClient::handleQueueSync(JsonObject& data) {
    JsonArray queueArray = data["queue"];
    int currentIndex = data["currentIndex"] | -1;

    if (queueArray.isNull()) {
        Logger.logln("GraphQL: QueueSync with null queue");
        return;
    }

    int count = queueArray.size();
    Logger.logln("GraphQL: QueueSync received: %d items, currentIndex: %d", count, currentIndex);

    if (!queueSyncCallback) {
        Logger.logln("GraphQL: No queue sync callback registered");
        return;
    }

    // Allocate on heap to avoid stack overflow (~19KB struct)
    ControllerQueueSyncData* syncData = new (std::nothrow) ControllerQueueSyncData();
    if (!syncData) {
#ifdef ESP_PLATFORM
        Logger.logln("GraphQL: CRITICAL: Failed to allocate QueueSync data (%u bytes, free heap: %u)",
                     (unsigned)sizeof(ControllerQueueSyncData), (unsigned)ESP.getFreeHeap());
#else
        Logger.logln("GraphQL: CRITICAL: Failed to allocate QueueSync data (%u bytes)",
                     (unsigned)sizeof(ControllerQueueSyncData));
#endif
        return;
    }

    syncData->count = min(count, ControllerQueueSyncData::MAX_ITEMS);
    syncData->currentIndex = currentIndex;

    int i = 0;
    for (JsonObject item : queueArray) {
        if (i >= ControllerQueueSyncData::MAX_ITEMS) break;

        const char* uuid = item["uuid"] | "";
        const char* climbUuid = item["climbUuid"] | "";
        const char* name = item["name"] | "";
        const char* grade = item["grade"] | "";
        const char* gradeColor = item["gradeColor"] | "";

        // Copy with truncation
        strncpy(syncData->items[i].uuid, uuid, sizeof(syncData->items[i].uuid) - 1);
        syncData->items[i].uuid[sizeof(syncData->items[i].uuid) - 1] = '\0';

        strncpy(syncData->items[i].climbUuid, climbUuid, sizeof(syncData->items[i].climbUuid) - 1);
        syncData->items[i].climbUuid[sizeof(syncData->items[i].climbUuid) - 1] = '\0';

        strncpy(syncData->items[i].name, name, sizeof(syncData->items[i].name) - 1);
        syncData->items[i].name[sizeof(syncData->items[i].name) - 1] = '\0';

        strncpy(syncData->items[i].grade, grade, sizeof(syncData->items[i].grade) - 1);
        syncData->items[i].grade[sizeof(syncData->items[i].grade) - 1] = '\0';

        strncpy(syncData->items[i].gradeColor, gradeColor, sizeof(syncData->items[i].gradeColor) - 1);
        syncData->items[i].gradeColor[sizeof(syncData->items[i].gradeColor) - 1] = '\0';

        i++;
    }

    // Call the callback
    queueSyncCallback(*syncData);

    // Free heap memory
    delete syncData;
}

void GraphQLWSClient::sendLedPositions(const LedCommand* commands, int count, int angle) {
    Logger.logln("GraphQL: sendLedPositions called: %d LEDs, state=%d", count, (int)state);

    if (state != GraphQLConnectionState::SUBSCRIBED) {
        Logger.logln("GraphQL: Cannot send LED positions - not subscribed");
        return;
    }

    // Check if this is the same LED data we just sent (deduplication)
    uint32_t currentHash = computeLedHash(commands, count);
    Logger.logln("GraphQL: Hash: %u, lastSent: %u, display: %u", currentHash, lastSentLedHash, currentDisplayHash);

    // Skip if same as last sent
    if (currentHash == lastSentLedHash && lastSentLedHash != 0) {
        Logger.logln("GraphQL: Skipping duplicate LED data (same as last sent)");
        return;
    }

    // Skip if matches what's currently displayed on the board (from backend)
    if (currentHash == currentDisplayHash && currentDisplayHash != 0) {
        Logger.logln("GraphQL: Skipping LED data (matches display hash: %u)", currentDisplayHash);
        return;
    }

    // Update last sent hash
    lastSentLedHash = currentHash;
    Logger.logln("GraphQL: Proceeding to send (updated hash)");

    JsonDocument doc;
    doc["id"] = generateSubscriptionId();
    doc["type"] = "subscribe";  // Using subscribe for mutations in graphql-ws

    JsonObject payload = doc["payload"].to<JsonObject>();
    // Send positions array - backend will convert to frames string
    payload["query"] = "mutation SetClimbFromLeds($sessionId: ID!, $positions: [LedCommandInput!]!) { "
                       "setClimbFromLedPositions(sessionId: $sessionId, positions: $positions) { "
                       "matched climbUuid climbName } }";

    JsonObject variables = payload["variables"].to<JsonObject>();
    variables["sessionId"] = sessionId;

    JsonArray positions = variables["positions"].to<JsonArray>();
    for (int i = 0; i < count; i++) {
        JsonObject pos = positions.add<JsonObject>();
        pos["position"] = commands[i].position;
        pos["r"] = commands[i].r;
        pos["g"] = commands[i].g;
        pos["b"] = commands[i].b;
        // Add role code for easier matching on backend
        pos["role"] = colorToRole(commands[i].r, commands[i].g, commands[i].b);
    }

    String message;
    serializeJson(doc, message);

    // Log role breakdown
    int starts = 0, hands = 0, finishes = 0, foots = 0;
    for (int i = 0; i < count; i++) {
        uint8_t role = colorToRole(commands[i].r, commands[i].g, commands[i].b);
        if (role == ROLE_STARTING)
            starts++;
        else if (role == ROLE_HAND)
            hands++;
        else if (role == ROLE_FINISH)
            finishes++;
        else if (role == ROLE_FOOT)
            foots++;
    }
    Logger.logln("GraphQL: Sending %d LED positions (roles: %d start, %d hand, %d finish, %d foot)", count, starts,
                 hands, finishes, foots);

    ws.sendTXT(message);
}

void GraphQLWSClient::setState(GraphQLConnectionState newState) {
    if (state != newState) {
        state = newState;
        if (stateCallback) {
            stateCallback(state);
        }
    }
}

void GraphQLWSClient::sendPing() {
    JsonDocument doc;
    doc["type"] = "ping";

    String message;
    serializeJson(doc, message);
    ws.sendTXT(message);
}

String GraphQLWSClient::generateSubscriptionId() {
    return String(random(100000, 999999));
}

uint32_t GraphQLWSClient::computeLedHash(const LedCommand* commands, int count) {
    // Order-independent hash: XOR all LED data together
    // This way the same LEDs in different order produce the same hash
    uint32_t hash = count;
    for (int i = 0; i < count; i++) {
        // Create a unique value for each LED and XOR them together
        uint32_t ledValue = (commands[i].position << 16) | (commands[i].r << 8) | (commands[i].g);
        // Mix in blue separately to avoid collisions
        ledValue ^= (commands[i].b << 24) | (commands[i].position);
        hash ^= ledValue;
    }
    return hash;
}
