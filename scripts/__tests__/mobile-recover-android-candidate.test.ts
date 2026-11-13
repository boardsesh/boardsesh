import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  missingRecoveryTags,
  requireReviewedPlayBuild,
  validateApkIdentity,
  validateRecoveryRun,
  validateRecoveryGateLog,
  recoveryCommandFailure,
  readOriginalNativeGateLog,
} from '../mobile-recover-android-candidate';

const SOURCE = 'd'.repeat(40);
const RUNTIME = 'f'.repeat(40);
const repository = 'boardsesh/boardsesh';
const run = {
  id: 123,
  path: '.github/workflows/android-apk-rn.yml',
  head_branch: 'main',
  head_sha: SOURCE,
  display_title: `android:${SOURCE}`,
  head_repository: { full_name: repository },
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'failure',
  run_number: 42,
};
const jobs = [
  {
    name: 'build-and-release',
    conclusion: 'success',
    steps: [{ name: 'Upload AAB to Play internal and open beta tracks', conclusion: 'success' }],
  },
];
const apk = { applicationId: 'com.boardsesh.app', versionCode: '2001682', version: '2.7.1', runtime: RUNTIME };
const releases = (state: string, code = 2001682) => ({
  releases: [{ releaseLifecycleState: state, activeArtifacts: [{ versionCode: code }] }],
});

describe('original native gate log transport', () => {
  const signedUrl = 'https://storage.example/log.txt?private-signature=secret';
  const options = { jobId: '132101145754', token: 'private-token' };
  const redirect = () => new Response(null, { status: 302, headers: { location: signedUrl } });

  it('authenticates only the fixed GitHub API and reads the signed hop without credentials', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(new Response('gate log'));
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl })).resolves.toBe('gate log');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/boardsesh/boardsesh/actions/jobs/132101145754/logs',
    );
    const apiInit = fetchImpl.mock.calls[0]?.[1];
    expect(apiInit?.redirect).toBe('manual');
    expect(new Headers(apiInit?.headers).get('authorization')).toBe('Bearer private-token');
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(new URL(signedUrl));
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual({ redirect: 'error', signal: apiInit?.signal });
  });

  it.each([
    null,
    '/relative',
    'http://storage.example/log',
    'https://user:private-token@storage.example/log',
    'not a URL',
  ])('rejects an unsafe or missing redirect: %s', async (location) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: location === null ? {} : { location },
      }),
    );
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl })).rejects.toThrow(
      location === null
        ? 'Original native gate log API redirect has no location.'
        : 'Original native gate log API redirect is unsafe.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([200, 401, 403, 404, 500])('reports the API status without exposing response content: %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-token', { status }));
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl })).rejects.toThrow(
      `Original native gate log API returned HTTP ${status}; expected a signed redirect.`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([206, 503])('rejects storage HTTP %s without copying its body or signed URL', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(new Response(signedUrl, { status }));
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl })).rejects.toThrow(
      `Original native gate log storage returned HTTP ${status}.`,
    );
  });

  it.each(['API', 'storage'] as const)('sanitizes %s transport errors and drops their cause', async (phase) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (phase === 'storage') fetchImpl.mockResolvedValueOnce(redirect());
    fetchImpl.mockRejectedValueOnce(new Error(`${signedUrl} private-token`));
    const failure = await readOriginalNativeGateLog({ ...options, fetchImpl }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`Original native gate log ${phase} network request failed.`);
    expect((failure as Error).cause).toBeUndefined();
  });

  it('enforces the streamed size bound and cancels oversized bodies', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(new Response(body));
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl, maxBytes: 4 })).rejects.toThrow(
      'Original native gate log exceeds its size bound.',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized declared lengths before reading and sanitizes cancellation errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error(signedUrl);
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(new Response(body, { headers: { 'content-length': '5' } }));
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl, maxBytes: 4 })).rejects.toThrow(
      'Original native gate log exceeds its size bound.',
    );
  });

  it('sanitizes streamed read errors and rejects empty or invalid UTF-8 bodies', async () => {
    for (const [body, expected] of [
      [
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(signedUrl));
          },
        }),
        'read failed',
      ],
      ['', 'empty body'],
      [new Uint8Array([255]), 'not valid UTF-8'],
    ] as const) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirect())
        .mockResolvedValueOnce(new Response(body));
      await expect(readOriginalNativeGateLog({ ...options, fetchImpl })).rejects.toThrow(expected);
    }
  });

  it('uses a single bounded deadline for both network hops', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error(signedUrl)), { once: true });
          }),
      );
    await expect(readOriginalNativeGateLog({ ...options, fetchImpl, timeoutMs: 5 })).rejects.toThrow(
      'Original native gate log storage timed out.',
    );
  });

  it('rejects invalid IDs and bounds before making any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const override of [
      { jobId: '../123' },
      { jobId: '9007199254740992' },
      { token: '' },
      { maxBytes: 0 },
      { maxBytes: 33 * 1024 * 1024 },
      { timeoutMs: 120_001 },
    ])
      await expect(readOriginalNativeGateLog({ ...options, fetchImpl, ...override })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('uploaded Android candidate recovery', () => {
  it('reports the exact failed operation and only whitelisted process diagnostics', () => {
    const error = recoveryCommandFailure('read original native gate logs', {
      status: 1,
      stderr: Buffer.from('gh: private response with Bearer secret-token (HTTP 403)'),
      stdout: 'private response',
      message: 'credential-bearing command arguments',
      code: 'EPIPE',
      signal: 'SIGTERM',
    });
    expect(error.message).toBe(
      'Android recovery command failed (read original native gate logs; exit 1; HTTP 403; EPIPE; SIGTERM).',
    );
    expect(error.cause).toBeUndefined();
  });

  it('distinguishes missing commands, timeouts and output-buffer failures without raw error text', () => {
    for (const code of ['ENOENT', 'ENOBUFS', 'ETIMEDOUT'])
      expect(
        recoveryCommandFailure('read original native jobs', { code, message: 'private credentials' }).message,
      ).toBe(`Android recovery command failed (read original native jobs; ${code}).`);
    expect(
      recoveryCommandFailure('read original native run', {
        code: 'private token',
        signal: 'private signal',
        stderr: 'private body',
      }).message,
    ).toBe('Android recovery command failed (read original native run).');
  });

  it.each([
    ['gh: API rate limit exceeded for private-account (HTTP 403)', 'HTTP 403; reason rate-limit'],
    ['gh: Resource not accessible by integration (HTTP 403)', 'HTTP 403; reason access-denied'],
    ['gh: Not Found (HTTP 404)', 'HTTP 404; reason not-found'],
    ['unknown flag: --private-argument', 'reason unsupported-option'],
  ])('classifies a known CLI failure without copying its details: %s', (stderr, expected) => {
    expect(recoveryCommandFailure('read original native jobs', { stderr }).message).toBe(
      `Android recovery command failed (read original native jobs; ${expected}).`,
    );
  });
  it('binds the APK to the actual resolved source and runtime in the trusted native gate', () => {
    const gate = `2026-11-13T19:01:27Z source_sha=${SOURCE}\n2026-11-13T19:01:58Z source_sha=${SOURCE}\n2026-11-13T19:01:58Z fingerprint=${RUNTIME}\n2026-11-13T19:01:58Z should_build=true\n`;
    expect(validateRecoveryGateLog(gate, SOURCE)).toBe(RUNTIME);
    expect(() => validateRecoveryGateLog(gate, 'a'.repeat(40))).toThrow();
    expect(() => validateRecoveryGateLog(gate.replace('should_build=true', 'should_build=false'), SOURCE)).toThrow();
    expect(() => validateRecoveryGateLog(`${gate}2026-11-13T19:01:59Z fingerprint=${RUNTIME}\n`, SOURCE)).toThrow();
    expect(() => validateRecoveryGateLog('', SOURCE)).toThrow();
  });
  it('accepts a failed metadata run only when its original build and Play upload succeeded', () => {
    expect(validateRecoveryRun(run, jobs, repository, '123', SOURCE)).toEqual({
      sourceRunId: '123',
      sourceSha: SOURCE,
      runNumber: '42',
      artifactName: 'boardsesh-rn-android-42',
    });
    expect(() => validateRecoveryRun(run, [], repository, '123', SOURCE)).toThrow(/must have succeeded/);
    expect(() =>
      validateRecoveryRun(run, [{ ...jobs[0], conclusion: 'failure' }], repository, '123', SOURCE),
    ).toThrow();
    expect(() =>
      validateRecoveryRun(
        run,
        [{ ...jobs[0], steps: [{ ...jobs[0]!.steps[0], conclusion: 'failure' }] }],
        repository,
        '123',
        SOURCE,
      ),
    ).toThrow();
  });

  it.each([
    { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/boardsesh' } },
    { head_sha: 'a'.repeat(40) },
    { display_title: `android:${'a'.repeat(40)}` },
    { status: 'in_progress' },
    { event: 'pull_request' },
    { id: 124 },
    { run_number: 0 },
  ])('rejects untrusted or mismatched native provenance %j', (invalid) => {
    expect(() => validateRecoveryRun({ ...run, ...invalid }, jobs, repository, '123', SOURCE)).toThrow();
  });

  it('checks the package, exact versionCode, semver and full embedded runtime', () => {
    expect(validateApkIdentity({ ...apk, runtime: `"${RUNTIME}"\n` }, '2001682')).toEqual(apk);
    for (const invalid of [
      { applicationId: 'other.app' },
      { versionCode: '2001683' },
      { version: '2.7.1-beta' },
      { runtime: 'f'.repeat(12) },
    ])
      expect(() => validateApkIdentity({ ...apk, ...invalid }, '2001682')).toThrow();
  });

  it('requires exact Play submission evidence, without claiming review means publication', () => {
    requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_PUBLISHED'), 'internal', '2001682');
    for (const state of ['IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED'])
      requireReviewedPlayBuild(releases(`RELEASE_LIFECYCLE_STATE_${state}`), 'beta', '2001682');
    for (const state of ['DRAFT', 'NOT_SENT_FOR_REVIEW', 'NOT_APPROVED'])
      expect(() => requireReviewedPlayBuild(releases(`RELEASE_LIFECYCLE_STATE_${state}`), 'beta', '2001682')).toThrow();
    expect(() =>
      requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_IN_REVIEW'), 'internal', '2001682'),
    ).toThrow();
    expect(() =>
      requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_PUBLISHED', 2001646), 'beta', '2001682'),
    ).toThrow();
    const evidence = releases('RELEASE_LIFECYCLE_STATE_IN_REVIEW');
    expect(() =>
      requireReviewedPlayBuild({ releases: [...evidence.releases, ...evidence.releases] }, 'beta', '2001682'),
    ).toThrow();
  });

  it('only creates missing immutable tags and refuses to replace a different target', () => {
    expect(missingRecoveryTags({ build: null, fingerprint: null }, SOURCE)).toEqual(['build', 'fingerprint']);
    expect(missingRecoveryTags({ build: SOURCE, fingerprint: null }, SOURCE)).toEqual(['fingerprint']);
    expect(missingRecoveryTags({ build: SOURCE, fingerprint: SOURCE }, SOURCE)).toEqual([]);
    expect(() => missingRecoveryTags({ build: SOURCE, fingerprint: 'a'.repeat(40) }, SOURCE)).toThrow(
      /refusing overwrite/,
    );
  });

  it('keeps recovery on trusted main and reads Play before minting a publication token', () => {
    const workflow = parse(readFileSync('.github/workflows/android-recover-candidate.yml', 'utf8'));
    const recover = workflow.jobs.recover;
    expect(recover.if).toBe("github.ref == 'refs/heads/main'");
    expect(recover.permissions).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    const steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> = recover.steps;
    expect(steps[0]!.with?.ref).toBe('${{ github.workflow_sha }}');
    const verify = steps.findIndex((step) => step.run?.endsWith(' verify'));
    const mint = steps.findIndex((step) => step.name === 'Mint short-lived candidate publication token');
    expect(mint).toBeGreaterThan(verify);
    expect(steps[mint]!.with?.['permission-contents']).toBe('write');
    expect(steps[mint]!.with?.['permission-workflows']).toBe('write');
    expect(steps.some((step) => /gradlew|upload_beta|force_native|changesInReviewBehavior/.test(step.run ?? ''))).toBe(
      false,
    );
    const download = steps.find((step) => step.name === 'Download the original signed APK');
    expect(download?.with?.['run-id']).toBe('${{ inputs.source_run_id }}');
  });
});
