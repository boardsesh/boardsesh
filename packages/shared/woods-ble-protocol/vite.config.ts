import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'woods-ble-protocol',
    clearMocks: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
