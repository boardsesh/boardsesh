// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

#ifndef BOARD_RENDERER_H
#define BOARD_RENDERER_H

#include <stdint.h>

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
