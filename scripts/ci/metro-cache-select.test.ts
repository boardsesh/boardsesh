import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactRecord,
  DEFAULT_MAX_BYTES,
  MAX_RUN_LOOKUPS,
  type RunRecord,
  type TrustedSource,
  judgeArtifact,
  judgeRun,
  main,
  selectStore,
} from './metro-cache-select';

const NAME = 'metro-ota-store-0123456789abcdef0123456789abcdef01234567';
const REPO_ID = 4242;
const OPTIONS = { expectedName: NAME, maxBytes: DEFAULT_MAX_BYTES, currentRunId: 999 };
const OTA_PATH = '.github/workflows/mobile-ota-production.yml';
const DEPLOY_PATH = '.github/workflows/production-deploy.yml';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 100,
    path: OTA_PATH,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    created_at: '2026-10-26T10:00:00Z',
    repository: { id: REPO_ID },
    head_repository: { id: REPO_ID },
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 1,
    name: NAME,
    size_in_bytes: 90 * 1024 * 1024,
    expired: false,
    created_at: '2026-10-26T10:05:00Z',
    workflow_run: { id: 100, head_branch: 'main' },
    ...overrides,
  };
}

describe('judgeRun', () => {
  it.each<[string, Partial<RunRecord>]>([
    ['the OTA workflow on main', {}],
    ['the OTA workflow on release/next, from a push', { head_branch: 'release/next', event: 'push' }],
    // Main's staging publish runs as a workflow_call inside production-deploy.yml.
    ['production-deploy on main', { path: DEPLOY_PATH, event: 'push' }],
  ])('accepts %s', (_label, overrides) => {
    expect(judgeRun(run(overrides), 999)).toEqual({ ok: true });
  });

  it.each<[string, Partial<RunRecord>]>([
    ['another workflow file', { path: '.github/workflows/mobile-ota-preview.yml' }],
    ['the renumber bot', { path: '.github/workflows/db-migration-renumber.yml' }],
    ['production-deploy off main', { path: DEPLOY_PATH, head_branch: 'release/next' }],
    ['a feature branch', { head_branch: 'feature/x' }],
    ['a failed run', { conclusion: 'failure' }],
    ['a cancelled run', { conclusion: 'cancelled' }],
    ['a run still in progress', { status: 'in_progress', conclusion: null }],
    ['an issue_comment run', { event: 'issue_comment' }],
    ['a pull_request run', { event: 'pull_request' }],
    ['a run with no event', { event: null }],
    ['a fork', { head_repository: { id: 7 } }],
    ['this run', { id: 999 }],
  ])('rejects %s', (_label, overrides) => {
    expect(judgeRun(run(overrides), 999).ok).toBe(false);
  });
});

describe('judgeArtifact', () => {
  it('accepts an unexpired artifact named for this key, within budget, made by the run', () => {
    expect(judgeArtifact(artifact(), run(), OPTIONS)).toEqual({ ok: true });
  });

  it.each<[string, Partial<ArtifactRecord>]>([
    ['another key', { name: 'metro-ota-store-ffff' }],
    ['expired', { expired: true }],
    ['empty', { size_in_bytes: 0 }],
    ['over the 1 GiB budget', { size_in_bytes: DEFAULT_MAX_BYTES + 1 }],
    ['made by another run', { workflow_run: { id: 101, head_branch: 'main' } }],
    ['without a producing run', { workflow_run: null }],
    ['on another branch than its run', { workflow_run: { id: 100, head_branch: 'release/next' } }],
  ])('rejects one that is %s', (_label, overrides) => {
    expect(judgeArtifact(artifact(overrides), run(), OPTIONS).ok).toBe(false);
  });
});

describe('selectStore', () => {
  const runsBySource = (runs: Record<string, RunRecord[]>) => async (source: TrustedSource) =>
    runs[`${source.workflowFile}@${source.branch}`] ?? [];

  it('asks only the trusted workflows on their trusted branches', async () => {
    const listRuns = vi.fn(async (_source: TrustedSource): Promise<RunRecord[]> => []);
    await selectStore(listRuns, async () => [], OPTIONS);
    expect(listRuns.mock.calls.map(([source]) => `${source.workflowFile}@${source.branch}`)).toEqual([
      'mobile-ota-production.yml@main',
      'mobile-ota-production.yml@release/next',
      'production-deploy.yml@main',
    ]);
  });

  it('takes the newest trusted run that carries a usable artifact', async () => {
    const deployNoOta = run({ id: 300, path: DEPLOY_PATH, event: 'push', created_at: '2026-10-26T12:00:00Z' });
    const train = run({ id: 200, head_branch: 'release/next', event: 'push', created_at: '2026-10-26T11:00:00Z' });
    const olderMain = run({ id: 100, created_at: '2026-10-26T09:00:00Z' });
    const artifactsByRun: Record<number, ArtifactRecord[]> = {
      300: [],
      200: [artifact({ id: 20, workflow_run: { id: 200, head_branch: 'release/next' } })],
      100: [artifact({ id: 10 })],
    };
    const chosen = await selectStore(
      runsBySource({
        'mobile-ota-production.yml@main': [olderMain],
        'mobile-ota-production.yml@release/next': [train],
        'production-deploy.yml@main': [deployNoOta],
      }),
      async (runId) => artifactsByRun[runId] ?? [],
      OPTIONS,
    );
    expect(chosen?.run.id).toBe(200);
    expect(chosen?.artifact.id).toBe(20);
  });

  it('never asks an untrusted run for artifacts, even one listed under a trusted workflow', async () => {
    const listArtifacts = vi.fn(async (runId: number) => [
      artifact({ id: runId, workflow_run: { id: runId, head_branch: 'main' } }),
    ]);
    const chosen = await selectStore(
      runsBySource({
        'mobile-ota-production.yml@main': [
          run({ id: 101, conclusion: 'failure' }),
          run({ id: 102, event: 'issue_comment' }),
          run({ id: 103, head_repository: { id: 7 } }),
          run({ id: 999 }),
        ],
      }),
      listArtifacts,
      OPTIONS,
    );
    expect(chosen).toBeNull();
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it('skips an oversized artifact and keeps looking in older runs', async () => {
    const chosen = await selectStore(
      runsBySource({
        'mobile-ota-production.yml@main': [
          run({ id: 2, created_at: '2026-10-26T11:00:00Z' }),
          run({ id: 1, created_at: '2026-10-26T10:00:00Z' }),
        ],
      }),
      async (runId) => [
        artifact({
          id: runId,
          workflow_run: { id: runId, head_branch: 'main' },
          size_in_bytes: runId === 2 ? DEFAULT_MAX_BYTES + 1 : 1024,
        }),
      ],
      OPTIONS,
    );
    expect(chosen?.run.id).toBe(1);
  });

  it('stops after a bounded number of run lookups', async () => {
    const many = Array.from({ length: MAX_RUN_LOOKUPS + 10 }, (_, index) =>
      run({ id: 1000 + index, created_at: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString() }),
    );
    const listArtifacts = vi.fn(async (_runId: number): Promise<ArtifactRecord[]> => []);
    expect(await selectStore(runsBySource({ 'mobile-ota-production.yml@main': many }), listArtifacts, OPTIONS)).toBe(
      null,
    );
    expect(listArtifacts).toHaveBeenCalledTimes(MAX_RUN_LOOKUPS);
    // Newest first.
    expect(listArtifacts.mock.calls[0]).toEqual([1000 + MAX_RUN_LOOKUPS + 9]);
  });
});

describe('main', () => {
  const originalFetch = globalThis.fetch;
  let workspace = '';
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  });

  function stubApi(runsByWorkflow: Record<string, RunRecord[]>, artifactsByRun: Record<number, ArtifactRecord[]>) {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      const runsMatch = /\/actions\/workflows\/([^/]+)\/runs\?branch=([^&]+)/.exec(url);
      if (runsMatch) {
        const key = `${runsMatch[1]}@${decodeURIComponent(runsMatch[2])}`;
        return new Response(JSON.stringify({ workflow_runs: runsByWorkflow[key] ?? [] }), { status: 200 });
      }
      const artifactsMatch = /\/actions\/runs\/(\d+)\/artifacts\?/.exec(url);
      const artifacts = artifactsMatch ? (artifactsByRun[Number(artifactsMatch[1])] ?? []) : [];
      return new Response(JSON.stringify({ artifacts }), { status: 200 });
    }) as typeof fetch;
    return requested;
  }

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    workspace = mkdtempSync(join(tmpdir(), 'metro-select-'));
    return {
      NODE_ENV: 'test',
      GITHUB_REPOSITORY: 'boardsesh/boardsesh',
      GITHUB_API_URL: 'https://api.example',
      GH_TOKEN: 'token',
      GITHUB_RUN_ID: '999',
      METRO_STORE_ARTIFACT: NAME,
      GITHUB_OUTPUT: join(workspace, 'output'),
      ...extra,
    };
  }

  const outputs = (processEnv: NodeJS.ProcessEnv) => {
    try {
      return readFileSync(processEnv.GITHUB_OUTPUT ?? '', 'utf8');
    } catch {
      return '';
    }
  };

  it('lists successful runs per trusted workflow and branch, then asks each run for this key', async () => {
    const requested = stubApi({ 'mobile-ota-production.yml@main': [run()] }, { 100: [artifact({ id: 7 })] });
    const processEnv = env();
    await main(processEnv);
    expect(outputs(processEnv)).toBe('run_id=100\nartifact_id=7\n');
    const base = 'https://api.example/repos/boardsesh/boardsesh/actions';
    const runQuery = `status=success&exclude_pull_requests=true&per_page=${MAX_RUN_LOOKUPS}`;
    expect(requested).toEqual([
      `${base}/workflows/mobile-ota-production.yml/runs?branch=main&${runQuery}`,
      `${base}/workflows/mobile-ota-production.yml/runs?branch=release%2Fnext&${runQuery}`,
      `${base}/workflows/production-deploy.yml/runs?branch=main&${runQuery}`,
      `${base}/runs/100/artifacts?name=${NAME}&per_page=100`,
    ]);
    // The repository-wide artifact listing, where anyone's same-named upload would compete, is never used.
    expect(requested.some((url) => url.includes('/actions/artifacts'))).toBe(false);
  });

  it('writes nothing when no trusted run carries the artifact', async () => {
    stubApi(
      { 'mobile-ota-production.yml@main': [run({ path: '.github/workflows/mobile-ota-preview.yml' })] },
      {
        100: [artifact()],
      },
    );
    const processEnv = env();
    await main(processEnv);
    expect(outputs(processEnv)).toBe('');
  });

  it('does nothing without a token or a metro-ota-store name', async () => {
    const requested = stubApi({ 'mobile-ota-production.yml@main': [run()] }, { 100: [artifact()] });
    await main(env({ GH_TOKEN: '' }));
    await main(env({ METRO_STORE_ARTIFACT: 'live-store-runtimes' }));
    expect(requested).toEqual([]);
  });

  it('honours a smaller size budget', async () => {
    stubApi({ 'mobile-ota-production.yml@main': [run()] }, { 100: [artifact({ size_in_bytes: 2048 })] });
    const processEnv = env({ METRO_CACHE_MAX_BYTES: '1024' });
    await main(processEnv);
    expect(outputs(processEnv)).toBe('');
  });
});
