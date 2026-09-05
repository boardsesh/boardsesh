// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "waveshare_display.h"

#include <config_manager.h>
#include <grade_colors.h>

#include <qrcode.h>

// Global display instance
WaveshareDisplay Display;

// ============================================
// LGFX_Waveshare7 Implementation (RGB bus with bounce buffers)
// ============================================

LGFX_Waveshare7::LGFX_Waveshare7() {
    // Panel configuration (must be set before bus)
    {
        auto cfg = _panel_instance.config();
        cfg.memory_width  = WS_SCREEN_WIDTH_NATIVE;
        cfg.memory_height = WS_SCREEN_HEIGHT_NATIVE;
        cfg.panel_width   = WS_SCREEN_WIDTH_NATIVE;
        cfg.panel_height  = WS_SCREEN_HEIGHT_NATIVE;
        cfg.offset_x = 0;
        cfg.offset_y = 0;

        _panel_instance.config(cfg);
    }

    // RGB Bus configuration
    {
        auto cfg = _bus_instance.config();
        cfg.panel = &_panel_instance;

        cfg.freq_write = 16000000;  // 16MHz pixel clock

        // Blue channel (5 bits) - pin_d0..d4
        cfg.pin_d0  = WS_LCD_B0;   // GPIO 14
        cfg.pin_d1  = WS_LCD_B1;   // GPIO 38
        cfg.pin_d2  = WS_LCD_B2;   // GPIO 18
        cfg.pin_d3  = WS_LCD_B3;   // GPIO 17
        cfg.pin_d4  = WS_LCD_B4;   // GPIO 10

        // Green channel (6 bits) - pin_d5..d10
        cfg.pin_d5  = WS_LCD_G0;   // GPIO 39
        cfg.pin_d6  = WS_LCD_G1;   // GPIO 0
        cfg.pin_d7  = WS_LCD_G2;   // GPIO 45
        cfg.pin_d8  = WS_LCD_G3;   // GPIO 48
        cfg.pin_d9  = WS_LCD_G4;   // GPIO 47
        cfg.pin_d10 = WS_LCD_G5;   // GPIO 21

        // Red channel (5 bits) - pin_d11..d15
        cfg.pin_d11 = WS_LCD_R0;   // GPIO 1
        cfg.pin_d12 = WS_LCD_R1;   // GPIO 2
        cfg.pin_d13 = WS_LCD_R2;   // GPIO 42
        cfg.pin_d14 = WS_LCD_R3;   // GPIO 41
        cfg.pin_d15 = WS_LCD_R4;   // GPIO 40

        // Control signals
        cfg.pin_henable = WS_LCD_DE;     // GPIO 5
        cfg.pin_vsync   = WS_LCD_VSYNC;  // GPIO 3
        cfg.pin_hsync   = WS_LCD_HSYNC;  // GPIO 46
        cfg.pin_pclk    = WS_LCD_PCLK;   // GPIO 7

        // Sync timing
        cfg.hsync_polarity    = 0;
        cfg.hsync_front_porch = 8;
        cfg.hsync_pulse_width = 4;
        cfg.hsync_back_porch  = 8;
        cfg.vsync_polarity    = 0;
        cfg.vsync_front_porch = 8;
        cfg.vsync_pulse_width = 4;
        cfg.vsync_back_porch  = 8;
        cfg.pclk_active_neg   = 1;
        cfg.de_idle_high      = 0;
        cfg.pclk_idle_high    = 0;

        _bus_instance.config(cfg);
    }

    _panel_instance.setBus(&_bus_instance);

    // Touch configuration (GT911)
    {
        auto cfg = _touch_instance.config();
        cfg.x_min      = 0;
        cfg.x_max      = WS_SCREEN_WIDTH_NATIVE - 1;
        cfg.y_min      = 0;
        cfg.y_max      = WS_SCREEN_HEIGHT_NATIVE - 1;
        cfg.pin_int    = WS_TOUCH_INT;
        cfg.pin_rst    = WS_TOUCH_RST;
        cfg.bus_shared = true;   // I2C bus shared with CH422G (already initialized)
        cfg.offset_rotation = 0;

        cfg.i2c_port   = 0;     // Same I2C port as CH422G (shared bus, different addresses)
        cfg.i2c_addr   = 0x14;  // GT911 default address
        cfg.pin_sda    = WS_TOUCH_SDA;
        cfg.pin_scl    = WS_TOUCH_SCL;
        cfg.freq       = 400000;

        _touch_instance.config(cfg);
        _panel_instance.setTouch(&_touch_instance);
    }

    setPanel(&_panel_instance);
}

// ============================================
// WaveshareDisplay Implementation
// ============================================

WaveshareDisplay::WaveshareDisplay() : _lastTouchTime(0) {}

WaveshareDisplay::~WaveshareDisplay() {
#ifdef ENABLE_BOARD_IMAGE
    if (_boardImageSprite) {
        _boardImageSprite->deleteSprite();
        delete _boardImageSprite;
        _boardImageSprite = nullptr;
    }
#endif
}

bool WaveshareDisplay::begin() {
    // 1. Initialize I2C for CH422G IO expander
    Wire.begin(WS_I2C_SDA, WS_I2C_SCL);

    // 2. Initialize IO expander (sets all IO pins HIGH initially)
    _ioExpander.begin(Wire);

    // 3. Reset LCD panel via IO expander (pin 3)
    _ioExpander.resetLCD();

    // 4. Reset touch panel via IO expander (pin 1)
    _ioExpander.resetTouch();

    // 5. Backlight off during init
    _ioExpander.setBacklight(false);
    delay(100);

    // 6. Initialize LovyanGFX display
    _display.init();

    // Read display mode from config
    _displayMode = static_cast<WsDisplayMode>(Config.getInt("disp_mode", 0));
    if (_displayMode == WsDisplayMode::LANDSCAPE) {
        _display.setRotation(0);  // Landscape mode (800x480)
    } else {
        _display.setRotation(1);  // Portrait mode (480x800)
    }

    // 7. Enable backlight
    _ioExpander.setBacklight(true);

    // 8. Test pattern to verify display works
    _display.fillScreen(0xF800);  // RED
    delay(300);
    _display.fillScreen(0x07E0);  // GREEN
    delay(300);
    _display.fillScreen(0x001F);  // BLUE
    delay(300);

    _display.fillScreen(COLOR_BACKGROUND);
    _display.setTextColor(COLOR_TEXT);

    return true;
}

void WaveshareDisplay::showConnecting() {
    _display.fillScreen(COLOR_BACKGROUND);

    int sw = screenWidth();
    int sh = screenHeight();

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Connecting...", sw / 2, sh / 2 - 50);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Boardsesh Queue", sw / 2, sh / 2 + 50);

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::showError(const char* message, const char* ipAddress) {
    _display.fillScreen(COLOR_BACKGROUND);

    int sw = screenWidth();
    int sh = screenHeight();

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_STATUS_ERROR);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Error", sw / 2, sh / 2 - 80);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString(message, sw / 2, sh / 2 + 20);

    if (ipAddress && strlen(ipAddress) > 0) {
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setFont(&fonts::FreeSansBold9pt7b);
        _display.drawString(ipAddress, sw / 2, sh / 2 + 120);
    }

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::showConfigPortal(const char* apName, const char* ip) {
    _display.fillScreen(COLOR_BACKGROUND);

    int sw = screenWidth();

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("WiFi Setup", sw / 2, 40);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("Connect to WiFi:", sw / 2, 140);

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_STATUS_OK);
    _display.drawString(apName, sw / 2, 200);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("Then open browser:", sw / 2, 340);

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.drawString(ip, sw / 2, 400);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Enter your WiFi credentials to continue", sw / 2, _displayMode == WsDisplayMode::LANDSCAPE ? 450 : 520);

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::showSetupScreen(const char* apName) {
    _display.fillScreen(COLOR_BACKGROUND);

    int sw = screenWidth();
    bool isLandscape = (_displayMode == WsDisplayMode::LANDSCAPE);

    // Header
    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("WiFi Setup", sw / 2, 20);

    // Step 1: Scan QR to join WiFi
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString("1. Scan QR to join WiFi", sw / 2, isLandscape ? 70 : 90);

    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_STATUS_OK);
    _display.drawString(apName, sw / 2, isLandscape ? 110 : 140);

    // QR Code section - generate WiFi join QR code
    char wifiQr[80];
    snprintf(wifiQr, sizeof(wifiQr), "WIFI:T:nopass;S:%s;;;", apName);
    QRCode qrCode;
    qrcode_initText(&qrCode, _qrCodeData, QR_VERSION, ECC_LOW, wifiQr);

    int qrSize = qrCode.size;
    int targetQrPx = isLandscape ? 180 : 250;
    int pixelSize = targetQrPx / qrSize;
    if (pixelSize < 1) pixelSize = 1;

    int actualQrSize = pixelSize * qrSize;
    int qrY = isLandscape ? 160 : 220;

    if (isLandscape) {
        // Landscape: QR on left, instructions on right
        int qrX = sw / 4 - actualQrSize / 2;
        _display.fillRect(qrX - 8, qrY - 8, actualQrSize + 16, actualQrSize + 16, COLOR_QR_BG);
        for (uint8_t y = 0; y < qrSize; y++) {
            for (uint8_t x = 0; x < qrSize; x++) {
                if (qrcode_getModule(&qrCode, x, y)) {
                    _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize, pixelSize, pixelSize, COLOR_QR_FG);
                }
            }
        }

        int instrX = sw * 3 / 4;
        _display.setFont(&fonts::FreeSansBold18pt7b);
        _display.setTextColor(COLOR_TEXT);
        _display.drawString("2. Open browser:", instrX, qrY + 20);
        _display.setFont(&fonts::FreeSansBold24pt7b);
        _display.setTextColor(COLOR_ACCENT);
        _display.drawString("192.168.4.1", instrX, qrY + 70);
        _display.setFont(&fonts::FreeSansBold9pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.drawString("to configure settings", instrX, qrY + 130);
    } else {
        // Portrait: QR centered, instructions below
        int qrX = (sw - actualQrSize) / 2;
        _display.fillRect(qrX - 8, qrY - 8, actualQrSize + 16, actualQrSize + 16, COLOR_QR_BG);
        for (uint8_t y = 0; y < qrSize; y++) {
            for (uint8_t x = 0; x < qrSize; x++) {
                if (qrcode_getModule(&qrCode, x, y)) {
                    _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize, pixelSize, pixelSize, COLOR_QR_FG);
                }
            }
        }

        int instructionY = qrY + actualQrSize + 30;
        _display.setFont(&fonts::FreeSansBold18pt7b);
        _display.setTextColor(COLOR_TEXT);
        _display.drawString("2. Open browser:", sw / 2, instructionY);
        _display.setFont(&fonts::FreeSansBold24pt7b);
        _display.setTextColor(COLOR_ACCENT);
        _display.drawString("192.168.4.1", sw / 2, instructionY + 60);
        _display.setFont(&fonts::FreeSansBold9pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.drawString("to configure settings", sw / 2, instructionY + 120);
    }

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::onStatusChanged() {
    if (_settingsScreenActive) return;
    if (_displayMode == WsDisplayMode::LANDSCAPE) {
        drawLandscapeStatusBar();
    } else {
        drawStatusBar();
    }
}

void WaveshareDisplay::refresh() {
    if (_settingsScreenActive) return;

    if (_displayMode == WsDisplayMode::LANDSCAPE) {
        drawLandscapeStatusBar();
        drawLandscapeBoardPanel();
        drawLandscapeQueuePanel();
        return;
    }

    // Portrait mode (unchanged)
    drawStatusBar();

#ifdef ENABLE_BOARD_IMAGE
    if (_hasBoardImage && _currentBoardConfig) {
        // Clear margins around the board image instead of full fillScreen
        int offsetX = (SCREEN_WIDTH - _currentBoardConfig->imageWidth) / 2;
        if (offsetX > 0) {
            _display.fillRect(0, WS_BOARD_IMAGE_Y, offsetX, _currentBoardConfig->imageHeight, COLOR_BACKGROUND);
            _display.fillRect(offsetX + _currentBoardConfig->imageWidth, WS_BOARD_IMAGE_Y, offsetX, _currentBoardConfig->imageHeight, COLOR_BACKGROUND);
        }
        drawBoardImageWithHolds();
        drawClimbInfoCompact();
    } else {
        _display.fillScreen(COLOR_BACKGROUND);
        drawStatusBar();
        drawCurrentClimb();
        drawQRCode();
        drawNextClimbIndicator();
        drawHistory();
    }
#else
    _display.fillScreen(COLOR_BACKGROUND);
    drawStatusBar();
    drawCurrentClimb();
    drawQRCode();
    drawNextClimbIndicator();
    drawHistory();
#endif

    drawNavButtons();
}

void WaveshareDisplay::refreshInfoOnly() {
    if (_settingsScreenActive) return;

    if (_displayMode == WsDisplayMode::LANDSCAPE) {
        drawLandscapeStatusBar();
        drawLandscapeClimbInfo();
        drawLandscapeQueuePanel();
        return;
    }

    // Portrait mode (unchanged)
    drawStatusBar();
#ifdef ENABLE_BOARD_IMAGE
    if (_hasBoardImage && _currentBoardConfig) {
        drawClimbInfoCompact();
    } else {
        drawCurrentClimb();
    }
#else
    drawCurrentClimb();
#endif
    drawNavButtons();
}

// ============================================
// Drawing Methods (480x800 layout)
// ============================================

void WaveshareDisplay::drawStatusBar() {
    _display.fillRect(0, WS_STATUS_BAR_Y, SCREEN_WIDTH, WS_STATUS_BAR_HEIGHT, COLOR_BACKGROUND);

    _display.setTextSize(1);
    _display.setFont(&fonts::FreeSansBold9pt7b);

    // WiFi indicator
    _display.setCursor(10, WS_STATUS_BAR_Y + 18);
    _display.setTextColor(_wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WiFi");
    _display.fillCircle(80, WS_STATUS_BAR_Y + 25, 8, _wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // Backend indicator
    _display.setCursor(110, WS_STATUS_BAR_Y + 18);
    _display.setTextColor(_backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WS");
    _display.fillCircle(160, WS_STATUS_BAR_Y + 25, 8, _backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // BLE indicator (if enabled)
    if (_bleEnabled) {
        _display.setCursor(190, WS_STATUS_BAR_Y + 18);
        _display.setTextColor(_bleConnected ? COLOR_STATUS_OK : COLOR_TEXT_DIM);
        _display.print("BLE");
        _display.fillCircle(240, WS_STATUS_BAR_Y + 25, 8, _bleConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);
    }

    // Angle display (shifted left to make room for gear icon)
    if (_hasClimb && _angle > 0) {
        _display.setTextColor(COLOR_TEXT);
        _display.setCursor(SCREEN_WIDTH - 130, WS_STATUS_BAR_Y + 18);
        _display.printf("%d", _angle);
        _display.drawCircle(SCREEN_WIDTH - 70, WS_STATUS_BAR_Y + 18, 4, COLOR_TEXT);  // Degree symbol
    }

    // Settings gear icon (top-right)
    int gearCx = WS_SETTINGS_BUTTON_X + WS_SETTINGS_BUTTON_W / 2;
    int gearCy = WS_STATUS_BAR_Y + WS_SETTINGS_BUTTON_H / 2;
    int gearR = 12;
    _display.drawCircle(gearCx, gearCy, gearR, COLOR_TEXT_DIM);
    _display.drawCircle(gearCx, gearCy, 5, COLOR_TEXT_DIM);
    // Draw gear teeth (4 ticks at N/S/E/W)
    _display.drawFastHLine(gearCx - gearR - 4, gearCy, 8, COLOR_TEXT_DIM);
    _display.drawFastHLine(gearCx + gearR - 4, gearCy, 8, COLOR_TEXT_DIM);
    _display.drawFastVLine(gearCx, gearCy - gearR - 4, 8, COLOR_TEXT_DIM);
    _display.drawFastVLine(gearCx, gearCy + gearR - 4, 8, COLOR_TEXT_DIM);
    // Diagonal teeth
    int d = (gearR * 707) / 1000;  // cos(45) * R
    _display.fillRect(gearCx + d - 2, gearCy - d - 2, 5, 5, COLOR_TEXT_DIM);
    _display.fillRect(gearCx - d - 2, gearCy - d - 2, 5, 5, COLOR_TEXT_DIM);
    _display.fillRect(gearCx + d - 2, gearCy + d - 2, 5, 5, COLOR_TEXT_DIM);
    _display.fillRect(gearCx - d - 2, gearCy + d - 2, 5, 5, COLOR_TEXT_DIM);
}

void WaveshareDisplay::drawCurrentClimb() {
    int yStart = WS_CURRENT_CLIMB_Y;

    _display.fillRect(0, yStart, SCREEN_WIDTH, WS_CURRENT_CLIMB_HEIGHT, COLOR_BACKGROUND);

    if (!_hasClimb) {
        _display.setFont(&fonts::FreeSansBold18pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Waiting for climb...", SCREEN_WIDTH / 2, yStart + WS_CURRENT_CLIMB_HEIGHT / 2);
        _display.setTextDatum(lgfx::top_left);
        return;
    }

    // Draw climb name
    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::top_center);

    String displayName = _climbName;
    if (displayName.length() > 25) {
        displayName = displayName.substring(0, 22) + "...";
    }
    _display.drawString(displayName.c_str(), SCREEN_WIDTH / 2, WS_CLIMB_NAME_Y);

    // Draw grade badge or "Project" for ungraded climbs
    if (_grade.length() > 0) {
        int badgeWidth = 200;
        int badgeHeight = 90;
        int badgeX = (SCREEN_WIDTH - badgeWidth) / 2;
        int badgeY = WS_GRADE_Y;

        uint16_t gradeColor565 = getGradeColor(_grade.c_str());

        _display.fillRoundRect(badgeX, badgeY, badgeWidth, badgeHeight, 16, gradeColor565);

        uint16_t textColor = getGradeTextColor(gradeColor565);

        _display.setFont(&fonts::FreeSansBold24pt7b);
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
        _display.setFont(&fonts::FreeSansOblique24pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Project", SCREEN_WIDTH / 2, WS_GRADE_Y + 45);
    }

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::drawQRCode() {
    int yStart = WS_QR_SECTION_Y;

    _display.fillRect(0, yStart, SCREEN_WIDTH, WS_QR_SECTION_HEIGHT, COLOR_BACKGROUND);

    if (!_hasClimb || !_hasQRCode || _sessionId.length() == 0) {
        return;
    }

    QRCode qrCode;
    qrcode_initText(&qrCode, _qrCodeData, QR_VERSION, ECC_LOW, _qrUrl.c_str());

    int qrSize = qrCode.size;
    int pixelSize = WS_QR_CODE_SIZE / qrSize;
    if (pixelSize < 1) pixelSize = 1;

    int actualQrSize = pixelSize * qrSize;
    int qrX = (SCREEN_WIDTH - actualQrSize) / 2;
    int qrY = yStart + (WS_QR_SECTION_HEIGHT - actualQrSize) / 2;

    // Draw white background for QR code
    _display.fillRect(qrX - 8, qrY - 8, actualQrSize + 16, actualQrSize + 16, COLOR_QR_BG);

    // Draw QR code modules
    for (uint8_t y = 0; y < qrSize; y++) {
        for (uint8_t x = 0; x < qrSize; x++) {
            if (qrcode_getModule(&qrCode, x, y)) {
                _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize, pixelSize, pixelSize, COLOR_QR_FG);
            }
        }
    }
}

void WaveshareDisplay::drawNextClimbIndicator() {
    _display.fillRect(0, WS_NEXT_INDICATOR_Y, SCREEN_WIDTH, WS_NEXT_INDICATOR_HEIGHT, COLOR_BACKGROUND);

    if (!_hasNavigation || !_nextClimb.isValid) {
        return;
    }

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextDatum(lgfx::middle_left);

    // Draw right arrow
    _display.setTextColor(COLOR_ACCENT);
    _display.drawString(">", 10, WS_NEXT_INDICATOR_Y + WS_NEXT_INDICATOR_HEIGHT / 2);

    // Draw "Next:" label
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("Next:", 30, WS_NEXT_INDICATOR_Y + WS_NEXT_INDICATOR_HEIGHT / 2);

    // Truncate name if needed
    String name = _nextClimb.name;
    if (name.length() > 20) {
        name = name.substring(0, 17) + "...";
    }

    _display.setTextColor(COLOR_TEXT);
    _display.drawString(name.c_str(), 100, WS_NEXT_INDICATOR_Y + WS_NEXT_INDICATOR_HEIGHT / 2);

    // Draw grade with color
    uint16_t gradeColor = COLOR_TEXT;
    if (_nextClimb.gradeColor.length() > 0) {
        gradeColor = hexToRgb565(_nextClimb.gradeColor.c_str());
    } else if (_nextClimb.grade.length() > 0) {
        gradeColor = getGradeColor(_nextClimb.grade.c_str());
    }

    String grade = _nextClimb.grade;
    int slashPos = grade.indexOf('/');
    if (slashPos > 0) {
        grade = grade.substring(slashPos + 1);
    }

    _display.setTextDatum(lgfx::middle_right);
    _display.setTextColor(gradeColor);
    _display.drawString(grade.c_str(), SCREEN_WIDTH - 10, WS_NEXT_INDICATOR_Y + WS_NEXT_INDICATOR_HEIGHT / 2);

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::drawHistory() {
    int yStart = WS_HISTORY_Y;

    _display.fillRect(0, yStart, SCREEN_WIDTH, WS_HISTORY_HEIGHT, COLOR_BACKGROUND);

    if (_history.empty()) {
        return;
    }

    // Draw "Previous:" label
    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.setCursor(10, yStart + 5);
    _display.print("Previous:");

    // Draw history items
    int y = yStart + WS_HISTORY_LABEL_HEIGHT;
    int itemsToShow = min((int)_history.size(), WS_HISTORY_MAX_ITEMS);

    for (int i = 0; i < itemsToShow; i++) {
        const ClimbHistoryEntry& entry = _history[_history.size() - 1 - i];

        uint16_t bulletColor = COLOR_TEXT_DIM;
        if (entry.grade.length() > 0) {
            bulletColor = getGradeColor(entry.grade.c_str());
        }
        _display.fillCircle(20, y + 14, 6, bulletColor);

        // Draw climb name (truncated)
        String name = entry.name;
        if (name.length() > 25) {
            name = name.substring(0, 22) + "...";
        }

        _display.setTextColor(COLOR_TEXT);
        _display.setCursor(38, y + 6);
        _display.print(name.c_str());

        // Draw grade
        _display.setTextColor(bulletColor);
        _display.setCursor(SCREEN_WIDTH - 80, y + 6);

        String grade = entry.grade;
        int slashPos = grade.indexOf('/');
        if (slashPos > 0) {
            grade = grade.substring(slashPos + 1);
        }
        _display.print(grade.c_str());

        y += WS_HISTORY_ITEM_HEIGHT;
    }
}

void WaveshareDisplay::drawNavButtons() {
    _display.fillRect(0, WS_NAV_BUTTON_Y, SCREEN_WIDTH, WS_NAV_BUTTON_HEIGHT, COLOR_BACKGROUND);

    if (!_hasNavigation || _queueTotal <= 1) {
        return;
    }

    // Draw button bar background
    _display.fillRect(0, WS_NAV_BUTTON_Y, SCREEN_WIDTH, WS_NAV_BUTTON_HEIGHT, 0x2104);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextDatum(lgfx::middle_center);

    // Show position indicator in center
    _display.setTextColor(COLOR_TEXT_DIM);
    char posStr[16];
    snprintf(posStr, sizeof(posStr), "%d / %d", _queueIndex + 1, _queueTotal);
    _display.drawString(posStr, SCREEN_WIDTH / 2, WS_NAV_BUTTON_Y + WS_NAV_BUTTON_HEIGHT / 2);

    // Draw Previous button (left side)
    if (_prevClimb.isValid) {
        _display.fillRoundRect(10, WS_NAV_BUTTON_Y + 5, 140, WS_NAV_BUTTON_HEIGHT - 10, 8, COLOR_ACCENT);
        _display.setTextColor(0x0000);  // Black text on cyan
        _display.drawString("< Prev", 80, WS_NAV_BUTTON_Y + WS_NAV_BUTTON_HEIGHT / 2);
    }

    // Draw Next button (right side)
    if (_nextClimb.isValid) {
        _display.fillRoundRect(SCREEN_WIDTH - 150, WS_NAV_BUTTON_Y + 5, 140, WS_NAV_BUTTON_HEIGHT - 10, 8,
                               COLOR_ACCENT);
        _display.setTextColor(0x0000);  // Black text on cyan
        _display.drawString("Next >", SCREEN_WIDTH - 80, WS_NAV_BUTTON_Y + WS_NAV_BUTTON_HEIGHT / 2);
    }

    _display.setTextDatum(lgfx::top_left);
}

// ============================================
// Board Image Rendering (v2 layout)
// ============================================

#ifdef ENABLE_BOARD_IMAGE
void WaveshareDisplay::setBoardConfig(const BoardConfig* config) {
    if (_currentBoardConfig != config) {
        // Invalidate cached sprite when board config changes
        _cachedBoardConfig = nullptr;
    }
    _currentBoardConfig = config;
    _hasBoardImage = (config != nullptr);
}

void WaveshareDisplay::setLedCommands(const LedCmd* commands, int count) {
    _ledCommandCount = min(count, MAX_LED_COMMANDS);
    if (commands && _ledCommandCount > 0) {
        memcpy(_ledCommands, commands, _ledCommandCount * sizeof(LedCmd));
    }
}

void WaveshareDisplay::drawBoardImageWithHolds() {
    if (!_currentBoardConfig) return;

    const BoardConfig* cfg = _currentBoardConfig;

    // Center the image horizontally
    int offsetX = (SCREEN_WIDTH - cfg->imageWidth) / 2;
    int offsetY = WS_BOARD_IMAGE_Y;

    // Cache the decoded JPEG in a PSRAM sprite so subsequent refreshes
    // (when only hold circles change) don't re-decode the entire JPEG.
    if (_cachedBoardConfig != cfg) {
        // Board config changed - rebuild the cache
        if (_boardImageSprite) {
            _boardImageSprite->deleteSprite();
            delete _boardImageSprite;
            _boardImageSprite = nullptr;
        }

        _boardImageSprite = new LGFX_Sprite(&_display);
        _boardImageSprite->setPsram(true);
        if (_boardImageSprite->createSprite(cfg->imageWidth, cfg->imageHeight)) {
            // Decode JPEG into the sprite (one-time cost)
            _boardImageSprite->drawJpg(cfg->imageData, cfg->imageSize,
                                        0, 0, cfg->imageWidth, cfg->imageHeight);
            _cachedBoardConfig = cfg;
        } else {
            // PSRAM allocation failed - fall back to direct decode each time
            delete _boardImageSprite;
            _boardImageSprite = nullptr;
            _cachedBoardConfig = nullptr;
        }
    }

    // Blit the cached image to screen (fast memcpy vs slow JPEG decode)
    if (_boardImageSprite) {
        _boardImageSprite->pushSprite(&_display, offsetX, offsetY);
    } else {
        // Fallback: decode JPEG directly (slow path)
        _display.drawJpg(cfg->imageData, cfg->imageSize,
                         offsetX, offsetY,
                         cfg->imageWidth, cfg->imageHeight);
    }

    // Overlay hold circles for each active LED command.
    // holdMap is sorted by ledPosition (at code generation time),
    // so we use binary search for O(n log m) instead of O(n*m).
    for (int i = 0; i < _ledCommandCount; i++) {
        uint16_t target = _ledCommands[i].position;
        int lo = 0, hi = cfg->holdCount - 1;
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            uint16_t midPos = cfg->holdMap[mid].ledPosition;
            if (midPos == target) {
                uint16_t color = _display.color565(
                    _ledCommands[i].r, _ledCommands[i].g, _ledCommands[i].b);
                int dx = offsetX + cfg->holdMap[mid].cx;
                int dy = offsetY + cfg->holdMap[mid].cy;
                int dr = cfg->holdMap[mid].radius;
                // Anti-aliased ring using fillArc (full 360° sweep)
                int strokeWidth = 3;
                int innerR = max(1, dr - strokeWidth);
                _display.fillArc(dx, dy, dr, innerR, 0.0f, 360.0f, color);
                break;
            } else if (midPos < target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
    }
}

void WaveshareDisplay::drawClimbInfoCompact() {
    if (!_hasClimb || !_currentBoardConfig) return;

    int yStart = WS_BOARD_IMAGE_Y + _currentBoardConfig->imageHeight + 10;

    // Clear the climb info area
    _display.fillRect(0, yStart, SCREEN_WIDTH, WS_CLIMB_INFO_V2_HEIGHT, COLOR_BACKGROUND);

    // Draw climb name centered
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::top_center);

    String displayName = _climbName;
    if (displayName.length() > 28) {
        displayName = displayName.substring(0, 25) + "...";
    }
    _display.drawString(displayName.c_str(), SCREEN_WIDTH / 2, yStart);

    // Draw grade badge
    if (_grade.length() > 0) {
        int badgeWidth = 140;
        int badgeHeight = 40;
        int badgeX = (SCREEN_WIDTH - badgeWidth) / 2;
        int badgeY = yStart + 38;

        uint16_t gradeColor565 = getGradeColor(_grade.c_str());
        _display.fillRoundRect(badgeX, badgeY, badgeWidth, badgeHeight, 10, gradeColor565);

        uint16_t textColor = getGradeTextColor(gradeColor565);
        _display.setFont(&fonts::FreeSansBold12pt7b);
        _display.setTextColor(textColor);
        _display.setTextDatum(lgfx::middle_center);

        // Extract V-grade for display
        String displayGrade = _grade;
        int slashPos = displayGrade.indexOf('/');
        if (slashPos > 0) {
            displayGrade = displayGrade.substring(slashPos + 1);
        }
        _display.drawString(displayGrade.c_str(), badgeX + badgeWidth / 2, badgeY + badgeHeight / 2);
    }

    _display.setTextDatum(lgfx::top_left);
}
#endif

// ============================================
// Settings Screen
// ============================================

void WaveshareDisplay::setSettingsData(const char* ssid, const char* ip, bool proxyEnabled) {
    _settingsSSID = ssid ? ssid : "";
    _settingsIP = ip ? ip : "";
    _settingsProxyEnabled = proxyEnabled;
}

void WaveshareDisplay::showSettingsScreen() {
    _settingsScreenActive = true;
    if (_displayMode == WsDisplayMode::LANDSCAPE) {
        drawLandscapeSettingsScreen();
    } else {
        drawSettingsScreen();
    }
}

void WaveshareDisplay::hideSettingsScreen() {
    _settingsScreenActive = false;
    refresh();
}

void WaveshareDisplay::drawSettingsScreen() {
    _display.fillScreen(COLOR_BACKGROUND);

    // Title
    _display.setFont(&fonts::FreeSansBold24pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("Settings", SCREEN_WIDTH / 2, WS_SETTINGS_TITLE_Y);

    // WiFi info
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("WiFi Network", SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    if (_settingsSSID.length() > 0) {
        _display.drawString(_settingsSSID.c_str(), SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y + 40);
    } else {
        _display.drawString("Not connected", SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y + 40);
    }

    // IP address
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("IP Address", SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y + 90);

    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_TEXT);
    if (_settingsIP.length() > 0) {
        _display.drawString(_settingsIP.c_str(), SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y + 130);
    } else {
        _display.drawString("--", SCREEN_WIDTH / 2, WS_SETTINGS_INFO_Y + 130);
    }

    // Reset WiFi button (red)
    _display.fillRoundRect(WS_SETTINGS_BTN_X, WS_SETTINGS_RESET_BTN_Y,
                           WS_SETTINGS_BTN_W, WS_SETTINGS_BTN_H, 12, 0xE8A4);
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Reset WiFi", SCREEN_WIDTH / 2,
                        WS_SETTINGS_RESET_BTN_Y + WS_SETTINGS_BTN_H / 2);

    // BLE Proxy toggle button (green if on, gray if off)
    uint16_t proxyColor = _settingsProxyEnabled ? 0x07E0 : 0x6B6D;
    _display.fillRoundRect(WS_SETTINGS_BTN_X, WS_SETTINGS_PROXY_BTN_Y,
                           WS_SETTINGS_BTN_W, WS_SETTINGS_BTN_H, 12, proxyColor);
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(_settingsProxyEnabled ? 0x0000 : 0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    char proxyLabel[32];
    snprintf(proxyLabel, sizeof(proxyLabel), "BLE Proxy: %s", _settingsProxyEnabled ? "ON" : "OFF");
    _display.drawString(proxyLabel, SCREEN_WIDTH / 2,
                        WS_SETTINGS_PROXY_BTN_Y + WS_SETTINGS_BTN_H / 2);

    // Display mode toggle button (blue)
    _display.fillRoundRect(WS_SETTINGS_BTN_X, WS_SETTINGS_DISPMODE_BTN_Y,
                           WS_SETTINGS_BTN_W, WS_SETTINGS_BTN_H, 12, 0x3B7F);
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Display: Portrait", SCREEN_WIDTH / 2,
                        WS_SETTINGS_DISPMODE_BTN_Y + WS_SETTINGS_BTN_H / 2);

    // Back button (cyan)
    _display.fillRoundRect(WS_SETTINGS_BTN_X, WS_SETTINGS_BACK_BTN_Y,
                           WS_SETTINGS_BTN_W, WS_SETTINGS_BTN_H, 12, COLOR_ACCENT);
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(0x0000);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Back", SCREEN_WIDTH / 2,
                        WS_SETTINGS_BACK_BTN_Y + WS_SETTINGS_BTN_H / 2);

    _display.setTextDatum(lgfx::top_left);
}

TouchAction WaveshareDisplay::handleSettingsTouch(int16_t x, int16_t y) {
    // Reset WiFi button
    if (x >= WS_SETTINGS_BTN_X && x <= WS_SETTINGS_BTN_X + WS_SETTINGS_BTN_W &&
        y >= WS_SETTINGS_RESET_BTN_Y && y <= WS_SETTINGS_RESET_BTN_Y + WS_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_RESET_WIFI;
    }

    // BLE Proxy toggle button
    if (x >= WS_SETTINGS_BTN_X && x <= WS_SETTINGS_BTN_X + WS_SETTINGS_BTN_W &&
        y >= WS_SETTINGS_PROXY_BTN_Y && y <= WS_SETTINGS_PROXY_BTN_Y + WS_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_TOGGLE_PROXY;
    }

    // Display mode toggle button
    if (x >= WS_SETTINGS_BTN_X && x <= WS_SETTINGS_BTN_X + WS_SETTINGS_BTN_W &&
        y >= WS_SETTINGS_DISPMODE_BTN_Y && y <= WS_SETTINGS_DISPMODE_BTN_Y + WS_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_TOGGLE_DISPLAY_MODE;
    }

    // Back button
    if (x >= WS_SETTINGS_BTN_X && x <= WS_SETTINGS_BTN_X + WS_SETTINGS_BTN_W &&
        y >= WS_SETTINGS_BACK_BTN_Y && y <= WS_SETTINGS_BACK_BTN_Y + WS_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_BACK;
    }

    return TouchAction::NONE;
}

// ============================================
// Touch Handling
// ============================================

TouchEvent WaveshareDisplay::pollTouch() {
    TouchEvent event;

    unsigned long now = millis();
    if (now - _lastTouchTime < TOUCH_DEBOUNCE_MS) {
        return event;  // Still in debounce period
    }

    lgfx::touch_point_t tp;
    if (_display.getTouch(&tp)) {
        _lastTouchTime = now;
        event.x = tp.x;
        event.y = tp.y;

        // Landscape mode touch handling
        if (_displayMode == WsDisplayMode::LANDSCAPE) {
            if (_settingsScreenActive) {
                event.action = handleLandscapeSettingsTouch(tp.x, tp.y);
                return event;
            }
            return handleLandscapeTouch(tp.x, tp.y);
        }

        // Portrait mode touch handling (unchanged)
        if (_settingsScreenActive) {
            event.action = handleSettingsTouch(tp.x, tp.y);
            return event;
        }

        // Check for settings button touch (top-right gear icon)
        if (tp.x >= WS_SETTINGS_BUTTON_X && tp.x <= WS_SETTINGS_BUTTON_X + WS_SETTINGS_BUTTON_W &&
            tp.y >= WS_SETTINGS_BUTTON_Y && tp.y <= WS_SETTINGS_BUTTON_Y + WS_SETTINGS_BUTTON_H) {
            event.action = TouchAction::OPEN_SETTINGS;
            return event;
        }

        // Check if touch is in the nav button area
        if (tp.y >= WS_NAV_BUTTON_Y && tp.y <= WS_NAV_BUTTON_Y + WS_NAV_BUTTON_HEIGHT) {
            // Left side = previous
            if (tp.x < SCREEN_WIDTH / 3) {
                event.action = TouchAction::NAVIGATE_PREVIOUS;
            }
            // Right side = next
            else if (tp.x > SCREEN_WIDTH * 2 / 3) {
                event.action = TouchAction::NAVIGATE_NEXT;
            }
        }
    }

    return event;
}

// ============================================
// Landscape Drawing Methods
// ============================================

void WaveshareDisplay::drawLandscapeStatusBar() {
    _display.fillRect(0, WS_L_STATUS_BAR_Y, WS_L_SCREEN_WIDTH, WS_L_STATUS_BAR_HEIGHT, COLOR_BACKGROUND);

    _display.setTextSize(1);
    _display.setFont(&fonts::FreeSansBold9pt7b);

    // WiFi indicator
    _display.setCursor(10, WS_L_STATUS_BAR_Y + 12);
    _display.setTextColor(_wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WiFi");
    _display.fillCircle(80, WS_L_STATUS_BAR_Y + 20, 6, _wifiConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // Backend indicator
    _display.setCursor(100, WS_L_STATUS_BAR_Y + 12);
    _display.setTextColor(_backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_ERROR);
    _display.print("WS");
    _display.fillCircle(140, WS_L_STATUS_BAR_Y + 20, 6, _backendConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);

    // BLE indicator
    if (_bleEnabled) {
        _display.setCursor(160, WS_L_STATUS_BAR_Y + 12);
        _display.setTextColor(_bleConnected ? COLOR_STATUS_OK : COLOR_TEXT_DIM);
        _display.print("BLE");
        _display.fillCircle(200, WS_L_STATUS_BAR_Y + 20, 6, _bleConnected ? COLOR_STATUS_OK : COLOR_STATUS_OFF);
    }

    // Angle display
    if (_hasClimb && _angle > 0) {
        _display.setTextColor(COLOR_TEXT);
        _display.setCursor(WS_L_SCREEN_WIDTH - 130, WS_L_STATUS_BAR_Y + 12);
        _display.printf("%d", _angle);
        _display.drawCircle(WS_L_SCREEN_WIDTH - 70, WS_L_STATUS_BAR_Y + 12, 4, COLOR_TEXT);
    }

    // Settings gear icon (top-right)
    int gearCx = WS_L_SETTINGS_BUTTON_X + WS_L_SETTINGS_BUTTON_W / 2;
    int gearCy = WS_L_STATUS_BAR_Y + WS_L_SETTINGS_BUTTON_H / 2;
    int gearR = 10;
    _display.drawCircle(gearCx, gearCy, gearR, COLOR_TEXT_DIM);
    _display.drawCircle(gearCx, gearCy, 4, COLOR_TEXT_DIM);
    _display.drawFastHLine(gearCx - gearR - 3, gearCy, 6, COLOR_TEXT_DIM);
    _display.drawFastHLine(gearCx + gearR - 3, gearCy, 6, COLOR_TEXT_DIM);
    _display.drawFastVLine(gearCx, gearCy - gearR - 3, 6, COLOR_TEXT_DIM);
    _display.drawFastVLine(gearCx, gearCy + gearR - 3, 6, COLOR_TEXT_DIM);
}

void WaveshareDisplay::drawLandscapeBoardPanel() {
#ifdef ENABLE_BOARD_IMAGE
    if (!_hasBoardImage || !_currentBoardConfig) {
        // Clear left panel and show "waiting" message
        _display.fillRect(WS_L_LEFT_PANEL_X, WS_L_LEFT_PANEL_Y,
                          WS_L_LEFT_PANEL_W, WS_L_LEFT_PANEL_H, COLOR_BACKGROUND);

        if (!_hasClimb) {
            _display.setFont(&fonts::FreeSansBold18pt7b);
            _display.setTextColor(COLOR_TEXT_DIM);
            _display.setTextDatum(lgfx::middle_center);
            _display.drawString("Waiting for climb...",
                                WS_L_LEFT_PANEL_X + WS_L_LEFT_PANEL_W / 2,
                                WS_L_LEFT_PANEL_Y + WS_L_LEFT_PANEL_H / 2);
            _display.setTextDatum(lgfx::top_left);
        }
        return;
    }

    const BoardConfig* cfg = _currentBoardConfig;

    // Calculate scaling to fit board image in left panel
    // Leave room for climb info at bottom
    int availableH = WS_L_LEFT_PANEL_H - WS_L_CLIMB_INFO_HEIGHT;
    int availableW = WS_L_LEFT_PANEL_W;

    // Scale image to fit available space
    float scaleW = (float)availableW / cfg->imageWidth;
    float scaleH = (float)availableH / cfg->imageHeight;
    float scale = min(scaleW, scaleH);

    int drawW = (int)(cfg->imageWidth * scale);
    int drawH = (int)(cfg->imageHeight * scale);
    int offsetX = WS_L_LEFT_PANEL_X + (availableW - drawW) / 2;
    int offsetY = WS_L_LEFT_PANEL_Y;

    // Clear margins around the board image
    if (offsetX > WS_L_LEFT_PANEL_X) {
        _display.fillRect(WS_L_LEFT_PANEL_X, WS_L_LEFT_PANEL_Y,
                          offsetX - WS_L_LEFT_PANEL_X, availableH, COLOR_BACKGROUND);
        _display.fillRect(offsetX + drawW, WS_L_LEFT_PANEL_Y,
                          WS_L_LEFT_PANEL_W - (offsetX - WS_L_LEFT_PANEL_X) - drawW, availableH, COLOR_BACKGROUND);
    }

    // Cache the decoded JPEG in a PSRAM sprite
    if (_cachedBoardConfig != cfg) {
        if (_boardImageSprite) {
            _boardImageSprite->deleteSprite();
            delete _boardImageSprite;
            _boardImageSprite = nullptr;
        }

        _boardImageSprite = new LGFX_Sprite(&_display);
        _boardImageSprite->setPsram(true);
        if (_boardImageSprite->createSprite(cfg->imageWidth, cfg->imageHeight)) {
            _boardImageSprite->drawJpg(cfg->imageData, cfg->imageSize,
                                        0, 0, cfg->imageWidth, cfg->imageHeight);
            _cachedBoardConfig = cfg;
        } else {
            delete _boardImageSprite;
            _boardImageSprite = nullptr;
            _cachedBoardConfig = nullptr;
        }
    }

    // Blit the cached image scaled to fit
    if (_boardImageSprite) {
        // Use pushRotateZoom to scale the sprite (angle=0, scaleX=scale, scaleY=scale)
        _boardImageSprite->pushRotateZoom(&_display,
            offsetX + drawW / 2, offsetY + drawH / 2,
            0, scale, scale);
    } else {
        _display.drawJpg(cfg->imageData, cfg->imageSize,
                         offsetX, offsetY, drawW, drawH);
    }

    // Overlay hold circles (scaled)
    for (int i = 0; i < _ledCommandCount; i++) {
        uint16_t target = _ledCommands[i].position;
        int lo = 0, hi = cfg->holdCount - 1;
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            uint16_t midPos = cfg->holdMap[mid].ledPosition;
            if (midPos == target) {
                uint16_t color = _display.color565(
                    _ledCommands[i].r, _ledCommands[i].g, _ledCommands[i].b);
                int dx = offsetX + (int)(cfg->holdMap[mid].cx * scale);
                int dy = offsetY + (int)(cfg->holdMap[mid].cy * scale);
                int dr = max(1, (int)(cfg->holdMap[mid].radius * scale));
                int strokeWidth = max(1, (int)(3 * scale));
                int innerR = max(1, dr - strokeWidth);
                _display.fillArc(dx, dy, dr, innerR, 0.0f, 360.0f, color);
                break;
            } else if (midPos < target) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
    }

    // Draw compact climb info below the board image
    drawLandscapeClimbInfo();

    // Draw small QR code in bottom-left corner (overlaid on board image)
    drawLandscapeQRCode();
#else
    // No board image support - show placeholder
    _display.fillRect(WS_L_LEFT_PANEL_X, WS_L_LEFT_PANEL_Y,
                      WS_L_LEFT_PANEL_W, WS_L_LEFT_PANEL_H, COLOR_BACKGROUND);
#endif
}

void WaveshareDisplay::drawLandscapeClimbInfo() {
    if (!_hasClimb) return;

#ifdef ENABLE_BOARD_IMAGE
    int yStart;
    if (_hasBoardImage && _currentBoardConfig) {
        int availableH = WS_L_LEFT_PANEL_H - WS_L_CLIMB_INFO_HEIGHT;
        float scaleW = (float)WS_L_LEFT_PANEL_W / _currentBoardConfig->imageWidth;
        float scaleH = (float)availableH / _currentBoardConfig->imageHeight;
        float scale = min(scaleW, scaleH);
        int drawH = (int)(_currentBoardConfig->imageHeight * scale);
        yStart = WS_L_LEFT_PANEL_Y + drawH + 4;
    } else {
        yStart = WS_L_LEFT_PANEL_Y + WS_L_LEFT_PANEL_H - WS_L_CLIMB_INFO_HEIGHT;
    }
#else
    int yStart = WS_L_LEFT_PANEL_Y + WS_L_LEFT_PANEL_H - WS_L_CLIMB_INFO_HEIGHT;
#endif

    // Clear climb info area
    _display.fillRect(WS_L_LEFT_PANEL_X, yStart, WS_L_LEFT_PANEL_W, WS_L_CLIMB_INFO_HEIGHT, COLOR_BACKGROUND);

    int centerX = WS_L_LEFT_PANEL_X + WS_L_LEFT_PANEL_W / 2;

    // Draw climb name
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.setTextDatum(lgfx::top_center);

    String displayName = _climbName;
    if (displayName.length() > 30) {
        displayName = displayName.substring(0, 27) + "...";
    }
    _display.drawString(displayName.c_str(), centerX, yStart);

    // Draw grade badge
    if (_grade.length() > 0) {
        int badgeWidth = 100;
        int badgeHeight = 28;
        int badgeX = centerX - badgeWidth / 2;
        int badgeY = yStart + 28;

        uint16_t gradeColor565 = getGradeColor(_grade.c_str());
        _display.fillRoundRect(badgeX, badgeY, badgeWidth, badgeHeight, 8, gradeColor565);

        uint16_t textColor = getGradeTextColor(gradeColor565);
        _display.setFont(&fonts::FreeSansBold9pt7b);
        _display.setTextColor(textColor);
        _display.setTextDatum(lgfx::middle_center);

        String displayGrade = _grade;
        int slashPos = displayGrade.indexOf('/');
        if (slashPos > 0) {
            displayGrade = displayGrade.substring(slashPos + 1);
        }
        _display.drawString(displayGrade.c_str(), badgeX + badgeWidth / 2, badgeY + badgeHeight / 2);
    }

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::drawLandscapeQRCode() {
    if (!_hasQRCode || _sessionId.length() == 0) return;

    // Generate QR code
    QRCode qrCode;
    qrcode_initText(&qrCode, _qrCodeData, QR_VERSION, ECC_LOW, _qrUrl.c_str());

    int qrSize = qrCode.size;
    int pixelSize = WS_L_QR_SIZE / qrSize;
    if (pixelSize < 1) pixelSize = 1;

    int actualQrSize = pixelSize * qrSize;

    // Position in bottom-left corner of left panel
    int qrX = WS_L_LEFT_PANEL_X + WS_L_QR_MARGIN;
    int qrY = WS_L_LEFT_PANEL_Y + WS_L_LEFT_PANEL_H - actualQrSize - WS_L_QR_MARGIN;

    // Draw white background
    _display.fillRect(qrX - 2, qrY - 2, actualQrSize + 4, actualQrSize + 4, COLOR_QR_BG);

    // Draw QR code modules
    for (uint8_t y = 0; y < qrSize; y++) {
        for (uint8_t x = 0; x < qrSize; x++) {
            if (qrcode_getModule(&qrCode, x, y)) {
                _display.fillRect(qrX + x * pixelSize, qrY + y * pixelSize,
                                  pixelSize, pixelSize, COLOR_QR_FG);
            }
        }
    }
}

void WaveshareDisplay::updateQueueScrollOffset() {
    if (_queueCount <= WS_L_QUEUE_VISIBLE_ITEMS) {
        _queueScrollOffset = 0;
        return;
    }

    // Center current item at ~position 4 (midpoint of visible items)
    int targetCenter = WS_L_QUEUE_VISIBLE_ITEMS / 2;
    _queueScrollOffset = _currentQueueIndex - targetCenter;

    // Clamp to valid range
    int maxOffset = _queueCount - WS_L_QUEUE_VISIBLE_ITEMS;
    if (_queueScrollOffset < 0) _queueScrollOffset = 0;
    if (_queueScrollOffset > maxOffset) _queueScrollOffset = maxOffset;
}

void WaveshareDisplay::drawLandscapeQueuePanel() {
    // Clear right panel
    _display.fillRect(WS_L_RIGHT_PANEL_X, WS_L_RIGHT_PANEL_Y,
                      WS_L_RIGHT_PANEL_W, WS_L_RIGHT_PANEL_H, COLOR_BACKGROUND);

    // Draw panel separator line
    _display.drawFastVLine(WS_L_RIGHT_PANEL_X, WS_L_RIGHT_PANEL_Y, WS_L_RIGHT_PANEL_H, 0x2104);

    if (_queueCount == 0) {
        _display.setFont(&fonts::FreeSansBold12pt7b);
        _display.setTextColor(COLOR_TEXT_DIM);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Waiting for",
                            WS_L_RIGHT_PANEL_X + WS_L_RIGHT_PANEL_W / 2,
                            WS_L_RIGHT_PANEL_Y + WS_L_RIGHT_PANEL_H / 2 - 15);
        _display.drawString("queue...",
                            WS_L_RIGHT_PANEL_X + WS_L_RIGHT_PANEL_W / 2,
                            WS_L_RIGHT_PANEL_Y + WS_L_RIGHT_PANEL_H / 2 + 15);
        _display.setTextDatum(lgfx::top_left);
        return;
    }

    updateQueueScrollOffset();

    // Draw queue header with position
    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.setTextDatum(lgfx::top_center);
    char headerStr[16];
    snprintf(headerStr, sizeof(headerStr), "Queue %d/%d", _currentQueueIndex + 1, _queueCount);
    _display.drawString(headerStr, WS_L_RIGHT_PANEL_X + WS_L_RIGHT_PANEL_W / 2, WS_L_RIGHT_PANEL_Y + 4);
    _display.setTextDatum(lgfx::top_left);

    int listStartY = WS_L_RIGHT_PANEL_Y + 24;
    int itemX = WS_L_RIGHT_PANEL_X + 8;
    int itemW = WS_L_RIGHT_PANEL_W - 16;

    int visibleCount = min(_queueCount - _queueScrollOffset, WS_L_QUEUE_VISIBLE_ITEMS);

    for (int i = 0; i < visibleCount; i++) {
        int queueIndex = _queueScrollOffset + i;
        int itemY = listStartY + i * WS_L_QUEUE_ITEM_HEIGHT;

        const LocalQueueItem* item = getQueueItem(queueIndex);
        if (!item || !item->isValid()) continue;

        // Determine colors based on position relative to current
        uint16_t textColor;
        if (queueIndex == _currentQueueIndex) {
            // Current item - highlighted background
            _display.fillRect(WS_L_RIGHT_PANEL_X + 2, itemY, WS_L_RIGHT_PANEL_W - 4, WS_L_QUEUE_ITEM_HEIGHT, 0x2104);
            textColor = COLOR_TEXT;
        } else if (queueIndex < _currentQueueIndex) {
            // Previous/completed items - grey
            textColor = COLOR_TEXT_DIM;
        } else {
            // Upcoming items - white
            textColor = COLOR_TEXT;
        }

        // Draw climb name (left-aligned, truncated)
        _display.setFont(&fonts::FreeSansBold9pt7b);
        _display.setTextColor(textColor);
        _display.setTextDatum(lgfx::middle_left);

        String name = item->name;
        if (name.length() > 18) {
            name = name.substring(0, 15) + "...";
        }
        _display.drawString(name.c_str(), itemX, itemY + WS_L_QUEUE_ITEM_HEIGHT / 2);

        // Draw grade text in grade color (right-aligned)
        // Extract V-grade from grade string (e.g., "6c/V5" -> "V5")
        if (item->grade[0] != '\0') {
            char vGrade[8] = "";
            const char* vPos = strchr(item->grade, 'V');
            if (!vPos) vPos = strchr(item->grade, 'v');
            if (vPos) {
                int gi = 0;
                vGrade[gi++] = 'V';
                vPos++;
                while (*vPos >= '0' && *vPos <= '9' && gi < 7) {
                    vGrade[gi++] = *vPos++;
                }
                vGrade[gi] = '\0';
            } else {
                // No V-grade found, use the raw grade
                strncpy(vGrade, item->grade, 7);
                vGrade[7] = '\0';
            }
            _display.setTextDatum(lgfx::middle_right);
            _display.setTextColor(item->gradeColorRgb);
            _display.drawString(vGrade, itemX + itemW, itemY + WS_L_QUEUE_ITEM_HEIGHT / 2);
        }
    }

    _display.setTextDatum(lgfx::top_left);
}

void WaveshareDisplay::drawLandscapeSettingsScreen() {
    _display.fillScreen(COLOR_BACKGROUND);

    int sw = WS_L_SCREEN_WIDTH;

    // Title
    _display.setFont(&fonts::FreeSansBold18pt7b);
    _display.setTextColor(COLOR_ACCENT);
    _display.setTextDatum(lgfx::top_center);
    _display.drawString("Settings", sw / 2, WS_L_SETTINGS_TITLE_Y);

    // WiFi info (compact)
    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("WiFi Network", sw / 2, WS_L_SETTINGS_INFO_Y);

    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString(_settingsSSID.length() > 0 ? _settingsSSID.c_str() : "Not connected",
                        sw / 2, WS_L_SETTINGS_INFO_Y + 25);

    _display.setFont(&fonts::FreeSansBold9pt7b);
    _display.setTextColor(COLOR_TEXT_DIM);
    _display.drawString("IP Address", sw / 2, WS_L_SETTINGS_INFO_Y + 55);

    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(COLOR_TEXT);
    _display.drawString(_settingsIP.length() > 0 ? _settingsIP.c_str() : "--",
                        sw / 2, WS_L_SETTINGS_INFO_Y + 80);

    // Reset WiFi button (red)
    _display.fillRoundRect(WS_L_SETTINGS_BTN_X, WS_L_SETTINGS_RESET_BTN_Y,
                           WS_L_SETTINGS_BTN_W, WS_L_SETTINGS_BTN_H, 10, 0xE8A4);
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Reset WiFi", sw / 2,
                        WS_L_SETTINGS_RESET_BTN_Y + WS_L_SETTINGS_BTN_H / 2);

    // BLE Proxy toggle
    uint16_t proxyColor = _settingsProxyEnabled ? 0x07E0 : 0x6B6D;
    _display.fillRoundRect(WS_L_SETTINGS_BTN_X, WS_L_SETTINGS_PROXY_BTN_Y,
                           WS_L_SETTINGS_BTN_W, WS_L_SETTINGS_BTN_H, 10, proxyColor);
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(_settingsProxyEnabled ? 0x0000 : 0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    char proxyLabel[32];
    snprintf(proxyLabel, sizeof(proxyLabel), "BLE Proxy: %s", _settingsProxyEnabled ? "ON" : "OFF");
    _display.drawString(proxyLabel, sw / 2,
                        WS_L_SETTINGS_PROXY_BTN_Y + WS_L_SETTINGS_BTN_H / 2);

    // Display mode toggle (blue)
    _display.fillRoundRect(WS_L_SETTINGS_BTN_X, WS_L_SETTINGS_DISPMODE_BTN_Y,
                           WS_L_SETTINGS_BTN_W, WS_L_SETTINGS_BTN_H, 10, 0x3B7F);
    _display.setFont(&fonts::FreeSansBold12pt7b);
    _display.setTextColor(0xFFFF);
    _display.setTextDatum(lgfx::middle_center);
    _display.drawString("Display: Landscape", sw / 2,
                        WS_L_SETTINGS_DISPMODE_BTN_Y + WS_L_SETTINGS_BTN_H / 2);

    // Back button (cyan) - only if there's room
    if (WS_L_SETTINGS_BACK_BTN_Y + WS_L_SETTINGS_BTN_H <= WS_L_SCREEN_HEIGHT) {
        _display.fillRoundRect(WS_L_SETTINGS_BTN_X, WS_L_SETTINGS_BACK_BTN_Y,
                               WS_L_SETTINGS_BTN_W, WS_L_SETTINGS_BTN_H, 10, COLOR_ACCENT);
        _display.setFont(&fonts::FreeSansBold12pt7b);
        _display.setTextColor(0x0000);
        _display.setTextDatum(lgfx::middle_center);
        _display.drawString("Back", sw / 2,
                            WS_L_SETTINGS_BACK_BTN_Y + WS_L_SETTINGS_BTN_H / 2);
    }

    _display.setTextDatum(lgfx::top_left);
}

TouchEvent WaveshareDisplay::handleLandscapeTouch(int16_t x, int16_t y) {
    TouchEvent event;
    event.x = x;
    event.y = y;

    // Settings gear button (top-right)
    if (x >= WS_L_SETTINGS_BUTTON_X && x <= WS_L_SETTINGS_BUTTON_X + WS_L_SETTINGS_BUTTON_W &&
        y >= WS_L_SETTINGS_BUTTON_Y && y <= WS_L_SETTINGS_BUTTON_Y + WS_L_SETTINGS_BUTTON_H) {
        event.action = TouchAction::OPEN_SETTINGS;
        return event;
    }

    // Right panel - queue item tap
    if (x >= WS_L_RIGHT_PANEL_X && y >= WS_L_RIGHT_PANEL_Y) {
        int listStartY = WS_L_RIGHT_PANEL_Y + 24;  // After header
        if (y >= listStartY) {
            int itemIndex = (y - listStartY) / WS_L_QUEUE_ITEM_HEIGHT;
            int tappedQueueIndex = _queueScrollOffset + itemIndex;
            if (tappedQueueIndex >= 0 && tappedQueueIndex < _queueCount && tappedQueueIndex != _currentQueueIndex) {
                event.action = TouchAction::NAVIGATE_TO_INDEX;
                event.targetIndex = tappedQueueIndex;
                return event;
            }
        }
    }

    return event;
}

TouchAction WaveshareDisplay::handleLandscapeSettingsTouch(int16_t x, int16_t y) {
    // Reset WiFi button
    if (x >= WS_L_SETTINGS_BTN_X && x <= WS_L_SETTINGS_BTN_X + WS_L_SETTINGS_BTN_W &&
        y >= WS_L_SETTINGS_RESET_BTN_Y && y <= WS_L_SETTINGS_RESET_BTN_Y + WS_L_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_RESET_WIFI;
    }

    // BLE Proxy toggle
    if (x >= WS_L_SETTINGS_BTN_X && x <= WS_L_SETTINGS_BTN_X + WS_L_SETTINGS_BTN_W &&
        y >= WS_L_SETTINGS_PROXY_BTN_Y && y <= WS_L_SETTINGS_PROXY_BTN_Y + WS_L_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_TOGGLE_PROXY;
    }

    // Display mode toggle
    if (x >= WS_L_SETTINGS_BTN_X && x <= WS_L_SETTINGS_BTN_X + WS_L_SETTINGS_BTN_W &&
        y >= WS_L_SETTINGS_DISPMODE_BTN_Y && y <= WS_L_SETTINGS_DISPMODE_BTN_Y + WS_L_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_TOGGLE_DISPLAY_MODE;
    }

    // Back button
    if (x >= WS_L_SETTINGS_BTN_X && x <= WS_L_SETTINGS_BTN_X + WS_L_SETTINGS_BTN_W &&
        y >= WS_L_SETTINGS_BACK_BTN_Y && y <= WS_L_SETTINGS_BACK_BTN_Y + WS_L_SETTINGS_BTN_H) {
        return TouchAction::SETTINGS_BACK;
    }

    return TouchAction::NONE;
}
