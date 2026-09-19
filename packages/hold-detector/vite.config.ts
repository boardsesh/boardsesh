import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'hold-detector',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
