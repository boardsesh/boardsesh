/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { withoutCommentLines } from './helpers/workflow-yaml';

/**
 * Pins the shape of mobile-e2e-gate.yml and the composite action it shares with
 * the Play Store capture.
 *
 * The gate's promises all live in YAML nothing type-checks: which commit each
 * job tests, that a second run cannot cancel the first, that it holds no OTA
 * publish lock, that it spends one macOS runner, and which jobs are allowed to
 * fail it. A wrong line there fails quietly, as a gate that tests the wrong
 * commit or one that blocks a release it was never meant to.
 */

const GATE_PATH = '.github/workflows/mobile-e2e-gate.yml';
const ANDROID_CAPTURE_PATH = '.github/workflows/mobile-screenshots-android.yml';
const IOS_CAPTURE_PATH = '.github/workflows/mobile-screenshots-ios.yml';
const ANDROID_ACTION_PATH = '.github/actions/android-emulator-capture/action.yml';
const ANDROID_ACTION_USES = './.github/actions/android-emulator-capture';
const IOS_ACTION_USES = './.github/actions/ios-screenshot-shard';

const TESTED_SHA = '${{ needs.resolve.outputs.sha }}';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string | boolean;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  needs?: string | string[];
  if?: string | boolean;
  uses?: string;
  with?: Record<string, unknown>;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  environment?: string;
  concurrency?: unknown;
  steps?: Step[];
};
type Workflow = {
  on: {
    workflow_call: {
      inputs: Record<string, { required?: boolean; type: string; default?: unknown }>;
      outputs: Record<string, { value: string }>;
    };
    workflow_dispatch: { inputs: Record<string, { required?: boolean; default?: unknown }> };
    schedule: Array<{ cron: string }>;
  };
  concurrency?: unknown;
  env: Record<string, string>;
  jobs: Record<string, Job>;
};

const source = readFileSync(GATE_PATH, 'utf8');
const workflow = parse(source) as Workflow;
const gateJobs = JSON.parse(workflow.env.GATE_JOBS) as Record<string, string>;

function stepsUsing(job: Job, action: string): Step[] {
  return (job.steps ?? []).filter((step) => (step.uses ?? '').startsWith(action));
}

describe('mobile-e2e-gate.yml triggers', () => {
  it('can be called, dispatched and scheduled, off the hour', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_call', 'workflow_dispatch', 'schedule']);
    const [minute] = workflow.on.schedule[0].cron.split(' ');
    expect(Number(minute)).toBeGreaterThan(0);
  });

  it('reads "this is a call" off an input only workflow_call defines', () => {
    const callInputs = workflow.on.workflow_call.inputs;
    expect(callInputs.ref).toMatchObject({ required: true, type: 'string' });
    expect(callInputs.called).toMatchObject({ type: 'boolean', default: true });
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty('called');
    expect(workflow.on.workflow_dispatch.inputs.ref.default).toBe('');
  });

  it('refuses a call with an empty ref before resolving anything', () => {
    const [guard, resolveStep] = workflow.jobs.resolve.steps ?? [];
    expect(guard.if).toBe('inputs.called && !inputs.ref');
    expect(guard.run).toContain('exit 1');
    expect(resolveStep.id).toBe('sha');
  });

  it('exposes the verdict as the workflow_call output', () => {
    expect(workflow.on.workflow_call.outputs.passed.value).toBe('${{ jobs.verdict.outputs.passed }}');
    expect(workflow.on.workflow_call.outputs.sha.value).toBe('${{ jobs.resolve.outputs.sha }}');
  });
});

describe('mobile-e2e-gate.yml concurrency', () => {
  it('has no concurrency group at all, so no run cancels or queues behind another', () => {
    expect(workflow.concurrency).toBeUndefined();
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.concurrency, `${name} must not declare a concurrency group`).toBeUndefined();
    }
  });

  it('never names an OTA publish lock outside a comment', () => {
    const live = withoutCommentLines(source).join('\n');
    for (const lock of ['mobile-ota-production', 'mobile-ota-staging', 'production-deploy']) {
      expect(live).not.toContain(lock);
    }
  });
});

describe('mobile-e2e-gate.yml jobs', () => {
  it('has the six jobs plus the nightly notify', () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      'resolve',
      'boot-real-bytes',
      'expo-web',
      'android-smoke',
      'ios-smoke',
      'verdict',
      'notify',
    ]);
  });

  it('bounds every job that can carry a timeout', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      // A job that calls a reusable workflow cannot set one; e2e-tests.yml bounds its own.
      if (job.uses) continue;
      expect(job['timeout-minutes'], `${name} needs timeout-minutes`).toBeGreaterThan(0);
    }
  });

  it('spends exactly one macOS runner', () => {
    const macJobs = Object.entries(workflow.jobs).filter(([, job]) => (job['runs-on'] ?? '').startsWith('macos'));
    expect(macJobs.map(([name]) => name)).toEqual(['ios-smoke']);
  });

  it('pins every checkout to the resolved commit', () => {
    const checkouts = Object.entries(workflow.jobs).flatMap(([name, job]) =>
      stepsUsing(job, 'actions/checkout@').map((step) => ({ name, ref: step.with?.ref })),
    );
    expect(checkouts.map((checkout) => checkout.name)).toEqual(['android-smoke', 'ios-smoke', 'verdict']);
    for (const checkout of checkouts) {
      // The verdict falls back to the triggering commit only when `resolve`
      // failed, and then fails on the missing SHA.
      const expected = checkout.name === 'verdict' ? '${{ needs.resolve.outputs.sha || github.sha }}' : TESTED_SHA;
      expect(checkout.ref, `${checkout.name} checkout`).toBe(expected);
    }
  });

  it('calls the Expo-web smoke at the resolved commit', () => {
    expect(workflow.jobs['expo-web'].uses).toBe('./.github/workflows/e2e-tests.yml');
    expect(workflow.jobs['expo-web'].with).toEqual({ ref: TESTED_SHA });
  });

  it('keeps the real-bytes slot as a job that never runs', () => {
    const placeholder = workflow.jobs['boot-real-bytes'];
    expect(placeholder.if).toBe(false);
    expect(placeholder.needs).toBe('resolve');
    const notes = JSON.parse(workflow.env.GATE_NOTES) as Record<string, string>;
    expect(notes['boot-real-bytes']).toBe('not implemented yet: see the real-bytes PR');
  });

  it('runs both smokes on recorded fixtures, with one orchestrator attempt', () => {
    const [android] = stepsUsing(workflow.jobs['android-smoke'], ANDROID_ACTION_USES);
    expect(android.with).toEqual({ flow: 'smoke', fixtures: 'replay', attempts: '1' });
    const [ios] = stepsUsing(workflow.jobs['ios-smoke'], IOS_ACTION_USES);
    expect(ios.with).toMatchObject({
      flow: 'smoke',
      fixtures: 'replay',
      attempts: '1',
      'upload-captures': 'false',
      locale: 'en-US',
      'device-name': 'iPhone 16 Pro Max',
    });
  });

  it('never hands a smoke the capture account', () => {
    // Replay signs in against the backend's synthetic session.
    expect(withoutCommentLines(source).join('\n')).not.toContain('SCREENSHOT_USER_');
  });

  it('shares the simulator app cache with the capture workflow, key for key', () => {
    const keyLine = (text: string) =>
      text.split('\n').find((line) => line.includes('screenshot-sim-app-v1-${{ hashFiles('));
    expect(keyLine(source)).toBeTruthy();
    expect(keyLine(source)?.trim()).toBe(keyLine(readFileSync(IOS_CAPTURE_PATH, 'utf8'))?.trim());
  });

  it('reads each smoke result on every outcome', () => {
    for (const name of ['android-smoke', 'ios-smoke']) {
      const result = (workflow.jobs[name].steps ?? []).find((step) => step.id === 'result');
      expect(result?.if, name).toBe('always()');
      expect(result?.run, name).toBe('bash scripts/ci-mobile-smoke-outputs.sh');
    }
  });
});

describe('mobile-e2e-gate.yml verdict', () => {
  it('lists every judged job once in GATE_JOBS, each as blocking or advisory', () => {
    const judged = (workflow.jobs.verdict.needs as string[]).filter((name) => name !== 'resolve');
    expect(Object.keys(gateJobs)).toEqual(judged);
    for (const mode of Object.values(gateJobs)) expect(['blocking', 'advisory']).toContain(mode);
  });

  it('starts with every job advisory', () => {
    // The release PR flips the three suites once they have been green five
    // nights running; the real-bytes PR flips its own. Update this test then.
    expect(gateJobs).toEqual({
      'boot-real-bytes': 'advisory',
      'expo-web': 'advisory',
      'android-smoke': 'advisory',
      'ios-smoke': 'advisory',
    });
  });

  it('runs on every outcome and computes the verdict with the tested script', () => {
    const verdict = workflow.jobs.verdict;
    expect(verdict.if).toBe('always()');
    const compute = (verdict.steps ?? []).find((step) => step.id === 'verdict');
    expect(compute?.run).toBe('vp run mobile:e2e-gate-verdict');
    expect(compute?.env).toMatchObject({ GATE_NEEDS: '${{ toJSON(needs) }}', GATE_SHA: TESTED_SHA });
  });

  it('posts to Discord from the nightly only, when something is red', () => {
    expect(workflow.jobs.notify.if).toBe(
      "${{ always() && github.event_name == 'schedule' && !inputs.called && (needs.verdict.result != 'success' || needs.verdict.outputs.any_red == 'true') }}",
    );
  });

  it('gives the environment that holds the webhook to the notify job alone', () => {
    const withEnvironment = Object.entries(workflow.jobs).filter(([, job]) => job.environment !== undefined);
    expect(withEnvironment.map(([name, job]) => [name, job.environment])).toEqual([['notify', 'Production']]);
  });
});

describe('android-emulator-capture composite action', () => {
  const action = parse(readFileSync(ANDROID_ACTION_PATH, 'utf8')) as {
    inputs: Record<string, { default?: string }>;
    outputs: Record<string, { value: string }>;
    runs: { using: string; steps: Step[] };
  };

  it('is the one emulator setup both workflows use', () => {
    expect(action.runs.using).toBe('composite');
    const capture = parse(readFileSync(ANDROID_CAPTURE_PATH, 'utf8')) as Workflow;
    expect(stepsUsing(capture.jobs.android, ANDROID_ACTION_USES)).toHaveLength(1);
    expect(stepsUsing(workflow.jobs['android-smoke'], ANDROID_ACTION_USES)).toHaveLength(1);
    // Neither workflow boots an emulator of its own any more.
    for (const path of [ANDROID_CAPTURE_PATH, GATE_PATH]) {
      expect(readFileSync(path, 'utf8')).not.toContain('reactivecircus/android-emulator-runner');
    }
  });

  it('defaults to the store capture: three attempts on replay', () => {
    expect(Object.keys(action.inputs)).toEqual([
      'flow',
      'android-device',
      'render-mode',
      'boards',
      'fixtures',
      'frozen-now',
      'fixture-snapshot',
      'attempts',
      'user-email',
      'user-password',
    ]);
    expect(action.inputs.flow.default).toBe('app-store');
    expect(action.inputs.attempts.default).toBe('3');
    expect(action.inputs.fixtures.default).toBe('replay');
  });

  it('leaves the checkout to its caller', () => {
    expect(stepsUsing({ steps: action.runs.steps }, 'actions/checkout@')).toEqual([]);
  });

  it('hands the capture account to the emulator step only', () => {
    const holders = action.runs.steps.filter((step) => step.env?.SCREENSHOT_USER_PASSWORD !== undefined);
    expect(holders.map((step) => step.uses)).toEqual(['reactivecircus/android-emulator-runner@v2']);
  });

  it('keeps the capture account off replay runs in the capture workflow', () => {
    const capture = parse(readFileSync(ANDROID_CAPTURE_PATH, 'utf8')) as Workflow;
    const [step] = stepsUsing(capture.jobs.android, ANDROID_ACTION_USES);
    expect(step.with?.['user-password']).toBe(
      "${{ (inputs.fixtures || 'replay') != 'replay' && secrets.SCREENSHOT_USER_PASSWORD || '' }}",
    );
  });
});
