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
    'On main or release/*, resolve refuses a commit that is not an ancestor of the run commit.',
  'mobile-e2e-gate.yml ${{ needs.resolve.outputs.sha || github.sha }}':
    'On main or release/*, resolve refuses a commit that is not an ancestor of the run commit; the fallback is the run commit.',
  'e2e-tests.yml ${{ inputs.ref }}':
    'Only mobile-e2e-gate.yml passes a ref, after its resolve job checked it; a dispatch leaves it empty (the run ref).',
  'mobile-ota-boot-check.yml ${{ needs.resolve.outputs.commit }}':
    "On main or release/*, a dispatch's commit must be an ancestor of the run commit; the daily stable call passes a staged main commit.",
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
  // Run steps whose git checkout arguments come from a variable (`file::job::step`).
  'mobile-ota-backport.yml::backport::Locate the release anchor and prepare the hotfix tree':
    'Checks out a release/* anchor tag (only the release App may create one), then cherry-picks fix_commits only after each resolves to a single commit that is an ancestor of origin/main (mobile-ota-backport-fix-commits.test.ts).',
  'mobile-ota-check.yml::ota-check::Materialize the base-branch baseline':
    "BASE_REF is the PR's base branch on a pull_request run (PR scope) and main on a push run; the variable path is RUNNER_TEMP.",
  'mobile-store-submit.yml::submit-ios::Take the listing text from the merge commit':
    'Copies only fastlane/metadata text from the release merge commit on main; nothing from it is executed.',
  'ota-image-bump.yml::bump::Open or update the bump PRs':
    'Creates the bump branch from origin/main; the variable is the new branch name, not the source.',
  'production-deploy.yml::push-promoted-changelog::Push promoted changelog to main':
    'Detached worktree of origin/main; the variable is the RUNNER_TEMP path.',
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

/** A scalar `with:` input as written ('' when absent); YAML may hand back a number or boolean. */
function scalarInput(step: Step, name: string): string {
  const input = step.with?.[name];
  return typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean'
    ? String(input).trim()
    : '';
}

const checkoutRef = (step: Step) => scalarInput(step, 'ref');

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

/** True when a step runs code from the workspace a computed checkout may have filled. */
function executes(step: Step): boolean {
  if (typeof step.run === 'string' || (step.uses ?? '').startsWith('./')) return true;
  // setup-vp (and friends) can install the workspace, running its lifecycle scripts.
  const runInstall = scalarInput(step, 'run-install');
  if (runInstall !== '' && runInstall !== 'false') return true;
  // A github-script step that loads a module from disk runs whatever the checkout put there.
  const script = step.with?.script;
  if ((step.uses ?? '').startsWith('actions/github-script@') && typeof script === 'string') {
    return [...script.matchAll(/\b(?:require|import)\s*\(\s*([^)]*)\)/g)].some(
      ([, target]) =>
        !/^['"`](?:node:)?(?:fs|path|os|crypto|child_process|util|url|zlib)['"`]$/.test(target?.trim() ?? ''),
    );
  }
  return false;
}

const isCheckout = (step: Step) => (step.uses ?? '').startsWith('actions/checkout@');
const PR_FETCH = /gh pr checkout|refs\/pull\/|\bpull\/(?:\$\{?[A-Za-z_]+\}?|[0-9]+)\/head/;
// `git checkout|switch|worktree add` whose arguments come from a variable or expression.
const COMPUTED_GIT_CHECKOUT =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch|worktree\s+add)\b[^\n]*(?:\$\{\{|\$[A-Za-z_{])/;

/** A checkout of another repository is computed code no matter which ref it names. */
function foreignRepository(step: Step): boolean {
  const repository = scalarInput(step, 'repository');
  return repository !== '' && repository.replace(/\s+/g, '') !== '${{github.repository}}';
}

function findViolations(files: Array<{ file: string; workflow: Workflow }>) {
  const violations: string[] = [];
  const used = new Set<string>();
  for (const { file, workflow } of files) {
    if (!runsInDefaultBranchContext(workflow)) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      steps.forEach((step, index) => {
        const where = `${file}::${jobName}::${step.name ?? step.uses ?? step.id ?? index}`;
        if (typeof step.run === 'string' && (PR_FETCH.test(step.run) || COMPUTED_GIT_CHECKOUT.test(step.run))) {
          if (ALLOWED[where]) used.add(where);
          else violations.push(`${where}: checks out a pull request or computed ref in a run step`);
        }
        if (!isCheckout(step)) return;
        const foreign = foreignRepository(step);
        if (!foreign && isTrustedRef(checkoutRef(step), workflow)) return;
        if (!steps.slice(index + 1).some(executes)) return;
        const key = foreign
          ? `${file} ${scalarInput(step, 'repository')} ${checkoutRef(step)}`
          : `${file} ${checkoutRef(step)}`;
        if (ALLOWED[key]) used.add(key);
        else
          violations.push(
            `${where}: checks out ${foreign ? 'another repository' : checkoutRef(step)} and later runs code`,
          );
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

  it('flags installs, module loads, foreign repositories and git checkouts of computed code', () => {
    const job = (steps: string[]) =>
      parse(['on: { workflow_dispatch: {} }', 'jobs:', '  build:', '    steps:', ...steps].join('\n')) as Workflow;
    const computed = ['      - uses: actions/checkout@v4', '        with: { ref: "${{ needs.gate.outputs.sha }}" }'];
    const cases = [
      job([...computed, '      - uses: voidzero-dev/setup-vp@v1', '        with: { run-install: true }']),
      job([
        ...computed,
        '      - uses: actions/github-script@v7',
        '        with:',
        '          script: require(`${process.env.GITHUB_WORKSPACE}/scripts/x.cjs`)',
      ]),
      job([
        '      - uses: actions/checkout@v4',
        '        with: { repository: "${{ inputs.fork }}" }',
        '      - run: make',
      ]),
      job(['      - run: git checkout "$PR_SHA" && make']),
      job(['      - run: git worktree add ../pr "${{ inputs.sha }}"']),
    ];
    for (const workflow of cases) expect(findViolations([{ file: 'x.yml', workflow }]).violations).toHaveLength(1);
    const builtinOnly = job([
      ...computed,
      '      - uses: actions/github-script@v7',
      '        with: { script: "const fs = require(\'fs\')" }',
    ]);
    expect(findViolations([{ file: 'y.yml', workflow: builtinOnly }]).violations).toEqual([]);
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
  const makeGithub = (headRef = 'feature', rules: () => Promise<{ data: unknown }> = async () => ({ data: [] })) => ({
    request: vi.fn(rules),
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            state: 'open',
            head: { sha: headSha, ref: headRef, repo: { full_name: 'boardsesh/boardsesh' } },
            base: { ref: 'main' },
            labels: [],
          },
        })),
      },
    },
  });
  const dispatchOn = (ref: string) => ({
    ref,
    repo,
    payload: { inputs: { pr: '42' }, repository: { default_branch: 'main' } },
  });
  const sandbox = 'refs/heads/ci-sandbox/db-renumber/pr-42/77';

  it.each(['refs/heads/main', 'refs/heads/feature', 'refs/heads/ci-sandbox/db-renumber/pr-4/1'])(
    'hands a vetted PR off from %s without running it',
    async (ref) => {
      const outputs = await runGateStep('db-migration-renumber.yml', 'gate', 'decide', makeGithub(), dispatchOn(ref));
      expect(outputs.get('run')).toBe('false');
      expect(outputs.get('handoff')).toBe('true');
    },
  );

  it('runs on its own sandbox branch', async () => {
    const outputs = await runGateStep('db-migration-renumber.yml', 'gate', 'decide', makeGithub(), dispatchOn(sandbox));
    expect(outputs.get('run')).toBe('true');
    expect(outputs.get('handoff')).toBe('false');
  });

  it.each([
    ['a release branch head', makeGithub('release/next')],
    ['a ruleset-protected head', makeGithub('feature', async () => ({ data: [{ type: 'non_fast_forward' }] }))],
  ])('never touches %s', async (_label, github) => {
    for (const ref of ['refs/heads/main', sandbox]) {
      const outputs = await runGateStep('db-migration-renumber.yml', 'gate', 'decide', github, dispatchOn(ref));
      expect(outputs.get('run')).toBe('false');
      expect(outputs.get('handoff')).toBe('false');
    }
  });

  it('stops when the head branch rules cannot be read', async () => {
    const github = makeGithub('feature', async () => {
      throw Object.assign(new Error('boom'), { status: 502 });
    });
    await expect(
      runGateStep('db-migration-renumber.yml', 'gate', 'decide', github, dispatchOn(sandbox)),
    ).rejects.toThrow(/Could not read the rules/);
  });
});

// A branch created with GITHUB_TOKEN starts no `on: push` / `on: create` runs, so a
// sandbox branch never wakes another workflow. An App token would.
describe('sandbox handoff token', () => {
  it.each([
    ['mobile-ota-preview.yml', 'handoff'],
    ['db-migration-renumber.yml', 'handoff'],
    ['mobile-ota-preview.yml', 'sandbox-cleanup'],
    ['db-migration-renumber.yml', 'sandbox-cleanup'],
  ])('%s %s creates and deletes branches with GITHUB_TOKEN only', (file, jobName) => {
    const workflow = parse(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')) as Workflow;
    const job = workflow.jobs?.[jobName];
    expect(job, `${file} ${jobName}`).toBeDefined();
    for (const step of job?.steps ?? []) {
      expect(step.uses ?? '').not.toContain('create-github-app-token');
      expect(step.with?.['github-token']).toBeUndefined();
      expect(step.with?.token).toBeUndefined();
    }
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
  });

  it('runs the helper with the github client github-script hands it', () => {
    const helper = readFileSync(resolve(import.meta.dirname, '../lib/ci-sandbox.cjs'), 'utf8');
    expect(helper).not.toMatch(/new Octokit|getOctokit|process\.env\.[A-Z_]*TOKEN/);
  });
});

describe('.claude/setup.sh', () => {
  it('exits before installing anything in GitHub Actions', () => {
    const setup = readFileSync(resolve(import.meta.dirname, '../../.claude/setup.sh'), 'utf8');
    const guard = setup.indexOf('if [ "${GITHUB_ACTIONS:-}" = "true" ]; then');
    expect(guard).toBeGreaterThan(-1);
    expect(setup.slice(guard).split('\n').slice(0, 4).join('\n')).toContain('exit 0');
    expect(guard).toBeLessThan(setup.indexOf('\nvp install'));
  });
});
