#include "waveshare_amoled_display.h"

#include <Wire.h>
#include <config_manager.h>
#include <grade_colors.h>
#include <utility>

WaveshareAmoledDisplay Display;

namespace {

Arduino_GFX* g_jpegGfx = nullptr;

int drawJpegBlock(JPEGDRAW* draw) {
    if (!g_jpegGfx || !draw) return 0;
    g_jpegGfx->draw16bitRGBBitmap(draw->x, draw->y, draw->pPixels, draw->iWidth, draw->iHeight);
    return 1;
}

const char* safeText(const char* value, const char* fallback = "") {
    return value && value[0] != '\0' ? value : fallback;
}

uint16_t statusColor(bool active) {
    return active ? COLOR_STATUS_OK : COLOR_STATUS_OFF;
}

}  // namespace

WaveshareAmoledDisplay::WaveshareAmoledDisplay()
    : _bus(new Arduino_ESP32QSPI(AMOLED_LCD_CS,
                                 AMOLED_LCD_SCLK,
                                 AMOLED_LCD_SDIO0,
                                 AMOLED_LCD_SDIO1,
                                 AMOLED_LCD_SDIO2,
                                 AMOLED_LCD_SDIO3)),
      _gfx(new Arduino_CO5300(_bus,
                              AMOLED_LCD_RESET,
                              0,
                              AMOLED_LCD_WIDTH,
                              AMOLED_LCD_HEIGHT,
                              0,
                              0,
                              0,
                              0)),
      _ready(false),
      _hasThumbnail(false),
      _thumbnailLoading(false) {}

WaveshareAmoledDisplay::~WaveshareAmoledDisplay() {
    delete _gfx;
    delete _bus;
}

bool WaveshareAmoledDisplay::begin() {
    Wire.begin(AMOLED_I2C_SDA, AMOLED_I2C_SCL);
    _ready = false;

    if (!_gfx || !_gfx->begin()) {
        return false;
    }

    _bus->writeC8D8(0x36, 0xA0);
    _gfx->fillScreen(COLOR_BACKGROUND);
    _gfx->setBrightness(static_cast<uint8_t>(Config.getInt("disp_br", 180)));
    _gfx->setTextWrap(false);

    _gfx->fillScreen(0xF800);
    delay(120);
    _gfx->fillScreen(0x07E0);
    delay(120);
    _gfx->fillScreen(0x001F);
    delay(120);
    _gfx->fillScreen(COLOR_BACKGROUND);

    _ready = true;
    return true;
}

void WaveshareAmoledDisplay::showConnecting() {
    if (!_ready) return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("Boardsesh", 152, 3, COLOR_ACCENT);
    drawCenteredText("Connecting...", 222, 2, COLOR_TEXT);
    drawCenteredText("Waiting for WiFi and session", 258, 1, COLOR_TEXT_DIM);
    drawStatusBar();
}

void WaveshareAmoledDisplay::showError(const char* message, const char* ipAddress) {
    if (!_ready) return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("Error", 150, 3, COLOR_STATUS_ERROR);
    drawCenteredText(safeText(message, "Something went wrong"), 218, 2, COLOR_TEXT);
    if (ipAddress && ipAddress[0] != '\0') {
        drawCenteredText(ipAddress, 260, 1, COLOR_TEXT_DIM);
    }
    drawStatusBar();
}

void WaveshareAmoledDisplay::showConfigPortal(const char* apName, const char* ip) {
    if (!_ready) return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("WiFi Setup", 86, 3, COLOR_ACCENT);
    drawCenteredText("Join this network", 154, 2, COLOR_TEXT);
    drawCenteredText(safeText(apName, "Boardsesh Setup"), 202, 2, COLOR_STATUS_OK);
    drawCenteredText("Then open", 282, 2, COLOR_TEXT);
    drawCenteredText(safeText(ip, "192.168.4.1"), 328, 2, COLOR_ACCENT);
}

void WaveshareAmoledDisplay::showSetupScreen(const char* apName) {
    showConfigPortal(apName, "192.168.4.1");
}

void WaveshareAmoledDisplay::showThumbnailLoading() {
    if (!_ready) return;
    _thumbnailJpeg.clear();
    _thumbnailCacheKey = "";
    _hasThumbnail = false;
    _thumbnailLoading = true;
    refresh();
}

void WaveshareAmoledDisplay::setThumbnailJpeg(const uint8_t* data, size_t len, const char* cacheKey) {
    if (!_ready) return;
    _thumbnailJpeg.clear();
    _thumbnailCacheKey = cacheKey ? cacheKey : "";
    _thumbnailLoading = false;

    if (!data || len == 0) {
        _hasThumbnail = false;
        refresh();
        return;
    }

    _thumbnailJpeg.assign(data, data + len);
    _hasThumbnail = true;
    refresh();
}

void WaveshareAmoledDisplay::setThumbnailJpeg(std::vector<uint8_t>&& data, const char* cacheKey) {
    if (!_ready) return;
    _thumbnailJpeg = std::move(data);
    _thumbnailCacheKey = cacheKey ? cacheKey : "";
    _thumbnailLoading = false;
    _hasThumbnail = !_thumbnailJpeg.empty();
    refresh();
}

void WaveshareAmoledDisplay::clearThumbnail() {
    _thumbnailJpeg.clear();
    _thumbnailCacheKey = "";
    _hasThumbnail = false;
    _thumbnailLoading = false;
}

void WaveshareAmoledDisplay::refresh() {
    if (!_ready) return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawStatusBar();

    if (!_hasClimb) {
        drawCenteredText("No climb selected", 188, 2, COLOR_TEXT);
        drawCenteredText("Send a climb over Bluetooth", 232, 1, COLOR_TEXT_DIM);
        drawFooter();
        return;
    }

    drawClimbHeader();
    drawThumbnailFrame();
    drawFooter();
}

void WaveshareAmoledDisplay::refreshInfoOnly() {
    refresh();
}

void WaveshareAmoledDisplay::onStatusChanged() {
    if (!_ready) return;
    drawStatusBar();
}

void WaveshareAmoledDisplay::drawStatusBar() {
    _gfx->fillRect(0, 0, SCREEN_WIDTH, AMOLED_STATUS_BAR_HEIGHT, 0x1082);
    _gfx->drawFastHLine(0, AMOLED_STATUS_BAR_HEIGHT - 1, SCREEN_WIDTH, 0x2945);

    _gfx->setTextSize(1);
    _gfx->setTextColor(COLOR_TEXT_DIM);
    _gfx->setCursor(12, 11);
    _gfx->print("Boardsesh");

    int dotX = SCREEN_WIDTH - 114;
    _gfx->fillCircle(dotX, 16, 5, statusColor(_wifiConnected));
    _gfx->setCursor(dotX + 10, 11);
    _gfx->print("W");

    dotX += 36;
    _gfx->fillCircle(dotX, 16, 5, statusColor(_backendConnected));
    _gfx->setCursor(dotX + 10, 11);
    _gfx->print("B");

    dotX += 36;
    _gfx->fillCircle(dotX, 16, 5, statusColor(_bleConnected));
    _gfx->setCursor(dotX + 10, 11);
    _gfx->print("BLE");
}

void WaveshareAmoledDisplay::drawClimbHeader() {
    String displayName = _climbName;
    if (displayName.length() == 0) {
        displayName = "Unknown Climb";
    }

    drawTruncatedText(displayName.c_str(), 18, 44, 2, COLOR_TEXT, 28);

    uint16_t gradeColor = DisplayBase::hexToRgb565(_gradeColor.c_str());
    int badgeX = SCREEN_WIDTH - 86;
    _gfx->fillRoundRect(badgeX, 42, 68, 28, 8, gradeColor);
    _gfx->drawRoundRect(badgeX, 42, 68, 28, 8, 0xFFFF);
    _gfx->setTextColor(COLOR_BACKGROUND);
    _gfx->setTextSize(1);
    const char* grade = _grade.length() > 0 ? _grade.c_str() : "?";
    int gradeWidth = static_cast<int>(strlen(grade)) * 6;
    _gfx->setCursor(badgeX + (68 - gradeWidth) / 2, 52);
    _gfx->print(grade);
}

void WaveshareAmoledDisplay::drawThumbnailFrame() {
    int frameX = (SCREEN_WIDTH - AMOLED_PREVIEW_SIZE) / 2;
    _gfx->fillRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6,
                        AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12,
                        10, 0x0841);
    _gfx->drawRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6,
                        AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12,
                        10, 0x4208);

    if (_thumbnailLoading) {
        drawCenteredText("Loading preview", AMOLED_PREVIEW_Y + 128, 2, COLOR_TEXT_DIM);
        return;
    }

    if (!_hasThumbnail || _thumbnailJpeg.empty()) {
        drawCenteredText("Preview unavailable", AMOLED_PREVIEW_Y + 128, 2, COLOR_TEXT_DIM);
        return;
    }

    drawThumbnailImage();
}

void WaveshareAmoledDisplay::drawThumbnailImage() {
    JPEGDEC jpeg;
    if (!jpeg.openRAM(_thumbnailJpeg.data(), static_cast<int>(_thumbnailJpeg.size()), drawJpegBlock)) {
        drawCenteredText("Preview decode failed", AMOLED_PREVIEW_Y + 128, 1, COLOR_STATUS_ERROR);
        return;
    }

    int imageWidth = jpeg.getWidth();
    int imageHeight = jpeg.getHeight();
    int imageX = (SCREEN_WIDTH - imageWidth) / 2;
    int imageY = AMOLED_PREVIEW_Y + (AMOLED_PREVIEW_SIZE - imageHeight) / 2;
    if (imageY < AMOLED_PREVIEW_Y) {
        imageY = AMOLED_PREVIEW_Y;
    }

    g_jpegGfx = _gfx;
    jpeg.decode(imageX, imageY, 0);
    jpeg.close();
    g_jpegGfx = nullptr;
}

void WaveshareAmoledDisplay::drawFooter() {
    _gfx->fillRect(0, AMOLED_FOOTER_Y, SCREEN_WIDTH, AMOLED_FOOTER_HEIGHT, 0x0841);
    _gfx->drawFastHLine(0, AMOLED_FOOTER_Y, SCREEN_WIDTH, 0x2945);

    if (_hasNavigation && _queueTotal > 0) {
        char positionText[32];
        snprintf(positionText, sizeof(positionText), "%d / %d", _queueIndex + 1, _queueTotal);
        drawCenteredText(positionText, AMOLED_FOOTER_Y + 14, 1, COLOR_TEXT_DIM);
    } else if (_queueCount > 0) {
        char positionText[32];
        snprintf(positionText, sizeof(positionText), "%d queued", _queueCount);
        drawCenteredText(positionText, AMOLED_FOOTER_Y + 14, 1, COLOR_TEXT_DIM);
    }

    const LocalQueueItem* nextItem = getNextQueueItem();
    if (nextItem && nextItem->isValid()) {
        _gfx->setTextSize(1);
        _gfx->setTextColor(COLOR_TEXT_DIM);
        _gfx->setCursor(18, AMOLED_FOOTER_Y + 42);
        _gfx->print("Next:");
        drawTruncatedText(nextItem->name, 58, AMOLED_FOOTER_Y + 42, 1, COLOR_TEXT, 42);
    } else if (_hasNavigation && _nextClimb.isValid) {
        _gfx->setTextSize(1);
        _gfx->setTextColor(COLOR_TEXT_DIM);
        _gfx->setCursor(18, AMOLED_FOOTER_Y + 42);
        _gfx->print("Next:");
        drawTruncatedText(_nextClimb.name.c_str(), 58, AMOLED_FOOTER_Y + 42, 1, COLOR_TEXT, 42);
    }
}

void WaveshareAmoledDisplay::drawCenteredText(const char* text, int y, uint8_t size, uint16_t color) {
    const char* printable = safeText(text);
    int textWidth = static_cast<int>(strlen(printable)) * 6 * size;
    int x = (SCREEN_WIDTH - textWidth) / 2;
    if (x < 0) x = 0;

    _gfx->setTextSize(size);
    _gfx->setTextColor(color);
    _gfx->setCursor(x, y);
    _gfx->print(printable);
}

void WaveshareAmoledDisplay::drawTruncatedText(const char* text,
                                               int x,
                                               int y,
                                               uint8_t size,
                                               uint16_t color,
                                               int maxChars) {
    const char* printable = safeText(text);
    char buffer[80];
    size_t textLen = strlen(printable);
    size_t limit = maxChars > 0 ? static_cast<size_t>(maxChars) : sizeof(buffer) - 1;
    if (limit >= sizeof(buffer)) limit = sizeof(buffer) - 1;

    if (textLen > limit && limit > 3) {
        memcpy(buffer, printable, limit - 3);
        buffer[limit - 3] = '.';
        buffer[limit - 2] = '.';
        buffer[limit - 1] = '.';
        buffer[limit] = '\0';
    } else {
        size_t copyLen = textLen < sizeof(buffer) - 1 ? textLen : sizeof(buffer) - 1;
        memcpy(buffer, printable, copyLen);
        buffer[copyLen] = '\0';
    }

    _gfx->setTextSize(size);
    _gfx->setTextColor(color);
    _gfx->setCursor(x, y);
    _gfx->print(buffer);
}
