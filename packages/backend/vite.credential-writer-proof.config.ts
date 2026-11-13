import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Pinned historical0312 fixture only; never imports shared backend setup.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'credential-writer-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: '' },
    include: [
      'src/auth/authority/__tests__/credential-writer-acl.proof.ts',
      'src/auth/authority/__tests__/browser-credential-writer.proof.ts',
      'src/auth/authority/__tests__/credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/browser-credential-writer-http.proof.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
