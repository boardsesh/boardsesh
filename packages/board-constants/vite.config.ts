import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'board-constants',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
