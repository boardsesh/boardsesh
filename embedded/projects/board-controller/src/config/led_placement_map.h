// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef LED_PLACEMENT_MAP_H
#define LED_PLACEMENT_MAP_H

#include <Arduino.h>

// LED placement map for Kilter/Tension boards
// Maps hold IDs from Aurora app to physical LED indices
//
// The Aurora app uses hold IDs that don't necessarily match
// the physical wiring order of LEDs on the board. This map
// translates between them.
//
// Format: ledMap[holdId] = ledIndex
// Set to 255 for holds that don't have LEDs

// Example mapping for a 12x12 board layout
// This should be customized for each physical board installation
const uint8_t LED_MAP[] = {
    // Hold ID 0-19
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    // Hold ID 20-39
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    // Hold ID 40-59
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    // Hold ID 60-79
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    // Hold ID 80-99
    80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    // Hold ID 100-119
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
    // Hold ID 120-139
    120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139,
    // Hold ID 140-159
    140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159,
    // Hold ID 160-179
    160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179,
    // Hold ID 180-199
    180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199};

const size_t LED_MAP_SIZE = sizeof(LED_MAP) / sizeof(LED_MAP[0]);

#endif
