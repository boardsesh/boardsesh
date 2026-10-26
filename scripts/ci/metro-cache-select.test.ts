import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactRecord,
  DEFAULT_MAX_BYTES,
  MAX_CANDIDATES,
  type RunRecord,
  judgeArtifact,
  judgeRun,
  main,
  selectStore,
} from './metro-cache-select';

const NAME = 'metro-ota-store-0123456789abcdef0123456789abcdef01234567';
const REPO_ID = 4242;
const OPTIONS = { expectedName: NAME, maxBytes: DEFAULT_MAX_BYTES, currentRunId: 999 };

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 1,
    name: NAME,
    size_in_bytes: 90 * 1024 * 1024,
    expired: false,
    created_at: '2026-10-26T10:00:00Z',
    workflow_run: { id: 100, head_branch: 'main' },
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 100,
    path: '.github/workflows/mobile-ota-production.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    repository: { id: REPO_ID },
    head_repository: { id: REPO_ID },
    ...overrides,
  };
}

describe('judgeArtifact', () => {
  it('accepts an unexpired artifact named for this key, within budget, from another run', () => {
    expect(judgeArtifact(artifact(), OPTIONS)).toEqual({ ok: true });
  });

  it.each<[string, Partial<ArtifactRecord>]>([
    ['another key', { name: 'metro-ota-store-ffff' }],
    ['expired', { expired: true }],
    ['empty', { size_in_bytes: 0 }],
    ['over the 1 GiB budget', { size_in_bytes: DEFAULT_MAX_BYTES + 1 }],
    ['no producing run', { workflow_run: null }],
    ['made by this run', { workflow_run: { id: 999, head_branch: 'main' } }],
  ])('rejects one that is %s', (_label, overrides) => {
    expect(judgeArtifact(artifact(overrides), OPTIONS).ok).toBe(false);
  });
});

describe('judgeRun', () => {
  it.each<[string, Partial<RunRecord>, Partial<ArtifactRecord>]>([
    ['the OTA workflow on main', {}, {}],
    [
      'the OTA workflow on release/next, from a push',
      { head_branch: 'release/next', event: 'push' },
      { workflow_run: { id: 100, head_branch: 'release/next' } },
    ],
    // Main's staging publish runs as a workflow_call inside production-deploy.yml.
    ['production-deploy on main', { path: '.github/workflows/production-deploy.yml', event: 'push' }, {}],
  ])('accepts %s', (_label, runOverrides, artifactOverrides) => {
    expect(judgeRun(run(runOverrides), artifact(artifactOverrides))).toEqual({ ok: true });
  });

  it.each<[string, Partial<RunRecord>, Partial<ArtifactRecord>]>([
    ['another workflow file', { path: '.github/workflows/mobile-ota-preview.yml' }, {}],
    ['the renumber bot', { path: '.github/workflows/db-migration-renumber.yml' }, {}],
    [
      'production-deploy off main',
      { path: '.github/workflows/production-deploy.yml', head_branch: 'release/next' },
      {},
    ],
    ['a feature branch', { head_branch: 'feature/x' }, { workflow_run: { id: 100, head_branch: 'feature/x' } }],
    ['a failed run', { conclusion: 'failure' }, {}],
    ['a cancelled run', { conclusion: 'cancelled' }, {}],
    ['a run still in progress', { status: 'in_progress', conclusion: null }, {}],
    ['an issue_comment run', { event: 'issue_comment' }, {}],
    ['a pull_request run', { event: 'pull_request' }, {}],
    ['a workflow_call-less unknown event', { event: null }, {}],
    ['a fork', { head_repository: { id: 7 } }, {}],
    ['a run that is not the artifact’s', { id: 101 }, {}],
    ['a branch that disagrees with the artifact', {}, { workflow_run: { id: 100, head_branch: 'release/next' } }],
  ])('rejects %s', (_label, runOverrides, artifactOverrides) => {
    expect(judgeRun(run(runOverrides), artifact(artifactOverrides)).ok).toBe(false);
  });
});

describe('selectStore', () => {
  it('takes the newest artifact whose run passes, skipping untrusted newer ones', async () => {
    const runs: Record<number, RunRecord> = {
      100: run({ id: 100 }),
      101: run({ id: 101, conclusion: 'failure' }),
      102: run({ id: 102, path: '.github/workflows/mobile-ota-preview.yml' }),
    };
    const chosen = await selectStore(
      [
        artifact({ id: 1, created_at: '2026-10-26T08:00:00Z', workflow_run: { id: 100, head_branch: 'main' } }),
        artifact({ id: 2, created_at: '2026-10-26T09:00:00Z', workflow_run: { id: 101, head_branch: 'main' } }),
        artifact({ id: 3, created_at: '2026-10-26T10:00:00Z', workflow_run: { id: 102, head_branch: 'main' } }),
        artifact({ id: 4, created_at: '2026-10-26T11:00:00Z', size_in_bytes: DEFAULT_MAX_BYTES * 2 }),
      ],
      async (runId) => runs[runId],
      OPTIONS,
    );
    expect(chosen?.artifact.id).toBe(1);
    expect(chosen?.run.id).toBe(100);
  });

  it('never looks up the run of an oversized or mismatched artifact', async () => {
    const getRun = vi.fn(async (runId: number) => run({ id: runId }));
    const chosen = await selectStore(
      [artifact({ size_in_bytes: DEFAULT_MAX_BYTES + 1 }), artifact({ name: 'metro-ota-store-other' })],
      getRun,
      OPTIONS,
    );
    expect(chosen).toBeNull();
    expect(getRun).not.toHaveBeenCalled();
  });

  it('stops after a bounded number of run lookups', async () => {
    const getRun = vi.fn(async (runId: number) => run({ id: runId, conclusion: 'failure' }));
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, index) =>
      artifact({ id: index, workflow_run: { id: 1000 + index, head_branch: 'main' } }),
    );
    expect(await selectStore(many, getRun, OPTIONS)).toBeNull();
    expect(getRun).toHaveBeenCalledTimes(MAX_CANDIDATES);
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

  function stubApi(artifacts: ArtifactRecord[], runs: Record<number, RunRecord>): string[] {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      const runMatch = /\/actions\/runs\/(\d+)$/.exec(url);
      const body = runMatch ? runs[Number(runMatch[1])] : { artifacts };
      return new Response(JSON.stringify(body), { status: 200 });
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

  it('writes the chosen run and artifact, asking the API for this key only', async () => {
    const requested = stubApi([artifact({ id: 7 })], { 100: run() });
    const processEnv = env();
    await main(processEnv);
    expect(outputs(processEnv)).toBe('run_id=100\nartifact_id=7\n');
    expect(requested[0]).toBe(
      `https://api.example/repos/boardsesh/boardsesh/actions/artifacts?name=${NAME}&per_page=100`,
    );
  });

  it('writes nothing when no artifact comes from a trusted run', async () => {
    stubApi([artifact()], { 100: run({ path: '.github/workflows/mobile-ota-preview.yml' }) });
    const processEnv = env();
    await main(processEnv);
    expect(outputs(processEnv)).toBe('');
  });

  it('does nothing without a token or a metro-ota-store name', async () => {
    const requested = stubApi([artifact()], { 100: run() });
    await main(env({ GH_TOKEN: '' }));
    await main(env({ METRO_STORE_ARTIFACT: 'live-store-runtimes' }));
    expect(requested).toEqual([]);
  });

  it('honours a smaller size budget before any run lookup', async () => {
    const requested = stubApi([artifact({ size_in_bytes: 2048 })], { 100: run() });
    const processEnv = env({ METRO_CACHE_MAX_BYTES: '1024' });
    await main(processEnv);
    expect(outputs(processEnv)).toBe('');
    expect(requested).toHaveLength(1);
  });
});
