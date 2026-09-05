// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef DISPLAY_TYPES_H
#define DISPLAY_TYPES_H

#include <Arduino.h>

// ============================================
// Colors (RGB565) - Shared across all displays
// ============================================

#define COLOR_BACKGROUND 0x0000  // Black
#define COLOR_TEXT 0xFFFF        // White
#define COLOR_TEXT_DIM 0x7BEF    // Gray
#define COLOR_ACCENT 0x07FF      // Cyan

#define COLOR_STATUS_OK 0x07E0     // Green
#define COLOR_STATUS_WARN 0xFD20   // Orange
#define COLOR_STATUS_ERROR 0xF800  // Red
#define COLOR_STATUS_OFF 0x4208    // Dark gray

#define COLOR_QR_FG 0x0000  // Black
#define COLOR_QR_BG 0xFFFF  // White

// ============================================
// Queue Item for Local Queue Storage
// ============================================

// Maximum number of queue items to store locally
#define MAX_QUEUE_SIZE 150

// Optimized queue item structure (~88 bytes per item)
struct LocalQueueItem {
    char uuid[37];           // Queue item UUID (for navigation)
    char climbUuid[37];      // Climb UUID (for display/matching)
    char name[32];           // Climb name (truncated for display)
    char grade[12];          // Grade string
    uint16_t gradeColorRgb;  // RGB565 color (saves parsing)

    LocalQueueItem() : gradeColorRgb(0xFFFF) {
        uuid[0] = '\0';
        climbUuid[0] = '\0';
        name[0] = '\0';
        grade[0] = '\0';
    }

    bool isValid() const { return uuid[0] != '\0'; }
    void clear() {
        uuid[0] = '\0';
        climbUuid[0] = '\0';
        name[0] = '\0';
        grade[0] = '\0';
        gradeColorRgb = 0xFFFF;
    }
};

// ============================================
// Climb History Entry
// ============================================

struct ClimbHistoryEntry {
    String name;
    String grade;
    String gradeColor;  // Hex color from backend
};

// ============================================
// Queue Navigation Item (for prev/next display)
// ============================================

struct QueueNavigationItem {
    String name;
    String grade;
    String gradeColor;
    bool isValid;

    QueueNavigationItem() : isValid(false) {}
    QueueNavigationItem(const String& n, const String& g, const String& c)
        : name(n), grade(g), gradeColor(c), isValid(true) {}
    void clear() {
        name = "";
        grade = "";
        gradeColor = "";
        isValid = false;
    }
};

#endif  // DISPLAY_TYPES_H
