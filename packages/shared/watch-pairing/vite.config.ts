import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'watch-pairing',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
