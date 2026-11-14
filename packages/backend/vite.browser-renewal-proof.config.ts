import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Explicit owned canonical0315 fixture; legacy profile receipts stay distinct.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'browser-renewal-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-browser-renewal-v1', CURRENT_STORE_BROWSER_RENEWAL_MODE: 'legacy' },
    include: [
      'src/auth/authority/__tests__/browser-renewal-credential-writer.proof.ts',
      'src/auth/authority/__tests__/credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/browser-credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/provider-security-http.proof.ts',
      'src/auth/authority/__tests__/first-password-http.proof.ts',
      'src/auth/authority/__tests__/anonymous-provider-http.proof.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
