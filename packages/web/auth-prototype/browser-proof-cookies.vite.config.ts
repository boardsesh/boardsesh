import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfigExport, type ViteUserConfigFn } from 'vite-plus';
import webConfiguration from '../vite.config';

async function resolveWebConfiguration(
  configuration: ViteUserConfigExport,
  environment: Parameters<ViteUserConfigFn>[0],
) {
  return await (typeof configuration === 'function' ? configuration(environment) : configuration);
}

// Explicit owned HTTPS/browser+canonical-token proof. No application server or
// production URL is mounted; the existing authority helper owns a fresh DB.
export default defineConfig(async (environment) => {
  const web = await resolveWebConfiguration(webConfiguration, environment);
  return {
    ...web,
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
      ...web.test,
      name: 'browser-proof-cookie-codec',
      environment: 'node',
      include: [
        'auth-prototype/browser-proof-cookies.proof.ts',
        'auth-prototype/provider-security-cookie-recovery.proof.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      maxWorkers: 1,
    },
  };
});
