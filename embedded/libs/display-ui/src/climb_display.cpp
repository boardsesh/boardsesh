// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "climb_display.h"

#include <climb_history.h>
#include <config_manager.h>
#include <log_buffer.h>

ClimbDisplay Display;

#ifdef ENABLE_DISPLAY

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

        cfg.memory_width = DISPLAY_WIDTH;
        cfg.memory_height = DISPLAY_HEIGHT;
        cfg.panel_width = DISPLAY_WIDTH;
        cfg.panel_height = DISPLAY_HEIGHT;
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

#endif  // ENABLE_DISPLAY

ClimbDisplay::ClimbDisplay()
    : initialized(false), brightness(200), wifiStatus(WiFiStatus::DISCONNECTED), bleStatus(BLEStatus::IDLE),
      hasCurrentClimb(false), needsFullRedraw(true), needsStatusRedraw(false), needsCurrentClimbRedraw(false),
      needsHistoryRedraw(false) {
    currentName[0] = '\0';
    currentGrade[0] = '\0';
}

void ClimbDisplay::begin() {
#ifdef ENABLE_DISPLAY
    Logger.logln("ClimbDisplay: Initializing");

    // Load brightness from config
    brightness = Config.getInt("disp_br", 200);

    // Enable display power (GPIO 15)
    pinMode(LCD_POWER_PIN, OUTPUT);
    digitalWrite(LCD_POWER_PIN, HIGH);
    delay(50);

    // Initialize display
    lcd.init();
    lcd.setRotation(0);  // Portrait mode
    lcd.setBrightness(brightness);
    lcd.fillScreen(COLOR_BLACK);

    initialized = true;
    needsFullRedraw = true;

    Logger.logln("ClimbDisplay: Ready");
#endif
}

void ClimbDisplay::setCurrentClimb(const char* name, const char* grade, const char* uuid, const char* boardPath,
                                   const char* sessionId) {
    // Store climb info
    strncpy(currentName, name ? name : "", sizeof(currentName) - 1);
    currentName[sizeof(currentName) - 1] = '\0';

    strncpy(currentGrade, grade ? grade : "", sizeof(currentGrade) - 1);
    currentGrade[sizeof(currentGrade) - 1] = '\0';

    hasCurrentClimb = true;

    // Generate QR code for session join
    if (sessionId && strlen(sessionId) > 0) {
        QRCode_Gen.generate(sessionId);
    }

    // Update history
    if (name && uuid) {
        ClimbHistoryMgr.addClimb(name, grade, uuid);
    }

    needsCurrentClimbRedraw = true;
    needsHistoryRedraw = true;
}

void ClimbDisplay::clearCurrentClimb() {
    hasCurrentClimb = false;
    currentName[0] = '\0';
    currentGrade[0] = '\0';
    QRCode_Gen.clear();
    ClimbHistoryMgr.clearCurrent();
    needsCurrentClimbRedraw = true;
}

void ClimbDisplay::setWiFiStatus(WiFiStatus status) {
    if (wifiStatus != status) {
        wifiStatus = status;
        needsStatusRedraw = true;
    }
}

void ClimbDisplay::setBLEStatus(BLEStatus status) {
    if (bleStatus != status) {
        bleStatus = status;
        needsStatusRedraw = true;
    }
}

void ClimbDisplay::setBrightness(uint8_t b) {
    brightness = b;
    Config.setInt("disp_br", b);

#ifdef ENABLE_DISPLAY
    if (initialized) {
        lcd.setBrightness(brightness);
    }
#endif
}

uint8_t ClimbDisplay::getBrightness() const {
    return brightness;
}

void ClimbDisplay::redraw() {
    needsFullRedraw = true;
}

void ClimbDisplay::loop() {
#ifdef ENABLE_DISPLAY
    if (!initialized)
        return;

    if (needsFullRedraw) {
        drawBackground();
        drawStatusBar();
        drawCurrentClimb();
        drawHistoryHeader();
        drawHistoryList();
        needsFullRedraw = false;
        needsStatusRedraw = false;
        needsCurrentClimbRedraw = false;
        needsHistoryRedraw = false;
        return;
    }

    if (needsCurrentClimbRedraw) {
        drawCurrentClimb();
        needsCurrentClimbRedraw = false;
    }

    if (needsHistoryRedraw) {
        drawHistoryList();
        needsHistoryRedraw = false;
    }

    if (needsStatusRedraw) {
        drawStatusBar();
        needsStatusRedraw = false;
    }
#endif
}

void ClimbDisplay::drawBackground() {
#ifdef ENABLE_DISPLAY
    lcd.fillScreen(COLOR_BLACK);
#endif
}

void ClimbDisplay::drawStatusBar() {
#ifdef ENABLE_DISPLAY
    // Status bar at top
    lcd.fillRect(0, 0, DISPLAY_WIDTH, STATUS_BAR_HEIGHT, COLOR_DARK_GRAY);

    lcd.setTextSize(1);
    lcd.setTextDatum(lgfx::middle_left);

    // WiFi status
    lcd.setCursor(5, STATUS_BAR_HEIGHT / 2 + 1);
    lcd.setTextColor(COLOR_WHITE);
    lcd.print("WiFi:");

    switch (wifiStatus) {
        case WiFiStatus::CONNECTED:
            lcd.setTextColor(COLOR_GREEN);
            lcd.print("OK");
            break;
        case WiFiStatus::CONNECTING:
            lcd.setTextColor(COLOR_CYAN);
            lcd.print("...");
            break;
        default:
            lcd.setTextColor(COLOR_RED);
            lcd.print("--");
            break;
    }

    // BLE status
    lcd.setCursor(70, STATUS_BAR_HEIGHT / 2 + 1);
    lcd.setTextColor(COLOR_WHITE);
    lcd.print("BLE:");

    switch (bleStatus) {
        case BLEStatus::CONNECTED:
            lcd.setTextColor(COLOR_GREEN);
            lcd.print("App");
            break;
        case BLEStatus::PROXY_CONNECTED:
            lcd.setTextColor(COLOR_CYAN);
            lcd.print("Prx");
            break;
        case BLEStatus::ADVERTISING:
            lcd.setTextColor(COLOR_CYAN);
            lcd.print("Adv");
            break;
        default:
            lcd.setTextColor(COLOR_LIGHT_GRAY);
            lcd.print("--");
            break;
    }
#endif
}

void ClimbDisplay::drawCurrentClimb() {
#ifdef ENABLE_DISPLAY
    int startY = STATUS_BAR_HEIGHT;

    // Clear the current climb area
    lcd.fillRect(0, startY, DISPLAY_WIDTH, CURRENT_CLIMB_HEIGHT + HEADER_HEIGHT, COLOR_BLACK);

    // Draw "CURRENT CLIMB" header
    lcd.fillRect(0, startY, DISPLAY_WIDTH, HEADER_HEIGHT, COLOR_DARK_GRAY);
    lcd.setTextColor(COLOR_CYAN);
    lcd.setTextSize(1);
    lcd.setCursor(8, startY + 7);
    lcd.print("CURRENT CLIMB");

    int contentY = startY + HEADER_HEIGHT;

    if (!hasCurrentClimb) {
        lcd.setTextColor(COLOR_LIGHT_GRAY);
        lcd.setTextSize(1);
        lcd.setCursor(10, contentY + 35);
        lcd.print("No climb selected");
        return;
    }

    // Draw QR code on the left
    int qrX = 5;
    int qrY = contentY + 5;
    drawQRCode(qrX, qrY);

    // Draw climb name on the right
    int textX = QR_SIZE + 15;
    int textY = contentY + 15;

    // Truncate name if too long
    char truncatedName[24];
    truncateText(currentName, truncatedName, 10);

    lcd.setTextColor(COLOR_WHITE);
    lcd.setTextSize(1);
    lcd.setCursor(textX, textY);
    lcd.print(truncatedName);

    // Draw grade with color
    textY += 25;
    char vGrade[8];
    extractVGrade(currentGrade, vGrade, sizeof(vGrade));

    if (vGrade[0] != '\0') {
        uint16_t gradeColor = getVGradeColor(vGrade);
        uint16_t textColor = getTextColorForBackground(gradeColor);

        // Draw grade badge
        int badgeWidth = 45;
        int badgeHeight = 22;
        lcd.fillRoundRect(textX, textY, badgeWidth, badgeHeight, 4, gradeColor);
        lcd.setTextColor(textColor);
        lcd.setTextSize(2);
        lcd.setCursor(textX + 6, textY + 4);
        lcd.print(vGrade);
    }
#endif
}

void ClimbDisplay::drawQRCode(int x, int y) {
#ifdef ENABLE_DISPLAY
    if (!QRCode_Gen.isValid()) {
        // Draw placeholder
        lcd.drawRect(x, y, QR_SIZE, QR_SIZE, COLOR_DARK_GRAY);
        lcd.setTextColor(COLOR_LIGHT_GRAY);
        lcd.setTextSize(1);
        lcd.setCursor(x + 20, y + 35);
        lcd.print("No QR");
        return;
    }

    int qrModules = QRCode_Gen.getSize();
    int moduleSize = (QR_SIZE - 8) / qrModules;
    int offsetX = x + (QR_SIZE - qrModules * moduleSize) / 2;
    int offsetY = y + (QR_SIZE - qrModules * moduleSize) / 2;

    // Draw white background
    lcd.fillRect(x, y, QR_SIZE, QR_SIZE, COLOR_WHITE);

    // Draw QR modules
    for (int qy = 0; qy < qrModules; qy++) {
        for (int qx = 0; qx < qrModules; qx++) {
            if (QRCode_Gen.getModule(qx, qy)) {
                lcd.fillRect(offsetX + qx * moduleSize, offsetY + qy * moduleSize, moduleSize, moduleSize, COLOR_BLACK);
            }
        }
    }
#endif
}

void ClimbDisplay::drawHistoryHeader() {
#ifdef ENABLE_DISPLAY
    int y = STATUS_BAR_HEIGHT + HEADER_HEIGHT + CURRENT_CLIMB_HEIGHT;
    lcd.fillRect(0, y, DISPLAY_WIDTH, HISTORY_HEADER_HEIGHT, COLOR_DARK_GRAY);
    lcd.setTextColor(COLOR_CYAN);
    lcd.setTextSize(1);
    lcd.setCursor(8, y + 5);
    lcd.print("RECENT CLIMBS");
#endif
}

void ClimbDisplay::drawHistoryList() {
#ifdef ENABLE_DISPLAY
    int startY = STATUS_BAR_HEIGHT + HEADER_HEIGHT + CURRENT_CLIMB_HEIGHT + HISTORY_HEADER_HEIGHT;

    // Clear history area
    int historyHeight = 5 * HISTORY_ITEM_HEIGHT;
    lcd.fillRect(0, startY, DISPLAY_WIDTH, historyHeight, COLOR_BLACK);

    // Draw each history item
    for (int i = 0; i < 5; i++) {
        drawHistoryItem(i, startY + i * HISTORY_ITEM_HEIGHT);
    }
#endif
}

void ClimbDisplay::drawHistoryItem(int index, int y) {
#ifdef ENABLE_DISPLAY
    // Get climb from history (skip index 0 which is current)
    const ClimbEntry* entry = ClimbHistoryMgr.getClimb(index + 1);

    if (!entry) {
        // Empty slot
        lcd.setTextColor(COLOR_DARK_GRAY);
        lcd.setTextSize(1);
        lcd.setCursor(10, y + 8);
        lcd.printf("%d. ---", index + 1);
        return;
    }

    // Draw index
    lcd.setTextColor(COLOR_LIGHT_GRAY);
    lcd.setTextSize(1);
    lcd.setCursor(8, y + 8);
    lcd.printf("%d.", index + 1);

    // Draw climb name (truncated)
    char truncatedName[18];
    truncateText(entry->name, truncatedName, 14);
    lcd.setCursor(25, y + 8);
    lcd.setTextColor(COLOR_WHITE);
    lcd.print(truncatedName);

    // Draw grade
    char vGrade[8];
    extractVGrade(entry->grade, vGrade, sizeof(vGrade));
    if (vGrade[0] != '\0') {
        uint16_t gradeColor = getVGradeColor(vGrade);
        lcd.setTextColor(gradeColor);
        lcd.setCursor(DISPLAY_WIDTH - 35, y + 8);
        lcd.print(vGrade);
    }
#endif
}

void ClimbDisplay::truncateText(const char* input, char* output, int maxChars) {
    if (!input) {
        output[0] = '\0';
        return;
    }

    int len = strlen(input);
    if (len <= maxChars) {
        strcpy(output, input);
    } else {
        strncpy(output, input, maxChars - 2);
        output[maxChars - 2] = '.';
        output[maxChars - 1] = '.';
        output[maxChars] = '\0';
    }
}
