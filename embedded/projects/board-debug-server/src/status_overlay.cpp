#include "status_overlay.h"

#include <qrcode.h>

#include "config/board_options.h"
#include "debug_state.h"

namespace board_debug {

namespace {

constexpr uint32_t kColorBg       = 0x0C1118;  // page background
constexpr uint32_t kColorBar      = 0x131C26;
constexpr uint32_t kColorBarLine  = 0x25313F;
constexpr uint32_t kColorText     = 0xE2ECF5;
constexpr uint32_t kColorMuted    = 0x94A8BB;
constexpr uint32_t kColorAccent   = 0xFFE066;
constexpr uint32_t kColorOk       = 0x1FB36A;
constexpr uint32_t kColorWarn     = 0xD3496E;

uint16_t toRgb565(uint32_t rgb) {
    const uint8_t r = (rgb >> 16) & 0xFF;
    const uint8_t g = (rgb >> 8) & 0xFF;
    const uint8_t b = rgb & 0xFF;
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}

}  // namespace

void StatusOverlay::begin(LGFX_Device* display, int16_t screenWidth, int16_t screenHeight) {
    _display = display;
    _screenWidth = screenWidth;
    _screenHeight = screenHeight;
}

String StatusOverlay::buildConfigSummary() const {
    String s;
    s += boardNameToString(gConfig.board);
    s += " · L";
    s += String(gConfig.layoutId);
    s += " · S";
    s += String(gConfig.sizeId);
    if (gConfig.setIdsCsv.length() > 0) {
        s += " · sets ";
        s += gConfig.setIdsCsv;
    }
    if (gConfig.angle >= 0) {
        s += " · ";
        s += String(gConfig.angle);
        s += "°";
    }
    return s;
}

void StatusOverlay::drawStatusBar() {
    if (!_display) return;
    _display->fillRect(0, 0, _screenWidth, kBarHeight, toRgb565(kColorBar));
    _display->drawFastHLine(0, kBarHeight - 1, _screenWidth, toRgb565(kColorBarLine));

    _display->setTextColor(toRgb565(kColorText), toRgb565(kColorBar));
    _display->setTextSize(2);
    _display->setCursor(12, 12);
    _display->print(buildConfigSummary());

    // Right-aligned chips: BLE then WiFi.
    auto drawChip = [&](int16_t rightEdge, const char* text, bool on) -> int16_t {
        _display->setTextSize(2);
        const int16_t w = _display->textWidth(text) + 16;
        const int16_t h = kBarHeight - 12;
        const int16_t x = rightEdge - w;
        const int16_t y = (kBarHeight - h) / 2;
        _display->fillRoundRect(x, y, w, h, 6, toRgb565(on ? kColorOk : kColorWarn));
        _display->setTextColor(toRgb565(kColorBg), toRgb565(on ? kColorOk : kColorWarn));
        _display->setCursor(x + 8, y + (h - 14) / 2);
        _display->print(text);
        return x - 8;
    };

    int16_t right = _screenWidth - 12;
    right = drawChip(right, gRuntime.bleConnected ? "BLE OK" : "BLE …", gRuntime.bleConnected);
    right = drawChip(right, gRuntime.wifiConnected ? "WiFi OK" : (gRuntime.apMode ? "AP" : "WiFi …"),
                     gRuntime.wifiConnected);
    (void)right;
}

void StatusOverlay::drawIdle() {
    if (!_display) return;
    _display->fillScreen(toRgb565(kColorBg));
    drawStatusBar();

    _display->setTextColor(toRgb565(kColorAccent), toRgb565(kColorBg));
    _display->setTextSize(3);
    const char* title = "Boardsesh debug rig";
    const int16_t titleW = _display->textWidth(title);
    _display->setCursor((_screenWidth - titleW) / 2, kBarHeight + 40);
    _display->print(title);

    _display->setTextSize(2);
    _display->setTextColor(toRgb565(kColorText), toRgb565(kColorBg));
    String line = "Connect from the app to ";
    line += gConfig.deviceName.length() > 0 ? gConfig.deviceName : String("(no name)");
    int16_t lineW = _display->textWidth(line);
    _display->setCursor((_screenWidth - lineW) / 2, kBarHeight + 90);
    _display->print(line);

    _display->setTextColor(toRgb565(kColorMuted), toRgb565(kColorBg));
    if (gRuntime.wifiConnected && gRuntime.ipAddress.length() > 0) {
        String url = "http://" + gRuntime.ipAddress + "/";
        const int16_t urlW = _display->textWidth(url);
        _display->setCursor((_screenWidth - urlW) / 2, kBarHeight + 130);
        _display->print(url);
        drawQrCode(_screenWidth / 2, kBarHeight + 200 + 90, url);
    } else {
        const char* hint = "Connect WiFi via the AP captive portal first.";
        const int16_t hintW = _display->textWidth(hint);
        _display->setCursor((_screenWidth - hintW) / 2, kBarHeight + 130);
        _display->print(hint);
    }
}

void StatusOverlay::drawError(const char* message) {
    if (!_display) return;
    drawStatusBar();
    _display->setTextColor(toRgb565(kColorWarn), toRgb565(kColorBg));
    _display->setTextSize(2);
    const int16_t y = _screenHeight - 28;
    _display->fillRect(0, y - 8, _screenWidth, 28, toRgb565(kColorBg));
    _display->setCursor(12, y - 4);
    _display->print("Render error: ");
    _display->print(message);
}

void StatusOverlay::drawQrCode(int16_t cx, int16_t cy, const String& text) {
    QRCode qr;
    constexpr uint8_t version = 4;  // up to 50 alphanumeric chars at ECC level L; plenty for an IP URL.
    uint8_t buffer[qrcode_getBufferSize(version)];
    if (qrcode_initText(&qr, buffer, version, ECC_LOW, text.c_str()) != 0) return;

    const int16_t pixelSize = 6;
    const int16_t total = qr.size * pixelSize;
    const int16_t startX = cx - total / 2;
    const int16_t startY = cy - total / 2;
    _display->fillRect(startX - 6, startY - 6, total + 12, total + 12, toRgb565(kColorText));
    for (uint8_t y = 0; y < qr.size; y++) {
        for (uint8_t x = 0; x < qr.size; x++) {
            const uint16_t color = qrcode_getModule(&qr, x, y) ? toRgb565(kColorBg) : toRgb565(kColorText);
            _display->fillRect(startX + x * pixelSize, startY + y * pixelSize, pixelSize, pixelSize, color);
        }
    }
}

}  // namespace board_debug
