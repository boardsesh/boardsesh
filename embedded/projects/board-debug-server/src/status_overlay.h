#ifndef BOARD_DEBUG_STATUS_OVERLAY_H
#define BOARD_DEBUG_STATUS_OVERLAY_H

#include <Arduino.h>

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

namespace board_debug {

// Always-on top status band + idle splash for the 7" panel. Independent of
// WaveshareDisplay (the production climb-info UI in the libs) — we paint
// directly on the LGFX device with our own simple layout.
class StatusOverlay {
  public:
    static constexpr int16_t kBarHeight = 40;

    void begin(LGFX_Device* display, int16_t screenWidth, int16_t screenHeight);

    // Drawn over a black background when no frames have arrived yet.
    void drawIdle();

    // Drawn after every render to refresh just the top bar without disturbing
    // the rendered climb image below.
    void drawStatusBar();

    // Used by the idle splash and as a fallback if a render fails badly.
    void drawError(const char* message);

    int16_t imageAreaY() const { return kBarHeight; }
    int16_t imageAreaHeight() const { return _screenHeight - kBarHeight; }
    int16_t imageAreaX() const { return 0; }
    int16_t imageAreaWidth() const { return _screenWidth; }

  private:
    LGFX_Device* _display = nullptr;
    int16_t _screenWidth = 0;
    int16_t _screenHeight = 0;

    void drawQrCode(int16_t cx, int16_t cy, const String& text);
    String buildConfigSummary() const;
};

}  // namespace board_debug

#endif
