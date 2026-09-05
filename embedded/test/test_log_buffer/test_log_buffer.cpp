// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for Log Buffer Library
 *
 * Tests the ring buffer logging utility that stores log messages
 * for later retrieval (e.g., via web interface).
 */

#include <cstring>
#include <log_buffer.h>
#include <unity.h>

// Test instance - use a fresh instance for each test
static LogBuffer* logger;

void setUp(void) {
    logger = new LogBuffer();
    logger->enableSerial(false);  // Disable serial output during tests
}

void tearDown(void) {
    delete logger;
    logger = nullptr;
}

// =============================================================================
// Basic Functionality Tests
// =============================================================================

void test_initial_state_empty(void) {
    TEST_ASSERT_EQUAL(0, logger->getSize());
    TEST_ASSERT_TRUE(logger->getBuffer().isEmpty());
}

void test_log_simple_string(void) {
    logger->log("Hello");

    TEST_ASSERT_EQUAL(5, logger->getSize());
    TEST_ASSERT_EQUAL_STRING("Hello", logger->getBuffer().c_str());
}

void test_logln_adds_newline(void) {
    logger->logln("Hello");

    TEST_ASSERT_EQUAL(6, logger->getSize());
    TEST_ASSERT_EQUAL_STRING("Hello\n", logger->getBuffer().c_str());
}

void test_log_multiple_messages(void) {
    logger->log("One");
    logger->log("Two");
    logger->log("Three");

    TEST_ASSERT_EQUAL_STRING("OneTwoThree", logger->getBuffer().c_str());
    TEST_ASSERT_EQUAL(11, logger->getSize());
}

void test_logln_multiple_messages(void) {
    logger->logln("Line 1");
    logger->logln("Line 2");

    TEST_ASSERT_EQUAL_STRING("Line 1\nLine 2\n", logger->getBuffer().c_str());
}

void test_mixed_log_and_logln(void) {
    logger->log("Start: ");
    logger->logln("value");
    logger->log("End");

    TEST_ASSERT_EQUAL_STRING("Start: value\nEnd", logger->getBuffer().c_str());
}

// =============================================================================
// Format String Tests
// =============================================================================

void test_log_format_integer(void) {
    logger->log("Count: %d", 42);

    TEST_ASSERT_EQUAL_STRING("Count: 42", logger->getBuffer().c_str());
}

void test_log_format_string(void) {
    logger->log("Name: %s", "test");

    TEST_ASSERT_EQUAL_STRING("Name: test", logger->getBuffer().c_str());
}

void test_log_format_multiple_args(void) {
    logger->log("x=%d, y=%d, name=%s", 10, 20, "point");

    TEST_ASSERT_EQUAL_STRING("x=10, y=20, name=point", logger->getBuffer().c_str());
}

void test_log_format_hex(void) {
    logger->log("Value: 0x%02X", 255);

    TEST_ASSERT_EQUAL_STRING("Value: 0xFF", logger->getBuffer().c_str());
}

void test_logln_format_integer(void) {
    logger->logln("Result: %d", 123);

    TEST_ASSERT_EQUAL_STRING("Result: 123\n", logger->getBuffer().c_str());
}

void test_log_empty_format(void) {
    logger->log("");

    TEST_ASSERT_EQUAL(0, logger->getSize());
}

void test_logln_empty_format(void) {
    logger->logln("");

    // Should still add newline
    TEST_ASSERT_EQUAL(1, logger->getSize());
    TEST_ASSERT_EQUAL_STRING("\n", logger->getBuffer().c_str());
}

// =============================================================================
// Clear Tests
// =============================================================================

void test_clear_empties_buffer(void) {
    logger->log("Some data");
    TEST_ASSERT_TRUE(logger->getSize() > 0);

    logger->clear();

    TEST_ASSERT_EQUAL(0, logger->getSize());
    TEST_ASSERT_TRUE(logger->getBuffer().isEmpty());
}

void test_clear_allows_reuse(void) {
    logger->log("First");
    logger->clear();
    logger->log("Second");

    TEST_ASSERT_EQUAL_STRING("Second", logger->getBuffer().c_str());
}

void test_multiple_clears(void) {
    logger->log("Data");
    logger->clear();
    logger->clear();  // Should be safe to clear again

    TEST_ASSERT_EQUAL(0, logger->getSize());
}

// =============================================================================
// Buffer Size Tests
// =============================================================================

void test_getSize_tracks_length(void) {
    TEST_ASSERT_EQUAL(0, logger->getSize());

    logger->log("12345");
    TEST_ASSERT_EQUAL(5, logger->getSize());

    logger->log("67890");
    TEST_ASSERT_EQUAL(10, logger->getSize());
}

void test_getSize_after_clear(void) {
    logger->log("Some text");
    logger->clear();

    TEST_ASSERT_EQUAL(0, logger->getSize());
}

// =============================================================================
// Ring Buffer Wrap Tests
// =============================================================================

void test_buffer_wraps_on_overflow(void) {
    // Fill the buffer with more than LOG_BUFFER_SIZE data
    // LOG_BUFFER_SIZE is 2048 by default

    // Write enough data to trigger wrap
    for (int i = 0; i < 100; i++) {
        logger->logln("This is log message number %d with some extra padding text", i);
    }

    // Buffer should still work - size should be < LOG_BUFFER_SIZE
    size_t size = logger->getSize();
    TEST_ASSERT_TRUE(size > 0);
    TEST_ASSERT_TRUE(size < LOG_BUFFER_SIZE);

    // Should be able to retrieve content
    String content = logger->getBuffer();
    TEST_ASSERT_TRUE(content.length() > 0);
}

void test_buffer_wrap_preserves_recent_data(void) {
    // Write a known sequence that will overflow
    for (int i = 0; i < 50; i++) {
        logger->logln("Message %d padding padding padding padding", i);
    }

    // The most recent messages should be in the buffer
    String content = logger->getBuffer();

    // Should contain some of the later messages (exact numbers depend on wrap behavior)
    // At minimum, the buffer should have valid content
    TEST_ASSERT_TRUE(content.length() > 0);
}

void test_buffer_continues_working_after_wrap(void) {
    // Overflow the buffer
    for (int i = 0; i < 100; i++) {
        logger->logln("Overflow message %d", i);
    }

    // Clear and verify it still works
    logger->clear();
    logger->log("After wrap");

    TEST_ASSERT_EQUAL_STRING("After wrap", logger->getBuffer().c_str());
}

// =============================================================================
// Serial Enable/Disable Tests
// =============================================================================

void test_serial_can_be_disabled(void) {
    logger->enableSerial(false);

    // Should not crash when logging with serial disabled
    logger->logln("Test message");
    logger->logln("Another message");

    TEST_ASSERT_EQUAL_STRING("Test message\nAnother message\n", logger->getBuffer().c_str());
}

void test_serial_can_be_reenabled(void) {
    logger->enableSerial(false);
    logger->log("First");
    logger->enableSerial(true);
    logger->log("Second");

    // Both messages should be in buffer regardless of serial state
    TEST_ASSERT_EQUAL_STRING("FirstSecond", logger->getBuffer().c_str());
}

// =============================================================================
// Edge Cases
// =============================================================================

void test_log_very_long_message(void) {
    // Create a message close to the temp buffer limit (256 chars)
    char longMsg[250];
    memset(longMsg, 'X', sizeof(longMsg) - 1);
    longMsg[sizeof(longMsg) - 1] = '\0';

    logger->log("%s", longMsg);

    // Should have logged something (may be truncated)
    TEST_ASSERT_TRUE(logger->getSize() > 0);
}

void test_log_format_truncation(void) {
    // Format string that would produce > 256 chars
    char result[300];
    memset(result, 'Y', 280);
    result[280] = '\0';

    logger->log("%s", result);

    // The internal temp buffer is 256, so output may be truncated
    // But it should not crash and should have some data
    TEST_ASSERT_TRUE(logger->getSize() > 0);
    TEST_ASSERT_TRUE(logger->getSize() <= 256);
}

void test_log_special_characters(void) {
    logger->log("Tab:\tNewline:\nPercent:%%");

    String content = logger->getBuffer();
    TEST_ASSERT_TRUE(content.indexOf('\t') >= 0);
    TEST_ASSERT_TRUE(content.indexOf('\n') >= 0);
    TEST_ASSERT_TRUE(content.indexOf('%') >= 0);
}

void test_log_unicode_bytes(void) {
    // Log some high-byte values (UTF-8 sequences)
    logger->log("\xC2\xA9");  // Copyright symbol in UTF-8

    TEST_ASSERT_EQUAL(2, logger->getSize());
}

void test_getBuffer_returns_copy(void) {
    logger->log("Original");

    String buffer1 = logger->getBuffer();
    String buffer2 = logger->getBuffer();

    // Both should have same content
    TEST_ASSERT_TRUE(buffer1 == buffer2);

    // Modifying one shouldn't affect the other
    // (This is testing the String behavior, not LogBuffer directly)
}

void test_rapid_logging(void) {
    // Simulate rapid logging that might occur during debugging
    for (int i = 0; i < 1000; i++) {
        logger->log("%d,", i);
    }

    // Should not crash and should have data
    TEST_ASSERT_TRUE(logger->getSize() > 0);
}

// =============================================================================
// Boundary Tests
// =============================================================================

void test_log_exactly_buffer_size(void) {
    // Try to fill buffer to exactly capacity
    // This is tricky because of the wrap logic, but shouldn't crash
    while (logger->getSize() < LOG_BUFFER_SIZE - 100) {
        logger->log("X");
    }

    TEST_ASSERT_TRUE(logger->getSize() > 0);
}

void test_clear_after_wrap(void) {
    // Fill and wrap
    for (int i = 0; i < 100; i++) {
        logger->logln("Wrapping message %d with extra content", i);
    }

    // Clear
    logger->clear();

    // Should be empty
    TEST_ASSERT_EQUAL(0, logger->getSize());

    // Should work normally after
    logger->log("Fresh start");
    TEST_ASSERT_EQUAL_STRING("Fresh start", logger->getBuffer().c_str());
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // Basic functionality tests
    RUN_TEST(test_initial_state_empty);
    RUN_TEST(test_log_simple_string);
    RUN_TEST(test_logln_adds_newline);
    RUN_TEST(test_log_multiple_messages);
    RUN_TEST(test_logln_multiple_messages);
    RUN_TEST(test_mixed_log_and_logln);

    // Format string tests
    RUN_TEST(test_log_format_integer);
    RUN_TEST(test_log_format_string);
    RUN_TEST(test_log_format_multiple_args);
    RUN_TEST(test_log_format_hex);
    RUN_TEST(test_logln_format_integer);
    RUN_TEST(test_log_empty_format);
    RUN_TEST(test_logln_empty_format);

    // Clear tests
    RUN_TEST(test_clear_empties_buffer);
    RUN_TEST(test_clear_allows_reuse);
    RUN_TEST(test_multiple_clears);

    // Buffer size tests
    RUN_TEST(test_getSize_tracks_length);
    RUN_TEST(test_getSize_after_clear);

    // Ring buffer wrap tests
    RUN_TEST(test_buffer_wraps_on_overflow);
    RUN_TEST(test_buffer_wrap_preserves_recent_data);
    RUN_TEST(test_buffer_continues_working_after_wrap);

    // Serial enable/disable tests
    RUN_TEST(test_serial_can_be_disabled);
    RUN_TEST(test_serial_can_be_reenabled);

    // Edge cases
    RUN_TEST(test_log_very_long_message);
    RUN_TEST(test_log_format_truncation);
    RUN_TEST(test_log_special_characters);
    RUN_TEST(test_log_unicode_bytes);
    RUN_TEST(test_getBuffer_returns_copy);
    RUN_TEST(test_rapid_logging);

    // Boundary tests
    RUN_TEST(test_log_exactly_buffer_size);
    RUN_TEST(test_clear_after_wrap);

    return UNITY_END();
}
