import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared-schema',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
