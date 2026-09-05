// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * BoardSesh ESP32 Controller
 *
 * This firmware enables an ESP32 to replace or proxy to the official Kilter/Tension board controller.
 * It provides two modes:
 *
 * DIRECT MODE (default):
 * - Direct WS2811 LED control from BoardSesh via WebSocket
 * - BLE GATT server compatible with official Kilter/Tension apps
 * - Web interface for WiFi/API key configuration
 * - When the official app sets a climb via Bluetooth, the LED data can be forwarded
 *   to the BoardSesh session for synchronization.
 *
 * PROXY MODE:
 * - Connects to an official Kilter board via BLE as a client
 * - Forwards LED commands from BoardSesh WebSocket to the board
 * - Advertises as "Kilter BoardSesh" for discovery by the web app
 * - Useful for adding BoardSesh features to existing boards without hardware modification
 */

#include <Arduino.h>

#ifdef EMULATOR_BUILD
// Hardware test rig build: skip the real LED/WiFi/WebSocket-client stack and
// run a BLE-emulator + local WebSocket-server instead. See src/emulator/.
#include "emulator/emulator_main.h"

void setup() { emulatorSetup(); }
void loop()  { emulatorLoop(); }

#else  // EMULATOR_BUILD

#include "config/config_manager.h"
#include "wifi/wifi_manager.h"
#include "led/led_controller.h"
#include "websocket/ws_client.h"
#include "bluetooth/ble_server.h"
#include "bluetooth/ble_client.h"
#include "web/web_server.h"

// Forward declarations
void onBluetoothLedData(const LedCommand* commands, int count, int angle);
void onWebSocketLedUpdate(const LedCommand* commands, int count);

void setup() {
    // Initialize serial for debugging
    Serial.begin(DEBUG_BAUD);
    delay(1000);

    Serial.println();
    Serial.println("=================================");
    Serial.println("  BoardSesh ESP32 Controller");
    Serial.println("=================================");
    Serial.println();

    // Initialize configuration manager
    if (!configManager.begin()) {
        Serial.println("[FATAL] Failed to initialize config manager");
        while (1) delay(1000);
    }
    configManager.printConfig();

    // Get controller mode
    bool isProxyMode = configManager.isProxyMode();
    const char* modeName = isProxyMode ? "PROXY" : "DIRECT";
    Serial.printf("[INIT] Operating in %s mode\n", modeName);

    // Initialize LED controller (used in direct mode, or for status indicators in proxy mode)
    if (!ledController.begin()) {
        Serial.println("[WARN] Failed to initialize LED controller");
    } else {
        // Quick startup blink - blue for direct, cyan for proxy
        if (isProxyMode) {
            ledController.blink(0, 255, 255, 2, 100);  // Cyan for proxy
        } else {
            ledController.blink(0, 0, 255, 2, 100);    // Blue for direct
        }
    }

    // Determine BLE device name based on mode
    const char* bleDeviceName = isProxyMode ? BLE_DEVICE_NAME_PROXY : BLE_DEVICE_NAME_DIRECT;

    // Initialize BLE server (before WiFi to allow configuration via app)
    if (!bleServer.begin(bleDeviceName)) {
        Serial.println("[WARN] Failed to initialize BLE server");
    } else {
        // Set callback for when LED data is received from Bluetooth (direct mode only)
        if (!isProxyMode) {
            bleServer.setLedDataCallback(onBluetoothLedData);
        }
    }

    // Initialize BLE client (proxy mode only)
    if (isProxyMode) {
        if (!bleClient.begin()) {
            Serial.println("[WARN] Failed to initialize BLE client");
        } else {
            // Try to connect to saved target board
            if (configManager.hasTargetBoard()) {
                String targetMac = configManager.getTargetBoardMac();
                Serial.printf("[INIT] Connecting to target board: %s\n", targetMac.c_str());
                if (!bleClient.connect(targetMac)) {
                    Serial.println("[WARN] Failed to connect to target board - will retry");
                }
            } else {
                Serial.println("[INIT] No target board configured - use web UI to scan and select");
            }
        }
    }

    // Initialize WiFi (may block for config portal)
    Serial.println("[INIT] Starting WiFi...");
    if (!boardWiFiManager.begin()) {
        Serial.println("[WARN] WiFi not connected - use AP mode to configure");
    }

    // Initialize web server (for configuration)
    if (!boardWebServer.begin()) {
        Serial.println("[WARN] Failed to initialize web server");
    }

    // Initialize WebSocket client (if API key is configured)
    if (configManager.hasApiKey() && configManager.getSessionId().length() > 0) {
        Serial.println("[INIT] Starting WebSocket client...");

        // Set LED update callback for proxy mode
        if (isProxyMode) {
            wsClient.setLedUpdateCallback(onWebSocketLedUpdate);
        }

        if (!wsClient.begin()) {
            Serial.println("[WARN] Failed to initialize WebSocket client");
        }
    } else {
        Serial.println("[INIT] WebSocket client not started - configure API key and session ID");
    }

    // Ready
    Serial.println();
    Serial.println("=================================");
    Serial.printf("  Controller Ready! (%s)\n", modeName);
    Serial.println("=================================");
    Serial.printf("  IP: %s\n", boardWiFiManager.getIPAddress().c_str());
    Serial.printf("  BLE: %s\n", bleDeviceName);
    if (isProxyMode && configManager.hasTargetBoard()) {
        Serial.printf("  Target: %s\n", configManager.getTargetBoardMac().c_str());
    }
    Serial.println("=================================");
    Serial.println();

    // Green blink to indicate ready
    ledController.blink(0, 255, 0, 3, 100);
}

void loop() {
    // Process WebSocket events
    wsClient.loop();

    // Process BLE client events (proxy mode)
    if (configManager.isProxyMode()) {
        bleClient.loop();
    }

    // Process web server requests
    boardWebServer.handleClient();

    // Small delay to prevent watchdog issues
    delay(1);
}

/**
 * Callback when LED data is received via Bluetooth from official app (DIRECT mode)
 * Forward the climb to the BoardSesh session so it can be matched
 */
void onBluetoothLedData(const LedCommand* commands, int count, int angle) {
    Serial.printf("[Main] Bluetooth LED data received: %d LEDs, angle: %d\n", count, angle);

    // Forward to backend via WebSocket to match climb
    if (wsClient.isSubscribed()) {
        wsClient.sendLedPositions(commands, count, angle);
    }
}

/**
 * Callback when LED commands are received from WebSocket (PROXY mode)
 * Forward the commands to the connected Kilter board via BLE
 */
void onWebSocketLedUpdate(const LedCommand* commands, int count) {
    Serial.printf("[Main] WebSocket LED update received: %d LEDs\n", count);

    // In proxy mode, forward to the connected Kilter board via BLE client
    if (bleClient.isConnected()) {
        if (bleClient.sendLedCommands(commands, count)) {
            Serial.printf("[Main] Forwarded %d LED commands to target board\n", count);
        } else {
            Serial.println("[Main] Failed to forward LED commands to target board");
        }
    } else {
        Serial.println("[Main] No target board connected - cannot forward LED commands");
        // Flash red to indicate error
        ledController.blink(255, 0, 0, 2, 100);
    }
}

#endif  // EMULATOR_BUILD

