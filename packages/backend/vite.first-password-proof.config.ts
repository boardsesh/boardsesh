import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Fresh canonical0314 database only; never imports shared backend setup.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'first-password-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-first-password-v1', CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy' },
    include: [
      'src/auth/authority/__tests__/first-password-credential-writer.proof.ts',
      'src/auth/authority/__tests__/credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/browser-credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/provider-security-http.proof.ts',
      'src/auth/authority/__tests__/first-password-http.proof.ts',
      'src/auth/authority/__tests__/anonymous-provider-http.proof.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
