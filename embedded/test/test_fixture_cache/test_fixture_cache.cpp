#define FIXTURE_CACHE_VALIDATION_ONLY
#include "../../projects/board-controller/src/gym/cache.h"

#include <unity.h>
#include <vector>

void setUp() {}
void tearDown() {}

static std::vector<uint8_t> geometry() {
    return {'B', 'S', 'G', 'M', 1, 0, 2, 0, 74, 1, 74, 1,
            0, 0, 0, 0, 0, 0, 1, 0, 255, 255, 73, 1, 73, 1, 255, 0};
}

static std::vector<uint8_t> jpeg() {
    return {0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 1, 74, 1, 74, 1, 1, 0x11, 0,
            0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 42, 0xff, 0xd9};
}

void test_geometry_accepts_boundary_positions_and_rejects_every_truncation() {
    auto bytes = geometry();
    TEST_ASSERT_TRUE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
    for (size_t length = 0; length < bytes.size(); ++length)
        TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), length, 330, 330, 2));
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 1025));
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 0, 330, 2));
}

void test_geometry_rejects_version_duplicates_coordinates_and_radius() {
    const auto original = geometry();
    auto bytes = original;
    bytes[4] = 2;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
    bytes = original;
    bytes[20] = bytes[21] = 0;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
    bytes = original;
    bytes[22] = 74;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
    bytes = original;
    bytes[18] = 0;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
    bytes = original;
    bytes[26] = 0;
    bytes[27] = 1;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::geometry(bytes.data(), bytes.size(), 330, 330, 2));
}

void test_jpeg_rejects_truncation_wrong_dimensions_and_progressive() {
    const auto original = jpeg();
    TEST_ASSERT_TRUE(gym_fixture::cache_validation::jpeg(original.data(), original.size(), 330, 330));
    for (size_t length = 0; length < original.size(); ++length)
        TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(original.data(), length, 330, 330));
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(original.data(), original.size(), 329, 330));
    auto bytes = original;
    bytes[3] = 0xc2;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(bytes.data(), bytes.size(), 330, 330));
    bytes = original;
    bytes[5] = 255;
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(bytes.data(), bytes.size(), 330, 330));
}

void test_jpeg_requires_scan_after_header_and_fits_size_cap() {
    auto bytes = jpeg();
    bytes.erase(bytes.begin() + 15, bytes.end() - 2);
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(bytes.data(), bytes.size(), 330, 330));
    bytes = jpeg();
    bytes.insert(bytes.end() - 2, 65536, 42);
    TEST_ASSERT_FALSE(gym_fixture::cache_validation::jpeg(bytes.data(), bytes.size(), 330, 330));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_geometry_accepts_boundary_positions_and_rejects_every_truncation);
    RUN_TEST(test_geometry_rejects_version_duplicates_coordinates_and_radius);
    RUN_TEST(test_jpeg_rejects_truncation_wrong_dimensions_and_progressive);
    RUN_TEST(test_jpeg_requires_scan_after_header_and_fits_size_cap);
    return UNITY_END();
}
