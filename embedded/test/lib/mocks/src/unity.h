// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unity Test Framework Mock for Syntax Checking
 *
 * This is a minimal mock of Unity for local compilation testing.
 * In CI, PlatformIO provides the real Unity framework.
 */

#ifndef UNITY_MOCK_H
#define UNITY_MOCK_H

#include <cstdio>
#include <cstdlib>
#include <cstring>

// Test counters - using inline to avoid ODR violations if header included multiple times
inline int unity_tests_run = 0;
inline int unity_tests_failed = 0;
inline const char* unity_current_test = nullptr;

// Unity macros
#define UNITY_BEGIN() (unity_tests_run = 0, unity_tests_failed = 0, 0)
#define UNITY_END()                                                                                    \
    (printf("\n-----------------------\n%d Tests %d Failures\n", unity_tests_run, unity_tests_failed), \
     unity_tests_failed)

#define RUN_TEST(func)                              \
    do {                                            \
        unity_current_test = #func;                 \
        unity_tests_run++;                          \
        int _failed_before = unity_tests_failed;    \
        printf("Running %s...", #func);             \
        setUp();                                    \
        func();                                     \
        tearDown();                                 \
        if (unity_tests_failed == _failed_before) { \
            printf(" PASSED\n");                    \
        }                                           \
    } while (0)

// Basic assertions
#define TEST_ASSERT(condition)                                                                  \
    do {                                                                                        \
        if (!(condition)) {                                                                     \
            printf(" FAILED\n  %s:%d: Assertion failed: %s\n", __FILE__, __LINE__, #condition); \
            unity_tests_failed++;                                                               \
            return;                                                                             \
        }                                                                                       \
    } while (0)

#define TEST_ASSERT_TRUE(condition) TEST_ASSERT(condition)
#define TEST_ASSERT_FALSE(condition) TEST_ASSERT(!(condition))

#define TEST_ASSERT_NULL(pointer) TEST_ASSERT((pointer) == nullptr)
#define TEST_ASSERT_NOT_NULL(pointer) TEST_ASSERT((pointer) != nullptr)

#define TEST_ASSERT_EQUAL(expected, actual)                                                              \
    do {                                                                                                 \
        if ((expected) != (actual)) {                                                                    \
            printf(" FAILED\n  %s:%d: Expected %ld but was %ld\n", __FILE__, __LINE__, (long)(expected), \
                   (long)(actual));                                                                      \
            unity_tests_failed++;                                                                        \
            return;                                                                                      \
        }                                                                                                \
    } while (0)

#define TEST_ASSERT_EQUAL_INT(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_INT8(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_INT16(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_INT32(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_UINT(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_UINT8(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_UINT16(expected, actual) TEST_ASSERT_EQUAL(expected, actual)
#define TEST_ASSERT_EQUAL_UINT32(expected, actual) TEST_ASSERT_EQUAL(expected, actual)

#define TEST_ASSERT_EQUAL_STRING(expected, actual)                                                                  \
    do {                                                                                                            \
        if (strcmp((expected), (actual)) != 0) {                                                                    \
            printf(" FAILED\n  %s:%d: Expected \"%s\" but was \"%s\"\n", __FILE__, __LINE__, (expected), (actual)); \
            unity_tests_failed++;                                                                                   \
            return;                                                                                                 \
        }                                                                                                           \
    } while (0)

#define TEST_ASSERT_EQUAL_MEMORY(expected, actual, len)                                 \
    do {                                                                                \
        if (memcmp((expected), (actual), (len)) != 0) {                                 \
            printf(" FAILED\n  %s:%d: Memory comparison failed\n", __FILE__, __LINE__); \
            unity_tests_failed++;                                                       \
            return;                                                                     \
        }                                                                               \
    } while (0)

// Floating point assertions (approximate)
#define TEST_ASSERT_FLOAT_WITHIN(delta, expected, actual)                                                       \
    do {                                                                                                        \
        double diff = (expected) - (actual);                                                                    \
        if (diff < 0)                                                                                           \
            diff = -diff;                                                                                       \
        if (diff > (delta)) {                                                                                   \
            printf(" FAILED\n  %s:%d: Expected %f +/- %f but was %f\n", __FILE__, __LINE__, (double)(expected), \
                   (double)(delta), (double)(actual));                                                          \
            unity_tests_failed++;                                                                               \
            return;                                                                                             \
        }                                                                                                       \
    } while (0)

#define TEST_FAIL_MESSAGE(msg)                                     \
    do {                                                           \
        printf(" FAILED\n  %s:%d: %s\n", __FILE__, __LINE__, msg); \
        unity_tests_failed++;                                      \
        return;                                                    \
    } while (0)

#define TEST_FAIL() TEST_FAIL_MESSAGE("Test failed")

#define TEST_IGNORE_MESSAGE(msg)       \
    do {                               \
        printf(" IGNORED: %s\n", msg); \
    } while (0)

#define TEST_IGNORE() TEST_IGNORE_MESSAGE("")

#endif  // UNITY_MOCK_H
