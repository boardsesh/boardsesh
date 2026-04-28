#ifndef BOARD_DEBUG_PLACEMENT_MAPS_H
#define BOARD_DEBUG_PLACEMENT_MAPS_H

#include <stddef.h>
#include <stdint.h>

#include "board_options.h"

namespace board_debug {

struct PlacementEntry {
    uint16_t led;
    uint16_t placementId;
};

struct PlacementMap {
    BoardName board;
    uint16_t layoutId;
    uint16_t sizeId;
    const PlacementEntry* entries;
    size_t count;
};

extern const PlacementMap kPlacementMaps[];
extern const size_t kPlacementMapCount;

const PlacementMap* findPlacementMap(BoardName board, uint16_t layoutId, uint16_t sizeId);

// Linear scan; the per-config entries are pre-sorted by led so callers can
// also do a binary search if they care about per-frame cost.
uint16_t lookupPlacementId(const PlacementMap* map, uint16_t led);

}  // namespace board_debug

#endif
