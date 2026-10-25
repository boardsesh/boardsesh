import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../testflight-build';
import {
  parseTestflightBuildReceipt,
  previousNativeBuild,
  trustedTestflightRun,
  validateReceiptSource,
} from '../lib/testflight-build';

const sourceSha = 'a'.repeat(40);
const previousSha = 'b'.repeat(40);
const fingerprint = 'abcdef123456';
const tag = (version: string, build: number) => `build-ios-v${version}-${build}-${fingerprint}`;
const receipt = () => ({
  version: '2.7.0',
  buildNumber: '2',
  sourceSha,
  sourceRef: 'release/next',
  sourceRunId: '123',
  buildTag: tag('2.7.0', 2),
  previousBuildTag: tag('2.7.0', 1),
  previousBuildSha: previousSha,
});
const sourceRun = () => ({
  id: 123,
  run_attempt: 2,
  path: '.github/workflows/ios-testflight-rn.yml',
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  head_repository: { full_name: 'boardsesh/boardsesh' },
  head_branch: 'release/next',
  head_sha: sourceSha,
});

describe('frozen previous native build', () => {
  it('finds the closest ancestor, excluding unrelated branches and Android tags', () => {
    const olderSha = 'c'.repeat(40);
    expect(
      previousNativeBuild(
        [
          { name: tag('2.6.0', 100), sha: olderSha },
          { name: tag('2.7.0', 1), sha: previousSha },
          { name: tag('2.7.0', 99), sha: 'd'.repeat(40) },
          { name: `build-android-v2.7.0-12-${fingerprint}`, sha: sourceSha },
        ],
        [sourceSha, previousSha, olderSha],
        '2.7.0',
        '2',
      ),
    ).toEqual({ name: tag('2.7.0', 1), sha: previousSha });
  });

  it('handles version bumps that reset build numbers', () => {
    expect(
      previousNativeBuild([{ name: tag('2.6.0', 18), sha: previousSha }], [sourceSha, previousSha], '2.7.0', '1')?.name,
    ).toBe(tag('2.6.0', 18));
  });

  it('uses an earlier same-commit rebuild but never the current or a newer build', () => {
    expect(
      previousNativeBuild(
        [1, 2, 3, 4].map((build) => ({ name: tag('2.7.0', build), sha: sourceSha })),
        [sourceSha],
        '2.7.0',
        '3',
      )?.name,
    ).toBe(tag('2.7.0', 2));
  });

  it('retains an explicit missing baseline instead of fabricating history', () => {
    expect(previousNativeBuild([], [sourceSha], '2.7.0', '1')).toBeNull();
    expect(parseTestflightBuildReceipt({ ...receipt(), previousBuildTag: null, previousBuildSha: null })).toMatchObject(
      {
        previousBuildTag: null,
        previousBuildSha: null,
      },
    );
  });
});

describe('receipt and source provenance', () => {
  it('rejects misspelled CLI flags before reading history or GitHub', () => {
    expect(() => main(['validate', '--run-id', '123', '--reciept', 'receipt.json'])).toThrow(
      'Invalid argument --reciept',
    );
  });

  it('binds the exact build and trusted source run', () => {
    const parsed = parseTestflightBuildReceipt(receipt());
    const run = trustedTestflightRun(sourceRun(), 'boardsesh/boardsesh');
    expect(() => validateReceiptSource(parsed, run)).not.toThrow();
    expect(() => validateReceiptSource(parsed, { ...run, id: '124' })).toThrow('does not belong');
    expect(() => validateReceiptSource(parsed, { ...run, sha: previousSha })).toThrow('does not belong');
  });

  it.each([
    { version: '2.8.0' },
    { buildNumber: '3' },
    { sourceSha: 'main' },
    { sourceRef: 'feature/untrusted' },
    { sourceRunId: '../123' },
    { previousBuildSha: null },
    { previousBuildTag: undefined },
    { previousBuildTag: tag('2.7.0', 2) },
  ])('rejects mismatched or malformed receipt fields: %j', (patch) => {
    expect(() => parseTestflightBuildReceipt({ ...receipt(), ...patch })).toThrow();
  });

  it.each([
    { path: '.github/workflows/ci.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_branch: 'feature/untrusted' },
    { head_repository: { full_name: 'fork/boardsesh' } },
    { head_sha: 'main' },
  ])('rejects untrusted or unsuccessful source runs: %j', (patch) => {
    expect(() => trustedTestflightRun({ ...sourceRun(), ...patch }, 'boardsesh/boardsesh')).toThrow();
  });
});

describe('capture CLI', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('freezes the baseline in an actual git history before a new build tag exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-build-'));
    directories.push(directory);
    const git = (...argumentsList: string[]) =>
      execFileSync('git', argumentsList, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'old native');
    const previous = git('rev-parse', 'HEAD');
    git('tag', tag('2.6.0', 18));
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'new native');
    const current = git('rev-parse', 'HEAD');
    const outputPath = join(directory, 'receipt.json');
    execFileSync(
      process.execPath,
      [
        '--import',
        resolve('node_modules/tsx/dist/loader.mjs'),
        resolve('scripts/testflight-build.ts'),
        'capture',
        '--output',
        outputPath,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          BOARDSESH_MOBILE_VERSION: '2.7.0',
          IOS_BUILD_NUMBER: '1',
          GITHUB_SHA: current,
          GITHUB_REF_NAME: 'release/next',
          GITHUB_RUN_ID: '123',
          FINGERPRINT_IOS: fingerprint,
        },
      },
    );
    git('tag', tag('2.7.0', 1));
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      version: '2.7.0',
      buildNumber: '1',
      sourceSha: current,
      previousBuildTag: tag('2.6.0', 18),
      previousBuildSha: previous,
    });
  });
});

describe('source run resolution CLI', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function resolveRun(
    artifacts: unknown[],
    buildConclusion = 'success',
    runPatch: Record<string, unknown> = {},
    attempt = '',
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-source-'));
    directories.push(directory);
    const executable = join(directory, 'gh');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const responses = JSON.parse(process.env.TESTFLIGHT_GH_FIXTURE);
const endpoint = process.argv.at(-1);
if (!(endpoint in responses)) process.exit(1);
process.stdout.write(JSON.stringify(responses[endpoint]));
`,
    );
    chmodSync(executable, 0o755);
    const outputPath = join(directory, 'outputs');
    writeFileSync(outputPath, '');
    const responses = {
      '/repos/boardsesh/boardsesh/actions/runs/123': { ...sourceRun(), ...runPatch },
      '/repos/boardsesh/boardsesh/actions/runs/123/attempts/1': { ...sourceRun(), run_attempt: 1, ...runPatch },
      '/repos/boardsesh/boardsesh/actions/runs/123/artifacts?per_page=100': [{ artifacts }],
      '/repos/boardsesh/boardsesh/actions/runs/123/attempts/2/jobs?per_page=100': {
        jobs: [{ name: 'build-and-upload', conclusion: buildConclusion }],
      },
    };
    const execute = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          resolve('scripts/testflight-build.ts'),
          'resolve',
          '--run-id',
          '123',
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'boardsesh/boardsesh',
            GITHUB_OUTPUT: outputPath,
            SOURCE_RUN_ATTEMPT: attempt,
            TESTFLIGHT_GH_FIXTURE: JSON.stringify(responses),
          },
        },
      );
    return { execute, outputs: () => readFileSync(outputPath, 'utf8') };
  }

  it('selects only the current successful attempt’s exact receipt', () => {
    const resolved = resolveRun([
      { id: 9, name: 'ios-testflight-build-1', expired: false },
      { id: 10, name: 'ios-testflight-build-2', expired: false },
    ]);
    resolved.execute();
    expect(resolved.outputs()).toContain('artifact_id=10\n');
    expect(resolved.outputs()).toContain('source_run_id=123\n');
  });

  it('quietly skips a fingerprint-gated run with no upload', () => {
    const resolved = resolveRun([], 'skipped');
    expect(resolved.execute()).toContain('Native gate skipped');
    expect(resolved.outputs()).toBe('should_distribute=false\n');
  });

  it('pins an automatic event’s successful attempt even after the native run was retried', () => {
    const resolved = resolveRun(
      [
        { id: 9, name: 'ios-testflight-build-1', expired: false },
        { id: 10, name: 'ios-testflight-build-2', expired: false },
      ],
      'success',
      {},
      '1',
    );
    resolved.execute();
    expect(resolved.outputs()).toContain('artifact_id=9\n');
    expect(resolved.outputs()).toContain('source_run_attempt=1\n');
  });

  it('fails missing or expired receipts after a successful upload', () => {
    for (const artifacts of [[], [{ id: 10, name: 'ios-testflight-build-2', expired: true }]]) {
      const resolved = resolveRun(artifacts);
      expect(resolved.execute).toThrow();
      expect(resolved.outputs()).toBe('');
    }
  });

  it('refuses fork runs before emitting any artifact output', () => {
    const resolved = resolveRun([{ id: 10, name: 'ios-testflight-build-2', expired: false }], 'success', {
      head_repository: { full_name: 'untrusted/boardsesh' },
    });
    expect(resolved.execute).toThrow();
    expect(resolved.outputs()).toBe('');
  });
});

describe('validate CLI against git tags', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function validationFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-validate-'));
    directories.push(directory);
    const git = (...argumentsList: string[]) =>
      execFileSync('git', argumentsList, { cwd: directory, encoding: 'utf8' }).trim();
    const commit = (message: string) =>
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', message);
    git('init', '--quiet');
    commit('baseline');
    const baselineSha = git('rev-parse', 'HEAD');
    git('tag', tag('2.7.0', 1));
    commit('uploaded native build');
    const uploadedSha = git('rev-parse', 'HEAD');
    git('tag', tag('2.7.0', 2));
    const receiptPath = join(directory, 'receipt.json');
    const outputPath = join(directory, 'outputs');
    const buildReceipt = { ...receipt(), sourceSha: uploadedSha, previousBuildSha: baselineSha };
    writeFileSync(receiptPath, JSON.stringify(buildReceipt));
    writeFileSync(outputPath, '');
    writeFileSync(
      join(directory, 'gh'),
      `#!/usr/bin/env node
if (process.argv.at(-1) !== '/repos/boardsesh/boardsesh/actions/runs/123/attempts/2') process.exit(1);
process.stdout.write(process.env.TESTFLIGHT_GH_FIXTURE);
`,
    );
    chmodSync(join(directory, 'gh'), 0o755);
    const execute = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          resolve('scripts/testflight-build.ts'),
          'validate',
          '--run-id',
          '123',
          '--receipt',
          receiptPath,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'boardsesh/boardsesh',
            GITHUB_OUTPUT: outputPath,
            SOURCE_RUN_ATTEMPT: '2',
            TESTFLIGHT_GH_FIXTURE: JSON.stringify({ ...sourceRun(), head_sha: uploadedSha }),
          },
        },
      );
    return {
      git,
      commit,
      buildReceipt,
      receiptPath,
      baselineSha,
      uploadedSha,
      execute,
      outputs: () => readFileSync(outputPath, 'utf8'),
    };
  }

  it('emits the exact uploaded version and build only after verifying both tags', () => {
    const fixture = validationFixture();
    fixture.execute();
    expect(fixture.outputs()).toBe('version=2.7.0\nbuild_number=2\n');
  });

  it.each(['moved uploaded tag', 'deleted uploaded tag', 'moved baseline tag', 'non-ancestor baseline'])(
    'refuses a %s without emitting build outputs',
    (mutation) => {
      const fixture = validationFixture();
      if (mutation === 'moved uploaded tag') fixture.git('tag', '--force', tag('2.7.0', 2), fixture.baselineSha);
      if (mutation === 'deleted uploaded tag') fixture.git('tag', '--delete', tag('2.7.0', 2));
      if (mutation === 'moved baseline tag') fixture.git('tag', '--force', tag('2.7.0', 1), fixture.uploadedSha);
      if (mutation === 'non-ancestor baseline') {
        fixture.git('checkout', '--quiet', '--orphan', 'unrelated-native');
        fixture.commit('unrelated baseline');
        const unrelatedSha = fixture.git('rev-parse', 'HEAD');
        fixture.git('tag', '--force', tag('2.7.0', 1), unrelatedSha);
        writeFileSync(fixture.receiptPath, JSON.stringify({ ...fixture.buildReceipt, previousBuildSha: unrelatedSha }));
      }
      expect(fixture.execute).toThrow();
      expect(fixture.outputs()).toBe('');
    },
  );
});
