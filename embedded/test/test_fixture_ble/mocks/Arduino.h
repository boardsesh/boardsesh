#pragma once

// Keep the shared Arduino mock while giving only this suite a controllable clock.
#define millis fixtureBleUnusedMillis
#define delay fixtureBleUnusedDelay
#include "../../lib/mocks/src/Arduino.h"
#undef millis
#undef delay

inline unsigned long fixtureBleTestMillis = 1;
inline unsigned long millis() {
    return fixtureBleTestMillis;
}
inline void delay(unsigned long milliseconds) {
    fixtureBleTestMillis += milliseconds;
}

// Arduino's real String supports range iteration; the shared minimal mock does not.
inline const char* begin(const String& text) {
    return text.c_str();
}
inline const char* end(const String& text) {
    return text.c_str() + text.length();
}
