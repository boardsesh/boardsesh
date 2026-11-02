#pragma once
#include <cstdint>

constexpr int INPUT_PULLUP = 1;
constexpr int LOW = 0;
inline uint32_t fixtureClockMs = 0;
inline int fixturePinLevel = 1;
inline int fixtureConfiguredPin = -1;
inline void pinMode(int pin, int) { fixtureConfiguredPin = pin; }
inline int digitalRead(int) { return fixturePinLevel; }
inline uint32_t millis() { return fixtureClockMs; }
