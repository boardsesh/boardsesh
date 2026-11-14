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
        'auth-prototype/web-credential-proof.integration.proof.ts',
        'auth-prototype/provider-security-auth.proof.ts',
        'auth-prototype/provider-security-publication.proof.ts',
        'auth-prototype/provider-security-google-reauth.proof.ts',
        'auth-prototype/provider-owned-signin-auth.proof.ts',
        'auth-prototype/provider-oauth-outer.proof.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30000,
      hookTimeout: 60000,
      maxWorkers: 1,
    },
  };
});
