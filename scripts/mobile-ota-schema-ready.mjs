#!/usr/bin/env node
// One-shot, fail-closed check used immediately before a production OTA publish.
// The staging upload runs while the backend builds; this check consumes no
// runner minutes waiting for it, because the workflow dependency is the wait.
import { execFileSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;
const SCHEMA_PATHS = ['packages/shared-schema/src/schema.ts', 'packages/shared-schema/src/schema/'];
const GENERATED_SCHEMA_PATH = 'packages/shared-schema/src/generated/schema.graphql';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function schemaReady({ release, sameSchema }) {
  if (!SHA.test(release)) return false;
  return sameSchema;
}

/** Native recovery may build an older stamp after additive backend changes shipped. */
export async function schemasCompatible(clientSchema, backendSchema) {
  // Native build jobs have dependencies installed. Keep this import lazy because
  // the default exact-schema checks also run in dependency-free promotion jobs.
  const { buildSchema, findBreakingChanges } = await import('graphql');
  return findBreakingChanges(buildSchema(clientSchema), buildSchema(backendSchema)).length === 0;
}

export async function checkSchemaReady({ release, sourceSha, allowCompatibleSchema = false, readGit = git }) {
  if (!SHA.test(release) || !SHA.test(sourceSha)) return false;
  readGit('cat-file', '-e', `${release}^{commit}`);
  let sameSchema = false;
  try {
    readGit('diff', '--quiet', release, sourceSha, '--', ...SCHEMA_PATHS);
    sameSchema = true;
  } catch (error) {
    // Status 1 is a schema difference; missing revisions and other git failures
    // must not enter the compatibility path.
    if (error.status !== 1) throw error;
  }
  if (!sameSchema && allowCompatibleSchema) {
    sameSchema = await schemasCompatible(
      readGit('show', `${sourceSha}:${GENERATED_SCHEMA_PATH}`),
      readGit('show', `${release}:${GENERATED_SCHEMA_PATH}`),
    );
  }
  return schemaReady({ release, sameSchema });
}

async function main() {
  const otaSha = process.env.GITHUB_SHA;
  if (!otaSha || !SHA.test(otaSha)) throw new Error('GITHUB_SHA must be a full commit SHA');
  const response = await fetch('https://ws.boardsesh.com/health', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Live backend health failed (HTTP ${response.status})`);
  const health = await response.json();
  const release = typeof health.release === 'string' ? health.release : '';
  if (!SHA.test(release)) throw new Error('Live backend health did not contain a valid release SHA');
  if (
    !(await checkSchemaReady({
      release,
      sourceSha: otaSha,
      allowCompatibleSchema: process.argv.includes('--allow-compatible-schema'),
    }))
  ) {
    throw new Error(`Live backend ${release} does not serve the schema required by OTA ${otaSha}`);
  }
  console.log(`Backend schema ready: OTA ${otaSha}, live backend ${release}`);
}

if (process.argv[1]?.endsWith('mobile-ota-schema-ready.mjs')) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
