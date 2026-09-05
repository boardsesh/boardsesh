// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef QR_GENERATOR_H
#define QR_GENERATOR_H

#include <Arduino.h>

// QR code version settings
#define QR_VERSION 4         // Version 4 can hold ~78 alphanumeric chars with ECC_LOW
#define QR_MODULE_SIZE 2     // Size of each QR module in pixels
#define QR_MAX_DATA_SIZE 78  // Max data for Version 4 with ECC_LOW

/**
 * QRGenerator creates QR codes for Boardsesh session join URLs.
 *
 * URL format: https://boardsesh.com/join/{sessionId}
 *
 * Example:
 *   sessionId: xyz789-abc123
 *   Result: https://boardsesh.com/join/xyz789-abc123
 */
class QRGenerator {
  public:
    QRGenerator();

    /**
     * Generate QR data for a session join URL.
     *
     * @param sessionId Session ID for joining
     * @return true if QR was generated successfully
     */
    bool generate(const char* sessionId);

    /**
     * Clear the QR data.
     */
    void clear();

    /**
     * Check if QR data is valid.
     */
    bool isValid() const;

    /**
     * Get the QR code data buffer.
     * This is the internal qrcode_t buffer from the QRCode library.
     */
    const uint8_t* getData() const;

    /**
     * Get the QR code size (modules per side).
     */
    int getSize() const;

    /**
     * Check if a specific module is set (black).
     *
     * @param x X coordinate (0 to size-1)
     * @param y Y coordinate (0 to size-1)
     * @return true if module is black
     */
    bool getModule(int x, int y) const;

    /**
     * Get the calculated QR code pixel size.
     * Based on module size and border.
     */
    int getPixelSize() const;

    /**
     * Get the URL that was encoded.
     */
    const char* getUrl() const;

  private:
    uint8_t qrData[128];  // QRCode library data buffer (Version 4)
    char urlBuffer[100];  // Buffer for the full URL
    int qrSize;
    bool valid;
};

extern QRGenerator QRCode_Gen;

#endif
