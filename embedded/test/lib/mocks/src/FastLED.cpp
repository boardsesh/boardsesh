// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * FastLED Mock Implementation
 */

#include "FastLED.h"

// Global FastLED instance
CFastLED FastLED;

// Static color definitions
const CRGB CRGB::Black(0, 0, 0);
const CRGB CRGB::White(255, 255, 255);
const CRGB CRGB::Red(255, 0, 0);
const CRGB CRGB::Green(0, 255, 0);
const CRGB CRGB::Blue(0, 0, 255);
