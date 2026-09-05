// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "lilygo_display.h"

#include <grade_colors.h>

#include <qrcode.h>

// Global display instance
LilyGoDisplay Display;

// ============================================
// LGFX_TDisplayS3 Implementation
// ============================================

LGFX_TDisplayS3::LGFX_TDisplayS3() {
    // Bus configuration for parallel 8-bit
    {
        auto cfg = _bus_instance.config();
        cfg.port = 0;
        cfg.freq_write = 20000000;
        cfg.pin_wr = LCD_WR_PIN;
        cfg.pin_rd = LCD_RD_PIN;
        cfg.pin_rs = LCD_RS_PIN;

        cfg.pin_d0 = LCD_D0_PIN;
        cfg.pin_d1 = LCD_D1_PIN;
        cfg.pin_d2 = LCD_D2_PIN;
        cfg.pin_d3 = LCD_D3_PIN;
        cfg.pin_d4 = LCD_D4_PIN;
        cfg.pin_d5 = LCD_D5_PIN;
        cfg.pin_d6 = LCD_D6_PIN;
        cfg.pin_d7 = LCD_D7_PIN;

        _bus_instance.config(cfg);
        _panel_instance.setBus(&_bus_instance);
    }

    // Panel configuration
    {
        auto cfg = _panel_instance.config();
        cfg.pin_cs = LCD_CS_PIN;
        cfg.pin_rst = LCD_RST_PIN;
        cfg.pin_busy = -1;

        cfg.memory_width = LILYGO_SCREEN_WIDTH;
        cfg.memory_height = LILYGO_SCREEN_HEIGHT;
        cfg.panel_width = LILYGO_SCREEN_WIDTH;
        cfg.panel_height = LILYGO_SCREEN_HEIGHT;
        cfg.offset_x = 35;
        cfg.offset_y = 0;
        cfg.offset_rotation = 0;
        cfg.dummy_read_pixel = 8;
        cfg.dummy_read_bits = 1;
        cfg.readable = true;
        cfg.invert = true;
        cfg.rgb_order = false;
        cfg.dlen_16bit = false;
        cfg.bus_shared = true;

        _panel_instance.config(cfg);
    }

    // Backlight configuration
    {
        auto cfg = _light_instance.config();
        cfg.pin_bl = LCD_BL_PIN;
        cfg.invert = false;
        cfg.freq = 12000;
        cfg.pwm_channel = 0;
        _light_instance.config(cfg);
        _panel_instance.setLight(&_light_instance);
    }

    setPanel(&_panel_instance);
}

// ============================================
// LilyGoDisplay Implementation
// ============================================

LilyGoDisplay::LilyGoDisplay() {}

LilyGoDisplay::~LilyGoDisplay() {}

bool LilyGoDisplay::begin() {
    // Enable display power
    pinMode(LCD_POWER_PIN, OUTPUT);
    digitalWrite(LCD_POWER_PIN, HIGH);
    delay(100);

    // Initialize display
    _display.init();
    _display.setRotation(0);      // Portrait mode
    _display.setBrightness(255);  // Max brightness

    // Test pattern to verify display works
    _display.fillScreen(0xF800);  // RED
    delay(500);
    _display.fillScreen(0x07E0);  // GREEN
    delay(500);
    _display.fillScreen(0x001F);  // BLUE
    delay(500);

    _display.fillScreen(COLOR_BACKGROUND);
    _display.setTextColor(COLOR_TEXT);

    // Initialize buttons
    pinMode(BUTTON_1_PIN, INPUT_PULLUP);
    pinMode(BUTTON_2_PIN, INPUT_PULLUP);

    return true;
}

void LilyGoDisplay::showConnecting() {
    _display.fillScreen(COLOR_BACKGROUND);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Connecting...", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 20);

    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Boardsesh Queue", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 + 20);

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::showError(const char* message, const char* ipAddress) {
    _display.fillScreen(COLOR_BACKGROUND);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_STATUS_ERROR);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Error", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 30);

    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString(message, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 + 10);

    // Show IP if provided
    if (ipAddress && strlen(ipAddress) > 0) {
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setFont(&fonts::Font0);
        _display.drawString(ipAddress, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 + 50);
    }

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::showConfigPortal(const char* apName, const char* ip) {
    _display.fillScreen(COLOR_BACKGROUND);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("WiFi Setup", SCREEN_WIDTH / 2, 20);

    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("Connect to WiFi:", SCREEN_WIDTH / 2, 60);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_STATUS_OK);
    _display.drawString(apName, SCREEN_WIDTH / 2, 90);

    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("Then open browser:", SCREEN_WIDTH / 2, 140);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.drawString(ip, SCREEN_WIDTH / 2, 170);

    _display.setFont(&fonts::Font0);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Enter your WiFi", SCREEN_WIDTH / 2, 220);
    _display.drawString("credentials to continue", SCREEN_WIDTH / 2, 235);

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::showSetupScreen(const char* apName) {
    _display.fillScreen(COLOR_BACKGROUND);

    // Header
    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("WiFi Setup", SCREEN_WIDTH / 2, 8);

    // Step 1: Scan QR to join WiFi
    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("1. Scan QR to join WiFi", SCREEN_WIDTH / 2, 38);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_STATUS_OK);
    _display.drawString(apName, SCREEN_WIDTH / 2, 58);

    // QR Code section - generate WiFi join QR code
    char wifiQr[80];
    snprintf(wifiQr, sizeof(wifiQr), "WIFI:T:nopass;S:%s;;;", apName);
    QRCode qrCode;
    qrcode_initText(&qrCode, _qrCodeData, QR_VERSION, ECC_LOW, wifiQr);

    // Calculate QR code size and position
    int qrSize = qrCode.size;
    int pixelSize = 100 / qrSize;  // Target ~100px QR code
    if (pixelSize < 1) pixelSize = 1;

    int actualQrSize = pixelSize * qrSize;
    int qrX = (SCREEN_WIDTH - actualQrSize) / 2;
    int qrY = 90;

    // Draw white background for QR code
    _display.fillRect(qrX - 4, qrY - 4, actualQrSize + 8, actualQrSize + 8, COLOR_QR_BG);

    // Draw QR code modules
    for (uint8_t y = 0; y < qrSize; y++) {
        for (uint8_t x = 0; x < qrSize; x++) {
            if (qrcode_getModule(&qrCode, x, y)) {
                _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize, pixelSize, pixelSize, COLOR_QR_FG);
            }
        }
    }

    // Step 2: Open browser
    int instructionY = qrY + actualQrSize + 16;

    _display.setFont(&fonts::Font2);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("2. Open browser:", SCREEN_WIDTH / 2, instructionY);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.drawString("192.168.4.1", SCREEN_WIDTH / 2, instructionY + 22);

    _display.setFont(&fonts::Font0);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("to configure settings", SCREEN_WIDTH / 2, instructionY + 50);

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::onStatusChanged() {
    drawStatusBar();
}

void LilyGoDisplay::refresh() {
    drawStatusBar();
    drawCurrentClimb();
    drawQRCode();
    drawNextClimbIndicator();
    drawHistory();
    drawButtonHints();
}

void LilyGoDisplay::drawStatusBar() {
    // Clear status bar area
    _display.fillRect(0, STATUS_BAR_Y, SCREEN_WIDTH, STATUS_BAR_HEIGHT, COLOR_BACKGROUND);

    // WiFi indicator
    _display.setTextSize(1);
    _display.setFont(&fonts::Font0);
    _display.setCursor(4, STATUS_BAR_Y + 6);
    _display.setTextColor(_wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WiFi");

    // Draw status dot
    _display.fillCircle(35, STATUS_BAR_Y + 10, 4, _wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // Backend indicator
    _display.setCursor(55, STATUS_BAR_Y + 6);
    _display.setTextColor(_backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WS");
    _display.fillCircle(75, STATUS_BAR_Y + 10, 4, _backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // BLE indicator (if enabled)
    if (_bleEnabled) {
        _display.setCursor(95, STATUS_BAR_Y + 6);
        _display.setTextColor(_bleConnected ? COLOR_STATUS_OK : COLOR_TEXT_DIM);
        _display.print("BLE");
        _display.fillCircle(120, STATUS_BAR_Y + 10, 4, _bleConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);
    }

    // Angle display (right side)
    if (_hasClimb && _angle > 0) {
        _display.setTextColor(COLOR_TEXT);
        _display.setCursor(SCREEN_WIDTH - 35, STATUS_BAR_Y + 6);
        _display.printf("%d", _angle);
        _display.drawCircle(SCREEN_WIDTH - 8, STATUS_BAR_Y + 7, 2, COLOR_TEXT);  // Degree symbol
    }
}

void LilyGoDisplay::drawCurrentClimb() {
    int yStart = CURRENT_CLIMB_Y;

    // Clear current climb area
    _display.fillRect(0, yStart, SCREEN_WIDTH, CURRENT_CLIMB_HEIGHT, COLOR_BACKGROUND);

    if (!_hasClimb) {
        // Show "waiting for climb" message
        _display.setFont(&fonts::Font2);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Waiting for climb...", SCREEN_WIDTH / 2, yStart + CURRENT_CLIMB_HEIGHT / 2);
        _display.setTextDatum(lgfx::top_left);
        return;
    }

    // Draw climb name (may need to truncate)
    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::top_center);

    String displayName = _climbName;
    if (displayName.length() > 18) {
        displayName = displayName.substring(0, 15) + "...";
    }
    _display.drawString(displayName.c_str(), SCREEN_WIDTH / 2, CLIMB_NAME_Y);

    // Draw grade badge or "Project" for ungraded climbs
    if (_grade.length() > 0) {
        // Calculate badge dimensions
        int badgeWidth = 80;
        int badgeHeight = 36;
        int badgeX = (SCREEN_WIDTH - badgeWidth) / 2;
        int badgeY = GRADE_Y;

        // Get grade color - calculate from grade string using same logic as frontend
        uint16_t gradeColor565 = getGradeColor(_grade.c_str());

        // Draw rounded rectangle badge
        _display.fillRoundRect(badgeX, badgeY, badgeWidth, badgeHeight, 8, gradeColor565);

        // Draw grade text (determine text color based on background brightness)
        uint16_t textColor = getGradeTextColor(gradeColor565);

        _display.setFont(&fonts::FreeSansBold12pt7b);
        _display.setTextColor(textColor);
        _display.setTextDatum(lgfx::middle_center);

        // Extract just the V-grade for display if combined format
        String displayGrade = _grade;
        int slashPos = displayGrade.indexOf('/');
        if (slashPos > 0) {
            displayGrade = displayGrade.substring(slashPos + 1);
        }

        _display.drawString(displayGrade.c_str(), badgeX + badgeWidth / 2, badgeY + badgeHeight / 2);
    } else {
        // No grade - show "Project" in italic
        _display.setFont(&fonts::FreeSansOblique12pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Project", SCREEN_WIDTH / 2, GRADE_Y + 18);
    }

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::drawQRCode() {
    int yStart = QR_SECTION_Y;

    // Clear QR code area
    _display.fillRect(0, yStart, SCREEN_WIDTH, QR_SECTION_HEIGHT, COLOR_BACKGROUND);

    if (!_hasClimb || !_hasQRCode || _sessionId.length() == 0) {
        return;
    }

    // Generate QR code from stored URL
    QRCode qrCode;
    qrcode_initText(&qrCode, _qrCodeData, QR_VERSION, ECC_LOW, _qrUrl.c_str());

    // Calculate scale factor for QR code
    int qrSize = qrCode.size;
    int pixelSize = QR_CODE_SIZE / qrSize;
    if (pixelSize < 1)
        pixelSize = 1;

    int actualQrSize = pixelSize * qrSize;
    int qrX = (SCREEN_WIDTH - actualQrSize) / 2;
    // Center QR code vertically in the section
    int qrY = yStart + (QR_SECTION_HEIGHT - actualQrSize) / 2;

    // Draw white background for QR code
    _display.fillRect(qrX - 4, qrY - 4, actualQrSize + 8, actualQrSize + 8, COLOR_QR_BG);

    // Draw QR code modules
    for (uint8_t y = 0; y < qrSize; y++) {
        for (uint8_t x = 0; x < qrSize; x++) {
            if (qrcode_getModule(&qrCode, x, y)) {
                _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize, pixelSize, pixelSize, COLOR_QR_FG);
            }
        }
    }
}

void LilyGoDisplay::drawNextClimbIndicator() {
    // Clear next indicator area
    _display.fillRect(0, NEXT_INDICATOR_Y, SCREEN_WIDTH, NEXT_INDICATOR_HEIGHT, COLOR_BACKGROUND);

    // Only draw if we have navigation and a next climb
    if (!_hasNavigation || !_nextClimb.isValid) {
        return;
    }

    _display.setFont(&fonts::Font0);
    _display.setTextDatum(lgfx::middle_left);

    // Draw right arrow
    _display.setTextColor(COLOR_ACCENT);
    _display.drawString(">", 4, NEXT_INDICATOR_Y + NEXT_INDICATOR_HEIGHT / 2);

    // Draw "Next:" label
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Next:", 14, NEXT_INDICATOR_Y + NEXT_INDICATOR_HEIGHT / 2);

    // Truncate name if needed
    String name = _nextClimb.name;
    if (name.length() > 10) {
        name = name.substring(0, 8) + "..";
    }

    // Draw climb name
    _display.setTextColor(COLOR_TEXT);
    _display.drawString(name.c_str(), 50, NEXT_INDICATOR_Y + NEXT_INDICATOR_HEIGHT / 2);

    // Draw grade with color
    uint16_t gradeColor = COLOR_TEXT;
    if (_nextClimb.gradeColor.length() > 0) {
        gradeColor = hexToRgb565(_nextClimb.gradeColor.c_str());
    } else if (_nextClimb.grade.length() > 0) {
        gradeColor = getGradeColor(_nextClimb.grade.c_str());
    }

    // Extract V-grade for display
    String grade = _nextClimb.grade;
    int slashPos = grade.indexOf('/');
    if (slashPos > 0) {
        grade = grade.substring(slashPos + 1);
    }

    _display.setTextDatum(lgfx::middle_right);
    _display.setTextColor(gradeColor);
    _display.drawString(grade.c_str(), SCREEN_WIDTH - 4, NEXT_INDICATOR_Y + NEXT_INDICATOR_HEIGHT / 2);

    _display.setTextDatum(lgfx::top_left);
}

void LilyGoDisplay::drawHistory() {
    int yStart = HISTORY_Y;

    // Clear history area
    _display.fillRect(0, yStart, SCREEN_WIDTH, HISTORY_HEIGHT, COLOR_BACKGROUND);

    if (_history.empty()) {
        return;
    }

    // Draw "Previous:" label
    _display.setFont(&fonts::Font0);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.setCursor(4, yStart);
    _display.print("Previous:");

    // Draw history items
    int y = yStart + 12;
    int itemsToShow = min((int)_history.size(), HISTORY_MAX_ITEMS);

    for (int i = 0; i < itemsToShow; i++) {
        const ClimbHistoryEntry& entry = _history[_history.size() - 1 - i];

        // Draw bullet with grade color (calculated from grade string)
        uint16_t bulletColor = COLOR_TEXT_DIM;
        if (entry.grade.length() > 0) {
            bulletColor = getGradeColor(entry.grade.c_str());
        }
        _display.fillCircle(8, y + 6, 3, bulletColor);

        // Draw climb name (truncated)
        String name = entry.name;
        if (name.length() > 12) {
            name = name.substring(0, 10) + "..";
        }

        _display.setTextColor(COLOR_TEXT);
        _display.setCursor(16, y + 2);
        _display.print(name.c_str());

        // Draw grade
        _display.setTextColor(bulletColor);
        _display.setCursor(SCREEN_WIDTH - 35, y + 2);

        String grade = entry.grade;
        int slashPos = grade.indexOf('/');
        if (slashPos > 0) {
            grade = grade.substring(slashPos + 1);
        }
        _display.print(grade.c_str());

        y += HISTORY_ITEM_HEIGHT;
    }
}

void LilyGoDisplay::drawButtonHints() {
    // Clear button hint area
    _display.fillRect(0, BUTTON_HINT_Y, SCREEN_WIDTH, BUTTON_HINT_HEIGHT, COLOR_BACKGROUND);

    // Only show hints if we have navigation
    if (!_hasNavigation || _queueTotal <= 1) {
        return;
    }

    _display.setFont(&fonts::Font0);
    _display.setTextDatum(lgfx::middle_center);

    // Draw hint bar background
    _display.fillRect(0, BUTTON_HINT_Y, SCREEN_WIDTH, BUTTON_HINT_HEIGHT, 0x2104);  // Very dark gray

    // Show position indicator in center
    _display.setTextColor(COLOR_TEXT_DIM);
    char posStr[16];
    snprintf(posStr, sizeof(posStr), "%d/%d", _queueIndex + 1, _queueTotal);
    _display.drawString(posStr, SCREEN_WIDTH / 2, BUTTON_HINT_Y + BUTTON_HINT_HEIGHT / 2);

    // Draw left button hint (if there's a previous climb)
    if (_prevClimb.isValid) {
        _display.setTextColor(COLOR_ACCENT);
        _display.setTextDatum(lgfx::middle_left);
        _display.drawString("<Prev", 4, BUTTON_HINT_Y + BUTTON_HINT_HEIGHT / 2);
    }

    // Draw right button hint (if there's a next climb)
    if (_nextClimb.isValid) {
        _display.setTextColor(COLOR_ACCENT);
        _display.setTextDatum(lgfx::middle_right);
        _display.drawString("Next>", SCREEN_WIDTH - 4, BUTTON_HINT_Y + BUTTON_HINT_HEIGHT / 2);
    }

    _display.setTextDatum(lgfx::top_left);
}
