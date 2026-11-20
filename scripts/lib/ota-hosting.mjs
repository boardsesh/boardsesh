import { readFileSync } from 'node:fs';

/** Refuse an unknown provider rather than silently skipping the publish gate. */
export function parseOtaHosting(value) {
  if (value?.provider !== 'railway' && value?.provider !== 'homelab') {
    throw new Error('infra/ota/hosting.json provider must be railway or homelab');
  }
  return value.provider;
}

export function readOtaHosting() {
  return parseOtaHosting(JSON.parse(readFileSync(new URL('../../infra/ota/hosting.json', import.meta.url), 'utf8')));
}

export const RAILWAY_APPLY_PATHS = [
  'infra/railway/',
  'infra/ota/server.json',
  'infra/ota/server.ts',
  'infra/ota/hosting.json',
  'scripts/railway-apply.ts',
  'scripts/railway-deployment-rollback.mjs',
  '.github/workflows/railway-drift.yml',
];

export const HOMELAB_APPLY_PATHS = [
  'infra/ota/server.json',
  'infra/ota/server.ts',
  'infra/ota/hosting.json',
  'scripts/ota-server-deploy.mjs',
  'scripts/lib/ota-hosting.mjs',
  'scripts/mobile-ota-server-ready.mjs',
  '.github/workflows/ota-server-deploy.yml',
];

export function otaDeployment(provider) {
  parseOtaHosting({ provider });
  return provider === 'homelab'
    ? { workflow: 'ota-server-deploy.yml', name: 'OTA Server Deploy', paths: HOMELAB_APPLY_PATHS }
    : { workflow: 'railway-drift.yml', name: 'Railway Config', paths: RAILWAY_APPLY_PATHS };
}

export function touchesDeployment(changedFiles, paths) {
  return changedFiles.some((file) =>
    paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
  );
}
