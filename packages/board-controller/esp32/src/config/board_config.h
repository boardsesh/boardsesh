// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

// ============================================
// Hardware Configuration
// ============================================

// Default LED configuration
#define DEFAULT_LED_PIN 5           // GPIO pin for WS2811 data line
#define DEFAULT_LED_COUNT 300       // Maximum number of LEDs
#define DEFAULT_BRIGHTNESS 128      // Default brightness (0-255)

// LED timing (WS2811)
#define LED_TYPE WS2811
#define LED_COLOR_ORDER GRB

// ============================================
// WiFi Configuration
// ============================================

// Access Point mode settings
#define AP_SSID "BoardSesh-Controller"
#define AP_PASSWORD ""              // Empty for open AP
#define AP_CHANNEL 1
#define AP_HIDDEN 0
#define AP_MAX_CONNECTIONS 4

// WiFi connection timeout (ms)
#define WIFI_CONNECT_TIMEOUT 30000

// ============================================
// Backend Configuration
// ============================================

// Default backend URL (can be overridden via config)
#define DEFAULT_BACKEND_URL "wss://backend.boardsesh.com/graphql"

// WebSocket reconnection settings
#define WS_RECONNECT_INTERVAL 5000  // ms between reconnection attempts
#define WS_PING_INTERVAL 30000      // ms between ping messages
#define WS_PONG_TIMEOUT 10000       // ms to wait for pong response

// ============================================
// BLE Configuration
// ============================================

// Aurora/Nordic UART Service UUIDs
#define AURORA_ADVERTISED_UUID "4488b571-7806-4df6-bcff-a2897e4953ff"
#define NORDIC_UART_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NORDIC_UART_RX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NORDIC_UART_TX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

// BLE device names (appears in scan)
#define BLE_DEVICE_NAME_DIRECT "Kilter Board"
#define BLE_DEVICE_NAME_PROXY "Kilter BoardSesh"

// BLE client settings (for proxy mode)
#define BLE_SCAN_DURATION_SECONDS 10
#define BLE_CLIENT_RECONNECT_INTERVAL 5000

// ============================================
// Operating Mode Configuration
// ============================================

// Controller modes:
// - DIRECT: Controller directly controls LEDs via WS2811 (replaces official controller)
// - PROXY: Controller connects to an official Kilter board via BLE and forwards commands
enum class ControllerMode : uint8_t {
    DIRECT = 0,  // Direct LED control (default)
    PROXY = 1    // BLE proxy to official board
};

// ============================================
// Web Server Configuration
// ============================================

#define WEB_SERVER_PORT 80

// ============================================
// NVS Configuration Keys
// ============================================

#define NVS_NAMESPACE "boardsesh"
#define NVS_KEY_WIFI_SSID "wifi_ssid"
#define NVS_KEY_WIFI_PASS "wifi_pass"
#define NVS_KEY_API_KEY "api_key"
#define NVS_KEY_BACKEND_URL "backend_url"
#define NVS_KEY_SESSION_ID "session_id"
#define NVS_KEY_LED_PIN "led_pin"
#define NVS_KEY_LED_COUNT "led_count"
#define NVS_KEY_BRIGHTNESS "brightness"
#define NVS_KEY_ANALYTICS "analytics"
#define NVS_KEY_CONTROLLER_MODE "ctrl_mode"
#define NVS_KEY_TARGET_BOARD_MAC "target_mac"

// ============================================
// Debug Configuration
// ============================================

#define DEBUG_SERIAL Serial
#define DEBUG_BAUD 115200

// Enable/disable debug output
#define DEBUG_WIFI 1
#define DEBUG_WEBSOCKET 1
#define DEBUG_BLE 1
#define DEBUG_LED 1

// ============================================
// Device Logging Macro
// ============================================
// Logs to both Serial and buffers for sending to backend via WebSocket.
// The WsClient will periodically send buffered logs to the backend,
// which forwards them to Axiom for aggregation.
//
// Usage:
//   DEVICE_LOG("INFO", "BLE", "Device connected: %s", mac);
//   DEVICE_LOG("ERROR", "WS", "Connection failed");
//
// Levels: DEBUG, INFO, WARN, ERROR
// Components: BLE, WS, WiFi, LED, CFG, WEB

// Forward declaration - implemented in ws_client.cpp
class WsClient;
extern WsClient wsClient;

#define DEVICE_LOG(level, component, fmt, ...) do { \
    char _log_msg[128]; \
    snprintf(_log_msg, sizeof(_log_msg), fmt, ##__VA_ARGS__); \
    Serial.printf("[%s][%s] %s\n", level, component, _log_msg); \
    wsClient.bufferLog(level, component, _log_msg); \
} while(0)

#endif // BOARD_CONFIG_H
