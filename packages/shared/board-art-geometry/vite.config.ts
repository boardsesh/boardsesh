import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-art-geometry',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
