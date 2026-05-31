import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'queue-react',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
