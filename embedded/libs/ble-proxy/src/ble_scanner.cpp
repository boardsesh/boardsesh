/**
 * BLE Scanner Implementation
 *
 * This module uses a singleton pattern with a global instance pointer for
 * ESP32/NimBLE callback compatibility. The NimBLE scan API requires C-style
 * callback functions for scan completion events, which cannot directly call
 * member functions. The static instance pointer allows the static callback
 * to forward results to the singleton instance.
 */

#include "ble_scanner.h"

#include <log_buffer.h>

BLEScanner Scanner;
BLEScanner* BLEScanner::instance = nullptr;

BLEScanner::BLEScanner() : pScan(nullptr), resultCallback(nullptr), completeCallback(nullptr), scanning(false) {
    instance = this;
}

void BLEScanner::startScan(ScanResultCallback onResult, ScanCompleteCallback onComplete, int timeoutSec) {
    if (scanning) {
        Logger.logln("BLEScanner: Already scanning");
        return;
    }

    resultCallback = onResult;
    completeCallback = onComplete;
    discoveredBoards.clear();

    // Initialize BLE if not already done
    if (!NimBLEDevice::isInitialized()) {
        Logger.logln("BLEScanner: BLE not initialized, skipping scan");
        return;
    }

    pScan = NimBLEDevice::getScan();
    pScan->setScanCallbacks(this);
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    pScan->setWindow(99);
    pScan->setMaxResults(0);  // Don't store in NimBLE, we store ourselves

    Logger.logln("BLEScanner: Starting scan for Aurora boards (%d sec)", timeoutSec);
    scanning = true;

    pScan->start(timeoutSec, false, true);
}

void BLEScanner::stopScan() {
    if (scanning && pScan) {
        Logger.logln("BLEScanner: Stopping scan");
        pScan->stop();
        scanning = false;
    }
}

bool BLEScanner::isScanning() const {
    return scanning;
}

const std::vector<DiscoveredBoard>& BLEScanner::getDiscoveredBoards() const {
    return discoveredBoards;
}

const DiscoveredBoard* BLEScanner::getBestBoard() const {
    if (discoveredBoards.empty()) {
        return nullptr;
    }

    const DiscoveredBoard* best = &discoveredBoards[0];
    for (const auto& board : discoveredBoards) {
        if (board.rssi > best->rssi) {
            best = &board;
        }
    }
    return best;
}

const DiscoveredBoard* BLEScanner::findByAddress(const String& mac) const {
    for (const auto& board : discoveredBoards) {
        if (mac.equalsIgnoreCase(board.address.toString().c_str())) {
            return &board;
        }
    }
    return nullptr;
}

void BLEScanner::onResult(const NimBLEAdvertisedDevice* advertisedDevice) {
    // Check if this device advertises Aurora's service UUID
    if (!advertisedDevice->isAdvertisingService(NimBLEUUID(AURORA_ADVERTISED_SERVICE_UUID))) {
        return;
    }

    // Check if we already found this board
    for (const auto& board : discoveredBoards) {
        if (board.address == advertisedDevice->getAddress()) {
            return;  // Already in list
        }
    }

    String name = advertisedDevice->getName().c_str();
    if (name.length() == 0) {
        name = "Unknown Board";
    }

    DiscoveredBoard board(advertisedDevice->getAddress(), name, advertisedDevice->getRSSI());

    discoveredBoards.push_back(board);
    Logger.logln("BLEScanner: Found Aurora board: %s (%s, %d dBm)", name.c_str(),
                 advertisedDevice->getAddress().toString().c_str(), advertisedDevice->getRSSI());

    if (resultCallback) {
        resultCallback(board);
    }
}

void BLEScanner::onScanEnd(const NimBLEScanResults& scanResults, int reason) {
    (void)scanResults;
    (void)reason;

    // Explicitly stop and clear the scan BEFORE doing anything else.
    // NimBLE requires scan to be fully stopped before creating client connections.
    if (pScan) {
        pScan->stop();
        pScan->clearResults();
    }
    scanning = false;

    // Note: The BLE proxy handles settling time via its WAIT_BEFORE_CONNECT
    // state, using a non-blocking timer. This avoids blocking the callback
    // and keeps the main loop responsive.

    Logger.logln("BLEScanner: Scan done, %d boards", discoveredBoards.size());

    if (completeCallback) {
        completeCallback(discoveredBoards);
    }
}
