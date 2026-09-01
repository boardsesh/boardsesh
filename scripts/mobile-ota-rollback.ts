/// <reference types="node" />

/**
 * Emergency rollback for a production self-hosted OTA. V3 supports progressive
 * rollouts, but once a bad update has fully rolled out (or shipped at 100%) every
 * install is on it — so "rollback" means re-pointing the production branch on the
 * expo-open-ota server. Two modes, both via the eoas CLI (the same client
 * scripts/mobile-publish.ts uses):
 *
 *   --mode embedded   (default) → `eoas rollback --nonInteractive`   Publishes a
 *       rollback DIRECTIVE: every install currently on the bad OTA reverts to the
 *       binary's EMBEDDED bundle on its next launch. eoas@3.1.2 rollback prompts
 *       for confirmation and THROWS in a non-TTY, so the helper passes
 *       --nonInteractive — that's what makes it CI-safe. Use this to stop the
 *       bleeding fast — it always lands on a known-good (shipped) bundle.
 *
 *   --mode republish            → `eoas republish`  Re-points the branch to a
 *       PREVIOUS published update you pick from a list. Interactive (eoas prompts
 *       for the update), so run it LOCALLY, not in CI.
 *       NEEDS THE SERVER ON v3.1.2: 3.1.2 lists candidates via lib/serverUpdates,
 *       which adds a `.../runtimeVersion/<rv>/publish-groups` route 3.0.5 does not
 *       serve, and can pass `?publishGroup=` on the republish call. Back-compat for
 *       older clients is server-side (xprem #168). Until the Railway image is
 *       bumped, use --mode embedded — unchanged, and the mode the incident runbook
 *       uses anyway. The helper prints this warning before running.
 *
 * eoas resolves the target runtimeVersion (fingerprint) from the LOCAL config, so
 * the rollback only lands if it resolves the SAME fingerprint the shipped binary
 * embeds. That means the fingerprint-affecting env must match the production
 * build's per-platform split (see docs/mobile-ota-updates.md → Rollback):
 *   - Android needs GOOGLE_MAPS_API_KEY (it changes android.config); iOS must run
 *     WITHOUT it (Apple Maps). A single --platform all can't satisfy both, so the
 *     helper rejects it — run one platform at a time.
 * Get any of these wrong and eoas reports success while the directive is filed
 * under a fingerprint no shipped binary has — the fleet reverts nothing.
 *
 * The cleaner long-term fix is still to revert the offending JS commit on `main`
 * — the production OTA workflow then republishes a good bundle automatically. Use
 * a rollback directive when you need installs reverted in minutes, before a
 * revert PR can merge + republish. See docs/mobile-ota-updates.md.
 *
 * Usage:
 *   vp run mobile:ota-rollback -- --platform ios       # rollback iOS to embedded
 *   vp run mobile:ota-rollback -- --platform android   # rollback Android (needs GOOGLE_MAPS_API_KEY)
 *   vp run mobile:ota-rollback -- --platform ios --mode republish   # re-point to a previous update (interactive, local)
 *
 * Env: EXPO_UPDATES_URL (server manifest endpoint) + EOO_TOKEN (the app-scoped
 * expo-open-ota API key), same as the production publish; plus
 * GOOGLE_MAPS_API_KEY for --platform android.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';

/** The server image that matches the pinned CLI — derived so it can't drift from it. */
const SERVER_IMAGE_REF = `xprem:v${EOAS_PACKAGE_SPEC.replace(/^eoas@/, '')}`;

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

/** The eoas argv for a rollback mode. EOAS_PACKAGE_SPEC pins the CLI to the deployed V3 server version. */
export function buildEoasArgs(options: RollbackOptions): string[] {
  const subcommand = options.mode === 'embedded' ? 'rollback' : 'republish';
  const args = [EOAS_PACKAGE_SPEC, subcommand, '--branch', options.branch, '--platform', options.platform];
  // eoas@3.1.2 `rollback` prompts for confirmation and throws in a non-TTY (CI)
  // without --nonInteractive. `republish` is interactive by design (it prompts for
  // which previous update to re-point to), so it stays TTY-driven — run it locally.
  if (options.mode === 'embedded') args.push('--nonInteractive');
  return args;
}

/** Returns an error message for an invalid mode/platform, or null when the options are usable. */
export function validateRollbackOptions(options: RollbackOptions): string | null {
  if (!VALID_MODES.includes(options.mode)) {
    return `Invalid --mode "${options.mode}". Must be one of: ${VALID_MODES.join(', ')}`;
  }
  if (!VALID_PLATFORMS.includes(options.platform as (typeof VALID_PLATFORMS)[number])) {
    return `Invalid --platform "${options.platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`;
  }
  return null;
}

/**
 * Pre-flight note printed before a `--mode republish` run.
 *
 * eoas 3.1.2 lists republish candidates through `lib/serverUpdates`, which adds a
 * `.../runtimeVersion/<rv>/publish-groups` route the 3.0.5 server never served, and
 * one republish path sends `?publishGroup=` on the call itself. Back-compat for
 * older clients is server-side (xprem #168), so this resolves itself the moment the
 * Railway image is bumped.
 *
 * Warn, don't block: nothing here can detect the deployed version (the server has no
 * version endpoint), so a guard would have to be unconditional — and would then need
 * a code change to undo after the bump. Blocking a rollback path mid-incident to
 * avoid a confusing error message is the wrong trade; naming the fallback is enough.
 */
export function republishServerVersionWarning(): string[] {
  return [
    `[ota-rollback] NOTE: republish needs the server on ${SERVER_IMAGE_REF}. If it is still on`,
    '[ota-rollback] v3.0.5, expect a 404 listing previous updates — that is the version',
    '[ota-rollback] gap, not a broken rollback. Use --mode embedded instead; it is',
    '[ota-rollback] unaffected and is the mode the incident runbook uses.',
  ];
}

function main(): number {
  const options = parseRollbackArgs(process.argv.slice(2));

  const invalid = validateRollbackOptions(options);
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
  if (!process.env.EOO_TOKEN) {
    console.error('[ota-rollback] Requires EOO_TOKEN (an app-scoped expo-open-ota API key — the V3 server rejects');
    console.error('[ota-rollback] Expo tokens). Mint one in the dashboard and set it. See docs/mobile-ota-updates.md.');
    return 1;
  }
  // The fingerprint depends on GOOGLE_MAPS_API_KEY per platform (it changes
  // android.config; iOS uses Apple Maps and the native iOS build sets it unset), so
  // the rollback must mirror the production publish's per-platform split. --platform
  // all can't satisfy both at once — reject it and make the operator run each side.
  if (options.platform === 'all') {
    console.error('[ota-rollback] --platform all cannot resolve a correct fingerprint for both platforms:');
    console.error('[ota-rollback] Android needs GOOGLE_MAPS_API_KEY set and iOS must resolve WITHOUT it (Apple');
    console.error('[ota-rollback] Maps), mirroring the per-platform production publish. Run it once per platform:');
    console.error('[ota-rollback]   vp run mobile:ota-rollback -- --platform ios');
    console.error('[ota-rollback]   vp run mobile:ota-rollback -- --platform android   (with GOOGLE_MAPS_API_KEY)');
    return 1;
  }
  if (options.platform === 'android' && !process.env.GOOGLE_MAPS_API_KEY) {
    console.error('[ota-rollback] --platform android requires GOOGLE_MAPS_API_KEY (it feeds android.config, so it');
    console.error('[ota-rollback] changes the Android fingerprint). Without it eoas resolves a map-less fingerprint');
    console.error(
      '[ota-rollback] no Android binary has and the rollback lands nowhere. See docs/mobile-ota-updates.md.',
    );
    return 1;
  }

  const eoasArgs = buildEoasArgs(options);

  console.log(
    `[ota-rollback] Mode:     ${options.mode === 'embedded' ? 'rollback to embedded bundle' : 'republish a previous update'}`,
  );
  console.log(`[ota-rollback] Server:   ${serverUrl}`);
  console.log(`[ota-rollback] Branch:   ${options.branch}`);
  console.log(`[ota-rollback] Platform: ${options.platform}`);
  if (options.mode === 'republish') {
    console.log('');
    for (const line of republishServerVersionWarning()) console.log(line);
  }
  console.log('');
  console.log(`[ota-rollback] Running: vp dlx ${eoasArgs.join(' ')}`);
  console.log('');

  // EXPO_UPDATES_URL must resolve in app.config so eoas finds the server; strip a
  // stray EAS_BUILD (which would flip app.config back to the EAS URL).
  const eoasEnv = { ...process.env };
  delete eoasEnv.EAS_BUILD;
  if (options.platform === 'ios') {
    // iOS resolves its fingerprint WITHOUT the maps key (Apple Maps; the native iOS
    // build sets no GOOGLE_MAPS_API_KEY). Strip a stray value so it can't perturb the
    // iOS fingerprint and file the directive where no iOS binary looks.
    delete eoasEnv.GOOGLE_MAPS_API_KEY;
  }

  const result = spawnSync('vp', ['dlx', ...eoasArgs], {
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
