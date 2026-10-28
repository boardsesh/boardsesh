#include "../../projects/board-controller/src/gym/client.h"
#include <unity.h>

// The fixture client links the ESP certificate bundle via these symbols.
asm(".globl _binary_x509_crt_bundle_start\n"
    "_binary_x509_crt_bundle_start:\n.byte 1,2,3,4\n"
    ".globl _binary_x509_crt_bundle_end\n_binary_x509_crt_bundle_end:\n");

void setUp() {
    fixtureClientClock = 1500;
    WiFi.connectionStatus = WL_CONNECTED;
    WebSocketsClient::latest = nullptr;
}
void tearDown() {}

static void start(gym_fixture::FixtureClient& client) {
    client.begin("wss://ws.boardsesh.com/graphql", "boardsesh-qa", "test-controller-key");
}

static void at(gym_fixture::FixtureClient& client, unsigned long milliseconds) {
    fixtureClientClock = milliseconds;
    client.loop();
}

void test_native_origin_removed_and_first_secure_attempt_is_prompt() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    TEST_ASSERT_EQUAL_STRING("Origin: file://", socket.extraHeaders.c_str());
    start(client);
    at(client, 1500);
    TEST_ASSERT_EQUAL_STRING("", socket.extraHeaders.c_str());
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    TEST_ASSERT_EQUAL_STRING("ws.boardsesh.com", socket.host.c_str());
    TEST_ASSERT_EQUAL(443, socket.port);
    TEST_ASSERT_EQUAL_STRING("/graphql", socket.path.c_str());
    TEST_ASSERT_EQUAL_STRING("graphql-transport-ws", socket.protocol.c_str());
    TEST_ASSERT_EQUAL_PTR(fixture_ca_start, socket.bundle);
    TEST_ASSERT_EQUAL(4, socket.bundleSize);
}

void test_upgrade_rejection_obeys_five_then_ten_second_backoff() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    socket.outcome = WebSocketsClient::Outcome::RejectUpgrade;
    start(client);
    at(client, 1500);
    at(client, 1501); // HTTP rejection emits a disconnect event.
    at(client, 6500);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 6501);
    TEST_ASSERT_EQUAL(2, socket.connectionAttempts);
    at(client, 6502);
    at(client, 16501);
    TEST_ASSERT_EQUAL(2, socket.connectionAttempts);
    at(client, 16502);
    TEST_ASSERT_EQUAL(3, socket.connectionAttempts);
}

void test_tcp_failure_cleanup_does_not_reconnect_in_the_same_loop() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    socket.outcome = WebSocketsClient::Outcome::FailTcp;
    start(client);
    at(client, 1500); // Failed TCP connect itself has no event.
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 1501); // Library cleanup emits disconnect, then continues.
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 6500);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 6501);
    TEST_ASSERT_EQUAL(2, socket.connectionAttempts);
}

void test_late_disconnect_does_not_also_apply_request_timeout_backoff() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    socket.outcome = WebSocketsClient::Outcome::RejectUpgrade;
    start(client);
    at(client, 1500);
    at(client, 25000); // Disconnect callback arrives after the request deadline.
    TEST_ASSERT_EQUAL_STRING("Connection lost; retrying gym refresh", client.status().c_str());
    at(client, 29999);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 30000); // Exactly one five-second backoff, not a second ten-second one.
    TEST_ASSERT_EQUAL(2, socket.connectionAttempts);
}

void test_offline_or_missing_key_does_not_attempt_transport() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    start(client);
    WiFi.connectionStatus = WL_DISCONNECTED;
    at(client, 5000);
    TEST_ASSERT_EQUAL(0, socket.connectionAttempts);
    WiFi.connectionStatus = WL_CONNECTED;
    at(client, 5001);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    client.begin("wss://ws.boardsesh.com/graphql", "boardsesh-qa", "");
    at(client, 120000);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
}

void test_asset_retry_keeps_activation_failure_and_scheduled_backoff() {
    gym_fixture::FixtureClient client;
    WebSocketsClient& socket = *WebSocketsClient::latest;
    start(client);
    at(client, 1500);
    fixtureClientClock = 2000;
    client.retryAfterAssetFailure("Cannot advertise every configured board");
    TEST_ASSERT_EQUAL_STRING("Cannot advertise every configured board; retrying", client.status().c_str());
    at(client, 6999);
    TEST_ASSERT_EQUAL(1, socket.connectionAttempts);
    at(client, 7000);
    TEST_ASSERT_EQUAL(2, socket.connectionAttempts);
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_native_origin_removed_and_first_secure_attempt_is_prompt);
    RUN_TEST(test_upgrade_rejection_obeys_five_then_ten_second_backoff);
    RUN_TEST(test_tcp_failure_cleanup_does_not_reconnect_in_the_same_loop);
    RUN_TEST(test_late_disconnect_does_not_also_apply_request_timeout_backoff);
    RUN_TEST(test_offline_or_missing_key_does_not_attempt_transport);
    RUN_TEST(test_asset_retry_keeps_activation_failure_and_scheduled_backoff);
    return UNITY_END();
}
