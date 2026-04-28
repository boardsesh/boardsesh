#ifndef BOARD_DEBUG_BOARD_OPTIONS_H
#define BOARD_DEBUG_BOARD_OPTIONS_H

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

namespace board_debug {

enum class BoardName : uint8_t {
    UNKNOWN = 0,
    KILTER,
    TENSION,
    MOONBOARD,
    DECOY,
    TOUCHSTONE,
    GRASSHOPPER,
};

const char* boardNameToString(BoardName board);
BoardName parseBoardName(const char* name);

// Whether the firmware should use the Aurora UART (Kilter family) or the
// MoonBoard text protocol for the given board.
bool isAuroraBoard(BoardName board);
bool isMoonBoardBoard(BoardName board);

struct SetOption {
    uint16_t id;
    const char* name;
};

struct SizeOption {
    uint16_t id;
    const char* name;
    const char* description;
    const SetOption* sets;
    uint16_t setCount;
};

struct LayoutOption {
    uint16_t id;
    const char* name;
    const SizeOption* sizes;
    uint16_t sizeCount;
};

struct BoardCatalogEntry {
    BoardName board;
    const char* name;
    const LayoutOption* layouts;
    uint16_t layoutCount;
};

extern const BoardCatalogEntry kBoardCatalog[];
extern const size_t kBoardCatalogCount;

const BoardCatalogEntry* findBoard(BoardName board);
const LayoutOption* findLayout(BoardName board, uint16_t layoutId);
const SizeOption* findSize(BoardName board, uint16_t layoutId, uint16_t sizeId);
bool isValidSet(BoardName board, uint16_t layoutId, uint16_t sizeId, uint16_t setId);

}  // namespace board_debug

#endif
