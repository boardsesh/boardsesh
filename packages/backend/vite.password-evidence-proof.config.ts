import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Full canonical journal and exact restricted LOGIN; no shared backend setup.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'password-evidence-proof',
    environment: 'node',
    include: [
      'src/auth/authority/__tests__/password-change-evidence.proof.ts',
      'src/auth/authority/__tests__/registration-evidence.proof.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
