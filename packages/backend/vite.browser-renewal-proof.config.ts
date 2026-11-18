import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Explicit owned canonical0315 fixture; legacy profile receipts stay distinct.
// Renewal custody is gone (#7596), but the private-browser-renewal-v1 contract
// stays selectable by operators until B5, so the kept proofs still run under it.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    // The joined public proof resolves the web package's real internal imports.
    alias: {
      '@': fileURLToPath(new URL('../web', import.meta.url)),
    },
  },
  test: {
    name: 'browser-renewal-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-browser-renewal-v1' },
    include: [
      'src/auth/authority/__tests__/credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/provider-security-http.proof.ts',
      'src/auth/authority/__tests__/first-password-http.proof.ts',
      'src/auth/authority/__tests__/web-oauth-session-http.proof.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
