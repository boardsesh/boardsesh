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
 *     server BRANCH name. Production has a one-time dashboard channel mapping;
 *     per-PR previews are selected through xprem branch surfing.
 *
 * Usage:
 *   vp run mobile:publish                              # preview: current git branch
 *   vp run mobile:publish -- --branch my-feature       # preview: explicit branch
 *   vp run mobile:publish -- --message "fix nav bug"   # custom update message
 *   vp run mobile:publish -- --channel production      # production: self-hosted OTA
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from './lib/eoas';
import {
  publishPlatformsSequentially,
  publishSelfHostedPlatformWithRetry,
  type OtaPublishPlatform,
  type PlatformPublishOutcome,
} from './lib/mobile-publish-retry';

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

/**
 * A GitHub "Create a merge commit" subject, which says nothing about the change.
 *
 * `Merge pull request #5020 from boardsesh/fix/ota-republish-after-native-build`
 */
const MERGE_PULL_REQUEST_SUBJECT = /^Merge pull request #(\d+) from \S+$/;

/**
 * The human-readable title of the commit at HEAD.
 *
 * Normally the subject. For a merge commit GitHub puts the PR title on the first
 * body line, so use that and re-attach the PR number — which lands on exactly the
 * `<title> (#N)` shape a squash merge already produces, so both merge styles read
 * the same on the OTA dashboard.
 */
export function titleFromCommitMessage(subject: string, body: string): string {
  const mergeSubject = MERGE_PULL_REQUEST_SUBJECT.exec(subject);
  if (mergeSubject === null) {
    return subject;
  }
  const pullRequestNumber = mergeSubject[1];
  const pullRequestTitle = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (pullRequestTitle === undefined) {
    // A merge commit with an empty body. The number is all there is to say.
    return `Merge #${pullRequestNumber}`;
  }
  return pullRequestTitle.includes(`(#${pullRequestNumber})`)
    ? pullRequestTitle
    : `${pullRequestTitle} (#${pullRequestNumber})`;
}

function getCommitTitle(): string {
  try {
    // NUL-separated: a body may contain anything, including blank lines and the
    // separator patterns a printable delimiter would use.
    const [subject = '', body = ''] = execFileSync('git', ['log', '-1', '--format=%s%x00%b'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0');
    return titleFromCommitMessage(subject.trim(), body);
  } catch {
    return '';
  }
}

/**
 * The title an update carries on the OTA server: the commit's own title, nothing else.
 *
 * Deliberately NOT `git log --oneline`-shaped. eoas records `commitHash` as its
 * own field on every row (`git rev-parse HEAD`), so a `<short sha> <subject>`
 * message printed the sha twice — once in the dashboard's Commit column, once
 * eating the width the subject needed.
 */
export function resolveUpdateMessage(explicitMessage: string | null): string {
  return explicitMessage ?? getCommitTitle();
}

/**
 * `--message <text>`, or nothing at all when there is no text.
 *
 * Passing an empty string would publish an update titled `""`; omitting the flag
 * instead lets eoas fall back to its own default, `git log -1 --pretty=%B`. Only
 * reachable outside a git checkout, since `getCommitTitle` is the sole source of
 * an empty message.
 */
export function messageArgs(updateMessage: string): string[] {
  return updateMessage === '' ? [] : ['--message', updateMessage];
}

// Whether this publish may run against a dirty working tree. CI only: the
// production OTA workflow regenerates the changelog into the tree and publishes
// it WITHOUT committing, so the update's commitHash and message name the real
// triggering commit instead of a throwaway `chore(changelog)` commit that never
// lands on main. Locally the clean-tree check stays on — otherwise
// `vp run mobile:publish -- --channel production` would ship a developer's
// scratch edits to the fleet.
// Reads one key, so it takes one key's worth of type. NodeJS.ProcessEnv now
// requires NODE_ENV, which made every `{ GITHUB_ACTIONS: 'true' }` in the tests
// a type error without saying anything true about what this needs.
export function shouldAllowDirtyTree(env: Record<string, string | undefined> = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

export function buildSelfHostedEoasArgs(
  branchName: string,
  platform: OtaPublishPlatform,
  updateMessage: string,
  options: { allowDirtyTree?: boolean } = {},
): string[] {
  // eoas aborts on a dirty tree before it ever reads the commit. Skipping that
  // check is what lets the workflow publish the regenerated changelog from an
  // uncommitted tree, keeping HEAD on the triggering commit — eoas reads
  // commitHash with `git rev-parse HEAD` regardless of this flag. The flag is
  // `hidden: true` upstream, so it is undocumented and could be dropped; it is
  // safe only because EOAS_PACKAGE_SPEC pins the exact eoas version. Production
  // only: previews publish from a clean PR checkout and stay strict.
  const repositoryCheckArgs =
    branchName === 'production' && options.allowDirtyTree === true ? ['--disableRepositoryCheck'] : [];
  const sourceMapArgs =
    branchName === 'production'
      ? [
          // Keep the exact production export that eoas uploads on disk with
          // external source maps. The platform-specific workflow uploads this
          // directory to Sentry immediately; the next publish replaces `dist`.
          '--dumpSourcemap',
          '--outputDir',
          'dist',
        ]
      : [];
  return [
    EOAS_PACKAGE_SPEC,
    'publish',
    '--branch',
    branchName,
    '--platform',
    platform,
    ...messageArgs(updateMessage),
    ...sourceMapArgs,
    ...repositoryCheckArgs,
    // Cap how fast eoas starts asset uploads. Before 3.1.2 it fired every asset
    // of the export (380 in a current bundle) through one unbounded
    // `Promise.all`, which is what tripped Tigris `SlowDown` (#3620). Applies to
    // every self-hosted branch — `production` and the per-PR `pr-<n>` previews
    // alike, since the previews are the concurrent ones. The EAS preview path
    // (`buildEasUpdateArgs`) has no equivalent flag and is untouched.
    '--upload-rate',
    String(SELF_HOSTED_UPLOAD_RATE_PER_SECOND),
    '--nonInteractive',
    // Force `vp exec` so eoas spawns the workspace's lockfile-pinned Expo
    // through the toolchain available in both current pnpm checkouts and frozen
    // pre-pnpm release anchors.
    '--packageRunner',
    'vp exec',
  ];
}

export function requestedSelfHostedPlatforms(platform: string): OtaPublishPlatform[] {
  if (platform === 'all') return ['ios', 'android'];
  if (platform === 'ios' || platform === 'android') return [platform];
  throw new Error(`Unsupported self-hosted publish platform: ${platform}`);
}

function summarizePlatformOutcome(outcome: PlatformPublishOutcome): string {
  if (outcome.success)
    return `${outcome.platform}=success (${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'})`;
  return `${outcome.platform}=failed (${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}, ${outcome.failureKind ?? 'unknown'})`;
}

async function publishToSelfHostedBranch(
  branchName: string,
  platform: string,
  explicitMessage: string | null,
): Promise<number> {
  const serverUrl = process.env.EXPO_UPDATES_URL;
  if (!serverUrl) {
    console.error('[mobile:publish] --channel requires EXPO_UPDATES_URL (the expo-open-ota manifest endpoint,');
    console.error(
      '[mobile:publish] e.g. https://updates.boardsesh.com/manifest). eoas derives the upload host from it.',
    );
    console.error('[mobile:publish] See docs/mobile-ota-updates.md.');
    return 1;
  }
  if (!process.env.EOO_TOKEN) {
    console.error('[mobile:publish] --channel requires EOO_TOKEN (an app-scoped expo-open-ota API key).');
    console.error('[mobile:publish] The V3 control-plane server rejects Expo tokens; mint a key in the dashboard');
    console.error('[mobile:publish] and set EOO_TOKEN locally / in CI. See docs/mobile-ota-updates.md.');
    return 1;
  }

  const updateMessage = resolveUpdateMessage(explicitMessage);

  // eoas publish targets a server BRANCH (--branch holds the uploaded
  // update). We deliberately do NOT pass --channel: in eoas@3 it's a DEPRECATED
  // client-side no-op — it only sets RELEASE_CHANNEL during config resolution; it
  // is NOT sent to the server, does NOT create a channel, and does NOT drive
  // rollouts. Production's channel→branch mapping is a one-time dashboard action;
  // per-PR previews use branch surfing. Progressive rollouts are branch + runtimeVersion scoped
  // (--rollout-percentage targets a branch's runtimeVersion), not channel scoped.
  // EOAS_PACKAGE_SPEC pins the CLI (it may lead the deployed server, never trail
  // it); see scripts/lib/eoas.ts. From 3.1.2 the CLI paces its own asset uploads
  // (--upload-rate) and retries 429/5xx itself, so the whole-command retry ladder
  // in lib/mobile-publish-retry.ts is now a backstop rather than the first line
  // of defence against storage throttling.
  console.log(`[mobile:publish] Mode:     ${selfHostedPublishModeLabel(branchName)}`);
  console.log(`[mobile:publish] Server:   ${serverUrl}`);
  console.log(`[mobile:publish] Branch:   ${branchName}`);
  console.log(`[mobile:publish] Message:  ${updateMessage || '(none — eoas will use the commit body)'}`);
  console.log(`[mobile:publish] Platform: ${platform}`);

  // EXPO_UPDATES_URL must resolve in app.config so eoas finds the server.
  // EAS_BUILD must be unset or app.config returns the EAS URL and eoas would
  // publish against the wrong host — strip it defensively so a stray value in
  // the caller's env can't redirect a production publish.
  const eoasEnv = { ...process.env };
  delete eoasEnv.EAS_BUILD;
  // eoas re-spawns `vp exec expo export`. Fail before uploading anything if
  // the workspace's Expo binary is not resolvable. `vp` is deliberately the
  // stable boundary: approved-release backports can check out Bun-era anchors.
  const preflight = spawnSync('vp', ['exec', 'expo', '--version'], { cwd: MOBILE_DIR, stdio: 'ignore' });
  if (preflight.status !== 0) {
    console.error('[mobile:publish] `vp exec expo --version` failed in packages/mobile. Run `vp install` and retry.');
    return 1;
  }

  const platforms = requestedSelfHostedPlatforms(platform);
  const outcomes = await publishPlatformsSequentially(platforms, async (requestedPlatform) => {
    const platformEnv = { ...eoasEnv };
    if (requestedPlatform === 'ios') delete platformEnv.GOOGLE_MAPS_API_KEY;
    const eoasArgs = buildSelfHostedEoasArgs(branchName, requestedPlatform, updateMessage, {
      allowDirtyTree: shouldAllowDirtyTree(),
    });
    console.log('');
    console.log(`[mobile:publish] Running ${requestedPlatform}: vp dlx ${eoasArgs.join(' ')}`);
    console.log('');
    return publishSelfHostedPlatformWithRetry({
      platform: requestedPlatform,
      command: 'vp',
      args: ['dlx', ...eoasArgs],
      cwd: MOBILE_DIR,
      env: platformEnv,
    });
  });

  console.log('');
  console.log(`[mobile:publish] Platform results: ${outcomes.map(summarizePlatformOutcome).join(', ')}`);
  if (outcomes.some((outcome) => !outcome.success)) {
    console.error('[mobile:publish] One or more platform publishes failed; successful platforms were not rolled back.');
    return 1;
  }

  for (const line of selfHostedPublishSuccessMessages(branchName)) console.log(line);
  return 0;
}

export function selfHostedPublishSuccessMessages(branchName: string): string[] {
  const published = `[mobile:publish] Published every requested platform to self-hosted branch "${branchName}".`;
  if (branchName === 'production') {
    return [published, '[mobile:publish] Production builds receive it on their next update check.'];
  }
  return [published, `[mobile:publish] Select "${branchName}" in xprem Branch Surfing to load this preview.`];
}

export function selfHostedPublishModeLabel(branchName: string): string {
  return branchName === 'production' ? 'production (self-hosted expo-open-ota)' : 'preview (self-hosted expo-open-ota)';
}

export function parseArgs(args: string[]): {
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

export function buildEasUpdateArgs(sanitizedBranch: string, updateMessage: string, platform: string): string[] {
  return [
    'eas-cli@16',
    'update',
    '--branch',
    sanitizedBranch,
    ...messageArgs(updateMessage),
    '--platform',
    platform,
    '--non-interactive',
  ];
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const { branch: explicitBranch, message: explicitMessage, platform, channel: selfHostedBranch } = parseArgs(args);

  if (!VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
    console.error(`[mobile:publish] Invalid platform "${platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`);
    return 1;
  }

  // Self-hosted path: the legacy wrapper flag is still named --channel for CLI
  // compatibility, but its value is passed only as the eoas branch selector.
  if (selfHostedBranch) {
    return publishToSelfHostedBranch(selfHostedBranch, platform, explicitMessage);
  }

  const branchName = explicitBranch ?? resolveCurrentBranchName();
  if (!branchName) {
    console.error('[mobile:publish] Could not determine branch name. Use --branch <name> or run from a git branch.');
    return 1;
  }

  const sanitizedBranch = branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
  const updateMessage = resolveUpdateMessage(explicitMessage);

  console.log(`[mobile:publish] Branch:   ${sanitizedBranch}`);
  console.log(`[mobile:publish] Message:  ${updateMessage || '(none — eoas will use the commit body)'}`);
  console.log(`[mobile:publish] Platform: ${platform}`);
  console.log('');

  const easArgs = buildEasUpdateArgs(sanitizedBranch, updateMessage, platform);

  console.log(`[mobile:publish] Running: vp dlx ${easArgs.join(' ')}`);
  console.log('');

  const result = spawnSync('vp', ['dlx', ...easArgs], {
    cwd: MOBILE_DIR,
    stdio: 'inherit',
    env: { ...process.env, PATH: process.env.PATH },
  });

  if (result.status !== 0) {
    console.error('');
    console.error('[mobile:publish] Update failed.');
    if (result.status === 1) {
      console.error('[mobile:publish] Make sure you are logged in: vp dlx eas-cli@16 login');
      console.error('[mobile:publish] And the project is linked: vp dlx eas-cli@16 init (from packages/mobile/)');
    }
    return result.status ?? 1;
  }

  console.log('');
  console.log(`[mobile:publish] Published to branch "${sanitizedBranch}".`);
  console.log(`[mobile:publish] Testers on the "preview" build will receive this update.`);
  console.log('');
  console.log(`[mobile:publish] To point a preview build at this branch:`);
  console.log(`  vp dlx eas-cli@16 channel:edit preview --branch ${sanitizedBranch}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      // Keep this generic: an unexpected error can contain child argv, env, or
      // server output that must not be echoed as a captured diagnostic.
      console.error('[mobile:publish] Unexpected publish failure.');
      process.exitCode = 1;
    });
}
