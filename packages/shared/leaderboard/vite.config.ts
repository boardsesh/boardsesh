import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'leaderboard',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
