import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'aurora-sync',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
