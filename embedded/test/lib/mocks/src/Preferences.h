// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * ESP32 Preferences Mock Header for Native Unit Testing
 *
 * Provides an in-memory key-value store to simulate NVS storage
 * for testing configuration management code.
 */

#ifndef PREFERENCES_MOCK_H
#define PREFERENCES_MOCK_H

#include "Arduino.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

class Preferences {
  public:
    Preferences() : opened_(false) {}

    bool begin(const char* name, bool readOnly = false) {
        (void)readOnly;
        namespace_ = name ? name : "";
        opened_ = true;
        return true;
    }

    void end() { opened_ = false; }

    bool clear() {
        if (!opened_)
            return false;
        auto it = storage_.find(namespace_);
        if (it != storage_.end()) {
            it->second.clear();
        }
        return true;
    }

    bool remove(const char* key) {
        if (!opened_ || !key)
            return false;
        auto nsIt = storage_.find(namespace_);
        if (nsIt != storage_.end()) {
            nsIt->second.erase(key);
            return true;
        }
        return false;
    }

    // String operations
    size_t putString(const char* key, const char* value) {
        if (!opened_ || !key)
            return 0;
        storage_[namespace_][key] = std::vector<uint8_t>(value, value + strlen(value) + 1);
        return strlen(value);
    }

    size_t putString(const char* key, const String& value) { return putString(key, value.c_str()); }

    String getString(const char* key, const String& defaultValue = String()) {
        if (!opened_ || !key)
            return defaultValue;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return defaultValue;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end())
            return defaultValue;
        return String((const char*)keyIt->second.data());
    }

    // Integer operations
    size_t putInt(const char* key, int32_t value) {
        if (!opened_ || !key)
            return 0;
        storage_[namespace_][key] = std::vector<uint8_t>((uint8_t*)&value, (uint8_t*)&value + sizeof(value));
        return sizeof(value);
    }

    int32_t getInt(const char* key, int32_t defaultValue = 0) {
        if (!opened_ || !key)
            return defaultValue;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return defaultValue;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end() || keyIt->second.size() < sizeof(int32_t))
            return defaultValue;
        return *reinterpret_cast<const int32_t*>(keyIt->second.data());
    }

    // Unsigned integer operations
    size_t putUInt(const char* key, uint32_t value) {
        if (!opened_ || !key)
            return 0;
        storage_[namespace_][key] = std::vector<uint8_t>((uint8_t*)&value, (uint8_t*)&value + sizeof(value));
        return sizeof(value);
    }

    uint32_t getUInt(const char* key, uint32_t defaultValue = 0) {
        if (!opened_ || !key)
            return defaultValue;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return defaultValue;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end() || keyIt->second.size() < sizeof(uint32_t))
            return defaultValue;
        return *reinterpret_cast<const uint32_t*>(keyIt->second.data());
    }

    // Boolean operations
    size_t putBool(const char* key, bool value) {
        if (!opened_ || !key)
            return 0;
        uint8_t v = value ? 1 : 0;
        storage_[namespace_][key] = std::vector<uint8_t>(&v, &v + 1);
        return 1;
    }

    bool getBool(const char* key, bool defaultValue = false) {
        if (!opened_ || !key)
            return defaultValue;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return defaultValue;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end() || keyIt->second.empty())
            return defaultValue;
        return keyIt->second[0] != 0;
    }

    // Bytes operations
    size_t putBytes(const char* key, const void* value, size_t len) {
        if (!opened_ || !key || !value)
            return 0;
        const uint8_t* data = static_cast<const uint8_t*>(value);
        storage_[namespace_][key] = std::vector<uint8_t>(data, data + len);
        return len;
    }

    size_t getBytes(const char* key, void* buf, size_t maxLen) {
        if (!opened_ || !key || !buf)
            return 0;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return 0;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end())
            return 0;
        size_t len = std::min(maxLen, keyIt->second.size());
        memcpy(buf, keyIt->second.data(), len);
        return len;
    }

    size_t getBytesLength(const char* key) {
        if (!opened_ || !key)
            return 0;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return 0;
        auto keyIt = nsIt->second.find(key);
        if (keyIt == nsIt->second.end())
            return 0;
        return keyIt->second.size();
    }

    // Check if key exists
    bool isKey(const char* key) {
        if (!opened_ || !key)
            return false;
        auto nsIt = storage_.find(namespace_);
        if (nsIt == storage_.end())
            return false;
        return nsIt->second.find(key) != nsIt->second.end();
    }

    // For testing - clear all stored data across all namespaces
    static void resetAll() { storage_.clear(); }

  private:
    bool opened_;
    std::string namespace_;

    // Static storage shared across all Preferences instances
    static std::map<std::string, std::map<std::string, std::vector<uint8_t>>> storage_;
};

#endif  // PREFERENCES_MOCK_H
