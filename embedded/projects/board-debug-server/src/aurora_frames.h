#ifndef BOARD_DEBUG_AURORA_FRAMES_H
#define BOARD_DEBUG_AURORA_FRAMES_H

#include <Arduino.h>

#include <led_controller.h>
#include <vector>

#include "config/board_options.h"

namespace board_debug {

// Re-derive the role code from a quantized BLE color, mirroring
// `colorToRoleCode` in packages/board-constants/src/led-placements.ts.
uint8_t colorToRoleCode(uint8_t r, uint8_t g, uint8_t b, BoardName board);

// Build the `p{placementId}r{roleCode}` frames string from the LED commands the
// Aurora protocol decoder produced. Mirrors `buildFramesString` in the same TS
// module: drops LEDs whose position can't be reverse-mapped, sorts by placement
// id, returns "" if the firmware has no placement map for the board/layout/size.
String buildFramesString(const std::vector<LedCommand>& leds,
                         BoardName board,
                         uint16_t layoutId,
                         uint16_t sizeId);

}  // namespace board_debug

#endif
