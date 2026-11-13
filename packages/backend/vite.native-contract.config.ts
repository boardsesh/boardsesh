import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'native-contract',
    environment: 'node',
    include: ['src/__tests__/native-contract/**/*.contract.ts'],
    pool: 'forks',
    execArgv: ['--experimental-vm-modules'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
