import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'queue-runtime',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
