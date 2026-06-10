#include "waveshare_amoled_display.h"

#include <Wire.h>
#ifdef ENABLE_BOARD_IMAGE
#include <board_hold_data.h>
#include <esp_heap_caps.h>
#endif
#include <config_manager.h>
#include <grade_colors.h>

WaveshareAmoledDisplay Display;

namespace {

Arduino_GFX* g_jpegGfx = nullptr;
uint16_t* g_jpegCache = nullptr;
int g_jpegCacheWidth = 0;
int g_jpegCacheHeight = 0;
int g_jpegBlockCount = 0;

int drawJpegBlockToDisplay(JPEGDRAW* draw) {
    if (!g_jpegGfx || !draw) return 0;
    g_jpegBlockCount++;
    g_jpegGfx->draw16bitBeRGBBitmap(draw->x, draw->y, draw->pPixels, draw->iWidth, draw->iHeight);
    yield();
    return 1;
}

int drawJpegBlockToCache(JPEGDRAW* draw) {
    if (!g_jpegCache || !draw) return 0;
    g_jpegBlockCount++;

    for (int row = 0; row < draw->iHeight; row++) {
        int destY = draw->y + row;
        if (destY < 0 || destY >= g_jpegCacheHeight) {
            continue;
        }

        int destX = draw->x;
        int copyWidth = draw->iWidth;
        const uint16_t* sourcePixels = draw->pPixels + (row * draw->iWidth);

        if (destX < 0) {
            int clippedPixels = -destX;
            sourcePixels += clippedPixels;
            copyWidth -= clippedPixels;
            destX = 0;
        }
        if (destX + copyWidth > g_jpegCacheWidth) {
            copyWidth = g_jpegCacheWidth - destX;
        }
        if (copyWidth <= 0) {
            continue;
        }

        memcpy(&g_jpegCache[destY * g_jpegCacheWidth + destX], sourcePixels, copyWidth * sizeof(uint16_t));
    }

    yield();
    return 1;
}

const char* safeText(const char* value, const char* fallback = "") {
    return value && value[0] != '\0' ? value : fallback;
}

uint16_t statusColor(bool active) {
    return active ? COLOR_STATUS_OK : COLOR_STATUS_OFF;
}

#ifdef ENABLE_BOARD_IMAGE
const HoldMapEntry* findHoldMapEntry(const BoardConfig* cfg, uint16_t target) {
    if (!cfg || !cfg->holdMap) return nullptr;

    int lo = 0;
    int hi = cfg->holdCount - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        uint16_t midPos = cfg->holdMap[mid].ledPosition;
        if (midPos == target) {
            return &cfg->holdMap[mid];
        }
        if (midPos < target) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return nullptr;
}
#endif

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
      _ready(false)
#ifdef ENABLE_BOARD_IMAGE
      ,
      _hasBoardImage(false),
      _currentBoardConfig(nullptr),
      _cachedBoardConfig(nullptr),
      _boardImageCache(nullptr),
      _boardImageCacheWidth(0),
      _boardImageCacheHeight(0),
      _ledCommandCount(0),
      _lastJpegBlockCount(0),
      _lastJpegDecodeResult(0),
      _lastMatchedHoldCount(0)
#endif
{}

WaveshareAmoledDisplay::~WaveshareAmoledDisplay() {
#ifdef ENABLE_BOARD_IMAGE
    clearBoardImageCache();
#endif
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

#ifdef ENABLE_BOARD_IMAGE
void WaveshareAmoledDisplay::setBoardConfig(const BoardConfig* config) {
    if (_currentBoardConfig != config) {
        clearBoardImageCache();
    }

    _currentBoardConfig = config;
    _hasBoardImage = config != nullptr;
    if (!_hasBoardImage) {
        _ledCommandCount = 0;
        _lastMatchedHoldCount = 0;
        _lastJpegBlockCount = 0;
        _lastJpegDecodeResult = 0;
    }
}

void WaveshareAmoledDisplay::setLedCommands(const LedCmd* commands, int count) {
    _ledCommandCount = min(count, MAX_LED_COMMANDS);
    if (commands && _ledCommandCount > 0) {
        memcpy(_ledCommands, commands, _ledCommandCount * sizeof(LedCmd));
    }
}
#endif

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
    drawPreviewFrame();
    drawFooter();
}

void WaveshareAmoledDisplay::refreshInfoOnly() {
    refresh();
}

void WaveshareAmoledDisplay::showBlePreview(const char* boardType, int angle, bool fullRefresh) {
    _climbName = "BLE Preview";
    _grade = "";
    _gradeColor = "";
    _angle = angle;
    _climbUuid = "";
    _boardType = boardType ? boardType : "kilter";
    _hasClimb = true;

    if (fullRefresh) {
        refresh();
        return;
    }

    if (!_ready) return;
    drawPreviewFrame();
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

void WaveshareAmoledDisplay::drawPreviewFrame() {
    int frameX = (SCREEN_WIDTH - AMOLED_PREVIEW_SIZE) / 2;
    _gfx->fillRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6,
                        AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12,
                        10, 0x0841);
    _gfx->drawRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6,
                        AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12,
                        10, 0x4208);

#ifdef ENABLE_BOARD_IMAGE
    if (!_hasBoardImage || !_currentBoardConfig) {
        drawCenteredText("Preview unavailable", AMOLED_PREVIEW_Y + AMOLED_PREVIEW_SIZE / 2 - 8, 2, COLOR_TEXT_DIM);
        return;
    }

    drawBoardImageWithHolds();
#else
    drawCenteredText("Preview unavailable", AMOLED_PREVIEW_Y + AMOLED_PREVIEW_SIZE / 2 - 8, 2, COLOR_TEXT_DIM);
#endif
}

#ifdef ENABLE_BOARD_IMAGE
void WaveshareAmoledDisplay::clearBoardImageCache() {
    if (_boardImageCache) {
        heap_caps_free(_boardImageCache);
        _boardImageCache = nullptr;
    }

    _cachedBoardConfig = nullptr;
    _boardImageCacheWidth = 0;
    _boardImageCacheHeight = 0;
}

bool WaveshareAmoledDisplay::ensureBoardImageCache(const BoardConfig* config) {
    if (!config) {
        return false;
    }
    if (_cachedBoardConfig == config && _boardImageCache) {
        return true;
    }

    clearBoardImageCache();

    int imageWidth = config->imageWidth / 2;
    int imageHeight = config->imageHeight / 2;
    if (imageWidth <= 0 || imageHeight <= 0) {
        return false;
    }

    size_t pixelCount = static_cast<size_t>(imageWidth) * static_cast<size_t>(imageHeight);
    size_t byteCount = pixelCount * sizeof(uint16_t);
    _boardImageCache = static_cast<uint16_t*>(heap_caps_malloc(byteCount, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!_boardImageCache) {
        return false;
    }

    memset(_boardImageCache, 0, byteCount);
    _boardImageCacheWidth = imageWidth;
    _boardImageCacheHeight = imageHeight;

    _lastJpegBlockCount = 0;
    _lastJpegDecodeResult = 0;

    if (!_jpegDecoder.openFLASH(config->imageData, static_cast<int>(config->imageSize), drawJpegBlockToCache)) {
        clearBoardImageCache();
        return false;
    }

    _jpegDecoder.setPixelType(RGB565_LITTLE_ENDIAN);
    g_jpegBlockCount = 0;
    g_jpegCache = _boardImageCache;
    g_jpegCacheWidth = _boardImageCacheWidth;
    g_jpegCacheHeight = _boardImageCacheHeight;
    _lastJpegDecodeResult = _jpegDecoder.decode(0, 0, JPEG_SCALE_HALF);
    _lastJpegBlockCount = g_jpegBlockCount;
    _jpegDecoder.close();
    g_jpegCache = nullptr;
    g_jpegCacheWidth = 0;
    g_jpegCacheHeight = 0;

    if (_lastJpegDecodeResult == 0 || _lastJpegBlockCount == 0) {
        clearBoardImageCache();
        return false;
    }

    _cachedBoardConfig = config;
    return true;
}

bool WaveshareAmoledDisplay::drawBoardImageDirect(const BoardConfig* config, int imageX, int imageY) {
    if (!config) {
        return false;
    }

    _lastJpegBlockCount = 0;
    _lastJpegDecodeResult = 0;

    if (!_jpegDecoder.openFLASH(config->imageData, static_cast<int>(config->imageSize), drawJpegBlockToDisplay)) {
        return false;
    }

    _jpegDecoder.setPixelType(RGB565_BIG_ENDIAN);
    g_jpegBlockCount = 0;
    g_jpegGfx = _gfx;
    _lastJpegDecodeResult = _jpegDecoder.decode(imageX, imageY, JPEG_SCALE_HALF);
    _lastJpegBlockCount = g_jpegBlockCount;
    _jpegDecoder.close();
    g_jpegGfx = nullptr;

    return _lastJpegDecodeResult != 0 && _lastJpegBlockCount > 0;
}

void WaveshareAmoledDisplay::drawBoardImageWithHolds() {
    if (!_currentBoardConfig) return;

    const BoardConfig* cfg = _currentBoardConfig;
    static const int jpegScaleDenominator = 2;

    _lastMatchedHoldCount = 0;

    int imageWidth = cfg->imageWidth / jpegScaleDenominator;
    int imageHeight = cfg->imageHeight / jpegScaleDenominator;
    int imageX = (SCREEN_WIDTH - imageWidth) / 2;
    int imageY = AMOLED_PREVIEW_Y + (AMOLED_PREVIEW_SIZE - imageHeight) / 2;
    if (imageY < AMOLED_PREVIEW_Y) {
        imageY = AMOLED_PREVIEW_Y;
    }

    bool imageDrawn = false;
    if (ensureBoardImageCache(cfg)) {
        _gfx->draw16bitRGBBitmap(imageX, imageY, _boardImageCache, _boardImageCacheWidth, _boardImageCacheHeight);
        imageDrawn = true;
    } else {
        imageDrawn = drawBoardImageDirect(cfg, imageX, imageY);
    }

    if (!imageDrawn) {
        drawCenteredText("Preview decode failed", AMOLED_PREVIEW_Y + AMOLED_PREVIEW_SIZE / 2 - 4, 1, COLOR_STATUS_ERROR);
        return;
    }

    for (int i = 0; i < _ledCommandCount; i++) {
        uint16_t target = _ledCommands[i].position;
        const HoldMapEntry* hold = findHoldMapEntry(cfg, target);
        if (!hold && target < UINT16_MAX) {
            hold = findHoldMapEntry(cfg, target + 1);
        }
        if (!hold) continue;

        uint16_t color = _gfx->color565(_ledCommands[i].r, _ledCommands[i].g, _ledCommands[i].b);
        int dx = imageX + hold->cx / jpegScaleDenominator;
        int dy = imageY + hold->cy / jpegScaleDenominator;
        int dr = max(8, hold->radius / jpegScaleDenominator + 2);
        int haloR = dr + 2;
        _gfx->fillCircle(dx, dy, haloR, 0x0000);
        _gfx->fillCircle(dx, dy, dr, color);
        _lastMatchedHoldCount++;
        if ((i & 0x0F) == 0) {
            yield();
        }
    }
}
#endif

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
