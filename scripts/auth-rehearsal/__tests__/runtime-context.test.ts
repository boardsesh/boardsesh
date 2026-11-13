import { expect, it } from 'vite-plus/test';
// Build helper is plain JavaScript; it is never imported by an application worker.
const contextModuleUrl = new URL('../runtime-context.mjs', import.meta.url).href;
const contextModule = (await import(contextModuleUrl)) as { contextPathAllowed: (path: string) => boolean };
it.each([
  '.env',
  'packages/backend/.env.production',
  '.npmrc',
  '.git/config',
  'packages/backend/node_modules/postgres/index.js',
  'packages/backend/operator.key',
  'packages/backend/cert.pem',
  '../Private/credentials.json',
  '/Users/operator/private.json',
  'packages\\backend\\secrets.json',
  '',
])('refuses unsafe dependency build-context input: %s', (path) => {
  expect(contextModule.contextPathAllowed(path)).toBe(false);
});
it('permits tracked code and lockfile build inputs', () => {
  expect(contextModule.contextPathAllowed('packages/backend/src/index.ts')).toBe(true);
  expect(contextModule.contextPathAllowed('pnpm-lock.yaml')).toBe(true);
});
