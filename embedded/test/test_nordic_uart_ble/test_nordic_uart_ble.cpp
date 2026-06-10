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
static std::vector<uint8_t> lastDataReceived;
static int dataCallbackCount = 0;
static std::vector<LedCommand> lastLedCommands;
static int ledDataCallbackCount = 0;
static int lastAngle = 0;

void testConnectCallback(bool connected) {
    lastConnectState = connected;
    connectCallbackCount++;
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
