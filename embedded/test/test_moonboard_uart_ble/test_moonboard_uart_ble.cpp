// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit tests for the MoonBoard BLE UART service.
 */

#include <NimBLEDevice.h>

#include <moonboard_uart_ble.h>
#include <Preferences.h>
#include <unity.h>

static MoonBoardUartBLE* ble;
static bool lastConnectState = false;
static int connectCallbackCount = 0;
static std::vector<uint8_t> lastRawData;
static int dataCallbackCount = 0;
static String lastFrames;
static bool lastLightsAboveHolds = false;
static int problemCallbackCount = 0;

void testConnectCallback(bool connected) {
    lastConnectState = connected;
    connectCallbackCount++;
}

void testDataCallback(const uint8_t* data, size_t len) {
    lastRawData.assign(data, data + len);
    dataCallbackCount++;
}

void testProblemCallback(const MoonBoardDecodedProblem& problem) {
    lastFrames = problem.frames;
    lastLightsAboveHolds = problem.lightsAboveHolds;
    problemCallbackCount++;
}

void setUp(void) {
    Preferences::resetAll();
    NimBLEDevice::mockReset();
    lastConnectState = false;
    connectCallbackCount = 0;
    lastRawData.clear();
    dataCallbackCount = 0;
    lastFrames = "";
    lastLightsAboveHolds = false;
    problemCallbackCount = 0;
    ble = new MoonBoardUartBLE();
}

void tearDown(void) {
    delete ble;
    ble = nullptr;
}

void test_begin_initializes_nimble_device(void) {
    ble->begin("MoonBoard A");
    TEST_ASSERT_TRUE(NimBLEDevice::isInitialized());
    TEST_ASSERT_EQUAL_STRING("MoonBoard A", NimBLEDevice::getDeviceName().c_str());
}

void test_begin_registers_nus_service_uuid(void) {
    ble->begin("MoonBoard A");
    const auto& uuids = NimBLEDevice::getAdvertising()->getServiceUUIDs();
    bool found = false;
    for (const auto& uuid : uuids) {
        if (uuid == MOONBOARD_NUS_SERVICE_UUID) {
            found = true;
            break;
        }
    }
    TEST_ASSERT_TRUE(found);
}

void test_connect_callback_is_invoked(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("MoonBoard A");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);

    TEST_ASSERT_TRUE(ble->isConnected());
    TEST_ASSERT_TRUE(lastConnectState);
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
}

void test_disconnect_callback_is_invoked(void) {
    ble->setConnectCallback(testConnectCallback);
    ble->begin("MoonBoard A");

    ble_gap_conn_desc desc;
    memset(&desc, 0, sizeof(desc));
    desc.conn_handle = 1;

    NimBLEDevice::getServer()->mockConnect(&desc);
    connectCallbackCount = 0;

    NimBLEDevice::getServer()->mockDisconnect(&desc);

    TEST_ASSERT_FALSE(ble->isConnected());
    TEST_ASSERT_FALSE(lastConnectState);
    TEST_ASSERT_EQUAL(1, connectCallbackCount);
}

void test_data_callback_receives_raw_uart_bytes(void) {
    ble->setDataCallback(testDataCallback);
    ble->begin("MoonBoard A");

    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(MOONBOARD_NUS_SERVICE_UUID);
    TEST_ASSERT_NOT_NULL(service);
    NimBLECharacteristic* rxCharacteristic = service->getCharacteristic(MOONBOARD_NUS_RX_CHARACTERISTIC);
    TEST_ASSERT_NOT_NULL(rxCharacteristic);

    const char payload[] = "l#S0#";
    rxCharacteristic->mockWrite(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_EQUAL(1, dataCallbackCount);
    TEST_ASSERT_EQUAL(strlen(payload), lastRawData.size());
}

void test_problem_callback_receives_decoded_frames(void) {
    ble->setProblemCallback(testProblemCallback);
    ble->begin("MoonBoard A");

    NimBLEService* service = NimBLEDevice::getServer()->getServiceByUUID(MOONBOARD_NUS_SERVICE_UUID);
    NimBLECharacteristic* rxCharacteristic = service->getCharacteristic(MOONBOARD_NUS_RX_CHARACTERISTIC);

    const char payload[] = "~Dl#S1,P37,E197#";
    rxCharacteristic->mockWrite(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_EQUAL(1, problemCallbackCount);
    TEST_ASSERT_EQUAL_STRING("p12r42p12r46p14r43p14r46p198r44", lastFrames.c_str());
    TEST_ASSERT_TRUE(lastLightsAboveHolds);
}

int main(int argc, char** argv) {
    UNITY_BEGIN();

    RUN_TEST(test_begin_initializes_nimble_device);
    RUN_TEST(test_begin_registers_nus_service_uuid);
    RUN_TEST(test_connect_callback_is_invoked);
    RUN_TEST(test_disconnect_callback_is_invoked);
    RUN_TEST(test_data_callback_receives_raw_uart_bytes);
    RUN_TEST(test_problem_callback_receives_decoded_frames);

    return UNITY_END();
}
