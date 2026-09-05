// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef BLE_PROXY_H
#define BLE_PROXY_H

#include "ble_client.h"
#include "ble_scanner.h"

#include <Arduino.h>
#include <atomic>

// Proxy state machine
enum class BLEProxyState {
    PROXY_DISABLED,         // Proxy mode not enabled
    IDLE,                   // Waiting to scan
    SCANNING,               // Scanning for boards
    SCAN_COMPLETE_NONE,     // Scan completed but no boards found (will auto-retry after delay)
    WAIT_BEFORE_CONNECT,    // Non-blocking wait after scan before connecting
    CONNECTING,             // Connecting to board
    WAIT_BEFORE_ADVERTISE,  // Non-blocking wait after connect before advertising
    CONNECTED,              // Connected and proxying
    RECONNECTING            // Connection lost, will retry
};

typedef void (*ProxyStateCallback)(BLEProxyState state);
typedef void (*ProxyDataCallback)(const uint8_t* data, size_t len, bool fromApp);
typedef void (*ProxySendToAppCallback)(const uint8_t* data, size_t len);

/**
 * BLEProxy orchestrates the proxy connection between official app and Aurora board.
 *
 * Architecture:
 * - Acts as a BLE server (appears as "Kilter Boardsesh" to official app)
 * - Acts as a BLE client to the actual Aurora board
 * - Forwards all data bidirectionally
 *
 * State Machine:
 *   DISABLED → IDLE → SCANNING → CONNECTING → CONNECTED
 *                                     ↑            ↓
 *                                     └── RECONNECTING ←┘
 *
 * Usage:
 * 1. Call begin() with a target MAC or empty string for auto-detect
 * 2. Call loop() regularly to process state
 * 3. Data received from app is forwarded to board
 * 4. Data received from board is forwarded to app
 */
class BLEProxy {
  public:
    BLEProxy();

    /**
     * Initialize the proxy.
     * @param targetMac Optional MAC address of target board (empty for auto-detect)
     */
    void begin(const String& targetMac = "");

    /**
     * Enable or disable proxy mode.
     */
    void setEnabled(bool enabled);

    /**
     * Check if proxy mode is enabled.
     */
    bool isEnabled() const;

    /**
     * Process proxy state (call from loop).
     */
    void loop();

    /**
     * Get current proxy state.
     */
    BLEProxyState getState() const;

    /**
     * Check if proxy is connected to the actual board.
     */
    bool isConnectedToBoard() const;

    /**
     * Get the MAC address of the connected board.
     */
    String getConnectedBoardAddress() const;

    /**
     * Set callback for state changes.
     */
    void setStateCallback(ProxyStateCallback callback);

    /**
     * Set callback for proxied data (for monitoring/display).
     * @param callback Called with data and direction (fromApp=true means app→board)
     */
    void setDataCallback(ProxyDataCallback callback);

    /**
     * Set callback for sending data to connected app via BLE server.
     * This must be set by the main application to provide the BLE send function.
     * @param callback Function to send data to app via BLE
     */
    void setSendToAppCallback(ProxySendToAppCallback callback);

    /**
     * Forward data from app to board.
     * This is called by the nordic-uart-ble server when it receives data.
     * @param data Data bytes
     * @param len Length of data
     * @return true if forwarded successfully
     */
    bool forwardToBoard(const uint8_t* data, size_t len);

    /**
     * Forward data from board to app.
     * This is called internally when board sends data.
     */
    void forwardToApp(const uint8_t* data, size_t len);

    // Public handlers for static callbacks
    void handleBoardFound(const DiscoveredBoard& board);
    void handleScanComplete(const std::vector<DiscoveredBoard>& boards);
    void handleBoardConnected(bool connected);
    void handleBoardData(const uint8_t* data, size_t len);

  private:
    BLEProxyState state;
    bool enabled;
    String targetMac;
    unsigned long scanStartTime;
    unsigned long reconnectDelay;

    // Non-blocking timer for wait states
    unsigned long waitStartTime;
    unsigned long waitDuration;

    // Pending connection info (stored after scan, before connect)
    NimBLEAddress pendingConnectAddress;
    String pendingConnectName;

    ProxyStateCallback stateCallback;
    ProxyDataCallback dataCallback;
    ProxySendToAppCallback sendToAppCallback;

    // Atomic flag to prevent race between handleBoardFound/handleScanComplete
    // callbacks and loop(). Both callbacks can fire asynchronously from NimBLE
    // and may attempt to initiate a connection simultaneously.
    std::atomic<bool> connectionInitiated{false};

    void setState(BLEProxyState newState);
    void startScan();
};

extern BLEProxy Proxy;

#endif
