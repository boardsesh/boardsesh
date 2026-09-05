// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit Tests for Grade Colors Library
 *
 * Tests the V-grade color scheme functions for climbing grades.
 * These are pure functions that require no hardware mocks.
 */

#include <grade_colors.h>
#include <unity.h>

void setUp(void) {
    // Nothing to set up - pure functions
}

void tearDown(void) {
    // Nothing to clean up
}

// =============================================================================
// getVGradeColorByNumber Tests
// =============================================================================

void test_vgrade_0_returns_yellow(void) {
    uint16_t color = getVGradeColorByNumber(0);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V0, color);
}

void test_vgrade_5_returns_red(void) {
    uint16_t color = getVGradeColorByNumber(5);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V5, color);
}

void test_vgrade_10_returns_red_purple(void) {
    uint16_t color = getVGradeColorByNumber(10);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V10, color);
}

void test_vgrade_17_returns_darkest_purple(void) {
    uint16_t color = getVGradeColorByNumber(17);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V17, color);
}

void test_vgrade_greater_than_17_returns_v17_color(void) {
    uint16_t color = getVGradeColorByNumber(20);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V17, color);

    color = getVGradeColorByNumber(100);
    TEST_ASSERT_EQUAL_UINT16(COLOR_V17, color);
}

void test_vgrade_negative_returns_default_gray(void) {
    uint16_t color = getVGradeColorByNumber(-1);
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);

    color = getVGradeColorByNumber(-5);
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_vgrade_all_values_0_to_17(void) {
    // Verify each V-grade returns a unique color
    uint16_t expectedColors[] = {COLOR_V0,  COLOR_V1,  COLOR_V2,  COLOR_V3,  COLOR_V4,  COLOR_V5,
                                 COLOR_V6,  COLOR_V7,  COLOR_V8,  COLOR_V9,  COLOR_V10, COLOR_V11,
                                 COLOR_V12, COLOR_V13, COLOR_V14, COLOR_V15, COLOR_V16, COLOR_V17};

    for (int i = 0; i <= 17; i++) {
        uint16_t color = getVGradeColorByNumber(i);
        TEST_ASSERT_EQUAL_UINT16(expectedColors[i], color);
    }
}

// =============================================================================
// getFontGradeColor Tests
// =============================================================================

void test_font_grade_4a_returns_v0_color(void) {
    uint16_t color = getFontGradeColor("4a");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V0, color);
}

void test_font_grade_5a_returns_v1_color(void) {
    uint16_t color = getFontGradeColor("5a");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V1, color);
}

void test_font_grade_5c_returns_v2_color(void) {
    uint16_t color = getFontGradeColor("5c");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V2, color);
}

void test_font_grade_6a_returns_v3_color(void) {
    uint16_t color = getFontGradeColor("6a");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V3, color);
}

void test_font_grade_6b_returns_v4_color(void) {
    uint16_t color = getFontGradeColor("6b");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V4, color);
}

void test_font_grade_7a_plus_returns_v7_color(void) {
    uint16_t color = getFontGradeColor("7a+");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V7, color);
}

void test_font_grade_7c_plus_returns_v10_color(void) {
    uint16_t color = getFontGradeColor("7c+");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V10, color);
}

void test_font_grade_8a_returns_v11_color(void) {
    uint16_t color = getFontGradeColor("8a");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V11, color);
}

void test_font_grade_8c_plus_returns_v16_color(void) {
    uint16_t color = getFontGradeColor("8c+");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V16, color);
}

void test_font_grade_null_returns_default(void) {
    uint16_t color = getFontGradeColor(nullptr);
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_font_grade_empty_returns_default(void) {
    uint16_t color = getFontGradeColor("");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_font_grade_single_char_returns_default(void) {
    uint16_t color = getFontGradeColor("6");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_font_grade_invalid_returns_default(void) {
    uint16_t color = getFontGradeColor("xyz");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);

    color = getFontGradeColor("9a");  // 9 is out of range
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

// =============================================================================
// getGradeColor Tests
// =============================================================================

void test_grade_color_v3_returns_v3_color(void) {
    uint16_t color = getGradeColor("V3");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V3, color);
}

void test_grade_color_lowercase_v3_returns_v3_color(void) {
    uint16_t color = getGradeColor("v3");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V3, color);
}

void test_grade_color_v10_returns_v10_color(void) {
    uint16_t color = getGradeColor("V10");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V10, color);
}

void test_grade_color_v17_returns_v17_color(void) {
    uint16_t color = getGradeColor("V17");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V17, color);
}

void test_grade_color_combined_format_extracts_vgrade(void) {
    // Combined format like "6a/V3" should use V3
    uint16_t color = getGradeColor("6a/V3");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V3, color);
}

void test_grade_color_combined_format_v10(void) {
    uint16_t color = getGradeColor("7c+/V10");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V10, color);
}

void test_grade_color_font_only_falls_back_to_font_grade(void) {
    // Font-only grade should use font grade mapping
    uint16_t color = getGradeColor("6b+");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V4, color);  // 6b maps to V4
}

void test_grade_color_uppercase_font_grade(void) {
    // Should handle uppercase font grades
    uint16_t color = getGradeColor("6A");
    TEST_ASSERT_EQUAL_UINT16(COLOR_V3, color);
}

void test_grade_color_null_returns_default(void) {
    uint16_t color = getGradeColor(nullptr);
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_grade_color_empty_returns_default(void) {
    uint16_t color = getGradeColor("");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

void test_grade_color_invalid_returns_default(void) {
    uint16_t color = getGradeColor("unknown");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);

    color = getGradeColor("123");
    TEST_ASSERT_EQUAL_UINT16(COLOR_GRADE_DEFAULT, color);
}

// =============================================================================
// isLightColor Tests
// =============================================================================

void test_is_light_color_v0_yellow_is_light(void) {
    // V0 is yellow, which is a light color
    bool isLight = isLightColor(COLOR_V0);
    TEST_ASSERT_TRUE(isLight);
}

void test_is_light_color_v1_amber_is_light(void) {
    // V1 is amber, which should be light
    bool isLight = isLightColor(COLOR_V1);
    TEST_ASSERT_TRUE(isLight);
}

void test_is_light_color_v17_dark_purple_is_dark(void) {
    // V17 is darkest purple, which is dark
    bool isLight = isLightColor(COLOR_V17);
    TEST_ASSERT_FALSE(isLight);
}

void test_is_light_color_v10_is_dark(void) {
    // V10 is red-purple, which is dark
    bool isLight = isLightColor(COLOR_V10);
    TEST_ASSERT_FALSE(isLight);
}

void test_is_light_color_white_is_light(void) {
    // Pure white
    bool isLight = isLightColor(0xFFFF);
    TEST_ASSERT_TRUE(isLight);
}

void test_is_light_color_black_is_dark(void) {
    // Pure black
    bool isLight = isLightColor(0x0000);
    TEST_ASSERT_FALSE(isLight);
}

void test_is_light_color_default_gray_is_light(void) {
    // Default gray should be light
    bool isLight = isLightColor(COLOR_GRADE_DEFAULT);
    TEST_ASSERT_TRUE(isLight);
}

// =============================================================================
// getGradeTextColor Tests
// =============================================================================

void test_text_color_on_light_bg_is_black(void) {
    // Light background (V0 yellow) should get black text
    uint16_t textColor = getGradeTextColor(COLOR_V0);
    TEST_ASSERT_EQUAL_UINT16(0x0000, textColor);  // Black
}

void test_text_color_on_dark_bg_is_white(void) {
    // Dark background (V17 purple) should get white text
    uint16_t textColor = getGradeTextColor(COLOR_V17);
    TEST_ASSERT_EQUAL_UINT16(0xFFFF, textColor);  // White
}

void test_text_color_on_white_is_black(void) {
    uint16_t textColor = getGradeTextColor(0xFFFF);
    TEST_ASSERT_EQUAL_UINT16(0x0000, textColor);  // Black
}

void test_text_color_on_black_is_white(void) {
    uint16_t textColor = getGradeTextColor(0x0000);
    TEST_ASSERT_EQUAL_UINT16(0xFFFF, textColor);  // White
}

void test_text_color_on_default_gray_is_black(void) {
    uint16_t textColor = getGradeTextColor(COLOR_GRADE_DEFAULT);
    TEST_ASSERT_EQUAL_UINT16(0x0000, textColor);  // Black (gray is light)
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char** argv) {
    UNITY_BEGIN();

    // getVGradeColorByNumber tests
    RUN_TEST(test_vgrade_0_returns_yellow);
    RUN_TEST(test_vgrade_5_returns_red);
    RUN_TEST(test_vgrade_10_returns_red_purple);
    RUN_TEST(test_vgrade_17_returns_darkest_purple);
    RUN_TEST(test_vgrade_greater_than_17_returns_v17_color);
    RUN_TEST(test_vgrade_negative_returns_default_gray);
    RUN_TEST(test_vgrade_all_values_0_to_17);

    // getFontGradeColor tests
    RUN_TEST(test_font_grade_4a_returns_v0_color);
    RUN_TEST(test_font_grade_5a_returns_v1_color);
    RUN_TEST(test_font_grade_5c_returns_v2_color);
    RUN_TEST(test_font_grade_6a_returns_v3_color);
    RUN_TEST(test_font_grade_6b_returns_v4_color);
    RUN_TEST(test_font_grade_7a_plus_returns_v7_color);
    RUN_TEST(test_font_grade_7c_plus_returns_v10_color);
    RUN_TEST(test_font_grade_8a_returns_v11_color);
    RUN_TEST(test_font_grade_8c_plus_returns_v16_color);
    RUN_TEST(test_font_grade_null_returns_default);
    RUN_TEST(test_font_grade_empty_returns_default);
    RUN_TEST(test_font_grade_single_char_returns_default);
    RUN_TEST(test_font_grade_invalid_returns_default);

    // getGradeColor tests
    RUN_TEST(test_grade_color_v3_returns_v3_color);
    RUN_TEST(test_grade_color_lowercase_v3_returns_v3_color);
    RUN_TEST(test_grade_color_v10_returns_v10_color);
    RUN_TEST(test_grade_color_v17_returns_v17_color);
    RUN_TEST(test_grade_color_combined_format_extracts_vgrade);
    RUN_TEST(test_grade_color_combined_format_v10);
    RUN_TEST(test_grade_color_font_only_falls_back_to_font_grade);
    RUN_TEST(test_grade_color_uppercase_font_grade);
    RUN_TEST(test_grade_color_null_returns_default);
    RUN_TEST(test_grade_color_empty_returns_default);
    RUN_TEST(test_grade_color_invalid_returns_default);

    // isLightColor tests
    RUN_TEST(test_is_light_color_v0_yellow_is_light);
    RUN_TEST(test_is_light_color_v1_amber_is_light);
    RUN_TEST(test_is_light_color_v17_dark_purple_is_dark);
    RUN_TEST(test_is_light_color_v10_is_dark);
    RUN_TEST(test_is_light_color_white_is_light);
    RUN_TEST(test_is_light_color_black_is_dark);
    RUN_TEST(test_is_light_color_default_gray_is_light);

    // getGradeTextColor tests
    RUN_TEST(test_text_color_on_light_bg_is_black);
    RUN_TEST(test_text_color_on_dark_bg_is_white);
    RUN_TEST(test_text_color_on_white_is_black);
    RUN_TEST(test_text_color_on_black_is_white);
    RUN_TEST(test_text_color_on_default_gray_is_black);

    return UNITY_END();
}
