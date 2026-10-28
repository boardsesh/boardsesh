#ifndef WAVESHARE_AMOLED_DISPLAY_H
#define WAVESHARE_AMOLED_DISPLAY_H

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

#include <JPEGDEC.h>
#include <atomic>
#include <display_base.h>

// Pin map from the current Waveshare ESP32-S3-Touch-AMOLED-2.16 docs/BSP.
#define AMOLED_LCD_SDIO0 4
#define AMOLED_LCD_SDIO1 5
#define AMOLED_LCD_SDIO2 6
#define AMOLED_LCD_SDIO3 7
#define AMOLED_LCD_SCLK 38
#define AMOLED_LCD_RESET 39
#define AMOLED_LCD_CS 12
#define AMOLED_LCD_WIDTH 480
#define AMOLED_LCD_HEIGHT 480

#define AMOLED_I2C_SDA 15
#define AMOLED_I2C_SCL 14
#define AMOLED_TOUCH_INT 11
#define AMOLED_TOUCH_RST 40

#define AMOLED_STATUS_BAR_HEIGHT 32
#define AMOLED_PREVIEW_Y 78
#define AMOLED_PREVIEW_SIZE 330
#define AMOLED_FOOTER_Y 418
#define AMOLED_FOOTER_HEIGHT 62

#ifdef ENABLE_BOARD_IMAGE
struct BoardConfig;
#endif

class WaveshareAmoledDisplay : public DisplayBase {
  public:
    WaveshareAmoledDisplay();
    ~WaveshareAmoledDisplay();

    bool begin() override;
    void showConnecting() override;
    void showError(const char* message, const char* ipAddress = nullptr) override;
    void showConfigPortal(const char* apName, const char* ip) override;
    void showSetupScreen(const char* apName) override;
    void refresh() override;
    void refreshInfoOnly() override;
    void showBlePreview(const char* boardType, int angle, bool fullRefresh);
    void showGymPreview(const char* name, const char* boardType, int angle, const char* serialNumber, int boardIndex,
                        int boardCount, bool payloadSeen, int ledCount, const char* syncStatus);

    // Status callbacks can run on the BLE task; rendering stays on the main loop.
    void setWiFiStatus(bool connected);
    void setBackendStatus(bool connected);
    void setBleStatus(bool enabled, bool connected);
    void service();
    bool writeScreenshot(Print& output);

#ifdef ENABLE_BOARD_IMAGE
    struct LedCmd {
        uint16_t position;
        uint8_t r;
        uint8_t g;
        uint8_t b;
    };
    static const int MAX_LED_COMMANDS = 1024;

    void setBoardConfig(const BoardConfig* config);
    void setLedCommands(const LedCmd* commands, int count);
    void setExactPositionMapping(bool exact) { _exactPositionMapping = exact; }
    int getLastJpegBlockCount() const { return _lastJpegBlockCount; }
    int getLastJpegDecodeResult() const { return _lastJpegDecodeResult; }
    int getLastMatchedHoldCount() const { return _lastMatchedHoldCount; }
#endif

    Arduino_GFX* getDisplay() { return _gfx; }

    static const int SCREEN_WIDTH = AMOLED_LCD_WIDTH;
    static const int SCREEN_HEIGHT = AMOLED_LCD_HEIGHT;

  protected:
    void onStatusChanged() override;

  private:
    Arduino_DataBus* _bus;
    Arduino_CO5300* _panel;
    Arduino_Canvas* _gfx;
    bool _ready;
    bool _blePreviewVisible;
    bool _fixturePreview = false;
    String _fixtureFooter;
    String _fixtureHint;
    std::atomic<uint8_t> _pendingWiFiStatus;
    std::atomic<uint8_t> _pendingBackendStatus;
    std::atomic<uint8_t> _pendingBleStatus;
    std::atomic<bool> _statusDirty;

#ifdef ENABLE_BOARD_IMAGE
    bool _hasBoardImage;
    const BoardConfig* _currentBoardConfig;
    const BoardConfig* _cachedBoardConfig;
    uint16_t* _boardImageCache;
    int _boardImageCacheWidth;
    int _boardImageCacheHeight;
    LedCmd _ledCommands[MAX_LED_COMMANDS];
    JPEGDEC _jpegDecoder;
    int _ledCommandCount;
    int _lastJpegBlockCount;
    int _lastJpegDecodeResult;
    int _lastMatchedHoldCount;
    bool _exactPositionMapping = false;
#endif

    void drawStatusBar();
    void drawClimbHeader();
    void drawPreviewFrame();
#ifdef ENABLE_BOARD_IMAGE
    void drawBoardImageWithHolds();
    bool ensureBoardImageCache(const BoardConfig* config);
    bool drawBoardImageDirect(const BoardConfig* config, int imageX, int imageY);
    void clearBoardImageCache();
#endif
    void drawFooter();
    void drawCenteredText(const char* text, int y, uint8_t size, uint16_t color);
    void drawTruncatedText(const char* text, int x, int y, uint8_t size, uint16_t color, int maxChars);
};

extern WaveshareAmoledDisplay Display;

#endif  // WAVESHARE_AMOLED_DISPLAY_H
