/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  with?: { script?: string };
}
interface WorkflowJob {
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  needs?: string[];
  steps: WorkflowStep[];
}
const workflow = parse(
  readFileSync(resolve(import.meta.dirname, '../.github/workflows/mobile-ota-preview.yml'), 'utf8'),
) as { jobs: Record<string, WorkflowJob> };
const mainSha = 'a'.repeat(40);
const trainSha = 'b'.repeat(40);
const headSha = 'c'.repeat(40);
const branch = 'pr-7';
const task = 'ota-preview-pr-7';
const baseContext = () => ({ version: 2, mainSha, sourceBaseRef: 'main', sourceBaseSha: mainSha });
const previousDeployment = () => ({
  id: 123,
  sha: headSha,
  task,
  environment: 'pr-preview',
  description: `OTA preview ${branch}`,
  transient_environment: true,
  production_environment: false,
  payload: { otaPreviewBases: baseContext() },
});

async function executeStep(
  job: string,
  name: string,
  github: unknown,
  env: Record<string, string>,
  eventName = 'pull_request',
) {
  const script = workflow.jobs[job].steps.find((step) => step.name === name)?.with?.script;
  if (!script) throw new Error(`Missing executable workflow step: ${name}`);
  const outputs = new Map<string, unknown>();
  const core = {
    setOutput: (key: string, output: unknown) => outputs.set(key, output),
    setFailed: (message: string) => {
      throw new Error(message);
    },
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
  };
  // Execute the workflow implementation so context reconciliation cannot drift from its tests.
  // oxlint-disable-next-line no-implied-eval
  const run = new Function('github', 'context', 'core', 'process', `return (async () => {\n${script}\n})();`) as (
    github: unknown,
    context: unknown,
    core: unknown,
    process: unknown,
  ) => Promise<void>;
  await run(github, { repo: { owner: 'boardsesh', repo: 'boardsesh' }, eventName }, core, { env });
  return outputs;
}

function fixture(
  options: {
    previous?: unknown;
    status?: string | null;
    main?: string;
    train?: string;
    sourceBaseRef?: string;
    sourceBaseSha?: string;
    nativeReset?: boolean;
  } = {},
) {
  const selectedMain = options.main ?? mainSha;
  const selectedTrain = options.train ?? trainSha;
  const latest = options.previous === undefined ? previousDeployment() : options.previous;
  const repos = {
    getBranch: vi.fn(async ({ branch: ref }: { branch: string }) => {
      if (ref === 'release/next' && selectedTrain === '')
        throw Object.assign(new Error('Train absent'), { status: 404 });
      return { data: { commit: { sha: ref === 'main' ? selectedMain : selectedTrain } } };
    }),
    listDeployments: vi.fn(async () => ({ data: latest === null ? [] : [latest] })),
    listDeploymentStatuses: vi.fn(async () => ({
      data: options.status === null ? [] : [{ state: options.status ?? 'success' }],
    })),
  };
  const pulls = {
    get: vi.fn(async () => ({
      data: {
        state: 'open',
        head: { sha: headSha },
        base: { sha: options.sourceBaseSha ?? selectedMain, ref: options.sourceBaseRef ?? 'main' },
      },
    })),
  };
  const run = (eventName = 'pull_request') =>
    executeStep(
      'gate',
      'Pin the main preview base',
      { rest: { repos, pulls } },
      {
        PR_NUMBER: '7',
        HEAD_SHA: headSha,
        PR_NATIVE_RESET: String(options.nativeReset ?? false),
      },
      eventName,
    );
  return { repos, pulls, run };
}

describe('preview base-context reconciliation', () => {
  it('keeps a successful same-revision retry available when its bases are identical', async () => {
    const { run, repos } = fixture();
    expect((await run()).get('needs_reset')).toBe('false');
    expect(repos.listDeployments).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'pr-preview', task, per_page: 1 }),
    );
    expect(repos.listDeploymentStatuses).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 123, per_page: 1 }),
    );
  });

  it.each(['pull_request', 'workflow_dispatch'])(
    'resets each new JS-only revision on %s before a conflict or failed upload can retain older variants',
    async (eventName) => {
      const previous = { ...previousDeployment(), sha: 'd'.repeat(40) };
      expect((await fixture({ previous }).run(eventName)).get('needs_reset')).toBe('true');
    },
  );

  it.each(['pull_request', 'workflow_dispatch'])(
    'resets changed bases on %s, including a JS push replacing a pending refresh',
    async (eventName) => {
      const { run } = fixture({ main: 'd'.repeat(40) });
      expect((await run(eventName)).get('needs_reset')).toBe('true');
    },
  );
  it.each([{ sourceBaseRef: 'release/next' }, { sourceBaseSha: 'e'.repeat(40) }])(
    'resets when the PR base changes: %j',
    async (change) => {
      expect((await fixture(change).run()).get('needs_reset')).toBe('true');
    },
  );
  it('resets a historical dual-base preview even when main did not move', async () => {
    const previous = previousDeployment();
    Object.assign(previous.payload.otaPreviewBases, { version: 1, trainSha });
    expect((await fixture({ previous }).run()).get('needs_reset')).toBe('true');
  });
  it('still resets native PR revisions even when base metadata matches', async () => {
    expect((await fixture({ nativeReset: true }).run()).get('needs_reset')).toBe('true');
  });
  it.each(['failure', 'error', 'in_progress', 'queued', 'pending', 'inactive', null])(
    'does not reuse an earlier %s attempt that may have changed only some runtime rows',
    async (status) => {
      expect((await fixture({ status }).run()).get('needs_reset')).toBe('true');
    },
  );
  it.each([
    null,
    { ...previousDeployment(), payload: {} },
    { ...previousDeployment(), payload: '{malformed' },
    { ...previousDeployment(), payload: { otaPreviewBases: { ...baseContext(), version: 1, trainSha } } },
    { ...previousDeployment(), description: 'OTA preview pr-8' },
    { ...previousDeployment(), task: 'ota-preview-pr-8' },
    { ...previousDeployment(), production_environment: true },
    { ...previousDeployment(), transient_environment: false },
    { ...previousDeployment(), sha: undefined },
    { ...previousDeployment(), sha: 'missing' },
  ])('resets missing, legacy or invalid previous metadata: %j', async (previous) => {
    expect((await fixture({ previous }).run()).get('needs_reset')).toBe('true');
  });
  it('accepts the GitHub API string form of a valid deployment payload', async () => {
    const previous = { ...previousDeployment(), payload: JSON.stringify(previousDeployment().payload) };
    expect((await fixture({ previous }).run()).get('needs_reset')).toBe('false');
  });
  it('fails closed when deployment history cannot be read', async () => {
    const { run, repos } = fixture();
    repos.listDeployments.mockRejectedValueOnce(new Error('History unavailable'));
    await expect(run()).rejects.toThrow('History unavailable');
  });

  it('records exactly the pinned bases on the per-PR deployment after reset', async () => {
    const repos = {
      createDeployment: vi.fn(async (_input: unknown) => ({ data: { id: 456 } })),
      createDeploymentStatus: vi.fn(async (_input: unknown) => ({})),
    };
    await executeStep(
      'publish',
      'Start deployment (preview building)',
      { rest: { repos } },
      {
        PR_NUMBER: '7',
        BRANCH: branch,
        HEAD_SHA: headSha,
        MAIN_SHA: mainSha,
        SOURCE_BASE_REF: 'main',
        SOURCE_BASE_SHA: mainSha,
      },
    );
    expect(repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: headSha,
        task,
        payload: { otaPreviewBases: baseContext() },
      }),
    );
    expect(workflow.jobs.gate.permissions?.deployments).toBe('read');
    expect(workflow.jobs.gate.outputs?.needs_reset).toBe('${{ steps.pin.outputs.needs_reset }}');
    expect(workflow.jobs.publish.needs).toContain('reset');
  });
});
