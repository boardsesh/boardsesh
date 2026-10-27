#ifdef ENABLE_GYM_FIXTURE
#include <Arduino.h>
#include <esp_bt.h>

// NimBLE-Arduino allocates the S3 controller for one advertiser. Reserve three
// connectable sets plus three established connections in this executable only.
extern "C" esp_err_t __real_esp_bt_controller_init(esp_bt_controller_config_t* configuration);
extern "C" esp_err_t __wrap_esp_bt_controller_init(esp_bt_controller_config_t* configuration) {
    if (!configuration)
        return ESP_ERR_INVALID_ARG;
    esp_bt_controller_config_t fixtureConfiguration = *configuration;
    fixtureConfiguration.ble_max_act = 9;
    return __real_esp_bt_controller_init(&fixtureConfiguration);
}

#ifdef GYM_FIXTURE_BLE_PROOF
#include "gym/proof.h"
#else
#include "gym/ble.h"
#include "gym/buttons.h"
#include "gym/cache.h"
#include "gym/client.h"

#include <ArduinoJson.h>
#include <esp_web_server.h>
#include <wifi_utils.h>

#include <array>
#include <atomic>
#include <board_hold_data.h>
#include <config_manager.h>
#include <log_buffer.h>
#include <mbedtls/sha256.h>
#include <utility>
#include <vector>
#include <waveshare_amoled_display.h>

namespace {
struct BoardRuntime {
    std::vector<uint8_t> image;
    std::vector<HoldMapEntry> holds;
    BoardConfig render{};
    std::vector<LedCommand> commands;
    bool payloadSeen = false;
    unsigned long receivedAt = 0;
    int angle = 0;
};

gym_fixture::FixtureBle fixtureBle;
gym_fixture::FixtureButtons buttons;
gym_fixture::FixtureCache cache;
gym_fixture::FixtureClient client;
JsonDocument activeManifest;
JsonDocument stagedManifest;
std::array<BoardRuntime, 3> runtimeBoards;
String gymRef, endpoint, apiKey, cacheScope;
String statusMessage, stagingError, activeSignature, cacheError, authoritySignature;
std::atomic<int> stagingState{0};  // 0 idle, 1 running, 2 committed, -1 failed
bool active = false;
bool stale = true;
bool displayReady = false;
bool renderPending = false;
bool rejectionHandled = false;
size_t selectedBoard = 0;
unsigned long lastRenderedAt = 0;
unsigned long restartAt = 0;

String digestString(const String& input) {
    uint8_t digest[32];
    if (mbedtls_sha256(reinterpret_cast<const uint8_t*>(input.c_str()), input.length(), digest, 0) != 0)
        return "";
    constexpr char hex[] = "0123456789abcdef";
    char result[65];
    for (size_t index = 0; index < 32; ++index) {
        result[index * 2] = hex[digest[index] >> 4];
        result[index * 2 + 1] = hex[digest[index] & 15];
    }
    result[64] = '\0';
    return result;
}

String manifestSignature(JsonVariantConst manifest) {
    String encoded;
    serializeJson(manifest, encoded);
    return digestString(encoded);
}

String boardConfigurationSignature(JsonVariantConst board) {
    JsonDocument configuration;
    for (const char* field : {"uuid", "boardType", "serialNumber", "layoutId", "sizeId", "setIds", "angle"})
        configuration[field].set(board[field]);
    return manifestSignature(configuration.as<JsonVariantConst>());
}

String radioSignature(JsonVariantConst manifest) {
    String signature = manifest["gymUuid"] | "";
    for (JsonVariantConst board : manifest["boards"].as<JsonArrayConst>())
        signature += boardConfigurationSignature(board);
    return signature;
}

bool validKey(const String& key) {
    if (key.length() != 64)
        return false;
    for (char character : key) {
        if (!isHexadecimalDigit(character))
            return false;
    }
    return true;
}

String configuredGym() {
    return gym_fixture::normalizeGymRef(Config.getString("fx_gym", GYM_FIXTURE_DEFAULT_GYM));
}

String configuredEndpoint() {
    String configured = Config.getString("fx_endpoint", GYM_FIXTURE_DEFAULT_ENDPOINT);
    configured.trim();
    return configured;
}

void stopFixture(const String& reason) {
    fixtureBle.stop();
    active = false;
    Display.setBoardConfig(nullptr);
    runtimeBoards = {};
    activeManifest.clear();
    activeSignature = "";
    statusMessage = reason;
    if (displayReady)
        Display.showError(reason.c_str(), WiFiMgr.isAPMode() ? "192.168.4.1" : WiFiMgr.getIP().c_str());
}

void status(JsonDocument& document) {
    document["fixture_mode"] = true;
    document["fixture_gym_name"] = activeManifest["name"] | "";
    document["fixture_gym_uuid"] = activeManifest["gymUuid"] | "";
    document["fixture_status"] = statusMessage;
    document["fixture_stale"] = stale || !WiFiMgr.isConnected();
    document["fixture_active"] = active;
    document["fixture_selected_board"] = selectedBoard;
    document["fixture_refreshing"] = stagingState.load() == 1;
    document["wifi_connected"] = WiFiMgr.isConnected();
    document["wifi_ip"] = WiFiMgr.getIP();
    document["ble_connected"] = fixtureBle.connectionCount() != 0;
    document["ble_connections"] = fixtureBle.connectionCount();
    document["cache_available"] = cache.available();
    document["fixture_cache_error"] = cacheError;
    JsonArray boards = document["fixture_boards"].to<JsonArray>();
    fixtureBle.appendStatus(boards);
    JsonArrayConst configuredBoards = activeManifest["boards"].as<JsonArrayConst>();
    for (size_t index = 0; index < configuredBoards.size(); ++index) {
        JsonObject board = index < boards.size() ? boards[index].as<JsonObject>() : boards.add<JsonObject>();
        board["name"] = configuredBoards[index]["name"];
        board["serialNumber"] = configuredBoards[index]["serialNumber"];
        board["advertisedName"] = configuredBoards[index]["advertisedName"];
        board["payloadSeen"] = runtimeBoards[index].payloadSeen;
        board["ledCount"] = runtimeBoards[index].commands.size();
        board["receivedAgeMs"] =
            runtimeBoards[index].payloadSeen ? static_cast<int>(millis() - runtimeBoards[index].receivedAt) : -1;
    }
}

void printStatus() {
    JsonDocument document;
    status(document);
    document["preview_matched_hold_count"] = Display.getLastMatchedHoldCount();
    document["preview_jpeg_decode_result"] = Display.getLastJpegDecodeResult();
    document["preview_jpeg_block_count"] = Display.getLastJpegBlockCount();
    serializeJson(document, Serial);
    Serial.println();
}

bool activate(JsonVariantConst manifest, String& error) {
    if (!gym_fixture::validateManifest(manifest, error))
        return false;
    std::array<BoardRuntime, 3> proposed;
    const JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
    for (size_t index = 0; index < boards.size(); ++index) {
        BoardRuntime& board = proposed[index];
        std::vector<uint8_t> geometry;
        if (!cache.readAsset(index, true, board.image, error) || !cache.readAsset(index, false, geometry, error))
            return false;
        const unsigned count = gym_fixture::cache_validation::little16(geometry.data() + 6);
        board.holds.reserve(count);
        for (unsigned position = 0; position < count; ++position) {
            const uint8_t* entry = geometry.data() + 12 + position * 8;
            board.holds.push_back({gym_fixture::cache_validation::little16(entry),
                                   gym_fixture::cache_validation::little16(entry + 2),
                                   gym_fixture::cache_validation::little16(entry + 4),
                                   static_cast<uint8_t>(gym_fixture::cache_validation::little16(entry + 6))});
        }
        board.render.imageWidth = boards[index]["preview"]["width"];
        board.render.imageHeight = boards[index]["preview"]["height"];
        board.angle = boards[index]["angle"];
        // Retain only this boot's state for exactly unchanged boards. Preview
        // payloads are never written to, or restored from, flash.
        if (active) {
            for (size_t previous = 0; previous < activeManifest["boards"].size(); ++previous) {
                if (boardConfigurationSignature(activeManifest["boards"][previous]) ==
                    boardConfigurationSignature(boards[index])) {
                    board.commands = runtimeBoards[previous].commands;
                    board.payloadSeen = runtimeBoards[previous].payloadSeen;
                    board.receivedAt = runtimeBoards[previous].receivedAt;
                    board.angle = runtimeBoards[previous].angle;
                }
            }
        }
    }
    // Load every preview before replacing any radio identity.
    const bool radioChanged =
        !active || radioSignature(activeManifest.as<JsonVariantConst>()) != radioSignature(manifest);
    if (radioChanged && !fixtureBle.begin(manifest, error)) {
        stopFixture(error);
        return false;
    }
    Display.setBoardConfig(nullptr);
    runtimeBoards = std::move(proposed);
    activeManifest.set(manifest);
    for (size_t index = 0; index < boards.size(); ++index) {
        BoardRuntime& board = runtimeBoards[index];
        board.render.configKey = "runtime-gym";
        board.render.imageData = board.image.data();
        board.render.imageSize = board.image.size();
        board.render.holdMap = board.holds.data();
        board.render.holdCount = board.holds.size();
    }
    if (selectedBoard >= boards.size())
        selectedBoard = 0;
    activeSignature = manifestSignature(manifest);
    active = true;
    renderPending = true;
    return true;
}

void render() {
    if (!active || !displayReady)
        return;
    BoardRuntime& board = runtimeBoards[selectedBoard];
    JsonVariantConst configuration = activeManifest["boards"][selectedBoard];
    Display.setBoardConfig(&board.render);
    std::vector<WaveshareAmoledDisplay::LedCmd> commands;
    commands.reserve(board.commands.size());
    for (const LedCommand& command : board.commands)
        commands.push_back({static_cast<uint16_t>(command.position), command.r, command.g, command.b});
    Display.setLedCommands(commands.data(), commands.size());
    const bool offline = stale || !WiFiMgr.isConnected();
    Display.showGymPreview(configuration["name"] | "Gym board", configuration["boardType"] | "", board.angle,
                           configuration["serialNumber"] | "", selectedBoard, activeManifest["boards"].size(),
                           board.payloadSeen, commands.size(), offline ? "Saved gym / offline" : "Gym refreshed");
    renderPending = false;
    lastRenderedAt = millis();
}

void navigate(int direction) {
    const int count = activeManifest["boards"].size();
    if (!active || count == 0)
        return;
    selectedBoard = (static_cast<int>(selectedBoard) + direction + count) % count;
    renderPending = true;
}

void stageAssets(void*) {
    const bool success = cache.stage(stagedManifest.as<JsonVariantConst>(), cacheScope, endpoint, stagingError);
    stagingState.store(success ? 2 : -1, std::memory_order_release);
    vTaskDelete(nullptr);
}

void serviceRefresh() {
    if (!cache.available()) {
        statusMessage = cacheError;
        return;
    }
    const int state = stagingState.load(std::memory_order_acquire);
    if (state == 1)
        return;
    if (state == 2 || state == -1) {
        String error;
        if (state == 2 && activate(stagedManifest.as<JsonVariantConst>(), error)) {
            stale = false;
            statusMessage = "Gym refreshed";
            Config.setString("fx_denied", "");
        } else {
            statusMessage = state == -1 ? stagingError : error;
            client.retryAfterAssetFailure();
        }
        stagedManifest.clear();
        stagingState.store(0);
    }
    client.loop();
    if (client.denied() && !rejectionHandled) {
        rejectionHandled = true;
        // An authoritative rejection must survive an offline reboot. Retain the
        // asset cache, but never reuse the rejected authority until revalidated.
        Config.setString("fx_denied", authoritySignature);
        stopFixture(client.status());
        return;
    }
    if (!client.takeManifest(stagedManifest)) {
        if (!rejectionHandled && (stale || !active))
            statusMessage = client.status();
        return;
    }
    if (active && manifestSignature(stagedManifest.as<JsonVariantConst>()) == activeSignature) {
        stale = false;
        statusMessage = "Gym refreshed";
        Config.setString("fx_denied", "");
        stagedManifest.clear();
        renderPending = true;
        return;
    }
    statusMessage = "Downloading gym previews";
    stagingError = "";
    stagingState.store(1);
    // HTTPS/flash writes stay off the display loop. Active images/maps are
    // immutable RAM snapshots; no main-loop cache reads occur during staging.
    if (xTaskCreate(stageAssets, "fixture-assets", 12288, nullptr, 1, nullptr) != pdPASS) {
        stagingState.store(0);
        stagedManifest.clear();
        statusMessage = "Cannot start preview download";
        client.retryAfterAssetFailure();
    }
}

// USB setup avoids moving the Mac onto the captive WiFi AP. Never echo keys or
// WiFi passwords; physical USB grants the same access as the local settings UI.
void serialConfigure(const String& encoded) {
    JsonDocument configuration;
    if (deserializeJson(configuration, encoded)) {
        Serial.println("{\"error\":\"Invalid setup JSON\"}");
        return;
    }
    String reference = configuration["fixture_gym_ref"].isNull()
                           ? gymRef
                           : gym_fixture::normalizeGymRef(configuration["fixture_gym_ref"].as<String>());
    String newEndpoint = configuration["fixture_endpoint"] | endpoint;
    String key = configuration["fixture_api_key"] | apiKey;
    String ssid = configuration["wifi_ssid"] | "";
    String password = configuration["wifi_password"] | "";
    newEndpoint.trim();
    key.trim();
    if (reference.isEmpty() || !newEndpoint.startsWith("wss://") || newEndpoint.length() > 200 ||
        (!key.isEmpty() && !validKey(key)) || ssid.length() > 32 || password.length() > 64) {
        Serial.println("{\"error\":\"Invalid gym, endpoint, key or WiFi settings\"}");
        return;
    }
    const bool saved =
        Config.setString("fx_gym", reference) && Config.setString("fx_endpoint", newEndpoint) &&
        Config.setString("fx_api_key", key) &&
        (ssid.isEmpty() || (Config.setString("wifi_ssid", ssid) && Config.setString("wifi_pass", password)));
    Serial.println(saved ? "{\"success\":true,\"restarting\":true}" : "{\"error\":\"Cannot save settings\"}");
    restartAt = millis() + 500;
}

void serviceSerial() {
    static String command;
    static bool overflow = false;
    while (Serial.available()) {
        const char character = Serial.read();
        if (character == '\n' || character == '\r') {
            if (!overflow) {
                if (command == "fixture-status" || command == "display-status")
                    printStatus();
                else if (command == "screenshot")
                    Display.writeScreenshot(Serial);
                else if (command == "fixture-next")
                    navigate(1);
                else if (command == "fixture-prev")
                    navigate(-1);
                else if (command == "fixture-refresh") {
                    client.begin(endpoint, gymRef, apiKey);
                    rejectionHandled = false;
                } else if (command.startsWith("fixture-config "))
                    serialConfigure(command.substring(15));
            }
            command = "";
            overflow = false;
        } else if (command.length() < 1024 && !overflow)
            command += character;
        else
            overflow = true;
    }
}
}  // namespace

void setup() {
    Serial.begin(115200);
    Config.begin();
    Logger.enableSerial(false);
    // One-time migration; clearing a fixture key never resurrects an old key.
    if (!Config.getBool("fx_key_init", false)) {
        if (!Config.hasKey("fx_api_key")) {
            String previousKey = Config.getString("api_key");
            if (validKey(previousKey))
                Config.setString("fx_api_key", previousKey);
        }
        Config.setBool("fx_key_init", true);
    }
    gymRef = configuredGym();
    endpoint = configuredEndpoint();
    apiKey = Config.getString("fx_api_key");
    // Changed credentials cannot reuse the previous owner's offline authority.
    cacheScope = gymRef + "|" + digestString(apiKey);
    authoritySignature = digestString(cacheScope + "|" + endpoint);
    displayReady = Display.begin();
    Display.setExactPositionMapping(true);
    buttons.begin();
    String error;
    if (!cache.begin(cacheError))
        statusMessage = cacheError;
    else if (validKey(apiKey) && Config.getString("fx_denied") != authoritySignature &&
             cache.load(cacheScope, endpoint, activeManifest, error)) {
        JsonDocument saved;
        saved.set(activeManifest.as<JsonVariantConst>());
        activeManifest.clear();
        if (activate(saved.as<JsonVariantConst>(), error))
            statusMessage = "Offline; using saved gym";
        else
            statusMessage = error;
    }
    WiFiMgr.begin();
    if (!WiFiMgr.connectSaved())
        WiFiMgr.startAP("Boardsesh-QA-Setup");
    configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
    WebConfig.setStatusProvider(status);
    WebConfig.begin();
    client.begin(endpoint, gymRef, apiKey);
    if (!active && displayReady)
        Display.showConfigPortal("Boardsesh-QA-Setup", WiFiMgr.isAPMode() ? "192.168.4.1" : "Checking WiFi...");
    if (active)
        render();
    Serial.println("Boardsesh gym fixture ready; fixture-status, screenshot, fixture-next, fixture-prev");
}

void loop() {
    serviceSerial();
    WebConfig.loop();
    WiFiMgr.loop();
    fixtureBle.loop();
    const int direction = buttons.poll();
    if (direction)
        navigate(direction);
    gym_fixture::CompletedUpdate update;
    while (fixtureBle.takeUpdate(update)) {
        if (active && update.boardIndex < activeManifest["boards"].size()) {
            BoardRuntime& board = runtimeBoards[update.boardIndex];
            board.commands = std::move(update.commands);
            board.payloadSeen = true;
            board.receivedAt = millis();
            board.angle = update.angle;
            selectedBoard = update.boardIndex;
            renderPending = true;
        }
    }
    serviceRefresh();
    static bool previouslyOnline = false;
    const bool online = WiFiMgr.isConnected();
    if (online != previouslyOnline) {
        previouslyOnline = online;
        renderPending = true;
    }
    Display.setWiFiStatus(online);
    Display.setBackendStatus(active && !stale && online);
    Display.setBleStatus(active, fixtureBle.connectionCount() != 0);
    Display.service();
    if (renderPending && millis() - lastRenderedAt >= 150)
        render();
    static unsigned long lastSettingsCheck = 0;
    if (millis() - lastSettingsCheck >= 1000) {
        lastSettingsCheck = millis();
        if (configuredGym() != gymRef || configuredEndpoint() != endpoint || Config.getString("fx_api_key") != apiKey) {
            fixtureBle.stop();
            if (restartAt == 0)
                restartAt = millis() + 500;
        }
    }
    if (restartAt != 0 && static_cast<int32_t>(millis() - restartAt) >= 0)
        ESP.restart();
    delay(5);
}
#endif  // GYM_FIXTURE_BLE_PROOF
#endif  // ENABLE_GYM_FIXTURE
