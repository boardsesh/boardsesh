import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'shared-schema',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
