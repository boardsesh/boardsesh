/**
 * Unit Tests for Nordic UART BLE Library
 *
 * Tests the BLE UART service for Kilter/Tension board communication.
 */

#include <NimBLEDevice.h>
#include <Preferences.h>

#include <cstring>
#include <nordic_uart_ble.h>
#include <unity.h>

// Test instance
static NordicUartBLE* ble;

// Test callback tracking
static bool lastConnectState = false;
static int connectCallbackCount = 0;
static bool connectCallbackSawConnectionParameterRequest = false;
static std::vector<uint8_t> lastDataReceived;
static int dataCallbackCount = 0;
static std::vector<LedCommand> lastLedCommands;
static int ledDataCallbackCount = 0;
static int lastAngle = 0;

// These duplicate the externally observable connection request deliberately so
// the test fails if production changes its BLE timing contract.
constexpr uint16_t kExpectedConnectionIntervalMin = 6;           // 7.5 ms in 1.25 ms units
constexpr uint16_t kExpectedConnectionIntervalMax = 18;          // 22.5 ms in 1.25 ms units
constexpr uint16_t kExpectedConnectionLatency = 0;               // No skipped connection events
constexpr uint16_t kExpectedConnectionSupervisionTimeout = 200;  // 2 s in 10 ms units

void testConnectCallback(bool connected) {
    lastConnectState = connected;
    connectCallbackCount++;
    NimBLEServer* server = NimBLEDevice::getServer();
    connectCallbackSawConnectionParameterRequest =
        server != nullptr && server->getConnectionParameterUpdateCallCount() > 0;
}

void testDataCallback(const uint8_t* data, size_t len) {
    lastDataReceived.assign(data, data + len);
    dataCallbackCount++;
}

void testLedDataCallback(const LedCommand* commands, int count, int angle) {
    lastLedCommands.clear();
    for (int i = 0; i < count; i++) {
        lastLedCommands.push_back(commands[i]);
    }
    ledDataCallbackCount++;
    lastAngle = angle;
}

void setUp(void) {
    Preferences::resetAll();
    NimBLEDevice::mockReset();
    lastConnectState = false;
    connectCallbackCount = 0;
    connectCallbackSawConnectionParameterRequest = false;
    lastDataReceived.clear();
    dataCallbackCount = 0;
    lastLedCommands.clear();
    ledDataCallbackCount = 0;
    lastAngle = 0;
    ble = new NordicUartBLE();
}

void tearDown(void) {
    delete ble;
    ble = nullptr;
}

// =============================================================================
// Constructor Tests
// =============================================================================

void test_initial_state_not_connected(void) {
    TEST_ASSERT_FALSE(ble->isConnected());
}

void test_initial_device_address_empty(void) {
    TEST_ASSERT_EQUAL_STRING("", ble->getConnectedDeviceAddress().c_str());
}

// =============================================================================
// Begin Tests
// =============================================================================

void test_begin_initializes_nimble_device(void) {
    ble->begin("Test Device");
    TEST_ASSERT_TRUE(NimBLEDevice::isInitialized());
}

void test_begin_sets_device_name(void) {
    ble->begin("My BLE Device");
    TEST_ASSERT_EQUAL_STRING("My BLE Device", NimBLEDevice::getDeviceName().c_str());
}

void test_begin_sets_power_level(void) {
    ble->begin("Test Device");
    TEST_ASSERT_EQUAL(ESP_PWR_LVL_P9, NimBLEDevice::getPower());
}

void test_begin_creates_server(void) {
    ble->begin("Test Device");
    TEST_ASSERT_NOT_NULL(NimBLEDevice::getServer());
}

void test_begin_starts_advertising(void) {
    ble->begin("Test Device");
    TEST_ASSERT_TRUE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertisingEnabled());
}

void test_begin_can_delay_advertising(void) {
    ble->begin("Test Device", false);
    TEST_ASSERT_FALSE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_FALSE(ble->isAdvertising());
    TEST_ASSERT_FALSE(ble->isAdvertisingEnabled());
}

void test_start_advertising_tracks_state(void) {
    ble->begin("Test Device", false);
    ble->startAdvertising();
    TEST_ASSERT_TRUE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertisingEnabled());
}

void test_begin_registers_aurora_service_uuid(void) {
    ble->begin("Test Device");
    const auto& uuids = NimBLEDevice::getAdvertising()->getServiceUUIDs();
    bool found = false;
    for (const auto& uuid : uuids) {
        if (uuid == AURORA_ADVERTISED_SERVICE_UUID) {
            found = true;
            break;
        }
    }
    TEST_ASSERT_TRUE(found);
}

void test_begin_advertises_device_name_in_scan_response(void) {
    ble->begin("Kilter Board#123456@3");
    NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();

    TEST_ASSERT_TRUE(advertising->isScanResponseEnabled());
    TEST_ASSERT_EQUAL_STRING("Kilter Board#123456@3", advertising->getScanResponseName().c_str());
}

void test_begin_registers_nus_gatt_service_uuid(void) {
    ble->begin("Test Device");
    TEST_ASSERT_NOT_NULL(NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID));
}

// =============================================================================
// Callback Registration Tests
// =============================================================================

void test_set_connect_callback_and_verify_invocation(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("Test Device");

    // Simulate connection - callback should be invoked
    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);

    TEST_ASSERT_EQUAL(1, connectCallbackCount);
    TEST_ASSERT_TRUE(lastConnectState);
}

void test_set_data_callback_and_verify_invocation(void) {
    ble->setDataCallback(testDataCallback);
    ble->begin("Test Device");

    // Connect first
    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    NimBLEDevice::getServer()->mockConnect(&desc);

    // Get the RX characteristic and simulate a write
    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID);
    TEST_ASSERT_NOT_NULL(service);

    NimBLECharacteristic* rxChar = service->getCharacteristic(NUS_RX_CHARACTERISTIC);
    TEST_ASSERT_NOT_NULL(rxChar);

    // Write raw data (not aurora protocol)
    uint8_t testData[] = {0x01, 0x02, 0x03};
    rxChar->mockWrite(testData, sizeof(testData));

    TEST_ASSERT_EQUAL(1, dataCallbackCount);
    TEST_ASSERT_EQUAL(3, lastDataReceived.size());
    TEST_ASSERT_EQUAL(0x01, lastDataReceived[0]);
}

void test_set_led_data_callback_registration(void) {
    // LED data callback requires full Aurora protocol frames
    // Just verify registration doesn't affect state
    bool connectedBefore = ble->isConnected();
    ble->setLedDataCallback(testLedDataCallback);
    TEST_ASSERT_EQUAL(connectedBefore, ble->isConnected());
}

// =============================================================================
// Connection Lifecycle Tests
// =============================================================================

void test_connection_requests_expected_connection_parameters_before_callback(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 42;
    NimBLEDevice::getServer()->mockConnect(&desc);

    NimBLEServer* server = NimBLEDevice::getServer();
    TEST_ASSERT_EQUAL(1, server->getConnectionParameterUpdateCallCount());
    TEST_ASSERT_EQUAL(42, server->getConnectionParameterUpdateHandle());
    TEST_ASSERT_EQUAL(kExpectedConnectionIntervalMin, server->getConnectionParameterUpdateMinInterval());
    TEST_ASSERT_EQUAL(kExpectedConnectionIntervalMax, server->getConnectionParameterUpdateMaxInterval());
    TEST_ASSERT_EQUAL(kExpectedConnectionLatency, server->getConnectionParameterUpdateLatency());
    TEST_ASSERT_EQUAL(kExpectedConnectionSupervisionTimeout, server->getConnectionParameterUpdateTimeout());
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
    TEST_ASSERT_TRUE(connectCallbackSawConnectionParameterRequest);
}

void test_reconnect_requests_connection_parameters_again(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc firstConnection;
    memset(&firstConnection, 0, sizeof(firstConnection));
    firstConnection.conn_handle = 42;
    NimBLEDevice::getServer()->mockConnect(&firstConnection);
    NimBLEDevice::getServer()->mockDisconnect(&firstConnection);

    ble_gap_conn_desc secondConnection;
    memset(&secondConnection, 0, sizeof(secondConnection));
    secondConnection.conn_handle = 43;
    NimBLEDevice::getServer()->mockConnect(&secondConnection);

    NimBLEServer* server = NimBLEDevice::getServer();
    TEST_ASSERT_EQUAL(2, server->getConnectionParameterUpdateCallCount());
    TEST_ASSERT_EQUAL(43, server->getConnectionParameterUpdateHandle());
    TEST_ASSERT_EQUAL(kExpectedConnectionSupervisionTimeout, server->getConnectionParameterUpdateTimeout());
}

void test_connection_callback_called_on_connect(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("Test Device");

    // Simulate connection
    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0xAA;
    desc.peer_ota_addr[1] = 0xBB;
    desc.peer_ota_addr[2] = 0xCC;
    desc.peer_ota_addr[3] = 0xDD;
    desc.peer_ota_addr[4] = 0xEE;
    desc.peer_ota_addr[5] = 0xFF;

    NimBLEDevice::getServer()->mockConnect(&desc);

    TEST_ASSERT_TRUE(ble->isConnected());
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
    TEST_ASSERT_TRUE(lastConnectState);
}

void test_advertising_stops_while_connected(void) {
    ble->begin("Test Device");
    TEST_ASSERT_TRUE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertising());

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);

    TEST_ASSERT_TRUE(ble->isConnected());
    TEST_ASSERT_FALSE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_FALSE(ble->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertisingEnabled());
}

void test_advertising_restarts_after_disconnect(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    NimBLEDevice::getServer()->mockDisconnect(&desc);

    TEST_ASSERT_FALSE(ble->isConnected());
    TEST_ASSERT_TRUE(NimBLEDevice::getAdvertising()->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertising());
    TEST_ASSERT_TRUE(ble->isAdvertisingEnabled());
}

void test_connection_callback_called_on_disconnect(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("Test Device");

    // Simulate connection then disconnection
    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    connectCallbackCount = 0;  // Reset for disconnect test

    NimBLEDevice::getServer()->mockDisconnect(&desc);

    TEST_ASSERT_FALSE(ble->isConnected());
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
    TEST_ASSERT_FALSE(lastConnectState);
}

// =============================================================================
// Device Address Tests
// =============================================================================

void test_connected_device_address_set_on_connect(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0x11;
    desc.peer_ota_addr[1] = 0x22;
    desc.peer_ota_addr[2] = 0x33;
    desc.peer_ota_addr[3] = 0x44;
    desc.peer_ota_addr[4] = 0x55;
    desc.peer_ota_addr[5] = 0x66;

    NimBLEDevice::getServer()->mockConnect(&desc);

    // Address format should be XX:XX:XX:XX:XX:XX
    String addr = ble->getConnectedDeviceAddress();
    TEST_ASSERT_TRUE(addr.length() > 0);
}

void test_connected_device_address_cleared_on_disconnect(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    NimBLEDevice::getServer()->mockDisconnect(&desc);

    TEST_ASSERT_EQUAL_STRING("", ble->getConnectedDeviceAddress().c_str());
}

// =============================================================================
// Hash Deduplication Tests
// =============================================================================

void test_should_send_led_data_true_for_first_send(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0xAA;

    NimBLEDevice::getServer()->mockConnect(&desc);

    // First send should always return true
    TEST_ASSERT_TRUE(ble->shouldSendLedData(12345));
}

void test_should_send_led_data_false_for_same_hash(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0xAA;

    NimBLEDevice::getServer()->mockConnect(&desc);

    uint32_t hash = 12345;
    ble->updateLastSentHash(hash);

    // Same hash should return false
    TEST_ASSERT_FALSE(ble->shouldSendLedData(hash));
}

void test_should_send_led_data_true_for_different_hash(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0xAA;

    NimBLEDevice::getServer()->mockConnect(&desc);

    ble->updateLastSentHash(12345);

    // Different hash should return true
    TEST_ASSERT_TRUE(ble->shouldSendLedData(67890));
}

void test_should_send_led_data_true_when_no_device(void) {
    ble->begin("Test Device");
    // Not connected - should allow sending
    TEST_ASSERT_TRUE(ble->shouldSendLedData(12345));
}

void test_clear_last_sent_hash(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    desc.peer_ota_addr[0] = 0xAA;

    NimBLEDevice::getServer()->mockConnect(&desc);

    ble->updateLastSentHash(12345);
    TEST_ASSERT_FALSE(ble->shouldSendLedData(12345));

    ble->clearLastSentHash();
    TEST_ASSERT_TRUE(ble->shouldSendLedData(12345));
}

// =============================================================================
// Aurora Frame → LED Strip Tests
// =============================================================================

// Build a complete Aurora V3 single-packet frame ('T') lighting the given
// (position, packed RRRGGGBB color) pairs. An empty list produces a valid
// zero-LED frame (the app's "clear board" command).
static std::vector<uint8_t> buildV3Frame(const std::vector<std::pair<uint16_t, uint8_t>>& ledsToLight) {
    std::vector<uint8_t> data;
    data.push_back('T');  // CMD_V3_PACKET_ONLY
    for (const auto& led : ledsToLight) {
        data.push_back(led.first & 0xFF);
        data.push_back((led.first >> 8) & 0xFF);
        data.push_back(led.second);
    }

    uint8_t checksum = 0;
    for (uint8_t byte : data) {
        checksum = (checksum + byte) & 0xFF;
    }
    checksum ^= 0xFF;

    std::vector<uint8_t> frame;
    frame.push_back(0x01);  // SOH
    frame.push_back((uint8_t)data.size());
    frame.push_back(checksum);
    frame.push_back(0x02);  // STX
    frame.insert(frame.end(), data.begin(), data.end());
    frame.push_back(0x03);  // ETX
    return frame;
}

static NimBLECharacteristic* connectAndGetRxCharacteristic() {
    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;
    NimBLEDevice::getServer()->mockConnect(&desc);

    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID);
    return service ? service->getCharacteristic(NUS_RX_CHARACTERISTIC) : nullptr;
}

// Regression test: each complete Aurora frame is the FULL LED state for a
// climb, so switching climbs must clear the previous climb's holds instead of
// accumulating them on the strip.
void test_new_climb_frame_clears_previous_climb_leds(void) {
    LEDs.begin(50);
    ble->setLedDataCallback(testLedDataCallback);
    ble->begin("Test Device");

    NimBLECharacteristic* rxChar = connectAndGetRxCharacteristic();
    TEST_ASSERT_NOT_NULL(rxChar);

    CRGB* strip = CFastLED::getLeds();
    TEST_ASSERT_NOT_NULL(strip);

    // Climb A lights LEDs 1 and 2 (0xE0 = full red in RRRGGGBB)
    std::vector<uint8_t> climbA = buildV3Frame({{1, 0xE0}, {2, 0xE0}});
    rxChar->mockWrite(climbA.data(), climbA.size());

    TEST_ASSERT_TRUE(strip[1] != CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[2] != CRGB(0, 0, 0));
    TEST_ASSERT_EQUAL(1, ledDataCallbackCount);
    TEST_ASSERT_EQUAL(2, lastLedCommands.size());

    // Climb B lights LED 3 only — LEDs 1 and 2 must turn off
    std::vector<uint8_t> climbB = buildV3Frame({{3, 0xE0}});
    rxChar->mockWrite(climbB.data(), climbB.size());

    TEST_ASSERT_TRUE(strip[3] != CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[1] == CRGB(0, 0, 0));
    TEST_ASSERT_TRUE(strip[2] == CRGB(0, 0, 0));
    TEST_ASSERT_EQUAL(2, ledDataCallbackCount);
}

void test_empty_frame_clears_all_leds(void) {
    LEDs.begin(50);
    ble->setLedDataCallback(testLedDataCallback);
    ble->begin("Test Device");

    NimBLECharacteristic* rxChar = connectAndGetRxCharacteristic();
    TEST_ASSERT_NOT_NULL(rxChar);

    CRGB* strip = CFastLED::getLeds();

    std::vector<uint8_t> climb = buildV3Frame({{4, 0xE0}});
    rxChar->mockWrite(climb.data(), climb.size());
    TEST_ASSERT_TRUE(strip[4] != CRGB(0, 0, 0));

    // Zero-LED frame = "clear board" from the app
    std::vector<uint8_t> clearFrame = buildV3Frame({});
    rxChar->mockWrite(clearFrame.data(), clearFrame.size());

    TEST_ASSERT_TRUE(strip[4] == CRGB(0, 0, 0));
    // The clear is not forwarded to the backend (only non-empty climbs are)
    TEST_ASSERT_EQUAL(1, ledDataCallbackCount);
}

// =============================================================================
// Disconnect Client Tests
// =============================================================================

void test_disconnect_client_when_connected(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 42;

    NimBLEDevice::getServer()->mockConnect(&desc);
    TEST_ASSERT_TRUE(ble->isConnected());

    ble->disconnectClient();

    // Check that disconnect was called with correct handle
    TEST_ASSERT_EQUAL(42, NimBLEDevice::getServer()->getDisconnectedHandle());
}

void test_disconnect_client_when_not_connected(void) {
    ble->begin("Test Device");
    TEST_ASSERT_FALSE(ble->isConnected());
    // Not connected - should safely do nothing and remain not connected
    ble->disconnectClient();
    TEST_ASSERT_FALSE(ble->isConnected());
}

// =============================================================================
// Send Tests
// =============================================================================

void test_send_bytes_when_connected(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    TEST_ASSERT_TRUE(ble->isConnected());

    // Get the TX characteristic to verify data was sent
    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID);
    TEST_ASSERT_NOT_NULL(service);
    NimBLECharacteristic* txChar = service->getCharacteristic(NUS_TX_CHARACTERISTIC);
    TEST_ASSERT_NOT_NULL(txChar);

    int notifyCountBefore = txChar->getNotifyCount();

    uint8_t data[] = {0x01, 0x02, 0x03};
    ble->send(data, sizeof(data));

    // Verify notify was called (data sent)
    TEST_ASSERT_EQUAL(notifyCountBefore + 1, txChar->getNotifyCount());
}

void test_send_string_when_connected(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    TEST_ASSERT_TRUE(ble->isConnected());

    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID);
    NimBLECharacteristic* txChar = service->getCharacteristic(NUS_TX_CHARACTERISTIC);

    int notifyCountBefore = txChar->getNotifyCount();
    ble->send(String("Hello"));

    TEST_ASSERT_EQUAL(notifyCountBefore + 1, txChar->getNotifyCount());
}

void test_send_when_not_connected(void) {
    ble->begin("Test Device");
    TEST_ASSERT_FALSE(ble->isConnected());

    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(NUS_SERVICE_UUID);
    NimBLECharacteristic* txChar = service->getCharacteristic(NUS_TX_CHARACTERISTIC);
    int notifyCountBefore = txChar->getNotifyCount();

    // Send when not connected - should not send
    uint8_t data[] = {0x01, 0x02, 0x03};
    ble->send(data, sizeof(data));

    // Verify no notification was sent
    TEST_ASSERT_EQUAL(notifyCountBefore, txChar->getNotifyCount());
}

// =============================================================================
// Loop Tests
// =============================================================================

void test_loop_maintains_disconnected_state(void) {
    ble->begin("Test Device");
    TEST_ASSERT_FALSE(ble->isConnected());

    ble->loop();
    ble->loop();

    // State should be preserved
    TEST_ASSERT_FALSE(ble->isConnected());
}

void test_loop_maintains_connected_state(void) {
    ble->begin("Test Device");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    TEST_ASSERT_TRUE(ble->isConnected());

    ble->loop();
    ble->loop();

    // State should be preserved
    TEST_ASSERT_TRUE(ble->isConnected());
}

// =============================================================================
// UUID Constants Tests
// =============================================================================

void test_service_uuids_defined(void) {
    TEST_ASSERT_EQUAL_STRING("4488b571-7806-4df6-bcff-a2897e4953ff", AURORA_ADVERTISED_SERVICE_UUID);
    TEST_ASSERT_EQUAL_STRING("6E400001-B5A3-F393-E0A9-E50E24DCCA9E", NUS_SERVICE_UUID);
    TEST_ASSERT_EQUAL_STRING("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", NUS_RX_CHARACTERISTIC);
    TEST_ASSERT_EQUAL_STRING("6E400003-B5A3-F393-E0A9-E50E24DCCA9E", NUS_TX_CHARACTERISTIC);
}

// =============================================================================
// Per-MAC Hash Tracking Tests
// =============================================================================

void test_different_mac_addresses_tracked_separately(void) {
    ble->begin("Test Device");

    // Connect first device
    ble_gap_conn_desc desc1;
    memset(&desc1, 0, sizeof(desc1));
    desc1.conn_handle = 1;
    desc1.peer_ota_addr[0] = 0xAA;

    NimBLEDevice::getServer()->mockConnect(&desc1);
    ble->updateLastSentHash(11111);

    // Disconnect first device
    NimBLEDevice::getServer()->mockDisconnect(&desc1);

    // Connect second device with different MAC
    ble_gap_conn_desc desc2;
    memset(&desc2, 0, sizeof(desc2));
    desc2.conn_handle = 2;
    desc2.peer_ota_addr[0] = 0xBB;

    NimBLEDevice::getServer()->mockConnect(&desc2);

    // Second device should be able to send (no hash recorded for this MAC)
    TEST_ASSERT_TRUE(ble->shouldSendLedData(11111));
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Constructor tests
    RUN_TEST(test_initial_state_not_connected);
    RUN_TEST(test_initial_device_address_empty);

    // Begin tests
    RUN_TEST(test_begin_initializes_nimble_device);
    RUN_TEST(test_begin_sets_device_name);
    RUN_TEST(test_begin_sets_power_level);
    RUN_TEST(test_begin_creates_server);
    RUN_TEST(test_begin_starts_advertising);
    RUN_TEST(test_begin_can_delay_advertising);
    RUN_TEST(test_start_advertising_tracks_state);
    RUN_TEST(test_begin_registers_aurora_service_uuid);
    RUN_TEST(test_begin_advertises_device_name_in_scan_response);
    RUN_TEST(test_begin_registers_nus_gatt_service_uuid);

    // Callback registration tests
    RUN_TEST(test_set_connect_callback_and_verify_invocation);
    RUN_TEST(test_set_data_callback_and_verify_invocation);
    RUN_TEST(test_set_led_data_callback_registration);

    // Connection lifecycle tests
    RUN_TEST(test_connection_requests_expected_connection_parameters_before_callback);
    RUN_TEST(test_reconnect_requests_connection_parameters_again);
    RUN_TEST(test_connection_callback_called_on_connect);
    RUN_TEST(test_advertising_stops_while_connected);
    RUN_TEST(test_advertising_restarts_after_disconnect);
    RUN_TEST(test_connection_callback_called_on_disconnect);

    // Device address tests
    RUN_TEST(test_connected_device_address_set_on_connect);
    RUN_TEST(test_connected_device_address_cleared_on_disconnect);

    // Hash deduplication tests
    RUN_TEST(test_should_send_led_data_true_for_first_send);
    RUN_TEST(test_should_send_led_data_false_for_same_hash);
    RUN_TEST(test_should_send_led_data_true_for_different_hash);
    RUN_TEST(test_should_send_led_data_true_when_no_device);
    RUN_TEST(test_clear_last_sent_hash);

    RUN_TEST(test_new_climb_frame_clears_previous_climb_leds);
    RUN_TEST(test_empty_frame_clears_all_leds);

    // Disconnect client tests
    RUN_TEST(test_disconnect_client_when_connected);
    RUN_TEST(test_disconnect_client_when_not_connected);

    // Send tests
    RUN_TEST(test_send_bytes_when_connected);
    RUN_TEST(test_send_string_when_connected);
    RUN_TEST(test_send_when_not_connected);

    // Loop tests
    RUN_TEST(test_loop_maintains_disconnected_state);
    RUN_TEST(test_loop_maintains_connected_state);

    // UUID constants tests
    RUN_TEST(test_service_uuids_defined);

    // Per-MAC tracking tests
    RUN_TEST(test_different_mac_addresses_tracked_separately);

    return UNITY_END();
}
