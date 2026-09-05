// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef CLIMB_DISPLAY_H
#define CLIMB_DISPLAY_H

#include "grade_colors.h"
#include "qr_generator.h"

#include <Arduino.h>

#ifdef ENABLE_DISPLAY
#include <LovyanGFX.hpp>

// ============================================
// LilyGo T-Display S3 Pin Configuration
// ============================================

// Parallel 8-bit data pins
#define LCD_D0_PIN 39
#define LCD_D1_PIN 40
#define LCD_D2_PIN 41
#define LCD_D3_PIN 42
#define LCD_D4_PIN 45
#define LCD_D5_PIN 46
#define LCD_D6_PIN 47
#define LCD_D7_PIN 48

// Control pins
#define LCD_WR_PIN 8   // Write strobe
#define LCD_RD_PIN 9   // Read strobe
#define LCD_RS_PIN 7   // Register select (DC)
#define LCD_CS_PIN 6   // Chip select
#define LCD_RST_PIN 5  // Reset

// Backlight and power
#define LCD_BL_PIN 38
#define LCD_POWER_PIN 15

// Custom LGFX class for T-Display-S3
class LGFX_TDisplayS3 : public lgfx::LGFX_Device {
    lgfx::Panel_ST7789 _panel_instance;
    lgfx::Bus_Parallel8 _bus_instance;
    lgfx::Light_PWM _light_instance;

  public:
    LGFX_TDisplayS3();
};
#endif

// T-Display-S3 screen dimensions (portrait mode)
#define DISPLAY_WIDTH 170
#define DISPLAY_HEIGHT 320

// Layout constants
#define HEADER_HEIGHT 24
#define CURRENT_CLIMB_HEIGHT 90
#define HISTORY_HEADER_HEIGHT 20
#define HISTORY_ITEM_HEIGHT 28
#define STATUS_BAR_HEIGHT 24
#define QR_SIZE 80

// WiFi/BLE status
enum class WiFiStatus { DISCONNECTED, CONNECTING, CONNECTED };

enum class BLEStatus { IDLE, ADVERTISING, CONNECTED, PROXY_CONNECTED };

/**
 * ClimbDisplay manages the T-Display-S3 screen showing:
 * - Current climb name and grade (with QR code)
 * - Recent climb history (last 5)
 * - Status bar (WiFi, BLE, proxy)
 */
class ClimbDisplay {
  public:
    ClimbDisplay();

    /**
     * Initialize the display.
     */
    void begin();

    /**
     * Set the current climb to display.
     */
    void setCurrentClimb(const char* name, const char* grade, const char* uuid, const char* boardPath,
                         const char* sessionId);

    /**
     * Clear the current climb (show "No climb selected").
     */
    void clearCurrentClimb();

    /**
     * Update WiFi status indicator.
     */
    void setWiFiStatus(WiFiStatus status);

    /**
     * Update BLE status indicator.
     */
    void setBLEStatus(BLEStatus status);

    /**
     * Set display brightness.
     * @param brightness 0-255
     */
    void setBrightness(uint8_t brightness);

    /**
     * Get current brightness.
     */
    uint8_t getBrightness() const;

    /**
     * Force a full redraw of the display.
     */
    void redraw();

    /**
     * Update the display (call periodically).
     */
    void loop();

  private:
#ifdef ENABLE_DISPLAY
    LGFX_TDisplayS3 lcd;  // Direct member (not pointer)
#endif
    bool initialized;
    uint8_t brightness;
    WiFiStatus wifiStatus;
    BLEStatus bleStatus;

    // Current climb info
    char currentName[64];
    char currentGrade[16];
    bool hasCurrentClimb;

    // Redraw flags
    bool needsFullRedraw;
    bool needsStatusRedraw;
    bool needsCurrentClimbRedraw;
    bool needsHistoryRedraw;

    // Drawing methods
    void drawHeader();
    void drawCurrentClimb();
    void drawQRCode(int x, int y);
    void drawHistoryHeader();
    void drawHistoryList();
    void drawHistoryItem(int index, int y);
    void drawStatusBar();
    void drawBackground();

    // Helper methods
    void truncateText(const char* input, char* output, int maxChars);
};

extern ClimbDisplay Display;

#endif
