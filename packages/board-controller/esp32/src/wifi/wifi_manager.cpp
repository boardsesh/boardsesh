// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "wifi_manager.h"

// Global instance
BoardWiFiManager boardWiFiManager;

// Static instance pointer for event handler
static BoardWiFiManager* wifiManagerInstance = nullptr;

BoardWiFiManager::BoardWiFiManager()
    : connected(false), onConnectedCallback(nullptr), onDisconnectedCallback(nullptr) {
    wifiManagerInstance = this;
}

void BoardWiFiManager::configureWiFiManager() {
    // Set timeout for config portal
    wifiManager.setConfigPortalTimeout(180); // 3 minutes

    // Set minimum signal quality (percentage)
    wifiManager.setMinimumSignalQuality(20);

    // Remove duplicate networks
    wifiManager.setRemoveDuplicateAPs(true);

    // Custom menu items
    std::vector<const char*> menu = {"wifi", "info", "sep", "restart", "exit"};
    wifiManager.setMenu(menu);

    // Set dark theme
    wifiManager.setClass("invert");

    // Custom hostname
    wifiManager.setHostname("boardsesh-controller");

    // Debug output
    wifiManager.setDebugOutput(DEBUG_WIFI);
}

bool BoardWiFiManager::begin() {
    Serial.println("[WiFi] Starting WiFi manager...");

    // Register event handlers
    WiFi.onEvent(WiFiEvent);

    // Configure the WiFiManager library
    configureWiFiManager();

    // Try to connect with saved credentials, or start config portal
    Serial.println("[WiFi] Attempting to connect to saved network...");

    // autoConnect returns true if connected to WiFi
    // If no saved credentials or connection fails, it starts config portal
    bool result = wifiManager.autoConnect(AP_SSID, AP_PASSWORD);

    if (result) {
        connected = true;
        Serial.println("[WiFi] Connected successfully!");
        Serial.printf("[WiFi] IP Address: %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("[WiFi] Signal Strength: %d dBm\n", WiFi.RSSI());

        // Save credentials to our config manager for display purposes
        configManager.setWifiCredentials(WiFi.SSID(), WiFi.psk());

        if (onConnectedCallback) {
            onConnectedCallback();
        }
    } else {
        Serial.println("[WiFi] Failed to connect and config portal timed out");
    }

    return result;
}

bool BoardWiFiManager::isConnected() {
    return WiFi.status() == WL_CONNECTED;
}

String BoardWiFiManager::getIPAddress() {
    if (isConnected()) {
        return WiFi.localIP().toString();
    }
    return "0.0.0.0";
}

int BoardWiFiManager::getSignalStrength() {
    if (isConnected()) {
        return WiFi.RSSI();
    }
    return 0;
}

void BoardWiFiManager::startConfigPortal() {
    Serial.println("[WiFi] Starting config portal...");
    wifiManager.startConfigPortal(AP_SSID, AP_PASSWORD);
}

void BoardWiFiManager::resetSettings() {
    Serial.println("[WiFi] Resetting WiFi settings...");
    wifiManager.resetSettings();
    configManager.setWifiCredentials("", "");
}

void BoardWiFiManager::setOnConnectedCallback(void (*callback)()) {
    onConnectedCallback = callback;
}

void BoardWiFiManager::setOnDisconnectedCallback(void (*callback)()) {
    onDisconnectedCallback = callback;
}

void BoardWiFiManager::WiFiEvent(WiFiEvent_t event) {
    switch (event) {
        case ARDUINO_EVENT_WIFI_STA_CONNECTED:
            Serial.println("[WiFi] Connected to AP");
            break;

        case ARDUINO_EVENT_WIFI_STA_GOT_IP:
            Serial.printf("[WiFi] Got IP: %s\n", WiFi.localIP().toString().c_str());
            if (wifiManagerInstance) {
                wifiManagerInstance->connected = true;
                if (wifiManagerInstance->onConnectedCallback) {
                    wifiManagerInstance->onConnectedCallback();
                }
            }
            break;

        case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
            Serial.println("[WiFi] Disconnected from AP");
            if (wifiManagerInstance) {
                wifiManagerInstance->connected = false;
                if (wifiManagerInstance->onDisconnectedCallback) {
                    wifiManagerInstance->onDisconnectedCallback();
                }
            }
            break;

        default:
            break;
    }
}
