import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'frosted-bokeh',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
