/// <reference types="node" />

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parsePreviewPlatform, type PreviewPlatformReceipt } from './lib/ota-preview-boot-receipt.ts';
import { isReleaseTrainActive } from './lib/mobile-release-policy.ts';

export type PreviewTarget = 'main' | 'release/next';
export interface PreviewSource {
  headSha: string;
  baseSha: string;
  baseRef: string;
  mainSha: string;
  trainSha?: string;
}
export interface PreviewCandidate {
  targetRef: PreviewTarget;
  targetSha: string;
  status: 'ready' | 'conflict' | 'failed';
  commitHash?: string;
  treeHash?: string;
  directory?: string;
  baselineDirectory?: string;
  sourceBundle?: string;
  sourceBundleSha256?: string;
  platforms: Partial<
    Record<
      'ios' | 'android',
      { status: string; fingerprint?: string; runtimeVersion?: string; receipt?: PreviewPlatformReceipt }
    >
  >;
}
const git = (directory: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
const sha = (input: string) => {
  if (!/^[0-9a-f]{40}$/.test(input)) throw new Error('Expected a pinned full commit SHA.');
  return input;
};

/** Replay the source PR's unique commits only; the source base itself never rides onto the other train. */
export function preparePreviewCandidates(
  repository: string,
  source: PreviewSource,
  scratch: string,
): PreviewCandidate[] {
  for (const commit of [source.headSha, source.baseSha, source.mainSha, ...(source.trainSha ? [source.trainSha] : [])])
    sha(commit);
  const targets: Array<{ ref: PreviewTarget; commit: string }> = [{ ref: 'main', commit: source.mainSha }];
  if (
    source.trainSha &&
    isReleaseTrainActive(
      git(repository, ['show', `${source.mainSha}:packages/mobile/app.config.ts`]),
      git(repository, ['show', `${source.trainSha}:packages/mobile/app.config.ts`]),
    )
  )
    targets.push({ ref: 'release/next', commit: source.trainSha });
  const mergeBase = git(repository, ['merge-base', source.baseSha, source.headSha]);
  const sourceTree = git(repository, ['rev-parse', `${source.headSha}^{tree}`]);
  // One synthetic commit expresses the cumulative PR delta, including adjustments
  // made only in merge commits. Its sole parent excludes the source base history.
  const synthetic = git(repository, [
    '-c',
    'user.name=Boardsesh OTA',
    '-c',
    'user.email=ota@boardsesh.com',
    'commit-tree',
    sourceTree,
    '-p',
    mergeBase,
    '-m',
    `OTA preview of PR ${source.headSha}`,
  ]);
  mkdirSync(scratch, { recursive: true });
  return targets.map(({ ref, commit }) => {
    const directory = join(scratch, ref === 'main' ? 'main' : 'train');
    git(repository, ['worktree', 'add', '--detach', directory, commit]);
    try {
      git(directory, [
        '-c',
        'user.name=Boardsesh OTA',
        '-c',
        'user.email=ota@boardsesh.com',
        '-c',
        'core.hooksPath=/dev/null',
        'cherry-pick',
        '--allow-empty',
        '--keep-redundant-commits',
        synthetic,
      ]);
    } catch (error) {
      // A conflicting aggregate patch never falls through to publish the old head.
      try {
        git(directory, ['cherry-pick', '--abort']);
      } catch {
        /* no cherry-pick in progress */
      }
      const timedOut = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ETIMEDOUT';
      if (timedOut) console.error(`::error::${ref} preview replay timed out after 30 seconds.`);
      return { targetRef: ref, targetSha: commit, status: timedOut ? 'failed' : 'conflict', platforms: {} };
    }
    return {
      targetRef: ref,
      targetSha: commit,
      status: 'ready',
      directory,
      commitHash: git(directory, ['rev-parse', 'HEAD']),
      treeHash: git(directory, ['rev-parse', 'HEAD^{tree}']),
      platforms: {},
    };
  });
}

/** A platform/runtime can serve only one candidate. The actual PR base wins ties. */
export function choosePreviewCandidates(candidates: PreviewCandidate[], baseRef: string) {
  const preferred = baseRef === 'release/next' ? 'release/next' : 'main';
  const chosen: Partial<Record<'ios' | 'android', PreviewCandidate>> = {};
  const claimed = new Set<string>();
  const selections: Array<{ candidate: PreviewCandidate; platform: 'ios' | 'android' }> = [];
  for (const candidate of [...candidates].sort(
    (left, right) => Number(right.targetRef === preferred) - Number(left.targetRef === preferred),
  )) {
    for (const platform of ['ios', 'android'] as const) {
      const result = candidate.platforms[platform];
      if (
        candidate.status !== 'ready' ||
        result?.status !== 'ota-compatible' ||
        !result.runtimeVersion ||
        !/^[0-9a-f]{40}$/.test(result.runtimeVersion)
      )
        continue;
      const identity = `${platform}:${result.runtimeVersion}`;
      if (claimed.has(identity)) {
        result.status = `shared-runtime:${preferred}`;
        continue;
      }
      claimed.add(identity);
      chosen[platform] ??= candidate;
      selections.push({ candidate, platform });
    }
  }
  return { selections, chosen };
}

export function collectCandidateReceipt(
  candidates: PreviewCandidate[],
  source: PreviewSource,
  metadata: {
    branch: string;
    runId: number;
    deploymentId: number;
  },
) {
  const preferred = source.baseRef === 'release/next' ? 'release/next' : 'main';
  const platforms: Record<string, unknown> = {};
  for (const candidate of [...candidates].sort(
    (left, right) => Number(left.targetRef === preferred) - Number(right.targetRef === preferred),
  )) {
    for (const platform of ['ios', 'android'] as const) {
      const receipt = candidate.platforms[platform]?.receipt;
      if (!receipt) continue;
      if (receipt.commitHash !== candidate.commitHash || receipt.branch !== metadata.branch)
        throw new Error('Candidate receipt does not match the generated commit/branch.');
      platforms[platform] = {
        ...receipt,
        candidateCommit: candidate.commitHash,
        candidateTree: candidate.treeHash,
        targetRef: candidate.targetRef,
        targetSha: candidate.targetSha,
        sourceBundle: candidate.sourceBundle,
        sourceBundleSha256: candidate.sourceBundleSha256,
      };
    }
  }
  return {
    version: 2,
    commitHash: source.headSha,
    sourceBaseSha: source.baseSha,
    sourceBaseRef: source.baseRef,
    branch: metadata.branch,
    previewRunId: metadata.runId,
    deploymentId: metadata.deploymentId,
    sourceArtifact: 'mobile-ota-preview-source',
    platforms,
    candidates: candidates.map(
      ({ directory: _directory, baselineDirectory: _baselineDirectory, ...candidate }) => candidate,
    ),
  };
}

export type RuntimeRunner = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string }>;
const execFileAsync: RuntimeRunner = (file, args, options) => {
  const pending = promisify(execFile)(file, args, options);
  pending.child.stdin?.end();
  return pending;
};

/** Compare full stable hashes under the actual publisher environment, not display hashes. */
export async function resolvePreviewRuntime(
  directory: string,
  platform: 'ios' | 'android',
  env: NodeJS.ProcessEnv,
  runner: RuntimeRunner = execFileAsync,
): Promise<string | null> {
  const runtimeEnv = { ...env };
  delete runtimeEnv.EOO_TOKEN;
  delete runtimeEnv.EXPO_UPDATES_FINGERPRINT_OVERRIDE;
  delete runtimeEnv.OTA_EXPECT_RUNTIME_VERSION;
  if (platform === 'ios') delete runtimeEnv.GOOGLE_MAPS_API_KEY;
  try {
    const hashes: Array<string | null> = [];
    // Two sequential resolutions of the same tree must agree; concurrency lives across trees.
    for (const _attempt of [0, 1]) {
      const { stdout } = await runner(
        'vp',
        ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform],
        {
          cwd: join(directory, 'packages/mobile'),
          env: runtimeEnv,
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      hashes.push(/\b[0-9a-f]{40}\b/.exec(String(stdout))?.[0] ?? null);
    }
    return hashes[0] && hashes[0] === hashes[1] ? hashes[0] : null;
  } catch {
    return null;
  }
}

function command(directory: string, binary: string, args: string[], env = process.env) {
  execFileSync(binary, args, { cwd: directory, env, stdio: 'inherit', timeout: 90 * 60_000 });
}
function outputs(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export async function runPreviewCandidates(
  repository: string,
  source: PreviewSource,
  scratch: string,
  out: string,
  phase: string,
  runCommand = command,
  runtimeResolver: (
    directory: string,
    platform: 'ios' | 'android',
    env: NodeJS.ProcessEnv,
  ) => Promise<string | null> = resolvePreviewRuntime,
) {
  const tooling = resolve(import.meta.dirname, '..');
  const planPath = join(scratch, 'candidates.json');
  const candidates: PreviewCandidate[] =
    phase === 'prepare'
      ? preparePreviewCandidates(repository, source, join(scratch, 'candidates'))
      : (JSON.parse(readFileSync(planPath, 'utf8')) as PreviewCandidate[]);
  const branch = process.env.BRANCH ?? '';
  if (!/^pr-[1-9][0-9]*$/.test(branch)) throw new Error('Refusing non-preview branch.');
  mkdirSync(out, { recursive: true });
  let failed = false;
  for (const candidate of phase === 'prepare' ? candidates : []) {
    if (!candidate.directory) continue;
    const directory = candidate.directory;
    try {
      const baseline = join(scratch, candidate.targetRef === 'main' ? 'baseline-main' : 'baseline-train');
      git(repository, ['worktree', 'add', '--detach', baseline, candidate.targetSha]);
      candidate.baselineDirectory = baseline;
      runCommand(directory, 'vp', ['install', '--frozen-lockfile']);
      runCommand(baseline, 'vp', ['install', '--frozen-lockfile']);
      const comparison = join(scratch, `${candidate.targetRef === 'main' ? 'main' : 'train'}-compat.txt`);
      const compatibilityEnv: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: comparison };
      // Do not feed the maps key into the relative comparison; each side is resolved
      // with identical public env. The actual Android publisher alone gets its key.
      delete compatibilityEnv.GOOGLE_MAPS_API_KEY;
      delete compatibilityEnv.EOO_TOKEN;
      runCommand(
        tooling,
        process.execPath,
        [
          '--experimental-strip-types',
          join(tooling, 'scripts/mobile-ota-compat-check.ts'),
          '--write-env',
          '--pr-dir',
          directory,
          '--base-dir',
          baseline,
          '--base-branch',
          candidate.targetRef,
        ],
        compatibilityEnv,
      );
      const comparisonOutputs = outputs(comparison);
      const pin = (path: string) =>
        readFileSync(join(path, 'scripts/lib/eoas.ts'), 'utf8').match(/EOAS_PACKAGE_SPEC\s*=\s*['"]([^'"]+)['"]/)?.[1];
      // The production server follows MAIN, even when a candidate targets the train.
      const serverPin = git(repository, ['show', `${source.mainSha}:scripts/lib/eoas.ts`]).match(
        /EOAS_PACKAGE_SPEC\s*=\s*['"]([^'"]+)['"]/,
      )?.[1];
      for (const platform of ['ios', 'android'] as const) {
        candidate.platforms[platform] = {
          status:
            !pin(directory) || !serverPin || pin(directory) !== serverPin
              ? 'server-upgrade'
              : (comparisonOutputs[`verdict_${platform}`] ?? 'unknown'),
          fingerprint: comparisonOutputs[`fingerprint_${platform}`],
        };
      }
      const sourceBundle = `${candidate.targetRef === 'main' ? 'main' : 'train'}.bundle`;
      const exclusions =
        candidate.commitHash !== candidate.targetSha
          ? [candidate.targetSha]
          : git(directory, ['rev-list', '--parents', '-n', '1', candidate.targetSha]).split(' ').slice(1);
      git(directory, [
        'bundle',
        'create',
        join(out, sourceBundle),
        'HEAD',
        ...exclusions.map((commit) => `^${commit}`),
      ]);
      candidate.sourceBundle = sourceBundle;
      candidate.sourceBundleSha256 = createHash('sha256')
        .update(readFileSync(join(out, sourceBundle)))
        .digest('hex');
    } catch {
      console.error(`::error::${candidate.targetRef} preview preparation failed; continuing the other target.`);
      candidate.status = 'failed';
    }
  }
  if (phase === 'prepare') {
    writeFileSync(planPath, JSON.stringify(candidates));
    return;
  }
  failed = candidates.some((candidate) => candidate.status === 'failed');
  type RuntimeCheck = {
    result: { status: string; runtimeVersion?: string };
    trees: [string, string];
    platform: 'ios' | 'android';
  };
  const verdict = ({ result }: RuntimeCheck, runtime: string | null, baseline: string | null) => {
    if (!runtime || !baseline) {
      result.status = 'runtime-unresolved';
      failed = true;
    } else if (runtime !== baseline) result.status = 'native-change-required';
    else result.runtimeVersion = runtime;
  };
  const checks: RuntimeCheck[] = candidates.flatMap((candidate) => {
    const { directory, baselineDirectory } = candidate;
    if (candidate.status !== 'ready' || !directory || !baselineDirectory) return [];
    return (['ios', 'android'] as const).flatMap((platform) => {
      const result = candidate.platforms[platform];
      return result?.status === 'ota-compatible' ? [{ result, trees: [directory, baselineDirectory], platform }] : [];
    });
  });
  // Every candidate/baseline tree resolves at once; publishes below stay ordered.
  const resolved = await Promise.all(
    checks.map((check) => Promise.all(check.trees.map((tree) => runtimeResolver(tree, check.platform, process.env)))),
  );
  for (const [index, check] of checks.entries()) {
    const [runtime, baseline] = resolved[index]!;
    if (!runtime || !baseline || runtime === baseline) {
      verdict(check, runtime, baseline);
      continue;
    }
    // @expo/fingerprint drops a source it fails to read instead of throwing, so
    // a mismatch under contention is confirmed one tree at a time before skipping.
    const serialRuntime = await runtimeResolver(check.trees[0], check.platform, process.env);
    const serialBaseline = await runtimeResolver(check.trees[1], check.platform, process.env);
    verdict(check, serialRuntime, serialBaseline);
  }
  const { selections } = choosePreviewCandidates(candidates, source.baseRef);
  for (const { candidate, platform } of selections) {
    const receiptPath = join(scratch, `${candidate.targetRef === 'main' ? 'main' : 'train'}-${platform}.json`);
    const publishEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OTA_PREVIEW_RECEIPT_PATH: receiptPath,
      OTA_EXPECT_RUNTIME_VERSION: candidate.platforms[platform]!.runtimeVersion,
    };
    if (platform === 'ios') delete publishEnv.GOOGLE_MAPS_API_KEY;
    try {
      runCommand(
        candidate.directory!,
        'vp',
        ['run', 'mobile:publish', '--', '--channel', branch, '--platform', platform],
        publishEnv,
      );
      candidate.platforms[platform]!.receipt = parsePreviewPlatform(
        JSON.parse(readFileSync(receiptPath, 'utf8')),
        platform,
      );
      if (candidate.platforms[platform]!.receipt!.runtimeVersion !== candidate.platforms[platform]!.runtimeVersion)
        throw new Error('Published preview runtime differs from authorized candidate.');
      candidate.platforms[platform]!.status = 'published';
    } catch {
      delete candidate.platforms[platform]!.receipt;
      candidate.platforms[platform]!.status = 'failed';
      failed = true;
    }
  }
  const receipt = collectCandidateReceipt(candidates, source, {
    branch,
    runId: Number(process.env.GITHUB_RUN_ID),
    deploymentId: Number(process.env.DEPLOYMENT_ID),
  });
  writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `published=${Object.keys(receipt.platforms).length > 0}\nfailed=${failed}\nsummary=${JSON.stringify(candidates.map(({ targetRef, targetSha, status, platforms }) => ({ targetRef, targetSha, status, platforms })))}\n`,
    );
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, repository, scratch, out] = process.argv.slice(2);
  if (!['prepare', 'publish'].includes(phase)) throw new Error('Expected prepare or publish.');
  if (!repository || !scratch || !out) throw new Error('Expected repository, scratch and output directory.');
  const source: PreviewSource = {
    headSha: process.env.HEAD_SHA ?? '',
    baseSha: process.env.SOURCE_BASE_SHA ?? '',
    baseRef: process.env.SOURCE_BASE_REF ?? 'main',
    mainSha: process.env.MAIN_SHA ?? '',
    trainSha: process.env.TRAIN_SHA || undefined,
  };
  if (existsSync(join(out, 'receipt.json'))) throw new Error('Refusing to reuse a previous preview receipt.');
  await runPreviewCandidates(repository, source, scratch, out, phase);
}
