import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'moonboard-sync',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
