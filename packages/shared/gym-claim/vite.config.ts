import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'gym-claim',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
