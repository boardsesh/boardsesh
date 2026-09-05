// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include "../config/board_config.h"
#include "../config/config_manager.h"

/**
 * WiFi Manager
 * Handles WiFi connection and fallback to AP mode with captive portal
 */
class BoardWiFiManager {
public:
    BoardWiFiManager();

    // Initialize WiFi - attempts connection, falls back to AP if needed
    bool begin();

    // Check if connected to WiFi
    bool isConnected();

    // Get current IP address
    String getIPAddress();

    // Get signal strength
    int getSignalStrength();

    // Disconnect and start AP mode for reconfiguration
    void startConfigPortal();

    // Reset WiFi settings
    void resetSettings();

    // Set callback for when connected
    void setOnConnectedCallback(void (*callback)());

    // Set callback for when disconnected
    void setOnDisconnectedCallback(void (*callback)());

private:
    WiFiManager wifiManager;
    bool connected;
    void (*onConnectedCallback)();
    void (*onDisconnectedCallback)();

    // Event handlers
    static void WiFiEvent(WiFiEvent_t event);

    // Configure WiFiManager
    void configureWiFiManager();
};

// Global WiFi manager instance
extern BoardWiFiManager boardWiFiManager;

#endif // WIFI_MANAGER_H
