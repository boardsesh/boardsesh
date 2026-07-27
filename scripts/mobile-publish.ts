/// <reference types="node" />

/**
 * Publishes an OTA update for the mobile app. Two modes:
 *
 *   Preview (default) — `eas update` to EAS free-tier hosting (u.expo.dev).
 *     Each git branch gets its own EAS Update branch, so multiple worktrees
 *     publish independently and testers switch between them in-app.
 *
 *   Production (`--channel <name>`) — `eoas publish` to our self-hosted
 *     expo-open-ota server. Requires EXPO_UPDATES_URL (the server's manifest
 *     endpoint — eoas derives the upload host from updates.url in app.config)
 *     and EOO_TOKEN (the app-scoped expo-open-ota API key; the V3 control-plane
 *     server rejects Expo tokens). The `--channel <name>` value is used as the
 *     server BRANCH name; the channel→branch mapping is a separate step
 *     (a one-time dashboard action for production; scripts/ota-channel-map.ts
 *     for per-PR previews).
 *
 * Usage:
 *   vp run mobile:publish                              # preview: current git branch
 *   vp run mobile:publish -- --branch my-feature       # preview: explicit branch
 *   vp run mobile:publish -- --message "fix nav bug"   # custom update message
 *   vp run mobile:publish -- --channel production      # production: self-hosted OTA
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EOAS_PACKAGE_SPEC, pathWithoutBrokenBunxShims } from './lib/eoas';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');

function resolveCurrentBranchName(): string | null {
  try {
    const branchName = execFileSync('git', ['branch', '--show-current'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branchName || null;
  } catch {
    return null;
  }
}

function getShortCommitHash(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getCommitSubject(): string {
  try {
    return execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function publishToSelfHostedChannel(channelName: string, platform: string, explicitMessage: string | null): never {
  const serverUrl = process.env.EXPO_UPDATES_URL;
  if (!serverUrl) {
    console.error('[mobile:publish] --channel requires EXPO_UPDATES_URL (the expo-open-ota manifest endpoint,');
    console.error(
      '[mobile:publish] e.g. https://updates.boardsesh.com/manifest). eoas derives the upload host from it.',
    );
    console.error('[mobile:publish] See docs/mobile-ota-updates.md.');
    process.exit(1);
  }
  if (!process.env.EOO_TOKEN) {
    console.error('[mobile:publish] --channel requires EOO_TOKEN (an app-scoped expo-open-ota API key).');
    console.error('[mobile:publish] The V3 control-plane server rejects Expo tokens; mint a key in the dashboard');
    console.error('[mobile:publish] and set EOO_TOKEN locally / in CI. See docs/mobile-ota-updates.md.');
    process.exit(1);
  }

  const commitHash = getShortCommitHash();
  const commitSubject = getCommitSubject();
  const updateMessage = explicitMessage ?? `${commitHash} ${commitSubject}`.trim();

  // eoas@3.0.5 publish targets a server BRANCH (--branch holds the uploaded
  // update). We deliberately do NOT pass --channel: in eoas@3 it's a DEPRECATED
  // client-side no-op — it only sets RELEASE_CHANNEL during config resolution; it
  // is NOT sent to the server, does NOT create a channel, and does NOT drive
  // rollouts. Channel creation + channel→branch mapping is a separate step
  // (scripts/ota-channel-map.ts for per-PR previews; a one-time dashboard action
  // for production). Progressive rollouts are branch + runtimeVersion scoped
  // (--rollout-percentage targets a branch's runtimeVersion), not channel scoped.
  // EOAS_PACKAGE_SPEC pins the CLI to the exact deployed V3 server version
  // (control-plane requires an exact match); see scripts/lib/eoas.ts.
  const eoasArgs = [
    EOAS_PACKAGE_SPEC,
    'publish',
    '--branch',
    channelName,
    '--platform',
    platform,
    '--message',
    updateMessage,
    '--nonInteractive',
    // The repo uses bun; force bunx so eoas spawns `bunx expo export` regardless
    // of the nearest package.json's packageManager field.
    '--packageRunner',
    'bunx',
  ];

  console.log(`[mobile:publish] Mode:     production (self-hosted expo-open-ota)`);
  console.log(`[mobile:publish] Server:   ${serverUrl}`);
  console.log(`[mobile:publish] Branch:   ${channelName}`);
  console.log(`[mobile:publish] Message:  ${updateMessage}`);
  console.log(`[mobile:publish] Platform: ${platform}`);
  console.log('');
  console.log(`[mobile:publish] Running: bunx ${eoasArgs.join(' ')}`);
  console.log('');

  // EXPO_UPDATES_URL must resolve in app.config so eoas finds the server.
  // EAS_BUILD must be unset or app.config returns the EAS URL and eoas would
  // publish against the wrong host — strip it defensively so a stray value in
  // the caller's env can't redirect a production publish.
  const eoasEnv = { ...process.env };
  delete eoasEnv.EAS_BUILD;
  // Drop vp's broken bunx shim dir so bunx — and the `bunx expo export` eoas
  // spawns via --packageRunner bunx — resolve a working bunx.
  eoasEnv.PATH = pathWithoutBrokenBunxShims(process.env.PATH);

  const result = spawnSync('bunx', eoasArgs, {
    cwd: MOBILE_DIR,
    stdio: 'inherit',
    env: eoasEnv,
  });

  if (result.status !== 0) {
    console.error('');
    console.error('[mobile:publish] eoas publish failed.');
    process.exit(result.status ?? 1);
  }

  console.log('');
  console.log(`[mobile:publish] Published to self-hosted channel "${channelName}".`);
  console.log(`[mobile:publish] Testers on a build baked with this channel receive it on next launch.`);
  process.exit(0);
}

function parseArgs(args: string[]): {
  branch: string | null;
  message: string | null;
  platform: string;
  channel: string | null;
} {
  let branch: string | null = null;
  let message: string | null = null;
  let platform = 'all';
  let channel: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;

    if (argument === '--branch' || argument === '-b') {
      branch = args[++index] ?? null;
      continue;
    }
    if (argument.startsWith('--branch=')) {
      branch = argument.slice('--branch='.length);
      continue;
    }

    if (argument === '--channel' || argument === '-c') {
      channel = args[++index] ?? null;
      continue;
    }
    if (argument.startsWith('--channel=')) {
      channel = argument.slice('--channel='.length);
      continue;
    }

    if (argument === '--message' || argument === '-m') {
      message = args[++index] ?? null;
      continue;
    }
    if (argument.startsWith('--message=')) {
      message = argument.slice('--message='.length);
      continue;
    }

    if (argument === '--platform' || argument === '-p') {
      platform = args[++index] ?? 'all';
      continue;
    }
    if (argument.startsWith('--platform=')) {
      platform = argument.slice('--platform='.length);
      continue;
    }
  }

  return { branch, message, platform, channel };
}

const VALID_PLATFORMS = ['ios', 'android', 'all'] as const;

const { branch: explicitBranch, message: explicitMessage, platform, channel } = parseArgs(process.argv.slice(2));

if (!VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
  console.error(`[mobile:publish] Invalid platform "${platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`);
  process.exit(1);
}

// Production path: publish to the self-hosted expo-open-ota server via eoas.
// The channel name maps to a same-named branch on the server.
if (channel) {
  publishToSelfHostedChannel(channel, platform, explicitMessage);
}

const branchName = explicitBranch ?? resolveCurrentBranchName();
if (!branchName) {
  console.error('[mobile:publish] Could not determine branch name. Use --branch <name> or run from a git branch.');
  process.exit(1);
}

const sanitizedBranch = branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
const commitHash = getShortCommitHash();
const commitSubject = getCommitSubject();
const updateMessage = explicitMessage ?? `${commitHash} ${commitSubject}`.trim();

console.log(`[mobile:publish] Branch:   ${sanitizedBranch}`);
console.log(`[mobile:publish] Message:  ${updateMessage}`);
console.log(`[mobile:publish] Platform: ${platform}`);
console.log('');

const easArgs = [
  'eas-cli@16',
  'update',
  '--branch',
  sanitizedBranch,
  '--message',
  updateMessage,
  '--platform',
  platform,
  '--non-interactive',
];

console.log(`[mobile:publish] Running: bunx ${easArgs.join(' ')}`);
console.log('');

const result = spawnSync('bunx', easArgs, {
  cwd: MOBILE_DIR,
  stdio: 'inherit',
  env: { ...process.env, PATH: pathWithoutBrokenBunxShims(process.env.PATH) },
});

if (result.status !== 0) {
  console.error('');
  console.error('[mobile:publish] Update failed.');
  if (result.status === 1) {
    console.error('[mobile:publish] Make sure you are logged in: bunx eas login');
    console.error('[mobile:publish] And the project is linked: bunx eas init (from packages/mobile/)');
  }
  process.exit(result.status ?? 1);
}

console.log('');
console.log(`[mobile:publish] Published to branch "${sanitizedBranch}".`);
console.log(`[mobile:publish] Testers on the "preview" build will receive this update.`);
console.log('');
console.log(`[mobile:publish] To point a preview build at this branch:`);
console.log(`  bunx eas-cli@16 channel:edit preview --branch ${sanitizedBranch}`);
