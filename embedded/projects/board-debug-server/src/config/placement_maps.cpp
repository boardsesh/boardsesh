#include "placement_maps.h"

namespace board_debug {

const PlacementMap* findPlacementMap(BoardName board, uint16_t layoutId, uint16_t sizeId) {
    for (size_t i = 0; i < kPlacementMapCount; i++) {
        const PlacementMap& map = kPlacementMaps[i];
        if (map.board == board && map.layoutId == layoutId && map.sizeId == sizeId) {
            return &map;
        }
    }
    return nullptr;
}

uint16_t lookupPlacementId(const PlacementMap* map, uint16_t led) {
    if (!map) return 0;
    // Binary search; the gen script emits entries sorted by led.
    size_t lo = 0;
    size_t hi = map->count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const PlacementEntry& e = map->entries[mid];
        if (e.led < led) {
            lo = mid + 1;
        } else if (e.led > led) {
            hi = mid;
        } else {
            return e.placementId;
        }
    }
    return 0;
}

}  // namespace board_debug
