import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'velvet-tokens',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
