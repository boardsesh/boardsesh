import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Isolated from the backend fixture setup: only disposable prototype DBs are used.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'auth-prototype',
    environment: 'node',
    include: ['src/auth/**/__tests__/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 4,
  },
});
