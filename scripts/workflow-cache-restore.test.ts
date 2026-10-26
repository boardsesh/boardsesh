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
  'mobile-store-videos.yml#record#Restore screenshot dev-client':
    'prebuilt simulator .app; follow-up: build in a secret-free job and hand over as a verified artifact',
  // Not a speed cache: the resumable bootstrap checkpoint that lets a failed
  // custom-product-page bootstrap resume. Follow-up: move it out of the cache.
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

// Resolve `${{ inputs.NAME }}` and `${{ inputs.NAME == 'true' }}` against the
// caller's inputs. Any other expression stays as-is and counts as truthy, so an
// unknown condition is treated as "may restore".
function resolveInputs(value: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
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

function stepMechanism(step: Step, inputs: Record<string, unknown>): string | null {
  const action = (step.uses ?? '').replace(/@.*$/, '');
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
      return option('cache') === undefined || isTruthy(option('cache')) ? 'actions/setup-go cache' : null;
    case 'ruby/setup-ruby':
      return isTruthy(option('bundler-cache')) ? 'setup-ruby bundler-cache' : null;
    case 'Swatinem/rust-cache':
      return 'rust-cache';
    case 'gradle/actions/setup-gradle':
      return isTruthy(option('cache-disabled')) ? null : 'setup-gradle cache';
    case 'astral-sh/setup-uv':
      return asText(option('enable-cache') ?? 'auto') === 'false' ? null : 'setup-uv cache';
    case 'jdx/mise-action':
      return asText(option('cache') ?? 'true') === 'false' ? null : 'mise cache';
    case 'docker/build-push-action':
      return /type=gha/.test(asText(option('cache-from') ?? '')) ? 'buildx type=gha cache-from' : null;
    default:
      return null;
  }
}

function skippedByInputs(step: Step, inputs: Record<string, unknown>): boolean {
  return step.if !== undefined && resolveInputs(step.if, inputs) === 'false';
}

function restoringSteps(
  steps: Step[],
  loadAction: (uses: string) => CompositeAction | null,
  inputs: Record<string, unknown> = {},
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
  if (secrets.length > 0 || /secrets\[/.test(text)) reasons.push('secrets');
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
      // A reusable-workflow call has no steps; the callee is scanned on its own.
      if (!job.steps) continue;
      const reasons = sensitivityReasons(workflow, job);
      if (reasons.length === 0) continue;
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

  it('counts environments, non-GITHUB_TOKEN secrets and write permissions as sensitive', () => {
    expect(sensitivityReasons({}, { environment: 'Production' })).toEqual(['environment']);
    expect(sensitivityReasons({}, { env: { TOKEN: '${{ secrets.GITHUB_TOKEN }}' } })).toEqual([]);
    expect(sensitivityReasons({}, { env: { TOKEN: '${{ secrets.EOO_TOKEN }}' } })).toEqual(['secrets']);
    expect(sensitivityReasons({ env: { KEY: '${{ secrets.KEY }}' } }, {})).toEqual(['secrets']);
    expect(sensitivityReasons({ permissions: { contents: 'write' } }, {})).toEqual(['write permissions']);
    expect(sensitivityReasons({ permissions: { contents: 'write' } }, { permissions: { contents: 'read' } })).toEqual(
      [],
    );
  });
});
