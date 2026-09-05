// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LILYGO_DISPLAY_H
#define LILYGO_DISPLAY_H

#include <Arduino.h>

#include <LovyanGFX.hpp>
#include <display_base.h>

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

// Built-in buttons
#define BUTTON_1_PIN 0   // GPIO0 - Boot button
#define BUTTON_2_PIN 14  // GPIO14 - User button

// ============================================
// Display Settings
// ============================================

#define LILYGO_SCREEN_WIDTH 170
#define LILYGO_SCREEN_HEIGHT 320

// ============================================
// UI Layout (170x320 Portrait) - Condensed for Navigation
// ============================================

// Status bar at top
#define STATUS_BAR_HEIGHT 20
#define STATUS_BAR_Y 0

// Current climb section
#define CURRENT_CLIMB_Y 20
#define CURRENT_CLIMB_HEIGHT 75

// Climb name area
#define CLIMB_NAME_Y 25
#define CLIMB_NAME_HEIGHT 30

// Grade badge area (starts at 55, height 36, ends at 91)
#define GRADE_Y 55
#define GRADE_HEIGHT 36

// QR code section (enlarged for 120px QR code)
#define QR_SECTION_Y 95
#define QR_SECTION_HEIGHT 133
#define QR_CODE_SIZE 120

// Next climb indicator
#define NEXT_INDICATOR_Y 228
#define NEXT_INDICATOR_HEIGHT 22

// History section (previous climbs in queue)
#define HISTORY_Y 250
#define HISTORY_HEIGHT 59
#define HISTORY_ITEM_HEIGHT 18
#define HISTORY_MAX_ITEMS 3
#define HISTORY_LABEL_HEIGHT 12

// Button hint bar at bottom
#define BUTTON_HINT_Y 309
#define BUTTON_HINT_HEIGHT 11

// ============================================
// LilyGo T-Display S3 Display Class
// ============================================

class LGFX_TDisplayS3 : public lgfx::LGFX_Device {
    lgfx::Panel_ST7789 _panel_instance;
    lgfx::Bus_Parallel8 _bus_instance;
    lgfx::Light_PWM _light_instance;

  public:
    LGFX_TDisplayS3();
};

// ============================================
// LilyGo Display Manager
// ============================================

class LilyGoDisplay : public DisplayBase {
  public:
    LilyGoDisplay();
    ~LilyGoDisplay();

    // DisplayBase overrides
    bool begin() override;
    void showConnecting() override;
    void showError(const char* message, const char* ipAddress = nullptr) override;
    void showConfigPortal(const char* apName, const char* ip) override;
    void showSetupScreen(const char* apName) override;
    void refresh() override;

    // Get display for custom drawing
    LGFX_TDisplayS3& getDisplay() { return _display; }

    // Screen dimensions
    static const int SCREEN_WIDTH = LILYGO_SCREEN_WIDTH;
    static const int SCREEN_HEIGHT = LILYGO_SCREEN_HEIGHT;

  protected:
    void onStatusChanged() override;

  private:
    LGFX_TDisplayS3 _display;

    // Internal drawing methods
    void drawStatusBar();
    void drawCurrentClimb();
    void drawQRCode();
    void drawNextClimbIndicator();
    void drawHistory();
    void drawButtonHints();
};

extern LilyGoDisplay Display;

#endif  // LILYGO_DISPLAY_H
