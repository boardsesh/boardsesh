/// <reference types="node" />

/** Main-only native release stamping and recovery; public store review is never submitted here. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APP_CONFIG_PATH, BOT_EMAIL, BOT_NAME, readMarketingVersion } from './lib/mobile-release-version.ts';
import {
  NATIVE_BASELINE_TAG,
  NATIVE_RESTORATION_MARKER,
  NATIVE_STAMP_PATTERN,
  NATIVE_WORKFLOWS,
  compareNativeVersions,
  coordinateNativeSnapshots,
  exactNativeBuilds,
  nativeRecoveryDecision,
  nativeReleaseMessage,
  nativeStampKind,
  planNativeVersion,
  parseNativeReleaseMetadata,
  publishNativeBaseline,
  publishNativeRestoration,
  replaceNativeVersion,
  requireFingerprints,
  requireFullSha,
  requireUnreleasedNativeVersion,
  sameNativeFingerprints,
  type NativeBuildRun,
  type NativeFingerprints,
  type NativePlatform,
  type NativeStamp,
  type NativeStampKind,
  type TaggedNativeBuild,
} from './lib/native-release.ts';

const ROOT = resolve(process.env.NATIVE_RELEASE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const MAIN_REF = 'refs/remotes/origin/main';
const ENVIRONMENT_KEYS = [
  'EXPO_PUBLIC_BACKEND_URL',
  'EXPO_PUBLIC_WS_URL',
  'EXPO_PUBLIC_WEB_URL',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_POSTHOG_KEY',
  'EXPO_PUBLIC_SNAPSHOT_BASE_URL',
  'EXPO_PUBLIC_USE_RN_FETCH',
] as const;

function execute(
  binary: string,
  argumentsList: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; trim?: boolean } = {},
): string {
  const { trim = true, ...executionOptions } = options;
  const result = execFileSync(binary, argumentsList, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...executionOptions,
  });
  return trim ? result.trim() : result;
}

function git(argumentsList: string[], options: Parameters<typeof execute>[2] = {}): string {
  return execute('git', argumentsList, options);
}

function ancestor(sourceSha: string, mainSha: string, directory = ROOT): boolean {
  try {
    git(['merge-base', '--is-ancestor', sourceSha, mainSha], { cwd: directory });
    return true;
  } catch {
    return false;
  }
}

function refresh(): string {
  git([
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/tags/*:refs/tags/*',
  ]);
  return requireFullSha(git(['rev-parse', MAIN_REF]));
}

function output(fields: Record<string, string | boolean>): void {
  const rendered = Object.entries(fields)
    .map(([name, contents]) => `${name}=${contents}`)
    .join('\n');
  console.log(rendered);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${rendered}\n`);
}

type ValidationContext = { stamps: Map<string, NativeStamp>; pending: Set<string> };
type NativeBaseline = NativeFingerprints & { sourceSha: string; version: string };
const validationContext = (): ValidationContext => ({ stamps: new Map(), pending: new Set() });

/** Historical proofs use immutable git ancestry/bytes, never today's public-store state. */
export function validateNativeStampSource(sourceSha: string, mainSha?: string, directory = ROOT): NativeStamp {
  const latestMain = mainSha ?? git(['rev-parse', MAIN_REF], { cwd: directory });
  return validateStamp(sourceSha, latestMain, directory, validationContext());
}

function validateStamp(
  sourceSha: string,
  latestMain: string,
  directory: string,
  context: ValidationContext,
): NativeStamp {
  const read = (argumentsList: string[]) => git(argumentsList, { cwd: directory });
  const configAt = (commit: string) => git(['show', `${commit}:${APP_CONFIG_PATH}`], { cwd: directory, trim: false });
  requireFullSha(sourceSha);
  requireFullSha(latestMain);
  if (!ancestor(sourceSha, latestMain, directory))
    throw new Error('Native build source is not an ancestor of current main.');
  const cached = context.stamps.get(sourceSha);
  if (cached) return cached;
  if (context.pending.has(sourceSha)) throw new Error('Cyclic native stamp provenance.');
  context.pending.add(sourceSha);
  try {
    const message = read(['show', '-s', '--format=%B', sourceSha]);
    const kind = nativeStampKind(message);
    if (!kind) throw new Error('Native source is not a release stamp.');
    const metadata = parseNativeReleaseMetadata(message, kind);
    const parents = read(['show', '-s', '--format=%P', sourceSha]).split(' ');
    if (parents.length !== 1 || parents[0] !== metadata.sourceSha)
      throw new Error('Native stamp must name its only parent.');
    if (
      read(['show', '-s', '--format=%an', sourceSha]) !== BOT_NAME ||
      read(['show', '-s', '--format=%ae', sourceSha]) !== BOT_EMAIL
    )
      throw new Error('Native stamp has an unexpected author.');
    const paths = read(['diff-tree', '--no-commit-id', '--name-only', '-r', sourceSha]).split('\n').filter(Boolean);
    const before = configAt(metadata.sourceSha);
    const after = configAt(sourceSha);
    const version = readMarketingVersion(after);
    if (version !== metadata.version) throw new Error('Native stamp marketing version does not match its provenance.');
    if (kind === 'version-adoption') {
      if (
        paths.length ||
        read(['rev-parse', `${sourceSha}^{tree}`]) !== read(['rev-parse', `${metadata.sourceSha}^{tree}`])
      )
        throw new Error('Native adoption must preserve its parent tree exactly.');
      const previous = latestStamp(metadata.sourceSha, directory, context) ?? baseline(metadata.sourceSha, directory);
      // Only planning reads release tags, so a later store approval never invalidates this proof.
      if (compareNativeVersions(version, previous.version) < 0 || sameNativeFingerprints(metadata, previous))
        throw new Error('Native adoption requires the open or a raised version and a changed native pair.');
    } else {
      if (paths.length !== 1 || paths[0] !== APP_CONFIG_PATH)
        throw new Error('Native stamp must change only the app version.');
      const entryMode = (commit: string) =>
        read(['ls-tree', commit, '--', APP_CONFIG_PATH]).split(/\s+/).slice(0, 2).join(' ');
      if (
        entryMode(sourceSha) !== entryMode(metadata.sourceSha) ||
        !['100644 blob', '100755 blob'].includes(entryMode(sourceSha))
      )
        throw new Error('Native version stamps must preserve the app config file mode.');
      if (replaceNativeVersion(before, version) !== after)
        throw new Error('Native stamp contains changes beyond its marketing version.');
      if (kind === 'version-bump') {
        if (compareNativeVersions(version, readMarketingVersion(before)) <= 0)
          throw new Error('Native stamp must contain an increasing marketing version.');
      } else {
        const superseded = validateStamp(metadata.supersedes!, metadata.sourceSha, directory, context);
        const previous = latestStamp(metadata.sourceSha, directory, context);
        const originalVersion = readMarketingVersion(configAt(superseded.sourceSha));
        const originalAnchor =
          latestStamp(superseded.sourceSha, directory, context) ?? baseline(superseded.sourceSha, directory);
        if (
          superseded.kind !== 'version-bump' ||
          previous?.sha !== superseded.sha ||
          readMarketingVersion(before) !== superseded.version ||
          version !== originalVersion ||
          compareNativeVersions(version, superseded.version) >= 0 ||
          compareNativeVersions(version, originalAnchor.version) < 0 ||
          !sameNativeFingerprints(metadata, superseded)
        )
          throw new Error(
            'Native restoration must undo the exact latest bump of an open version without changing its native pair.',
          );
      }
    }
    const stamp = { ...metadata, version, sha: sourceSha, kind };
    context.stamps.set(sourceSha, stamp);
    return stamp;
  } finally {
    context.pending.delete(sourceSha);
  }
}

function latestStamp(mainSha: string, directory = ROOT, context = validationContext()): NativeStamp | null {
  const candidate = git(
    ['log', '--first-parent', '-1', '--format=%H', '--extended-regexp', `--grep=${NATIVE_STAMP_PATTERN}`, mainSha],
    { cwd: directory },
  );
  return candidate ? validateStamp(candidate, mainSha, directory, context) : null;
}

function baseline(mainSha: string, directory = ROOT): NativeBaseline {
  const read = (argumentsList: string[]) => git(argumentsList, { cwd: directory });
  try {
    if (read(['cat-file', '-t', `refs/tags/${NATIVE_BASELINE_TAG}`]) !== 'tag')
      throw new Error('Baseline is not annotated.');
    const sourceSha = read(['rev-parse', `refs/tags/${NATIVE_BASELINE_TAG}^{commit}`]);
    const metadata = parseNativeReleaseMetadata(
      read(['for-each-ref', '--format=%(contents)', `refs/tags/${NATIVE_BASELINE_TAG}`]),
      'baseline',
    );
    if (metadata.sourceSha !== sourceSha || !ancestor(sourceSha, mainSha, directory))
      throw new Error('Baseline does not identify main history.');
    return { ...metadata, sourceSha, version: readMarketingVersion(read(['show', `${sourceSha}:${APP_CONFIG_PATH}`])) };
  } catch {
    throw new Error(
      `Missing or invalid protected ${NATIVE_BASELINE_TAG}. Dispatch baseline with the pre-cutover main SHA before coordinating releases.`,
    );
  }
}

/** Only explicit, validated restoration records retire tester reservations. */
export function getSupersededNativeStampShas(directory = ROOT, mainSha?: string): string[] {
  const currentMain = mainSha ?? git(['rev-parse', MAIN_REF], { cwd: directory });
  requireFullSha(currentMain);
  const commits = git(['log', '--first-parent', '--format=%H', `--grep=^${NATIVE_RESTORATION_MARKER}$`, currentMain], {
    cwd: directory,
  })
    .split('\n')
    .filter(Boolean);
  const context = validationContext();
  return [...new Set(commits.map((commit) => validateStamp(commit, currentMain, directory, context).supersedes!))];
}

function tagReferences(directory = ROOT): TaggedNativeBuild[] {
  return git(
    [
      'for-each-ref',
      '--format=%(refname:strip=2) %(objectname) %(*objectname)',
      'refs/tags/build-*',
      'refs/tags/release/*',
    ],
    { cwd: directory },
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, directSha, peeledSha] = line.split(' ');
      return { tag: tag!, sha: peeledSha || directSha! };
    });
}

function allTagNames(): string[] {
  return git(['tag', '--list']).split('\n').filter(Boolean);
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    'PUSH_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NATIVE_ANDROID_MAPS_KEY',
    'GOOGLE_MAPS_API_KEY',
    'EXPO_UPDATES_FINGERPRINT_OVERRIDE',
  ])
    delete environment[name];
  return environment;
}

function withSourceTree<T>(sourceSha: string, operation: (directory: string) => T): T {
  const temporary = mkdtempSync(join(tmpdir(), 'boardsesh-native-release-'));
  const directory = join(temporary, 'source');
  git(['worktree', 'add', '--quiet', '--detach', directory, sourceSha]);
  try {
    return operation(directory);
  } finally {
    git(['worktree', 'remove', '--force', directory]);
    rmSync(temporary, { recursive: true, force: true });
  }
}

function resolveFingerprints(directory: string): NativeFingerprints {
  const environment = cleanEnvironment();
  console.log('Resolving canonical native fingerprints.');
  execute('vp', ['install', '--frozen-lockfile'], { cwd: directory, env: environment });
  const mobileDirectory = join(directory, 'packages/mobile');
  writeFileSync(
    join(mobileDirectory, '.env'),
    `${ENVIRONMENT_KEYS.map((key) => `${key}=${process.env[key] ?? ''}`).join('\n')}\n`,
  );
  const resolvePlatform = (platform: NativePlatform): string => {
    const platformEnvironment = { ...environment };
    if (platform === 'android') {
      const mapsKey = process.env.NATIVE_ANDROID_MAPS_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
      if (!mapsKey) throw new Error('Missing Android Maps key for canonical native fingerprint resolution.');
      platformEnvironment.GOOGLE_MAPS_API_KEY = mapsKey;
    }
    const resolved: unknown = JSON.parse(
      execute('vp', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform], {
        cwd: mobileDirectory,
        env: platformEnvironment,
      }),
    );
    if (
      !resolved ||
      typeof resolved !== 'object' ||
      !('runtimeVersion' in resolved) ||
      typeof resolved.runtimeVersion !== 'string'
    )
      throw new Error(`Could not resolve the canonical ${platform} fingerprint.`);
    return requireFullSha(resolved.runtimeVersion, `${platform} fingerprint`);
  };
  return requireFingerprints({ ios: resolvePlatform('ios'), android: resolvePlatform('android') });
}

function authenticatedPush(refspec: string): void {
  const pushToken = process.env.PUSH_TOKEN;
  if (!pushToken) throw new Error('Missing repository App push token.');
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${pushToken}`).toString('base64')}`,
  };
  git(['push', `https://github.com/${repository()}.git`, refspec], { env: environment });
}

function repository(): string {
  const name = process.env.GITHUB_REPOSITORY;
  if (!name || !/^[\w.-]+\/[\w.-]+$/.test(name))
    throw new Error('GITHUB_REPOSITORY must identify the trusted repository.');
  return name;
}

function ghPages(endpoint: string): unknown[] {
  const pages: unknown = JSON.parse(
    execute('gh', ['api', '--paginate', '--slurp', `repos/${repository()}/${endpoint}`]),
  );
  if (!Array.isArray(pages)) throw new Error('GitHub returned unreadable native release evidence.');
  return pages;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Unreadable GitHub native release record.');
  return input as Record<string, unknown>;
}

function buildRuns(workflowFile: string): NativeBuildRun[] {
  return ghPages(`actions/workflows/${workflowFile}/runs?branch=main&per_page=100`).flatMap((page) => {
    const runs = object(page).workflow_runs;
    if (!Array.isArray(runs)) throw new Error('Missing native workflow runs.');
    return runs.map((input) => {
      const run = object(input);
      const headRepository = object(run.head_repository);
      if (headRepository.full_name !== repository() || run.head_branch !== 'main')
        throw new Error('Untrusted native workflow run.');
      if (
        typeof run.id !== 'number' ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.display_title !== 'string' ||
        typeof run.status !== 'string' ||
        (run.conclusion !== null && typeof run.conclusion !== 'string') ||
        typeof run.created_at !== 'string' ||
        !Number.isFinite(Date.parse(run.created_at))
      )
        throw new Error('Incomplete native workflow run.');
      return {
        id: run.id,
        title: run.display_title,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
      };
    });
  });
}

function uploadAttempted(runId: number, uploadStep: string): boolean {
  return ghPages(`actions/runs/${runId}/jobs?filter=all&per_page=100`).some((page) => {
    const jobs = object(page).jobs;
    if (!Array.isArray(jobs)) throw new Error('Missing native build jobs.');
    return jobs.some((input) => {
      const steps = object(input).steps;
      if (!Array.isArray(steps)) return false;
      return steps.some((inputStep) => {
        const step = object(inputStep);
        return (
          step.name === uploadStep &&
          step.status !== 'queued' &&
          step.status !== 'pending' &&
          step.conclusion !== 'skipped'
        );
      });
    });
  });
}

function recoverLatest(stamp: NativeStamp, dryRun: boolean): void {
  const currentStamp = latestStamp(refresh());
  if (currentStamp?.sha !== stamp.sha) {
    console.log('A newer native stamp appeared while resolving main; its own coordinator run handles recovery.');
    return;
  }
  const taggedBuilds = tagReferences();
  for (const workflow of NATIVE_WORKFLOWS) {
    if (exactNativeBuilds(taggedBuilds, workflow.platform, stamp).length > 0) {
      console.log(`${workflow.platform}: done. The exact stamped binary is tagged.`);
      continue;
    }
    const runs = buildRuns(workflow.file);
    const firstDecision = nativeRecoveryDecision({
      platform: workflow.platform,
      stamp,
      taggedBuilds,
      runs,
      now: Date.now(),
    });
    const matching = runs
      .filter((run) => run.title === `${workflow.platform}:${stamp.sha}`)
      .sort((left, right) => right.id - left.id);
    const latest = matching[0];
    const attempted = latest?.status === 'completed' && uploadAttempted(latest.id, workflow.uploadStep);
    const decision =
      firstDecision.action === 'done' || firstDecision.action === 'wait'
        ? firstDecision
        : nativeRecoveryDecision({
            platform: workflow.platform,
            stamp,
            taggedBuilds,
            runs,
            now: Date.now(),
            uploadAttempted: attempted,
          });
    console.log(`${workflow.platform}: ${decision.action}. ${decision.reason}`);
    if (decision.action === 'inspect')
      throw new Error(`${workflow.platform} run ${decision.runId}: ${decision.reason}`);
    if (decision.action === 'dispatch' && !dryRun)
      execute('gh', [
        'workflow',
        'run',
        workflow.file,
        '--repo',
        repository(),
        '--ref',
        'main',
        '-f',
        `source_sha=${stamp.sha}`,
        '-f',
        'force_native=false',
      ]);
  }
}

/** Builds the stamp commit object only; publishing it to main is a separate, verified push. */
export function writeNativeStamp(
  directory: string,
  mainSha: string,
  fingerprints: NativeFingerprints,
  version: string,
  kind: NativeStampKind,
  supersedes?: string,
): NativeStamp {
  const configPath = join(directory, APP_CONFIG_PATH);
  const config = git(['show', `${mainSha}:${APP_CONFIG_PATH}`], { cwd: directory, trim: false });
  let tree = git(['rev-parse', `${mainSha}^{tree}`], { cwd: directory });
  if (kind !== 'version-adoption') {
    writeFileSync(configPath, replaceNativeVersion(config, version));
    git(['add', '--', APP_CONFIG_PATH], { cwd: directory });
    tree = git(['write-tree'], { cwd: directory });
  }
  const timestamp = String(Number(git(['show', '-s', '--format=%ct', mainSha], { cwd: directory })) + 1);
  const metadata = { ...fingerprints, sourceSha: mainSha, version, ...(supersedes ? { supersedes } : {}) };
  const stampSha = git(['commit-tree', tree, '-p', mainSha], {
    cwd: directory,
    input: nativeReleaseMessage(metadata, kind),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
      GIT_AUTHOR_DATE: `${timestamp} +0000`,
      GIT_COMMITTER_DATE: `${timestamp} +0000`,
    },
  });
  return { ...metadata, sha: stampSha, kind };
}

export function prepareNativeVersionStamp(
  directory: string,
  mainSha: string,
  fingerprints: NativeFingerprints,
  previousNativeVersion: string,
  references: readonly TaggedNativeBuild[],
  supersededStampShas: readonly string[] = [],
): NativeStamp {
  const currentVersion = readMarketingVersion(git(['show', `${mainSha}:${APP_CONFIG_PATH}`], { cwd: directory }));
  const plan = planNativeVersion(currentVersion, previousNativeVersion, references, supersededStampShas);
  return writeNativeStamp(directory, mainSha, fingerprints, plan.version, plan.kind);
}

/** Prepare an explicit undo of one bump that should have kept the open version; never mutate refs. */
export function prepareNativeVersionRestoration(
  directory: string,
  mainSha: string,
  targetVersion: string,
  expectedStampSha: string,
  fingerprints: NativeFingerprints,
): { stamp: NativeStamp; alreadyApplied: boolean } {
  requireFullSha(mainSha);
  requireFullSha(expectedStampSha, 'Expected latest native stamp');
  compareNativeVersions(targetVersion, targetVersion);
  requireFingerprints(fingerprints);
  const latest = latestStamp(mainSha, directory);
  const currentVersion = readMarketingVersion(git(['show', `${mainSha}:${APP_CONFIG_PATH}`], { cwd: directory }));
  if (
    latest?.kind === 'version-restoration' &&
    latest.supersedes === expectedStampSha &&
    latest.version === targetVersion &&
    currentVersion === targetVersion &&
    sameNativeFingerprints(latest, fingerprints)
  )
    return { stamp: latest, alreadyApplied: true };
  if (latest?.sha !== expectedStampSha || latest.kind !== 'version-bump')
    throw new Error('The expected latest native version-bump stamp changed. Plan restoration again.');
  const originalVersion = readMarketingVersion(
    git(['show', `${latest.sourceSha}:${APP_CONFIG_PATH}`], { cwd: directory }),
  );
  const previous = latestStamp(latest.sourceSha, directory) ?? baseline(latest.sourceSha, directory);
  if (
    currentVersion !== latest.version ||
    targetVersion !== originalVersion ||
    compareNativeVersions(targetVersion, latest.version) >= 0
  )
    throw new Error('Restoration must undo only the latest bump, back to the version its source had.');
  if (!sameNativeFingerprints(latest, fingerprints))
    throw new Error('Native fingerprints changed after the expected stamp; refusing version restoration.');
  const references = git(['tag', '--list'], { cwd: directory }).split('\n').filter(Boolean);
  requireUnreleasedNativeVersion(targetVersion, references);
  // Restore only what the coordinator would keep today: the target is still open (no release
  // anchor, no higher reservation once this bump's own tester builds are retired).
  const retired = [...getSupersededNativeStampShas(directory, mainSha), expectedStampSha];
  const plan = planNativeVersion(targetVersion, previous.version, tagReferences(directory), retired);
  if (plan.kind !== 'version-adoption' || plan.version !== targetVersion)
    throw new Error(`Native ${targetVersion} is not an open version the coordinator would keep; refusing restoration.`);
  return {
    stamp: writeNativeStamp(directory, mainSha, fingerprints, targetVersion, 'version-restoration', expectedStampSha),
    alreadyApplied: false,
  };
}

function coordinate(dryRun: boolean): void {
  const result = coordinateNativeSnapshots(
    {
      prepare() {
        const mainSha = refresh();
        const stamp = latestStamp(mainSha);
        const previous = stamp ?? baseline(mainSha);
        const prepared = withSourceTree(mainSha, (directory) => {
          const fingerprints = resolveFingerprints(directory);
          if (sameNativeFingerprints(previous, fingerprints)) return null;
          const prepared = prepareNativeVersionStamp(
            directory,
            mainSha,
            fingerprints,
            previous.version,
            tagReferences(),
            getSupersededNativeStampShas(ROOT, mainSha),
          );
          console.log(
            `Native change on ${mainSha}: prepared ${prepared.sha} (${prepared.kind} v${prepared.version}; previous native v${previous.version}).`,
          );
          return prepared;
        });
        return {
          mainSha,
          stampSha: prepared?.sha ?? null,
          previousStamp: stamp,
          // Empty adoption commits do not match the native workflows' push paths.
          ...(prepared?.kind === 'version-adoption' ? { immediateRecoveryStamp: prepared } : {}),
        };
      },
      push(stampSha) {
        authenticatedPush(`${stampSha}:refs/heads/main`);
      },
      committed(stampSha) {
        return ancestor(stampSha, refresh());
      },
      recover: recoverLatest,
    },
    dryRun,
  );
  // The App push starts both stamped native workflows; its follow-up/schedule
  // reconciles missing starts, without waiting for binaries under this lock.
  output({ changed: result.changed, source_sha: result.sourceSha, dry_run: dryRun });
}

function restoreVersion(targetVersion: string, expectedStampSha: string, apply: boolean): void {
  compareNativeVersions(targetVersion, targetVersion);
  requireFullSha(expectedStampSha, 'Expected latest native stamp');
  const mainSha = refresh();
  const prepared = withSourceTree(mainSha, (directory) =>
    prepareNativeVersionRestoration(
      directory,
      mainSha,
      targetVersion,
      expectedStampSha,
      resolveFingerprints(directory),
    ),
  );
  const applied =
    prepared.alreadyApplied ||
    publishNativeRestoration(
      prepared.stamp.sha,
      {
        push: (stampSha) => authenticatedPush(`${stampSha}:refs/heads/main`),
        committed: (stampSha) => ancestor(stampSha, refresh()),
      },
      apply,
    );
  output({
    source_sha: prepared.stamp.sha,
    main_sha: mainSha,
    version: prepared.stamp.version,
    supersedes_sha: expectedStampSha,
    fingerprint_ios: prepared.stamp.ios,
    fingerprint_android: prepared.stamp.android,
    applied,
    already_applied: prepared.alreadyApplied,
  });
}

function createBaseline(sourceSha: string, apply: boolean): void {
  const mainSha = refresh();
  requireFullSha(sourceSha);
  if (!ancestor(sourceSha, mainSha)) throw new Error('Native baseline must be in main history.');
  const fingerprints = withSourceTree(sourceSha, resolveFingerprints);
  const message = nativeReleaseMessage({ ...fingerprints, sourceSha }, 'baseline');
  const remoteObject = (): string | null => {
    const references = git([
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${NATIVE_BASELINE_TAG}`,
      `refs/tags/${NATIVE_BASELINE_TAG}^{}`,
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/));
    const direct = references.filter(([, reference]) => reference === `refs/tags/${NATIVE_BASELINE_TAG}`);
    const peeled = references.filter(([, reference]) => reference === `refs/tags/${NATIVE_BASELINE_TAG}^{}`);
    if (direct.length === 0 && peeled.length === 0) return null;
    if (direct.length !== 1 || peeled.length !== 1)
      throw new Error('Origin native baseline must be one annotated tag.');
    return requireFullSha(direct[0]![0]!, 'Remote annotated baseline object');
  };
  if (remoteObject()) {
    refresh();
    const existing = git(['rev-parse', '--verify', `refs/tags/${NATIVE_BASELINE_TAG}^{commit}`]);
    const recorded = baseline(mainSha);
    if (existing !== sourceSha || !sameNativeFingerprints(recorded, fingerprints))
      throw new Error('Native baseline already exists with a different source or fingerprint pair.');
    console.log(`${NATIVE_BASELINE_TAG} is already correct.`);
    return;
  }
  console.log(message);
  if (apply) {
    const timestamp = git(['show', '-s', '--format=%ct', sourceSha]);
    const tagObject = git(['mktag'], {
      input: [
        `object ${sourceSha}`,
        'type commit',
        `tag ${NATIVE_BASELINE_TAG}`,
        `tagger ${BOT_NAME} <${BOT_EMAIL}> ${timestamp} +0000`,
        '',
        message,
      ].join('\n'),
    });
    publishNativeBaseline(tagObject, {
      push: (objectSha) => authenticatedPush(`${objectSha}:refs/tags/${NATIVE_BASELINE_TAG}`),
      remoteObject,
    });
  }
  output({ baseline_sha: sourceSha, applied: apply });
}

function resolveSource(): void {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Native builds run from main only.');
  const mainSha = refresh();
  const sourceSha = requireFullSha(process.env.REQUESTED_SOURCE_SHA || process.env.GITHUB_SHA || '');
  if (!ancestor(sourceSha, mainSha)) throw new Error('Native source is not in current main history.');
  if (getSupersededNativeStampShas(ROOT, mainSha).includes(sourceSha))
    throw new Error('Native source was explicitly superseded by a version restoration.');
  const forced = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.FORCE_NATIVE === 'true';
  const message = git(['show', '-s', '--format=%B', sourceSha]);
  if (!nativeStampKind(message)) {
    if (forced && sourceSha === process.env.GITHUB_SHA) {
      output({ source_sha: sourceSha, eligible: true });
      return;
    }
    if (process.env.REQUESTED_SOURCE_SHA)
      throw new Error('Pinned native recovery needs a validated native release stamp.');
    output({
      source_sha: sourceSha,
      eligible: false,
      reason: 'Raw main changes wait for the native coordinator stamp.',
    });
    return;
  }
  const stamp = validateNativeStampSource(sourceSha, mainSha);
  const newest = latestStamp(mainSha);
  if (!forced && newest && newest.sha !== sourceSha && ancestor(sourceSha, newest.sha)) {
    output({
      source_sha: sourceSha,
      eligible: false,
      reason: 'A newer validated native release stamp supersedes this one.',
    });
    return;
  }
  output({ source_sha: sourceSha, eligible: true, version: stamp.version });
}

function gate(): void {
  const platform = process.env.NATIVE_PLATFORM;
  if (platform !== 'ios' && platform !== 'android') throw new Error('NATIVE_PLATFORM must be ios or android.');
  const sourceSha = requireFullSha(process.env.NATIVE_SOURCE_SHA ?? '');
  const fingerprint = requireFullSha(process.env.RESOLVED_FINGERPRINT ?? '', `${platform} fingerprint`);
  const version = readMarketingVersion(readFileSync(join(ROOT, APP_CONFIG_PATH), 'utf8'));
  const message = git(['show', '-s', '--format=%B', sourceSha]);
  const forced = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.FORCE_NATIVE === 'true';
  if (getSupersededNativeStampShas().includes(sourceSha))
    throw new Error('Native source was explicitly superseded by a version restoration.');
  const stamp = nativeStampKind(message) ? validateNativeStampSource(sourceSha) : null;
  if (stamp && (stamp.version !== version || stamp[platform] !== fingerprint))
    throw new Error('Resolved native state differs from the release stamp.');
  const exact = exactNativeBuilds(tagReferences(), platform, {
    sha: sourceSha,
    version,
    ios: fingerprint,
    android: fingerprint,
  });
  const shouldBuild = forced || exact.length === 0;
  if (shouldBuild && platform === 'ios' && allTagNames().some((tag) => tag.startsWith(`release/ios-v${version}-`)))
    throw new Error(
      `Apple already approved iOS ${version}; merge a native change or bump the marketing version before rebuilding.`,
    );
  if (!forced && exact.length === 0) {
    const workflow = NATIVE_WORKFLOWS.find((candidate) => candidate.platform === platform)!;
    const currentRunId = Number(process.env.GITHUB_RUN_ID);
    const currentAttempt = Number(process.env.GITHUB_RUN_ATTEMPT || '1');
    const earlier = buildRuns(workflow.file).filter(
      (run) => run.title === `${platform}:${sourceSha}` && (run.id !== currentRunId || currentAttempt > 1),
    );
    if (earlier.some((run) => uploadAttempted(run.id, workflow.uploadStep)))
      throw new Error(
        'An upload of this exact native source already started without a build tag. Reconcile its store receipt before rebuilding.',
      );
  }
  output({
    source_sha: sourceSha,
    fingerprint,
    should_build: shouldBuild,
    reason: shouldBuild
      ? 'Building the exact native release source.'
      : 'This exact version, source and fingerprint already uploaded.',
  });
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  switch (process.argv[2]) {
    case 'coordinate':
      coordinate(process.argv.includes('--dry-run'));
      break;
    case 'baseline':
      createBaseline(flag('--source-sha') ?? '', process.argv.includes('--apply'));
      break;
    case 'restore-version':
      restoreVersion(
        flag('--target-version') ?? '',
        flag('--expected-stamp-sha') ?? '',
        process.argv.includes('--apply'),
      );
      break;
    case 'source':
      resolveSource();
      break;
    case 'gate':
      gate();
      break;
    default:
      throw new Error('Expected coordinate, baseline, restore-version, source or gate.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    // Child-process messages may contain credential-bearing commands/URLs. Keep
    // failures actionable without echoing subprocess arguments or output.
    const message =
      error instanceof Error && !('cmd' in error) && !('status' in error)
        ? error.message
        : 'A native release command failed; inspect the preceding step and retry without another version bump.';
    console.error(`[native-release] ${message}`);
    process.exitCode = 1;
  }
}
