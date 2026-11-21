/// <reference types="node" />
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import controller from '../lib/expo-web-preview-controller.cjs';

const HEAD = 'a'.repeat(40);
const TRUSTED = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const pullRequest = {
    number: 42,
    state: 'open',
    head: { sha: HEAD, repo: { full_name: 'boardsesh/boardsesh' } },
    base: { ref: 'main', repo: { full_name: 'boardsesh/boardsesh' } },
  };
  const request = {
    id: 10,
    sha: HEAD,
    task: 'expo-web-preview-request',
    environment: 'expo-web-preview-request-42',
    creator: { login: 'github-actions[bot]' },
    payload: {
      version: 1,
      prNumber: 42,
      headSha: HEAD,
      headRepository: 'boardsesh/boardsesh',
      trustedSha: TRUSTED,
      sandboxRef: 'ci-sandbox/web-preview/pr-42/9001',
      commentId: 55,
    },
  };
  const run = {
    id: 100,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'boardsesh/boardsesh' },
    head_repository: { full_name: 'boardsesh/boardsesh' },
    path: '.github/workflows/expo-web-preview.yml',
    head_sha: TRUSTED,
    head_branch: 'ci-sandbox/web-preview/pr-42/9001',
    html_url: 'https://github.com/boardsesh/boardsesh/actions/runs/100',
  };
  const context = {
    eventName: 'workflow_run',
    ref: 'refs/heads/main',
    sha: TRUSTED,
    repo: { owner: 'boardsesh', repo: 'boardsesh' },
    runId: 9001,
    payload: {
      repository: { default_branch: 'main' },
      inputs: { pr: '42', sha: HEAD, request: '10', refresh: 'false', source_run_id: '100' },
      workflow_run: run,
      pull_request: { number: 42 },
      issue: { number: 42, pull_request: {} },
      comment: { id: 55, body: `/web-preview ${HEAD}`, user: { login: 'maintainer' } },
    },
  };
  const core = { setOutput: vi.fn(), info: vi.fn(), warning: vi.fn(), notice: vi.fn() };
  const comments: Array<{ id: number; user: { login: string }; body: string }> = [];
  const github = {
    paginate: vi.fn(async (_endpoint: unknown, options: Record<string, unknown>) => {
      if ('pull_number' in options) return [{ filename: 'packages/mobile/app/index.tsx' }];
      if ('issue_number' in options) return comments;
      if ('run_id' in options) return [{ name: `expo-web-preview-42-${HEAD}`, expired: false }];
      return options.task === 'expo-web-preview-request' ? [request] : [];
    }),
    rest: {
      pulls: { get: vi.fn(async () => ({ data: pullRequest })), listFiles: vi.fn() },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
        updateComment: vi.fn(),
        getComment: vi.fn(async () => ({
          data: {
            issue_url: 'https://api.github.com/repos/boardsesh/boardsesh/issues/42',
            body: `/web-preview ${HEAD}`,
            user: { login: 'maintainer' },
          },
        })),
      },
      repos: {
        listDeployments: vi.fn(),
        getDeployment: vi.fn(async () => ({ data: request })),
        createDeployment: vi.fn(async () => ({ data: { id: 20 } })),
        createDeploymentStatus: vi.fn(),
        listDeploymentStatuses: vi.fn(async () => ({ data: [{ state: 'success' }] })),
        getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: 'write' } })),
        compareCommitsWithBasehead: vi.fn(async () => ({
          data: { status: 'ahead', files: [{ filename: 'packages/backend/src/index.ts' }] },
        })),
      },
      actions: {
        listWorkflowRunArtifacts: vi.fn(),
        getWorkflowRun: vi.fn(async () => ({ data: run })),
        createWorkflowDispatch: vi.fn(),
      },
    },
  };
  const cloudflare = {
    ensureProject: vi.fn(),
    ensurePreviewDomain: vi.fn(),
    removePreview: vi.fn(),
    listPreviews: vi.fn(async () => [] as Array<{ prNumber: number; createdOn: string }>),
    smokePreview: vi.fn(async () => 'https://pr-42.boardsesh.com'),
  };
  return {
    github,
    context,
    core,
    cloudflare,
    pullRequest,
    request,
    run,
    comments,
    trustedSha: TRUSTED,
    handoff: vi.fn(),
  };
}

function artifact() {
  const root = mkdtempSync(join(tmpdir(), 'web-preview-controller-'));
  directories.push(root);
  const directory = join(root, 'export');
  mkdirSync(join(directory, '_expo'), { recursive: true });
  mkdirSync(join(directory, 'wasm'));
  writeFileSync(join(directory, 'index.html'), '<html></html>');
  writeFileSync(join(directory, 'wasm', 'board_renderer_wasm_bg.wasm'), 'wasm');
  return { directory, hostDirectory: join(root, 'host'), trustedDirectory: resolve(import.meta.dirname, '../..') };
}

describe('trusted preview requests', () => {
  it('retires a first-build request and updates its comment when retargeted away', async () => {
    const options = fixture();
    options.context.eventName = 'pull_request_target';
    options.pullRequest.base.ref = 'release/next';
    options.github.rest.repos.listDeploymentStatuses.mockResolvedValue({ data: [{ state: 'in_progress' }] });
    options.comments.push({
      id: 7,
      user: { login: 'github-actions[bot]' },
      body: '<!-- boardsesh:expo-web-preview -->\nBuilding',
    });
    await controller.runLifecycle(options);
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 10, state: 'inactive' }),
    );
    expect(options.github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 7, body: expect.stringContaining('Browser preview removed') }),
    );
    expect(options.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(options.cloudflare.removePreview).not.toHaveBeenCalled();
    expect(options.handoff).not.toHaveBeenCalled();
  });

  it('does not add a preview comment to unrelated PRs', async () => {
    const options = fixture();
    options.context.eventName = 'pull_request_target';
    options.pullRequest.base.ref = 'release/next';
    options.github.paginate.mockResolvedValue([]);
    await controller.runLifecycle(options);
    expect(options.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(options.github.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(options.cloudflare.removePreview).not.toHaveBeenCalled();
  });

  it.each(['workflow_dispatch', 'issue_comment'])(
    'does not build another base branch through %s',
    async (eventName) => {
      const options = fixture();
      options.context.eventName = eventName;
      options.pullRequest.base.ref = 'release/next';
      await controller.runLifecycle(options);
      expect(options.handoff).not.toHaveBeenCalled();
      expect(options.github.rest.repos.createDeployment).not.toHaveBeenCalled();
    },
  );

  it('uses the repository default branch rather than assuming a base name', async () => {
    const options = fixture();
    options.context.payload.repository.default_branch = 'trunk';
    options.pullRequest.base.ref = 'trunk';
    await expect(controller.reconcilePullRequest({ ...options, number: 42 })).resolves.toBe('build');
    expect(options.handoff).toHaveBeenCalledOnce();
  });

  it('daily cleanup reconciles a hosted PR retargeted away from the default branch', async () => {
    const options = fixture();
    options.context.eventName = 'schedule';
    options.pullRequest.base.ref = 'release/next';
    options.cloudflare.listPreviews.mockResolvedValue([{ prNumber: 42, createdOn: new Date().toISOString() }]);
    await controller.runLifecycle(options);
    expect(options.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'expo-web-preview-lifecycle.yml',
        inputs: { pr: '42', refresh: 'true' },
      }),
    );
    options.context.eventName = 'workflow_dispatch';
    options.context.payload.inputs.refresh = 'true';
    await controller.runLifecycle(options);
    expect(options.cloudflare.removePreview).toHaveBeenCalledWith(42);
    expect(options.handoff).not.toHaveBeenCalled();
  });

  it('hands same-repository app PRs to a sandbox bound to exact source and control SHAs', async () => {
    const options = fixture();
    await expect(controller.reconcilePullRequest({ ...options, number: 42 })).resolves.toBe('build');
    expect(options.github.rest.repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: HEAD,
        task: 'expo-web-preview-request',
        payload: expect.objectContaining({ headSha: HEAD, trustedSha: TRUSTED }),
      }),
    );
    expect(options.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: TRUSTED,
        inputs: { pr: '42', sha: HEAD, request: '20' },
        workflowKey: 'web-preview',
      }),
    );
  });

  it('skips unrelated PRs without requesting builds or Cloudflare credentials', async () => {
    const options = fixture();
    options.github.paginate.mockImplementation(async (_endpoint, params) =>
      'pull_number' in params ? [{ filename: 'docs/readme.md' }] : [],
    );
    await expect(controller.reconcilePullRequest({ ...options, number: 42 })).resolves.toBe('cleanup');
    expect(options.handoff).not.toHaveBeenCalled();
    expect(options.cloudflare.removePreview).not.toHaveBeenCalled();
  });

  it('includes previous filenames so moved app code still qualifies', async () => {
    const options = fixture();
    options.github.paginate.mockResolvedValue([
      { filename: 'docs/moved.md', previous_filename: 'packages/mobile/app/index.tsx' },
    ] as never);
    expect(await controller.changedPaths(options.github, options.context, 42)).toContain(
      'packages/mobile/app/index.tsx',
    );
  });

  it('never treats a truncated PR file listing as complete', async () => {
    const options = fixture();
    options.github.paginate.mockResolvedValue(
      Array.from({ length: 3000 }, () => ({ filename: 'docs/readme.md' })) as never,
    );
    await expect(controller.changedPaths(options.github, options.context, 42)).rejects.toThrow('complete changed-file');
  });

  it('prompts forks with the full SHA and performs no privileged upload', async () => {
    const options = fixture();
    options.pullRequest.head.repo.full_name = 'contributor/boardsesh';
    await expect(controller.reconcilePullRequest({ ...options, number: 42 })).resolves.toBe('awaiting-approval');
    expect(options.handoff).not.toHaveBeenCalled();
    expect(options.github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(`/web-preview ${HEAD}`) }),
    );
  });

  it.each([`/web-preview`, `/web-preview ${PREVIOUS}`])('refuses queued or unbound fork approval %s', async (body) => {
    const options = fixture();
    options.context.eventName = 'issue_comment';
    options.context.payload.comment.body = body;
    options.pullRequest.head.repo.full_name = 'contributor/boardsesh';
    await expect(controller.runLifecycle(options)).rejects.toThrow('Approval must name');
    expect(options.handoff).not.toHaveBeenCalled();
  });

  it('checks current maintainer permission before dispatching fork code', async () => {
    const options = fixture();
    options.context.eventName = 'issue_comment';
    options.github.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'read' } });
    await expect(controller.runLifecycle(options)).rejects.toThrow('write permission');
    expect(options.handoff).not.toHaveBeenCalled();
  });

  it('daily cleanup dispatches the per-PR lock instead of deleting directly', async () => {
    const options = fixture();
    options.context.eventName = 'schedule';
    options.pullRequest.state = 'closed';
    options.cloudflare.listPreviews.mockResolvedValue([{ prNumber: 42, createdOn: new Date().toISOString() }]);
    await controller.runLifecycle(options);
    expect(options.cloudflare.removePreview).not.toHaveBeenCalled();
    expect(options.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'expo-web-preview-lifecycle.yml',
        inputs: { pr: '42', refresh: 'true' },
      }),
    );
  });
});

describe('source and artifact provenance', () => {
  it('does not build or accept an artifact after the PR changes its base', async () => {
    const options = fixture();
    options.pullRequest.base.ref = 'release/next';
    await expect(controller.sourceRequest(options.github, options.context)).resolves.toBeNull();
    options.context.eventName = 'workflow_dispatch';
    options.context.ref = `refs/heads/${options.request.payload.sandboxRef}`;
    await controller.inspectBuild(options);
    expect(options.core.setOutput).not.toHaveBeenCalledWith('build', 'true');
  });

  it('accepts GitHub workflow paths with an explicit ref suffix', async () => {
    const options = fixture();
    options.run.path += '@refs/heads/ci-sandbox/web-preview/pr-42/9001';
    await expect(controller.sourceRequest(options.github, options.context)).resolves.not.toBeNull();
  });

  it('terminalizes a first-build request on close without needing Cloudflare credentials', async () => {
    const options = fixture();
    options.pullRequest.state = 'closed';
    options.github.rest.repos.listDeploymentStatuses.mockResolvedValue({ data: [{ state: 'in_progress' }] });
    await controller.reconcilePullRequest({ ...options, number: 42 });
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 10, state: 'inactive' }),
    );
    expect(options.cloudflare.removePreview).not.toHaveBeenCalled();
  });

  it('terminalizes superseded pending requests before creating the next build', async () => {
    const options = fixture();
    options.request.sha = options.request.payload.headSha = PREVIOUS;
    options.github.rest.repos.listDeploymentStatuses.mockResolvedValue({ data: [{ state: 'in_progress' }] });
    await controller.reconcilePullRequest({ ...options, number: 42 });
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 10, state: 'inactive' }),
    );
    expect(options.handoff).toHaveBeenCalledOnce();
  });

  it('refuses a fork push between permission checking and request creation', async () => {
    const options = fixture();
    options.context.eventName = 'issue_comment';
    options.pullRequest.head.repo.full_name = 'contributor/boardsesh';
    options.github.rest.pulls.get.mockImplementationOnce(async () => ({ data: structuredClone(options.pullRequest) }));
    options.github.rest.pulls.get.mockImplementationOnce(async () => ({
      data: { ...options.pullRequest, head: { ...options.pullRequest.head, sha: PREVIOUS } },
    }));
    await expect(controller.runLifecycle(options)).rejects.toThrow('advanced after');
    expect(options.handoff).not.toHaveBeenCalled();
  });

  it('allows an exact trusted sandbox build but never a default-branch source checkout', async () => {
    const options = fixture();
    options.context.eventName = 'workflow_dispatch';
    options.context.ref = `refs/heads/${options.request.payload.sandboxRef}`;
    await controller.inspectBuild(options);
    expect(options.core.setOutput).toHaveBeenCalledWith('build', 'true');
    options.context.ref = 'refs/heads/main';
    await expect(controller.inspectBuild(options)).rejects.toThrow('trusted sandbox request');
  });

  it('rejects a forged request creator and mismatched sandbox control SHA', async () => {
    const options = fixture();
    expect(controller.validRequest(options.request, 42)).toBe(true);
    options.request.creator.login = 'contributor';
    expect(controller.validRequest(options.request, 42)).toBe(false);
    await expect(controller.sourceRequest(options.github, options.context)).rejects.toThrow('matching trusted');
  });

  it('drops an older completion after a push or PR close', async () => {
    const options = fixture();
    options.pullRequest.head.sha = PREVIOUS;
    await expect(controller.sourceRequest(options.github, options.context)).resolves.toBeNull();
    options.pullRequest.head.sha = HEAD;
    options.pullRequest.state = 'closed';
    await expect(controller.sourceRequest(options.github, options.context)).resolves.toBeNull();
  });

  it('validates the authoritative dispatched source run rather than caller-supplied metadata', async () => {
    const options = fixture();
    options.context.eventName = 'workflow_dispatch';
    await controller.inspectPublish({ ...options, inspectOnly: true });
    expect(options.github.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 100 }));
    expect(options.core.setOutput).toHaveBeenCalledWith('publish', 'true');
    expect(options.github.rest.repos.createDeploymentStatus).not.toHaveBeenCalled();
  });

  it('keeps unlocked failed-build inspection read-only, then reports failure inside the lock', async () => {
    const options = fixture();
    options.run.conclusion = 'failure';
    await controller.inspectPublish({ ...options, inspectOnly: true });
    expect(options.core.setOutput).toHaveBeenCalledWith('pr_number', '42');
    expect(options.github.rest.issues.createComment).not.toHaveBeenCalled();
    await controller.inspectPublish(options);
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure' }),
    );
  });

  it('rejects publishing when the source artifact is missing', async () => {
    const options = fixture();
    options.github.paginate.mockImplementation(async (_endpoint, params) => {
      if ('run_id' in params) return [];
      if ('pull_number' in params) return [{ filename: 'packages/mobile/app/index.tsx' }];
      return [options.request] as never;
    });
    await expect(controller.inspectPublish(options)).rejects.toThrow('expected browser artifact');
  });

  it('rechecks exact fork approval content and permission before accepting an artifact', async () => {
    const options = fixture();
    options.pullRequest.head.repo.full_name = options.request.payload.headRepository = 'contributor/boardsesh';
    options.github.rest.issues.getComment.mockResolvedValue({
      data: {
        issue_url: 'https://api.github.com/repos/boardsesh/boardsesh/issues/42',
        body: `/web-preview ${PREVIOUS}`,
        user: { login: 'maintainer' },
      },
    });
    await expect(controller.sourceRequest(options.github, options.context)).rejects.toThrow('does not name');
  });

  it('replaces artifact-controlled server code and hosting policy with trusted files', () => {
    const paths = artifact();
    writeFileSync(join(paths.directory, '_worker.js'), 'throw new Error("must never execute");');
    writeFileSync(join(paths.directory, '_redirects'), '/* https://example.com 302');
    controller.prepareArtifact(paths.directory, paths.trustedDirectory, 42, HEAD, paths.hostDirectory);
    expect(() => readFileSync(join(paths.directory, '_worker.js'))).toThrow();
    expect(readFileSync(join(paths.directory, '_redirects'), 'utf8')).toContain('/index.html');
    expect(JSON.parse(readFileSync(join(paths.directory, 'preview-meta.json'), 'utf8'))).toEqual({
      prNumber: 42,
      sha: HEAD,
    });
    expect(readFileSync(join(paths.hostDirectory, 'functions/_middleware.ts'), 'utf8')).toContain('ASSET_PREFIXES');
  });

  it('rejects symlinks before privileged hosting tooling sees the artifact', () => {
    const paths = artifact();
    symlinkSync('/etc', join(paths.directory, 'escape'));
    expect(() =>
      controller.prepareArtifact(paths.directory, paths.trustedDirectory, 42, HEAD, paths.hostDirectory),
    ).toThrow('regular files');
  });
});

describe('reuse and publication', () => {
  it('does not activate a hostname when the base changes during upload', async () => {
    const options = fixture();
    await controller.publish({
      ...options,
      ...artifact(),
      upload: async () => {
        options.pullRequest.base.ref = 'release/next';
      },
    });
    expect(options.cloudflare.ensurePreviewDomain).not.toHaveBeenCalled();
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'inactive' }),
    );
  });

  it('uploads an inert retirement page using a reserved provider marker and cleans its files', async () => {
    let uploadedDirectory = '';
    const upload = vi.fn(
      async (options: {
        directory: string;
        hostDirectory: string;
        number: number;
        sha: string;
        commitMessage: string;
      }) => {
        uploadedDirectory = options.directory;
        expect(options.number).toBe(42);
        expect(options.sha).toBe('0'.repeat(40));
        expect(options.commitMessage).toBe('boardsesh:retired-web-preview:v1');
        expect(options.hostDirectory).toBe(options.directory);
        const html = readFileSync(join(options.directory, 'index.html'), 'utf8');
        expect(html).toContain('This preview is closed');
        expect(html).not.toMatch(/<script|ws\.boardsesh\.com|www\.boardsesh\.com/);
        expect(readdirSync(options.directory)).toEqual(
          expect.arrayContaining(['index.html', '_headers', '_redirects', 'robots.txt', 'preview-meta.json']),
        );
        expect(existsSync(join(options.directory, 'functions'))).toBe(false);
        expect(readFileSync(join(options.directory, '_headers'), 'utf8')).toContain('no-store');
        expect(JSON.parse(readFileSync(join(options.directory, 'preview-meta.json'), 'utf8'))).toEqual({
          prNumber: 42,
          retired: true,
        });
      },
    );
    await controller.retirePreview(42, { upload });
    expect(upload).toHaveBeenCalledOnce();
    expect(existsSync(uploadedDirectory)).toBe(false);
  });

  it.each([
    ['matching deployed revision', PREVIOUS, 'reuse'],
    ['superseded or failed upload replaced the branch', HEAD, 'build'],
    ['expired deployment', null, 'build'],
  ])('checks the live host before reuse: %s', async (_scenario, servedSha, expected) => {
    const options = fixture();
    const previous = {
      id: 8,
      sha: PREVIOUS,
      task: 'expo-web-preview',
      creator: { login: 'github-actions[bot]' },
      payload: { version: 1, prNumber: 42 },
    };
    options.github.paginate.mockImplementation(async (_endpoint, params) => {
      if ('pull_number' in params) return [{ filename: 'packages/mobile/app/index.tsx' }];
      if (params.task === 'expo-web-preview') return [previous] as never;
      if (params.task === 'expo-web-preview-request') return [options.request] as never;
      return [];
    });
    const fetchPreview = vi.fn(async () =>
      servedSha
        ? new Response(JSON.stringify({ prNumber: 42, sha: servedSha }), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('Not found', { status: 404 }),
    );
    await expect(controller.reconcilePullRequest({ ...options, number: 42, fetchPreview })).resolves.toBe(expected);
    expect(fetchPreview).toHaveBeenCalledWith(
      'https://pr-42.boardsesh.com/preview-meta.json',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    );
    expect(options.handoff).toHaveBeenCalledTimes(expected === 'build' ? 1 : 0);
  });

  it('reuses backend-only pushes but rebuilds app-input changes or uncertain comparisons', async () => {
    const { github, context } = fixture();
    await expect(controller.appInputsUnchanged(github, context, PREVIOUS, HEAD)).resolves.toBe(true);
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { status: 'ahead', files: [{ filename: 'packages/shared/queue/src/index.ts' }] },
    });
    await expect(controller.appInputsUnchanged(github, context, PREVIOUS, HEAD)).resolves.toBe(false);
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { status: 'diverged', files: [] } });
    await expect(controller.appInputsUnchanged(github, context, PREVIOUS, HEAD)).resolves.toBe(false);
  });

  it('marks ready only after stable-host certificate/content smoke succeeds', async () => {
    const options = fixture();
    const upload = vi.fn();
    await controller.publish({ ...options, ...artifact(), upload });
    expect(upload).toHaveBeenCalledOnce();
    expect(options.cloudflare.smokePreview).toHaveBeenCalledWith(42, HEAD);
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success', environment_url: 'https://pr-42.boardsesh.com' }),
    );
  });

  it('does not mark TLS/asset failures ready and publishes an actionable failure', async () => {
    const options = fixture();
    options.cloudflare.smokePreview.mockRejectedValue(new Error('certificate expired'));
    await expect(controller.publish({ ...options, ...artifact(), upload: vi.fn() })).rejects.toThrow(
      'certificate expired',
    );
    expect(options.github.rest.repos.createDeploymentStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' }),
    );
    expect(options.github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('could not be published') }),
    );
  });

  it('does not activate a hostname if the PR changes while uploading', async () => {
    const options = fixture();
    await controller.publish({
      ...options,
      ...artifact(),
      upload: async () => {
        options.pullRequest.head.sha = PREVIOUS;
      },
    });
    expect(options.cloudflare.ensurePreviewDomain).not.toHaveBeenCalled();
    expect(options.cloudflare.smokePreview).not.toHaveBeenCalled();
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 20, state: 'inactive' }),
    );
    expect(options.github.rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 10, state: 'inactive' }),
    );
    expect(options.github.rest.repos.createDeploymentStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' }),
    );
  });
});
