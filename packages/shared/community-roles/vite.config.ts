import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'community-roles',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
