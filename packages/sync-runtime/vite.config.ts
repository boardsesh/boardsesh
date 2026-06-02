import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'sync-runtime',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
