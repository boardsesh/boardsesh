import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'auth-fence',
    environment: 'node',
    include: ['src/scripts/auth-fence/__tests__/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
