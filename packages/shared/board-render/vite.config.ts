import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-render',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
