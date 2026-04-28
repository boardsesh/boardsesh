#include "debug_state.h"

#include <config_manager.h>

namespace board_debug {

DeviceConfig gConfig;
RuntimeState gRuntime;

namespace {

constexpr const char* kKeyBoard = "dbg_board";
constexpr const char* kKeyLayout = "dbg_layout";
constexpr const char* kKeySize = "dbg_size";
constexpr const char* kKeySets = "dbg_sets";
constexpr const char* kKeyAngle = "dbg_angle";
constexpr const char* kKeyDeviceName = "dbg_devname";
constexpr const char* kKeyApiLevel = "dbg_api";

// Snap a freshly loaded config back to a valid combo when stored values point
// at something the catalog no longer exposes (e.g. stale NVS after a firmware
// rev that dropped a layout).
void clampToCatalog(DeviceConfig& cfg) {
    if (!findBoard(cfg.board)) {
        cfg.board = BoardName::KILTER;
    }
    if (!findLayout(cfg.board, cfg.layoutId)) {
        const BoardCatalogEntry* entry = findBoard(cfg.board);
        if (entry && entry->layoutCount > 0) {
            cfg.layoutId = entry->layouts[0].id;
        }
    }
    const LayoutOption* layout = findLayout(cfg.board, cfg.layoutId);
    if (!layout || !findSize(cfg.board, cfg.layoutId, cfg.sizeId)) {
        if (layout && layout->sizeCount > 0) {
            cfg.sizeId = layout->sizes[0].id;
        }
    }
    const SizeOption* size = findSize(cfg.board, cfg.layoutId, cfg.sizeId);
    if (!size) return;

    // Filter setIdsCsv to those still valid for the new (board, layout, size).
    String filtered;
    int start = 0;
    while (start <= static_cast<int>(cfg.setIdsCsv.length())) {
        int end = cfg.setIdsCsv.indexOf(',', start);
        if (end < 0) end = cfg.setIdsCsv.length();
        if (end > start) {
            int id = cfg.setIdsCsv.substring(start, end).toInt();
            if (id > 0 && isValidSet(cfg.board, cfg.layoutId, cfg.sizeId, id)) {
                if (filtered.length() > 0) filtered += ",";
                filtered += String(id);
            }
        }
        start = end + 1;
    }
    if (filtered.length() == 0 && size->setCount > 0) {
        for (uint16_t i = 0; i < size->setCount; i++) {
            if (i > 0) filtered += ",";
            filtered += String(size->sets[i].id);
        }
    }
    cfg.setIdsCsv = filtered;
}

}  // namespace

const char* renderOutcomeToString(RenderOutcome outcome) {
    switch (outcome) {
        case RenderOutcome::NONE:           return "none";
        case RenderOutcome::OK:             return "ok";
        case RenderOutcome::NETWORK_ERROR:  return "network_error";
        case RenderOutcome::HTTP_ERROR:     return "http_error";
        case RenderOutcome::BODY_TOO_LARGE: return "body_too_large";
        case RenderOutcome::DECODE_ERROR:   return "decode_error";
    }
    return "unknown";
}

void loadConfig() {
    String boardStr = Config.getString(kKeyBoard, "kilter");
    gConfig.board = parseBoardName(boardStr.c_str());
    gConfig.layoutId = static_cast<uint16_t>(Config.getInt(kKeyLayout, 1));
    gConfig.sizeId = static_cast<uint16_t>(Config.getInt(kKeySize, 7));
    gConfig.setIdsCsv = Config.getString(kKeySets, "1,20");
    gConfig.angle = static_cast<int16_t>(Config.getInt(kKeyAngle, 40));
    gConfig.deviceName = Config.getString(kKeyDeviceName, "Kilter A1");
    gConfig.apiLevel = static_cast<uint8_t>(Config.getInt(kKeyApiLevel, 3));
    if (gConfig.deviceName.length() == 0) gConfig.deviceName = "Kilter A1";
    if (gConfig.apiLevel != 2 && gConfig.apiLevel != 3) gConfig.apiLevel = 3;
    clampToCatalog(gConfig);
}

void saveConfig() {
    Config.setString(kKeyBoard, boardNameToString(gConfig.board));
    Config.setInt(kKeyLayout, gConfig.layoutId);
    Config.setInt(kKeySize, gConfig.sizeId);
    Config.setString(kKeySets, gConfig.setIdsCsv);
    Config.setInt(kKeyAngle, gConfig.angle);
    Config.setString(kKeyDeviceName, gConfig.deviceName);
    Config.setInt(kKeyApiLevel, gConfig.apiLevel);
}

}  // namespace board_debug
