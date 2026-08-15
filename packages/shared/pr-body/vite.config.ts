import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'pr-body',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
