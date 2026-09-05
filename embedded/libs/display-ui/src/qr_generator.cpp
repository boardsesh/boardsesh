// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "qr_generator.h"

#include <log_buffer.h>
#include <qrcode.h>  // ricmoo/QRCode library

QRGenerator QRCode_Gen;

// Static QRCode object for the library
static QRCode qrcode;

QRGenerator::QRGenerator() : qrSize(0), valid(false) {
    urlBuffer[0] = '\0';
    memset(qrData, 0, sizeof(qrData));
}

bool QRGenerator::generate(const char* sessionId) {
    clear();

    if (!sessionId || strlen(sessionId) == 0) {
        Logger.logln("QRGen: Missing sessionId");
        return false;
    }

    // Build the URL
    // Format: https://boardsesh.com/join/{sessionId}
    int len = snprintf(urlBuffer, sizeof(urlBuffer), "https://boardsesh.com/join/%s", sessionId);

    if (len >= (int)sizeof(urlBuffer)) {
        Logger.logln("QRGen: URL too long (%d chars)", len);
        return false;
    }

    // Check if URL fits in QR code
    if (len > QR_MAX_DATA_SIZE) {
        Logger.logln("QRGen: URL exceeds QR capacity (%d > %d)", len, QR_MAX_DATA_SIZE);
        return false;
    }

    Logger.logln("QRGen: Generating QR for %s", urlBuffer);

    // Generate QR code
    qrcode_initText(&qrcode, qrData, QR_VERSION, ECC_LOW, urlBuffer);
    qrSize = qrcode.size;
    valid = true;

    Logger.logln("QRGen: Generated %dx%d QR code", qrSize, qrSize);
    return true;
}

void QRGenerator::clear() {
    valid = false;
    qrSize = 0;
    urlBuffer[0] = '\0';
    memset(qrData, 0, sizeof(qrData));
}

bool QRGenerator::isValid() const {
    return valid;
}

const uint8_t* QRGenerator::getData() const {
    return qrData;
}

int QRGenerator::getSize() const {
    return qrSize;
}

bool QRGenerator::getModule(int x, int y) const {
    if (!valid || x < 0 || y < 0 || x >= qrSize || y >= qrSize) {
        return false;
    }
    return qrcode_getModule(&qrcode, x, y);
}

int QRGenerator::getPixelSize() const {
    if (!valid)
        return 0;
    // Add 2 modules of quiet zone on each side
    return (qrSize + 4) * QR_MODULE_SIZE;
}

const char* QRGenerator::getUrl() const {
    return urlBuffer;
}
