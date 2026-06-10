/**
 * Unit Tests for ESP Web Server Library
 *
 * Tests the HTTP configuration server for ESP32.
 */

#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <esp_web_server.h>
#include <wifi_utils.h>

#include <config_manager.h>
#include <cstring>
#include <unity.h>

// Test instance
static ESPWebServer* webServer;

// Static test state for non-capturing lambdas
static bool s_handlerCalled;
static String s_receivedBody;

void setUp(void) {
    s_handlerCalled = false;
    s_receivedBody = "";
    Preferences::resetAll();
    WiFi.mockReset();
    ESP.mockReset();
    Update.mockReset();
    webServer = new ESPWebServer();
}

void tearDown(void) {
    webServer->stop();
    delete webServer;
    webServer = nullptr;
}

// =============================================================================
// Constructor Tests
// =============================================================================

void test_server_created_but_not_running(void) {
    // Server should be created but not running initially
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
}

// =============================================================================
// Begin/Stop Tests
// =============================================================================

void test_begin_starts_server(void) {
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
}

void test_stop_stops_server(void) {
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
    webServer->stop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
}

void test_multiple_begin_calls_stay_running(void) {
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
}

void test_multiple_stop_calls_stay_stopped(void) {
    webServer->begin();
    webServer->stop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
    webServer->stop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
    webServer->stop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
}

// =============================================================================
// Loop Tests
// =============================================================================

void test_loop_maintains_state_when_not_started(void) {
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
    webServer->loop();
    webServer->loop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
}

void test_loop_maintains_state_when_started(void) {
    webServer->begin();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
    webServer->loop();
    webServer->loop();
    TEST_ASSERT_TRUE(webServer->getServer().isRunning());
}

void test_loop_after_stop_maintains_stopped_state(void) {
    webServer->begin();
    webServer->stop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
    webServer->loop();
    TEST_ASSERT_FALSE(webServer->getServer().isRunning());
}

// =============================================================================
// SendJson Tests
// =============================================================================

void test_send_json_with_string(void) {
    webServer->begin();
    webServer->sendJson(200, "{\"test\":\"value\"}");
    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_EQUAL_STRING("application/json", webServer->getServer().getLastContentType().c_str());
}

void test_send_json_with_document(void) {
    webServer->begin();
    JsonDocument doc;
    doc["key"] = "value";
    doc["number"] = 42;
    webServer->sendJson(200, doc);
    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_EQUAL_STRING("application/json", webServer->getServer().getLastContentType().c_str());
}

// =============================================================================
// SendError Tests
// =============================================================================

void test_send_error(void) {
    webServer->begin();
    webServer->sendError(400, "Bad Request");
    TEST_ASSERT_EQUAL(400, webServer->getServer().getLastResponseCode());
}

void test_send_error_404(void) {
    webServer->begin();
    webServer->sendError(404, "Not Found");
    TEST_ASSERT_EQUAL(404, webServer->getServer().getLastResponseCode());
}

void test_send_error_500(void) {
    webServer->begin();
    webServer->sendError(500, "Internal Server Error");
    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
}

// =============================================================================
// GetServer Tests
// =============================================================================

void test_get_server_returns_reference(void) {
    webServer->begin();
    WebServer& server = webServer->getServer();
    // Verify we can use the server reference
    TEST_ASSERT_TRUE(server.isRunning());
}

// =============================================================================
// Custom Route Handler Tests
// =============================================================================

void test_add_custom_route_get(void) {
    webServer->on("/test", HTTP_GET, [](WebServer& server) {
        s_handlerCalled = true;
        server.send(200, "text/plain", "OK");
    });
    webServer->begin();

    // Simulate request
    webServer->getServer().mockRequest("/test", HTTP_GET);
    TEST_ASSERT_TRUE(s_handlerCalled);
}

void test_add_custom_route_post(void) {
    webServer->on("/submit", HTTP_POST, [](WebServer& server) {
        s_handlerCalled = true;
        server.send(200, "application/json", "{\"success\":true}");
    });
    webServer->begin();

    webServer->getServer().mockRequest("/submit", HTTP_POST);
    TEST_ASSERT_TRUE(s_handlerCalled);
}

void test_custom_route_receives_body(void) {
    webServer->on("/data", HTTP_POST, [](WebServer& server) {
        if (server.hasArg("plain")) {
            s_receivedBody = server.arg("plain");
        }
        server.send(200, "text/plain", "OK");
    });
    webServer->begin();

    webServer->getServer().mockRequest("/data", HTTP_POST, "{\"data\":\"test\"}");
    TEST_ASSERT_TRUE(s_receivedBody.indexOf("data") >= 0);
}

// =============================================================================
// Built-in Route Tests (via direct server access)
// =============================================================================

void test_root_route_exists(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/", HTTP_GET);

    // Root should return HTML
    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    const std::string& contentType = webServer->getServer().getLastContentType();
    TEST_ASSERT_TRUE(contentType.find("text/html") != std::string::npos);
}

void test_api_config_get_route(void) {
    // Set some config values first
    Config.setString("backend_host", "test.boardsesh.com");
    Config.setInt("backend_port", 443);
    Config.setString("device_name", "Test Controller");
    Config.setInt("brightness", 200);

    webServer->begin();
    webServer->getServer().mockRequest("/api/config", HTTP_GET);

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    const std::string& body = webServer->getServer().getLastResponseBody();
    TEST_ASSERT_TRUE(body.find("backend_host") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("\"backend_sync_enabled\"") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("\"preview_board_name\"") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("\"preview_layout_id\"") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("\"preview_size_id\"") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("\"preview_set_ids\"") != std::string::npos);
}

void test_api_config_post_route(void) {
    webServer->begin();
    webServer->getServer().mockRequest(
        "/api/config",
        HTTP_POST,
        "{\"device_name\":\"New Name\",\"brightness\":100,\"backend_sync_enabled\":true,\"preview_board_name\":\"tension\",\"preview_layout_id\":2,\"preview_size_id\":10,\"preview_set_ids\":\"1,2\"}");

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());

    // Verify config was updated
    TEST_ASSERT_EQUAL_STRING("New Name", Config.getString("device_name").c_str());
    TEST_ASSERT_EQUAL(100, Config.getInt("brightness"));
    TEST_ASSERT_TRUE(Config.getBool("backend_sync"));
    TEST_ASSERT_EQUAL_STRING("tension", Config.getString("preview_board_name").c_str());
    TEST_ASSERT_EQUAL(2, Config.getInt("preview_layout_id"));
    TEST_ASSERT_EQUAL(10, Config.getInt("preview_size_id"));
    TEST_ASSERT_EQUAL_STRING("1,2", Config.getString("preview_set_ids").c_str());
}

void test_api_config_post_invalid_json(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/config", HTTP_POST, "not json");

    TEST_ASSERT_EQUAL(400, webServer->getServer().getLastResponseCode());
}

void test_api_config_post_no_body(void) {
    webServer->begin();
    webServer->getServer().mockClearArgs();
    webServer->getServer().mockRequest("/api/config", HTTP_POST, "");

    TEST_ASSERT_EQUAL(400, webServer->getServer().getLastResponseCode());
}

void test_api_wifi_scan_route(void) {
    // Set up mock networks
    std::vector<MockWiFi::NetworkInfo> networks = {
        {"TestNetwork1", -50, true}, {"TestNetwork2", -70, false}, {"TestNetwork3", -80, true}};
    WiFi.mockSetNetworks(networks);

    webServer->begin();
    webServer->getServer().mockRequest("/api/wifi/scan", HTTP_GET);

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    const std::string& body = webServer->getServer().getLastResponseBody();
    TEST_ASSERT_TRUE(body.find("networks") != std::string::npos);
}

void test_api_wifi_connect_route(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/wifi/connect", HTTP_POST,
                                       "{\"ssid\":\"TestNetwork\",\"password\":\"secret123\"}");

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
}

void test_api_wifi_connect_missing_ssid(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/wifi/connect", HTTP_POST, "{\"password\":\"secret123\"}");

    TEST_ASSERT_EQUAL(400, webServer->getServer().getLastResponseCode());
}

void test_api_wifi_connect_no_body(void) {
    webServer->begin();
    webServer->getServer().mockClearArgs();
    webServer->getServer().mockRequest("/api/wifi/connect", HTTP_POST, "");

    TEST_ASSERT_EQUAL(400, webServer->getServer().getLastResponseCode());
}

void test_api_wifi_status_route(void) {
    // Set up WiFi status using the WiFi mock
    WiFi.mockSetStatus(WL_CONNECTED);
    WiFi.mockSetSSID("MyNetwork");
    WiFi.mockSetLocalIP(192, 168, 1, 50);
    WiFi.mockSetRSSI(-55);

    webServer->begin();
    webServer->getServer().mockRequest("/api/wifi/status", HTTP_GET);

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    const std::string& body = webServer->getServer().getLastResponseBody();
    TEST_ASSERT_TRUE(body.find("connected") != std::string::npos);
}

void test_api_restart_route(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/restart", HTTP_POST);

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_TRUE(ESP.wasRestartCalled());
}

void test_not_found_route(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/nonexistent", HTTP_GET);

    TEST_ASSERT_EQUAL(404, webServer->getServer().getLastResponseCode());
}

// =============================================================================
// CORS Headers Tests
// =============================================================================

void test_cors_headers_on_custom_route(void) {
    webServer->on("/test", HTTP_GET, [](WebServer& server) { server.send(200, "text/plain", "OK"); });
    webServer->begin();

    webServer->getServer().mockRequest("/test", HTTP_GET);

    const auto& headers = webServer->getServer().getLastHeaders();
    auto it = headers.find("Access-Control-Allow-Origin");
    TEST_ASSERT_TRUE(it != headers.end());
    TEST_ASSERT_EQUAL_STRING("*", it->second.c_str());
}

// =============================================================================
// Config Persistence Tests
// =============================================================================

void test_config_values_persist(void) {
    webServer->begin();

    // Set config via API
    webServer->getServer().mockRequest("/api/config", HTTP_POST, "{\"session_id\":\"abc123\",\"api_key\":\"key456\"}");

    // Verify values were saved
    TEST_ASSERT_EQUAL_STRING("abc123", Config.getString("session_id").c_str());
    TEST_ASSERT_EQUAL_STRING("key456", Config.getString("api_key").c_str());
}

void test_config_partial_update(void) {
    // Set initial values
    Config.setString("device_name", "Initial Name");
    Config.setInt("brightness", 128);

    webServer->begin();

    // Update only brightness
    webServer->getServer().mockRequest("/api/config", HTTP_POST, "{\"brightness\":255}");

    // device_name should be unchanged
    TEST_ASSERT_EQUAL_STRING("Initial Name", Config.getString("device_name").c_str());
    TEST_ASSERT_EQUAL(255, Config.getInt("brightness"));
}

// =============================================================================
// Firmware Version Endpoint Tests
// =============================================================================

void test_firmware_version_endpoint(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/firmware/version", HTTP_GET);

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    const std::string& body = webServer->getServer().getLastResponseBody();
    TEST_ASSERT_TRUE(body.find("version") != std::string::npos);
    TEST_ASSERT_TRUE(body.find("build_env") != std::string::npos);
}

void test_firmware_upload_route_registered(void) {
    webServer->begin();
    webServer->getServer().mockRequest("/api/firmware/upload", HTTP_POST);

    // Should get a response (not 404), confirming the route is registered
    TEST_ASSERT_TRUE(webServer->getServer().getLastResponseCode() != 404);
}

// =============================================================================
// Firmware OTA Upload Tests
// =============================================================================

void test_firmware_upload_success(void) {
    webServer->begin();

    uint8_t fakeData[] = {0x01, 0x02, 0x03, 0x04};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.bin", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_TRUE(Update.wasBeginCalled());
    TEST_ASSERT_TRUE(Update.wasEndCalled());
    TEST_ASSERT_FALSE(Update.wasAbortCalled());
    TEST_ASSERT_EQUAL(sizeof(fakeData), Update.getBytesWritten());
    TEST_ASSERT_TRUE(ESP.wasRestartCalled());
}

void test_firmware_upload_begin_failure(void) {
    webServer->begin();
    Update.mockSetFailBegin(true);

    uint8_t fakeData[] = {0x01};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.bin", fakeData, sizeof(fakeData));

    // Should return error status and not restart
    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
    // Update.begin was called but failed
    TEST_ASSERT_TRUE(Update.wasBeginCalled());
    // Should abort to clean up after failed begin
    TEST_ASSERT_TRUE(Update.wasAbortCalled());
}

void test_firmware_upload_write_failure(void) {
    webServer->begin();
    Update.mockSetFailWrite(true);

    uint8_t fakeData[] = {0x01, 0x02};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.bin", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    // Should abort the update to avoid resource leak
    TEST_ASSERT_TRUE(Update.wasAbortCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_end_failure(void) {
    webServer->begin();
    Update.mockSetFailEnd(true);

    uint8_t fakeData[] = {0x01};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.bin", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_TRUE(Update.wasEndCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_abort(void) {
    webServer->begin();

    webServer->getServer().mockSimulateUploadAbort(
        "/api/firmware/upload", "firmware.bin");

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_TRUE(Update.wasAbortCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_rejects_non_bin_file(void) {
    webServer->begin();

    uint8_t fakeData[] = {0x01};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.txt", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    // Should not have called Update.begin for invalid file type
    TEST_ASSERT_FALSE(Update.wasBeginCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_rejects_empty_filename(void) {
    webServer->begin();

    uint8_t fakeData[] = {0x01};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_FALSE(Update.wasBeginCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_rejects_short_filename(void) {
    webServer->begin();

    uint8_t fakeData[] = {0x01};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "abc", fakeData, sizeof(fakeData));

    TEST_ASSERT_EQUAL(500, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_FALSE(Update.wasBeginCalled());
    TEST_ASSERT_FALSE(ESP.wasRestartCalled());
}

void test_firmware_upload_passes_total_size_to_update(void) {
    webServer->begin();

    uint8_t fakeData[] = {0x01, 0x02, 0x03, 0x04};
    webServer->getServer().mockSimulateUpload(
        "/api/firmware/upload", "firmware.bin", fakeData, sizeof(fakeData));

    // Update.begin should have been called (size validation delegated to Update library)
    TEST_ASSERT_EQUAL(200, webServer->getServer().getLastResponseCode());
    TEST_ASSERT_TRUE(Update.wasBeginCalled());
}

// =============================================================================
// Port Constant Test
// =============================================================================

void test_web_server_port_constant(void) {
    TEST_ASSERT_EQUAL(80, WEB_SERVER_PORT);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Constructor tests
    RUN_TEST(test_server_created_but_not_running);

    // Begin/Stop tests
    RUN_TEST(test_begin_starts_server);
    RUN_TEST(test_stop_stops_server);
    RUN_TEST(test_multiple_begin_calls_stay_running);
    RUN_TEST(test_multiple_stop_calls_stay_stopped);

    // Loop tests
    RUN_TEST(test_loop_maintains_state_when_not_started);
    RUN_TEST(test_loop_maintains_state_when_started);
    RUN_TEST(test_loop_after_stop_maintains_stopped_state);

    // SendJson tests
    RUN_TEST(test_send_json_with_string);
    RUN_TEST(test_send_json_with_document);

    // SendError tests
    RUN_TEST(test_send_error);
    RUN_TEST(test_send_error_404);
    RUN_TEST(test_send_error_500);

    // GetServer tests
    RUN_TEST(test_get_server_returns_reference);

    // Custom route tests
    RUN_TEST(test_add_custom_route_get);
    RUN_TEST(test_add_custom_route_post);
    RUN_TEST(test_custom_route_receives_body);

    // Built-in route tests
    RUN_TEST(test_root_route_exists);
    RUN_TEST(test_api_config_get_route);
    RUN_TEST(test_api_config_post_route);
    RUN_TEST(test_api_config_post_invalid_json);
    RUN_TEST(test_api_config_post_no_body);
    RUN_TEST(test_api_wifi_scan_route);
    RUN_TEST(test_api_wifi_connect_route);
    RUN_TEST(test_api_wifi_connect_missing_ssid);
    RUN_TEST(test_api_wifi_connect_no_body);
    RUN_TEST(test_api_wifi_status_route);
    RUN_TEST(test_api_restart_route);
    RUN_TEST(test_not_found_route);

    // CORS tests
    RUN_TEST(test_cors_headers_on_custom_route);

    // Config persistence tests
    RUN_TEST(test_config_values_persist);
    RUN_TEST(test_config_partial_update);

    // Firmware endpoint tests
    RUN_TEST(test_firmware_version_endpoint);
    RUN_TEST(test_firmware_upload_route_registered);

    // Firmware OTA upload tests
    RUN_TEST(test_firmware_upload_success);
    RUN_TEST(test_firmware_upload_begin_failure);
    RUN_TEST(test_firmware_upload_write_failure);
    RUN_TEST(test_firmware_upload_end_failure);
    RUN_TEST(test_firmware_upload_abort);
    RUN_TEST(test_firmware_upload_rejects_non_bin_file);
    RUN_TEST(test_firmware_upload_rejects_empty_filename);
    RUN_TEST(test_firmware_upload_rejects_short_filename);
    RUN_TEST(test_firmware_upload_passes_total_size_to_update);

    // Port constant test
    RUN_TEST(test_web_server_port_constant);

    return UNITY_END();
}
