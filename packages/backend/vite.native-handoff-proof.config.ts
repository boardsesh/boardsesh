import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Explicit owned canonical0314 database; ordinary backend setup is never used.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'native-handoff-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-native-handoff-v1', CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy' },
    include: [
      'src/auth/authority/__tests__/native-provider-creation-credential-writer.proof.ts',
      'src/auth/authority/__tests__/native-handoff-credential-writer.proof.ts',
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
