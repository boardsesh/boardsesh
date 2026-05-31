/**
 * Unit Tests for WiFi Utils Library
 *
 * Tests the WiFi connection management with auto-reconnect functionality.
 */

#include <Preferences.h>
#include <WiFi.h>
#include <wifi_utils.h>

#include <config_manager.h>
#include <unity.h>

// Test instance
static WiFiUtils* wifiMgr;

void setUp(void) {
    Preferences::resetAll();  // Clear config storage
    WiFi.mockReset();         // Reset WiFi mock state
    wifiMgr = new WiFiUtils();
}

void tearDown(void) {
    delete wifiMgr;
    wifiMgr = nullptr;
}

// =============================================================================
// Initial State Tests
// =============================================================================

void test_initial_state_disconnected(void) {
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

void test_initial_isConnected_false(void) {
    TEST_ASSERT_FALSE(wifiMgr->isConnected());
}

// =============================================================================
// Begin Tests
// =============================================================================

void test_begin_sets_sta_mode(void) {
    wifiMgr->begin();
    TEST_ASSERT_EQUAL(WIFI_STA, WiFi.getMode());
}

void test_begin_enables_auto_reconnect(void) {
    wifiMgr->begin();
    TEST_ASSERT_TRUE(WiFi.getAutoReconnect());
}

// =============================================================================
// mDNS Hostname Tests
// =============================================================================

void test_buildMdnsHostName_uses_device_name_and_mac_suffix(void) {
    String hostname = WiFiUtils::buildMdnsHostName("Kilter Board#751737@3", "FC:B4:67:DB:2A:80");

    TEST_ASSERT_EQUAL_STRING("kilter-board-751737-3-db2a80", hostname.c_str());
}

void test_buildMdnsHostName_collapses_invalid_characters(void) {
    String hostname = WiFiUtils::buildMdnsHostName("  MoonBoard   A!!!", "AA:BB:CC:12:34:56");

    TEST_ASSERT_EQUAL_STRING("moonboard-a-123456", hostname.c_str());
}

void test_buildMdnsHostName_falls_back_for_empty_name(void) {
    String hostname = WiFiUtils::buildMdnsHostName("!!!", "AA:BB:CC:12:34:56");

    TEST_ASSERT_EQUAL_STRING("boardsesh-esp32-123456", hostname.c_str());
}

void test_buildMdnsHostName_keeps_dns_label_under_sixty_three_chars(void) {
    String hostname =
        WiFiUtils::buildMdnsHostName("Very Long Boardsesh Controller Name That Exceeds The DNS Label Limit",
                                     "AA:BB:CC:12:34:56");

    TEST_ASSERT_TRUE(hostname.length() <= 63);
    TEST_ASSERT_TRUE(hostname.endsWith("-123456"));
}

// =============================================================================
// Connect Tests
// =============================================================================

void test_connect_starts_connection(void) {
    wifiMgr->begin();
    bool result = wifiMgr->connect("TestNetwork", "password123");

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());
}

void test_connect_saves_credentials(void) {
    wifiMgr->begin();
    wifiMgr->connect("MySSID", "MyPassword", true);

    // Check that credentials were saved via ConfigManager
    String savedSSID = Config.getString(WiFiUtils::KEY_SSID);
    String savedPass = Config.getString(WiFiUtils::KEY_PASSWORD);

    TEST_ASSERT_EQUAL_STRING("MySSID", savedSSID.c_str());
    TEST_ASSERT_EQUAL_STRING("MyPassword", savedPass.c_str());
}

void test_connect_without_save(void) {
    wifiMgr->begin();
    wifiMgr->connect("TempNetwork", "TempPass", false);

    // Credentials should not be saved
    String savedSSID = Config.getString(WiFiUtils::KEY_SSID);
    TEST_ASSERT_EQUAL_STRING("", savedSSID.c_str());
}

void test_connect_empty_password(void) {
    wifiMgr->begin();
    bool result = wifiMgr->connect("OpenNetwork", "");

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());
}

// =============================================================================
// Connect Saved Tests
// =============================================================================

void test_connectSaved_returns_false_when_no_saved_credentials(void) {
    wifiMgr->begin();
    bool result = wifiMgr->connectSaved();

    TEST_ASSERT_FALSE(result);
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

void test_connectSaved_uses_stored_credentials(void) {
    // Pre-save credentials
    Config.setString(WiFiUtils::KEY_SSID, "SavedNetwork");
    Config.setString(WiFiUtils::KEY_PASSWORD, "SavedPass");

    wifiMgr->begin();
    bool result = wifiMgr->connectSaved();

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());
}

// =============================================================================
// Disconnect Tests
// =============================================================================

void test_disconnect_sets_state(void) {
    wifiMgr->begin();
    wifiMgr->connect("Network", "pass");
    wifiMgr->disconnect();

    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

// =============================================================================
// State Callback Tests
// =============================================================================

static WiFiConnectionState lastCallbackState;
static int callbackCount;

void testStateCallback(WiFiConnectionState state) {
    lastCallbackState = state;
    callbackCount++;
}

void test_state_callback_on_connect(void) {
    callbackCount = 0;
    lastCallbackState = WiFiConnectionState::DISCONNECTED;

    wifiMgr->begin();
    wifiMgr->setStateCallback(testStateCallback);
    wifiMgr->connect("Network", "pass");

    TEST_ASSERT_EQUAL(1, callbackCount);
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, lastCallbackState);
}

void test_state_callback_on_disconnect(void) {
    callbackCount = 0;

    wifiMgr->begin();
    wifiMgr->connect("Network", "pass");
    wifiMgr->setStateCallback(testStateCallback);
    wifiMgr->disconnect();

    TEST_ASSERT_EQUAL(1, callbackCount);
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, lastCallbackState);
}

void test_no_callback_when_state_unchanged(void) {
    callbackCount = 0;

    wifiMgr->begin();
    wifiMgr->setStateCallback(testStateCallback);
    wifiMgr->disconnect();  // Already disconnected

    TEST_ASSERT_EQUAL(0, callbackCount);  // No state change, no callback
}

void test_null_callback_is_safe(void) {
    wifiMgr->begin();
    wifiMgr->setStateCallback(nullptr);
    wifiMgr->connect("Network", "pass");  // Should not crash
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Connection State Machine Tests
// =============================================================================

void test_checkConnection_transitions_to_connected(void) {
    wifiMgr->begin();
    wifiMgr->connect("Network", "pass");

    // Simulate WiFi becoming connected
    WiFi.mockSetStatus(WL_CONNECTED);
    wifiMgr->loop();

    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTED, wifiMgr->getState());
}

void test_isConnected_reflects_wifi_status(void) {
    WiFi.mockSetStatus(WL_CONNECTED);
    TEST_ASSERT_TRUE(wifiMgr->isConnected());

    WiFi.mockSetStatus(WL_DISCONNECTED);
    TEST_ASSERT_FALSE(wifiMgr->isConnected());
}

void test_connected_state_transitions_to_disconnected(void) {
    wifiMgr->begin();
    wifiMgr->connect("Network", "pass");

    // Simulate connection
    WiFi.mockSetStatus(WL_CONNECTED);
    wifiMgr->loop();
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTED, wifiMgr->getState());

    // Simulate disconnection
    WiFi.mockSetStatus(WL_DISCONNECTED);
    wifiMgr->loop();
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

void test_disconnected_detects_connection(void) {
    wifiMgr->begin();

    // Simulate external connection (e.g., reconnect by WiFi library)
    WiFi.mockSetStatus(WL_CONNECTED);
    wifiMgr->loop();

    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTED, wifiMgr->getState());
}

// =============================================================================
// Status Information Tests
// =============================================================================

void test_getSSID_returns_wifi_ssid(void) {
    WiFi.mockSetSSID("TestNetwork");
    String ssid = wifiMgr->getSSID();
    TEST_ASSERT_EQUAL_STRING("TestNetwork", ssid.c_str());
}

void test_getIP_returns_wifi_ip(void) {
    WiFi.mockSetLocalIP(192, 168, 1, 50);
    String ip = wifiMgr->getIP();
    TEST_ASSERT_EQUAL_STRING("192.168.1.50", ip.c_str());
}

void test_getRSSI_returns_wifi_rssi(void) {
    WiFi.mockSetRSSI(-65);
    int8_t rssi = wifiMgr->getRSSI();
    TEST_ASSERT_EQUAL(-65, rssi);
}

// =============================================================================
// Edge Cases
// =============================================================================

void test_multiple_connect_calls(void) {
    wifiMgr->begin();
    wifiMgr->connect("Network1", "pass1");
    wifiMgr->connect("Network2", "pass2");

    // Should use latest credentials
    String savedSSID = Config.getString(WiFiUtils::KEY_SSID);
    TEST_ASSERT_EQUAL_STRING("Network2", savedSSID.c_str());
}

void test_connect_after_disconnect(void) {
    wifiMgr->begin();
    wifiMgr->connect("Network", "pass");
    wifiMgr->disconnect();
    wifiMgr->connect("Network2", "pass2");

    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());
}

void test_loop_when_not_connecting(void) {
    wifiMgr->begin();
    wifiMgr->loop();  // Should not crash when not in connecting state
    TEST_ASSERT_TRUE(true);
}

void test_getState_reflects_current_state(void) {
    wifiMgr->begin();

    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());

    wifiMgr->connect("Network", "pass");
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());

    WiFi.mockSetStatus(WL_CONNECTED);
    wifiMgr->loop();
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTED, wifiMgr->getState());
}

// =============================================================================
// AP Mode Tests
// =============================================================================

void test_startAP_sets_ap_mode(void) {
    wifiMgr->begin();
    bool result = wifiMgr->startAP("TestAP");

    TEST_ASSERT_TRUE(result);
    TEST_ASSERT_TRUE(wifiMgr->isAPMode());
    TEST_ASSERT_EQUAL(WiFiConnectionState::AP_MODE, wifiMgr->getState());
}

void test_startAP_clears_credentials_prevents_reconnect_loop(void) {
    wifiMgr->begin();

    // Simulate a failed connection attempt that sets currentSSID/currentPassword
    wifiMgr->connect("FailingNetwork", "password123", false);
    TEST_ASSERT_EQUAL(WiFiConnectionState::CONNECTING, wifiMgr->getState());

    // Enter AP mode - should clear in-memory credentials
    wifiMgr->startAP("SetupAP");
    TEST_ASSERT_EQUAL(WiFiConnectionState::AP_MODE, wifiMgr->getState());

    // Stop AP mode - transitions to DISCONNECTED
    wifiMgr->stopAP();
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());

    // Run the loop - checkConnection should NOT attempt reconnection
    // because currentSSID was cleared by startAP()
    wifiMgr->loop();

    // Should remain DISCONNECTED (not transition to CONNECTING)
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

void test_startAP_after_failed_connection(void) {
    wifiMgr->begin();
    wifiMgr->setStateCallback(testStateCallback);
    callbackCount = 0;

    // Start a connection that will fail
    wifiMgr->connect("BadNetwork", "badpass", false);

    // Enter AP mode
    wifiMgr->startAP("SetupAP");
    TEST_ASSERT_EQUAL(WiFiConnectionState::AP_MODE, wifiMgr->getState());
    TEST_ASSERT_EQUAL(WIFI_AP, WiFi.getMode());
}

void test_stopAP_restores_sta_mode(void) {
    wifiMgr->begin();
    wifiMgr->startAP("TestAP");

    wifiMgr->stopAP();
    TEST_ASSERT_FALSE(wifiMgr->isAPMode());
    TEST_ASSERT_EQUAL(WIFI_STA, WiFi.getMode());
    TEST_ASSERT_EQUAL(WiFiConnectionState::DISCONNECTED, wifiMgr->getState());
}

void test_loop_skips_check_in_ap_mode(void) {
    wifiMgr->begin();
    wifiMgr->startAP("TestAP");

    // Even if WiFi reports connected (shouldn't in AP mode), state should stay AP_MODE
    WiFi.mockSetStatus(WL_CONNECTED);
    wifiMgr->loop();

    TEST_ASSERT_EQUAL(WiFiConnectionState::AP_MODE, wifiMgr->getState());
}

void test_hasSavedCredentials_with_saved(void) {
    Config.setString(WiFiUtils::KEY_SSID, "SavedNet");
    Config.setString(WiFiUtils::KEY_PASSWORD, "SavedPass");

    TEST_ASSERT_TRUE(wifiMgr->hasSavedCredentials());
}

void test_hasSavedCredentials_without_saved(void) {
    TEST_ASSERT_FALSE(wifiMgr->hasSavedCredentials());
}

// =============================================================================
// Config Key Tests
// =============================================================================

void test_key_constants(void) {
    TEST_ASSERT_EQUAL_STRING("wifi_ssid", WiFiUtils::KEY_SSID);
    TEST_ASSERT_EQUAL_STRING("wifi_pass", WiFiUtils::KEY_PASSWORD);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Initial state tests
    RUN_TEST(test_initial_state_disconnected);
    RUN_TEST(test_initial_isConnected_false);

    // Begin tests
    RUN_TEST(test_begin_sets_sta_mode);
    RUN_TEST(test_begin_enables_auto_reconnect);

    // mDNS hostname tests
    RUN_TEST(test_buildMdnsHostName_uses_device_name_and_mac_suffix);
    RUN_TEST(test_buildMdnsHostName_collapses_invalid_characters);
    RUN_TEST(test_buildMdnsHostName_falls_back_for_empty_name);
    RUN_TEST(test_buildMdnsHostName_keeps_dns_label_under_sixty_three_chars);

    // Connect tests
    RUN_TEST(test_connect_starts_connection);
    RUN_TEST(test_connect_saves_credentials);
    RUN_TEST(test_connect_without_save);
    RUN_TEST(test_connect_empty_password);

    // Connect saved tests
    RUN_TEST(test_connectSaved_returns_false_when_no_saved_credentials);
    RUN_TEST(test_connectSaved_uses_stored_credentials);

    // Disconnect tests
    RUN_TEST(test_disconnect_sets_state);

    // State callback tests
    RUN_TEST(test_state_callback_on_connect);
    RUN_TEST(test_state_callback_on_disconnect);
    RUN_TEST(test_no_callback_when_state_unchanged);
    RUN_TEST(test_null_callback_is_safe);

    // Connection state machine tests
    RUN_TEST(test_checkConnection_transitions_to_connected);
    RUN_TEST(test_isConnected_reflects_wifi_status);
    RUN_TEST(test_connected_state_transitions_to_disconnected);
    RUN_TEST(test_disconnected_detects_connection);

    // Status information tests
    RUN_TEST(test_getSSID_returns_wifi_ssid);
    RUN_TEST(test_getIP_returns_wifi_ip);
    RUN_TEST(test_getRSSI_returns_wifi_rssi);

    // Edge cases
    RUN_TEST(test_multiple_connect_calls);
    RUN_TEST(test_connect_after_disconnect);
    RUN_TEST(test_loop_when_not_connecting);
    RUN_TEST(test_getState_reflects_current_state);

    // AP mode tests
    RUN_TEST(test_startAP_sets_ap_mode);
    RUN_TEST(test_startAP_clears_credentials_prevents_reconnect_loop);
    RUN_TEST(test_startAP_after_failed_connection);
    RUN_TEST(test_stopAP_restores_sta_mode);
    RUN_TEST(test_loop_skips_check_in_ap_mode);
    RUN_TEST(test_hasSavedCredentials_with_saved);
    RUN_TEST(test_hasSavedCredentials_without_saved);

    // Config key tests
    RUN_TEST(test_key_constants);

    return UNITY_END();
}
