import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'gym-filters',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
