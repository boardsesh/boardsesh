// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * ESP32 WiFi Mock Header for Native Unit Testing
 *
 * Provides a mock WiFi class and related types to simulate WiFi
 * functionality for testing WiFi management code.
 */

#ifndef WIFI_MOCK_H
#define WIFI_MOCK_H

#include "Arduino.h"

#include <cstdint>
#include <string>
#include <vector>

// WiFi status codes
typedef enum {
    WL_NO_SHIELD = 255,
    WL_IDLE_STATUS = 0,
    WL_NO_SSID_AVAIL = 1,
    WL_SCAN_COMPLETED = 2,
    WL_CONNECTED = 3,
    WL_CONNECT_FAILED = 4,
    WL_CONNECTION_LOST = 5,
    WL_DISCONNECTED = 6
} wl_status_t;

// WiFi modes
typedef enum { WIFI_OFF = 0, WIFI_STA = 1, WIFI_AP = 2, WIFI_AP_STA = 3 } wifi_mode_t;

// WiFi auth types
typedef enum {
    WIFI_AUTH_OPEN = 0,
    WIFI_AUTH_WEP,
    WIFI_AUTH_WPA_PSK,
    WIFI_AUTH_WPA2_PSK,
    WIFI_AUTH_WPA_WPA2_PSK,
    WIFI_AUTH_WPA2_ENTERPRISE,
    WIFI_AUTH_WPA3_PSK,
    WIFI_AUTH_WPA2_WPA3_PSK,
    WIFI_AUTH_WAPI_PSK,
    WIFI_AUTH_MAX
} wifi_auth_mode_t;

/**
 * Mock IPAddress class
 */
class IPAddress {
  public:
    IPAddress() : addr_(0) {}
    IPAddress(uint32_t addr) : addr_(addr) {}
    IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) {
        addr_ = ((uint32_t)a) | ((uint32_t)b << 8) | ((uint32_t)c << 16) | ((uint32_t)d << 24);
    }

    String toString() const {
        char buf[16];
        snprintf(buf, sizeof(buf), "%u.%u.%u.%u", (uint8_t)(addr_ & 0xFF), (uint8_t)((addr_ >> 8) & 0xFF),
                 (uint8_t)((addr_ >> 16) & 0xFF), (uint8_t)((addr_ >> 24) & 0xFF));
        return String(buf);
    }

    operator uint32_t() const { return addr_; }

  private:
    uint32_t addr_;
};

/**
 * Mock WiFi class
 */
class MockWiFi {
  public:
    struct NetworkInfo {
        std::string ssid;
        int32_t rssi;
        bool secure;
    };

    MockWiFi()
        : status_(WL_DISCONNECTED), mode_(WIFI_OFF), autoReconnect_(false), rssi_(-70), localIP_(192, 168, 1, 100),
          ssid_(""), macAddress_("AA:BB:CC:DD:EE:FF"), apActive_(false), apSSID_(""), apIP_(192, 168, 4, 1) {}

    // Mode control
    bool mode(wifi_mode_t mode) {
        mode_ = mode;
        return true;
    }

    wifi_mode_t getMode() const { return mode_; }

    // Connection control
    wl_status_t begin(const char* ssid, const char* passphrase = nullptr) {
        (void)passphrase;
        ssid_ = ssid ? ssid : "";
        // In mock, we don't automatically connect - tests control this
        return status_;
    }

    bool disconnect(bool wifioff = false) {
        (void)wifioff;
        status_ = WL_DISCONNECTED;
        ssid_ = "";
        return true;
    }

    bool setAutoReconnect(bool autoReconnect) {
        autoReconnect_ = autoReconnect;
        return true;
    }

    bool getAutoReconnect() const { return autoReconnect_; }

    // Status
    wl_status_t status() const { return status_; }

    String SSID() const { return ssid_; }

    IPAddress localIP() const { return localIP_; }

    int8_t RSSI() const { return rssi_; }

    String macAddress() const { return macAddress_; }

    // Access Point methods
    bool softAP(const char* ssid, const char* passphrase = nullptr) {
        (void)passphrase;
        apSSID_ = ssid ? ssid : "";
        apActive_ = true;
        return true;
    }

    bool softAPdisconnect(bool wifioff = false) {
        (void)wifioff;
        apActive_ = false;
        apSSID_ = "";
        return true;
    }

    IPAddress softAPIP() const { return apIP_; }

    // Scan methods
    int16_t scanNetworks() { return networks_.size(); }

    void scanDelete() {
        // Reset scan results (keep for next scan)
    }

    String SSID(int index) const {
        if (index >= 0 && (size_t)index < networks_.size()) {
            return networks_[index].ssid.c_str();
        }
        return String();
    }

    int32_t RSSI(int index) const {
        if (index >= 0 && (size_t)index < networks_.size()) {
            return networks_[index].rssi;
        }
        return 0;
    }

    wifi_auth_mode_t encryptionType(int index) const {
        if (index >= 0 && (size_t)index < networks_.size()) {
            return networks_[index].secure ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        }
        return WIFI_AUTH_OPEN;
    }

    // Test control methods - for setting up mock state
    void mockSetStatus(wl_status_t status) { status_ = status; }
    void mockSetSSID(const char* ssid) { ssid_ = ssid ? ssid : ""; }
    void mockSetRSSI(int8_t rssi) { rssi_ = rssi; }
    void mockSetLocalIP(IPAddress ip) { localIP_ = ip; }
    void mockSetLocalIP(uint8_t a, uint8_t b, uint8_t c, uint8_t d) { localIP_ = IPAddress(a, b, c, d); }
    void mockSetMacAddress(const char* mac) { macAddress_ = mac ? mac : ""; }

    void mockSetNetworks(const std::vector<NetworkInfo>& networks) { networks_ = networks; }

    // Reset mock to initial state
    void mockReset() {
        status_ = WL_DISCONNECTED;
        mode_ = WIFI_OFF;
        autoReconnect_ = false;
        rssi_ = -70;
        localIP_ = IPAddress(192, 168, 1, 100);
        ssid_ = "";
        macAddress_ = "AA:BB:CC:DD:EE:FF";
        networks_.clear();
        apActive_ = false;
        apSSID_ = "";
        apIP_ = IPAddress(192, 168, 4, 1);
    }

  private:
    wl_status_t status_;
    wifi_mode_t mode_;
    bool autoReconnect_;
    int8_t rssi_;
    IPAddress localIP_;
    String ssid_;
    String macAddress_;
    std::vector<NetworkInfo> networks_;
    bool apActive_ = false;
    String apSSID_;
    IPAddress apIP_ = IPAddress(192, 168, 4, 1);
};

extern MockWiFi WiFi;

#endif  // WIFI_MOCK_H
