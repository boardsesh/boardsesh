#ifdef EMULATOR_BUILD

#include "ws_server.h"

#include <ArduinoJson.h>
#include <WebSocketsServer.h>

namespace {

// Allocated lazily in EmulatorWsServer::begin() so the caller's `port` arg
// actually applies. The library's WebSocketsServer takes the port at
// construction, so a file-scope instance would lock us to a hard-coded port.
WebSocketsServer* gWs = nullptr;

constexpr const char* FW_VERSION = "0.1.0";

String bytesToHex(const uint8_t* data, size_t length) {
    static const char hex[] = "0123456789abcdef";
    String out;
    out.reserve(length * 2);
    for (size_t i = 0; i < length; ++i) {
        out += hex[(data[i] >> 4) & 0xF];
        out += hex[data[i] & 0xF];
    }
    return out;
}

String configToHelloJson(const EmulatorConfig& cfg, const String& mdnsHost) {
    JsonDocument doc;
    doc["type"]      = "hello";
    doc["fwVersion"] = FW_VERSION;
    doc["board"]     = BleEmulator::boardToString(cfg.board);
    doc["serial"]    = cfg.serial;
    doc["apiLevel"]  = cfg.apiLevel;
    if (mdnsHost.length() > 0) {
        doc["mdnsHost"] = mdnsHost;
    }
    String out;
    serializeJson(doc, out);
    return out;
}

void onWsEvent(uint8_t clientId, WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED: {
            IPAddress ip = gWs->remoteIP(clientId);
            Serial.printf("[WS] #%u connected from %s\n", clientId, ip.toString().c_str());
            wsServer.handleClientConnected(clientId);
            break;
        }
        case WStype_DISCONNECTED:
            Serial.printf("[WS] #%u disconnected\n", clientId);
            break;
        case WStype_TEXT: {
            String msg;
            msg.reserve(length);
            for (size_t i = 0; i < length; ++i) msg += static_cast<char>(payload[i]);
            wsServer.handleClientMessage(clientId, msg);
            break;
        }
        default:
            break;
    }
}

}  // namespace

EmulatorWsServer wsServer;

bool EmulatorWsServer::begin(uint16_t port) {
    if (gWs != nullptr) {
        // Idempotent — calling begin() twice with a different port isn't
        // supported by the underlying library, so just keep the first.
        Serial.println("[WS] begin() called twice — keeping existing server");
        return true;
    }
    gWs = new WebSocketsServer(port);
    gWs->begin();
    gWs->onEvent(onWsEvent);
    Serial.printf("[WS] Listening on port %u\n", static_cast<unsigned>(port));
    return true;
}

void EmulatorWsServer::loop() {
    if (gWs) gWs->loop();
}

void EmulatorWsServer::broadcastBleWrite(const uint8_t* data, size_t length) {
    JsonDocument doc;
    doc["type"] = "ble-write";
    doc["ts"]   = static_cast<uint32_t>(millis());
    doc["hex"]  = bytesToHex(data, length);
    String out;
    serializeJson(doc, out);
    if (gWs) gWs->broadcastTXT(out);
}

void EmulatorWsServer::broadcastBleConnection(bool connected) {
    JsonDocument doc;
    doc["type"] = connected ? "ble-connected" : "ble-disconnected";
    String out;
    serializeJson(doc, out);
    if (gWs) gWs->broadcastTXT(out);
}

void EmulatorWsServer::broadcastHello(const EmulatorConfig& cfg) {
    String out = configToHelloJson(cfg, mdnsHost);
    if (gWs) gWs->broadcastTXT(out);
}

void EmulatorWsServer::handleClientConnected(uint8_t clientId) {
    String hello = configToHelloJson(bleEmulator.getConfig(), mdnsHost);
    if (gWs) gWs->sendTXT(clientId, hello);
}

void EmulatorWsServer::handleClientMessage(uint8_t clientId, const String& payload) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err) {
        Serial.printf("[WS] Bad JSON from #%u: %s\n", clientId, err.c_str());
        return;
    }
    const char* type = doc["type"] | "";

    if (strcmp(type, "ping") == 0) {
        if (gWs) gWs->sendTXT(clientId, "{\"type\":\"pong\"}");
        return;
    }

    if (strcmp(type, "set-config") == 0) {
        EmulatorConfig cfg = bleEmulator.getConfig();
        const char* board    = doc["board"]    | "";
        const char* serial   = doc["serial"]   | "";
        int         apiLevel = doc["apiLevel"] | static_cast<int>(cfg.apiLevel);

        if (strlen(board) > 0) {
            EmulatedBoard b;
            if (!BleEmulator::parseBoard(String(board), b)) {
                if (gWs) gWs->sendTXT(clientId, "{\"type\":\"error\",\"message\":\"unknown board\"}");
                return;
            }
            cfg.board = b;
        }
        if (strlen(serial) > 0) cfg.serial = String(serial);
        if (apiLevel == 2 || apiLevel == 3) cfg.apiLevel = static_cast<uint8_t>(apiLevel);

        if (onConfig) onConfig(cfg);

        // Echo the active config back to all clients.
        broadcastHello(cfg);

        JsonDocument ack;
        ack["type"]              = "config-ack";
        ack["config"]["board"]   = BleEmulator::boardToString(cfg.board);
        ack["config"]["serial"]  = cfg.serial;
        ack["config"]["apiLevel"] = cfg.apiLevel;
        String out;
        serializeJson(ack, out);
        if (gWs) gWs->broadcastTXT(out);
        return;
    }

    Serial.printf("[WS] Unknown message type from #%u: %s\n", clientId, type);
}

#endif // EMULATOR_BUILD
