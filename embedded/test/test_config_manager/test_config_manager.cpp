// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for Config Manager Library
 *
 * Tests the NVS (Non-Volatile Storage) configuration persistence layer.
 */

#include <Preferences.h>

#include <config_manager.h>
#include <cstring>
#include <unity.h>

// Test instance
static ConfigManager* config;

void setUp(void) {
    Preferences::resetAll();  // Clear all mock storage between tests
    config = new ConfigManager();
}

void tearDown(void) {
    config->end();
    delete config;
    config = nullptr;
}

// =============================================================================
// String Storage Tests
// =============================================================================

void test_setString_and_getString(void) {
    config->setString("key1", "Hello World");
    String result = config->getString("key1");
    TEST_ASSERT_EQUAL_STRING("Hello World", result.c_str());
}

void test_getString_default_when_not_set(void) {
    String result = config->getString("nonexistent", "default_value");
    TEST_ASSERT_EQUAL_STRING("default_value", result.c_str());
}

void test_getString_empty_default(void) {
    String result = config->getString("nonexistent");
    TEST_ASSERT_EQUAL_STRING("", result.c_str());
}

void test_setString_overwrites_existing(void) {
    config->setString("key", "first");
    config->setString("key", "second");
    String result = config->getString("key");
    TEST_ASSERT_EQUAL_STRING("second", result.c_str());
}

void test_setString_empty_value(void) {
    config->setString("key", "");
    String result = config->getString("key", "default");
    TEST_ASSERT_EQUAL_STRING("", result.c_str());
}

void test_setString_special_characters(void) {
    config->setString("key", "Hello\nWorld\t!");
    String result = config->getString("key");
    TEST_ASSERT_EQUAL_STRING("Hello\nWorld\t!", result.c_str());
}

void test_setString_long_value(void) {
    String longValue = "";
    for (int i = 0; i < 100; i++) {
        longValue += "ABCDEFGHIJ";
    }
    config->setString("longkey", longValue);
    String result = config->getString("longkey");
    TEST_ASSERT_EQUAL(1000, result.length());
}

// =============================================================================
// Integer Storage Tests
// =============================================================================

void test_setInt_and_getInt(void) {
    config->setInt("number", 12345);
    int32_t result = config->getInt("number");
    TEST_ASSERT_EQUAL(12345, result);
}

void test_getInt_default_when_not_set(void) {
    int32_t result = config->getInt("nonexistent", -1);
    TEST_ASSERT_EQUAL(-1, result);
}

void test_getInt_zero_default(void) {
    int32_t result = config->getInt("nonexistent");
    TEST_ASSERT_EQUAL(0, result);
}

void test_setInt_negative_value(void) {
    config->setInt("negative", -99999);
    int32_t result = config->getInt("negative");
    TEST_ASSERT_EQUAL(-99999, result);
}

void test_setInt_zero(void) {
    config->setInt("zero", 0);
    int32_t result = config->getInt("zero", 42);  // Default should be ignored
    TEST_ASSERT_EQUAL(0, result);
}

void test_setInt_max_value(void) {
    config->setInt("max", 2147483647);
    int32_t result = config->getInt("max");
    TEST_ASSERT_EQUAL(2147483647, result);
}

void test_setInt_min_value(void) {
    config->setInt("min", -2147483648);
    int32_t result = config->getInt("min");
    TEST_ASSERT_EQUAL(-2147483648, result);
}

void test_setInt_overwrites_existing(void) {
    config->setInt("count", 100);
    config->setInt("count", 200);
    int32_t result = config->getInt("count");
    TEST_ASSERT_EQUAL(200, result);
}

// =============================================================================
// Boolean Storage Tests
// =============================================================================

void test_setBool_true_and_getBool(void) {
    config->setBool("enabled", true);
    bool result = config->getBool("enabled");
    TEST_ASSERT_TRUE(result);
}

void test_setBool_false_and_getBool(void) {
    config->setBool("enabled", false);
    bool result = config->getBool("enabled", true);  // Default should be ignored
    TEST_ASSERT_FALSE(result);
}

void test_getBool_default_when_not_set(void) {
    bool result = config->getBool("nonexistent", true);
    TEST_ASSERT_TRUE(result);
}

void test_getBool_false_default(void) {
    bool result = config->getBool("nonexistent");
    TEST_ASSERT_FALSE(result);
}

void test_setBool_toggle(void) {
    config->setBool("flag", true);
    TEST_ASSERT_TRUE(config->getBool("flag"));

    config->setBool("flag", false);
    TEST_ASSERT_FALSE(config->getBool("flag"));

    config->setBool("flag", true);
    TEST_ASSERT_TRUE(config->getBool("flag"));
}

// =============================================================================
// Byte Array Storage Tests
// =============================================================================

void test_setBytes_and_getBytes(void) {
    uint8_t data[] = {0x01, 0x02, 0x03, 0x04, 0x05};
    config->setBytes("binary", data, sizeof(data));

    uint8_t buffer[10] = {0};
    size_t len = config->getBytes("binary", buffer, sizeof(buffer));

    TEST_ASSERT_EQUAL(5, len);
    TEST_ASSERT_EQUAL_UINT8(0x01, buffer[0]);
    TEST_ASSERT_EQUAL_UINT8(0x02, buffer[1]);
    TEST_ASSERT_EQUAL_UINT8(0x03, buffer[2]);
    TEST_ASSERT_EQUAL_UINT8(0x04, buffer[3]);
    TEST_ASSERT_EQUAL_UINT8(0x05, buffer[4]);
}

void test_getBytes_returns_zero_when_not_set(void) {
    uint8_t buffer[10] = {0xFF};
    size_t len = config->getBytes("nonexistent", buffer, sizeof(buffer));
    TEST_ASSERT_EQUAL(0, len);
}

void test_setBytes_empty_array(void) {
    uint8_t data[] = {0};
    config->setBytes("empty", data, 0);

    uint8_t buffer[10] = {0xFF};
    size_t len = config->getBytes("empty", buffer, sizeof(buffer));
    TEST_ASSERT_EQUAL(0, len);
}

void test_getBytes_truncates_to_maxLen(void) {
    uint8_t data[] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08};
    config->setBytes("long", data, sizeof(data));

    uint8_t buffer[4] = {0};
    size_t len = config->getBytes("long", buffer, 4);

    TEST_ASSERT_EQUAL(4, len);
    TEST_ASSERT_EQUAL_UINT8(0x01, buffer[0]);
    TEST_ASSERT_EQUAL_UINT8(0x04, buffer[3]);
}

void test_setBytes_binary_data(void) {
    uint8_t data[] = {0x00, 0xFF, 0x7F, 0x80, 0xAB, 0xCD};
    config->setBytes("binary", data, sizeof(data));

    uint8_t buffer[10] = {0};
    size_t len = config->getBytes("binary", buffer, sizeof(buffer));

    TEST_ASSERT_EQUAL(6, len);
    TEST_ASSERT_EQUAL_UINT8(0x00, buffer[0]);
    TEST_ASSERT_EQUAL_UINT8(0xFF, buffer[1]);
    TEST_ASSERT_EQUAL_UINT8(0x7F, buffer[2]);
    TEST_ASSERT_EQUAL_UINT8(0x80, buffer[3]);
}

// =============================================================================
// Key Existence Tests
// =============================================================================

void test_hasKey_returns_false_when_not_set(void) {
    TEST_ASSERT_FALSE(config->hasKey("nonexistent"));
}

void test_hasKey_returns_true_for_string(void) {
    config->setString("mykey", "value");
    TEST_ASSERT_TRUE(config->hasKey("mykey"));
}

void test_hasKey_returns_true_for_int(void) {
    config->setInt("myint", 42);
    TEST_ASSERT_TRUE(config->hasKey("myint"));
}

void test_hasKey_returns_true_for_bool(void) {
    config->setBool("mybool", false);
    TEST_ASSERT_TRUE(config->hasKey("mybool"));
}

void test_hasKey_returns_true_for_bytes(void) {
    uint8_t data[] = {0x01};
    config->setBytes("mybytes", data, 1);
    TEST_ASSERT_TRUE(config->hasKey("mybytes"));
}

// =============================================================================
// Key Removal Tests
// =============================================================================

void test_remove_key(void) {
    config->setString("toremove", "value");
    TEST_ASSERT_TRUE(config->hasKey("toremove"));

    config->remove("toremove");
    TEST_ASSERT_FALSE(config->hasKey("toremove"));
}

void test_remove_nonexistent_key(void) {
    config->remove("nonexistent");  // Should not crash
    TEST_ASSERT_TRUE(true);
}

void test_remove_and_reuse_key(void) {
    config->setString("key", "first");
    config->remove("key");
    config->setString("key", "second");

    String result = config->getString("key");
    TEST_ASSERT_EQUAL_STRING("second", result.c_str());
}

// =============================================================================
// Clear All Tests
// =============================================================================

void test_clear_removes_all_keys(void) {
    config->setString("str", "value");
    config->setInt("num", 42);
    config->setBool("flag", true);

    config->clear();

    TEST_ASSERT_FALSE(config->hasKey("str"));
    TEST_ASSERT_FALSE(config->hasKey("num"));
    TEST_ASSERT_FALSE(config->hasKey("flag"));
}

void test_clear_allows_new_values(void) {
    config->setString("key", "old");
    config->clear();
    config->setString("key", "new");

    String result = config->getString("key");
    TEST_ASSERT_EQUAL_STRING("new", result.c_str());
}

// =============================================================================
// Begin/End Lifecycle Tests
// =============================================================================

void test_begin_is_called_automatically(void) {
    // Methods should work without explicit begin()
    config->setString("auto", "value");
    String result = config->getString("auto");
    TEST_ASSERT_EQUAL_STRING("value", result.c_str());
}

void test_end_can_be_called_safely(void) {
    config->setString("key", "value");
    config->end();
    // After end(), operations should still work (begin is called automatically)
    config->setString("key2", "value2");
    String result = config->getString("key2");
    TEST_ASSERT_EQUAL_STRING("value2", result.c_str());
}

void test_multiple_end_calls(void) {
    config->end();
    config->end();  // Should not crash
    TEST_ASSERT_TRUE(true);
}

// =============================================================================
// Edge Cases
// =============================================================================

void test_different_keys_are_independent(void) {
    config->setString("key1", "value1");
    config->setString("key2", "value2");
    config->setInt("key3", 123);

    TEST_ASSERT_EQUAL_STRING("value1", config->getString("key1").c_str());
    TEST_ASSERT_EQUAL_STRING("value2", config->getString("key2").c_str());
    TEST_ASSERT_EQUAL(123, config->getInt("key3"));
}

void test_overwrite_different_type(void) {
    // Set as string first
    config->setString("mixed", "text");
    TEST_ASSERT_EQUAL_STRING("text", config->getString("mixed").c_str());

    // Overwrite with int (different storage)
    config->setInt("mixed", 999);
    TEST_ASSERT_EQUAL(999, config->getInt("mixed"));
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // String storage tests
    RUN_TEST(test_setString_and_getString);
    RUN_TEST(test_getString_default_when_not_set);
    RUN_TEST(test_getString_empty_default);
    RUN_TEST(test_setString_overwrites_existing);
    RUN_TEST(test_setString_empty_value);
    RUN_TEST(test_setString_special_characters);
    RUN_TEST(test_setString_long_value);

    // Integer storage tests
    RUN_TEST(test_setInt_and_getInt);
    RUN_TEST(test_getInt_default_when_not_set);
    RUN_TEST(test_getInt_zero_default);
    RUN_TEST(test_setInt_negative_value);
    RUN_TEST(test_setInt_zero);
    RUN_TEST(test_setInt_max_value);
    RUN_TEST(test_setInt_min_value);
    RUN_TEST(test_setInt_overwrites_existing);

    // Boolean storage tests
    RUN_TEST(test_setBool_true_and_getBool);
    RUN_TEST(test_setBool_false_and_getBool);
    RUN_TEST(test_getBool_default_when_not_set);
    RUN_TEST(test_getBool_false_default);
    RUN_TEST(test_setBool_toggle);

    // Byte array storage tests
    RUN_TEST(test_setBytes_and_getBytes);
    RUN_TEST(test_getBytes_returns_zero_when_not_set);
    RUN_TEST(test_setBytes_empty_array);
    RUN_TEST(test_getBytes_truncates_to_maxLen);
    RUN_TEST(test_setBytes_binary_data);

    // Key existence tests
    RUN_TEST(test_hasKey_returns_false_when_not_set);
    RUN_TEST(test_hasKey_returns_true_for_string);
    RUN_TEST(test_hasKey_returns_true_for_int);
    RUN_TEST(test_hasKey_returns_true_for_bool);
    RUN_TEST(test_hasKey_returns_true_for_bytes);

    // Key removal tests
    RUN_TEST(test_remove_key);
    RUN_TEST(test_remove_nonexistent_key);
    RUN_TEST(test_remove_and_reuse_key);

    // Clear all tests
    RUN_TEST(test_clear_removes_all_keys);
    RUN_TEST(test_clear_allows_new_values);

    // Begin/End lifecycle tests
    RUN_TEST(test_begin_is_called_automatically);
    RUN_TEST(test_end_can_be_called_safely);
    RUN_TEST(test_multiple_end_calls);

    // Edge cases
    RUN_TEST(test_different_keys_are_independent);
    RUN_TEST(test_overwrite_different_type);

    return UNITY_END();
}
