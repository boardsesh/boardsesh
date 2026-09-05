// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'crypto',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    env: {
      NODE_ENV: 'development',
    },
  },
});
