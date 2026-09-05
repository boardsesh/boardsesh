// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'board-constants',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
