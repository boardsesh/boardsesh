#include "../../libs/waveshare-amoled-display/src/preview_geometry.h"

#include <unity.h>

void setUp(void) {}
void tearDown(void) {}

void test_homewall_fills_preview_height_with_one_scale_for_holds() {
    amoled_preview::Geometry geometry = amoled_preview::fit(402, 560, 330);
    TEST_ASSERT_EQUAL_INT(237, geometry.width);
    TEST_ASSERT_EQUAL_INT(330, geometry.height);
    TEST_ASSERT_EQUAL_INT(46, geometry.offsetX);
    TEST_ASSERT_EQUAL_INT(0, geometry.offsetY);
    TEST_ASSERT_EQUAL_INT(165, geometry.coordinate(280));
    TEST_ASSERT_EQUAL_INT(280, geometry.source(165));
    TEST_ASSERT_EQUAL_INT(5, geometry.boundary(8));
    TEST_ASSERT_TRUE(geometry.coordinate(401) < geometry.width);
    TEST_ASSERT_TRUE(geometry.coordinate(559) < geometry.height);
}

void test_landscape_square_and_invalid_images_fit_inside_the_frame() {
    amoled_preview::Geometry landscape = amoled_preview::fit(460, 320, 330);
    TEST_ASSERT_EQUAL_INT(330, landscape.width);
    TEST_ASSERT_EQUAL_INT(230, landscape.height);
    TEST_ASSERT_EQUAL_INT(0, landscape.offsetX);
    TEST_ASSERT_EQUAL_INT(50, landscape.offsetY);

    amoled_preview::Geometry square = amoled_preview::fit(41, 41, 330);
    TEST_ASSERT_EQUAL_INT(330, square.width);
    TEST_ASSERT_EQUAL_INT(330, square.height);
    TEST_ASSERT_EQUAL_INT(0, square.offsetX);
    TEST_ASSERT_EQUAL_INT(0, square.offsetY);
    TEST_ASSERT_EQUAL_INT(0, amoled_preview::fit(0, 560, 330).width);
    TEST_ASSERT_EQUAL_INT(0, amoled_preview::fit(402, -1, 330).height);
    TEST_ASSERT_EQUAL_INT(0, amoled_preview::fit(402, 560, 0).width);
}

void test_jpeg_blocks_with_padding_render_without_seams_or_lost_edge_pixels() {
    uint16_t sourcePixels[8 * 5];
    for (int row = 0; row < 5; row++) {
        for (int column = 0; column < 8; column++) {
            sourcePixels[row * 8 + column] = column < 7 ? row * 10 + column : 9999;
        }
    }
    uint16_t destinationPixels[4 * 3];
    std::fill_n(destinationPixels, 12, 0xBEEF);
    amoled_preview::Geometry geometry = amoled_preview::fit(7, 5, 4);

    // Four independently delivered JPEG blocks; the last column is padding.
    amoled_preview::copyBlock(geometry, sourcePixels, 8, 0, 0, 4, 3, destinationPixels, 4);
    amoled_preview::copyBlock(geometry, sourcePixels + 4, 8, 4, 0, 3, 3, destinationPixels, 4);
    amoled_preview::copyBlock(geometry, sourcePixels + 3 * 8, 8, 0, 3, 4, 2, destinationPixels, 4);
    amoled_preview::copyBlock(geometry, sourcePixels + 3 * 8 + 4, 8, 4, 3, 3, 2, destinationPixels, 4);

    const uint16_t expectedPixels[] = {0, 1, 3, 5, 10, 11, 13, 15, 30, 31, 33, 35};
    TEST_ASSERT_EQUAL_MEMORY(expectedPixels, destinationPixels, sizeof(expectedPixels));
}

void test_direct_framebuffer_fallback_matches_cache_and_preserves_surrounding_pixels() {
    const uint16_t sourcePixels[] = {1, 2, 3, 4, 5, 6};
    amoled_preview::Geometry geometry = amoled_preview::fit(3, 2, 6);
    uint16_t cachePixels[6 * 4];
    uint16_t framebufferPixels[10 * 8];
    std::fill_n(framebufferPixels, 80, 0xBEEF);

    amoled_preview::copyBlock(geometry, sourcePixels, 3, 0, 0, 3, 2, cachePixels, 6);
    amoled_preview::copyBlock(geometry, sourcePixels, 3, 0, 0, 3, 2, framebufferPixels, 10, 2, 3);
    const uint16_t expectedPixels[] = {1, 1, 2, 2, 3, 3, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 4, 4, 5, 5, 6, 6};
    TEST_ASSERT_EQUAL_MEMORY(expectedPixels, cachePixels, sizeof(expectedPixels));
    for (int row = 0; row < 8; row++) {
        for (int column = 0; column < 10; column++) {
            if (row >= 3 && row < 7 && column >= 2 && column < 8) {
                TEST_ASSERT_EQUAL_UINT16(cachePixels[(row - 3) * 6 + column - 2], framebufferPixels[row * 10 + column]);
            } else {
                TEST_ASSERT_EQUAL_UINT16(0xBEEF, framebufferPixels[row * 10 + column]);
            }
        }
    }
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;
    UNITY_BEGIN();
    RUN_TEST(test_homewall_fills_preview_height_with_one_scale_for_holds);
    RUN_TEST(test_landscape_square_and_invalid_images_fit_inside_the_frame);
    RUN_TEST(test_jpeg_blocks_with_padding_render_without_seams_or_lost_edge_pixels);
    RUN_TEST(test_direct_framebuffer_fallback_matches_cache_and_preserves_surrounding_pixels);
    return UNITY_END();
}
