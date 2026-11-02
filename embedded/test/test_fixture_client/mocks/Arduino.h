#pragma once

// Reuse the shared mock without changing its clock or String for other suites.
#define millis fixtureClientUnusedMillis
#define String FixtureClientBaseString
#include "../../lib/mocks/src/Arduino.h"
#undef String
#undef millis

inline unsigned long fixtureClientClock = 0;
inline unsigned long millis() { return fixtureClientClock; }

class String : public FixtureClientBaseString {
  public:
    using FixtureClientBaseString::FixtureClientBaseString;
    using FixtureClientBaseString::operator=;
    String(const FixtureClientBaseString& text) : FixtureClientBaseString(text) {}
    bool concat(const char* text, size_t length) {
        for (size_t index = 0; index < length; ++index)
            *this += text[index];
        return true;
    }
};

inline String operator+(const char* prefix, const String& text) { return String(prefix) + text; }
inline const char* begin(const String& text) { return text.c_str(); }
inline const char* end(const String& text) { return text.c_str() + text.length(); }
inline bool isAlphaNumeric(char character) { return std::isalnum(static_cast<unsigned char>(character)); }
