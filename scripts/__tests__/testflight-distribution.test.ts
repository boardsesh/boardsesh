import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDistributionResult,
  latestUploadedIosBuild,
  parseDistributionResult,
  readSupersededTestflightSources,
  retryableDistribution,
  type DistributionResult,
} from '../lib/testflight-distribution';
import { main } from '../testflight-distribution';

const receipt = {
  version: '2.7.0',
  buildNumber: '8',
  sourceSha: 'a'.repeat(40),
  sourceRef: 'release/next',
  sourceRunId: '123',
  buildTag: 'build-ios-v2.7.0-8-abcdef123456',
  previousBuildTag: 'build-ios-v2.7.0-7-abcdef123456',
  previousBuildSha: 'b'.repeat(40),
};
const identity = {
  sourceRunAttempt: 1,
  distributionRunId: '456',
  distributionRunAttempt: 1,
  checkedAt: '2026-11-01T13:00:00Z',
};
function result(status: DistributionResult['status'] = 'deferred-beta-review'): DistributionResult {
  return createDistributionResult(receipt, identity, {
    version: receipt.version,
    buildNumber: receipt.buildNumber,
    status,
  });
}

describe('TestFlight retry selection', () => {
  const latest = { name: receipt.buildTag, sha: receipt.sourceSha };
  it('retries only explicitly deferred processing or beta-review outcomes', () => {
    for (const status of ['deferred-beta-review', 'deferred-processing'] as const)
      expect(retryableDistribution(latest, [result(status)])?.status).toBe(status);
    for (const status of [
      'terminal-failure',
      'pending-beta-review',
      'approved-awaiting-availability',
      'ready-for-testing',
    ] as const)
      expect(retryableDistribution(latest, [result(status)])).toBeNull();
    expect(retryableDistribution(latest, [])).toBeNull();
  });

  it('never falls back from a newer terminal error or successful assignment to an old deferred outcome', () => {
    for (const status of ['terminal-failure', 'ready-for-testing'] as const)
      expect(retryableDistribution(latest, [result(status), result()])).toBeNull();
  });

  it('supersedes old deferred deliveries only after a newer actual upload', () => {
    expect(
      retryableDistribution({ name: 'build-ios-v2.7.1-1-abcdef123456', sha: 'b'.repeat(40) }, [result()]),
    ).toBeNull();
    expect(retryableDistribution(latest, [{ ...result(), sourceSha: 'b'.repeat(40) }])).toBeNull();
    expect(
      latestUploadedIosBuild([
        latest,
        { name: 'build-ios-v2.7.1-1-abcdef123456', sha: 'b'.repeat(40) },
        { name: 'fingerprint-ios-abcdef123456', sha: 'c'.repeat(40) },
        { name: 'build-android-v9.0.0-100-abcdef123456', sha: 'c'.repeat(40) },
      ])?.name,
    ).toBe('build-ios-v2.7.1-1-abcdef123456');
  });

  it('does not invent uploaded binaries from gate-only runs and refuses ambiguous newest tags', () => {
    expect(latestUploadedIosBuild([])).toBeNull();
    expect(() => latestUploadedIosBuild([latest, { ...latest, name: 'build-ios-v2.7.0-8-123456abcdef' }])).toThrow(
      'Ambiguous',
    );
  });

  it('excludes only explicitly retired source SHAs before ranking restored uploads', () => {
    const expired = { name: 'build-ios-v2.7.1-1-abcdef123456', sha: 'c'.repeat(40) };
    const restored = { name: 'build-ios-v2.7.0-9-abcdef123456', sha: 'd'.repeat(40) };
    expect(latestUploadedIosBuild([latest, expired, restored], new Set([expired.sha]))).toEqual(restored);
    expect(latestUploadedIosBuild([latest, expired, restored])).toEqual(expired);
    expect(latestUploadedIosBuild([expired], new Set([expired.sha]))).toBeNull();
    expect(latestUploadedIosBuild([latest, expired, restored], new Set([restored.sha]))).toEqual(expired);
  });

  it('refreshes main without token arguments and refuses stale lineage after fetch or proof failures', () => {
    const execute = vi.fn(() => '');
    const readLineage = vi.fn(() => ['c'.repeat(40)]);
    expect([...readSupersededTestflightSources(execute, readLineage, '/repo')]).toEqual(['c'.repeat(40)]);
    expect(execute).toHaveBeenCalledExactlyOnceWith('git', [
      '-C',
      '/repo',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    expect(readLineage).toHaveBeenCalledExactlyOnceWith('/repo');
    execute.mockImplementation(() => {
      throw new Error('origin unavailable');
    });
    expect(() => readSupersededTestflightSources(execute, readLineage)).toThrow('origin unavailable');
    expect(readLineage).toHaveBeenCalledOnce();
    execute.mockReturnValue('');
    readLineage.mockImplementation(() => {
      throw new Error('forged restoration');
    });
    expect(() => readSupersededTestflightSources(execute, readLineage)).toThrow('forged restoration');
  });
});

describe('TestFlight distribution result provenance', () => {
  it('records an unclassified failure as terminal and binds lane version/build', () => {
    expect(createDistributionResult(receipt, identity).status).toBe('terminal-failure');
    expect(() =>
      createDistributionResult(receipt, identity, { version: '2.7.1', buildNumber: '8', status: 'ready-for-testing' }),
    ).toThrow('different');
    expect(result()).toMatchObject({
      sourceRunId: '123',
      distributionRunId: '456',
      sourceSha: receipt.sourceSha,
      buildTag: receipt.buildTag,
    });
  });

  it.each([
    { status: 'retry-everything' },
    { sourceRunAttempt: 0 },
    { distributionRunAttempt: -1 },
    { sourceRunId: '../123' },
    { sourceSha: 'main' },
    { version: '2.7.1' },
    { buildNumber: '9' },
    { checkedAt: 'yesterday' },
    { buildId: 12 },
    { groupId: undefined },
  ])('rejects malformed result %j', (patch) => {
    expect(() => parseDistributionResult({ ...result(), ...patch })).toThrow('Invalid');
  });
});

describe('distribution result capture after earlier job failures', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  it('retains a terminal result when note generation stopped before the Apple lane', () => {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-record-'));
    directories.push(directory);
    const receiptPath = join(directory, 'build.json');
    const outputPath = join(directory, 'result', 'distribution-result.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    vi.stubEnv('TESTFLIGHT_BUILD_RECEIPT', receiptPath);
    vi.stubEnv('TESTFLIGHT_DISTRIBUTION_OUTPUT', join(directory, 'missing-lane.json'));
    vi.stubEnv('TESTFLIGHT_RESULT_OUTPUT', outputPath);
    vi.stubEnv('SOURCE_RUN_ATTEMPT', '1');
    vi.stubEnv('GITHUB_RUN_ID', '456');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    main(['record']);
    expect(parseDistributionResult(JSON.parse(readFileSync(outputPath, 'utf8')))).toMatchObject({
      status: 'terminal-failure',
      sourceRunId: '123',
      sourceRunAttempt: 1,
      distributionRunAttempt: 2,
    });
  });

  function selectFixture(
    status: DistributionResult['status'] | 'malformed' | 'missing',
    options: {
      rerunTerminal?: boolean;
      paginate?: boolean;
      unrelatedMissing?: boolean;
      restored?: boolean;
      neverDistributed?: boolean;
      untrustedFirst?: boolean;
      uploadReceipt?: typeof receipt;
    } = {},
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'testflight-select-'));
    directories.push(directory);
    const outputPath = join(directory, 'outputs');
    writeFileSync(outputPath, '');
    vi.stubEnv('GITHUB_REPOSITORY', 'boardsesh/boardsesh');
    vi.stubEnv('GITHUB_OUTPUT', outputPath);
    const downloads: string[] = [];
    const pages: number[] = [];
    const uploadedReceipt = options.restored
      ? {
          ...receipt,
          buildNumber: '9',
          buildTag: 'build-ios-v2.7.0-9-abcdef123456',
          sourceSha: 'd'.repeat(40),
          sourceRunId: '124',
          previousBuildTag: receipt.buildTag,
          previousBuildSha: receipt.sourceSha,
        }
      : receipt;
    const execute = (binary: string, argumentsList: string[]) => {
      if (binary === 'git')
        return argumentsList[0] === 'for-each-ref'
          ? `${uploadedReceipt.buildTag} ${uploadedReceipt.sourceSha}${options.restored ? `\n${receipt.buildTag} ${receipt.sourceSha}\nbuild-ios-v2.7.1-1-abcdef123456 ${'c'.repeat(40)}` : ''}`
          : '';
      if (argumentsList[0] === 'run') {
        const runId = argumentsList[2];
        downloads.push(runId);
        const target = argumentsList[argumentsList.indexOf('--dir') + 1];
        if (argumentsList[argumentsList.indexOf('--name') + 1] === 'ios-testflight-build-1') {
          writeFileSync(
            join(target, 'testflight-build.json'),
            JSON.stringify(options.uploadReceipt ?? uploadedReceipt),
          );
          return '';
        }
        const older = runId === '1';
        const statusForRun = older ? (options.rerunTerminal ? 'terminal-failure' : 'deferred-beta-review') : status;
        const checkedAt = older
          ? options.rerunTerminal
            ? '2026-11-01T14:00:00Z'
            : '2026-11-01T12:00:00Z'
          : identity.checkedAt;
        const oldReceipt = {
          ...receipt,
          buildNumber: '7',
          buildTag: 'build-ios-v2.7.0-7-abcdef123456',
          previousBuildTag: 'build-ios-v2.7.0-6-abcdef123456',
        };
        writeFileSync(
          join(target, 'testflight-build.json'),
          JSON.stringify(older && options.unrelatedMissing ? oldReceipt : uploadedReceipt),
        );
        if (statusForRun !== 'missing' && !(older && options.unrelatedMissing))
          writeFileSync(
            join(target, 'distribution-result.json'),
            JSON.stringify(
              statusForRun === 'malformed'
                ? { status: 'broken' }
                : {
                    ...createDistributionResult(uploadedReceipt, identity, {
                      version: uploadedReceipt.version,
                      buildNumber: uploadedReceipt.buildNumber,
                      status: statusForRun,
                    }),
                    distributionRunId: runId,
                    distributionRunAttempt: older && options.rerunTerminal ? 2 : 1,
                    checkedAt,
                  },
            ),
          );
        return '';
      }
      const endpoint = argumentsList[1];
      if (endpoint === '/repos/boardsesh/boardsesh/actions/runs/123')
        return JSON.stringify({
          id: 123,
          path: '.github/workflows/ios-testflight-rn.yml',
          created_at: '2026-11-01T10:00:00Z',
          head_repository: { full_name: 'boardsesh/boardsesh' },
        });
      if (endpoint.includes('/workflows/ios-testflight-rn.yml/runs')) {
        expect(endpoint).toContain('status=success');
        const nativeRun = (id: number, title: string) => ({
          id,
          run_attempt: 1,
          display_title: title,
          path: '.github/workflows/ios-testflight-rn.yml',
          status: 'completed',
          conclusion: 'success',
          event: 'workflow_dispatch',
          head_branch: 'main',
          head_sha: 'e'.repeat(40),
          head_repository: { full_name: 'boardsesh/boardsesh' },
        });
        return JSON.stringify({
          workflow_runs: options.neverDistributed
            ? [
                ...(options.untrustedFirst
                  ? [{ ...nativeRun(998, `ios:${uploadedReceipt.sourceSha}`), head_branch: 'feature' }]
                  : []),
                nativeRun(999, `ios:${'f'.repeat(40)}`),
                nativeRun(123, `ios:${uploadedReceipt.sourceSha}`),
              ]
            : [],
        });
      }
      if (endpoint.includes('/workflows/')) {
        const page = Number(endpoint.match(/&page=(\d+)/)?.[1]);
        pages.push(page);
        const ids = options.neverDistributed
          ? []
          : options.paginate
            ? page === 1
              ? [...Array.from({ length: 98 }, (_, index) => index + 100), 3, 2]
              : [1]
            : [3, 2, 1];
        return JSON.stringify({
          workflow_runs: ids.map((id) => ({
            id,
            run_attempt: id === 1 && options.rerunTerminal ? 2 : 1,
            created_at: '2026-11-01T11:00:00Z',
            updated_at: id === 1 && options.rerunTerminal ? '2026-11-01T14:01:00Z' : '2026-11-01T13:01:00Z',
            path: '.github/workflows/ios-testflight-distribute.yml',
            head_branch: 'main',
            head_repository: { full_name: 'boardsesh/boardsesh' },
          })),
        });
      }
      const runId = endpoint.match(/runs\/(\d+)\//)?.[1];
      const name = endpoint.match(/[?&]name=([^&]+)/)?.[1];
      if (name === 'ios-testflight-build-1')
        return JSON.stringify({ artifacts: runId === '123' ? [{ id: 77, name, expired: false }] : [] });
      return JSON.stringify({
        artifacts: runId === '3' || Number(runId) >= 100 ? [] : [{ id: 123, name, expired: false }],
      });
    };
    return { execute, downloads, pages, outputs: () => readFileSync(outputPath, 'utf8') };
  }

  it('skips no-op runs and resumes only the newest classified deferred source attempt', () => {
    const fixture = selectFixture('deferred-processing');
    main(['select'], fixture.execute, () => []);
    expect(fixture.downloads).toEqual(['2', '1']);
    expect(fixture.outputs()).toBe('selected=true\nsource_run_id=123\nsource_run_attempt=1\n');
  });

  it.each(['terminal-failure', 'ready-for-testing'] as const)(
    'does not retry an older deferred result after the newest outcome is %s',
    (status) => {
      const fixture = selectFixture(status);
      main(['select'], fixture.execute, () => []);
      expect(fixture.downloads).toEqual(['2', '1']);
      expect(fixture.outputs()).toBe('selected=false\n');
    },
  );

  it.each(['missing', 'malformed'] as const)('fails closed on a %s newest matching artifact', (status) => {
    const fixture = selectFixture(status);
    expect(() => main(['select'], fixture.execute, () => [])).toThrow('no valid result');
    expect(fixture.downloads).toEqual(['2', '1']);
    expect(fixture.outputs()).toBe('');
  });

  it('reads later pages and lets an older run rerun terminally supersede newer-created deferred runs', () => {
    const fixture = selectFixture('deferred-beta-review', { rerunTerminal: true, paginate: true });
    main(['select'], fixture.execute, () => []);
    expect(fixture.pages).toEqual([1, 2]);
    expect(fixture.downloads).toEqual(['2', '1']);
    expect(fixture.outputs()).toBe('selected=false\n');
  });

  it('does not let unrelated historical artifacts without results block the current delivery', () => {
    const fixture = selectFixture('deferred-processing', { unrelatedMissing: true });
    main(['select'], fixture.execute, () => []);
    expect(fixture.outputs()).toBe('selected=true\nsource_run_id=123\nsource_run_attempt=1\n');
  });

  it('retries restored 2.7.0 after the higher 2.7.1 source is explicitly retired', () => {
    const fixture = selectFixture('deferred-processing', { restored: true });
    main(['select'], fixture.execute, () => ['c'.repeat(40)]);
    expect(fixture.outputs()).toBe('selected=true\nsource_run_id=124\nsource_run_attempt=1\n');
  });

  it('keeps higher uploaded versions eligible without a validated restoration record', () => {
    const fixture = selectFixture('deferred-processing', { restored: true });
    main(['select'], fixture.execute, () => []);
    expect(fixture.outputs()).toBe('selected=false\n');
  });

  it('delivers a newest upload that no distribution ever attempted', () => {
    const fixture = selectFixture('deferred-processing', { neverDistributed: true });
    main(['select'], fixture.execute, () => []);
    expect(fixture.downloads).toEqual(['123']);
    expect(fixture.outputs()).toBe('selected=true\nsource_run_id=123\nsource_run_attempt=1\n');
  });

  it('skips an untrusted same-titled run instead of blocking hourly delivery', () => {
    const fixture = selectFixture('deferred-processing', { neverDistributed: true, untrustedFirst: true });
    main(['select'], fixture.execute, () => []);
    expect(fixture.downloads).toEqual(['123']);
    expect(fixture.outputs()).toBe('selected=true\nsource_run_id=123\nsource_run_attempt=1\n');
  });

  it('does not deliver an attempted upload a second time through the never-attempted path', () => {
    const fixture = selectFixture('ready-for-testing');
    main(['select'], fixture.execute, () => []);
    expect(fixture.downloads).not.toContain('123');
    expect(fixture.outputs()).toBe('selected=false\n');
  });

  it.each([
    ['another build tag', { ...receipt, buildNumber: '9', buildTag: 'build-ios-v2.7.0-9-abcdef123456' }],
    ['another source run', { ...receipt, sourceRunId: '124' }],
  ])('refuses a never-attempted upload whose receipt names %s', (_description, uploadReceipt) => {
    const fixture = selectFixture('deferred-processing', { neverDistributed: true, uploadReceipt });
    main(['select'], fixture.execute, () => []);
    expect(fixture.outputs()).toBe('selected=false\n');
  });

  it('emits no retry authorization when main refresh fails', () => {
    const fixture = selectFixture('deferred-processing');
    const lineage = vi.fn(() => []);
    expect(() =>
      main(
        ['select'],
        (binary, argumentsList) => {
          if (binary === 'git' && argumentsList.includes('fetch')) throw new Error('origin unavailable');
          return fixture.execute(binary, argumentsList);
        },
        lineage,
      ),
    ).toThrow('origin unavailable');
    expect(lineage).not.toHaveBeenCalled();
    expect(fixture.outputs()).toBe('');
  });
});
