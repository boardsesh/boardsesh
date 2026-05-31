import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-react',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
