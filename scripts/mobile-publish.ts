/// <reference types="node" />

/**
 * Publishes an EAS Update for the current branch so testers on the "preview"
 * build can receive it OTA. Each git branch gets its own EAS Update branch,
 * meaning multiple worktrees can publish independently and testers switch
 * between them by scanning a QR code or selecting the branch in the app.
 *
 * Usage:
 *   vp run mobile:publish              # publishes to current git branch
 *   vp run mobile:publish -- --branch my-feature  # explicit branch name
 *   vp run mobile:publish -- --message "fix nav bug"  # custom update message
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function parseArgs(args: string[]): { branch: string | null; message: string | null; platform: string } {
  let branch: string | null = null;
  let message: string | null = null;
  let platform = 'all';

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

  return { branch, message, platform };
}

const VALID_PLATFORMS = ['ios', 'android', 'all'] as const;

const { branch: explicitBranch, message: explicitMessage, platform } = parseArgs(process.argv.slice(2));

if (!VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
  console.error(`[mobile:publish] Invalid platform "${platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`);
  process.exit(1);
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
  env: { ...process.env },
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

// Upload source maps so this OTA update's $exception stack traces are readable in
// PostHog error tracking. Native builds do this via the Xcode/Gradle build phases;
// OTA isn't covered by those. Best-effort and gated on credentials: most local
// publishes are unkeyed and skip it; CI (mobile-eas-update.yml) sets the env vars.
// expo export re-bundles deterministically, so the debug IDs match the bundle eas
// update just shipped.
const posthogApiKey = process.env.POSTHOG_CLI_API_KEY;
const posthogProjectId = process.env.POSTHOG_CLI_PROJECT_ID;
if (posthogApiKey && posthogProjectId) {
  console.log('');
  console.log('[mobile:publish] Uploading source maps to PostHog...');
  const exportResult = spawnSync('bunx', ['expo', 'export', '--dump-sourcemap', '--platform', platform], {
    cwd: MOBILE_DIR,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (exportResult.status !== 0) {
    console.warn('[mobile:publish] expo export failed — skipping PostHog source map upload (OTA already shipped).');
  } else {
    const uploadResult = spawnSync('bunx', ['posthog-cli', 'hermes', 'upload', '--directory', 'dist'], {
      cwd: MOBILE_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (uploadResult.status !== 0) {
      console.warn('[mobile:publish] PostHog source map upload failed (OTA already shipped).');
    } else {
      console.log('[mobile:publish] Source maps uploaded to PostHog.');
    }
  }
} else {
  console.log('');
  console.log('[mobile:publish] POSTHOG_CLI_API_KEY / POSTHOG_CLI_PROJECT_ID not set — skipping source map upload.');
  console.log('[mobile:publish] (CI uploads automatically; set both to upload from a local publish.)');
}

console.log('');
console.log(`[mobile:publish] Published to branch "${sanitizedBranch}".`);
console.log(`[mobile:publish] Testers on the "preview" build will receive this update.`);
console.log('');
console.log(`[mobile:publish] To point a preview build at this branch:`);
console.log(`  bunx eas-cli@16 channel:edit preview --branch ${sanitizedBranch}`);
