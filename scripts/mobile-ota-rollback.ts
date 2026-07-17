/// <reference types="node" />

/**
 * Emergency rollback for a production self-hosted OTA. Production has no rollout
 * percentage — every install on the bad bundle is on it — so "rollback" means
 * re-pointing the production branch on the expo-open-ota server. Two modes, both
 * via the eoas CLI (the same client scripts/mobile-publish.ts uses):
 *
 *   --mode embedded   (default) → `eoas rollback`   Publishes a rollback
 *       DIRECTIVE: every install currently on the bad OTA reverts to the binary's
 *       EMBEDDED bundle on its next launch. CI-safe — even though eoas's own
 *       confirm prompt requires a TTY, this script fakes one (see
 *       needsPtyWorkaround/buildPtyWrapperArgs below) and auto-answers it when
 *       stdin isn't interactive. Use this to stop the bleeding fast — it always
 *       lands on a known-good (shipped) bundle.
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
 * `eoas rollback` (unlike `republish`) always asks "Are you sure?" via a prompt
 * that throws immediately when stdin isn't a TTY (eoas@2.3.22's confirmAsync
 * checks `process.stdin.isTTY` before reading anything — no flag skips it). CI
 * runners have no TTY, so a plain `bunx eoas rollback` fails before it ever
 * uploads. `republish`'s own interactive picker needs a *real* terminal to be
 * usable, so it's exempt — this only patches the mode that's supposed to be
 * CI-safe.
 */
export function needsPtyWorkaround(mode: RollbackMode, isTTY: boolean | undefined): boolean {
  return mode === 'embedded' && !isTTY;
}

/** Single-quotes a shell argument, escaping embedded single quotes POSIX-style. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `script` allocates a pty for the wrapped command (so its stdin reports
 * isTTY === true) and forwards whatever bytes arrive on *our* stdin through
 * that pty — so piping "y\n" lands as if a human typed it at the confirm
 * prompt. `-e` propagates the child's real exit code back out. This is
 * util-linux `script` syntax (Linux only — CI runs ubuntu-latest, and a local
 * interactive run has a real TTY and never takes this path); macOS's BSD
 * `script` takes its command as trailing positional args instead of `-c`.
 */
export function buildPtyWrapperArgs(command: string[]): { command: string; args: string[] } {
  return { command: 'script', args: ['-qec', command.map(shellQuote).join(' '), '/dev/null'] };
}

/** Runs `command` under a faked pty (see buildPtyWrapperArgs) and auto-answers its confirm prompt. */
function spawnWithFakedPty(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const { command: ptyCommand, args } = buildPtyWrapperArgs(command);
  console.log('[ota-rollback] No TTY on stdin — auto-confirming via a faked pty (see needsPtyWorkaround).');
  return spawnSync(ptyCommand, args, {
    cwd,
    input: 'y\n',
    stdio: ['pipe', 'inherit', 'inherit'],
    env,
  });
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

  const result = needsPtyWorkaround(options.mode, process.stdin.isTTY)
    ? spawnWithFakedPty(['bunx', ...eoasArgs], MOBILE_DIR, eoasEnv)
    : spawnSync('bunx', eoasArgs, {
        cwd: MOBILE_DIR,
        stdio: 'inherit', // a real terminal: let eoas prompt normally (republish needs it anyway)
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
