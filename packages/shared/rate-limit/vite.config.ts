import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'rate-limit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
