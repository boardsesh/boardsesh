#ifndef BLE_SCANNER_H
#define BLE_SCANNER_H

#include <Arduino.h>
#include <NimBLEDevice.h>

#include <vector>

// Aurora boards advertise this service UUID for discovery
#define AURORA_ADVERTISED_SERVICE_UUID "4488b571-7806-4df6-bcff-a2897e4953ff"

// Scan timeout in seconds
#define SCAN_TIMEOUT_SEC 30

/**
 * Information about a discovered Aurora board
 */
struct DiscoveredBoard {
    NimBLEAddress address;
    String name;
    int rssi;
    bool valid;

    DiscoveredBoard() : rssi(0), valid(false) {}
    DiscoveredBoard(NimBLEAddress addr, const String& n, int r) : address(addr), name(n), rssi(r), valid(true) {}
};

typedef void (*ScanResultCallback)(const DiscoveredBoard& board);
typedef void (*ScanCompleteCallback)(const std::vector<DiscoveredBoard>& boards);

/**
 * BLEScanner searches for nearby Aurora climbing boards.
 *
 * Features:
 * - Filters by Aurora's advertised service UUID
 * - Returns RSSI for signal strength indication
 * - 30 second scan timeout
 * - Callback when scan completes
 */
class BLEScanner : public NimBLEScanCallbacks {
  public:
    BLEScanner();

    /**
     * Start scanning for Aurora boards.
     * @param onResult Callback for each board found (optional)
     * @param onComplete Callback when scan finishes
     * @param timeoutSec Scan duration in seconds (default 30)
     */
    void startScan(ScanResultCallback onResult = nullptr, ScanCompleteCallback onComplete = nullptr,
                   int timeoutSec = SCAN_TIMEOUT_SEC);

    /**
     * Stop an ongoing scan.
     */
    void stopScan();

    /**
     * Check if currently scanning.
     */
    bool isScanning() const;

    /**
     * Get the list of discovered boards from last scan.
     */
    const std::vector<DiscoveredBoard>& getDiscoveredBoards() const;

    /**
     * Get the best (highest RSSI) discovered board.
     * @return Pointer to best board, or nullptr if none found
     */
    const DiscoveredBoard* getBestBoard() const;

    /**
     * Find a board by MAC address.
     * @param mac MAC address string
     * @return Pointer to board, or nullptr if not found
     */
    const DiscoveredBoard* findByAddress(const String& mac) const;

    // NimBLE callback
    void onResult(const NimBLEAdvertisedDevice* advertisedDevice) override;
    void onScanEnd(const NimBLEScanResults& scanResults, int reason) override;

  private:
    NimBLEScan* pScan;
    std::vector<DiscoveredBoard> discoveredBoards;
    ScanResultCallback resultCallback;
    ScanCompleteCallback completeCallback;
    bool scanning;

    static BLEScanner* instance;
};

extern BLEScanner Scanner;

#endif
