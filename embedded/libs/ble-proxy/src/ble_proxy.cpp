// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * BLE Proxy Implementation
 *
 * This module uses a singleton pattern with a static instance pointer for
 * ESP32/NimBLE callback compatibility. The scanner and client libraries
 * require C-style callback functions which cannot directly invoke member
 * functions. Static wrapper functions forward calls to the singleton instance.
 */

#include "ble_proxy.h"

#include <config_manager.h>
#include <log_buffer.h>
#include <nordic_uart_ble.h>

BLEProxy Proxy;

// Delay before retrying scan when no boards found (10 seconds)
static const unsigned long SCAN_RETRY_DELAY_MS = 10000;

// Static instance pointer for callbacks (required for C-style callback wrappers)
static BLEProxy* proxyInstance = nullptr;

// Static callback wrappers
static void onBoardConnectedStatic(bool connected) {
    if (proxyInstance) {
        proxyInstance->handleBoardConnected(connected);
    }
}

static void onBoardDataStatic(const uint8_t* data, size_t len) {
    if (proxyInstance) {
        proxyInstance->handleBoardData(data, len);
    }
}

static void onScanCompleteStatic(const std::vector<DiscoveredBoard>& boards) {
    if (proxyInstance) {
        proxyInstance->handleScanComplete(boards);
    }
}

static void onBoardFoundStatic(const DiscoveredBoard& board) {
    if (proxyInstance) {
        proxyInstance->handleBoardFound(board);
    }
}

BLEProxy::BLEProxy()
    : state(BLEProxyState::PROXY_DISABLED), enabled(false), scanStartTime(0), reconnectDelay(5000),
      waitStartTime(0), waitDuration(0),
      stateCallback(nullptr), dataCallback(nullptr), sendToAppCallback(nullptr) {
    proxyInstance = this;
}

void BLEProxy::begin(const String& mac) {
    targetMac = mac;

    // Load enabled state from config
    enabled = Config.getBool("proxy_en", false);

    if (enabled) {
        Logger.logln("BLEProxy: Proxy mode enabled");
        setState(BLEProxyState::IDLE);

        // Set up callbacks for the board client
        BoardClient.setConnectCallback(onBoardConnectedStatic);
        BoardClient.setDataCallback(onBoardDataStatic);
    } else {
        Logger.logln("BLEProxy: Proxy mode disabled");
        setState(BLEProxyState::PROXY_DISABLED);
    }
}

void BLEProxy::setEnabled(bool enable) {
    if (enabled == enable)
        return;

    enabled = enable;
    Config.setBool("proxy_en", enable);

    if (enable) {
        Logger.logln("BLEProxy: Enabling proxy mode");
        setState(BLEProxyState::IDLE);

        BoardClient.setConnectCallback(onBoardConnectedStatic);
        BoardClient.setDataCallback(onBoardDataStatic);
    } else {
        Logger.logln("BLEProxy: Disabling proxy mode");
        BoardClient.disconnect();
        Scanner.stopScan();
        // Reset connection flag when disabling
        connectionInitiated = false;
        setState(BLEProxyState::PROXY_DISABLED);
    }
}

bool BLEProxy::isEnabled() const {
    return enabled;
}

void BLEProxy::loop() {
    if (!enabled)
        return;

    switch (state) {
        case BLEProxyState::IDLE:
            // Start scanning for boards
            startScan();
            break;

        case BLEProxyState::SCAN_COMPLETE_NONE:
            // Retry scanning after delay
            if (millis() - waitStartTime >= waitDuration) {
                Logger.logln("BLEProxy: Retrying scan...");
                setState(BLEProxyState::IDLE);
            }
            break;

        case BLEProxyState::SCANNING:
            // Check if we found a board to connect to
            if (pendingConnectName.length() > 0) {
                Logger.logln("BLEProxy: Found board, preparing to connect to %s", pendingConnectName.c_str());

                // Stop the scan (this may trigger handleScanComplete, but we check pendingConnectName)
                Scanner.stopScan();

                Logger.logln("BLEProxy: Addr: %s", pendingConnectAddress.toString().c_str());

                // Non-blocking wait: Allow NimBLE to fully release scan resources before
                // initiating client connection. Without this, connection may fail
                // due to scan cleanup not completing.
                waitStartTime = millis();
                waitDuration = 100;
                setState(BLEProxyState::WAIT_BEFORE_CONNECT);
            }
            break;

        case BLEProxyState::WAIT_BEFORE_CONNECT:
            // Non-blocking wait before connecting
            if (millis() - waitStartTime >= waitDuration) {
                Logger.logln("BLEProxy: Connecting to %s", pendingConnectName.c_str());

                // Store connection info and clear pending
                NimBLEAddress connectAddr = pendingConnectAddress;
                pendingConnectName = "";

                setState(BLEProxyState::CONNECTING);
                BoardClient.connect(connectAddr);
            }
            break;

        case BLEProxyState::CONNECTING:
            // Handled by client callbacks
            break;

        case BLEProxyState::WAIT_BEFORE_ADVERTISE:
            // Non-blocking wait before starting advertising
            if (millis() - waitStartTime >= waitDuration) {
                Logger.logln("BLEProxy: Starting BLE advertising");
                // Use BLE.startAdvertising() which properly manages advertising state
                // and avoids duplicate GATT server start issues
                BLE.startAdvertising();
                setState(BLEProxyState::CONNECTED);
            }
            break;

        case BLEProxyState::CONNECTED:
            BoardClient.loop();
            break;

        case BLEProxyState::RECONNECTING:
            BoardClient.loop();
            break;

        default:
            break;
    }
}

BLEProxyState BLEProxy::getState() const {
    return state;
}

bool BLEProxy::isConnectedToBoard() const {
    return state == BLEProxyState::CONNECTED && BoardClient.isConnected();
}

String BLEProxy::getConnectedBoardAddress() const {
    return BoardClient.getConnectedAddress();
}

void BLEProxy::setStateCallback(ProxyStateCallback callback) {
    stateCallback = callback;
}

void BLEProxy::setDataCallback(ProxyDataCallback callback) {
    dataCallback = callback;
}

void BLEProxy::setSendToAppCallback(ProxySendToAppCallback callback) {
    sendToAppCallback = callback;
}

bool BLEProxy::forwardToBoard(const uint8_t* data, size_t len) {
    if (!isConnectedToBoard()) {
        return false;
    }

    if (dataCallback) {
        dataCallback(data, len, true);  // fromApp = true
    }

    return BoardClient.send(data, len);
}

void BLEProxy::forwardToApp(const uint8_t* data, size_t len) {
    if (dataCallback) {
        dataCallback(data, len, false);  // fromApp = false
    }

    // Forward to connected app via BLE server
    if (sendToAppCallback) {
        sendToAppCallback(data, len);
    }
}

void BLEProxy::setState(BLEProxyState newState) {
    if (state != newState) {
        Logger.logln("BLEProxy: State %d -> %d", (int)state, (int)newState);
        state = newState;
        if (stateCallback) {
            stateCallback(state);
        }
    }
}

void BLEProxy::startScan() {
    setState(BLEProxyState::SCANNING);
    scanStartTime = millis();

    // Use result callback to connect immediately when board found
    Scanner.startScan(onBoardFoundStatic, onScanCompleteStatic, 30);
}

void BLEProxy::handleBoardFound(const DiscoveredBoard& board) {
    // If we're still scanning and haven't found a board yet, mark it for connection
    // Don't stop scan or connect from callback - do it in loop() to avoid re-entry
    // Atomically check and set connectionInitiated to prevent race with handleScanComplete
    if (state == BLEProxyState::SCANNING &&
        pendingConnectName.length() == 0 &&
        !connectionInitiated.exchange(true)) {
        Logger.logln("BLEProxy: Found %s", board.name.c_str());

        // Store target info - loop() will handle connection
        pendingConnectAddress = board.address;
        pendingConnectName = board.name;
    }
}

void BLEProxy::handleScanComplete(const std::vector<DiscoveredBoard>& boards) {
    // If we're already connecting or connected (e.g., from handleBoardFound path),
    // don't try to connect again
    if (state == BLEProxyState::CONNECTING || state == BLEProxyState::CONNECTED) {
        Logger.logln("BLEProxy: Scan complete, already %s",
                     state == BLEProxyState::CONNECTED ? "connected" : "connecting");
        return;
    }

    if (boards.empty()) {
        Logger.logln("BLEProxy: No boards found, will retry in %lus", SCAN_RETRY_DELAY_MS / 1000);
        // Reset connection flag so future scans can initiate connections
        connectionInitiated = false;
        waitStartTime = millis();
        waitDuration = SCAN_RETRY_DELAY_MS;
        setState(BLEProxyState::SCAN_COMPLETE_NONE);
        return;
    }

    const DiscoveredBoard* target = nullptr;

    // If we have a target MAC, find it
    if (targetMac.length() > 0) {
        target = Scanner.findByAddress(targetMac);
        if (!target) {
            Logger.logln("BLEProxy: Target MAC %s not found", targetMac.c_str());
        }
    }

    // Otherwise, use the strongest signal
    if (!target) {
        target = Scanner.getBestBoard();
    }

    if (target) {
        // Atomically check and set to prevent race with handleBoardFound
        if (connectionInitiated.exchange(true)) {
            Logger.logln("BLEProxy: Connection already initiated by handleBoardFound, skipping");
            return;
        }

        Logger.logln("BLEProxy: Will connect to %s (%s)", target->name.c_str(), target->address.toString().c_str());

        // Store connection info for the wait state
        pendingConnectAddress = target->address;
        pendingConnectName = target->name;

        // Non-blocking wait: Allow NimBLE to fully release scan resources before
        // initiating client connection. Without this, connection may fail
        // due to scan cleanup not completing.
        waitStartTime = millis();
        waitDuration = 100;
        setState(BLEProxyState::WAIT_BEFORE_CONNECT);
    } else {
        // Reset connection flag so next scan can initiate a new connection
        connectionInitiated = false;
        setState(BLEProxyState::IDLE);
    }
}

void BLEProxy::handleBoardConnected(bool connected) {
    if (connected) {
        Logger.logln("BLEProxy: Connected to board!");

        // Now that we're connected to the real board, start advertising
        // so phone apps can connect to us. Use non-blocking wait to allow
        // BLE client connection to stabilize before starting server
        // advertising. This prevents GATT server issues when client and
        // server start simultaneously.
        waitStartTime = millis();
        waitDuration = 200;
        setState(BLEProxyState::WAIT_BEFORE_ADVERTISE);
    } else {
        Logger.logln("BLEProxy: Board disconnected");

        // Reset connection flag so next scan can initiate a new connection
        connectionInitiated = false;

        setState(BLEProxyState::RECONNECTING);
    }
}

void BLEProxy::handleBoardData(const uint8_t* data, size_t len) {
    // Forward data from board to app
    forwardToApp(data, len);
}
