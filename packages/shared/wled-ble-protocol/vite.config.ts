import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wled-ble-protocol',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
