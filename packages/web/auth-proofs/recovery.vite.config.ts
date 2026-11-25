import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfigExport, type ViteUserConfigFn } from 'vite-plus';
import webConfiguration from '../vite.config';
async function resolveWebConfiguration(
  configuration: ViteUserConfigExport,
  environment: Parameters<ViteUserConfigFn>[0],
) {
  return await (typeof configuration === 'function' ? configuration(environment) : configuration);
}
export default defineConfig(async (environment) => {
  const web = await resolveWebConfiguration(webConfiguration, environment);
  return {
    ...web,
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
      ...web.test,
      name: 'recovery-web-proof',
      environment: 'node',
      include: ['auth-proofs/pre-enforcement-recovery.integration.proof.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30000,
      hookTimeout: 60000,
      maxWorkers: 1,
      fileParallelism: false,
    },
  };
});
