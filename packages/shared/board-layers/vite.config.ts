import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'board-layers',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
