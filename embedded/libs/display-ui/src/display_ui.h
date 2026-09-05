// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef DISPLAY_UI_H
#define DISPLAY_UI_H

/**
 * Display UI Library for T-Display-S3
 *
 * This library provides a complete UI for displaying climb information
 * on the LilyGo T-Display-S3 (170x320 LCD).
 *
 * Components:
 * - ClimbDisplay: Main display manager
 * - QRGenerator: QR code generation for Boardsesh URLs
 * - Grade colors: V-grade color scheme in RGB565
 *
 * Usage:
 *   #include <display_ui.h>
 *
 *   void setup() {
 *     Display.begin();
 *   }
 *
 *   void loop() {
 *     Display.loop();
 *   }
 *
 *   // When climb changes:
 *   Display.setCurrentClimb("Climb Name", "V5", "uuid", "kilter/1/12/1,2,3/40", "session123");
 */

#include "climb_display.h"
#include "grade_colors.h"
#include "qr_generator.h"

#endif
