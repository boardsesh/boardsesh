#pragma once
#include "Arduino.h"

// This suite stops before GraphQL messages arrive. These compile-only JSON
// types deliberately reject incoming text; protocol/manifest tests live elsewhere.
class JsonVariantConst {
  public:
    JsonVariantConst operator[](const char*) const { return {}; }
    template <typename T> JsonVariantConst& operator=(const T&) { return *this; }
    template <typename T> T as() const { return {}; }
    template <typename T> bool is() const { return false; }
    template <typename T> void set(const T&) {}
    const char* operator|(const char* fallback) const { return fallback; }
    bool isNull() const { return true; }
};

class JsonArrayConst {
  public:
    size_t size() const { return 0; }
    JsonVariantConst operator[](size_t) const { return {}; }
    const JsonVariantConst* begin() const { return nullptr; }
    const JsonVariantConst* end() const { return nullptr; }
};

class JsonDocument {
  public:
    JsonVariantConst operator[](const char*) const { return {}; }
    template <typename T> T as() const { return {}; }
    template <typename T> void set(const T&) {}
    void clear() {}
};

inline bool deserializeJson(JsonDocument&, const uint8_t*, size_t) { return true; }
inline void serializeJson(const JsonDocument&, String& encoded) { encoded = "{}"; }
