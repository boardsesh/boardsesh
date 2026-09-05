// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * V-grade color scheme for climbing grades
 * Ported from packages/web/app/lib/grade-colors.ts
 *
 * Color progression from yellow (easy) to purple (hard):
 * - V0: Yellow
 * - V1-V2: Orange
 * - V3-V4: Dark orange/red-orange
 * - V5-V6: Red
 * - V7-V10: Dark red/crimson
 * - V11+: Purple/magenta
 */

#ifndef GRADE_COLORS_H
#define GRADE_COLORS_H

#include <Arduino.h>

// Convert RGB888 to RGB565
#define RGB565(r, g, b) ((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))

// V-grade colors (RGB565)
#define COLOR_V0 RGB565(0xFF, 0xEB, 0x3B)   // Yellow #FFEB3B
#define COLOR_V1 RGB565(0xFF, 0xC1, 0x07)   // Amber #FFC107
#define COLOR_V2 RGB565(0xFF, 0x98, 0x00)   // Orange #FF9800
#define COLOR_V3 RGB565(0xFF, 0x70, 0x43)   // Deep orange #FF7043
#define COLOR_V4 RGB565(0xFF, 0x57, 0x22)   // Red-orange #FF5722
#define COLOR_V5 RGB565(0xF4, 0x43, 0x36)   // Red #F44336
#define COLOR_V6 RGB565(0xE5, 0x39, 0x35)   // Red (darker) #E53935
#define COLOR_V7 RGB565(0xD3, 0x2F, 0x2F)   // Dark red #D32F2F
#define COLOR_V8 RGB565(0xC6, 0x28, 0x28)   // Darker red #C62828
#define COLOR_V9 RGB565(0xB7, 0x1C, 0x1C)   // Deep red #B71C1C
#define COLOR_V10 RGB565(0xA1, 0x1B, 0x4A)  // Red-purple #A11B4A
#define COLOR_V11 RGB565(0x9C, 0x27, 0xB0)  // Purple #9C27B0
#define COLOR_V12 RGB565(0x7B, 0x1F, 0xA2)  // Dark purple #7B1FA2
#define COLOR_V13 RGB565(0x6A, 0x1B, 0x9A)  // Darker purple #6A1B9A
#define COLOR_V14 RGB565(0x5C, 0x1A, 0x87)  // Deep purple #5C1A87
#define COLOR_V15 RGB565(0x4A, 0x14, 0x8C)  // Very deep purple #4A148C
#define COLOR_V16 RGB565(0x38, 0x00, 0x6B)  // Near black purple #38006B
#define COLOR_V17 RGB565(0x2A, 0x00, 0x54)  // Darkest purple #2A0054

// Default color for unknown grades
#define COLOR_GRADE_DEFAULT RGB565(0xC8, 0xC8, 0xC8)  // Light gray

/**
 * Get RGB565 color for a V-grade number (0-17)
 * @param vGrade V-grade number
 * @return RGB565 color value
 */
inline uint16_t getVGradeColorByNumber(int vGrade) {
    switch (vGrade) {
        case 0:
            return COLOR_V0;
        case 1:
            return COLOR_V1;
        case 2:
            return COLOR_V2;
        case 3:
            return COLOR_V3;
        case 4:
            return COLOR_V4;
        case 5:
            return COLOR_V5;
        case 6:
            return COLOR_V6;
        case 7:
            return COLOR_V7;
        case 8:
            return COLOR_V8;
        case 9:
            return COLOR_V9;
        case 10:
            return COLOR_V10;
        case 11:
            return COLOR_V11;
        case 12:
            return COLOR_V12;
        case 13:
            return COLOR_V13;
        case 14:
            return COLOR_V14;
        case 15:
            return COLOR_V15;
        case 16:
            return COLOR_V16;
        case 17:
            return COLOR_V17;
        default:
            return vGrade > 17 ? COLOR_V17 : COLOR_GRADE_DEFAULT;
    }
}

/**
 * Get RGB565 color for a Font grade (e.g., "6a", "7b+")
 * Maps Font grades to their equivalent V-grade colors
 * @param fontGrade Font grade string
 * @return RGB565 color value
 */
inline uint16_t getFontGradeColor(const char* fontGrade) {
    if (!fontGrade || strlen(fontGrade) < 2)
        return COLOR_GRADE_DEFAULT;

    char grade = fontGrade[0];
    char sub = fontGrade[1];
    bool plus = (strlen(fontGrade) >= 3 && fontGrade[2] == '+');

    // Map Font grades to V-grade colors
    if (grade == '4')
        return COLOR_V0;  // 4a, 4b, 4c -> V0
    if (grade == '5') {
        if (sub == 'a' || sub == 'b')
            return COLOR_V1;  // 5a, 5b -> V1
        if (sub == 'c')
            return COLOR_V2;  // 5c -> V2
    }
    if (grade == '6') {
        if (sub == 'a')
            return COLOR_V3;  // 6a, 6a+ -> V3
        if (sub == 'b')
            return COLOR_V4;  // 6b, 6b+ -> V4
        if (sub == 'c')
            return COLOR_V5;  // 6c, 6c+ -> V5
    }
    if (grade == '7') {
        if (sub == 'a' && !plus)
            return COLOR_V6;  // 7a -> V6
        if (sub == 'a' && plus)
            return COLOR_V7;  // 7a+ -> V7
        if (sub == 'b')
            return COLOR_V8;  // 7b, 7b+ -> V8
        if (sub == 'c' && !plus)
            return COLOR_V9;  // 7c -> V9
        if (sub == 'c' && plus)
            return COLOR_V10;  // 7c+ -> V10
    }
    if (grade == '8') {
        if (sub == 'a' && !plus)
            return COLOR_V11;  // 8a -> V11
        if (sub == 'a' && plus)
            return COLOR_V12;  // 8a+ -> V12
        if (sub == 'b' && !plus)
            return COLOR_V13;  // 8b -> V13
        if (sub == 'b' && plus)
            return COLOR_V14;  // 8b+ -> V14
        if (sub == 'c' && !plus)
            return COLOR_V15;  // 8c -> V15
        if (sub == 'c' && plus)
            return COLOR_V16;  // 8c+ -> V16
    }

    return COLOR_GRADE_DEFAULT;
}

/**
 * Get RGB565 color for a grade string (e.g., "V3", "6a/V3", "V10")
 * Tries to extract V-grade first, falls back to Font grade
 * @param grade Grade string
 * @return RGB565 color value
 */
inline uint16_t getGradeColor(const char* grade) {
    if (!grade || strlen(grade) == 0)
        return COLOR_GRADE_DEFAULT;

    // Look for V-grade pattern (V followed by number)
    const char* vPos = strchr(grade, 'V');
    if (!vPos)
        vPos = strchr(grade, 'v');

    if (vPos) {
        // Parse the number after V
        int vGrade = atoi(vPos + 1);
        if (vGrade >= 0 && vGrade <= 17) {
            return getVGradeColorByNumber(vGrade);
        }
        // Handle V17+
        if (vGrade > 17)
            return COLOR_V17;
    }

    // Try Font grade (look for pattern like "6a" or "7b+")
    for (const char* p = grade; *p; p++) {
        if (*p >= '4' && *p <= '8' && p[1] &&
            (p[1] == 'a' || p[1] == 'b' || p[1] == 'c' || p[1] == 'A' || p[1] == 'B' || p[1] == 'C')) {
            char fontGrade[4] = {0};
            fontGrade[0] = *p;
            fontGrade[1] = (p[1] >= 'A' && p[1] <= 'C') ? (p[1] + 32) : p[1];  // lowercase
            if (p[2] == '+')
                fontGrade[2] = '+';
            return getFontGradeColor(fontGrade);
        }
    }

    return COLOR_GRADE_DEFAULT;
}

/**
 * Determine if a color is light (for text contrast)
 * @param color RGB565 color
 * @return true if color is light and should use dark text
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
 * Get text color (black or white) for good contrast against background
 * @param bgColor Background RGB565 color
 * @return RGB565 color for text (black or white)
 */
inline uint16_t getGradeTextColor(uint16_t bgColor) {
    return isLightColor(bgColor) ? 0x0000 : 0xFFFF;  // Black or White
}

#endif  // GRADE_COLORS_H
