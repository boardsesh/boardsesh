// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef GRADE_COLORS_H
#define GRADE_COLORS_H

#include <Arduino.h>

/**
 * V-grade color scheme based on thecrag.com grade coloring
 * Colors are in RGB565 format for TFT displays
 *
 * Color progression from yellow (easy) to purple (hard):
 * - V0: Yellow
 * - V1-V2: Orange
 * - V3-V4: Dark orange/red-orange
 * - V5-V6: Red
 * - V7-V10: Dark red/crimson
 * - V11+: Purple/magenta
 */

// RGB565 color format: 5 bits red, 6 bits green, 5 bits blue
// Macro to convert RGB888 to RGB565
#define RGB565(r, g, b) (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3))

// V-grade colors in RGB565 format
#define V_GRADE_COLOR_V0 RGB565(0xFF, 0xEB, 0x3B)   // Yellow #FFEB3B
#define V_GRADE_COLOR_V1 RGB565(0xFF, 0xC1, 0x07)   // Amber #FFC107
#define V_GRADE_COLOR_V2 RGB565(0xFF, 0x98, 0x00)   // Orange #FF9800
#define V_GRADE_COLOR_V3 RGB565(0xFF, 0x70, 0x43)   // Deep orange #FF7043
#define V_GRADE_COLOR_V4 RGB565(0xFF, 0x57, 0x22)   // Red-orange #FF5722
#define V_GRADE_COLOR_V5 RGB565(0xF4, 0x43, 0x36)   // Red #F44336
#define V_GRADE_COLOR_V6 RGB565(0xE5, 0x39, 0x35)   // Red darker #E53935
#define V_GRADE_COLOR_V7 RGB565(0xD3, 0x2F, 0x2F)   // Dark red #D32F2F
#define V_GRADE_COLOR_V8 RGB565(0xC6, 0x28, 0x28)   // Darker red #C62828
#define V_GRADE_COLOR_V9 RGB565(0xB7, 0x1C, 0x1C)   // Deep red #B71C1C
#define V_GRADE_COLOR_V10 RGB565(0xA1, 0x1B, 0x4A)  // Red-purple #A11B4A
#define V_GRADE_COLOR_V11 RGB565(0x9C, 0x27, 0xB0)  // Purple #9C27B0
#define V_GRADE_COLOR_V12 RGB565(0x7B, 0x1F, 0xA2)  // Dark purple #7B1FA2
#define V_GRADE_COLOR_V13 RGB565(0x6A, 0x1B, 0x9A)  // Darker purple #6A1B9A
#define V_GRADE_COLOR_V14 RGB565(0x5C, 0x1A, 0x87)  // Deep purple #5C1A87
#define V_GRADE_COLOR_V15 RGB565(0x4A, 0x14, 0x8C)  // Very deep purple #4A148C
#define V_GRADE_COLOR_V16 RGB565(0x38, 0x00, 0x6B)  // Near black purple #38006B
#define V_GRADE_COLOR_V17 RGB565(0x2A, 0x00, 0x54)  // Darkest purple #2A0054

// Default color for unknown grades
#define V_GRADE_COLOR_DEFAULT RGB565(0xC8, 0xC8, 0xC8)  // Light gray

// Common display colors
#define COLOR_WHITE 0xFFFF
#define COLOR_BLACK 0x0000
#define COLOR_DARK_GRAY RGB565(0x40, 0x40, 0x40)
#define COLOR_LIGHT_GRAY RGB565(0xA0, 0xA0, 0xA0)
#define COLOR_GREEN RGB565(0x00, 0xD9, 0x64)
#define COLOR_RED RGB565(0xE9, 0x45, 0x60)
#define COLOR_CYAN RGB565(0x00, 0xD9, 0xFF)

/**
 * Get RGB565 color for a V-grade string.
 * Supports formats: "V0", "V5", "V10", "v3", "6c/V5" (extracts V-grade)
 *
 * @param grade Grade string
 * @return RGB565 color value
 */
inline uint16_t getVGradeColor(const char* grade) {
    if (!grade || grade[0] == '\0') {
        return V_GRADE_COLOR_DEFAULT;
    }

    // Find V-grade in string (e.g., extract "V5" from "6c/V5")
    const char* vPos = strchr(grade, 'V');
    if (!vPos) {
        vPos = strchr(grade, 'v');
    }
    if (!vPos) {
        return V_GRADE_COLOR_DEFAULT;
    }

    // Parse the number after V
    int vGrade = atoi(vPos + 1);

    switch (vGrade) {
        case 0:
            return V_GRADE_COLOR_V0;
        case 1:
            return V_GRADE_COLOR_V1;
        case 2:
            return V_GRADE_COLOR_V2;
        case 3:
            return V_GRADE_COLOR_V3;
        case 4:
            return V_GRADE_COLOR_V4;
        case 5:
            return V_GRADE_COLOR_V5;
        case 6:
            return V_GRADE_COLOR_V6;
        case 7:
            return V_GRADE_COLOR_V7;
        case 8:
            return V_GRADE_COLOR_V8;
        case 9:
            return V_GRADE_COLOR_V9;
        case 10:
            return V_GRADE_COLOR_V10;
        case 11:
            return V_GRADE_COLOR_V11;
        case 12:
            return V_GRADE_COLOR_V12;
        case 13:
            return V_GRADE_COLOR_V13;
        case 14:
            return V_GRADE_COLOR_V14;
        case 15:
            return V_GRADE_COLOR_V15;
        case 16:
            return V_GRADE_COLOR_V16;
        case 17:
            return V_GRADE_COLOR_V17;
        default:
            if (vGrade > 17)
                return V_GRADE_COLOR_V17;
            return V_GRADE_COLOR_DEFAULT;
    }
}

/**
 * Check if a color is light (for determining text color contrast)
 *
 * @param color RGB565 color
 * @return true if color is light (should use dark text)
 */
inline bool isLightColor(uint16_t color) {
    // Extract RGB components from RGB565
    uint8_t r = (color >> 11) << 3;
    uint8_t g = ((color >> 5) & 0x3F) << 2;
    uint8_t b = (color & 0x1F) << 3;

    // Calculate relative luminance
    float luminance = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f;
    return luminance > 0.5f;
}

/**
 * Get appropriate text color (black or white) for a background color
 *
 * @param backgroundColor RGB565 background color
 * @return RGB565 color for text (black or white)
 */
inline uint16_t getTextColorForBackground(uint16_t backgroundColor) {
    return isLightColor(backgroundColor) ? COLOR_BLACK : COLOR_WHITE;
}

/**
 * Extract V-grade string from a difficulty string.
 * Examples: "6c/V5" -> "V5", "V10" -> "V10", "7a" -> ""
 *
 * @param difficulty Full difficulty string
 * @param output Buffer to store extracted V-grade
 * @param maxLen Maximum length of output buffer
 */
inline void extractVGrade(const char* difficulty, char* output, size_t maxLen) {
    output[0] = '\0';
    if (!difficulty)
        return;

    const char* vPos = strchr(difficulty, 'V');
    if (!vPos) {
        vPos = strchr(difficulty, 'v');
    }
    if (!vPos)
        return;

    // Copy the V-grade (V followed by digits)
    size_t i = 0;
    output[i++] = 'V';
    vPos++;
    while (*vPos >= '0' && *vPos <= '9' && i < maxLen - 1) {
        output[i++] = *vPos++;
    }
    output[i] = '\0';
}

#endif
