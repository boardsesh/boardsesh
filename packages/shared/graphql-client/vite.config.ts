// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'graphql-client',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
