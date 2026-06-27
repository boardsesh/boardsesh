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
 *     and EXPO_TOKEN (Expo API auth for branch/channel mapping). The channel
 *     name maps to a same-named branch on the server.
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
import { pathWithoutBrokenBunxShims } from './lib/eoas';

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
    console.error('[mobile:publish] e.g. https://ota.boardsesh.com/manifest). eoas derives the upload host from it.');
    console.error('[mobile:publish] See docs/mobile-ota-updates.md.');
    process.exit(1);
  }
  if (!process.env.EXPO_TOKEN) {
    console.error('[mobile:publish] --channel requires EXPO_TOKEN (Expo API auth for branch/channel mapping).');
    console.error('[mobile:publish] Run `bunx eas login` locally, or set EXPO_TOKEN in CI.');
    process.exit(1);
  }

  const commitHash = getShortCommitHash();
  const commitSubject = getCommitSubject();
  const updateMessage = explicitMessage ?? `${commitHash} ${commitSubject}`.trim();

  // eoas publish targets a server branch; the channel baked into the binary
  // maps to a same-named branch (channel "production" → branch "production").
  // Pin the major (matches the eas-cli@16 convention below): eoas 3.x is already
  // in alpha, and an unpinned @latest could pull a breaking release into the
  // production publish path with no change in this repo.
  const eoasArgs = [
    'eoas@2',
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
