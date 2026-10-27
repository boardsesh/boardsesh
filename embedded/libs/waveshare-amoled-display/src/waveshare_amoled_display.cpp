#include "waveshare_amoled_display.h"

#include <esp_heap_caps.h>

#include <Wire.h>
#ifdef ENABLE_BOARD_IMAGE
#include "preview_geometry.h"

#include <board_hold_data.h>
#endif
#include <config_manager.h>
#include <grade_colors.h>

WaveshareAmoledDisplay Display;

namespace {

// Arduino_Canvas otherwise allocates from the default heap. Keep the 450 KiB
// framebuffer in PSRAM so WiFi and BLE retain their internal-memory budget.
class PsramCanvas : public Arduino_Canvas {
  public:
    explicit PsramCanvas(Arduino_G* output) : Arduino_Canvas(AMOLED_LCD_WIDTH, AMOLED_LCD_HEIGHT, output) {}

    bool begin(int32_t speed = GFX_NOT_DEFINED) override {
        if (!_framebuffer) {
            size_t byteCount = static_cast<size_t>(AMOLED_LCD_WIDTH) * AMOLED_LCD_HEIGHT * sizeof(uint16_t);
            _framebuffer =
                static_cast<uint16_t*>(heap_caps_aligned_alloc(16, byteCount, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
            if (!_framebuffer)
                return false;
        }
        return Arduino_Canvas::begin(speed);
    }
};

constexpr uint8_t STATUS_PENDING = 0x80;

#ifdef ENABLE_BOARD_IMAGE
struct JpegPreviewTarget {
    amoled_preview::Geometry geometry;
    uint16_t* pixels;
    int stride;
    int offsetX;
    int offsetY;
    int blockCount = 0;
};

int drawJpegPreviewBlock(JPEGDRAW* draw) {
    if (!draw || !draw->pUser || !draw->pPixels)
        return 0;
    JpegPreviewTarget* target = static_cast<JpegPreviewTarget*>(draw->pUser);
    target->blockCount++;
    amoled_preview::copyBlock(target->geometry, draw->pPixels, draw->iWidth, draw->x, draw->y, draw->iWidthUsed,
                              draw->iHeight, target->pixels, target->stride, target->offsetX, target->offsetY);
    yield();
    return 1;
}
#endif

const char* safeText(const char* value, const char* fallback = "") {
    return value && value[0] != '\0' ? value : fallback;
}

uint16_t statusColor(bool active) {
    return active ? COLOR_STATUS_OK : COLOR_STATUS_OFF;
}

#ifdef ENABLE_BOARD_IMAGE
const HoldMapEntry* findHoldMapEntry(const BoardConfig* cfg, uint16_t target) {
    if (!cfg || !cfg->holdMap)
        return nullptr;

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
    : _bus(new Arduino_ESP32QSPI(AMOLED_LCD_CS, AMOLED_LCD_SCLK, AMOLED_LCD_SDIO0, AMOLED_LCD_SDIO1, AMOLED_LCD_SDIO2,
                                 AMOLED_LCD_SDIO3)),
      _panel(new Arduino_CO5300(_bus, AMOLED_LCD_RESET, 0, AMOLED_LCD_WIDTH, AMOLED_LCD_HEIGHT, 0, 0, 0, 0)),
      _gfx(new PsramCanvas(_panel)), _ready(false), _blePreviewVisible(false), _pendingWiFiStatus(0),
      _pendingBackendStatus(0), _pendingBleStatus(0), _statusDirty(false)
#ifdef ENABLE_BOARD_IMAGE
      ,
      _hasBoardImage(false), _currentBoardConfig(nullptr), _cachedBoardConfig(nullptr), _boardImageCache(nullptr),
      _boardImageCacheWidth(0), _boardImageCacheHeight(0), _ledCommandCount(0), _lastJpegBlockCount(0),
      _lastJpegDecodeResult(0), _lastMatchedHoldCount(0)
#endif
{
}

WaveshareAmoledDisplay::~WaveshareAmoledDisplay() {
#ifdef ENABLE_BOARD_IMAGE
    clearBoardImageCache();
#endif
    delete _gfx;
    delete _panel;
    delete _bus;
}

bool WaveshareAmoledDisplay::begin() {
    Wire.begin(AMOLED_I2C_SDA, AMOLED_I2C_SCL);
    _ready = false;
    _blePreviewVisible = false;

    if (!_panel || !_gfx || !_panel->begin()) {
        return false;
    }

    // Preserve the board-specific scan direction without reinitializing the
    // physical output when the canvas begins.
    _bus->writeC8D8(0x36, 0xA0);
    if (!_gfx->begin(GFX_SKIP_OUTPUT_BEGIN)) {
        return false;
    }
    _gfx->fillScreen(COLOR_BACKGROUND);
    _panel->setBrightness(static_cast<uint8_t>(Config.getInt("disp_br", 180)));
    _gfx->setTextWrap(false);

    _gfx->fillScreen(0xF800);
    _gfx->flush();
    delay(120);
    _gfx->fillScreen(0x07E0);
    _gfx->flush();
    delay(120);
    _gfx->fillScreen(0x001F);
    _gfx->flush();
    delay(120);
    _gfx->fillScreen(COLOR_BACKGROUND);
    _gfx->flush();

    _ready = true;
    return true;
}

void WaveshareAmoledDisplay::showConnecting() {
    _blePreviewVisible = false;
    if (!_ready)
        return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("Boardsesh", 152, 3, COLOR_ACCENT);
    drawCenteredText("Connecting...", 222, 2, COLOR_TEXT);
    drawCenteredText("Waiting for WiFi and session", 258, 1, COLOR_TEXT_DIM);
    drawStatusBar();
    _gfx->flush();
}

void WaveshareAmoledDisplay::showError(const char* message, const char* ipAddress) {
    _blePreviewVisible = false;
    if (!_ready)
        return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("Error", 150, 3, COLOR_STATUS_ERROR);
    drawCenteredText(safeText(message, "Something went wrong"), 218, 2, COLOR_TEXT);
    if (ipAddress && ipAddress[0] != '\0') {
        drawCenteredText(ipAddress, 260, 1, COLOR_TEXT_DIM);
    }
    drawStatusBar();
    _gfx->flush();
}

void WaveshareAmoledDisplay::showConfigPortal(const char* apName, const char* ip) {
    _blePreviewVisible = false;
    if (!_ready)
        return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawCenteredText("WiFi Setup", 86, 3, COLOR_ACCENT);
    drawCenteredText("Join this network", 154, 2, COLOR_TEXT);
    drawCenteredText(safeText(apName, "Boardsesh Setup"), 202, 2, COLOR_STATUS_OK);
    drawCenteredText("Then open", 282, 2, COLOR_TEXT);
    drawCenteredText(safeText(ip, "192.168.4.1"), 328, 2, COLOR_ACCENT);
    _gfx->flush();
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
    _blePreviewVisible = false;
    if (!_ready)
        return;
    _gfx->fillScreen(COLOR_BACKGROUND);
    drawStatusBar();

    if (!_hasClimb) {
        drawCenteredText("No climb selected", 188, 2, COLOR_TEXT);
        drawCenteredText("Send a climb over Bluetooth", 232, 1, COLOR_TEXT_DIM);
        drawFooter();
        _gfx->flush();
        return;
    }

    drawClimbHeader();
    drawPreviewFrame();
    drawFooter();
    _gfx->flush();
}

void WaveshareAmoledDisplay::refreshInfoOnly() {
    refresh();
}

void WaveshareAmoledDisplay::showBlePreview(const char* boardType, int angle, bool fullRefresh) {
    if (!_ready)
        return;
    const char* previewBoardType = boardType ? boardType : "kilter";
    bool redrawScreen = fullRefresh || !_blePreviewVisible || _angle != angle || _boardType != previewBoardType;
    _climbName = "BLE Preview";
    _grade = "";
    _gradeColor = "";
    _angle = angle;
    _climbUuid = "";
    _boardType = previewBoardType;
    _hasClimb = true;

    if (redrawScreen) {
        refresh();
    } else {
        drawPreviewFrame();
        _gfx->flush();
    }
    _blePreviewVisible = true;
}

void WaveshareAmoledDisplay::onStatusChanged() {
    _statusDirty.store(true, std::memory_order_relaxed);
}

void WaveshareAmoledDisplay::setWiFiStatus(bool connected) {
    _pendingWiFiStatus.store(STATUS_PENDING | (connected ? 1 : 0), std::memory_order_relaxed);
}

void WaveshareAmoledDisplay::setBackendStatus(bool connected) {
    _pendingBackendStatus.store(STATUS_PENDING | (connected ? 1 : 0), std::memory_order_relaxed);
}

void WaveshareAmoledDisplay::setBleStatus(bool enabled, bool connected) {
    _pendingBleStatus.store(STATUS_PENDING | (enabled ? 1 : 0) | (connected ? 2 : 0), std::memory_order_relaxed);
}

void WaveshareAmoledDisplay::service() {
    if (!_ready)
        return;

    uint8_t wifiStatus = _pendingWiFiStatus.exchange(0, std::memory_order_relaxed);
    uint8_t backendStatus = _pendingBackendStatus.exchange(0, std::memory_order_relaxed);
    uint8_t bleStatus = _pendingBleStatus.exchange(0, std::memory_order_relaxed);
    if (wifiStatus & STATUS_PENDING)
        DisplayBase::setWiFiStatus((wifiStatus & 1) != 0);
    if (backendStatus & STATUS_PENDING)
        DisplayBase::setBackendStatus((backendStatus & 1) != 0);
    if (bleStatus & STATUS_PENDING)
        DisplayBase::setBleStatus((bleStatus & 1) != 0, (bleStatus & 2) != 0);

    if (_statusDirty.exchange(false, std::memory_order_relaxed)) {
        drawStatusBar();
        _gfx->flush();
    }
}

bool WaveshareAmoledDisplay::writeScreenshot(Print& output) {
    if (!_ready || !_gfx->getFramebuffer())
        return false;

    // All rendering and this capture run on the main loop. BLE callbacks only
    // update mailboxes, so these pixels remain stable throughout the transfer.
    service();
    const uint16_t* framebuffer = _gfx->getFramebuffer();
    constexpr char hexDigits[] = "0123456789abcdef";
    constexpr char beginLine[] = "\nBOARDSESH_SCREENSHOT_BEGIN 480 480 RGB565LE\n";
    constexpr char endLine[] = "\nBOARDSESH_SCREENSHOT_END\n";
    if (output.write(reinterpret_cast<const uint8_t*>(beginLine), sizeof(beginLine) - 1) != sizeof(beginLine) - 1) {
        return false;
    }

    char rowLine[AMOLED_LCD_WIDTH * 4 + 40];
    for (int row = 0; row < AMOLED_LCD_HEIGHT; row++) {
        size_t lineLength =
            static_cast<size_t>(snprintf(rowLine, sizeof(rowLine), "\nBOARDSESH_SCREENSHOT_ROW %d ", row));
        for (int column = 0; column < AMOLED_LCD_WIDTH; column++) {
            uint16_t pixel = framebuffer[row * AMOLED_LCD_WIDTH + column];
            // The protocol states byte order explicitly, independent of the
            // panel bus's RGB565 byte order.
            rowLine[lineLength++] = hexDigits[(pixel >> 4) & 0x0F];
            rowLine[lineLength++] = hexDigits[pixel & 0x0F];
            rowLine[lineLength++] = hexDigits[(pixel >> 12) & 0x0F];
            rowLine[lineLength++] = hexDigits[(pixel >> 8) & 0x0F];
        }
        rowLine[lineLength++] = '\n';
        if (output.write(reinterpret_cast<const uint8_t*>(rowLine), lineLength) != lineLength)
            return false;
        yield();
    }

    return output.write(reinterpret_cast<const uint8_t*>(endLine), sizeof(endLine) - 1) == sizeof(endLine) - 1;
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

    if (_grade.length() == 0)
        return;

    uint16_t gradeColor = DisplayBase::hexToRgb565(_gradeColor.c_str());
    int badgeX = SCREEN_WIDTH - 86;
    _gfx->fillRoundRect(badgeX, 42, 68, 28, 8, gradeColor);
    _gfx->drawRoundRect(badgeX, 42, 68, 28, 8, 0xFFFF);
    _gfx->setTextColor(COLOR_BACKGROUND);
    _gfx->setTextSize(1);
    const char* grade = _grade.c_str();
    int gradeWidth = static_cast<int>(strlen(grade)) * 6;
    _gfx->setCursor(badgeX + (68 - gradeWidth) / 2, 52);
    _gfx->print(grade);
}

void WaveshareAmoledDisplay::drawPreviewFrame() {
    int frameX = (SCREEN_WIDTH - AMOLED_PREVIEW_SIZE) / 2;
    _gfx->fillRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6, AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12, 10,
                        0x0841);
    _gfx->drawRoundRect(frameX - 6, AMOLED_PREVIEW_Y - 6, AMOLED_PREVIEW_SIZE + 12, AMOLED_PREVIEW_SIZE + 12, 10,
                        0x4208);

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

    amoled_preview::Geometry previewGeometry =
        amoled_preview::fit(config->imageWidth, config->imageHeight, AMOLED_PREVIEW_SIZE);
    int imageWidth = previewGeometry.width;
    int imageHeight = previewGeometry.height;
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

    if (!_jpegDecoder.openFLASH(config->imageData, static_cast<int>(config->imageSize), drawJpegPreviewBlock)) {
        clearBoardImageCache();
        return false;
    }

    JpegPreviewTarget target{previewGeometry, _boardImageCache, imageWidth, 0, 0};
    _jpegDecoder.setPixelType(RGB565_LITTLE_ENDIAN);
    _jpegDecoder.setUserPointer(&target);
    _lastJpegDecodeResult = _jpegDecoder.decode(0, 0, 0);
    _lastJpegBlockCount = target.blockCount;
    _jpegDecoder.close();
    _jpegDecoder.setUserPointer(nullptr);

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

    if (!_jpegDecoder.openFLASH(config->imageData, static_cast<int>(config->imageSize), drawJpegPreviewBlock)) {
        return false;
    }

    JpegPreviewTarget target{amoled_preview::fit(config->imageWidth, config->imageHeight, AMOLED_PREVIEW_SIZE),
                             _gfx->getFramebuffer(), SCREEN_WIDTH, imageX, imageY};
    _jpegDecoder.setPixelType(RGB565_LITTLE_ENDIAN);
    _jpegDecoder.setUserPointer(&target);
    _lastJpegDecodeResult = _jpegDecoder.decode(0, 0, 0);
    _lastJpegBlockCount = target.blockCount;
    _jpegDecoder.close();
    _jpegDecoder.setUserPointer(nullptr);

    return _lastJpegDecodeResult != 0 && _lastJpegBlockCount > 0;
}

void WaveshareAmoledDisplay::drawBoardImageWithHolds() {
    if (!_currentBoardConfig)
        return;

    const BoardConfig* cfg = _currentBoardConfig;
    amoled_preview::Geometry previewGeometry =
        amoled_preview::fit(cfg->imageWidth, cfg->imageHeight, AMOLED_PREVIEW_SIZE);

    _lastMatchedHoldCount = 0;

    int imageX = (SCREEN_WIDTH - AMOLED_PREVIEW_SIZE) / 2 + previewGeometry.offsetX;
    int imageY = AMOLED_PREVIEW_Y + previewGeometry.offsetY;

    bool imageDrawn = false;
    if (ensureBoardImageCache(cfg)) {
        _gfx->draw16bitRGBBitmap(imageX, imageY, _boardImageCache, _boardImageCacheWidth, _boardImageCacheHeight);
        imageDrawn = true;
    } else {
        imageDrawn = drawBoardImageDirect(cfg, imageX, imageY);
    }

    if (!imageDrawn) {
        drawCenteredText("Preview decode failed", AMOLED_PREVIEW_Y + AMOLED_PREVIEW_SIZE / 2 - 4, 1,
                         COLOR_STATUS_ERROR);
        return;
    }

    for (int i = 0; i < _ledCommandCount; i++) {
        uint16_t target = _ledCommands[i].position;
        const HoldMapEntry* hold = findHoldMapEntry(cfg, target);
        if (!hold && target < UINT16_MAX) {
            hold = findHoldMapEntry(cfg, target + 1);
        }
        if (!hold)
            continue;

        uint16_t color = _gfx->color565(_ledCommands[i].r, _ledCommands[i].g, _ledCommands[i].b);
        int dx = imageX + previewGeometry.coordinate(hold->cx);
        int dy = imageY + previewGeometry.coordinate(hold->cy);
        int radius = max(3, previewGeometry.boundary(hold->radius) + 1);
        _gfx->drawCircle(dx, dy, radius + 1, 0x0000);
        _gfx->drawCircle(dx, dy, radius, color);
        _gfx->drawCircle(dx, dy, radius - 1, color);
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
    if (x < 0)
        x = 0;

    _gfx->setTextSize(size);
    _gfx->setTextColor(color);
    _gfx->setCursor(x, y);
    _gfx->print(printable);
}

void WaveshareAmoledDisplay::drawTruncatedText(const char* text, int x, int y, uint8_t size, uint16_t color,
                                               int maxChars) {
    const char* printable = safeText(text);
    char buffer[80];
    size_t textLen = strlen(printable);
    size_t limit = maxChars > 0 ? static_cast<size_t>(maxChars) : sizeof(buffer) - 1;
    if (limit >= sizeof(buffer))
        limit = sizeof(buffer) - 1;

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
