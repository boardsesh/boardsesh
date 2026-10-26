import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_WORKFLOW,
  PREVIEW_ARTIFACT,
  resolvePreviewReceipt,
  readPreviewReceiptZip,
  validatePreviewRun,
  validatePreviewReceipt,
  validatePreviewArtifact,
  validatePreviewDeployment,
} from './mobile-ota-boot-preview';

const proof = { repository: 'boardsesh/boardsesh', headSha: 'a'.repeat(40), pullRequest: 6131 };
const NOW = Date.parse('2026-10-09T00:00:00Z');
const run = {
  id: 10,
  path: PREVIEW_WORKFLOW,
  event: 'pull_request',
  head_sha: proof.headSha,
  repository: { full_name: proof.repository },
  head_repository: { full_name: proof.repository },
  pull_requests: [{ number: 6131, head: { sha: proof.headSha } }],
  status: 'completed',
  conclusion: 'success',
};
const artifact = {
  id: 20,
  name: PREVIEW_ARTIFACT,
  expired: false,
  expires_at: '2026-10-10T00:00:00Z',
  size_in_bytes: 500,
  workflow_run: { id: 10, head_sha: proof.headSha },
};
const identity = {
  runtimeVersion: 'b'.repeat(40),
  bundleSha256: 'c'.repeat(64),
  updateId: '12345678-1234-1234-1234-123456789abc',
};
const receipt = {
  version: 1,
  commitHash: proof.headSha,
  branch: 'pr-6131',
  previewRunId: 10,
  deploymentId: 30,
  platforms: { ios: identity, android: { ...identity, runtimeVersion: 'd'.repeat(40) } },
};
const deployment = {
  id: 30,
  sha: proof.headSha,
  ref: proof.headSha,
  environment: 'pr-preview',
  production_environment: false,
  transient_environment: true,
  description: 'OTA preview pr-6131',
};
const pr = { state: 'open', head: { sha: proof.headSha, repo: { full_name: proof.repository } } };

function zip(entries: Record<string, string>): Uint8Array {
  return execFileSync('python3', [
    '-c',
    'import sys, json, zipfile, io\nbuffer=io.BytesIO()\nwith zipfile.ZipFile(buffer, "w") as archive:\n for name, contents in json.loads(sys.argv[1]).items(): archive.writestr(name, contents)\nsys.stdout.buffer.write(buffer.getvalue())',
    JSON.stringify(entries),
  ]);
}

function fakeGithub(overrides: Record<string, unknown> = {}, artifactReceipt: unknown = receipt) {
  const answers: Record<string, unknown> = {
    '/pulls/6131': pr,
    '/actions/workflows/mobile-ota-preview.yml/runs': { workflow_runs: [run] },
    '/actions/runs/10/artifacts': { artifacts: [artifact] },
    '/deployments/30': deployment,
    '/deployments/30/statuses': [{ state: 'success' }],
    ...overrides,
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    if (url.hostname === 'storage.example') {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(new Uint8Array(zip({ 'receipt.json': JSON.stringify(artifactReceipt) })).buffer);
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-github-token');
    const path = url.pathname.replace('/repos/boardsesh/boardsesh', '');
    if (path === '/actions/artifacts/20/zip')
      return new Response(null, { status: 302, headers: { location: 'https://storage.example/receipt.zip' } });
    if (!(path in answers)) throw new Error(`Unexpected request ${path}`);
    return Response.json(answers[path]);
  });
  return { token: 'private-github-token', fetchImpl, nowMs: () => NOW };
}
afterEach(() => vi.useRealTimers());

describe('frozen preview boot receipt discovery', () => {
  it('uses the pinned head, trusted run, artifact and authoritative successful deployment without leaking the token', async () => {
    const github = fakeGithub();
    expect(await resolvePreviewReceipt(proof, github)).toEqual(receipt);
    expect(
      github.fetchImpl.mock.calls.filter(([url]) =>
        (url instanceof URL ? url.href : typeof url === 'string' ? url : url.url).includes('/pulls/6131'),
      ),
    ).toHaveLength(2);
  });

  it('accepts default-branch dispatch provenance while preserving the original PR deployment SHA', async () => {
    const dispatched = {
      ...run,
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'f'.repeat(40),
      pull_requests: [],
    };
    const github = fakeGithub({
      '/actions/workflows/mobile-ota-preview.yml/runs': { workflow_runs: [dispatched] },
      '/actions/runs/10/artifacts': {
        artifacts: [{ ...artifact, workflow_run: { id: 10, head_sha: dispatched.head_sha } }],
      },
    });
    expect(await resolvePreviewReceipt(proof, github)).toEqual(receipt);
    expect(() => validatePreviewRun({ ...dispatched, head_branch: 'release/next' }, proof)).toThrow('trusted');
    expect(() =>
      validatePreviewRun({ ...dispatched, head_branch: `ci-sandbox/ota-preview/pr-${proof.pullRequest}/42` }, proof),
    ).not.toThrow();
    for (const head_branch of [
      `ci-sandbox/ota-preview/pr-${proof.pullRequest + 1}/42`,
      `ci-sandbox/db-renumber/pr-${proof.pullRequest}/42`,
      `ci-sandbox/ota-preview/pr-${proof.pullRequest}/x`,
    ]) {
      expect(() => validatePreviewRun({ ...dispatched, head_branch }, proof)).toThrow('trusted');
    }
    expect(() => validatePreviewArtifact(artifact, dispatched, proof, NOW)).toThrow();
  });

  it('binds v2 generated source artifacts to the same trusted dispatch run', async () => {
    const dispatched = {
      ...run,
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'f'.repeat(40),
      pull_requests: [],
    };
    const generated = {
      candidateCommit: 'e'.repeat(40),
      candidateTree: 'd'.repeat(40),
      targetSha: 'f'.repeat(40),
      targetRef: 'main',
      sourceBundle: 'main.bundle',
      sourceBundleSha256: 'c'.repeat(64),
    };
    const ios = { ...identity, ...generated };
    const android = { ...identity, ...generated };
    const preview = {
      ...receipt,
      version: 2,
      sourceBaseSha: 'b'.repeat(40),
      sourceBaseRef: 'main',
      sourceArtifact: 'mobile-ota-preview-source',
      platforms: { ios, android },
      candidates: [
        {
          targetRef: 'main',
          targetSha: generated.targetSha,
          commitHash: generated.candidateCommit,
          treeHash: generated.candidateTree,
          sourceBundle: generated.sourceBundle,
          sourceBundleSha256: generated.sourceBundleSha256,
          platforms: Object.fromEntries(
            ['ios', 'android'].map((platform) => [
              platform,
              {
                status: 'published',
                receipt: { ...identity, commitHash: generated.candidateCommit, branch: receipt.branch },
              },
            ]),
          ),
        },
      ],
    };
    const source = {
      ...artifact,
      id: 21,
      name: preview.sourceArtifact,
      workflow_run: { id: 10, head_sha: dispatched.head_sha },
    };
    const overrides = {
      '/actions/workflows/mobile-ota-preview.yml/runs': { workflow_runs: [dispatched] },
      '/actions/runs/10/artifacts': { artifacts: [{ ...artifact, workflow_run: source.workflow_run }, source] },
    };
    expect(await resolvePreviewReceipt(proof, fakeGithub(overrides, preview))).toEqual({
      ...preview,
      sourceArtifactId: 21,
    });
    await expect(
      resolvePreviewReceipt(
        proof,
        fakeGithub(
          {
            ...overrides,
            '/actions/runs/10/artifacts': {
              artifacts: [
                { ...artifact, workflow_run: source.workflow_run },
                { ...source, workflow_run: { id: 11, head_sha: dispatched.head_sha } },
              ],
            },
          },
          preview,
        ),
      ),
    ).rejects.toThrow('does not match');
  });

  it.each([
    { path: '.github/workflows/production-deploy.yml' },
    { event: 'workflow_dispatch' },
    { head_sha: 'e'.repeat(40) },
    { head_repository: { full_name: 'attacker/fork' } },
    { repository: { full_name: 'attacker/fork' } },
    { pull_requests: [{ number: 1, head: { sha: proof.headSha } }] },
    { pull_requests: [{ number: 6131, head: { sha: 'e'.repeat(40) } }] },
  ])('refuses untrusted run metadata %j', (changes) =>
    expect(() => validatePreviewRun({ ...run, ...changes }, proof)).toThrow('trusted'),
  );

  it.each([
    { expired: true },
    { expires_at: '2026-10-08T00:00:00Z' },
    { workflow_run: { id: 11, head_sha: proof.headSha } },
    { workflow_run: { id: 10, head_sha: 'e'.repeat(40) } },
    { size_in_bytes: 2 * 1024 * 1024 },
  ])('refuses stale or mismatched artifact %j', (changes) =>
    expect(() => validatePreviewArtifact({ ...artifact, ...changes }, run, proof, NOW)).toThrow(),
  );

  it.each([
    { version: '1' },
    { version: '2' },
    { commitHash: 'e'.repeat(40) },
    { branch: 'pr-1' },
    { previewRunId: 11 },
    { deploymentId: 0 },
    { platforms: { ios: identity } },
    { platforms: { ios: identity, android: { ...identity, bundleSha256: 'metadata-only' } } },
  ])('refuses tampered or partial receipt %j', (changes) =>
    expect(() => validatePreviewReceipt({ ...receipt, ...changes }, proof, 10)).toThrow(),
  );

  it.each([
    { sha: 'e'.repeat(40) },
    { ref: 'main' },
    { environment: 'production' },
    { production_environment: true },
    { description: 'OTA preview pr-1' },
  ])('refuses untrusted deployment %j', (changes) =>
    expect(() => validatePreviewDeployment({ ...deployment, ...changes }, [{ state: 'success' }], proof, 30)).toThrow(),
  );
  it('rejects a failed latest deployment status even when an earlier one succeeded', () =>
    expect(() =>
      validatePreviewDeployment(deployment, [{ state: 'failure' }, { state: 'success' }], proof, 30),
    ).toThrow());

  it.each(['failure', 'cancelled', 'skipped'])(
    'fails a completed %s preview rather than proving older bytes',
    async (conclusion) => {
      await expect(
        resolvePreviewReceipt(
          proof,
          fakeGithub({ '/actions/workflows/mobile-ota-preview.yml/runs': { workflow_runs: [{ ...run, conclusion }] } }),
        ),
      ).rejects.toThrow('completed');
    },
  );
  it('does not fall back to an older successful run after the newest one failed', async () => {
    await expect(
      resolvePreviewReceipt(
        proof,
        fakeGithub({
          '/actions/workflows/mobile-ota-preview.yml/runs': {
            workflow_runs: [run, { ...run, id: 11, conclusion: 'failure' }],
          },
        }),
      ),
    ).rejects.toThrow('run 11');
  });
  it('refuses a successful native-only/partial preview lacking a both-platform receipt', async () => {
    await expect(
      resolvePreviewReceipt(proof, fakeGithub({ '/actions/runs/10/artifacts': { artifacts: [] } })),
    ).rejects.toThrow('no unique receipt');
  });
  it('fails closed after the PR head changes', async () => {
    await expect(
      resolvePreviewReceipt(proof, fakeGithub({ '/pulls/6131': { ...pr, head: { ...pr.head, sha: 'e'.repeat(40) } } })),
    ).rejects.toThrow('head moved');
  });
  it('waits for the matching preview, then fails at the bounded deadline', async () => {
    let now = NOW;
    const github = fakeGithub({ '/actions/workflows/mobile-ota-preview.yml/runs': { workflow_runs: [] } });
    const sleeper = vi.fn(async (duration: number) => {
      now += duration;
    });
    await expect(
      resolvePreviewReceipt(proof, { ...github, nowMs: () => now, sleeper, waitMs: 30_000 }),
    ).rejects.toThrow('Timed out');
    expect(sleeper).toHaveBeenCalledTimes(2);
  });
  it('times out a stalled GitHub JSON response body', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
            ),
        }) as Response,
    );
    const result = expect(resolvePreviewReceipt(proof, { token: 'token', fetchImpl })).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
  });

  it.each(['../receipt.json', '/receipt.json', 'nested/receipt.json', 'receipt.json\\evil'])(
    'rejects unsafe/misnamed ZIP receipt %s',
    (name) => expect(() => readPreviewReceiptZip(zip({ [name]: '{}' }))).toThrow(),
  );
  it('rejects archives with unrequested extra files', () =>
    expect(() => readPreviewReceiptZip(zip({ 'receipt.json': '{}', extra: 'no' }))).toThrow());
});
