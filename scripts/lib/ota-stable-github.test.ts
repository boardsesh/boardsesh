/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStableGithubClient,
  parseTrustedArtifact,
  parseTrustedRun,
  SOURCE_WORKFLOW,
  STABLE_WORKFLOW,
} from './ota-stable-github';

const repository = 'boardsesh/boardsesh';
const headSha = 'a'.repeat(40);
const nowMs = Date.parse('2026-10-09T00:00:00Z');
const runInput = (runId: number, workflow = STABLE_WORKFLOW, overrides: Record<string, unknown> = {}) => ({
  id: runId,
  path: workflow,
  head_branch: 'main',
  head_sha: headSha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  event: workflow === SOURCE_WORKFLOW ? 'push' : 'schedule',
  status: 'completed',
  conclusion: 'success',
  display_title: 'OTA stable tick',
  ...overrides,
});
const artifactInput = (runId: number, name: string, overrides: Record<string, unknown> = {}) => ({
  id: runId * 10,
  name,
  expired: false,
  expires_at: '2026-11-09T00:00:00Z',
  size_in_bytes: 100,
  workflow_run: { id: runId, head_sha: headSha, head_branch: 'main' },
  ...overrides,
});

function mockClient(responses: Record<string, unknown>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const requestUrl = input instanceof Request ? input.url : input;
    const pathname = new URL(requestUrl).pathname;
    const matched = Object.entries(responses).find(([suffix]) => pathname.endsWith(suffix));
    if (!matched) throw new Error(`Unexpected API request: ${pathname}`);
    return new Response(JSON.stringify(matched[1]));
  });
  return {
    client: createStableGithubClient({ repository, token: 'test-token', fetchImpl, nowMs: () => nowMs }),
    fetchImpl,
  };
}

afterEach(() => vi.useRealTimers());

describe('trusted workflow and artifact provenance', () => {
  it('accepts only main push source runs and controlled stable commands', () => {
    expect(parseTrustedRun(runInput(12, SOURCE_WORKFLOW), repository, SOURCE_WORKFLOW)).toMatchObject({
      runId: 12,
      headSha,
      command: null,
    });
    for (const command of ['prepare', 'tick', 'plan', 'qualify', 'abort']) {
      expect(
        parseTrustedRun(
          runInput(12, STABLE_WORKFLOW, { display_title: `OTA stable ${command}` }),
          repository,
          STABLE_WORKFLOW,
        ).command,
      ).toBe(command);
    }
  });

  it.each([
    { path: '.github/workflows/evil.yml' },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { head_sha: 'main' },
    { id: '1; echo injected' },
    { head_repository: { full_name: 'attacker/boardsesh' } },
    { repository: { full_name: 'other/repo' } },
    { display_title: 'OTA stable tick ; injected' },
    { status: undefined },
  ])('refuses tampered stable run metadata: %j', (overrides) => {
    expect(() => parseTrustedRun(runInput(12, STABLE_WORKFLOW, overrides), repository, STABLE_WORKFLOW)).toThrow();
  });

  it.each([
    { expired: true },
    { expires_at: '2026-10-08T00:00:00Z' },
    { expires_at: 'invalid' },
    { workflow_run: { id: 11, head_sha: headSha, head_branch: 'main' } },
    { workflow_run: { id: 12, head_sha: 'b'.repeat(40), head_branch: 'main' } },
    { workflow_run: { id: 12, head_sha: headSha, head_branch: 'feature' } },
    { workflow_run: null },
    { size_in_bytes: 0 },
    { id: -1 },
  ])('refuses expired or unrelated artifacts: %j', (overrides) => {
    const run = parseTrustedRun(runInput(12), repository, STABLE_WORKFLOW);
    expect(() =>
      parseTrustedArtifact(
        artifactInput(12, 'mobile-ota-stable-state', overrides),
        run,
        'mobile-ota-stable-state',
        nowMs,
      ),
    ).toThrow();
  });
});

describe('newest eligible artifact selection', () => {
  it('ignores queued future runs and the current run while restoring the latest older checkpoint', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(19, STABLE_WORKFLOW, { status: 'requested', conclusion: null }),
          runInput(18, STABLE_WORKFLOW, { status: 'waiting', conclusion: null }),
          runInput(17, STABLE_WORKFLOW, { status: 'pending', conclusion: null }),
          runInput(16, STABLE_WORKFLOW, { status: 'queued', conclusion: null, display_title: 'OTA stable prepare' }),
          runInput(15, STABLE_WORKFLOW, { status: 'in_progress', conclusion: null }),
          runInput(14),
        ],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['completed', 'in_progress', 'unknown', ''])(
    'holds instead of loading older state behind a future %s writer',
    async (status) => {
      const { client, fetchImpl } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [runInput(16, STABLE_WORKFLOW, { status }), runInput(14)],
        },
        'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
      });
      await expect(client.latestCheckpoint(15)).rejects.toThrow('Newer stable write run 16');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not silently ignore future writers with missing status metadata', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(16, STABLE_WORKFLOW, { status: undefined }), runInput(14)],
      },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('invalid status');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a completed future read-only plan because it cannot replace state', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(16, STABLE_WORKFLOW, { display_title: 'OTA stable plan' }), runInput(14)],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid current run boundary %s',
    async (excludeRunId) => {
      const { client, fetchImpl } = mockClient({});
      await expect(client.latestCheckpoint(excludeRunId)).rejects.toThrow('positive safe integer');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('uses the latest abort checkpoint rather than resurrecting a previous active canary', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable abort' }), runInput(13)],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('holds after an abort whose latest state artifact is missing', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable abort', conclusion: 'failure' }),
          runInput(13),
        ],
      },
      'runs/14/artifacts': { artifacts: [] },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('skips failed and non-OTA deployments, returning the latest complete stage', async () => {
    const { client } = mockClient({
      'production-deploy.yml/runs': {
        workflow_runs: [
          runInput(15, SOURCE_WORKFLOW, { conclusion: 'failure' }),
          runInput(14, SOURCE_WORKFLOW),
          runInput(13, SOURCE_WORKFLOW),
        ],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stage')] },
    });
    await expect(client.latestSource()).resolves.toEqual({ runId: 13, headSha, artifactId: 130 });
  });

  it('never falls back to older staged bytes when the newest stage expired', async () => {
    const { client, fetchImpl } = mockClient({
      'production-deploy.yml/runs': { workflow_runs: [runInput(14, SOURCE_WORKFLOW), runInput(13, SOURCE_WORKFLOW)] },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stage', { expired: true })] },
    });
    await expect(client.latestSource()).rejects.toThrow('expired');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('ignores the current run and read-only plans but accepts the latest failed checkpoint', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(15),
          runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable plan' }),
          runInput(13, STABLE_WORKFLOW, { conclusion: 'failure' }),
        ],
      },
      'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 13 });
  });

  it('bootstraps only when no earlier write-mode runs exist', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(15), runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable plan' })],
      },
    });
    await expect(client.latestCheckpoint(15)).resolves.toBeNull();
  });

  it.each(['failure', 'cancelled', 'timed_out', 'success'])(
    'holds on the latest %s run missing state, without using an older checkpoint',
    async (conclusion) => {
      const { client, fetchImpl } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion }), runInput(13)],
        },
        'runs/14/artifacts': { artifacts: [] },
      });
      await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('holds when an earlier controller is still running or its state expired', async () => {
    const running = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { status: 'in_progress', conclusion: null })],
      },
    });
    await expect(running.client.latestCheckpoint(15)).rejects.toThrow('still in_progress');
    const expired = mockClient({
      'mobile-ota-stable-release.yml/runs': { workflow_runs: [runInput(14)] },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state', { expired: true })] },
    });
    await expect(expired.client.latestCheckpoint(15)).rejects.toThrow('expired');
  });

  it.each([
    { display_title: 'OTA stable tick' },
    { conclusion: 'failure' },
    { event: 'push' },
    { status: 'in_progress', conclusion: null },
    { head_branch: 'feature' },
  ])('refuses candidates outside successful trusted prepare runs: %j', async (overrides) => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable prepare', ...overrides }),
    });
    await expect(client.candidate(14)).rejects.toThrow();
  });

  it('accepts the named candidate only from its successful preparation run', async () => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable prepare' }),
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-candidate')] },
    });
    await expect(client.candidate(14)).resolves.toEqual({ runId: 14, headSha, artifactId: 140 });
  });
});

describe('bounded GitHub reads', () => {
  it('does not forward its token to the signed storage redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.headers
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example/archive.zip?signature=secret' },
          })
        : new Response(new Uint8Array([80, 75])),
    );
    const client = createStableGithubClient({ repository, token: 'test-token', fetchImpl });
    await expect(client.downloadArtifact(14)).resolves.toEqual(new Uint8Array([80, 75]));
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('Authorization', 'Bearer test-token');
    expect(fetchImpl.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1]?.redirect).toBe('error');
  });

  it('times out a stalled JSON body as well as the initial API request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
            },
          }),
        ),
    );
    const client = createStableGithubClient({ repository, token: 'test-token', fetchImpl });
    const pending = expect(client.latestSource()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
