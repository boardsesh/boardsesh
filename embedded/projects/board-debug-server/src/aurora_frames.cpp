#include "aurora_frames.h"

#include <algorithm>

#include "config/placement_maps.h"

namespace board_debug {

namespace {

// Aurora boards advertise role codes per product. The TS source uses
// STATE_TO_PRIMARY_CODE in packages/board-constants/src/hold-states.ts to pick
// one canonical code per state per board. Mirrored verbatim here.
struct RoleCodes {
    uint8_t starting;
    uint8_t hand;
    uint8_t finish;
    uint8_t foot;
};

RoleCodes rolesFor(BoardName board) {
    switch (board) {
        case BoardName::KILTER:
            return {42, 43, 44, 45};
        case BoardName::TENSION:
        case BoardName::DECOY:
        case BoardName::TOUCHSTONE:
        case BoardName::GRASSHOPPER:
            return {1, 2, 3, 4};
        default:
            return {0, 0, 0, 0};
    }
}

}  // namespace

uint8_t colorToRoleCode(uint8_t r, uint8_t g, uint8_t b, BoardName board) {
    const RoleCodes codes = rolesFor(board);
    const bool R = r > 127;
    const bool G = g > 127;
    const bool B = b > 127;

    if (!R && G && !B) return codes.starting;
    if (!R && !G && B) return codes.hand;
    if (R && !G && !B) return codes.finish;
    if (R && !G && B) {
        // Kilter encodes FINISH as magenta and has no foot/magenta clash.
        // Tension-family encodes FOOT as magenta.
        return board == BoardName::KILTER ? codes.finish : codes.foot;
    }
    if (R && G && !B) return codes.foot;
    return codes.hand;
}

String buildFramesString(const std::vector<LedCommand>& leds,
                         BoardName board,
                         uint16_t layoutId,
                         uint16_t sizeId) {
    const PlacementMap* map = findPlacementMap(board, layoutId, sizeId);
    if (!map) {
        return String();
    }

    struct Entry {
        uint16_t placementId;
        uint8_t roleCode;
    };
    std::vector<Entry> entries;
    entries.reserve(leds.size());

    for (const auto& led : leds) {
        const uint16_t placementId = lookupPlacementId(map, led.position);
        if (placementId == 0) continue;  // Position not in map; same behavior as TS warning path.
        const uint8_t role = colorToRoleCode(led.r, led.g, led.b, board);
        if (role == 0) continue;
        entries.push_back({placementId, role});
    }

    std::sort(entries.begin(), entries.end(),
              [](const Entry& a, const Entry& b) { return a.placementId < b.placementId; });

    String out;
    out.reserve(entries.size() * 12);  // ~ "pNNNNrNN"
    char buf[24];
    for (const auto& e : entries) {
        snprintf(buf, sizeof(buf), "p%ur%u", static_cast<unsigned>(e.placementId),
                 static_cast<unsigned>(e.roleCode));
        out += buf;
    }
    return out;
}

}  // namespace board_debug
