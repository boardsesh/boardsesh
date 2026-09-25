import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'spray-wall-geometry',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
