import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'led-controller',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
