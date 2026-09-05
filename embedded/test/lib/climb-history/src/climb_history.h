// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef CLIMB_HISTORY_H
#define CLIMB_HISTORY_H

#include <Arduino.h>

// Maximum number of climbs to track in history
#define MAX_CLIMB_HISTORY 5

// Maximum lengths for climb data
#define MAX_CLIMB_NAME_LEN 64
#define MAX_CLIMB_GRADE_LEN 16
#define MAX_CLIMB_UUID_LEN 40

/**
 * Data structure for a single climb entry
 */
struct ClimbEntry {
    char name[MAX_CLIMB_NAME_LEN];
    char grade[MAX_CLIMB_GRADE_LEN];
    char uuid[MAX_CLIMB_UUID_LEN];
    bool valid;  // Whether this entry contains data

    ClimbEntry() : valid(false) {
        name[0] = '\0';
        grade[0] = '\0';
        uuid[0] = '\0';
    }
};

/**
 * ClimbHistory manages a circular buffer of recent climbs with NVS persistence.
 *
 * Features:
 * - Stores the last MAX_CLIMB_HISTORY climbs
 * - Persists to NVS for power cycle recovery
 * - Provides access to current and previous climbs
 * - Automatically shifts entries when adding new climbs
 */
class ClimbHistory {
  public:
    ClimbHistory();

    /**
     * Initialize the climb history.
     * Loads any persisted data from NVS.
     */
    void begin();

    /**
     * Add a new climb to the history.
     * This becomes the current climb, and previous climbs shift down.
     * If the climb UUID matches the current climb, it's treated as an update.
     *
     * @param name Climb name
     * @param grade Climb grade (e.g., "V5", "6c/V5")
     * @param uuid Climb UUID
     */
    void addClimb(const char* name, const char* grade, const char* uuid);

    /**
     * Clear the current climb (e.g., when LEDs are cleared).
     * Does not remove from history, just marks no current climb.
     */
    void clearCurrent();

    /**
     * Get the current climb (index 0).
     * @return Pointer to current climb entry, or nullptr if none
     */
    const ClimbEntry* getCurrentClimb() const;

    /**
     * Get a climb from history by index.
     * @param index 0 = current, 1 = previous, etc.
     * @return Pointer to climb entry, or nullptr if invalid index or empty slot
     */
    const ClimbEntry* getClimb(int index) const;

    /**
     * Get the number of valid entries in history.
     * @return Count of valid entries (0 to MAX_CLIMB_HISTORY)
     */
    int getCount() const;

    /**
     * Check if there's a current climb.
     * @return true if there's a valid current climb
     */
    bool hasCurrentClimb() const;

    /**
     * Save history to NVS.
     * Called automatically by addClimb().
     */
    void save();

    /**
     * Load history from NVS.
     * Called automatically by begin().
     */
    void load();

    /**
     * Clear all history entries and NVS storage.
     */
    void clear();

  private:
    ClimbEntry history[MAX_CLIMB_HISTORY];
    bool hasCurrentClimb_;

    // NVS key for storing history
    static const char* NVS_KEY_HISTORY;

    // Shift all entries down by 1, discarding the oldest
    void shiftDown();
};

extern ClimbHistory ClimbHistoryMgr;

#endif
