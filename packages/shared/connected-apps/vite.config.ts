import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'connected-apps',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
