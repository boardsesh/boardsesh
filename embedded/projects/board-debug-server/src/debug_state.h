#ifndef BOARD_DEBUG_STATE_H
#define BOARD_DEBUG_STATE_H

#include <Arduino.h>

#include "config/board_options.h"

namespace board_debug {

// Persisted in NVS via ConfigManager.
struct DeviceConfig {
    BoardName board = BoardName::KILTER;
    uint16_t layoutId = 1;
    uint16_t sizeId = 7;
    String setIdsCsv = "1,20";
    int16_t angle = 40;
    String deviceName = "Kilter A1";
    uint8_t apiLevel = 3;  // Aurora API v3 only; harmless for MoonBoard.
};

enum class RenderOutcome : uint8_t {
    NONE,
    OK,
    NETWORK_ERROR,
    HTTP_ERROR,
    BODY_TOO_LARGE,
    DECODE_ERROR,
};

const char* renderOutcomeToString(RenderOutcome outcome);

// Mutable runtime state, updated from main.cpp's loop and read by the web routes
// + status overlay. Volatile-ish; we don't need cross-core sync because BLE
// callbacks set fields and the main loop reads them — both run on core 0/1 with
// natural happens-before via the FreeRTOS scheduler tick. If a torn read of a
// String shows up under load we'll add a mutex.
struct RuntimeState {
    bool wifiConnected = false;
    bool apMode = false;
    String wifiSsid;
    String ipAddress;

    bool bleConnected = false;
    String connectedDeviceMac;

    // Last frames string the firmware acted on (whether render succeeded or not).
    String lastFrames;
    uint32_t lastFramesAtMs = 0;
    uint32_t framesRevision = 0;

    RenderOutcome lastRenderOutcome = RenderOutcome::NONE;
    int lastHttpCode = 0;
    uint32_t lastRenderMs = 0;
    uint32_t lastRenderAtMs = 0;
    String lastRenderUrl;
    String lastRenderError;
};

extern DeviceConfig gConfig;
extern RuntimeState gRuntime;

void loadConfig();
void saveConfig();

}  // namespace board_debug

#endif
