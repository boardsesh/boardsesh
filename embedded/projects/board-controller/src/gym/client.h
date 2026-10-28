#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>

#include <WebSocketsClient.h>
#include <ctime>

extern const uint8_t fixture_ca_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t fixture_ca_end[] asm("_binary_x509_crt_bundle_end");

namespace gym_fixture {

inline String normalizeGymRef(String reference) {
    reference.trim();
    if (reference.startsWith("https://")) {
        const int gymPath = reference.indexOf("/gym/");
        if (gymPath < 0)
            return "";
        reference = reference.substring(gymPath + 5);
        int end = reference.indexOf('/');
        if (end >= 0)
            reference = reference.substring(0, end);
    }
    for (char separator : {'?', '#'}) {
        int end = reference.indexOf(separator);
        if (end >= 0)
            reference = reference.substring(0, end);
    }
    if (reference.length() == 0 || reference.length() > 120)
        return "";
    for (size_t index = 0; index < reference.length(); ++index) {
        const char character = reference[index];
        if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
              (character >= '0' && character <= '9') || character == '-'))
            return "";
    }
    return reference;
}

inline bool validateManifest(JsonVariantConst manifest, String& error) {
    JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
    if (manifest["version"].as<int>() != 1 || !manifest["gymUuid"].is<const char*>() || boards.size() < 1 ||
        boards.size() > 3) {
        error = "Unsupported gym manifest";
        return false;
    }
    for (size_t index = 0; index < boards.size(); ++index) {
        JsonVariantConst board = boards[index];
        String type = board["boardType"] | "";
        String uuid = board["uuid"] | "";
        String serial = board["serialNumber"] | "";
        String advertisedName = board["advertisedName"] | "";
        String expectedName = type == "moonboard" ? "MoonBoard A#" + serial
                              : type == "kilter"  ? "Kilter Board#" + serial + "@3"
                                                  : "Tension Board#" + serial + "@3";
        if ((type != "kilter" && type != "tension" && type != "moonboard") || uuid.length() != 36 ||
            serial.length() < 4 || serial.length() > 32 || advertisedName != expectedName ||
            advertisedName.length() > 29 || board["layoutId"].as<int>() <= 0 || board["sizeId"].as<int>() <= 0 ||
            !board["setIds"].is<const char*>() || !board["angle"].is<int>() || board["angle"].as<int>() < 0 ||
            board["angle"].as<int>() > 90) {
            error = "Gym contains an invalid board identity or layout";
            return false;
        }
        for (size_t character = 0; character < serial.length(); ++character) {
            if (!isAlphaNumeric(serial[character]) && serial[character] != ':' && serial[character] != '-') {
                error = "Gym contains an invalid serial number";
                return false;
            }
        }
        for (size_t previous = 0; previous < index; ++previous) {
            if (uuid == String(boards[previous]["uuid"] | "") ||
                serial == String(boards[previous]["serialNumber"] | "")) {
                error = "Gym contains duplicate board identities";
                return false;
            }
        }
    }
    error = "";
    return true;
}

// A boot/refresh query client, intentionally separate from the legacy session
// controller, whose singleton BLE dependencies cannot coexist with EXT_ADV.
class FixtureClient {
  public:
    void begin(const String& endpoint, const String& gymRef, const String& apiKey) {
        _running = false;
        _socket.disconnect();
        _endpoint = endpoint;
        _gymRef = gymRef;
        _apiKey = apiKey;
        _result.clear();
        _hasResult = false;
        _denied = false;
        _retryDelay = 5000;
        _nextAttempt = 0;
        _status = apiKey.isEmpty() ? "Add a controller key in settings" : "Waiting for WiFi";
        _enabled = !apiKey.isEmpty();
        _socket.onEvent([this](WStype_t type, uint8_t* payload, size_t length) { onEvent(type, payload, length); });
        // Native controllers have no browser origin. The library's default
        // Origin: file:// is correctly rejected by the backend's browser checks.
        _socket.setExtraHeaders("");
        // Stay below our request deadline without allowing a reconnect in the
        // same library loop after its disconnect callback schedules our backoff.
        _socket.setReconnectInterval(1000);
        _socket.enableHeartbeat(20000, 5000, 2);
    }

    void loop() {
        if (!_enabled || _denied || _hasResult)
            return;
        if (WiFi.status() != WL_CONNECTED) {
            if (_running) {
                _running = false;
                _socket.disconnect();
            }
            _status = "Offline; using saved gym if available";
            return;
        }
        if (time(nullptr) < 1700000000) {
            _status = "Setting clock for secure connection";
            return;
        }
        if (!_running && static_cast<int32_t>(millis() - _nextAttempt) >= 0)
            connect();
        if (_running) {
            _socket.loop();
            if (_running && millis() - _startedAt > 20000) {
                _status = "Gym refresh timed out";
                retry();
            }
        }
    }

    bool takeManifest(JsonDocument& manifest) {
        if (!_hasResult)
            return false;
        manifest.set(_result.as<JsonVariantConst>());
        _result.clear();
        _hasResult = false;
        // Refresh only on boot/settings changes, or after a failed refresh.
        _enabled = false;
        return true;
    }

    bool denied() const { return _denied; }
    const String& status() const { return _status; }

    void retryAfterAssetFailure(const String& reason = "Preview download failed") {
        _enabled = !_apiKey.isEmpty() && !_denied;
        _status = reason + "; retrying";
        retry();
    }

  private:
    WebSocketsClient _socket;
    String _endpoint;
    String _gymRef;
    String _apiKey;
    String _status;
    String _fragments;
    JsonDocument _result;
    bool _enabled = false;
    bool _running = false;
    bool _hasResult = false;
    bool _denied = false;
    unsigned long _startedAt = 0;
    unsigned long _nextAttempt = 0;
    unsigned long _retryDelay = 5000;
    static constexpr size_t MAX_MESSAGE_BYTES = 16384;

    void connect() {
        if (!_endpoint.startsWith("wss://")) {
            _denied = true;
            _status = "Backend must use a secure wss:// URL";
            return;
        }
        String hostAndPath = _endpoint.substring(6);
        int slash = hostAndPath.indexOf('/');
        String authority = slash < 0 ? hostAndPath : hostAndPath.substring(0, slash);
        String path = slash < 0 ? "/graphql" : hostAndPath.substring(slash);
        uint16_t port = 443;
        int colon = authority.indexOf(':');
        if (colon >= 0) {
            int configuredPort = authority.substring(colon + 1).toInt();
            if (configuredPort <= 0 || configuredPort > 65535) {
                _denied = true;
                _status = "Backend port is invalid";
                return;
            }
            port = configuredPort;
            authority = authority.substring(0, colon);
        }
        if (authority.isEmpty() || authority.indexOf('@') >= 0 || authority.indexOf('\\') >= 0) {
            _denied = true;
            _status = "Backend URL is invalid";
            return;
        }
        _running = true;
        _startedAt = millis();
        _fragments = "";
        _status = "Fetching gym configuration";
        _socket.beginSslWithBundle(authority.c_str(), port, path.c_str(), fixture_ca_start,
                                   static_cast<size_t>(fixture_ca_end - fixture_ca_start), "graphql-transport-ws");
    }

    void send(JsonDocument& message) {
        String encoded;
        serializeJson(message, encoded);
        _socket.sendTXT(encoded);
    }

    void retry() {
        _running = false;
        _nextAttempt = millis() + _retryDelay;
        _retryDelay = min(_retryDelay * 2UL, 60000UL);
        _socket.disconnect();
    }

    void reject(const char* message) {
        _denied = true;
        _status = message;
        _running = false;
        _socket.disconnect();
    }

    void handleErrors(JsonVariantConst errors) {
        for (JsonVariantConst error : errors.as<JsonArrayConst>()) {
            String code = error["extensions"]["code"] | "";
            if (code == "FORBIDDEN" || code == "UNAUTHENTICATED" || code == "NOT_FOUND" || code == "BAD_USER_INPUT") {
                reject("Gym access or configuration was rejected; check settings");
                return;
            }
        }
        _status = "Gym service unavailable; retrying";
        retry();
    }

    void text(const uint8_t* payload, size_t length) {
        if (length > MAX_MESSAGE_BYTES) {
            reject("Gym response exceeds device limit");
            return;
        }
        JsonDocument message;
        if (deserializeJson(message, payload, length)) {
            _status = "Gym service returned invalid JSON";
            retry();
            return;
        }
        String type = message["type"] | "";
        if (type == "connection_ack") {
            JsonDocument request;
            request["id"] = "fixture";
            request["type"] = "subscribe";
            request["payload"]["query"] =
                "query FixtureGym($gymRef:String!){controllerGymManifest(gymRef:$gymRef){version gymUuid name slug "
                "boards{uuid name boardType serialNumber layoutId sizeId setIds angle advertisedName "
                "preview{imageUrl geometryUrl imageSha256 geometrySha256 imageBytes geometryBytes width height "
                "positionCount}}}}";
            request["payload"]["variables"]["gymRef"] = _gymRef;
            send(request);
        } else if (type == "ping") {
            JsonDocument pong;
            pong["type"] = "pong";
            pong["payload"].set(message["payload"]);
            send(pong);
        } else if (type == "error") {
            handleErrors(message["payload"]);
        } else if (type == "next" && String(message["id"] | "") == "fixture") {
            if (!message["payload"]["errors"].isNull()) {
                handleErrors(message["payload"]["errors"]);
                return;
            }
            String error;
            JsonVariantConst manifest = message["payload"]["data"]["controllerGymManifest"];
            if (!validateManifest(manifest, error)) {
                reject(error.c_str());
                return;
            }
            _result.set(manifest);
            _hasResult = true;
            _running = false;
            _status = "Gym configuration received";
            _socket.disconnect();
        }
    }

    void onEvent(WStype_t type, uint8_t* payload, size_t length) {
        if (type == WStype_CONNECTED) {
            JsonDocument init;
            init["type"] = "connection_init";
            init["payload"]["controllerApiKey"] = _apiKey;
            init["payload"]["clientIdentity"] = "esp32-gym-fixture";
            send(init);
        } else if (type == WStype_TEXT) {
            text(payload, length);
        } else if (type == WStype_FRAGMENT_TEXT_START) {
            _fragments = "";
            appendFragment(payload, length);
        } else if (type == WStype_FRAGMENT || type == WStype_FRAGMENT_FIN) {
            if (appendFragment(payload, length) && type == WStype_FRAGMENT_FIN)
                text(reinterpret_cast<const uint8_t*>(_fragments.c_str()), _fragments.length());
        } else if ((type == WStype_DISCONNECTED || type == WStype_ERROR) && _running) {
            _status = "Connection lost; retrying gym refresh";
            retry();
        }
    }

    bool appendFragment(const uint8_t* payload, size_t length) {
        if (_fragments.length() + length > MAX_MESSAGE_BYTES) {
            reject("Gym response exceeds device limit");
            return false;
        }
        return _fragments.concat(reinterpret_cast<const char*>(payload), length);
    }
};
}  // namespace gym_fixture
