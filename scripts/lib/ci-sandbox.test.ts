import { describe, expect, it, vi } from 'vitest';

import { deleteOwnSandbox, handOffToSandbox, isAnySandboxRef, isSandboxRef, sandboxPrefix } from './ci-sandbox.cjs';

const sha = 'a'.repeat(40);
const repo = { owner: 'boardsesh', repo: 'boardsesh' };

function fakeGitHub(existingRefs: string[] = []) {
  const calls: string[] = [];
  const github = {
    paginate: vi.fn(async (_endpoint: unknown, params: { ref: string }) => {
      calls.push(`list ${params.ref}`);
      return existingRefs.map((ref) => ({ ref }));
    }),
    rest: {
      git: {
        listMatchingRefs: vi.fn(),
        createRef: vi.fn(async ({ ref }: { ref: string }) => {
          calls.push(`create ${ref}`);
        }),
        deleteRef: vi.fn(async ({ ref }: { ref: string }) => {
          calls.push(`delete ${ref}`);
        }),
      },
      actions: {
        createWorkflowDispatch: vi.fn(async ({ ref }: { ref: string }) => {
          calls.push(`dispatch ${ref}`);
        }),
      },
    },
  };
  return { github, calls };
}

const core = { notice: vi.fn(), info: vi.fn() };

describe('sandbox ref names', () => {
  it('builds a per-workflow, per-PR prefix', () => {
    expect(sandboxPrefix('ota-preview', '42')).toBe('ci-sandbox/ota-preview/pr-42/');
  });

  it('rejects names that could escape the prefix', () => {
    expect(() => sandboxPrefix('ota-preview', '42/../main')).toThrow();
    expect(() => sandboxPrefix('../main', '42')).toThrow();
    expect(() => sandboxPrefix('ota-preview', '0')).toThrow();
  });

  it('recognises only this workflow and PR, with a numeric run id', () => {
    expect(isSandboxRef('refs/heads/ci-sandbox/ota-preview/pr-42/123', 'ota-preview', '42')).toBe(true);
    expect(isSandboxRef('refs/heads/ci-sandbox/ota-preview/pr-42/123', 'ota-preview', '4')).toBe(false);
    expect(isSandboxRef('refs/heads/ci-sandbox/ota-preview/pr-421/123', 'ota-preview', '42')).toBe(false);
    expect(isSandboxRef('refs/heads/ci-sandbox/db-renumber/pr-42/123', 'ota-preview', '42')).toBe(false);
    expect(isSandboxRef('refs/heads/ci-sandbox/ota-preview/pr-42/abc', 'ota-preview', '42')).toBe(false);
    expect(isSandboxRef('refs/heads/main', 'ota-preview', '42')).toBe(false);
    expect(isAnySandboxRef('refs/heads/ci-sandbox/ota-preview/pr-42/123', 'ota-preview')).toBe(true);
    expect(isAnySandboxRef('refs/heads/ci-sandbox/ota-preview/pr-42/123', 'db-renumber')).toBe(false);
    expect(isAnySandboxRef('refs/heads/main', 'ota-preview')).toBe(false);
  });
});

describe('handOffToSandbox', () => {
  it('prunes older sandboxes for the PR, then creates a fresh ref and dispatches on it', async () => {
    const { github, calls } = fakeGitHub(['refs/heads/ci-sandbox/ota-preview/pr-42/100']);
    const branch = await handOffToSandbox({
      github,
      context: { repo, runId: 200 },
      core,
      workflowKey: 'ota-preview',
      workflowFile: 'mobile-ota-preview.yml',
      prNumber: '42',
      inputs: { pr: '42' },
      sha,
    });
    expect(branch).toBe('ci-sandbox/ota-preview/pr-42/200');
    expect(calls).toEqual([
      'list heads/ci-sandbox/ota-preview/pr-42/',
      'delete heads/ci-sandbox/ota-preview/pr-42/100',
      'create refs/heads/ci-sandbox/ota-preview/pr-42/200',
      'dispatch ci-sandbox/ota-preview/pr-42/200',
    ]);
    expect(github.rest.git.createRef).toHaveBeenCalledWith({
      ...repo,
      ref: 'refs/heads/ci-sandbox/ota-preview/pr-42/200',
      sha,
    });
    expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith({
      ...repo,
      workflow_id: 'mobile-ota-preview.yml',
      ref: 'ci-sandbox/ota-preview/pr-42/200',
      inputs: { pr: '42' },
    });
  });

  it('removes the fresh ref when the dispatch fails', async () => {
    const { github, calls } = fakeGitHub();
    github.rest.actions.createWorkflowDispatch.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 422 }));
    await expect(
      handOffToSandbox({
        github,
        context: { repo, runId: 7 },
        core,
        workflowKey: 'db-renumber',
        workflowFile: 'db-migration-renumber.yml',
        prNumber: '9',
        inputs: { pr: '9' },
        sha,
      }),
    ).rejects.toThrow('no');
    expect(calls.at(-1)).toBe('delete heads/ci-sandbox/db-renumber/pr-9/7');
  });

  it('refuses anything but a full commit SHA', async () => {
    const { github } = fakeGitHub();
    await expect(
      handOffToSandbox({
        github,
        context: { repo, runId: 7 },
        core,
        workflowKey: 'db-renumber',
        workflowFile: 'db-migration-renumber.yml',
        prNumber: '9',
        inputs: {},
        sha: 'main',
      }),
    ).rejects.toThrow(/full commit SHA/);
    expect(github.rest.git.createRef).not.toHaveBeenCalled();
  });
});

describe('deleteOwnSandbox', () => {
  it('deletes the sandbox the run is executing on', async () => {
    const { github, calls } = fakeGitHub();
    const context = { repo, ref: 'refs/heads/ci-sandbox/ota-preview/pr-42/200' };
    expect(await deleteOwnSandbox({ github, context, core, workflowKey: 'ota-preview' })).toBe(true);
    expect(calls).toEqual(['delete heads/ci-sandbox/ota-preview/pr-42/200']);
  });

  it('never deletes a ref outside its own sandbox namespace', async () => {
    const { github } = fakeGitHub();
    for (const ref of ['refs/heads/main', 'refs/heads/ci-sandbox/db-renumber/pr-42/200', 'refs/pull/42/merge']) {
      expect(await deleteOwnSandbox({ github, context: { repo, ref }, core, workflowKey: 'ota-preview' })).toBe(false);
    }
    expect(github.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('treats an already-deleted ref as done', async () => {
    const { github } = fakeGitHub();
    github.rest.git.deleteRef.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 422 }));
    const context = { repo, ref: 'refs/heads/ci-sandbox/ota-preview/pr-42/200' };
    await expect(deleteOwnSandbox({ github, context, core, workflowKey: 'ota-preview' })).resolves.toBe(true);
  });
});
