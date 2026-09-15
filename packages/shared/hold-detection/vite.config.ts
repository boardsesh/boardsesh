import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'hold-detection',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
