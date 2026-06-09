#ifndef WAVESHARE_AMOLED_DISPLAY_H
#define WAVESHARE_AMOLED_DISPLAY_H

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <JPEGDEC.h>
#include <display_base.h>

#include <vector>

// Pin map from the current Waveshare ESP32-S3-Touch-AMOLED-2.16 docs/BSP.
#define AMOLED_LCD_SDIO0 4
#define AMOLED_LCD_SDIO1 5
#define AMOLED_LCD_SDIO2 6
#define AMOLED_LCD_SDIO3 7
#define AMOLED_LCD_SCLK  38
#define AMOLED_LCD_RESET 39
#define AMOLED_LCD_CS    12
#define AMOLED_LCD_WIDTH 480
#define AMOLED_LCD_HEIGHT 480

#define AMOLED_I2C_SDA 15
#define AMOLED_I2C_SCL 14
#define AMOLED_TOUCH_INT 11
#define AMOLED_TOUCH_RST 40

#define AMOLED_STATUS_BAR_HEIGHT 32
#define AMOLED_PREVIEW_Y 76
#define AMOLED_PREVIEW_SIZE 286
#define AMOLED_FOOTER_Y 384
#define AMOLED_FOOTER_HEIGHT 82

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

    void showThumbnailLoading();
    void setThumbnailJpeg(const uint8_t* data, size_t len, const char* cacheKey);
    void setThumbnailJpeg(std::vector<uint8_t>&& data, const char* cacheKey);
    void clearThumbnail();

    Arduino_GFX* getDisplay() { return _gfx; }

    static const int SCREEN_WIDTH = AMOLED_LCD_WIDTH;
    static const int SCREEN_HEIGHT = AMOLED_LCD_HEIGHT;

  protected:
    void onStatusChanged() override;

  private:
    Arduino_DataBus* _bus;
    Arduino_CO5300* _gfx;
    std::vector<uint8_t> _thumbnailJpeg;
    String _thumbnailCacheKey;
    bool _ready;
    bool _hasThumbnail;
    bool _thumbnailLoading;

    void drawStatusBar();
    void drawClimbHeader();
    void drawThumbnailFrame();
    void drawThumbnailImage();
    void drawFooter();
    void drawCenteredText(const char* text, int y, uint8_t size, uint16_t color);
    void drawTruncatedText(const char* text, int x, int y, uint8_t size, uint16_t color, int maxChars);
};

extern WaveshareAmoledDisplay Display;

#endif  // WAVESHARE_AMOLED_DISPLAY_H
