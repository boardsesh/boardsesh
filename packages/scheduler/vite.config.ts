import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'scheduler',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
