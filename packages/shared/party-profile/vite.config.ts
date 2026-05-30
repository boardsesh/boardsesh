import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'party-profile',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
