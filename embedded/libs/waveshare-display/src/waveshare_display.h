// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef WAVESHARE_DISPLAY_H
#define WAVESHARE_DISPLAY_H

#include <Arduino.h>

#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#include <display_base.h>

#include "bus_rgb_bounce.h"

// Board image data is only available when explicitly enabled
#ifdef ENABLE_BOARD_IMAGE
#include <board_hold_data.h>
#endif

#include "ch422g.h"

// ============================================
// Waveshare ESP32-S3-Touch-LCD-7 Pin Configuration
// ============================================

// RGB 16-bit parallel control pins
#define WS_LCD_DE    5
#define WS_LCD_VSYNC 3
#define WS_LCD_HSYNC 46
#define WS_LCD_PCLK  7

// RGB data pins - Red (5 bits)
#define WS_LCD_R0   1
#define WS_LCD_R1   2
#define WS_LCD_R2   42
#define WS_LCD_R3   41
#define WS_LCD_R4   40

// RGB data pins - Green (6 bits)
#define WS_LCD_G0   39
#define WS_LCD_G1   0
#define WS_LCD_G2   45
#define WS_LCD_G3   48
#define WS_LCD_G4   47
#define WS_LCD_G5   21

// RGB data pins - Blue (5 bits)
#define WS_LCD_B0   14
#define WS_LCD_B1   38
#define WS_LCD_B2   18
#define WS_LCD_B3   17
#define WS_LCD_B4   10

// Touch pins (GT911 via I2C)
#define WS_TOUCH_SDA 8
#define WS_TOUCH_SCL 9
#define WS_TOUCH_INT 4
#define WS_TOUCH_RST -1  // Reset handled by CH422G

// I2C for CH422G IO expander
#define WS_I2C_SDA  8
#define WS_I2C_SCL  9

// ============================================
// Display Settings (native 800x480)
// ============================================

#define WS_SCREEN_WIDTH_NATIVE  800
#define WS_SCREEN_HEIGHT_NATIVE 480

// Portrait mode (after rotation)
#define WS_SCREEN_WIDTH  480
#define WS_SCREEN_HEIGHT 800

// ============================================
// Display Mode
// ============================================

enum class WsDisplayMode : uint8_t { PORTRAIT = 0, LANDSCAPE = 1 };

// ============================================
// Landscape Layout Constants (800x480)
// ============================================

#define WS_L_SCREEN_WIDTH  800
#define WS_L_SCREEN_HEIGHT 480

// Status bar at top (full width)
#define WS_L_STATUS_BAR_HEIGHT 40
#define WS_L_STATUS_BAR_Y 0

// Left panel - board preview
#define WS_L_LEFT_PANEL_X 0
#define WS_L_LEFT_PANEL_W 533
#define WS_L_LEFT_PANEL_Y WS_L_STATUS_BAR_HEIGHT
#define WS_L_LEFT_PANEL_H (WS_L_SCREEN_HEIGHT - WS_L_STATUS_BAR_HEIGHT)

// Right panel - queue list
#define WS_L_RIGHT_PANEL_X 533
#define WS_L_RIGHT_PANEL_W 267
#define WS_L_RIGHT_PANEL_Y WS_L_STATUS_BAR_HEIGHT
#define WS_L_RIGHT_PANEL_H (WS_L_SCREEN_HEIGHT - WS_L_STATUS_BAR_HEIGHT)

// Queue item dimensions
#define WS_L_QUEUE_ITEM_HEIGHT 48
#define WS_L_QUEUE_VISIBLE_ITEMS 9

// Climb info compact below board image in left panel
#define WS_L_CLIMB_INFO_HEIGHT 60

// QR code in bottom-left corner of left panel
#define WS_L_QR_SIZE 80
#define WS_L_QR_MARGIN 6

// Settings button (top-right, landscape-aware)
#define WS_L_SETTINGS_BUTTON_X (WS_L_SCREEN_WIDTH - 50)
#define WS_L_SETTINGS_BUTTON_Y 0
#define WS_L_SETTINGS_BUTTON_W 50
#define WS_L_SETTINGS_BUTTON_H 40

// Settings screen layout (landscape - more compact for 480px height)
#define WS_L_SETTINGS_TITLE_Y 20
#define WS_L_SETTINGS_INFO_Y 80
#define WS_L_SETTINGS_BTN_W 360
#define WS_L_SETTINGS_BTN_H 55
#define WS_L_SETTINGS_BTN_X ((WS_L_SCREEN_WIDTH - WS_L_SETTINGS_BTN_W) / 2)
#define WS_L_SETTINGS_RESET_BTN_Y 220
#define WS_L_SETTINGS_PROXY_BTN_Y 290
#define WS_L_SETTINGS_DISPMODE_BTN_Y 360
#define WS_L_SETTINGS_BACK_BTN_Y 420

// ============================================
// UI Layout (480x800 Portrait) - Scaled from LilyGo 170x320
// ============================================

// Status bar at top
#define WS_STATUS_BAR_HEIGHT 50
#define WS_STATUS_BAR_Y 0

// Current climb section
#define WS_CURRENT_CLIMB_Y 50
#define WS_CURRENT_CLIMB_HEIGHT 190

// Climb name area
#define WS_CLIMB_NAME_Y 60
#define WS_CLIMB_NAME_HEIGHT 75

// Grade badge area
#define WS_GRADE_Y 140
#define WS_GRADE_HEIGHT 90

// QR code section
#define WS_QR_SECTION_Y 240
#define WS_QR_SECTION_HEIGHT 330
#define WS_QR_CODE_SIZE 300

// Next climb indicator
#define WS_NEXT_INDICATOR_Y 570
#define WS_NEXT_INDICATOR_HEIGHT 55

// History section (previous climbs in queue)
#define WS_HISTORY_Y 625
#define WS_HISTORY_HEIGHT 115
#define WS_HISTORY_ITEM_HEIGHT 35
#define WS_HISTORY_MAX_ITEMS 3
#define WS_HISTORY_LABEL_HEIGHT 25

// Board image section (v2 layout with board image)
#define WS_BOARD_IMAGE_Y        40
#define WS_BOARD_IMAGE_MAX_H    560
#define WS_BOARD_IMAGE_MAX_W    480
#define WS_CLIMB_INFO_V2_HEIGHT 80

// Navigation buttons at bottom (touch targets)
#define WS_NAV_BUTTON_Y 740
#define WS_NAV_BUTTON_HEIGHT 60

// ============================================
// Touch Event
// ============================================

// Settings button layout (top-right of status bar)
#define WS_SETTINGS_BUTTON_X (WS_SCREEN_WIDTH - 50)
#define WS_SETTINGS_BUTTON_Y 0
#define WS_SETTINGS_BUTTON_W 50
#define WS_SETTINGS_BUTTON_H 50

// Settings screen layout
#define WS_SETTINGS_TITLE_Y 30
#define WS_SETTINGS_INFO_Y 120
#define WS_SETTINGS_BTN_W 360
#define WS_SETTINGS_BTN_H 70
#define WS_SETTINGS_BTN_X ((WS_SCREEN_WIDTH - WS_SETTINGS_BTN_W) / 2)
#define WS_SETTINGS_RESET_BTN_Y 350
#define WS_SETTINGS_PROXY_BTN_Y 450
#define WS_SETTINGS_DISPMODE_BTN_Y 550
#define WS_SETTINGS_BACK_BTN_Y 650

enum class TouchAction {
    NONE,
    NAVIGATE_PREVIOUS,
    NAVIGATE_NEXT,
    NAVIGATE_TO_INDEX,
    OPEN_SETTINGS,
    SETTINGS_BACK,
    SETTINGS_RESET_WIFI,
    SETTINGS_TOGGLE_PROXY,
    SETTINGS_TOGGLE_DISPLAY_MODE
};

struct TouchEvent {
    TouchAction action;
    int16_t x;
    int16_t y;
    int targetIndex;  // For NAVIGATE_TO_INDEX

    TouchEvent() : action(TouchAction::NONE), x(0), y(0), targetIndex(-1) {}
};

// ============================================
// Waveshare 7" LGFX Display Class (RGB bus)
// ============================================

class LGFX_Waveshare7 : public lgfx::LGFX_Device {
    lgfx::Panel_RGB _panel_instance;
    lgfx::Bus_RGB_Bounce _bus_instance;
    lgfx::Touch_GT911 _touch_instance;

  public:
    LGFX_Waveshare7();
};

// ============================================
// Waveshare Display Manager
// ============================================

class WaveshareDisplay : public DisplayBase {
  public:
    WaveshareDisplay();
    ~WaveshareDisplay();

    // DisplayBase overrides
    bool begin() override;
    void showConnecting() override;
    void showError(const char* message, const char* ipAddress = nullptr) override;
    void showConfigPortal(const char* apName, const char* ip) override;
    void showSetupScreen(const char* apName) override;
    void refresh() override;
    void refreshInfoOnly() override;

    // Touch handling
    TouchEvent pollTouch();

    // Settings screen
    void showSettingsScreen();
    void hideSettingsScreen();
    void setSettingsData(const char* ssid, const char* ip, bool proxyEnabled);
    bool isSettingsScreenActive() const { return _settingsScreenActive; }

    // Get display for custom drawing
    LGFX_Waveshare7& getDisplay() { return _display; }

    // Screen dimensions (mode-aware)
    int screenWidth() const { return _displayMode == WsDisplayMode::LANDSCAPE ? WS_L_SCREEN_WIDTH : WS_SCREEN_WIDTH; }
    int screenHeight() const { return _displayMode == WsDisplayMode::LANDSCAPE ? WS_L_SCREEN_HEIGHT : WS_SCREEN_HEIGHT; }

    // Legacy static constants (portrait defaults)
    static const int SCREEN_WIDTH = WS_SCREEN_WIDTH;
    static const int SCREEN_HEIGHT = WS_SCREEN_HEIGHT;

    // Display mode
    WsDisplayMode getDisplayMode() const { return _displayMode; }

  protected:
    void onStatusChanged() override;

  private:
    LGFX_Waveshare7 _display;
    CH422G _ioExpander;

    // Display mode
    WsDisplayMode _displayMode = WsDisplayMode::PORTRAIT;

    // Touch debouncing
    unsigned long _lastTouchTime;
    static const unsigned long TOUCH_DEBOUNCE_MS = 150;

    // Settings screen state
    bool _settingsScreenActive = false;
    String _settingsSSID;
    String _settingsIP;
    bool _settingsProxyEnabled = false;

    // Internal drawing methods (portrait)
    void drawStatusBar();
    void drawCurrentClimb();
    void drawQRCode();
    void drawNextClimbIndicator();
    void drawHistory();
    void drawNavButtons();
    void drawSettingsScreen();
    TouchAction handleSettingsTouch(int16_t x, int16_t y);

    // Landscape drawing methods
    void drawLandscapeStatusBar();
    void drawLandscapeBoardPanel();
    void drawLandscapeQueuePanel();
    void drawLandscapeClimbInfo();
    void drawLandscapeQRCode();
    void drawLandscapeSettingsScreen();
    TouchEvent handleLandscapeTouch(int16_t x, int16_t y);
    TouchAction handleLandscapeSettingsTouch(int16_t x, int16_t y);

    // Queue scrolling for landscape
    int _queueScrollOffset = 0;
    void updateQueueScrollOffset();

#ifdef ENABLE_BOARD_IMAGE
  public:
    // LED command struct (public so main.cpp can construct them)
    struct LedCmd { uint16_t position; uint8_t r, g, b; };
    static const int MAX_LED_COMMANDS = 512;

    void setBoardConfig(const BoardConfig* config);
    void setLedCommands(const LedCmd* commands, int count);

  private:
    // Board image rendering (v2 layout)
    void drawBoardImageWithHolds();
    void drawClimbInfoCompact();

    // Board image state
    bool _hasBoardImage = false;
    const BoardConfig* _currentBoardConfig = nullptr;

    // Cached decoded board image (PSRAM sprite avoids re-decoding JPEG each refresh)
    LGFX_Sprite* _boardImageSprite = nullptr;
    const BoardConfig* _cachedBoardConfig = nullptr;

    // Current LED commands for hold overlay
    LedCmd _ledCommands[MAX_LED_COMMANDS];
    int _ledCommandCount = 0;
#endif
};

extern WaveshareDisplay Display;

#endif  // WAVESHARE_DISPLAY_H
