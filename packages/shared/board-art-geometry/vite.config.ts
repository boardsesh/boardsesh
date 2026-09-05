// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-art-geometry',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Gate 6 decodes real board art with sharp. The default 5s bites on the
    // all-configs sweep (`BOARD_ART_GATES=all`), which reads 51 boards' layers.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
