#include <board_config_key.h>
#include <unity.h>

void setUp(void) {}

void tearDown(void) {}

// Build a comma-separated id list "1,2,...,count", optionally replacing the id
// at `swapIndex`. Two lists that differ only past the cap are the case the
// passthrough exists for, and writing them out by hand would be 26 ids twice.
String makeSetIds(int count, int swapIndex = -1, int swapValue = 0) {
    String list;
    for (int i = 0; i < count; i++) {
        if (i > 0) list += ",";
        list += String(i == swapIndex ? swapValue : i + 1);
    }
    return list;
}

void test_extract_config_key_sorts_set_ids_and_strips_the_angle(void) {
    TEST_ASSERT_EQUAL_STRING("kilter/1/7/1,20", extractConfigKey("kilter/1/7/20,1/40").c_str());
}

void test_extract_config_key_reads_a_path_with_no_angle(void) {
    TEST_ASSERT_EQUAL_STRING("kilter/1/7/1,20", extractConfigKey("kilter/1/7/20,1").c_str());
}

void test_extract_config_key_keeps_every_set_id_on_the_widest_board(void) {
    // Decoy layout 2 / size 1 — 19 sets, the widest shipped config and the one
    // the old cap of 16 silently shortened.
    String key = extractConfigKey("decoy/2/1/2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20/20");

    TEST_ASSERT_EQUAL_STRING("decoy/2/1/2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20", key.c_str());
}

void test_extract_config_key_carries_a_list_past_the_cap_through_whole(void) {
    // Past BOARD_CONFIG_MAX_SET_IDS the list is keyed exactly as it arrived:
    // unsorted, but not one id shorter.
    String setIds = makeSetIds(BOARD_CONFIG_MAX_SET_IDS + 2);
    String key = extractConfigKey((String("kilter/1/7/") + setIds + "/40").c_str());

    TEST_ASSERT_EQUAL_STRING((String("kilter/1/7/") + setIds).c_str(), key.c_str());
}

void test_extract_config_key_separates_two_configs_that_differ_past_the_cap(void) {
    // The regression the passthrough exists for. Truncating at the cap made
    // these two configs produce the SAME key, so the second board to load
    // showed the first board's cached image.
    int wide = BOARD_CONFIG_MAX_SET_IDS + 2;
    String first = makeSetIds(wide);
    String second = makeSetIds(wide, wide - 1, 900);

    String firstKey = extractConfigKey((String("kilter/1/7/") + first + "/40").c_str());
    String secondKey = extractConfigKey((String("kilter/1/7/") + second + "/40").c_str());

    TEST_ASSERT_TRUE(firstKey.length() > 0);
    TEST_ASSERT_FALSE(firstKey == secondKey);
}

void test_extract_config_key_rejects_a_path_without_set_ids(void) {
    TEST_ASSERT_EQUAL_STRING("", extractConfigKey("kilter/1/7").c_str());
    TEST_ASSERT_EQUAL_STRING("", extractConfigKey("kilter/1").c_str());
    TEST_ASSERT_EQUAL_STRING("", extractConfigKey("kilter").c_str());
    TEST_ASSERT_EQUAL_STRING("", extractConfigKey("kilter/1/7//40").c_str());
}

void test_extract_config_key_rejects_null(void) {
    TEST_ASSERT_EQUAL_STRING("", extractConfigKey(nullptr).c_str());
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    UNITY_BEGIN();
    RUN_TEST(test_extract_config_key_sorts_set_ids_and_strips_the_angle);
    RUN_TEST(test_extract_config_key_reads_a_path_with_no_angle);
    RUN_TEST(test_extract_config_key_keeps_every_set_id_on_the_widest_board);
    RUN_TEST(test_extract_config_key_carries_a_list_past_the_cap_through_whole);
    RUN_TEST(test_extract_config_key_separates_two_configs_that_differ_past_the_cap);
    RUN_TEST(test_extract_config_key_rejects_a_path_without_set_ids);
    RUN_TEST(test_extract_config_key_rejects_null);
    return UNITY_END();
}
