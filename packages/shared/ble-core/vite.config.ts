import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'ble-core', environment: 'node', include: ['src/**/*.test.ts'] } });
