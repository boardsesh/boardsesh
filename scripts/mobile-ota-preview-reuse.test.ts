import { describe, expect, it, vi } from 'vitest';
import { checkPreviewReuse } from './mobile-ota-preview-reuse';
import { PREVIEW_ARTIFACT, PREVIEW_WORKFLOW } from './mobile-ota-boot-preview';

const OLD_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MAIN_SHA = 'c'.repeat(40);
const RUNTIME = 'd'.repeat(40);
const GENERATED_SHA = 'e'.repeat(40);
const BUNDLE_HASH = 'f'.repeat(64);
const UPDATE_ID = '12345678-1234-1234-1234-123456789abc';
const NOW = Date.parse('2026-11-22T00:00:00Z');

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;

function fixture() {
  const bases = { version: 2, mainSha: MAIN_SHA, sourceBaseSha: MAIN_SHA, sourceBaseRef: 'main' };
  const deployment = {
    id: 30,
    sha: OLD_SHA,
    ref: OLD_SHA,
    task: 'ota-preview-pr-7',
    environment: 'pr-preview',
    description: 'OTA preview pr-7',
    transient_environment: true,
    production_environment: false,
    payload: { otaPreviewBases: bases, otaPreviewRunId: 10 },
  };
  const identity = {
    runtimeVersion: RUNTIME,
    bundleSha256: BUNDLE_HASH,
    updateId: UPDATE_ID,
    candidateCommit: GENERATED_SHA,
    candidateTree: GENERATED_SHA,
    targetRef: 'main',
    targetSha: MAIN_SHA,
    sourceBundle: 'main.bundle',
    sourceBundleSha256: BUNDLE_HASH,
  };
  const published = {
    status: 'published',
    receipt: { commitHash: GENERATED_SHA, branch: 'pr-7', ...identity },
  };
  const receipt = {
    version: 2,
    commitHash: OLD_SHA,
    branch: 'pr-7',
    previewRunId: 10,
    deploymentId: 30,
    sourceBaseSha: MAIN_SHA,
    sourceBaseRef: 'main',
    sourceArtifact: 'mobile-ota-preview-source',
    platforms: { ios: { ...identity }, android: { ...identity } },
    candidates: [
      {
        targetRef: 'main',
        targetSha: MAIN_SHA,
        commitHash: GENERATED_SHA,
        treeHash: GENERATED_SHA,
        sourceBundle: 'main.bundle',
        sourceBundleSha256: BUNDLE_HASH,
        platforms: { ios: structuredClone(published), android: structuredClone(published) },
      },
    ],
  };
  const answers: Record<string, unknown> = {
    [`/compare/${OLD_SHA}...${HEAD_SHA}`]: {
      status: 'ahead',
      files: [{ filename: 'packages/backend/src/server.ts' }],
    },
    '/actions/runs/10': {
      id: 10,
      path: PREVIEW_WORKFLOW,
      event: 'pull_request',
      head_sha: OLD_SHA,
      repository: { full_name: 'boardsesh/boardsesh' },
      head_repository: { full_name: 'boardsesh/boardsesh' },
      pull_requests: [{ number: 7, head: { sha: OLD_SHA } }],
      status: 'completed',
      conclusion: 'success',
    },
    '/actions/runs/10/artifacts': {
      total_count: 1,
      artifacts: [
        {
          id: 20,
          name: PREVIEW_ARTIFACT,
          expired: false,
          expires_at: '2026-11-23T00:00:00Z',
          size_in_bytes: 500,
          workflow_run: { id: 10, head_sha: OLD_SHA },
        },
      ],
    },
    '/pulls/7': { state: 'open', head: { sha: HEAD_SHA }, base: { sha: MAIN_SHA, ref: 'main' } },
    '/deployments': [deployment],
    '/deployments/30/statuses': [{ state: 'success' }],
  };
  const manifest = {
    id: UPDATE_ID,
    createdAt: '2026-11-21T00:00:00Z',
    runtimeVersion: RUNTIME,
    extra: { branch: 'pr-7' },
    launchAsset: { hash: Buffer.from(BUNDLE_HASH, 'hex').toString('base64url') },
    assets: [],
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestUrl(input));
    if (url.hostname === 'updates.boardsesh.com') {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(new Headers(init?.headers).get('xprem-branch')).toBe('pr-7');
      expect(new Headers(init?.headers).get('expo-runtime-version')).toBe(RUNTIME);
      return Response.json(manifest);
    }
    if (url.hostname === 'artifact.example') {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const path = url.pathname.replace('/repos/boardsesh/boardsesh', '');
    if (path === '/actions/artifacts/20/zip')
      return new Response(null, { status: 302, headers: { location: 'https://artifact.example/receipt.zip' } });
    if (!(path in answers)) throw new Error(`Unexpected request ${url.href}`);
    return Response.json(answers[path]);
  });
  const options = {
    candidate: { deployment, status: 'success' },
    repository: 'boardsesh/boardsesh',
    headSha: HEAD_SHA,
    mainSha: MAIN_SHA,
    sourceBaseSha: MAIN_SHA,
    sourceBaseRef: 'main',
    pullRequest: 7,
    token: 'test-token',
    manifestUrl: 'https://updates.boardsesh.com/manifest',
    fetchImpl,
    nowMs: () => NOW,
    readReceiptZip: vi.fn(() => receipt as unknown),
  };
  return { options, answers, receipt, deployment, manifest, fetchImpl };
}

describe('verified OTA preview reuse', () => {
  it('retains both proven runtime variants after a backend-only push without uploading anything', async () => {
    const { options, fetchImpl } = fixture();
    expect(await checkPreviewReuse(options)).toEqual({
      reuse: true,
      reason: 'Native app inputs and both served runtime variants are unchanged.',
      servedSha: OLD_SHA,
    });
    expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes('updates.boardsesh.com'))).toHaveLength(
      2,
    );
    expect(fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it.each([
    'packages/mobile/src/app.tsx',
    'packages/shared/queue/src/reducer.ts',
    'packages/shared-schema/src/types/session.ts',
    'pnpm-lock.yaml',
  ])('rebuilds when %s changes', async (filename) => {
    const { options, answers, fetchImpl } = fixture();
    answers[`/compare/${OLD_SHA}...${HEAD_SHA}`] = { status: 'ahead', files: [{ filename }] };
    expect(await checkPreviewReuse(options)).toMatchObject({ reuse: false, reason: 'Native app inputs changed.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('includes the old filename when app code moves outside app roots', async () => {
    const { options, answers } = fixture();
    answers[`/compare/${OLD_SHA}...${HEAD_SHA}`] = {
      status: 'ahead',
      files: [{ filename: 'docs/old.ts', previous_filename: 'packages/mobile/src/app.tsx' }],
    };
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it.each([
    { status: 'diverged', files: [] },
    { status: 'ahead' },
    { status: 'ahead', files: Array.from({ length: 300 }, () => ({ filename: 'docs/test.md' })) },
    { status: 'ahead', files: [{}] },
  ])('does not infer unchanged inputs from an uncertain comparison %j', async (comparison) => {
    const { options, answers } = fixture();
    answers[`/compare/${OLD_SHA}...${HEAD_SHA}`] = comparison;
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it('rebuilds legacy deployments without run provenance before making network requests', async () => {
    const { options, deployment, fetchImpl } = fixture();
    deployment.payload.otaPreviewRunId = 0;
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects expired receipts and partial artifact listings', async () => {
    for (const artifacts of [
      { total_count: 1, artifacts: [{ name: PREVIEW_ARTIFACT, expired: true }] },
      { total_count: 2, artifacts: [] },
    ]) {
      const { options, answers } = fixture();
      answers['/actions/runs/10/artifacts'] = artifacts;
      expect((await checkPreviewReuse(options)).reuse).toBe(false);
    }
  });

  it('rejects a partial-platform receipt instead of silently losing a working platform', async () => {
    const { options, receipt } = fixture();
    options.readReceiptZip.mockReturnValue({ ...receipt, platforms: { ios: receipt.platforms.ios } });
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it('rejects receipts from another deployment or source base', async () => {
    for (const change of [{ deploymentId: 31 }, { sourceBaseSha: '1'.repeat(40) }]) {
      const { options, receipt } = fixture();
      options.readReceiptZip.mockReturnValue({ ...receipt, ...change });
      expect((await checkPreviewReuse(options)).reuse).toBe(false);
    }
  });

  it.each(['failure', 'in_progress'])('rebuilds when the recorded run ended in %s', async (conclusion) => {
    const { options, answers } = fixture();
    answers['/actions/runs/10'] = { ...(answers['/actions/runs/10'] as object), conclusion };
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it.each([
    { id: '87654321-1234-1234-1234-123456789abc' },
    { runtimeVersion: '9'.repeat(40) },
    { extra: { branch: 'production' } },
    { launchAsset: { hash: 'different-bundle' } },
  ])('requires the device endpoint to serve the exact frozen update %j', async (change) => {
    const { options, manifest } = fixture();
    Object.assign(manifest, change);
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it('does not retry an unavailable public manifest', async () => {
    const { options, fetchImpl } = fixture();
    const unavailable = vi.fn<typeof fetch>(async (input, init) =>
      requestUrl(input).includes('updates.boardsesh.com')
        ? new Response('Unavailable', { status: 503 })
        : fetchImpl(input, init),
    );
    expect((await checkPreviewReuse({ ...options, fetchImpl: unavailable })).reuse).toBe(false);
    expect(
      unavailable.mock.calls.filter(([input]) => requestUrl(input).includes('updates.boardsesh.com')),
    ).toHaveLength(1);
  });

  it('rejects a moved head or a replacement deployment after manifest checks', async () => {
    for (const path of ['/pulls/7', '/deployments']) {
      const { options, answers } = fixture();
      answers[path] =
        path === '/pulls/7'
          ? { state: 'closed', head: { sha: HEAD_SHA }, base: { sha: MAIN_SHA, ref: 'main' } }
          : [{ id: 31 }];
      expect((await checkPreviewReuse(options)).reuse).toBe(false);
    }
  });

  it('rechecks successful deployment status before skipping', async () => {
    const { options, answers } = fixture();
    answers['/deployments/30/statuses'] = [{ state: 'inactive' }];
    expect((await checkPreviewReuse(options)).reuse).toBe(false);
  });

  it('treats API failures as normal rebuilds', async () => {
    const { options } = fixture();
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error('API offline'));
    expect(await checkPreviewReuse({ ...options, fetchImpl: failed })).toEqual({ reuse: false, reason: 'API offline' });
  });
});
