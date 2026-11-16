#ifndef BOARD_RENDERER_H
#define BOARD_RENDERER_H

#include <stdint.h>

uint32_t board_renderer_gpu_atlas_format_version(void);

int32_t board_renderer_prepare_gpu_atlas(const uint8_t *config_json, uint32_t config_json_len,
                                        uint8_t **out_data, uint32_t *out_len);

/* Each result is independently owned and freed with board_renderer_free. */
int32_t board_renderer_prepare_gpu_atlas_owned(
    const uint8_t *config_json, uint32_t config_json_len,
    const uint8_t *asset_path, uint32_t asset_path_len,
    const uint8_t *expected_sha, uint32_t expected_sha_len,
    const uint8_t *generated_dir, uint32_t generated_dir_len,
    uint8_t **out_manifest, uint32_t *out_manifest_len,
    uint8_t **out_pixels, uint32_t *out_pixels_len
);

/**
 * Render a board overlay from a JSON config string.
 * Returns 0 on success, -1 on parse error, -2 on render error.
 */
int32_t board_renderer_render(
    const uint8_t *config_json,
    uint32_t config_json_len,
    uint8_t **out_data,
    uint32_t *out_len,
    uint32_t *out_width,
    uint32_t *out_height
);

/**
 * Free memory allocated by board_renderer_render.
 */
void board_renderer_free(uint8_t *ptr, uint32_t len);

#endif /* BOARD_RENDERER_H */
