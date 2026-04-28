#ifndef BOARD_DEBUG_WEB_ROUTES_H
#define BOARD_DEBUG_WEB_ROUTES_H

namespace board_debug {

// Called from main once after WebConfig.begin() to attach our debug routes.
// The page is served at `/`, JSON endpoints under `/api/...`.
void registerDebugRoutes();

// Some config keys (board name, device name, api level) require a BLE
// reinitialization. The web POST handler sets this so the main loop can act on
// it on the next tick rather than from the HTTP handler context.
bool consumeBleRestartFlag();

}  // namespace board_debug

#endif
