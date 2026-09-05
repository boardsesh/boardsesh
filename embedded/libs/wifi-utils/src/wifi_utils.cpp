// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "wifi_utils.h"

WiFiUtils WiFiMgr;

const char* WiFiUtils::KEY_SSID = "wifi_ssid";
const char* WiFiUtils::KEY_PASSWORD = "wifi_pass";

WiFiUtils::WiFiUtils()
    : state(WiFiConnectionState::DISCONNECTED), stateCallback(nullptr), connectStartTime(0), lastReconnectAttempt(0), dnsRunning(false) {}

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
    WiFi.disconnect();
    setState(WiFiConnectionState::DISCONNECTED);
}

bool WiFiUtils::startAP(const char* apName) {
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

void WiFiUtils::setStateCallback(WiFiStateCallback callback) {
    stateCallback = callback;
}

void WiFiUtils::setState(WiFiConnectionState newState) {
    if (state != newState) {
        state = newState;
        if (stateCallback) {
            stateCallback(state);
        }
    }
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
