// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for Climb History Library
 *
 * Tests the circular buffer climb history with NVS persistence.
 */

#include <Preferences.h>

#include <climb_history.h>
#include <cstring>
#include <unity.h>

// Test instance (use the global ClimbHistoryMgr)
void setUp(void) {
    Preferences::resetAll();  // Clear all mock storage between tests
    ClimbHistoryMgr.clear();  // Clear history state
}

void tearDown(void) {
    // Nothing to clean up
}

// =============================================================================
// Basic Add/Get Tests
// =============================================================================

void test_addClimb_and_getCurrentClimb(void) {
    ClimbHistoryMgr.addClimb("Test Climb", "V5", "uuid-123");

    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_NOT_NULL(climb);
    TEST_ASSERT_EQUAL_STRING("Test Climb", climb->name);
    TEST_ASSERT_EQUAL_STRING("V5", climb->grade);
    TEST_ASSERT_EQUAL_STRING("uuid-123", climb->uuid);
    TEST_ASSERT_TRUE(climb->valid);
}

void test_hasCurrentClimb_false_when_empty(void) {
    TEST_ASSERT_FALSE(ClimbHistoryMgr.hasCurrentClimb());
}

void test_hasCurrentClimb_true_after_add(void) {
    ClimbHistoryMgr.addClimb("Climb", "V3", "uuid-1");
    TEST_ASSERT_TRUE(ClimbHistoryMgr.hasCurrentClimb());
}

void test_getCurrentClimb_null_when_empty(void) {
    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_NULL(climb);
}

void test_getCount_returns_zero_when_empty(void) {
    TEST_ASSERT_EQUAL(0, ClimbHistoryMgr.getCount());
}

void test_getCount_increments_with_adds(void) {
    ClimbHistoryMgr.addClimb("Climb 1", "V1", "uuid-1");
    TEST_ASSERT_EQUAL(1, ClimbHistoryMgr.getCount());

    ClimbHistoryMgr.addClimb("Climb 2", "V2", "uuid-2");
    TEST_ASSERT_EQUAL(2, ClimbHistoryMgr.getCount());

    ClimbHistoryMgr.addClimb("Climb 3", "V3", "uuid-3");
    TEST_ASSERT_EQUAL(3, ClimbHistoryMgr.getCount());
}

// =============================================================================
// History Shifting Tests
// =============================================================================

void test_history_shifts_down_when_new_climb_added(void) {
    ClimbHistoryMgr.addClimb("First", "V1", "uuid-1");
    ClimbHistoryMgr.addClimb("Second", "V2", "uuid-2");

    // Current should be Second
    const ClimbEntry* current = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_EQUAL_STRING("Second", current->name);

    // Previous should be First
    const ClimbEntry* previous = ClimbHistoryMgr.getClimb(1);
    TEST_ASSERT_NOT_NULL(previous);
    TEST_ASSERT_EQUAL_STRING("First", previous->name);
}

void test_history_maintains_order(void) {
    ClimbHistoryMgr.addClimb("Climb 1", "V1", "uuid-1");
    ClimbHistoryMgr.addClimb("Climb 2", "V2", "uuid-2");
    ClimbHistoryMgr.addClimb("Climb 3", "V3", "uuid-3");
    ClimbHistoryMgr.addClimb("Climb 4", "V4", "uuid-4");

    TEST_ASSERT_EQUAL_STRING("Climb 4", ClimbHistoryMgr.getClimb(0)->name);
    TEST_ASSERT_EQUAL_STRING("Climb 3", ClimbHistoryMgr.getClimb(1)->name);
    TEST_ASSERT_EQUAL_STRING("Climb 2", ClimbHistoryMgr.getClimb(2)->name);
    TEST_ASSERT_EQUAL_STRING("Climb 1", ClimbHistoryMgr.getClimb(3)->name);
}

void test_history_limits_to_max(void) {
    // Add more than MAX_CLIMB_HISTORY (5) climbs
    for (int i = 0; i < 7; i++) {
        char name[32];
        char uuid[32];
        snprintf(name, sizeof(name), "Climb %d", i);
        snprintf(uuid, sizeof(uuid), "uuid-%d", i);
        ClimbHistoryMgr.addClimb(name, "V1", uuid);
    }

    // Should only have MAX_CLIMB_HISTORY entries
    TEST_ASSERT_EQUAL(MAX_CLIMB_HISTORY, ClimbHistoryMgr.getCount());

    // Most recent should be Climb 6
    TEST_ASSERT_EQUAL_STRING("Climb 6", ClimbHistoryMgr.getClimb(0)->name);

    // Oldest in history should be Climb 2 (0 and 1 were pushed out)
    TEST_ASSERT_EQUAL_STRING("Climb 2", ClimbHistoryMgr.getClimb(MAX_CLIMB_HISTORY - 1)->name);
}

// =============================================================================
// Update Existing Climb Tests
// =============================================================================

void test_same_uuid_updates_instead_of_shifts(void) {
    ClimbHistoryMgr.addClimb("Original Name", "V3", "uuid-same");
    ClimbHistoryMgr.addClimb("Updated Name", "V4", "uuid-same");

    // Should still only have 1 entry
    TEST_ASSERT_EQUAL(1, ClimbHistoryMgr.getCount());

    // Name and grade should be updated
    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_EQUAL_STRING("Updated Name", climb->name);
    TEST_ASSERT_EQUAL_STRING("V4", climb->grade);
    TEST_ASSERT_EQUAL_STRING("uuid-same", climb->uuid);
}

void test_update_only_applies_to_current(void) {
    ClimbHistoryMgr.addClimb("First", "V1", "uuid-1");
    ClimbHistoryMgr.addClimb("Second", "V2", "uuid-2");

    // Now add with uuid-1 (which is now in position 1, not current)
    ClimbHistoryMgr.addClimb("New Climb", "V3", "uuid-1");

    // This should add a NEW entry (not update position 1)
    TEST_ASSERT_EQUAL(3, ClimbHistoryMgr.getCount());
    TEST_ASSERT_EQUAL_STRING("New Climb", ClimbHistoryMgr.getClimb(0)->name);
}

// =============================================================================
// Clear Current Tests
// =============================================================================

void test_clearCurrent_marks_no_current(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    TEST_ASSERT_TRUE(ClimbHistoryMgr.hasCurrentClimb());

    ClimbHistoryMgr.clearCurrent();
    TEST_ASSERT_FALSE(ClimbHistoryMgr.hasCurrentClimb());
}

void test_clearCurrent_keeps_history(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    ClimbHistoryMgr.clearCurrent();

    // Count should still be 1 (entry exists, just not "current")
    TEST_ASSERT_EQUAL(1, ClimbHistoryMgr.getCount());

    // getClimb should still work
    const ClimbEntry* climb = ClimbHistoryMgr.getClimb(0);
    TEST_ASSERT_NOT_NULL(climb);
    TEST_ASSERT_EQUAL_STRING("Climb", climb->name);
}

void test_getCurrentClimb_null_after_clearCurrent(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    ClimbHistoryMgr.clearCurrent();

    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_NULL(climb);
}

// =============================================================================
// Get Climb By Index Tests
// =============================================================================

void test_getClimb_returns_null_for_negative_index(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    TEST_ASSERT_NULL(ClimbHistoryMgr.getClimb(-1));
}

void test_getClimb_returns_null_for_out_of_bounds_index(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    TEST_ASSERT_NULL(ClimbHistoryMgr.getClimb(MAX_CLIMB_HISTORY));
}

void test_getClimb_returns_null_for_empty_slot(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", "uuid-1");
    // Only 1 entry, so index 1 should be null
    TEST_ASSERT_NULL(ClimbHistoryMgr.getClimb(1));
}

// =============================================================================
// Edge Cases
// =============================================================================

void test_addClimb_with_null_name_is_ignored(void) {
    ClimbHistoryMgr.addClimb(nullptr, "V1", "uuid-1");
    TEST_ASSERT_EQUAL(0, ClimbHistoryMgr.getCount());
}

void test_addClimb_with_null_uuid_is_ignored(void) {
    ClimbHistoryMgr.addClimb("Climb", "V1", nullptr);
    TEST_ASSERT_EQUAL(0, ClimbHistoryMgr.getCount());
}

void test_addClimb_with_null_grade_is_ok(void) {
    ClimbHistoryMgr.addClimb("Climb", nullptr, "uuid-1");
    TEST_ASSERT_EQUAL(1, ClimbHistoryMgr.getCount());

    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_EQUAL_STRING("", climb->grade);
}

void test_addClimb_truncates_long_name(void) {
    // Create a very long name
    char longName[100];
    memset(longName, 'A', sizeof(longName) - 1);
    longName[sizeof(longName) - 1] = '\0';

    ClimbHistoryMgr.addClimb(longName, "V1", "uuid-1");

    const ClimbEntry* climb = ClimbHistoryMgr.getCurrentClimb();
    TEST_ASSERT_TRUE(strlen(climb->name) < MAX_CLIMB_NAME_LEN);
}

void test_clear_removes_all_history(void) {
    ClimbHistoryMgr.addClimb("Climb 1", "V1", "uuid-1");
    ClimbHistoryMgr.addClimb("Climb 2", "V2", "uuid-2");
    TEST_ASSERT_EQUAL(2, ClimbHistoryMgr.getCount());

    ClimbHistoryMgr.clear();

    TEST_ASSERT_EQUAL(0, ClimbHistoryMgr.getCount());
    TEST_ASSERT_FALSE(ClimbHistoryMgr.hasCurrentClimb());
    TEST_ASSERT_NULL(ClimbHistoryMgr.getCurrentClimb());
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Basic add/get tests
    RUN_TEST(test_addClimb_and_getCurrentClimb);
    RUN_TEST(test_hasCurrentClimb_false_when_empty);
    RUN_TEST(test_hasCurrentClimb_true_after_add);
    RUN_TEST(test_getCurrentClimb_null_when_empty);
    RUN_TEST(test_getCount_returns_zero_when_empty);
    RUN_TEST(test_getCount_increments_with_adds);

    // History shifting tests
    RUN_TEST(test_history_shifts_down_when_new_climb_added);
    RUN_TEST(test_history_maintains_order);
    RUN_TEST(test_history_limits_to_max);

    // Update existing climb tests
    RUN_TEST(test_same_uuid_updates_instead_of_shifts);
    RUN_TEST(test_update_only_applies_to_current);

    // Clear current tests
    RUN_TEST(test_clearCurrent_marks_no_current);
    RUN_TEST(test_clearCurrent_keeps_history);
    RUN_TEST(test_getCurrentClimb_null_after_clearCurrent);

    // Get climb by index tests
    RUN_TEST(test_getClimb_returns_null_for_negative_index);
    RUN_TEST(test_getClimb_returns_null_for_out_of_bounds_index);
    RUN_TEST(test_getClimb_returns_null_for_empty_slot);

    // Edge cases
    RUN_TEST(test_addClimb_with_null_name_is_ignored);
    RUN_TEST(test_addClimb_with_null_uuid_is_ignored);
    RUN_TEST(test_addClimb_with_null_grade_is_ok);
    RUN_TEST(test_addClimb_truncates_long_name);
    RUN_TEST(test_clear_removes_all_history);

    return UNITY_END();
}
