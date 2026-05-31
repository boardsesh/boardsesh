#include "wifi_utils.h"

#ifndef UNIT_TEST
#include <ESPmDNS.h>
#endif
#include <ctype.h>

#ifndef FIRMWARE_BUILD_ENV
#define FIRMWARE_BUILD_ENV "unknown"
#endif

WiFiUtils WiFiMgr;

const char* WiFiUtils::KEY_SSID = "wifi_ssid";
const char* WiFiUtils::KEY_PASSWORD = "wifi_pass";

WiFiUtils::WiFiUtils()
    : state(WiFiConnectionState::DISCONNECTED), stateCallback(nullptr), connectStartTime(0), lastReconnectAttempt(0),
      mdnsServicePort(0), mdnsRunning(false), dnsRunning(false) {}

void WiFiUtils::begin() {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
}

void WiFiUtils::loop() {
    if (dnsRunning) {
        dnsServer.processNextRequest();
    }
    checkConnection();
}

bool WiFiUtils::connect(const char* ssid, const char* password, bool save) {
    currentSSID = ssid;
    currentPassword = password;

    if (save) {
        Config.setString(KEY_SSID, ssid);
        Config.setString(KEY_PASSWORD, password);
    }

    WiFi.begin(ssid, password);
    connectStartTime = millis();
    setState(WiFiConnectionState::CONNECTING);

    return true;
}

bool WiFiUtils::connectSaved() {
    String ssid = Config.getString(KEY_SSID);
    String password = Config.getString(KEY_PASSWORD);

    if (ssid.length() == 0) {
        return false;
    }

    return connect(ssid.c_str(), password.c_str(), false);
}

void WiFiUtils::disconnect() {
    stopMdns();
    WiFi.disconnect();
    setState(WiFiConnectionState::DISCONNECTED);
}

bool WiFiUtils::startAP(const char* apName) {
    stopMdns();

    // Stop any existing connection first
    WiFi.disconnect();

    // Clear in-memory credentials to prevent checkConnection() from
    // attempting reconnection with stale credentials if we later
    // transition out of AP mode
    currentSSID = "";
    currentPassword = "";

    // Configure AP mode
    WiFi.mode(WIFI_AP);

    // Start the access point
    bool success = WiFi.softAP(apName);
    if (success) {
        // Start DNS server to redirect all domains to our AP IP (captive portal)
        dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
        dnsRunning = true;
        setState(WiFiConnectionState::AP_MODE);
    }
    return success;
}

void WiFiUtils::stopAP() {
    stopMdns();
    if (dnsRunning) {
        dnsServer.stop();
        dnsRunning = false;
    }
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    setState(WiFiConnectionState::DISCONNECTED);
}

bool WiFiUtils::isAPMode() {
    return state == WiFiConnectionState::AP_MODE;
}

String WiFiUtils::getAPIP() {
    return WiFi.softAPIP().toString();
}

bool WiFiUtils::hasSavedCredentials() {
    String ssid = Config.getString(KEY_SSID);
    return ssid.length() > 0;
}

bool WiFiUtils::isConnected() {
    return WiFi.status() == WL_CONNECTED;
}

WiFiConnectionState WiFiUtils::getState() {
    return state;
}

String WiFiUtils::getSSID() {
    return WiFi.SSID();
}

String WiFiUtils::getIP() {
    return WiFi.localIP().toString();
}

int8_t WiFiUtils::getRSSI() {
    return WiFi.RSSI();
}

void WiFiUtils::configureMdns(const char* deviceName, const char* serviceType, uint16_t servicePort, const char* role) {
    mdnsDeviceName = deviceName ? deviceName : "";
    mdnsServiceType = serviceType ? serviceType : "boardsesh";
    mdnsServicePort = servicePort;
    mdnsRole = role ? role : "";
    restartMdns();
}

void WiFiUtils::setMdnsDeviceName(const char* deviceName) {
    mdnsDeviceName = deviceName ? deviceName : "";
    restartMdns();
}

void WiFiUtils::restartMdns() {
    stopMdns();
    if (WiFi.status() == WL_CONNECTED) {
        startMdns();
    }
}

void WiFiUtils::stopMdns() {
    bool wasRunning = mdnsRunning;
#ifndef UNIT_TEST
    if (wasRunning) {
        MDNS.end();
    }
#endif
    mdnsRunning = false;
    mdnsHostName = "";
}

String WiFiUtils::getMdnsHostName() {
    return mdnsHostName;
}

void WiFiUtils::setStateCallback(WiFiStateCallback callback) {
    stateCallback = callback;
}

String WiFiUtils::buildMdnsHostName(const String& deviceName, const String& macAddress) {
    String base;
    bool lastWasDash = false;

    for (size_t i = 0; i < deviceName.length(); i++) {
        char c = static_cast<char>(tolower(deviceName[i]));
        bool isAlphaNumeric = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (isAlphaNumeric) {
            base += c;
            lastWasDash = false;
        } else if (!lastWasDash && base.length() > 0) {
            base += '-';
            lastWasDash = true;
        }
    }

    while (base.endsWith("-")) {
        base.remove(base.length() - 1);
    }

    String macSuffix;
    for (size_t i = 0; i < macAddress.length(); i++) {
        char c = static_cast<char>(tolower(macAddress[i]));
        if ((c >= 'a' && c <= 'f') || (c >= '0' && c <= '9')) {
            macSuffix += c;
        }
    }
    if (macSuffix.length() > 6) {
        macSuffix = macSuffix.substring(macSuffix.length() - 6);
    }

    if (base.length() == 0) {
        base = "boardsesh-esp32";
    }

    const size_t suffixLength = macSuffix.length() > 0 ? macSuffix.length() + 1 : 0;
    const size_t maxBaseLength = 63 - suffixLength;
    if (base.length() > maxBaseLength) {
        base = base.substring(0, maxBaseLength);
        while (base.endsWith("-")) {
            base.remove(base.length() - 1);
        }
    }

    if (macSuffix.length() > 0) {
        base += "-";
        base += macSuffix;
    }

    return base;
}

void WiFiUtils::setState(WiFiConnectionState newState) {
    if (state != newState) {
        if (newState != WiFiConnectionState::CONNECTED) {
            stopMdns();
        }
        state = newState;
        if (state == WiFiConnectionState::CONNECTED) {
            startMdns();
        }
        if (stateCallback) {
            stateCallback(state);
        }
    }
}

void WiFiUtils::startMdns() {
    if (mdnsServicePort == 0) {
        return;
    }

    mdnsHostName = buildMdnsHostName(mdnsDeviceName, WiFi.macAddress());

#ifndef UNIT_TEST
    if (!MDNS.begin(mdnsHostName.c_str())) {
        Serial.printf("mDNS failed for %s.local\n", mdnsHostName.c_str());
        mdnsHostName = "";
        mdnsRunning = false;
        return;
    }

    MDNS.addService(mdnsServiceType.c_str(), "tcp", mdnsServicePort);
    MDNS.addServiceTxt(mdnsServiceType.c_str(), "tcp", "role", mdnsRole.c_str());
    MDNS.addServiceTxt(mdnsServiceType.c_str(), "tcp", "build", FIRMWARE_BUILD_ENV);

    if (mdnsServicePort == 80) {
        MDNS.addService("http", "tcp", mdnsServicePort);
        MDNS.addServiceTxt("http", "tcp", "role", mdnsRole.c_str());
    }
#endif

    mdnsRunning = true;
    Serial.printf("mDNS: %s.local\n", mdnsHostName.c_str());
}

void WiFiUtils::checkConnection() {
    // Don't check STA connection in AP mode
    if (state == WiFiConnectionState::AP_MODE) {
        return;
    }

    bool connected = WiFi.status() == WL_CONNECTED;

    switch (state) {
        case WiFiConnectionState::CONNECTING:
            if (connected) {
                setState(WiFiConnectionState::CONNECTED);
            } else if (millis() - connectStartTime > WIFI_CONNECT_TIMEOUT_MS) {
                setState(WiFiConnectionState::CONNECTION_FAILED);
            }
            break;

        case WiFiConnectionState::CONNECTED:
            if (!connected) {
                setState(WiFiConnectionState::DISCONNECTED);
                lastReconnectAttempt = millis();
            }
            break;

        case WiFiConnectionState::DISCONNECTED:
        case WiFiConnectionState::CONNECTION_FAILED:
            if (connected) {
                setState(WiFiConnectionState::CONNECTED);
            } else if (currentSSID.length() > 0 && millis() - lastReconnectAttempt > WIFI_RECONNECT_INTERVAL_MS) {
                connect(currentSSID.c_str(), currentPassword.c_str(), false);
            }
            break;

        case WiFiConnectionState::AP_MODE:
            // Handled at the top of the function
            break;
    }
}
