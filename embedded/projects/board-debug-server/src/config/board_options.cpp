#include "board_options.h"

#include <string.h>

namespace board_debug {

const char* boardNameToString(BoardName board) {
    switch (board) {
        case BoardName::KILTER:      return "kilter";
        case BoardName::TENSION:     return "tension";
        case BoardName::MOONBOARD:   return "moonboard";
        case BoardName::DECOY:       return "decoy";
        case BoardName::TOUCHSTONE:  return "touchstone";
        case BoardName::GRASSHOPPER: return "grasshopper";
        default:                     return "unknown";
    }
}

BoardName parseBoardName(const char* name) {
    if (!name) return BoardName::UNKNOWN;
    if (strcasecmp(name, "kilter") == 0)      return BoardName::KILTER;
    if (strcasecmp(name, "tension") == 0)     return BoardName::TENSION;
    if (strcasecmp(name, "moonboard") == 0)   return BoardName::MOONBOARD;
    if (strcasecmp(name, "decoy") == 0)       return BoardName::DECOY;
    if (strcasecmp(name, "touchstone") == 0)  return BoardName::TOUCHSTONE;
    if (strcasecmp(name, "grasshopper") == 0) return BoardName::GRASSHOPPER;
    return BoardName::UNKNOWN;
}

bool isAuroraBoard(BoardName board) {
    return board == BoardName::KILTER || board == BoardName::TENSION ||
           board == BoardName::DECOY || board == BoardName::TOUCHSTONE ||
           board == BoardName::GRASSHOPPER;
}

bool isMoonBoardBoard(BoardName board) {
    return board == BoardName::MOONBOARD;
}

const BoardCatalogEntry* findBoard(BoardName board) {
    for (size_t i = 0; i < kBoardCatalogCount; i++) {
        if (kBoardCatalog[i].board == board) {
            return &kBoardCatalog[i];
        }
    }
    return nullptr;
}

const LayoutOption* findLayout(BoardName board, uint16_t layoutId) {
    const BoardCatalogEntry* entry = findBoard(board);
    if (!entry) return nullptr;
    for (uint16_t i = 0; i < entry->layoutCount; i++) {
        if (entry->layouts[i].id == layoutId) {
            return &entry->layouts[i];
        }
    }
    return nullptr;
}

const SizeOption* findSize(BoardName board, uint16_t layoutId, uint16_t sizeId) {
    const LayoutOption* layout = findLayout(board, layoutId);
    if (!layout) return nullptr;
    for (uint16_t i = 0; i < layout->sizeCount; i++) {
        if (layout->sizes[i].id == sizeId) {
            return &layout->sizes[i];
        }
    }
    return nullptr;
}

bool isValidSet(BoardName board, uint16_t layoutId, uint16_t sizeId, uint16_t setId) {
    const SizeOption* size = findSize(board, layoutId, sizeId);
    if (!size) return false;
    for (uint16_t i = 0; i < size->setCount; i++) {
        if (size->sets[i].id == setId) return true;
    }
    return false;
}

}  // namespace board_debug
