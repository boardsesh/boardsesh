/// <reference types="node" />

/** Native compatibility shared by the published dev-client gate and APK consumers. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture, type RunOptions, type RunResult } from './exec';
import { parseResolverOutput } from './mobile-runtime-version';

export const DEV_NATIVE_INPUT_PATHS: readonly string[] = [
  'package.json',
  'packages/mobile/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/mobile/app.config.ts',
  'packages/mobile/fingerprint.config.js',
  'packages/mobile/plugins',
  'packages/mobile/modules',
  'packages/mobile/locales',
  'packages/mobile/eas.json',
  'packages/mobile/assets',
  'packages/mobile/dev-assets',
  'packages/mobile/targets',
  'patches',
];

export type NativeCommandRunner = (command: string, args: string[], options?: RunOptions) => RunResult;

const DEV_ENV_DEFAULTS = {
  EXPO_PUBLIC_BACKEND_URL: 'https://ws.boardsesh.com',
  EXPO_PUBLIC_WS_URL: 'wss://ws.boardsesh.com/graphql',
  EXPO_PUBLIC_WEB_URL: 'https://www.boardsesh.com',
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '401523882502-0f6d7te1vekvkpmg18t8di6l0ig560q7.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: '401523882502-h92kdkck1qhmdbgq7ltek87g4rg8rg3h.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: '401523882502-hvfhh79p4q1qq0md7lk646c6sgmsi9q0.apps.googleusercontent.com',
  EXPO_PUBLIC_SENTRY_DSN:
    'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400',
  EXPO_PUBLIC_POSTHOG_KEY: '',
  EXPO_PUBLIC_USE_RN_FETCH: '1',
} as const;

/** Identical config and .env for both trees; caller's Metro .env is never changed. */
export function devFingerprintEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const devEnvironment = { ...environment };
  for (const [name, fallback] of Object.entries(DEV_ENV_DEFAULTS)) {
    devEnvironment[name] = environment[name] ?? fallback;
  }
  devEnvironment.BOARDSESH_APP_VARIANT = 'dev';
  devEnvironment.TAILSCALE_HOSTS = '';
  devEnvironment.CI = '1';
  // These opt-ins describe another binary, not the universal CI dev-client.
  for (const name of [
    'EXPO_UPDATES_FINGERPRINT_OVERRIDE',
    'BOARDSESH_WEB',
    'BOARDSESH_SCREENSHOT_BUILD',
    'EAS_BUILD',
    'EAS_BUILD_PROFILE',
    'GOOGLE_SERVICES_JSON',
    'GOOGLE_MAPS_API_KEY',
    'EXPO_UPDATES_URL',
    'EXPO_PUBLIC_EAS_PROJECT_ID',
    'EXPO_PUBLIC_OTA_APP_ID',
    'EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME',
  ]) {
    delete devEnvironment[name];
  }
  return devEnvironment;
}

function commandResult(runner: NativeCommandRunner, command: string, args: string[], options: RunOptions): string {
  const result = runner(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export interface NativeComparison {
  compatible: boolean;
  headFingerprint?: string;
  baseFingerprint?: string;
}

/**
 * Compare the APK's commit with the requested tree, not the preceding merge.
 * Equal native paths avoid installs. Candidate edits use Expo's real resolver
 * so version bumps and unrelated dependency changes do not trigger a rebuild.
 */
export function compareDevNativeInputs(
  repoRoot: string,
  headCommit: string,
  baseCommit: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: NativeCommandRunner = runCapture,
): NativeComparison {
  if (!/^[0-9a-f]{40}$/i.test(headCommit) || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
    throw new Error('Native comparison requires exact commit SHAs');
  }
  const gitOptions = { cwd: repoRoot };
  for (const commit of [headCommit, baseCommit]) {
    if (runner('git', ['cat-file', '-e', `${commit}^{commit}`], gitOptions).status !== 0) {
      commandResult(runner, 'git', ['fetch', '--no-tags', '--depth=1', 'origin', commit], gitOptions);
      commandResult(runner, 'git', ['cat-file', '-e', `${commit}^{commit}`], gitOptions);
    }
  }
  const diff = runner('git', ['diff', '--quiet', baseCommit, headCommit, '--', ...DEV_NATIVE_INPUT_PATHS], gitOptions);
  if (diff.status === 0) return { compatible: true };
  if (diff.status !== 1) throw new Error(`Native input diff failed (${diff.status}): ${diff.stderr.trim()}`);

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'boardsesh-dev-native-'));
  const worktreePaths: string[] = [];
  const devEnvironment = devFingerprintEnvironment(environment);
  const envContents = Object.keys(DEV_ENV_DEFAULTS)
    .map((name) => `${name}=${devEnvironment[name] ?? ''}\n`)
    .join('');
  const fingerprints: string[] = [];
  try {
    for (const [label, commit] of [
      ['head', headCommit],
      ['base', baseCommit],
    ]) {
      const worktreePath = join(temporaryRoot, label);
      commandResult(runner, 'git', ['worktree', 'add', '--detach', worktreePath, commit], gitOptions);
      worktreePaths.push(worktreePath);
      writeFileSync(join(worktreePath, 'packages/mobile/.env'), envContents);
      commandResult(runner, 'vp', ['install', '--frozen-lockfile'], { cwd: worktreePath, env: devEnvironment });
      const stdout = commandResult(
        runner,
        'vp',
        ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', 'android'],
        { cwd: join(worktreePath, 'packages/mobile'), env: devEnvironment },
      );
      const { runtimeVersion } = parseResolverOutput(stdout);
      if (typeof runtimeVersion !== 'string' || !/^[0-9a-f]{40}$/i.test(runtimeVersion)) {
        throw new Error(`Invalid Android dev fingerprint at ${label}`);
      }
      fingerprints.push(runtimeVersion.toLowerCase());
    }
    return {
      compatible: fingerprints[0] === fingerprints[1],
      headFingerprint: fingerprints[0],
      baseFingerprint: fingerprints[1],
    };
  } finally {
    for (const worktreePath of worktreePaths.reverse()) {
      runner('git', ['worktree', 'remove', '--force', worktreePath], gitOptions);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export interface PublishedDevApk {
  tag: string;
  commit: string;
  url: string;
  runId: number;
}

function record(candidate: unknown): Record<string, unknown> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('Invalid GitHub API object');
  }
  return candidate as Record<string, unknown>;
}

function apiJson(runner: NativeCommandRunner, repoRoot: string, endpoint: string, paginate = false): unknown {
  const args = ['api', endpoint, ...(paginate ? ['--paginate', '--slurp'] : [])];
  return JSON.parse(commandResult(runner, 'gh', args, { cwd: repoRoot })) as unknown;
}

function pages(candidate: unknown): unknown[] {
  if (!Array.isArray(candidate) || candidate.some((page) => !Array.isArray(page))) {
    throw new Error('Invalid paginated GitHub API response');
  }
  return candidate.flat() as unknown[];
}

/** Read every release page; stable /latest and the first 50 entries are insufficient. */
export function latestPublishedDevApk(
  repoRoot: string,
  runner: NativeCommandRunner = runCapture,
): PublishedDevApk | null {
  const releases = pages(apiJson(runner, repoRoot, 'repos/{owner}/{repo}/releases?per_page=100', true))
    .map(record)
    .filter(
      (release) =>
        release.draft === false &&
        release.prerelease === true &&
        typeof release.tag_name === 'string' &&
        /^rn-android-dev-\d+$/.test(release.tag_name) &&
        Array.isArray(release.assets) &&
        release.assets.some((candidate: unknown) => {
          const asset = record(candidate);
          return (
            asset.name === 'boardsesh-dev-android.apk' &&
            asset.state === 'uploaded' &&
            typeof asset.size === 'number' &&
            asset.size > 0
          );
        }),
    )
    .sort(
      (first, second) =>
        Number(String(second.tag_name).split('-').at(-1)) - Number(String(first.tag_name).split('-').at(-1)),
    );

  for (const release of releases) {
    const tag = String(release.tag_name);
    const buildNumber = Number(tag.split('-').at(-1));
    const reference = record(apiJson(runner, repoRoot, `repos/{owner}/{repo}/git/ref/tags/${tag}`));
    const target = record(reference.object);
    const commit =
      target.type === 'tag'
        ? record(record(apiJson(runner, repoRoot, `repos/{owner}/{repo}/git/tags/${String(target.sha)}`)).object).sha
        : target.sha;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`Invalid build commit for ${tag}`);
    }
    const runPages = apiJson(
      runner,
      repoRoot,
      `repos/{owner}/{repo}/actions/workflows/android-apk-dev-client.yml/runs?head_sha=${commit}&per_page=100`,
      true,
    );
    if (!Array.isArray(runPages)) throw new Error('Invalid workflow runs response');
    const runs = runPages.flatMap((page: unknown) => {
      const workflowRuns = record(page).workflow_runs;
      if (!Array.isArray(workflowRuns)) throw new Error('Missing dev-client workflow runs');
      return workflowRuns.map(record);
    });
    const successfulRun = runs.find(
      (run) =>
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        run.run_number === buildNumber &&
        run.head_sha === commit &&
        run.head_branch === 'main' &&
        run.path === '.github/workflows/android-apk-dev-client.yml' &&
        typeof run.id === 'number',
    );
    if (successfulRun) {
      if (typeof release.html_url !== 'string') throw new Error(`Missing release URL for ${tag}`);
      return { tag, commit, url: release.html_url, runId: successfulRun.id as number };
    }
  }
  return null;
}
