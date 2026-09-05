import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'session-inference',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
