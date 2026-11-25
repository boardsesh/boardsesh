import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'password-login-backend-proof',
    environment: 'node',
    include: [
      'src/auth/authority/__tests__/password-login-backend.proof.ts',
      'src/auth/current-store/__tests__/pre-enforcement-password-limits.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
