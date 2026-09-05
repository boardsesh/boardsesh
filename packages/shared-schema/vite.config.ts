// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared-schema',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
