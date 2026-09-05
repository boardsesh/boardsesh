// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef WEB_SERVER_H
#define WEB_SERVER_H

#include <Arduino.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include "../config/board_config.h"
#include "../config/config_manager.h"
#include "../wifi/wifi_manager.h"
#include "../led/led_controller.h"
#include "../websocket/ws_client.h"
#include "../bluetooth/ble_server.h"
#include "../bluetooth/ble_client.h"

/**
 * Web Server
 * Provides configuration UI and REST API for the controller
 */
class BoardWebServer {
public:
    BoardWebServer();

    // Initialize web server
    bool begin();

    // Process incoming requests (call in loop)
    void handleClient();

private:
    WebServer server;

    // Route handlers
    void handleRoot();
    void handleGetStatus();
    void handlePostConfig();
    void handleTestLed();
    void handleReset();
    void handleNotFound();

    // Proxy mode route handlers
    void handleScanBoards();
    void handleConnectBoard();
    void handleDisconnectBoard();

    // Generate status JSON
    String getStatusJson();

    // Generate config page HTML
    String getConfigPageHtml();
};

// Global web server instance
extern BoardWebServer boardWebServer;

#endif // WEB_SERVER_H
