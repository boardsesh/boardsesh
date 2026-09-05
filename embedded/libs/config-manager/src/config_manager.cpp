// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "config_manager.h"

ConfigManager Config;

ConfigManager::ConfigManager() : opened(false) {}

void ConfigManager::begin() {
    if (!opened) {
        prefs.begin(CONFIG_NAMESPACE, false);
        opened = true;
    }
}

void ConfigManager::end() {
    if (opened) {
        prefs.end();
        opened = false;
    }
}

String ConfigManager::getString(const char* key, const String& defaultValue) {
    begin();
    return prefs.getString(key, defaultValue);
}

bool ConfigManager::setString(const char* key, const String& value) {
    begin();
    return prefs.putString(key, value) > 0 || value.length() == 0;
}

int32_t ConfigManager::getInt(const char* key, int32_t defaultValue) {
    begin();
    return prefs.getInt(key, defaultValue);
}

bool ConfigManager::setInt(const char* key, int32_t value) {
    begin();
    return prefs.putInt(key, value) > 0;
}

bool ConfigManager::getBool(const char* key, bool defaultValue) {
    begin();
    return prefs.getBool(key, defaultValue);
}

bool ConfigManager::setBool(const char* key, bool value) {
    begin();
    return prefs.putBool(key, value) > 0;
}

size_t ConfigManager::getBytes(const char* key, uint8_t* buffer, size_t maxLen) {
    begin();
    return prefs.getBytes(key, buffer, maxLen);
}

bool ConfigManager::setBytes(const char* key, const uint8_t* buffer, size_t len) {
    begin();
    return prefs.putBytes(key, buffer, len) > 0 || len == 0;
}

void ConfigManager::clear() {
    begin();
    prefs.clear();
}

bool ConfigManager::hasKey(const char* key) {
    begin();
    return prefs.isKey(key);
}

void ConfigManager::remove(const char* key) {
    begin();
    prefs.remove(key);
}
