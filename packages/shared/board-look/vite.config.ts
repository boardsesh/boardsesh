// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-look',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
