import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Current canonical0313 fixture; the selected provider profile also runs the
// real existing web/browser HTTP drivers. No shared backend setup or fallback.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'provider-credential-writer-proof',
    environment: 'node',
    env: { AUTH_CREDENTIAL_HTTP_CONTRACT: 'private-provider-v1' },
    include: [
      'src/auth/authority/__tests__/provider-credential-writer.proof.ts',
      'src/auth/authority/__tests__/credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/browser-credential-writer-http.proof.ts',
      'src/auth/authority/__tests__/provider-security-http.proof.ts',
      'src/auth/authority/__tests__/anonymous-provider-http.proof.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
