import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'consent',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
