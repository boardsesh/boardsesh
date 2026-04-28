#ifndef BOARD_DEBUG_RENDER_FETCHER_H
#define BOARD_DEBUG_RENDER_FETCHER_H

#include <Arduino.h>

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

#include "config/board_options.h"

namespace board_debug {

struct RenderRequest {
    BoardName board;
    uint16_t layoutId;
    uint16_t sizeId;
    String setIdsCsv;  // e.g. "1,20"
    int16_t angle;     // -1 for "no angle param"
    String frames;     // e.g. "p4210r42p4212r43..."
};

enum class RenderStatus : uint8_t {
    OK,
    NETWORK_ERROR,    // could not reach boardsesh.com
    HTTP_ERROR,       // non-200 response
    BODY_TOO_LARGE,   // image exceeded the buffer cap
    DECODE_ERROR,     // PNG decode failed
};

struct RenderResult {
    RenderStatus status;
    int httpCode;       // -1 if no response
    size_t bytes;       // body length downloaded
    uint32_t fetchMs;   // time spent in HTTP GET
    uint32_t drawMs;    // time spent in drawPng
};

class RenderFetcher {
  public:
    void begin(LGFX_Device* display, int16_t targetX, int16_t targetY,
               int16_t targetWidth, int16_t targetHeight);

    RenderResult fetchAndDisplay(const RenderRequest& request);

    String lastError() const { return _lastError; }
    String lastUrl() const { return _lastUrl; }

  private:
    LGFX_Device* _display = nullptr;
    int16_t _targetX = 0;
    int16_t _targetY = 0;
    int16_t _targetWidth = 0;
    int16_t _targetHeight = 0;
    String _lastError;
    String _lastUrl;

    String buildUrl(const RenderRequest& request) const;
};

}  // namespace board_debug

#endif
