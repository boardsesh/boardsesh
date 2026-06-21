import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'analytics',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
