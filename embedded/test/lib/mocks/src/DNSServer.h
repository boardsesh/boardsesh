// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * DNSServer Mock Header for Native Unit Testing
 *
 * Provides a mock ESP32 DNSServer implementation to satisfy compilation
 * of wifi_utils and esp_web_server during native tests.
 */

#ifndef DNSSERVER_MOCK_H
#define DNSSERVER_MOCK_H

#include "Arduino.h"
#include "WiFi.h"

#include <cstdint>

class DNSServer {
  public:
    DNSServer() : running_(false), port_(0) {}

    void start(uint16_t port, const char* domain, IPAddress ip) {
        running_ = true;
        port_ = port;
    }

    void processNextRequest() {
        // No-op in mock
    }

    void stop() {
        running_ = false;
    }

    // Test helpers
    bool mockIsRunning() const { return running_; }
    uint16_t mockGetPort() const { return port_; }
    void mockReset() {
        running_ = false;
        port_ = 0;
    }

  private:
    bool running_;
    uint16_t port_;
};

#endif  // DNSSERVER_MOCK_H
