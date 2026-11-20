import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: false,
    name: 'aurora-ble-protocol',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
