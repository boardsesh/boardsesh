// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "climb_history.h"

#include <ArduinoJson.h>

#include <config_manager.h>

ClimbHistory ClimbHistoryMgr;

const char* ClimbHistory::NVS_KEY_HISTORY = "climb_hist";

ClimbHistory::ClimbHistory() : hasCurrentClimb_(false) {
    // Initialize all entries as invalid
    for (int i = 0; i < MAX_CLIMB_HISTORY; i++) {
        history[i] = ClimbEntry();
    }
}

void ClimbHistory::begin() {
    load();
}

void ClimbHistory::addClimb(const char* name, const char* grade, const char* uuid) {
    if (!name || !uuid)
        return;

    // Check if this is the same as the current climb (update)
    if (hasCurrentClimb_ && history[0].valid && strcmp(history[0].uuid, uuid) == 0) {
        // Same climb - just update name/grade in case they changed
        strncpy(history[0].name, name, MAX_CLIMB_NAME_LEN - 1);
        history[0].name[MAX_CLIMB_NAME_LEN - 1] = '\0';
        if (grade) {
            strncpy(history[0].grade, grade, MAX_CLIMB_GRADE_LEN - 1);
            history[0].grade[MAX_CLIMB_GRADE_LEN - 1] = '\0';
        }
        save();
        return;
    }

    // Shift existing entries down
    shiftDown();

    // Add new climb at position 0
    strncpy(history[0].name, name, MAX_CLIMB_NAME_LEN - 1);
    history[0].name[MAX_CLIMB_NAME_LEN - 1] = '\0';

    if (grade) {
        strncpy(history[0].grade, grade, MAX_CLIMB_GRADE_LEN - 1);
        history[0].grade[MAX_CLIMB_GRADE_LEN - 1] = '\0';
    } else {
        history[0].grade[0] = '\0';
    }

    strncpy(history[0].uuid, uuid, MAX_CLIMB_UUID_LEN - 1);
    history[0].uuid[MAX_CLIMB_UUID_LEN - 1] = '\0';

    history[0].valid = true;
    hasCurrentClimb_ = true;

    save();
}

void ClimbHistory::clearCurrent() {
    hasCurrentClimb_ = false;
    // Note: We don't remove the entry from history, just mark no current climb
    // This way the display can still show "last climb was X"
}

const ClimbEntry* ClimbHistory::getCurrentClimb() const {
    if (!hasCurrentClimb_ || !history[0].valid) {
        return nullptr;
    }
    return &history[0];
}

const ClimbEntry* ClimbHistory::getClimb(int index) const {
    if (index < 0 || index >= MAX_CLIMB_HISTORY) {
        return nullptr;
    }
    if (!history[index].valid) {
        return nullptr;
    }
    return &history[index];
}

int ClimbHistory::getCount() const {
    int count = 0;
    for (int i = 0; i < MAX_CLIMB_HISTORY; i++) {
        if (history[i].valid) {
            count++;
        }
    }
    return count;
}

bool ClimbHistory::hasCurrentClimb() const {
    return hasCurrentClimb_ && history[0].valid;
}

void ClimbHistory::shiftDown() {
    // Move each entry to the next position, oldest is discarded
    for (int i = MAX_CLIMB_HISTORY - 1; i > 0; i--) {
        history[i] = history[i - 1];
    }
    // Position 0 is now ready for new entry
    history[0] = ClimbEntry();
}

void ClimbHistory::save() {
    // Serialize history to JSON
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();

    for (int i = 0; i < MAX_CLIMB_HISTORY; i++) {
        if (history[i].valid) {
            JsonObject obj = arr.add<JsonObject>();
            obj["n"] = history[i].name;
            obj["g"] = history[i].grade;
            obj["u"] = history[i].uuid;
        }
    }

    String json;
    serializeJson(doc, json);

    // Store in NVS
    Config.setString(NVS_KEY_HISTORY, json.c_str());
}

void ClimbHistory::load() {
    String json = Config.getString(NVS_KEY_HISTORY);
    if (json.length() == 0) {
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, json);
    if (error) {
        return;
    }

    JsonArray arr = doc.as<JsonArray>();
    int index = 0;

    for (JsonObject obj : arr) {
        if (index >= MAX_CLIMB_HISTORY)
            break;

        const char* name = obj["n"];
        const char* grade = obj["g"];
        const char* uuid = obj["u"];

        if (name && uuid) {
            strncpy(history[index].name, name, MAX_CLIMB_NAME_LEN - 1);
            history[index].name[MAX_CLIMB_NAME_LEN - 1] = '\0';

            if (grade) {
                strncpy(history[index].grade, grade, MAX_CLIMB_GRADE_LEN - 1);
                history[index].grade[MAX_CLIMB_GRADE_LEN - 1] = '\0';
            }

            strncpy(history[index].uuid, uuid, MAX_CLIMB_UUID_LEN - 1);
            history[index].uuid[MAX_CLIMB_UUID_LEN - 1] = '\0';

            history[index].valid = true;
            index++;
        }
    }

    // Note: We don't set hasCurrentClimb_ = true here because loaded history
    // represents past climbs, not an active current climb. The current climb
    // is only set when a new climb is explicitly added via addClimb().
}

void ClimbHistory::clear() {
    for (int i = 0; i < MAX_CLIMB_HISTORY; i++) {
        history[i] = ClimbEntry();
    }
    hasCurrentClimb_ = false;
    Config.remove(NVS_KEY_HISTORY);
}
