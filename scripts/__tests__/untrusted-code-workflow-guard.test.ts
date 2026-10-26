/// <reference types="node" />

// Guard: a workflow that can run in the default branch's context must not check
// out a computed ref (a PR head, a dispatch input, a job output) and then execute
// code from it. Whatever such a run writes to shared Actions storage is visible
// to every branch and PR, and its secrets belong to the default branch.
//
// PR-authored code belongs in a `pull_request` run, or in a run handed off to a
// `ci-sandbox/*` branch (scripts/lib/ci-sandbox.cjs). A checkout that is
// genuinely safe goes in ALLOWED below with the reason a reviewer can check.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; id?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; steps?: Step[]; uses?: string };
type Workflow = { on?: unknown; true?: unknown; jobs?: Record<string, Job> };

const WORKFLOW_DIR = resolve(import.meta.dirname, '../../.github/workflows');

// Events whose runs execute with the default branch's ref, or (workflow_call) the
// caller's, which may be the default branch.
const DEFAULT_BRANCH_EVENTS = new Set([
  'workflow_dispatch',
  'schedule',
  'issue_comment',
  'issues',
  'pull_request_target',
  'workflow_run',
  'workflow_call',
  'merge_group',
  'repository_dispatch',
  'create',
  'delete',
  'release',
]);

// Checkout refs that always resolve to the run's own trusted commit.
const TRUSTED_REF_TERMS = new Set([
  'github.sha',
  'github.workflow_sha',
  'github.ref',
  'github.ref_name',
  'github.event.repository.default_branch',
]);

/**
 * `<workflow file> <checkout ref>` → why executing that checkout cannot run
 * unreviewed code in a default-branch run. Every entry must still match a
 * checkout; stale ones fail.
 */
const ALLOWED: Record<string, string> = {
  'mobile-ota-preview.yml ${{ needs.gate.outputs.head_sha }}':
    'The gate emits action=publish only on a pull_request run (PR-scoped) or on its own ci-sandbox/ota-preview branch; a default-branch dispatch becomes action=handoff. The gate tests below execute it.',
  "mobile-ota-preview.yml ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && needs.gate.outputs.head_sha || github.event.repository.default_branch }}":
    "Resolves to the PR head only on a same-repo pull_request run (the PR's own scope); every other event checks out the default branch.",
  'db-migration-renumber.yml ${{ needs.gate.outputs.branch }}':
    'The gate sets run=true only on its own ci-sandbox/db-renumber branch, and the job holds no secret; a default-branch dispatch sets handoff=true instead. The gate tests below execute it.',
  'mobile-e2e-gate.yml ${{ needs.resolve.outputs.sha }}':
    'resolve refuses a commit outside main history whenever the run itself is on main.',
  'mobile-e2e-gate.yml ${{ needs.resolve.outputs.sha || github.sha }}':
    'resolve refuses a commit outside main history whenever the run itself is on main; the fallback is the run commit.',
  'e2e-tests.yml ${{ inputs.ref }}':
    'Only mobile-e2e-gate.yml passes a ref, after its resolve job checked it; a dispatch leaves it empty (the run ref).',
  'mobile-ota-boot-check.yml ${{ needs.resolve.outputs.commit }}':
    'resolve refuses a commit outside main history when a dispatch runs on main; the daily stable call passes a staged main commit.',
  'mobile-screenshots-ios.yml ${{ github.event.workflow_run.head_sha || github.sha }}':
    'workflow_run is filtered to deploy runs on release/next (the release train); a dispatch checks out its own ref.',
  'mobile-screenshots-ios.yml ${{ needs.setup.outputs.source_sha }}':
    'source_sha is the workflow_run head on release/next, or the dispatch run commit.',
  'mobile-screenshots-android.yml ${{ github.event.workflow_run.head_sha || github.sha }}':
    'workflow_run is filtered to deploy runs on release/next (the release train); a dispatch checks out its own ref.',
  'mobile-store-draft.yml ${{ steps.ref.outputs.sha }}':
    'The live head of main or release/next, or a release_sha proven to be in main history.',
  'mobile-store-draft.yml ${{ steps.candidate.outputs.ios_build_sha }}':
    'The commit behind a build-ios-* tag, which only the release App may create (tag ruleset).',
  'mobile-store-draft.yml ${{ steps.candidate.outputs.android_build_sha }}':
    'The commit behind a build-android-* tag, which only the release App may create (tag ruleset).',
  'mobile-store-draft.yml ${{ needs.release-candidate.outputs.sha }}':
    'The release-candidate job output: the pinned main/release/next head checked above.',
  'postgres-image-publisher.yml ${{ inputs.expected_main_sha }}':
    'validate-main fails unless expected_main_sha equals github.sha and the live main head.',
};

function triggers(workflow: Workflow): Record<string, unknown> {
  // YAML 1.1 reads a bare `on:` key as boolean true.
  const raw = workflow.on ?? workflow.true;
  if (typeof raw === 'string') return { [raw]: null };
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((event: string) => [event, null]));
  return (raw ?? {}) as Record<string, unknown>;
}

function pushReachesMain(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true;
  const { branches, tags } = config as { branches?: string[]; tags?: string[] };
  if (Array.isArray(branches)) return branches.some((branch) => ['main', '*', '**'].includes(branch));
  return !Array.isArray(tags);
}

function runsInDefaultBranchContext(workflow: Workflow): boolean {
  return Object.entries(triggers(workflow)).some(
    ([event, config]) => DEFAULT_BRANCH_EVENTS.has(event) || (event === 'push' && pushReachesMain(config)),
  );
}

/** Terms of a `${{ a || b && 'c' }}` expression, or null for a literal ref. */
function expressionTerms(ref: string): string[] | null {
  const expressions = [...ref.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1] ?? '');
  if (expressions.length === 0) return null;
  return expressions
    .flatMap((expression) => expression.split(/\|\||&&|==|!=|[()!]/))
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !/^'[^']*'$/.test(term) && term !== 'true' && term !== 'false');
}

/** A checkout's `with.ref` as written; YAML may hand back a number for a bare SHA-like value. */
function checkoutRef(step: Step): string {
  const ref = step.with?.ref;
  return typeof ref === 'string' || typeof ref === 'number' ? String(ref).trim() : '';
}

function isTrustedRef(ref: string, workflow: Workflow): boolean {
  if (ref === '') return true;
  const terms = expressionTerms(ref);
  if (terms === null) return true;
  const hasTarget = 'pull_request_target' in triggers(workflow);
  return terms.every(
    (term) =>
      TRUSTED_REF_TERMS.has(term) ||
      // Empty outside pull_request events; pull_request_target fills it with the PR head.
      (!hasTarget && (term.startsWith('github.event.pull_request.') || term === 'github.event_name')) ||
      term === 'github.repository',
  );
}

const executes = (step: Step) => typeof step.run === 'string' || (step.uses ?? '').startsWith('./');
const isCheckout = (step: Step) => (step.uses ?? '').startsWith('actions/checkout@');
const PR_FETCH = /gh pr checkout|refs\/pull\/|\bpull\/(?:\$\{?[A-Za-z_]+\}?|[0-9]+)\/head/;

function findViolations(files: Array<{ file: string; workflow: Workflow }>) {
  const violations: string[] = [];
  const used = new Set<string>();
  for (const { file, workflow } of files) {
    if (!runsInDefaultBranchContext(workflow)) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      steps.forEach((step, index) => {
        const where = `${file}::${jobName}::${step.name ?? step.uses ?? step.id ?? index}`;
        if (typeof step.run === 'string' && PR_FETCH.test(step.run)) {
          if (ALLOWED[where]) used.add(where);
          else violations.push(`${where}: fetches a pull request ref in a run step`);
        }
        if (!isCheckout(step) || isTrustedRef(checkoutRef(step), workflow)) return;
        if (!steps.slice(index + 1).some(executes)) return;
        const key = `${file} ${checkoutRef(step)}`;
        if (ALLOWED[key]) used.add(key);
        else violations.push(`${where}: checks out ${checkoutRef(step)} and later runs code`);
      });
    }
  }
  return { violations, used };
}

function loadWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ file, workflow: parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Workflow }));
}

describe('default-branch workflows never execute unreviewed checkouts', () => {
  const workflows = loadWorkflows();
  const { violations, used } = findViolations(workflows);

  it('finds no computed checkout followed by a run step outside the allowlist', () => {
    expect(violations).toEqual([]);
  });

  it('keeps every allowlist entry live and justified', () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(used.has(key), `stale allowlist entry ${key}`).toBe(true);
      expect(reason.length, `justify ${key}`).toBeGreaterThan(40);
    }
  });

  it('flags a PR-head checkout under pull_request_target', () => {
    const workflow = parse(
      [
        'on: { pull_request_target: {} }',
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with: { ref: "${{ github.event.pull_request.head.sha }}" }',
        '      - run: npm install',
      ].join('\n'),
    ) as Workflow;
    expect(findViolations([{ file: 'x.yml', workflow }]).violations).toHaveLength(1);
  });

  it('flags a dispatch that checks out a job output and runs it', () => {
    const workflow = parse(
      [
        'on: { workflow_dispatch: {} }',
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with: { ref: "${{ needs.gate.outputs.head_sha }}" }',
        '      - uses: ./.github/actions/setup',
      ].join('\n'),
    ) as Workflow;
    expect(findViolations([{ file: 'x.yml', workflow }]).violations).toHaveLength(1);
  });

  it('flags gh pr checkout in a comment-triggered run', () => {
    const workflow = parse(
      ['on: { issue_comment: {} }', 'jobs:', '  build:', '    steps:', '      - run: gh pr checkout 5 && make'].join(
        '\n',
      ),
    ) as Workflow;
    expect(findViolations([{ file: 'x.yml', workflow }]).violations).toHaveLength(1);
  });

  it('ignores pull_request-only workflows and trusted refs', () => {
    const prOnly = parse(
      [
        'on: { pull_request: {} }',
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with: { ref: "${{ github.event.pull_request.head.sha }}" }',
        '      - run: npm test',
      ].join('\n'),
    ) as Workflow;
    const trusted = parse(
      [
        'on: { push: { branches: [main] }, pull_request: {} }',
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with: { ref: "${{ github.event.pull_request.head.sha || github.sha }}" }',
        '      - run: npm test',
      ].join('\n'),
    ) as Workflow;
    expect(findViolations([{ file: 'a.yml', workflow: prOnly }]).violations).toEqual([]);
    expect(findViolations([{ file: 'b.yml', workflow: trusted }]).violations).toEqual([]);
  });
});

// The two sandboxed workflows rely on their gate refusing to run PR code on any
// ref but their own sandbox branch. Execute the real gate scripts to prove it.
type GateResult = Map<string, unknown>;

async function runGateStep(
  file: string,
  job: string,
  stepId: string,
  github: unknown,
  context: unknown,
): Promise<GateResult> {
  const workflow = parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Workflow;
  const script = workflow.jobs?.[job]?.steps?.find((step) => step.id === stepId)?.with?.script;
  if (typeof script !== 'string') throw new Error(`${file}: missing ${job}.${stepId} script`);
  const outputs: GateResult = new Map();
  const core = {
    setOutput: (key: string, value: unknown) => outputs.set(key, value),
    setFailed: (message: string) => {
      throw new Error(message);
    },
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
  };
  // oxlint-disable-next-line no-implied-eval
  const run = new Function('github', 'context', 'core', `return (async () => {\n${script}\n})();`) as (
    github: unknown,
    context: unknown,
    core: unknown,
  ) => Promise<void>;
  await run(github, context, core);
  return outputs;
}

const repo = { owner: 'boardsesh', repo: 'boardsesh' };
const headSha = 'c'.repeat(40);

describe('mobile-ota-preview gate', () => {
  const github = {
    paginate: vi.fn(async () => [{ filename: 'packages/mobile/src/app.tsx' }]),
    rest: {
      pulls: {
        listFiles: vi.fn(),
        get: vi.fn(async () => ({ data: { state: 'open', head: { sha: headSha } } })),
      },
      actions: { createWorkflowDispatch: vi.fn() },
      repos: { getCollaboratorPermissionLevel: vi.fn() },
    },
  };
  const dispatchOn = (ref: string) => ({
    eventName: 'workflow_dispatch',
    ref,
    repo,
    payload: { inputs: { pr: '42' }, repository: { default_branch: 'main' } },
  });

  it.each([
    'refs/heads/main',
    'refs/heads/release/next',
    'refs/heads/feature',
    'refs/heads/ci-sandbox/ota-preview/pr-4/1',
  ])('hands a dispatch on %s off instead of publishing', async (ref) => {
    const outputs = await runGateStep('mobile-ota-preview.yml', 'gate', 'decide', github, dispatchOn(ref));
    expect(outputs.get('action')).toBe('handoff');
  });

  it('publishes on its own sandbox branch', async () => {
    const outputs = await runGateStep(
      'mobile-ota-preview.yml',
      'gate',
      'decide',
      github,
      dispatchOn('refs/heads/ci-sandbox/ota-preview/pr-42/9001'),
    );
    expect(outputs.get('action')).toBe('publish');
    expect(outputs.get('head_sha')).toBe(headSha);
  });

  it('only lets publish and announce run on action=publish', () => {
    const workflow = parse(readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-preview.yml'), 'utf8')) as Workflow;
    for (const job of ['publish', 'announce', 'reset', 'notify']) {
      expect(workflow.jobs?.[job]?.if, job).toContain("needs.gate.outputs.action == 'publish'");
    }
    expect(workflow.jobs?.handoff?.if).toBe("needs.gate.outputs.action == 'handoff'");
  });
});

describe('db-migration-renumber gate', () => {
  const github = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            state: 'open',
            head: { sha: headSha, ref: 'feature', repo: { full_name: 'boardsesh/boardsesh' } },
            base: { ref: 'main' },
            labels: [],
          },
        })),
      },
    },
  };
  const dispatchOn = (ref: string) => ({
    ref,
    repo,
    payload: { inputs: { pr: '42' }, repository: { default_branch: 'main' } },
  });

  it.each(['refs/heads/main', 'refs/heads/feature', 'refs/heads/ci-sandbox/db-renumber/pr-4/1'])(
    'hands a vetted PR off from %s without running it',
    async (ref) => {
      const outputs = await runGateStep('db-migration-renumber.yml', 'gate', 'decide', github, dispatchOn(ref));
      expect(outputs.get('run')).toBe('false');
      expect(outputs.get('handoff')).toBe('true');
    },
  );

  it('runs on its own sandbox branch', async () => {
    const outputs = await runGateStep(
      'db-migration-renumber.yml',
      'gate',
      'decide',
      github,
      dispatchOn('refs/heads/ci-sandbox/db-renumber/pr-42/77'),
    );
    expect(outputs.get('run')).toBe('true');
    expect(outputs.get('handoff')).toBe('false');
  });
});
