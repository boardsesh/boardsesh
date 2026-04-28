#include "web_routes.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_web_server.h>

#include "config/board_options.h"
#include "debug_state.h"
#include "web_ui_html.h"

namespace board_debug {

namespace {

bool gBleRestartPending = false;

void handleIndex(WebServer& server) {
    server.send_P(200, "text/html", DEBUG_INDEX_HTML);
}

void handleOptions(WebServer& server) {
    JsonDocument doc;
    JsonArray boards = doc["boards"].to<JsonArray>();
    for (size_t i = 0; i < kBoardCatalogCount; i++) {
        const BoardCatalogEntry& entry = kBoardCatalog[i];
        JsonObject b = boards.add<JsonObject>();
        b["name"] = entry.name;
        JsonArray layouts = b["layouts"].to<JsonArray>();
        for (uint16_t li = 0; li < entry.layoutCount; li++) {
            const LayoutOption& layout = entry.layouts[li];
            JsonObject lObj = layouts.add<JsonObject>();
            lObj["id"] = layout.id;
            lObj["name"] = layout.name;
            JsonArray sizes = lObj["sizes"].to<JsonArray>();
            for (uint16_t si = 0; si < layout.sizeCount; si++) {
                const SizeOption& size = layout.sizes[si];
                JsonObject sObj = sizes.add<JsonObject>();
                sObj["id"] = size.id;
                sObj["name"] = size.name;
                sObj["description"] = size.description;
                JsonArray sets = sObj["sets"].to<JsonArray>();
                for (uint16_t i2 = 0; i2 < size.setCount; i2++) {
                    JsonObject set = sets.add<JsonObject>();
                    set["id"] = size.sets[i2].id;
                    set["name"] = size.sets[i2].name;
                }
            }
        }
    }
    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
}

void writeSetIds(JsonArray array, const String& csv) {
    int start = 0;
    while (start <= static_cast<int>(csv.length())) {
        int end = csv.indexOf(',', start);
        if (end < 0) end = csv.length();
        if (end > start) {
            int id = csv.substring(start, end).toInt();
            if (id > 0) array.add(id);
        }
        start = end + 1;
    }
}

void handleGetConfig(WebServer& server) {
    JsonDocument doc;
    doc["board"] = boardNameToString(gConfig.board);
    doc["layout_id"] = gConfig.layoutId;
    doc["size_id"] = gConfig.sizeId;
    JsonArray sets = doc["set_ids"].to<JsonArray>();
    writeSetIds(sets, gConfig.setIdsCsv);
    doc["angle"] = gConfig.angle;
    doc["device_name"] = gConfig.deviceName;
    doc["api_level"] = gConfig.apiLevel;
    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
}

void handleSetConfig(WebServer& server) {
    if (!server.hasArg("plain")) {
        server.send(400, "application/json", "{\"error\":\"missing body\"}");
        return;
    }
    JsonDocument doc;
    auto err = deserializeJson(doc, server.arg("plain"));
    if (err) {
        server.send(400, "application/json", "{\"error\":\"invalid json\"}");
        return;
    }

    DeviceConfig next = gConfig;
    bool needsBleRestart = false;

    if (doc["board"].is<const char*>()) {
        BoardName parsed = parseBoardName(doc["board"].as<const char*>());
        if (parsed == BoardName::UNKNOWN) {
            server.send(400, "application/json", "{\"error\":\"unknown board\"}");
            return;
        }
        if (parsed != next.board) needsBleRestart = true;
        next.board = parsed;
    }
    if (doc["layout_id"].is<int>()) next.layoutId = doc["layout_id"].as<uint16_t>();
    if (doc["size_id"].is<int>()) next.sizeId = doc["size_id"].as<uint16_t>();
    if (doc["angle"].is<int>()) next.angle = doc["angle"].as<int16_t>();
    if (doc["device_name"].is<const char*>()) {
        String dn = doc["device_name"].as<const char*>();
        if (dn.length() > 0 && dn != next.deviceName) needsBleRestart = true;
        if (dn.length() > 0) next.deviceName = dn;
    }
    if (doc["api_level"].is<int>()) {
        uint8_t lvl = doc["api_level"].as<uint8_t>();
        if (lvl == 2 || lvl == 3) {
            if (lvl != next.apiLevel) needsBleRestart = true;
            next.apiLevel = lvl;
        }
    }
    if (doc["set_ids"].is<JsonArray>()) {
        String csv;
        for (JsonVariant v : doc["set_ids"].as<JsonArray>()) {
            int id = v.as<int>();
            if (id <= 0) continue;
            if (csv.length() > 0) csv += ",";
            csv += String(id);
        }
        next.setIdsCsv = csv;
    }

    // Validate the resulting combo against the catalog before committing.
    if (!findLayout(next.board, next.layoutId)) {
        server.send(400, "application/json", "{\"error\":\"unknown layout\"}");
        return;
    }
    if (!findSize(next.board, next.layoutId, next.sizeId)) {
        server.send(400, "application/json", "{\"error\":\"unknown size\"}");
        return;
    }

    gConfig = next;
    saveConfig();
    if (needsBleRestart) gBleRestartPending = true;

    server.send(200, "application/json", "{\"success\":true}");
}

void handleStatus(WebServer& server) {
    JsonDocument doc;
    doc["now"] = millis();
    doc["wifi_connected"] = gRuntime.wifiConnected;
    doc["ap_mode"] = gRuntime.apMode;
    doc["ssid"] = gRuntime.wifiSsid;
    doc["ip"] = gRuntime.ipAddress;
    doc["ble_connected"] = gRuntime.bleConnected;
    doc["connected_mac"] = gRuntime.connectedDeviceMac;
    doc["last_frames"] = gRuntime.lastFrames;
    doc["last_frames_at_ms"] = gRuntime.lastFramesAtMs;
    doc["frames_revision"] = gRuntime.framesRevision;
    doc["last_render_outcome"] = renderOutcomeToString(gRuntime.lastRenderOutcome);
    doc["last_http_code"] = gRuntime.lastHttpCode;
    doc["last_render_ms"] = gRuntime.lastRenderMs;
    doc["last_render_at_ms"] = gRuntime.lastRenderAtMs;
    doc["last_render_url"] = gRuntime.lastRenderUrl;
    doc["last_render_error"] = gRuntime.lastRenderError;
    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
}

void handleRestart(WebServer& server) {
    server.send(200, "application/json", "{\"success\":true}");
    delay(150);
    ESP.restart();
}

}  // namespace

void registerDebugRoutes() {
    WebConfig.on("/", HTTP_GET, handleIndex);
    WebConfig.on("/api/options", HTTP_GET, handleOptions);
    WebConfig.on("/api/config", HTTP_GET, handleGetConfig);
    WebConfig.on("/api/config", HTTP_POST, handleSetConfig);
    WebConfig.on("/api/status", HTTP_GET, handleStatus);
    WebConfig.on("/api/restart", HTTP_POST, handleRestart);
}

bool consumeBleRestartFlag() {
    if (!gBleRestartPending) return false;
    gBleRestartPending = false;
    return true;
}

}  // namespace board_debug
