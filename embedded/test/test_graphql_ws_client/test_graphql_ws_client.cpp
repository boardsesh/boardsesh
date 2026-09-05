// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for GraphQL WebSocket Client Library
 *
 * Tests the WebSocket GraphQL client for backend communication.
 */

#include <ArduinoJson.h>
#include <Preferences.h>

#include <WebSocketsClient.h>
#include <cstring>
#include <graphql_ws_client.h>
#include <led_controller.h>
#include <unity.h>

// Access the global WebSocket mock through GraphQL client
static GraphQLWSClient* client;
static WebSocketsClient* wsMock;

// Test state callback tracking
static GraphQLConnectionState lastCallbackState = GraphQLConnectionState::DISCONNECTED;
static int stateCallbackCount = 0;

void stateCallback(GraphQLConnectionState state) {
    lastCallbackState = state;
    stateCallbackCount++;
}

// Test message callback tracking
static int messageCallbackCount = 0;

void messageCallback(JsonDocument& doc) {
    (void)doc;
    messageCallbackCount++;
}

void setUp(void) {
    Preferences::resetAll();
    lastCallbackState = GraphQLConnectionState::DISCONNECTED;
    stateCallbackCount = 0;
    messageCallbackCount = 0;
    client = new GraphQLWSClient();
}

void tearDown(void) {
    delete client;
    client = nullptr;
}

// =============================================================================
// Constructor Tests
// =============================================================================

void test_initial_state_is_disconnected(void) {
    TEST_ASSERT_EQUAL(GraphQLConnectionState::DISCONNECTED, client->getState());
}

void test_initial_is_connected_returns_false(void) {
    TEST_ASSERT_FALSE(client->isConnected());
}

void test_initial_is_subscribed_returns_false(void) {
    TEST_ASSERT_FALSE(client->isSubscribed());
}

void test_initial_display_hash_is_zero(void) {
    TEST_ASSERT_EQUAL_UINT32(0, client->getCurrentDisplayHash());
}

// =============================================================================
// Begin/Connection Tests
// =============================================================================

void test_begin_sets_state_to_connecting(void) {
    client->begin("test.host.com", 443, "/graphql", "test-api-key");
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());
}

// =============================================================================
// State Callback Tests
// =============================================================================

void test_set_state_callback(void) {
    client->setStateCallback(stateCallback);
    client->begin("test.host.com", 443, "/graphql", nullptr);

    // State should change to CONNECTING, triggering callback
    TEST_ASSERT_EQUAL(1, stateCallbackCount);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, lastCallbackState);
}

// =============================================================================
// Connection State Tests
// =============================================================================

void test_connecting_state_not_connected(void) {
    // Test that CONNECTING state is not considered "connected"
    client->begin("test.host.com", 443, "/graphql", nullptr);

    // isConnected should return false when in CONNECTING state
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());
    TEST_ASSERT_FALSE(client->isConnected());
}

void test_is_subscribed_false_when_not_subscribed(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    TEST_ASSERT_FALSE(client->isSubscribed());
}

// =============================================================================
// Disconnect Tests
// =============================================================================

void test_disconnect_sets_state_to_disconnected(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());

    client->disconnect();
    TEST_ASSERT_EQUAL(GraphQLConnectionState::DISCONNECTED, client->getState());
}

// =============================================================================
// Display Hash Tests
// =============================================================================

void test_initial_display_hash_zero(void) {
    // Display hash starts at 0, only updated from backend LED updates via handleLedUpdate
    TEST_ASSERT_EQUAL_UINT32(0, client->getCurrentDisplayHash());
}

void test_display_hash_unchanged_by_send(void) {
    // sendLedPositions uses a separate lastSentLedHash internally for deduplication
    // getCurrentDisplayHash returns the display hash (set by handleLedUpdate from backend)
    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription { test }", nullptr);

    LedCommand commands[2] = {{10, 255, 0, 0}, {20, 0, 255, 0}};
    client->sendLedPositions(commands, 2, 40);

    // Display hash should remain 0 since it's only updated from backend
    TEST_ASSERT_EQUAL_UINT32(0, client->getCurrentDisplayHash());
}

// =============================================================================
// LED Update Tests
// =============================================================================

// Append one LED command object to the update's "commands" array. Set fields
// immediately per element (the mock's vector can reallocate on the next add).
static void addLedCommand(JsonArray commands, int position, int r, int g, int b) {
    JsonObject command = commands.add<JsonObject>();
    command["position"] = position;
    command["r"] = r;
    command["g"] = g;
    command["b"] = b;
}

// Regression test: each LedUpdate carries the FULL LED state for a climb, so
// switching climbs from the web queue must clear the previous climb's holds
// instead of accumulating them on the strip (same contract as the BLE path).
void test_led_update_clears_previous_climb_leds(void) {
    LEDs.begin(50);
    CRGB* strip = CFastLED::getLeds();
    TEST_ASSERT_NOT_NULL(strip);

    JsonDocument climbA;
    JsonArray commandsA = climbA["commands"].to<JsonArray>();
    addLedCommand(commandsA, 1, 255, 0, 0);
    addLedCommand(commandsA, 2, 0, 255, 0);
    JsonObject climbAData = climbA.as<JsonObject>();
    client->handleLedUpdate(climbAData);

    TEST_ASSERT_TRUE(strip[1] != CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[2] != CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(client->getCurrentDisplayHash() != 0);

    JsonDocument climbB;
    JsonArray commandsB = climbB["commands"].to<JsonArray>();
    addLedCommand(commandsB, 3, 0, 0, 255);
    JsonObject climbBData = climbB.as<JsonObject>();
    client->handleLedUpdate(climbBData);

    TEST_ASSERT_TRUE(strip[3] != CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[1] == CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[2] == CRGB(0, 0, 0));
}

void test_led_update_with_empty_commands_array_clears_all_leds(void) {
    LEDs.begin(50);
    CRGB* strip = CFastLED::getLeds();

    JsonDocument climb;
    JsonArray commands = climb["commands"].to<JsonArray>();
    addLedCommand(commands, 6, 255, 0, 0);
    JsonObject climbData = climb.as<JsonObject>();
    client->handleLedUpdate(climbData);
    TEST_ASSERT_TRUE(strip[6] != CRGB(0, 0, 0));

    // Explicit "commands": [] (as opposed to the key being absent)
    JsonDocument clearUpdate;
    clearUpdate["commands"].to<JsonArray>();
    JsonObject clearData = clearUpdate.as<JsonObject>();
    client->handleLedUpdate(clearData);

    TEST_ASSERT_TRUE(strip[6] == CRGB(0, 0, 0));
    TEST_ASSERT_EQUAL_UINT32(0, client->getCurrentDisplayHash());
}

void test_led_update_without_commands_clears_all_leds(void) {
    LEDs.begin(50);
    CRGB* strip = CFastLED::getLeds();

    JsonDocument climb;
    JsonArray commands = climb["commands"].to<JsonArray>();
    addLedCommand(commands, 4, 255, 255, 255);
    JsonObject climbData = climb.as<JsonObject>();
    client->handleLedUpdate(climbData);
    TEST_ASSERT_TRUE(strip[4] != CRGB(0, 0, 0));

    JsonDocument clearUpdate;
    JsonObject clearData = clearUpdate.as<JsonObject>();
    client->handleLedUpdate(clearData);

    TEST_ASSERT_TRUE(strip[4] == CRGB(0, 0, 0));
    TEST_ASSERT_EQUAL_UINT32(0, client->getCurrentDisplayHash());
}

// =============================================================================
// Message Callback Tests
// =============================================================================

void test_set_message_callback_stores_callback(void) {
    // Setting callback should not affect state
    GraphQLConnectionState stateBefore = client->getState();
    client->setMessageCallback(messageCallback);
    TEST_ASSERT_EQUAL(stateBefore, client->getState());
    // Note: Callback invocation tested indirectly via message handling
}

// =============================================================================
// Config Key Constants Tests
// =============================================================================

void test_config_keys_are_defined(void) {
    TEST_ASSERT_NOT_NULL(GraphQLWSClient::KEY_HOST);
    TEST_ASSERT_NOT_NULL(GraphQLWSClient::KEY_PORT);
    TEST_ASSERT_NOT_NULL(GraphQLWSClient::KEY_PATH);

    TEST_ASSERT_EQUAL_STRING("gql_host", GraphQLWSClient::KEY_HOST);
    TEST_ASSERT_EQUAL_STRING("gql_port", GraphQLWSClient::KEY_PORT);
    TEST_ASSERT_EQUAL_STRING("gql_path", GraphQLWSClient::KEY_PATH);
}

// =============================================================================
// Loop Behavior Tests
// =============================================================================

void test_loop_maintains_state_when_disconnected(void) {
    // Loop should maintain DISCONNECTED state
    TEST_ASSERT_EQUAL(GraphQLConnectionState::DISCONNECTED, client->getState());
    client->loop();
    client->loop();
    TEST_ASSERT_EQUAL(GraphQLConnectionState::DISCONNECTED, client->getState());
}

void test_loop_maintains_state_when_connecting(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());
    client->loop();
    client->loop();
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());
}

// =============================================================================
// Subscribe Tests
// =============================================================================

void test_subscribe_changes_state_to_subscribed(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    // Note: In real implementation, subscribe requires being in CONNECTION_ACK state
    // but for testing we verify the method doesn't crash
    client->subscribe("test-sub", "subscription { test }", nullptr);
    // State changes to SUBSCRIBED
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());
}

void test_subscribe_with_variables(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription Test($id: ID!) { test(id: $id) }", "{\"id\":\"123\"}");
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());
}

// =============================================================================
// Unsubscribe Tests
// =============================================================================

void test_unsubscribe_maintains_connection_state(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription { test }", nullptr);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());

    client->unsubscribe("test-sub");
    // After unsubscribe, state should still be valid (not crash)
    TEST_ASSERT_TRUE(client->getState() == GraphQLConnectionState::CONNECTING ||
                     client->getState() == GraphQLConnectionState::SUBSCRIBED);
}

// =============================================================================
// Send Tests
// =============================================================================

void test_send_query_maintains_state(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    GraphQLConnectionState stateBefore = client->getState();
    client->send("query { test }", nullptr);
    // Send should not change connection state
    TEST_ASSERT_EQUAL(stateBefore, client->getState());
}

void test_send_query_with_variables_maintains_state(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    GraphQLConnectionState stateBefore = client->getState();
    client->send("query Test($id: ID!) { test(id: $id) }", "{\"id\":\"123\"}");
    TEST_ASSERT_EQUAL(stateBefore, client->getState());
}

// =============================================================================
// sendLedPositions Tests
// =============================================================================

void test_send_led_positions_skipped_when_not_subscribed(void) {
    // When not subscribed, sendLedPositions should skip (state preserved)
    LedCommand commands[2] = {
        {10, 255, 0, 0},  // Position 10, red
        {20, 0, 255, 0}   // Position 20, green
    };

    client->begin("test.host.com", 443, "/graphql", nullptr);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());

    // State is CONNECTING, not SUBSCRIBED - should not crash and state preserved
    client->sendLedPositions(commands, 2, 40);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::CONNECTING, client->getState());
}

void test_send_led_positions_maintains_subscribed_state(void) {
    LedCommand commands[3] = {
        {10, 255, 0, 0},  // Position 10, red
        {20, 0, 255, 0},  // Position 20, green
        {30, 0, 0, 255}   // Position 30, blue
    };

    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription { test }", nullptr);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());

    client->sendLedPositions(commands, 3, 40);
    // State should still be SUBSCRIBED after sending
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());
}

void test_send_led_positions_handles_empty_array(void) {
    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription { test }", nullptr);

    // Sending empty array should not crash
    client->sendLedPositions(nullptr, 0, 40);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());
}

void test_send_led_positions_repeated_calls_preserve_state(void) {
    // Multiple calls with same data should preserve state (tests deduplication path)
    LedCommand commands[2] = {{10, 255, 0, 0}, {20, 0, 255, 0}};

    client->begin("test.host.com", 443, "/graphql", nullptr);
    client->subscribe("test-sub", "subscription { test }", nullptr);

    // Multiple sends - all should maintain SUBSCRIBED state
    client->sendLedPositions(commands, 2, 40);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());

    client->sendLedPositions(commands, 2, 40);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());

    // Change data and send again
    commands[0].position = 15;
    client->sendLedPositions(commands, 2, 40);
    TEST_ASSERT_EQUAL(GraphQLConnectionState::SUBSCRIBED, client->getState());
}

// =============================================================================
// State Transitions Tests
// =============================================================================

void test_multiple_state_transitions(void) {
    client->setStateCallback(stateCallback);
    stateCallbackCount = 0;

    client->begin("test.host.com", 443, "/graphql", nullptr);
    TEST_ASSERT_EQUAL(1, stateCallbackCount);  // DISCONNECTED -> CONNECTING

    client->disconnect();
    TEST_ASSERT_EQUAL(2, stateCallbackCount);  // CONNECTING -> DISCONNECTED
}

// =============================================================================
// WebSocket Timing Constants Tests
// =============================================================================

void test_websocket_timing_constants_defined(void) {
    // These constants are defined in the header
    TEST_ASSERT_EQUAL(30000, WS_PING_INTERVAL);
    TEST_ASSERT_EQUAL(10000, WS_PONG_TIMEOUT);
    TEST_ASSERT_EQUAL(5000, WS_RECONNECT_INTERVAL);
}

// =============================================================================
// Protocol Constant Tests
// =============================================================================

void test_graphql_ws_protocol_defined(void) {
    TEST_ASSERT_EQUAL_STRING("graphql-transport-ws", GQL_WS_PROTOCOL);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Constructor tests
    RUN_TEST(test_initial_state_is_disconnected);
    RUN_TEST(test_initial_is_connected_returns_false);
    RUN_TEST(test_initial_is_subscribed_returns_false);
    RUN_TEST(test_initial_display_hash_is_zero);

    // Begin/Connection tests
    RUN_TEST(test_begin_sets_state_to_connecting);

    // State callback tests
    RUN_TEST(test_set_state_callback);

    // Connection state tests
    RUN_TEST(test_connecting_state_not_connected);
    RUN_TEST(test_is_subscribed_false_when_not_subscribed);

    // Disconnect tests
    RUN_TEST(test_disconnect_sets_state_to_disconnected);

    // Display hash tests
    RUN_TEST(test_initial_display_hash_zero);
    RUN_TEST(test_display_hash_unchanged_by_send);

    // LED update tests
    RUN_TEST(test_led_update_clears_previous_climb_leds);
    RUN_TEST(test_led_update_with_empty_commands_array_clears_all_leds);
    RUN_TEST(test_led_update_without_commands_clears_all_leds);

    // Message callback tests
    RUN_TEST(test_set_message_callback_stores_callback);

    // Config key tests
    RUN_TEST(test_config_keys_are_defined);

    // Loop behavior tests
    RUN_TEST(test_loop_maintains_state_when_disconnected);
    RUN_TEST(test_loop_maintains_state_when_connecting);

    // Subscribe tests
    RUN_TEST(test_subscribe_changes_state_to_subscribed);
    RUN_TEST(test_subscribe_with_variables);

    // Unsubscribe tests
    RUN_TEST(test_unsubscribe_maintains_connection_state);

    // Send tests
    RUN_TEST(test_send_query_maintains_state);
    RUN_TEST(test_send_query_with_variables_maintains_state);

    // sendLedPositions tests
    RUN_TEST(test_send_led_positions_skipped_when_not_subscribed);
    RUN_TEST(test_send_led_positions_maintains_subscribed_state);
    RUN_TEST(test_send_led_positions_handles_empty_array);
    RUN_TEST(test_send_led_positions_repeated_calls_preserve_state);

    // State transition tests
    RUN_TEST(test_multiple_state_transitions);

    // Timing constant tests
    RUN_TEST(test_websocket_timing_constants_defined);

    // Protocol constant tests
    RUN_TEST(test_graphql_ws_protocol_defined);

    return UNITY_END();
}
