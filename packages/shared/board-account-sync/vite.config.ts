import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-account-sync',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
