import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfigExport, type ViteUserConfigFn } from 'vite-plus';
import webConfiguration from '../vite.config';

async function resolveWebConfiguration(
  configuration: ViteUserConfigExport,
  environment: Parameters<ViteUserConfigFn>[0],
) {
  return await (typeof configuration === 'function' ? configuration(environment) : configuration);
}

// Real backend/web proof owns a disposable PostgreSQL database. Keep it out of
// database-free web tests and the web-only Docker build context.
export default defineConfig(async (environment) => {
  const web = await resolveWebConfiguration(webConfiguration, environment);
  return {
    ...web,
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
      ...web.test,
      name: 'auth-web-credential-proof',
      environment: 'node',
      include: [
        'auth-proofs/web-credential-proof.integration.proof.ts',
        'auth-proofs/legacy-route-snapshot.integration.proof.ts',
        'auth-proofs/web-session-cookie.integration.proof.ts',
        'auth-proofs/web-session-signout.integration.proof.ts',
        'auth-proofs/web-session-bridge.integration.proof.ts',
        'auth-proofs/ws-auth-access-token.integration.proof.ts',
        'auth-proofs/server-render-session.integration.proof.ts',
        'auth-proofs/web-provider-session.integration.proof.ts',
        'auth-proofs/web-session-bridge-replacement.integration.proof.ts',
        'auth-proofs/web-set-password.integration.proof.ts',
        'auth-proofs/native-callback.integration.proof.ts',
        'auth-proofs/provider-security-link.integration.proof.ts',
        'auth-proofs/provider-security-unlink.integration.proof.ts',
        'auth-proofs/first-password.integration.proof.ts',
        'auth-proofs/web-apple-sign-in.integration.proof.ts',
        'auth-proofs/provider-security-apple-link.integration.proof.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30000,
      hookTimeout: 60000,
      maxWorkers: 1,
    },
  };
});
