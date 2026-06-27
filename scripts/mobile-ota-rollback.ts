/// <reference types="node" />

/**
 * Emergency rollback for a production self-hosted OTA. Production has no rollout
 * percentage — every install on the bad bundle is on it — so "rollback" means
 * re-pointing the production branch on the expo-open-ota server. Two modes, both
 * via the eoas CLI (the same client scripts/mobile-publish.ts uses):
 *
 *   --mode embedded   (default) → `eoas rollback`   Publishes a rollback
 *       DIRECTIVE: every install currently on the bad OTA reverts to the binary's
 *       EMBEDDED bundle on its next launch. Non-interactive, CI-safe. Use this to
 *       stop the bleeding fast — it always lands on a known-good (shipped) bundle.
 *
 *   --mode republish            → `eoas republish`  Re-points the branch to a
 *       PREVIOUS published update you pick from a list. Interactive (eoas prompts
 *       for the update), so run it LOCALLY, not in CI.
 *
 * The cleaner long-term fix is still to revert the offending JS commit on `main`
 * — the production OTA workflow then republishes a good bundle automatically. Use
 * a rollback directive when you need installs reverted in minutes, before a
 * revert PR can merge + republish. See docs/mobile-ota-updates.md.
 *
 * Usage:
 *   vp run mobile:ota-rollback                       # rollback to embedded, all platforms
 *   vp run mobile:ota-rollback -- --platform ios     # one platform
 *   vp run mobile:ota-rollback -- --mode republish   # re-point to a previous update (interactive, local)
 *
 * Env: EXPO_UPDATES_URL (server manifest endpoint) + EXPO_TOKEN (Expo API auth),
 * same as the production publish.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathWithoutBrokenBunxShims } from './lib/eoas';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');

export type RollbackMode = 'embedded' | 'republish';

export interface RollbackOptions {
  branch: string;
  platform: string;
  mode: RollbackMode;
}

const VALID_PLATFORMS = ['ios', 'android', 'all'] as const;
const VALID_MODES: readonly RollbackMode[] = ['embedded', 'republish'];

export function parseRollbackArgs(argv: string[]): RollbackOptions {
  let branch = 'production';
  let platform = 'all';
  let mode: RollbackMode = 'embedded';

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') continue;

    if (argument === '--branch' || argument === '-b') {
      branch = argv[++index] ?? branch;
    } else if (argument.startsWith('--branch=')) {
      branch = argument.slice('--branch='.length);
    } else if (argument === '--platform' || argument === '-p') {
      platform = argv[++index] ?? platform;
    } else if (argument.startsWith('--platform=')) {
      platform = argument.slice('--platform='.length);
    } else if (argument === '--mode' || argument === '-m') {
      mode = (argv[++index] as RollbackMode) ?? mode;
    } else if (argument.startsWith('--mode=')) {
      mode = argument.slice('--mode='.length) as RollbackMode;
    }
  }

  return { branch, platform, mode };
}

/** The eoas argv for a rollback mode. `eoas@2` pins the major, matching mobile-publish.ts. */
export function buildEoasArgs(options: RollbackOptions): string[] {
  const subcommand = options.mode === 'embedded' ? 'rollback' : 'republish';
  return ['eoas@2', subcommand, '--branch', options.branch, '--platform', options.platform];
}

function validate(options: RollbackOptions): string | null {
  if (!VALID_MODES.includes(options.mode)) {
    return `Invalid --mode "${options.mode}". Must be one of: ${VALID_MODES.join(', ')}`;
  }
  if (!VALID_PLATFORMS.includes(options.platform as (typeof VALID_PLATFORMS)[number])) {
    return `Invalid --platform "${options.platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`;
  }
  return null;
}

function main(): number {
  const options = parseRollbackArgs(process.argv.slice(2));

  const invalid = validate(options);
  if (invalid) {
    console.error(`[ota-rollback] ${invalid}`);
    return 1;
  }

  const serverUrl = process.env.EXPO_UPDATES_URL;
  if (!serverUrl) {
    console.error('[ota-rollback] Requires EXPO_UPDATES_URL (the expo-open-ota manifest endpoint).');
    console.error('[ota-rollback] See docs/mobile-ota-updates.md.');
    return 1;
  }
  if (!process.env.EXPO_TOKEN) {
    console.error('[ota-rollback] Requires EXPO_TOKEN (Expo API auth). Run `bunx eas login` locally or set it in CI.');
    return 1;
  }

  const eoasArgs = buildEoasArgs(options);

  console.log(
    `[ota-rollback] Mode:     ${options.mode === 'embedded' ? 'rollback to embedded bundle' : 'republish a previous update'}`,
  );
  console.log(`[ota-rollback] Server:   ${serverUrl}`);
  console.log(`[ota-rollback] Branch:   ${options.branch}`);
  console.log(`[ota-rollback] Platform: ${options.platform}`);
  console.log('');
  console.log(`[ota-rollback] Running: bunx ${eoasArgs.join(' ')}`);
  console.log('');

  // EXPO_UPDATES_URL must resolve in app.config so eoas finds the server; strip a
  // stray EAS_BUILD (which would flip app.config back to the EAS URL) and drop
  // vp's broken bunx shim dir — same guards as the production publish.
  const eoasEnv = { ...process.env };
  delete eoasEnv.EAS_BUILD;
  eoasEnv.PATH = pathWithoutBrokenBunxShims(process.env.PATH);

  const result = spawnSync('bunx', eoasArgs, {
    cwd: MOBILE_DIR,
    stdio: 'inherit', // republish is interactive; rollback streams progress
    env: eoasEnv,
  });

  if (result.status !== 0) {
    console.error('');
    console.error('[ota-rollback] eoas failed.');
    return result.status ?? 1;
  }

  console.log('');
  console.log(`[ota-rollback] Done. Installs on branch "${options.branch}" pick up the change on next launch.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
