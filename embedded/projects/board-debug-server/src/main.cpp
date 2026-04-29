#include <Arduino.h>
#include <Wire.h>

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

#include <log_buffer.h>
#include <config_manager.h>
#include <esp_web_server.h>
#include <wifi_utils.h>

#include <aurora_protocol.h>
#include <nordic_uart_ble.h>
#include <moonboard_protocol.h>
#include <moonboard_uart_ble.h>

#include <ch422g.h>
#include <waveshare_display.h>

#include "aurora_frames.h"
#include "config/board_options.h"
#include "config/version.h"
#include "debug_state.h"
#include "render_fetcher.h"
#include "status_overlay.h"
#include "web_routes.h"

namespace {

LGFX_Waveshare7 gDisplay;
CH422G gIoExpander;
board_debug::StatusOverlay gOverlay;
board_debug::RenderFetcher gFetcher;

// Cross-callback handoff. The BLE callback runs in NimBLE's task; we don't want
// to do HTTP + PNG decode there. Instead the callback fills these fields and
// the main loop services the request.
struct PendingRender {
    bool valid = false;
    String frames;
    uint32_t enqueuedAtMs = 0;
};
PendingRender gPending;

bool gAuroraActive = false;   // which BLE flavor is currently advertised
bool gMoonBoardActive = false;
unsigned long gLastStatusBarMs = 0;

constexpr int16_t kScreenWidth = 480;   // portrait
constexpr int16_t kScreenHeight = 800;

void onWifiState(WiFiConnectionState state) {
    using board_debug::gRuntime;
    gRuntime.wifiConnected = (state == WiFiConnectionState::CONNECTED);
    gRuntime.apMode = (state == WiFiConnectionState::AP_MODE);
    gRuntime.wifiSsid = WiFiMgr.getSSID();
    gRuntime.ipAddress = WiFiMgr.isAPMode() ? WiFiMgr.getAPIP() : WiFiMgr.getIP();
    Logger.logln("[wifi] state %d ssid=%s ip=%s",
                 static_cast<int>(state), gRuntime.wifiSsid.c_str(), gRuntime.ipAddress.c_str());
}

void onAuroraConnect(bool connected) {
    using board_debug::gRuntime;
    gRuntime.bleConnected = connected;
    if (connected) gRuntime.connectedDeviceMac = BLE.getConnectedDeviceAddress();
    else gRuntime.connectedDeviceMac = "";
}

void onMoonBoardConnect(bool connected) {
    using board_debug::gRuntime;
    gRuntime.bleConnected = connected;
    // MoonBoardUartBLE doesn't expose MAC; leave empty.
    if (!connected) gRuntime.connectedDeviceMac = "";
}

void onAuroraLedData(const LedCommand* commands, int count, int /*angle*/) {
    using namespace board_debug;
    std::vector<LedCommand> leds(commands, commands + count);
    String frames = buildFramesString(leds, gConfig.board, gConfig.layoutId, gConfig.sizeId);
    if (frames.length() == 0) {
        Logger.logln("[aurora] %d LEDs, no placement map for %s/%u/%u",
                     count, boardNameToString(gConfig.board), gConfig.layoutId, gConfig.sizeId);
        return;
    }
    gPending.frames = frames;
    gPending.enqueuedAtMs = millis();
    gPending.valid = true;
}

void onMoonBoardProblem(const MoonBoardDecodedProblem& problem) {
    if (problem.frames.length() == 0) return;
    gPending.frames = problem.frames;
    gPending.enqueuedAtMs = millis();
    gPending.valid = true;
}

void stopBle() {
    if (gAuroraActive) {
        BLE.disconnectClient();
        // NimBLE doesn't expose a clean teardown via the wrapper; ESP.restart()
        // is the reliable path when the user changes board type. Web handler
        // sets the restart flag for that.
    }
}

void startBle() {
    using namespace board_debug;
    if (isMoonBoardBoard(gConfig.board)) {
        MoonBLE.begin(gConfig.deviceName.c_str(), true);
        MoonBLE.setConnectCallback(onMoonBoardConnect);
        MoonBLE.setProblemCallback(onMoonBoardProblem);
        gMoonBoardActive = true;
        gAuroraActive = false;
    } else if (isAuroraBoard(gConfig.board)) {
        // Aurora apps key off the device-name suffix `@N` to negotiate API level.
        String name = gConfig.deviceName;
        if (name.indexOf('@') < 0) {
            name += "@";
            name += String(gConfig.apiLevel);
        }
        BLE.begin(name.c_str(), true);
        BLE.setConnectCallback(onAuroraConnect);
        BLE.setLedDataCallback(onAuroraLedData);
        gAuroraActive = true;
        gMoonBoardActive = false;
    }
    Logger.logln("[ble] advertising as '%s' (board=%s)",
                 gConfig.deviceName.c_str(), board_debug::boardNameToString(gConfig.board));
}

void servicePendingRender() {
    if (!gPending.valid) return;
    using namespace board_debug;

    RenderRequest req;
    req.board = gConfig.board;
    req.layoutId = gConfig.layoutId;
    req.sizeId = gConfig.sizeId;
    req.setIdsCsv = gConfig.setIdsCsv;
    req.angle = gConfig.angle;
    req.frames = gPending.frames;

    gRuntime.lastFrames = gPending.frames;
    gRuntime.lastFramesAtMs = gPending.enqueuedAtMs;
    gRuntime.framesRevision++;
    gPending.valid = false;

    if (!gRuntime.wifiConnected) {
        gRuntime.lastRenderOutcome = RenderOutcome::NETWORK_ERROR;
        gRuntime.lastRenderError = "wifi offline";
        gOverlay.drawError("WiFi offline");
        return;
    }

    const RenderResult res = gFetcher.fetchAndDisplay(req);
    gRuntime.lastHttpCode = res.httpCode;
    gRuntime.lastRenderMs = res.fetchMs + res.drawMs;
    gRuntime.lastRenderAtMs = millis();
    gRuntime.lastRenderUrl = gFetcher.lastUrl();
    gRuntime.lastRenderError = gFetcher.lastError();
    switch (res.status) {
        case RenderStatus::OK:             gRuntime.lastRenderOutcome = RenderOutcome::OK; break;
        case RenderStatus::NETWORK_ERROR:  gRuntime.lastRenderOutcome = RenderOutcome::NETWORK_ERROR; break;
        case RenderStatus::HTTP_ERROR:     gRuntime.lastRenderOutcome = RenderOutcome::HTTP_ERROR; break;
        case RenderStatus::BODY_TOO_LARGE: gRuntime.lastRenderOutcome = RenderOutcome::BODY_TOO_LARGE; break;
        case RenderStatus::DECODE_ERROR:   gRuntime.lastRenderOutcome = RenderOutcome::DECODE_ERROR; break;
    }

    if (res.status != RenderStatus::OK) {
        gOverlay.drawError(gRuntime.lastRenderError.c_str());
    } else {
        gOverlay.drawStatusBar();
    }
}

void initDisplay() {
    Wire.begin(WS_I2C_SDA, WS_I2C_SCL);
    gIoExpander.begin(Wire);
    gIoExpander.resetLCD();
    gIoExpander.resetTouch();
    gIoExpander.setBacklight(false);
    delay(100);

    gDisplay.init();
    gDisplay.setRotation(1);  // portrait 480x800
    gDisplay.fillScreen(0x0000);

    gIoExpander.setBacklight(true);

    gOverlay.begin(&gDisplay, kScreenWidth, kScreenHeight);
    gFetcher.begin(&gDisplay,
                   gOverlay.imageAreaX(), gOverlay.imageAreaY(),
                   gOverlay.imageAreaWidth(), gOverlay.imageAreaHeight());
}

}  // namespace

void setup() {
    Serial.begin(115200);
    delay(800);

    Logger.logln("=================================");
    Logger.logln("%s v%s", DEVICE_NAME, FIRMWARE_VERSION);
    Logger.logln("env: %s", FIRMWARE_BUILD_ENV);
    Logger.logln("=================================");

    Config.begin();
    board_debug::loadConfig();

    initDisplay();
    gOverlay.drawIdle();

    WiFiMgr.begin();
    WiFiMgr.setStateCallback(onWifiState);
    if (!WiFiMgr.connectSaved()) {
#if defined(DEFAULT_WIFI_SSID) && defined(DEFAULT_WIFI_PASSWORD)
        // Compile-time fallback baked from .env (gitignored); used when NVS is
        // empty. WiFiMgr.connect persists creds, so this only runs on first boot.
        Logger.logln("[wifi] no saved creds; trying compiled-in default SSID");
        if (!WiFiMgr.connect(DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASSWORD, true)) {
            WiFiMgr.startAP();
        }
#else
        WiFiMgr.startAP();
#endif
    }

    startBle();

    WebConfig.begin();
    board_debug::registerDebugRoutes();

    Logger.logln("[setup] ready");
}

void loop() {
    WiFiMgr.loop();
    if (gAuroraActive) BLE.loop();
    if (gMoonBoardActive) MoonBLE.loop();
    WebConfig.loop();

    servicePendingRender();

    // Check if the web UI asked for a BLE rebuild (board type / device name /
    // API level changed). The cleanest way is a full restart — NimBLE's tear-
    // down path is fragile and we already serialized config to NVS.
    if (board_debug::consumeBleRestartFlag()) {
        Logger.logln("[main] BLE restart requested via web; rebooting");
        delay(200);
        ESP.restart();
    }

    // Refresh the status bar ~1Hz so the BLE/WiFi pills stay current.
    const unsigned long now = millis();
    if (now - gLastStatusBarMs > 1000) {
        gLastStatusBarMs = now;
        // Don't redraw the bar over an idle splash — only after we've drawn
        // a render or error frame.
        if (board_debug::gRuntime.lastFramesAtMs > 0 ||
            board_debug::gRuntime.lastRenderOutcome != board_debug::RenderOutcome::NONE) {
            gOverlay.drawStatusBar();
        } else {
            gOverlay.drawIdle();
        }
    }
}
