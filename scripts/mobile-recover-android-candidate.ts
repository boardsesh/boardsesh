/// <reference types="node" />

/** Publish metadata for an Android binary already accepted by Play. Never uploads a binary to Play. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuditAccessToken, readProductionReleaseSummaries } from './mobile-store-android-audit';
import { trackSummaries } from './lib/google-play-tracks';
import { formatBuildTag } from './lib/release-tags';

const PACKAGE = 'com.boardsesh.app';
const APK_NAME = 'boardsesh-android-beta-arm64-v8a.apk';
const FULL_SHA = /^[0-9a-f]{40}$/;

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid recovery evidence.');
  return input as Record<string, unknown>;
}

export function validateRecoveryRun(
  input: unknown,
  jobs: unknown,
  repository: string,
  runId: string,
  sourceSha: string,
) {
  const run = record(input);
  if (
    !/^[1-9]\d*$/.test(runId) ||
    !FULL_SHA.test(sourceSha) ||
    String(run.id) !== runId ||
    run.path !== '.github/workflows/android-apk-rn.yml' ||
    run.head_branch !== 'main' ||
    record(run.head_repository).full_name !== repository ||
    run.head_sha !== sourceSha ||
    run.display_title !== `android:${sourceSha}` ||
    !['push', 'workflow_dispatch'].includes(String(run.event)) ||
    run.status !== 'completed' ||
    !Number.isSafeInteger(run.run_number) ||
    Number(run.run_number) < 1
  )
    throw new Error('Recovery requires the exact completed Android main run and its source SHA.');
  if (!Array.isArray(jobs)) throw new Error('Missing Android upload jobs.');
  const uploads = jobs.map(record).filter((job) => job.name === 'build-and-release' && job.conclusion === 'success');
  if (
    !uploads.some(
      (job) =>
        Array.isArray(job.steps) &&
        job.steps
          .map(record)
          .some(
            (step) => step.name === 'Upload AAB to Play internal and open beta tracks' && step.conclusion === 'success',
          ),
    )
  )
    throw new Error('The original Android build and Play upload must have succeeded.');
  return {
    sourceRunId: runId,
    sourceSha,
    runNumber: String(run.run_number),
    artifactName: `boardsesh-rn-android-${String(run.run_number)}`,
  };
}

export function validateApkIdentity(
  input: { applicationId: string; versionCode: string; version: string; runtime: string },
  expectedCode: string,
) {
  const identity = Object.fromEntries(
    Object.entries(input).map(([key, contents]) => [key, contents.trim().replace(/^"|"$/g, '')]),
  ) as typeof input;
  if (
    identity.applicationId !== PACKAGE ||
    !/^[1-9]\d*$/.test(expectedCode) ||
    !Number.isSafeInteger(Number(expectedCode)) ||
    identity.versionCode !== expectedCode ||
    !/^\d+\.\d+\.\d+$/.test(identity.version) ||
    !FULL_SHA.test(identity.runtime)
  )
    throw new Error('The retained APK package, versionCode, marketing version or full runtime is invalid.');
  return identity;
}

export function validateRecoveryGateLog(log: string, sourceSha: string): string {
  const sources = [...log.matchAll(/^\S+ source_sha=([0-9a-f]{40})\r?$/gm)].map((match) => match[1]);
  const runtimes = [...log.matchAll(/^\S+ fingerprint=([0-9a-f]{40})\r?$/gm)].map((match) => match[1]);
  if (
    !sources.length ||
    sources.some((source) => source !== sourceSha) ||
    runtimes.length !== 1 ||
    !/^\S+ should_build=true\r?$/m.test(log)
  )
    throw new Error('Original native gate does not confirm this exact source and runtime.');
  return runtimes[0]!;
}

export function requireReviewedPlayBuild(input: unknown, track: 'internal' | 'beta', versionCode: string): void {
  const matches = trackSummaries(input, track).filter((release) =>
    release.activeArtifacts.some((artifact) => String(artifact.versionCode) === versionCode),
  );
  const accepted =
    track === 'internal'
      ? ['RELEASE_LIFECYCLE_STATE_PUBLISHED']
      : [
          'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
          'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
          'RELEASE_LIFECYCLE_STATE_PUBLISHED',
        ];
  if (matches.length !== 1 || !accepted.includes(matches[0]!.releaseLifecycleState))
    throw new Error(`Play ${track} does not confirm this exact submitted build.`);
}

export function missingRecoveryTags(tags: Readonly<Record<string, string | null>>, sourceSha: string): string[] {
  for (const target of Object.values(tags))
    if (target !== null && target !== sourceSha)
      throw new Error('An existing immutable recovery tag points to another source; refusing overwrite.');
  return Object.keys(tags).filter((tag) => tags[tag] === null);
}

export function recoveryCommandFailure(operation: string, error: unknown): Error {
  const details: string[] = [];
  if (typeof error === 'object' && error !== null) {
    const failure = error as Record<string, unknown>;
    if (
      typeof failure.status === 'number' &&
      Number.isInteger(failure.status) &&
      failure.status >= 0 &&
      failure.status <= 255
    )
      details.push(`exit ${failure.status}`);
    const stderr =
      typeof failure.stderr === 'string'
        ? failure.stderr
        : Buffer.isBuffer(failure.stderr)
          ? failure.stderr.toString('utf8')
          : '';
    const http = stderr.match(/\bHTTP[ :]+([1-5]\d{2})\b/i)?.[1];
    if (http) details.push(`HTTP ${http}`);
    if (/^gh:\s*(?:API rate limit exceeded|You have exceeded a secondary rate limit)\b/im.test(stderr))
      details.push('reason rate-limit');
    else if (/^gh:\s*Resource not accessible by (?:integration|personal access token)\b/im.test(stderr))
      details.push('reason access-denied');
    else if (/^gh:\s*Not Found\b/im.test(stderr)) details.push('reason not-found');
    else if (/^(?:unknown flag:|the `--slurp` option is not supported\b)/im.test(stderr))
      details.push('reason unsupported-option');
    if (
      typeof failure.code === 'string' &&
      ['ENOENT', 'ENOBUFS', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE'].includes(failure.code)
    )
      details.push(failure.code);
    if (typeof failure.signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(failure.signal))
      details.push(failure.signal);
  }
  return new Error(`Android recovery command failed (${operation}${details.length ? `; ${details.join('; ')}` : ''}).`);
}

function execute(
  binary: string,
  args: string[],
  environment = process.env,
  operation = `${binary} ${args[0]}`,
): string {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error: unknown) {
    throw recoveryCommandFailure(operation, error);
  }
}
const required = (name: string) => {
  const configured = process.env[name];
  if (!configured?.trim()) throw new Error(`Missing recovery input: ${name}.`);
  return configured;
};
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, contents: unknown) => writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
function output(fields: Record<string, string>): void {
  const rendered = Object.entries(fields)
    .map(([key, contents]) => `${key}=${contents}`)
    .join('\n');
  console.log(rendered);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${rendered}\n`);
}

async function main(): Promise<void> {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Android candidate recovery runs on main only.');
  const repository = required('GITHUB_REPOSITORY');
  if (repository !== 'boardsesh/boardsesh') throw new Error('Recovery requires the Boardsesh repository.');
  const receiptPath = join(required('RUNNER_TEMP'), 'android-candidate-recovery.json');
  const [phase] = process.argv.slice(2);
  if (phase === 'resolve') {
    const runId = required('SOURCE_RUN_ID');
    const sourceSha = required('EXPECTED_SOURCE_SHA');
    if (!/^[1-9]\d*$/.test(runId) || !FULL_SHA.test(sourceSha)) throw new Error('Invalid recovery run or source SHA.');
    const run = JSON.parse(
      execute('gh', ['api', `repos/${repository}/actions/runs/${runId}`], process.env, 'read original native run'),
    ) as unknown;
    const pages = JSON.parse(
      execute(
        'gh',
        ['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`],
        process.env,
        'read original native jobs',
      ),
    ) as Array<{ jobs: unknown[] }>;
    const source = validateRecoveryRun(
      run,
      pages.flatMap((page) => page.jobs),
      repository,
      runId,
      sourceSha,
    );
    const gate = pages
      .flatMap((page) => page.jobs)
      .map(record)
      .find((job) => job.name === 'gate' && job.conclusion === 'success');
    if (!gate || !Number.isSafeInteger(gate.id)) throw new Error('Missing original successful native gate.');
    const expectedRuntime = validateRecoveryGateLog(
      execute(
        'gh',
        ['api', `repos/${repository}/actions/jobs/${String(gate.id)}/logs`],
        process.env,
        'read original native gate logs',
      ),
      sourceSha,
    );
    execute('git', ['fetch', '--quiet', '--no-tags', 'origin', 'main:refs/remotes/origin/main']);
    execute('git', ['merge-base', '--is-ancestor', sourceSha, 'refs/remotes/origin/main']);
    save(receiptPath, { ...source, expectedRuntime });
    output({ artifact_name: source.artifactName });
    return;
  }
  const source = record(json(receiptPath));
  const apk = join(required('RUNNER_TEMP'), 'android-recovery-apk', APK_NAME);
  if (phase === 'verify') {
    const analyzer = join(required('ANDROID_HOME'), 'cmdline-tools', 'latest', 'bin', 'apkanalyzer');
    const identity = validateApkIdentity(
      {
        applicationId: execute(analyzer, ['manifest', 'application-id', apk]),
        versionCode: execute(analyzer, ['manifest', 'version-code', apk]),
        version: execute(analyzer, ['manifest', 'version-name', apk]),
        runtime: execute(analyzer, [
          'resources',
          'value',
          '--config',
          'default',
          '--name',
          'expo_runtime_version',
          '--type',
          'string',
          '--package',
          PACKAGE,
          apk,
        ]),
      },
      required('EXPECTED_VERSION_CODE'),
    );
    if (identity.runtime !== source.expectedRuntime)
      throw new Error('APK runtime differs from its original native gate.');
    const token = await createAuditAccessToken(required('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'));
    const states: Record<string, unknown> = {};
    for (const track of ['internal', 'beta'] as const) {
      const evidence = await readProductionReleaseSummaries(token, track);
      requireReviewedPlayBuild(evidence, track, identity.versionCode);
      states[track] = trackSummaries(evidence, track);
    }
    const apkSha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');
    const buildTag = formatBuildTag(
      'android',
      identity.version,
      Number(identity.versionCode),
      identity.runtime.slice(0, 12),
    );
    save(receiptPath, {
      ...source,
      ...identity,
      apkSha256,
      buildTag,
      checkedAt: new Date().toISOString(),
      play: states,
    });
    output({
      version_code: identity.versionCode,
      version: identity.version,
      runtime: identity.runtime,
      build_tag: buildTag,
    });
    return;
  }
  if (phase !== 'publish') throw new Error('Recovery phase must be resolve, verify or publish.');
  const { sourceSha, buildTag, runtime, apkSha256, version, versionCode } = source;
  if (
    typeof sourceSha !== 'string' ||
    !FULL_SHA.test(sourceSha) ||
    typeof runtime !== 'string' ||
    !FULL_SHA.test(runtime) ||
    typeof buildTag !== 'string' ||
    typeof version !== 'string' ||
    typeof versionCode !== 'string' ||
    buildTag !== formatBuildTag('android', version, Number(versionCode), runtime.slice(0, 12)) ||
    createHash('sha256').update(readFileSync(apk)).digest('hex') !== apkSha256
  )
    throw new Error('Verified recovery receipt no longer matches its retained APK.');
  const tags = [buildTag, `fingerprint-android-${runtime}`];
  const remote = `https://github.com/${repository}.git`;
  const readTags = () =>
    Object.fromEntries(
      tags.map((tag) => {
        const target = execute('git', ['ls-remote', '--refs', remote, `refs/tags/${tag}`]);
        return [tag, target ? target.split(/\s/)[0]! : null];
      }),
    );
  const missing = missingRecoveryTags(readTags(), sourceSha);
  if (missing.length) {
    for (const tag of missing) execute('git', ['tag', tag, sourceSha]);
    const environment = {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${required('GH_APP_TOKEN')}`).toString('base64')}`,
    };
    try {
      execute('git', ['push', '--atomic', remote, ...missing.map((tag) => `refs/tags/${tag}`)], environment);
    } catch {
      if (missingRecoveryTags(readTags(), sourceSha).length)
        throw new Error('Recovery tags were not published; no store upload was attempted.');
    }
  }
  if (missingRecoveryTags(readTags(), sourceSha).length) throw new Error('Recovery tag readback failed.');
  const releaseEnvironment = { ...process.env, GH_TOKEN: required('GH_APP_TOKEN') };
  let release: { isDraft: boolean; assets: Array<{ name: string }> } | null = null;
  try {
    release = JSON.parse(
      execute(
        'gh',
        ['release', 'view', buildTag, '--repo', repository, '--json', 'isDraft,assets'],
        releaseEnvironment,
      ),
    );
  } catch {
    /* Missing release is created as a draft below. */
  }
  if (!release)
    execute(
      'gh',
      [
        'release',
        'create',
        buildTag,
        apk,
        '--repo',
        repository,
        '--verify-tag',
        '--draft',
        '--prerelease',
        '--title',
        `Boardsesh Android Beta v${version} (${versionCode})`,
        '--notes',
        `Recovered the existing Play-uploaded APK from native run ${String(source.sourceRunId)}. No rebuild or Play upload. Source: ${sourceSha}; SHA-256: ${apkSha256}.`,
      ],
      releaseEnvironment,
    );
  else if (!release.assets.some((asset) => asset.name === APK_NAME)) {
    if (!release.isDraft) throw new Error('Existing public release is missing its APK; refusing to alter it.');
    execute('gh', ['release', 'upload', buildTag, apk, '--repo', repository], releaseEnvironment);
  }
  const readback = join(required('RUNNER_TEMP'), 'android-recovery-readback');
  mkdirSync(readback, { recursive: true });
  const publishedApk = join(readback, APK_NAME);
  if (existsSync(publishedApk)) throw new Error('Recovery download directory was already used.');
  execute(
    'gh',
    ['release', 'download', buildTag, '--repo', repository, '--pattern', APK_NAME, '--dir', readback],
    releaseEnvironment,
  );
  if (createHash('sha256').update(readFileSync(publishedApk)).digest('hex') !== apkSha256)
    throw new Error('Recovered release APK readback differs; leaving draft unchanged.');
  if (!release || release.isDraft)
    execute(
      'gh',
      ['release', 'edit', buildTag, '--repo', repository, '--draft=false', '--prerelease'],
      releaseEnvironment,
    );
  save(join(required('RUNNER_TEMP'), 'native-build-source.json'), {
    schemaVersion: 1,
    platform: 'android',
    sourceSha,
    workflowSha: required('GITHUB_SHA'),
    sourceRunId: required('GITHUB_RUN_ID'),
    originalSourceRunId: source.sourceRunId,
    version,
    buildNumber: versionCode,
    buildTag,
  });
  console.log(`Recovered Android ${version} (${versionCode}); existing Play submission retained.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Android candidate recovery failed.');
    process.exitCode = 1;
  });
