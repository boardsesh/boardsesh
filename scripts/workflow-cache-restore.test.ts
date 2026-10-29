/// <reference types="node" />

// Jobs that hold deploy secrets, run under an `environment:`, or can write to the
// repository or its packages must not restore entries from the shared GitHub
// Actions cache. Those entries are shared across branches, so a job that ships
// something or holds credentials installs its dependencies fresh instead. PR CI
// jobs with no secrets and a read-only token keep their caches.
//
// The guard walks every workflow job, expands local composite actions (with the
// caller's inputs), and fails on any step that would restore a cache. Steps that
// still do so on purpose are listed in RESTORE_ALLOWLIST, each with the reason.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW_DIR = '.github/workflows';

type Step = { name?: string; uses?: string; if?: unknown; with?: Record<string, unknown> };
type Job = {
  environment?: unknown;
  permissions?: unknown;
  steps?: Step[];
  uses?: string;
  [key: string]: unknown;
};
type Workflow = { env?: unknown; permissions?: unknown; jobs?: Record<string, Job> };
type ActionInput = { default?: unknown };
type CompositeAction = { inputs?: Record<string, ActionInput>; runs?: { using?: string; steps?: Step[] } };

type RestoringStep = { label: string; mechanism: string };

// Steps that still restore a shared cache inside a sensitive job. Keyed
// `<workflow file>#<job id>#<step label>`; a composite action's steps are
// labelled `<action dir> > <step name>`. Every entry needs a follow-up.
const RESTORE_ALLOWLIST: Record<string, string> = {
  // Native build caches worth ~30 min per run. Follow-up: restore them in a
  // secret-free job, repack, hand over as an artifact and verify an HMAC in
  // the signing job, instead of restoring them here.
  'ios-testflight-rn.yml#build-and-upload#Cache CocoaPods':
    'Pods tree (prebuilt xcframeworks); follow-up: split restore into a secret-free job + verified artifact',
  'android-apk-rn.yml#build-and-release#Cache Gradle':
    'Gradle caches for the signed release build; follow-up: split restore into a secret-free job + verified artifact',
  'android-apk-dev-client.yml#build-and-release#Cache Gradle':
    'Gradle caches for the dev-client prerelease; follow-up: split restore into a secret-free job + verified artifact',
  // The prebuilt screenshot simulator app. Shards fail on a miss by design so
  // they never cold-build. Follow-up: pass the .app as a verified artifact.
  'mobile-screenshots-ios.yml#probe#ios-screenshot-shard > Restore prebuilt simulator app':
    'prebuilt simulator .app; follow-up: hand over as a verified artifact from ios-build',
  'mobile-screenshots-ios.yml#ios-capture#ios-screenshot-shard > Restore prebuilt simulator app':
    'prebuilt simulator .app; follow-up: hand over as a verified artifact from ios-build',
  'mobile-screenshots-ios.yml#cpp-capture#ios-screenshot-shard > Restore prebuilt simulator app':
    'prebuilt simulator .app; follow-up: hand over as a verified artifact from ios-build',
  'mobile-store-videos-measure.yml#record#Restore screenshot dev-client':
    'prebuilt simulator .app; follow-up: build in a secret-free job and hand over as a verified artifact',
  'mobile-store-videos-pipeline.yml#record#ios-store-video-tools > actions/cache/restore@v4':
    'prebuilt simulator .app; follow-up: hand over as a verified artifact from app',
  'mobile-store-videos-pipeline.yml#crew#ios-store-video-tools > actions/cache/restore@v4':
    'prebuilt simulator .app; follow-up: hand over as a verified artifact from app',
  // Not a speed cache: the resumable bootstrap checkpoint that lets a failed
  // custom-product-page bootstrap resume. Follow-up: move it out of the cache.
  // anthropics/claude-code-action installs Bun through oven-sh/setup-bun, which
  // restores the Bun binary from the Actions cache. Follow-up: install Bun
  // without a cache and pass `path_to_bun_executable` so setup-bun is skipped.
  'claude.yml#claude#Run Claude Code':
    'setup-bun binary cache inside claude-code-action; follow-up: path_to_bun_executable',
  'claude-code-review.yml#claude-review#Run Claude Code Review':
    'setup-bun binary cache inside claude-code-action; follow-up: path_to_bun_executable',
  'discord-feedback-issues.yml#triage#Triage with Claude':
    'setup-bun binary cache inside claude-code-action; follow-up: path_to_bun_executable',
  'sentry-triage.yml#triage#Run Sentry triage':
    'setup-bun binary cache inside claude-code-action; follow-up: path_to_bun_executable',
  'mobile-screenshots-ios.yml#cpp-bootstrap#Restore account-bound bootstrap checkpoint':
    'resumable bootstrap checkpoint; follow-up: carry it in an artifact or the repo instead of the cache',
};

// YAML scalars arrive as strings, booleans or numbers; anything else is
// compared by its JSON form.
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value) ?? '';
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  const text = asText(value).trim();
  return text !== '' && text !== 'false';
}

// Remote actions whose source was read and found to touch no GitHub Actions
// cache (or only the runner-local tool cache). A remote action missing from this
// set and from the switch in stepMechanism fails the guard in a sensitive job:
// a composite or JavaScript action can restore a cache internally, so an
// unreviewed one counts as a restore until someone reads it.
const REVIEWED_CACHE_FREE_ACTIONS = new Set([
  'actions/checkout',
  'actions/upload-artifact',
  'actions/download-artifact',
  'actions/github-script',
  'actions/create-github-app-token',
  'actions/attest',
  'actions/attest-build-provenance',
  'actions/cache/save',
  'docker/login-action',
  'docker/metadata-action',
  'android-actions/setup-android', // @actions/tool-cache only
  'reactivecircus/android-emulator-runner', // @actions/tool-cache only
  'oras-project/setup-oras', // @actions/tool-cache only
  'dtolnay/rust-toolchain',
  'dorny/paths-filter',
  'softprops/action-gh-release',
  'marocchino/sticky-pull-request-comment',
  'turing85/publish-report',
]);

// `null` = top level of a workflow job: nothing is resolved, so any expression
// (including a workflow_dispatch `inputs.*`) counts as "may restore". Inside a
// composite action, `${{ inputs.NAME }}` and `${{ inputs.NAME == 'x' }}` are
// resolved against the caller's `with:` and the action's defaults; any other
// expression stays as-is and counts as truthy.
type Inputs = Record<string, unknown> | null;

function resolveInputs(value: unknown, inputs: Inputs): unknown {
  if (inputs === null || typeof value !== 'string') return value;
  const plain = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(value.trim());
  if (plain) return inputs[plain[1]];
  const equals = /^\$\{\{\s*inputs\.([\w-]+)\s*==\s*'([^']*)'\s*\}\}$/.exec(value.trim());
  if (equals) {
    const actual = inputs[equals[1]];
    if (typeof actual === 'string' && actual.includes('${{')) return value;
    return asText(actual) === equals[2] ? 'true' : 'false';
  }
  return value;
}

const isLiterallyFalse = (value: unknown): boolean => value === false || value === 'false';

function stepMechanism(step: Step, inputs: Inputs): string | null {
  if (!step.uses) return null;
  const action = step.uses.replace(/@.*$/, '');
  const option = (key: string): unknown => resolveInputs(step.with?.[key], inputs);
  switch (action) {
    case 'actions/cache':
    case 'actions/cache/restore':
      return isTruthy(option('lookup-only')) ? null : action;
    case 'voidzero-dev/setup-vp':
      if (isTruthy(option('cache'))) return 'setup-vp cache';
      if (isTruthy(option('sfw'))) return 'setup-vp sfw binary cache';
      return null;
    case 'actions/setup-node':
    case 'actions/setup-python':
    case 'actions/setup-java':
    case 'actions/setup-dotnet':
      return isTruthy(option('cache')) ? `${action} cache` : null;
    case 'actions/setup-go':
      return isLiterallyFalse(option('cache')) ? null : 'actions/setup-go cache';
    case 'ruby/setup-ruby':
      return isTruthy(option('bundler-cache')) ? 'setup-ruby bundler-cache' : null;
    case 'Swatinem/rust-cache':
      return 'rust-cache';
    case 'gradle/actions/setup-gradle':
      return isTruthy(option('cache-disabled')) ? null : 'setup-gradle cache';
    case 'astral-sh/setup-uv':
      return isLiterallyFalse(option('enable-cache')) ? null : 'setup-uv cache';
    case 'jdx/mise-action':
      return isLiterallyFalse(option('cache')) ? null : 'mise cache';
    case 'docker/build-push-action':
      return /type=gha/.test(asText(option('cache-from') ?? '')) ? 'buildx type=gha cache-from' : null;
    // Both cache a downloaded binary/image in the Actions cache by default.
    case 'docker/setup-buildx-action':
      return isLiterallyFalse(option('cache-binary')) ? null : 'setup-buildx cache-binary';
    case 'docker/setup-qemu-action':
      return isLiterallyFalse(option('cache-image')) ? null : 'setup-qemu cache-image';
    default: {
      // Local composite actions are expanded and checked step by step instead.
      if (action.startsWith('./')) return null;
      // Fail closed: any cache-looking input that isn't literally off.
      const cacheKeys = Object.keys(step.with ?? {}).filter(
        (key) => /cache/i.test(key) && !isLiterallyFalse(option(key)),
      );
      if (cacheKeys.length > 0) return `${action} ${cacheKeys.join(', ')}`;
      if (action.startsWith('docker://')) return null;
      return REVIEWED_CACHE_FREE_ACTIONS.has(action) ? null : `unreviewed remote action ${action}`;
    }
  }
}

function skippedByInputs(step: Step, inputs: Inputs): boolean {
  return inputs !== null && step.if !== undefined && resolveInputs(step.if, inputs) === 'false';
}

function restoringSteps(
  steps: Step[],
  loadAction: (uses: string) => CompositeAction | null,
  inputs: Inputs = null,
  prefix = '',
): RestoringStep[] {
  const found: RestoringStep[] = [];
  for (const step of steps) {
    if (skippedByInputs(step, inputs)) continue;
    const label = `${prefix}${step.name ?? step.uses ?? '(run step)'}`;
    const mechanism = stepMechanism(step, inputs);
    if (mechanism) found.push({ label, mechanism });
    if (step.uses?.startsWith('./')) {
      const action = loadAction(step.uses);
      if (action?.runs?.using === 'composite') {
        const callerInputs: Record<string, unknown> = {};
        for (const [name, spec] of Object.entries(action.inputs ?? {})) callerInputs[name] = spec.default;
        for (const [name, value] of Object.entries(step.with ?? {})) {
          callerInputs[name] = resolveInputs(value, inputs);
        }
        const dir = step.uses.replace(/\/$/, '').split('/').pop() ?? step.uses;
        found.push(...restoringSteps(action.runs.steps ?? [], loadAction, callerInputs, `${dir} > `));
      }
    }
  }
  return found;
}

function sensitivityReasons(workflow: Workflow, job: Job): string[] {
  const reasons: string[] = [];
  if (isTruthy(job.environment)) reasons.push('environment');
  const text = JSON.stringify(job) + JSON.stringify(workflow.env ?? {});
  const secrets = [...text.matchAll(/secrets\.([\w-]+)/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'GITHUB_TOKEN');
  if (secrets.length > 0 || /secrets\[/.test(text) || job.secrets === 'inherit') reasons.push('secrets');
  const permissions = job.permissions !== undefined ? job.permissions : workflow.permissions;
  const writes =
    permissions === 'write-all' ||
    (typeof permissions === 'object' && permissions !== null && Object.values(permissions).includes('write'));
  if (writes) reasons.push('write permissions');
  return reasons;
}

function loadRepoAction(uses: string): CompositeAction | null {
  const dir = uses.replace(/^\.\//, '').replace(/\/$/, '');
  for (const file of ['action.yml', 'action.yaml']) {
    try {
      return parse(readFileSync(join(dir, file), 'utf8')) as CompositeAction;
    } catch {
      // try the next file name
    }
  }
  return null;
}

type Finding = RestoringStep & { key: string; reasons: string[] };

function scanRepo(): Finding[] {
  const findings: Finding[] = [];
  const files = readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file));
  for (const file of files.sort()) {
    const workflow = parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as Workflow;
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const reasons = sensitivityReasons(workflow, job);
      if (reasons.length === 0) continue;
      // A local reusable workflow is scanned on its own; a remote one can't be
      // read here, so it fails closed like an unreviewed remote action.
      if (job.uses !== undefined) {
        if (!job.uses.startsWith('./')) {
          findings.push({
            label: job.uses,
            mechanism: `unreviewed remote reusable workflow ${job.uses}`,
            key: `${file}#${jobId}#${job.uses}`,
            reasons,
          });
        }
        continue;
      }
      if (!job.steps) continue;
      for (const restoring of restoringSteps(job.steps, loadRepoAction)) {
        findings.push({ ...restoring, key: `${file}#${jobId}#${restoring.label}`, reasons });
      }
    }
  }
  return findings;
}

describe('shared cache restores in sensitive jobs', () => {
  const findings = scanRepo();

  it('no job holding secrets, an environment or write permissions restores a shared cache', () => {
    const violations = findings
      .filter((finding) => !(finding.key in RESTORE_ALLOWLIST))
      .map((finding) => `${finding.key} (${finding.mechanism}; job has ${finding.reasons.join(', ')})`);
    expect(
      violations,
      'Disable the cache restore in these jobs (setup-vp `cache: false`, an explicit `bundle install` ' +
        'instead of `bundler-cache: true`, no `type=gha` cache-from, `restore-caches: false` on the ' +
        'composite actions), or add a RESTORE_ALLOWLIST entry with its follow-up.',
    ).toEqual([]);
  });

  it('every allowlist entry still matches a restoring step in a sensitive job', () => {
    const keys = new Set(findings.map((finding) => finding.key));
    expect(Object.keys(RESTORE_ALLOWLIST).filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe('cache restore detection', () => {
  const noActions = (): CompositeAction | null => null;

  it('flags setup-vp, bundler and actions/cache restores, and skips lookups and saves', () => {
    const steps: Step[] = [
      { uses: 'voidzero-dev/setup-vp@v1', with: { cache: true } },
      { uses: 'voidzero-dev/setup-vp@v1', with: { cache: false } },
      { uses: 'voidzero-dev/setup-vp@v1' },
      { uses: 'ruby/setup-ruby@v1', with: { 'bundler-cache': true } },
      { name: 'restore', uses: 'actions/cache/restore@v4', with: { key: 'k' } },
      { name: 'lookup', uses: 'actions/cache/restore@v4', with: { key: 'k', 'lookup-only': true } },
      { name: 'save', uses: 'actions/cache/save@v4', with: { key: 'k' } },
      { uses: 'docker/build-push-action@v7', with: { 'cache-from': 'type=gha,scope=x' } },
      { uses: 'docker/build-push-action@v7', with: { 'cache-from': 'type=registry,ref=ghcr.io/x' } },
    ];
    expect(restoringSteps(steps, noActions).map((step) => step.mechanism)).toEqual([
      'setup-vp cache',
      'setup-ruby bundler-cache',
      'actions/cache/restore',
      'buildx type=gha cache-from',
    ]);
  });

  it('treats an unresolvable expression as a restore', () => {
    const steps: Step[] = [
      { uses: 'voidzero-dev/setup-vp@v1', with: { cache: "${{ runner.environment == 'github-hosted' }}" } },
    ];
    expect(restoringSteps(steps, noActions)).toHaveLength(1);
  });

  it("resolves a composite action's inputs from the caller and the defaults", () => {
    const action: CompositeAction = {
      inputs: { 'restore-caches': { default: 'false' } },
      runs: {
        using: 'composite',
        steps: [
          { uses: 'voidzero-dev/setup-vp@v1', with: { cache: "${{ inputs.restore-caches == 'true' }}" } },
          { name: 'Gradle', if: "${{ inputs.restore-caches == 'true' }}", uses: 'actions/cache@v4' },
        ],
      },
    };
    const load = () => action;
    expect(restoringSteps([{ uses: './.github/actions/capture' }], load)).toEqual([]);
    expect(
      restoringSteps([{ uses: './.github/actions/capture', with: { 'restore-caches': 'true' } }], load).map(
        (step) => step.label,
      ),
    ).toEqual(['capture > voidzero-dev/setup-vp@v1', 'capture > Gradle']);
  });

  it('fails closed on cache-looking inputs and unreviewed remote actions', () => {
    const steps: Step[] = [
      { name: 'unknown cache input', uses: 'someone/setup-thing@v1', with: { 'use-cache': 'yes' } },
      { name: 'unknown cache input off', uses: 'actions/checkout@v6', with: { 'cache-thing': 'false' } },
      { name: 'boolean off', uses: 'actions/checkout@v6', with: { cache: false } },
      { name: 'unreviewed', uses: 'someone/other-action@v2' },
      { name: 'reviewed', uses: 'actions/checkout@v6' },
      { name: 'save only', uses: 'actions/cache/save@v4', with: { key: 'k', path: 'p' } },
      { name: 'buildx default', uses: 'docker/setup-buildx-action@v4' },
      { name: 'buildx off', uses: 'docker/setup-buildx-action@v4', with: { 'cache-binary': false } },
      { name: 'qemu default', uses: 'docker/setup-qemu-action@v3' },
      { name: 'local composite', uses: './.github/actions/thing', with: { 'app-cache-key': 'k' } },
      { name: 'docker image', uses: 'docker://alpine:3' },
    ];
    expect(restoringSteps(steps, noActions)).toEqual([
      { label: 'unknown cache input', mechanism: 'someone/setup-thing use-cache' },
      { label: 'unreviewed', mechanism: 'unreviewed remote action someone/other-action' },
      { label: 'buildx default', mechanism: 'setup-buildx cache-binary' },
      { label: 'qemu default', mechanism: 'setup-qemu cache-image' },
    ]);
  });

  it('flags an unreviewed action inside a local composite action', () => {
    const action: CompositeAction = { runs: { using: 'composite', steps: [{ name: 'Inner', uses: 'someone/x@v1' }] } };
    expect(restoringSteps([{ uses: './.github/actions/wrap' }], () => action)).toEqual([
      { label: 'wrap > Inner', mechanism: 'unreviewed remote action someone/x' },
    ]);
  });

  it('never resolves workflow-level inputs: expression toggles and conditions count as restores', () => {
    const steps: Step[] = [
      { name: 'dispatch toggle', uses: 'voidzero-dev/setup-vp@v1', with: { cache: '${{ inputs.use_cache }}' } },
      {
        name: 'dispatch equality',
        uses: 'voidzero-dev/setup-vp@v1',
        with: { cache: "${{ inputs.use_cache == 'true' }}" },
      },
      { name: 'conditional restore', if: "${{ inputs.restore == 'true' }}", uses: 'actions/cache/restore@v4' },
      { name: 'go default', uses: 'actions/setup-go@v5', with: { cache: '${{ inputs.go_cache }}' } },
    ];
    expect(restoringSteps(steps, noActions).map((step) => step.label)).toEqual([
      'dispatch toggle',
      'dispatch equality',
      'conditional restore',
      'go default',
    ]);
  });

  it('passes an unresolved workflow expression through a composite input as a restore', () => {
    const action: CompositeAction = {
      inputs: { 'restore-caches': { default: 'false' } },
      runs: {
        using: 'composite',
        steps: [{ uses: 'voidzero-dev/setup-vp@v1', with: { cache: "${{ inputs.restore-caches == 'true' }}" } }],
      },
    };
    const caller: Step = { uses: './.github/actions/capture', with: { 'restore-caches': '${{ inputs.cache }}' } };
    expect(restoringSteps([caller], () => action)).toHaveLength(1);
  });

  it('counts environments, non-GITHUB_TOKEN secrets and write permissions as sensitive', () => {
    expect(sensitivityReasons({}, { environment: 'Production' })).toEqual(['environment']);
    expect(sensitivityReasons({}, { env: { TOKEN: '${{ secrets.GITHUB_TOKEN }}' } })).toEqual([]);
    expect(sensitivityReasons({}, { env: { TOKEN: '${{ secrets.EOO_TOKEN }}' } })).toEqual(['secrets']);
    expect(sensitivityReasons({ env: { KEY: '${{ secrets.KEY }}' } }, {})).toEqual(['secrets']);
    expect(sensitivityReasons({}, { uses: 'org/repo/.github/workflows/x.yml@v1', secrets: 'inherit' })).toEqual([
      'secrets',
    ]);
    expect(sensitivityReasons({ permissions: { contents: 'write' } }, {})).toEqual(['write permissions']);
    expect(sensitivityReasons({ permissions: { contents: 'write' } }, { permissions: { contents: 'read' } })).toEqual(
      [],
    );
  });
});
