// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef CONFIG_MANAGER_H
#define CONFIG_MANAGER_H

#include <Arduino.h>
#include <Preferences.h>
#include "board_config.h"

/**
 * Configuration Manager
 * Handles persistent storage of settings using ESP32 NVS (Non-Volatile Storage)
 */
class ConfigManager {
public:
    ConfigManager();

    // Initialize NVS
    bool begin();

    // WiFi credentials
    String getWifiSSID();
    String getWifiPassword();
    void setWifiCredentials(const String& ssid, const String& password);
    bool hasWifiCredentials();

    // API key for BoardSesh backend
    String getApiKey();
    void setApiKey(const String& apiKey);
    bool hasApiKey();

    // Backend URL
    String getBackendUrl();
    void setBackendUrl(const String& url);

    // Session ID
    String getSessionId();
    void setSessionId(const String& sessionId);

    // LED configuration
    int getLedPin();
    void setLedPin(int pin);

    int getLedCount();
    void setLedCount(int count);

    int getBrightness();
    void setBrightness(int brightness);

    // Analytics (log collection)
    bool isAnalyticsEnabled();
    void setAnalyticsEnabled(bool enabled);

    // Controller mode (DIRECT or PROXY)
    ControllerMode getControllerMode();
    void setControllerMode(ControllerMode mode);
    bool isProxyMode();

    // Target board MAC address (for proxy mode)
    String getTargetBoardMac();
    void setTargetBoardMac(const String& mac);
    bool hasTargetBoard();

    // Factory reset - clear all settings
    void factoryReset();

    // Debug: print all settings
    void printConfig();

private:
    Preferences preferences;
    bool initialized;
};

// Global config manager instance
extern ConfigManager configManager;

#endif // CONFIG_MANAGER_H
