import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'location-sync',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
