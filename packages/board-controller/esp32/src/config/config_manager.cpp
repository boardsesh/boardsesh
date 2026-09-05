// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "config_manager.h"

// Global instance
ConfigManager configManager;

ConfigManager::ConfigManager() : initialized(false) {}

bool ConfigManager::begin() {
    if (initialized) {
        return true;
    }

    bool success = preferences.begin(NVS_NAMESPACE, false);
    if (success) {
        initialized = true;
        Serial.println("[Config] NVS initialized");
    } else {
        Serial.println("[Config] Failed to initialize NVS");
    }
    return success;
}

// WiFi credentials
String ConfigManager::getWifiSSID() {
    return preferences.getString(NVS_KEY_WIFI_SSID, "");
}

String ConfigManager::getWifiPassword() {
    return preferences.getString(NVS_KEY_WIFI_PASS, "");
}

void ConfigManager::setWifiCredentials(const String& ssid, const String& password) {
    preferences.putString(NVS_KEY_WIFI_SSID, ssid);
    preferences.putString(NVS_KEY_WIFI_PASS, password);
    Serial.printf("[Config] WiFi credentials saved for SSID: %s\n", ssid.c_str());
}

bool ConfigManager::hasWifiCredentials() {
    return getWifiSSID().length() > 0;
}

// API key
String ConfigManager::getApiKey() {
    return preferences.getString(NVS_KEY_API_KEY, "");
}

void ConfigManager::setApiKey(const String& apiKey) {
    preferences.putString(NVS_KEY_API_KEY, apiKey);
    Serial.println("[Config] API key saved");
}

bool ConfigManager::hasApiKey() {
    return getApiKey().length() > 0;
}

// Backend URL
String ConfigManager::getBackendUrl() {
    String url = preferences.getString(NVS_KEY_BACKEND_URL, "");
    if (url.length() == 0) {
        return DEFAULT_BACKEND_URL;
    }
    return url;
}

void ConfigManager::setBackendUrl(const String& url) {
    preferences.putString(NVS_KEY_BACKEND_URL, url);
    Serial.printf("[Config] Backend URL set to: %s\n", url.c_str());
}

// Session ID
String ConfigManager::getSessionId() {
    return preferences.getString(NVS_KEY_SESSION_ID, "");
}

void ConfigManager::setSessionId(const String& sessionId) {
    preferences.putString(NVS_KEY_SESSION_ID, sessionId);
    Serial.printf("[Config] Session ID set to: %s\n", sessionId.c_str());
}

// LED configuration
int ConfigManager::getLedPin() {
    return preferences.getInt(NVS_KEY_LED_PIN, DEFAULT_LED_PIN);
}

void ConfigManager::setLedPin(int pin) {
    preferences.putInt(NVS_KEY_LED_PIN, pin);
    Serial.printf("[Config] LED pin set to: %d\n", pin);
}

int ConfigManager::getLedCount() {
    return preferences.getInt(NVS_KEY_LED_COUNT, DEFAULT_LED_COUNT);
}

void ConfigManager::setLedCount(int count) {
    preferences.putInt(NVS_KEY_LED_COUNT, count);
    Serial.printf("[Config] LED count set to: %d\n", count);
}

int ConfigManager::getBrightness() {
    return preferences.getInt(NVS_KEY_BRIGHTNESS, DEFAULT_BRIGHTNESS);
}

void ConfigManager::setBrightness(int brightness) {
    brightness = constrain(brightness, 0, 255);
    preferences.putInt(NVS_KEY_BRIGHTNESS, brightness);
    Serial.printf("[Config] Brightness set to: %d\n", brightness);
}

// Analytics (log collection) - defaults to true
bool ConfigManager::isAnalyticsEnabled() {
    return preferences.getBool(NVS_KEY_ANALYTICS, true);
}

void ConfigManager::setAnalyticsEnabled(bool enabled) {
    preferences.putBool(NVS_KEY_ANALYTICS, enabled);
    Serial.printf("[Config] Analytics set to: %s\n", enabled ? "enabled" : "disabled");
}

// Controller mode - defaults to DIRECT
ControllerMode ConfigManager::getControllerMode() {
    return static_cast<ControllerMode>(preferences.getUChar(NVS_KEY_CONTROLLER_MODE, 0));
}

void ConfigManager::setControllerMode(ControllerMode mode) {
    preferences.putUChar(NVS_KEY_CONTROLLER_MODE, static_cast<uint8_t>(mode));
    Serial.printf("[Config] Controller mode set to: %s\n",
                  mode == ControllerMode::PROXY ? "PROXY" : "DIRECT");
}

bool ConfigManager::isProxyMode() {
    return getControllerMode() == ControllerMode::PROXY;
}

// Target board MAC address (for proxy mode)
String ConfigManager::getTargetBoardMac() {
    return preferences.getString(NVS_KEY_TARGET_BOARD_MAC, "");
}

void ConfigManager::setTargetBoardMac(const String& mac) {
    preferences.putString(NVS_KEY_TARGET_BOARD_MAC, mac);
    Serial.printf("[Config] Target board MAC set to: %s\n", mac.c_str());
}

bool ConfigManager::hasTargetBoard() {
    return getTargetBoardMac().length() > 0;
}

// Factory reset
void ConfigManager::factoryReset() {
    Serial.println("[Config] Factory reset - clearing all settings");
    preferences.clear();
}

// Debug output
void ConfigManager::printConfig() {
    Serial.println("=== Current Configuration ===");
    Serial.printf("Controller Mode: %s\n", isProxyMode() ? "PROXY" : "DIRECT");
    Serial.printf("WiFi SSID: %s\n", getWifiSSID().c_str());
    Serial.printf("WiFi Password: %s\n", hasWifiCredentials() ? "****" : "(not set)");
    Serial.printf("API Key: %s\n", hasApiKey() ? "****" : "(not set)");
    Serial.printf("Backend URL: %s\n", getBackendUrl().c_str());
    Serial.printf("Session ID: %s\n", getSessionId().c_str());
    Serial.printf("LED Pin: %d\n", getLedPin());
    Serial.printf("LED Count: %d\n", getLedCount());
    Serial.printf("Brightness: %d\n", getBrightness());
    if (isProxyMode()) {
        Serial.printf("Target Board: %s\n", hasTargetBoard() ? getTargetBoardMac().c_str() : "(not set)");
    }
    Serial.println("=============================");
}
