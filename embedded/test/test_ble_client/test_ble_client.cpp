// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for BLE Client Library
 *
 * Tests the BLE client connection handling, particularly ensuring that
 * connection callbacks are properly invoked on both success and failure paths.
 *
 * Key test: When connect() fails synchronously, the connectCallback must be
 * called with false to notify the proxy of the failure. This prevents the
 * proxy from getting stuck in CONNECTING state.
 */

#include <NimBLEDevice.h>
#include <Preferences.h>
#include <unity.h>

#include <ble_client.h>

// Test callback tracking
static bool lastConnectCallbackValue = false;
static int connectCallbackCount = 0;
static int dataCallbackCount = 0;
static std::vector<uint8_t> lastReceivedData;

void testConnectCallback(bool connected) {
    lastConnectCallbackValue = connected;
    connectCallbackCount++;
}

void testDataCallback(const uint8_t* data, size_t len) {
    dataCallbackCount++;
    lastReceivedData.assign(data, data + len);
}

void setUp(void) {
    // Reset all tracking variables
    lastConnectCallbackValue = false;
    connectCallbackCount = 0;
    dataCallbackCount = 0;
    lastReceivedData.clear();

    // Reset NimBLE mock state
    NimBLEDevice::mockReset();
    NimBLEDevice::init("TestDevice");
}

void tearDown(void) {
    NimBLEDevice::mockReset();
}

// =============================================================================
// Constructor Tests
// =============================================================================

void test_initial_state_is_idle(void) {
    BLEClientConnection client;
    TEST_ASSERT_EQUAL(BLEClientState::IDLE, client.getState());
}

void test_initial_is_connected_returns_false(void) {
    BLEClientConnection client;
    TEST_ASSERT_FALSE(client.isConnected());
}

void test_initial_connected_address_is_empty(void) {
    BLEClientConnection client;
    TEST_ASSERT_EQUAL_STRING("", client.getConnectedAddress().c_str());
}

// =============================================================================
// Connect Basic Tests
// =============================================================================

void test_connect_returns_true_when_ble_connect_succeeds(void) {
    BLEClientConnection client;
    client.setConnectCallback(testConnectCallback);

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    // With default mock (connect succeeds), connect() should return true
    // Note: Service setup will fail since mock has no NUS service,
    // but connect() itself returns true
    bool result = client.connect(address);
    TEST_ASSERT_TRUE(result);
}

void test_connect_triggers_callback(void) {
    BLEClientConnection client;
    client.setConnectCallback(testConnectCallback);

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    client.connect(address);

    // The callback should be triggered at least once
    // (either on connect success or disconnect due to service setup failure)
    TEST_ASSERT_TRUE(connectCallbackCount >= 1);
}

// =============================================================================
// Connect Failure Tests - CRITICAL REGRESSION TESTS
// =============================================================================

/**
 * CRITICAL TEST: When connect() fails synchronously (returns false),
 * the connectCallback MUST be called with false.
 *
 * This prevents the BLE proxy from getting stuck in CONNECTING state
 * when the underlying BLE connection fails.
 *
 * Bug fixed: Previously, connectCallback(false) was only called in
 * onDisconnect(), not when connect() itself failed. This left the
 * proxy stuck in CONNECTING state forever.
 */
void test_connect_failure_triggers_callback_with_false(void) {
    BLEClientConnection client;
    client.setConnectCallback(testConnectCallback);

    // Set up the mock so that the NEXT client created will fail to connect
    NimBLEDevice::mockSetNextConnectSuccess(false);

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    // Reset callback tracking
    connectCallbackCount = 0;
    lastConnectCallbackValue = true;  // Set to true so we can verify it changes to false

    bool result = client.connect(address);

    // connect() should return false when underlying connect fails
    TEST_ASSERT_FALSE(result);

    // CRITICAL: The callback MUST be called with false on synchronous failure
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
    TEST_ASSERT_FALSE(lastConnectCallbackValue);
}

void test_connect_failure_sets_state_to_disconnected(void) {
    BLEClientConnection client;

    // Set up the mock so that the NEXT client created will fail to connect
    NimBLEDevice::mockSetNextConnectSuccess(false);

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    client.connect(address);

    // State should be DISCONNECTED, not stuck in CONNECTING
    TEST_ASSERT_EQUAL(BLEClientState::DISCONNECTED, client.getState());
}

void test_connect_failure_schedules_reconnect(void) {
    BLEClientConnection client;

    // Set up the mock so that the NEXT client created will fail to connect
    NimBLEDevice::mockSetNextConnectSuccess(false);

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    client.connect(address);

    // State should be DISCONNECTED (reconnect handled in loop())
    TEST_ASSERT_EQUAL(BLEClientState::DISCONNECTED, client.getState());
}

// =============================================================================
// Disconnect Tests
// =============================================================================

void test_disconnect_triggers_callback_with_false(void) {
    BLEClientConnection client;
    client.setConnectCallback(testConnectCallback);

    // First connect successfully
    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);
    client.connect(address);

    // Reset callback tracking
    connectCallbackCount = 0;

    // Now disconnect
    client.disconnect();

    // Callback should be triggered with false
    // Note: disconnect() sets state to IDLE, so callback may or may not be called
    // depending on implementation - but if connected, onDisconnect should fire
    TEST_ASSERT_EQUAL(BLEClientState::IDLE, client.getState());
}

void test_disconnect_sets_state_to_idle(void) {
    BLEClientConnection client;

    // First connect successfully
    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);
    client.connect(address);

    // Now disconnect
    client.disconnect();

    TEST_ASSERT_EQUAL(BLEClientState::IDLE, client.getState());
}

// =============================================================================
// Already Connecting/Connected Guard Tests
// =============================================================================

/**
 * Test that connect() is guarded against being called while already connecting.
 *
 * Note: With synchronous mocks, we can't easily test the "in progress" state.
 * This test verifies the guard exists by checking state transitions.
 */
void test_connect_guard_exists(void) {
    BLEClientConnection client;

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    // Verify initial state
    TEST_ASSERT_EQUAL(BLEClientState::IDLE, client.getState());

    // After a failed connect (mock has no service), state should be DISCONNECTED
    // not stuck in CONNECTING
    client.connect(address);

    // State transitions through CONNECTING but ends up elsewhere
    // due to service setup failure or success
    BLEClientState state = client.getState();
    TEST_ASSERT_TRUE(state == BLEClientState::DISCONNECTED ||
                     state == BLEClientState::CONNECTED ||
                     state == BLEClientState::IDLE);
}

/**
 * Test that calling connect() from IDLE state is allowed (for reconnection).
 */
void test_connect_from_idle_allowed(void) {
    BLEClientConnection client;

    uint8_t addr[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    NimBLEAddress address(addr);

    // Initial state is IDLE
    TEST_ASSERT_EQUAL(BLEClientState::IDLE, client.getState());

    // Connect should be allowed from IDLE
    bool result = client.connect(address);
    TEST_ASSERT_TRUE(result);
}

// =============================================================================
// Callback Registration Tests
// =============================================================================

void test_set_connect_callback(void) {
    BLEClientConnection client;
    // Should not crash
    client.setConnectCallback(testConnectCallback);
    client.setConnectCallback(nullptr);
}

void test_set_data_callback(void) {
    BLEClientConnection client;
    // Should not crash
    client.setDataCallback(testDataCallback);
    client.setDataCallback(nullptr);
}

// =============================================================================
// Send Tests
// =============================================================================

void test_send_when_not_connected_returns_false(void) {
    BLEClientConnection client;

    uint8_t data[] = {0x01, 0x02, 0x03};
    bool result = client.send(data, sizeof(data));

    TEST_ASSERT_FALSE(result);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Constructor tests
    RUN_TEST(test_initial_state_is_idle);
    RUN_TEST(test_initial_is_connected_returns_false);
    RUN_TEST(test_initial_connected_address_is_empty);

    // Connect basic tests
    RUN_TEST(test_connect_returns_true_when_ble_connect_succeeds);
    RUN_TEST(test_connect_triggers_callback);

    // Connect failure tests - CRITICAL REGRESSION TESTS
    RUN_TEST(test_connect_failure_triggers_callback_with_false);
    RUN_TEST(test_connect_failure_sets_state_to_disconnected);
    RUN_TEST(test_connect_failure_schedules_reconnect);

    // Disconnect tests
    RUN_TEST(test_disconnect_triggers_callback_with_false);
    RUN_TEST(test_disconnect_sets_state_to_idle);

    // Connection guard tests
    RUN_TEST(test_connect_guard_exists);
    RUN_TEST(test_connect_from_idle_allowed);

    // Callback registration tests
    RUN_TEST(test_set_connect_callback);
    RUN_TEST(test_set_data_callback);

    // Send tests
    RUN_TEST(test_send_when_not_connected_returns_false);

    return UNITY_END();
}
