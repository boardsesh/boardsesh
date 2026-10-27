import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'workout-summary',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
