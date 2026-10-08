/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_HOSTS } from '../lib/ota-boot-check';
import { parseBootCheckArgs } from '../mobile-ota-boot-check';

/**
 * The boot check decides whether a day's release goes out, and it runs a release
 * build of the app against the production update server. Its shape is pinned
 * here: it holds no secret, takes no publish lock, builds the binary from the
 * commit under test, and never launches the update with its analytics reachable.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'mobile-ota-boot-check.yml');
const source = readFileSync(WORKFLOW_PATH, 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  'runs-on': string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  environment?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
}
const workflow = parse(source) as {
  on: {
    workflow_call: { inputs: Record<string, { default?: string }>; outputs: Record<string, { value: string }> };
    workflow_dispatch: { inputs: Record<string, { default?: string }> };
    pull_request: { paths: string[] };
  };
  permissions: Record<string, string>;
  concurrency: { group: string };
  env: Record<string, string>;
  jobs: Record<'resolve' | 'ios' | 'android' | 'verdict', Job>;
};

const stepNamed = (job: Job, name: string): Step => {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`No step named "${name}"`);
  return step;
};
const indexOfStep = (job: Job, name: string): number => job.steps.indexOf(stepNamed(job, name));

describe('mobile-ota-boot-check.yml', () => {
  it('can be called, dispatched, and runs itself on a PR that edits it', () => {
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(['ref', 'branch', 'receipt_json']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['ref', 'branch', 'receipt_json']);
    expect(workflow.on.workflow_call.inputs.branch.default).toBe('pr-staging');
    expect(workflow.on.workflow_call.outputs.passed.value).toBe('${{ jobs.verdict.outputs.passed }}');
    expect(workflow.on.pull_request.paths).toEqual([
      '.github/workflows/mobile-ota-boot-check.yml',
      'scripts/mobile-ota-boot-check.ts',
      'scripts/mobile-ota-boot-fixture.gradle',
      'scripts/lib/ota-boot-check.ts',
      'scripts/mobile-ota-boot-preview.ts',
      'scripts/lib/ota-preview-boot-receipt.ts',
      'scripts/lib/ota-publish-protocol.ts',
    ]);
  });

  it('pins every action to a commit', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(10);
    for (const action of uses) {
      // The one local action is read from the commit under test.
      if (action === './.github/actions/android-rn-setup') continue;
      expect(action, action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it('tests the triggering PR head on its own preview, with time to wait for an attested publication', () => {
    const resolveJob = workflow.jobs.resolve;
    expect(resolveJob['timeout-minutes']).toBeGreaterThan(25);
    expect(workflow.env.UPDATE_BRANCH).toContain("format('pr-{0}', github.event.pull_request.number)");
    const checkout = stepNamed(resolveJob, 'Check out the PR receipt resolver');
    expect(checkout.if).toBe("github.event_name == 'pull_request'");
    expect(checkout.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(checkout.with?.['persist-credentials']).toBe(false);
    const wait = stepNamed(resolveJob, "Wait for this PR head's frozen preview");
    expect(wait.env?.PR_HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
    expect(wait.run).toContain('mobile-ota-boot-preview.ts');
    const receipt = stepNamed(resolveJob, 'Find the receipt for the commit under test');
    expect(receipt.env?.REF).toContain('github.event.pull_request.head.sha');
    expect(receipt.run).toContain('if [ "$EVENT_NAME" = "pull_request" ]; then');
    expect(receipt.run).toContain('elif [ -n "$RECEIPT_JSON" ]; then');
  });

  it('archives a preview receipt only after both actual publisher steps succeed', () => {
    const preview = parse(readFileSync(join(REPO_ROOT, '.github/workflows/mobile-ota-preview.yml'), 'utf8')) as {
      jobs: { publish: Job };
    };
    const publishJob = preview.jobs.publish;
    for (const platform of ['ios', 'android']) {
      const step = stepNamed(publishJob, `Publish ${platform === 'ios' ? 'iOS' : 'Android'} OTA`);
      expect(step.env?.OTA_PREVIEW_RECEIPT_PATH).toBe(`\${{ runner.temp }}/preview-${platform}.json`);
    }
    for (const name of ['Collect the frozen preview receipt', 'Archive the frozen preview receipt']) {
      expect(stepNamed(publishJob, name).if).toBe(
        "steps.publish_ios.outcome == 'success' && steps.publish_android.outcome == 'success'",
      );
    }
    expect(stepNamed(publishJob, 'Archive the frozen preview receipt').with?.name).toBe('mobile-ota-preview-receipt');
    expect(stepNamed(publishJob, 'Collect the frozen preview receipt').env?.HEAD_SHA).toBe(
      '${{ needs.gate.outputs.head_sha }}',
    );
    expect(stepNamed(publishJob, 'Collect the frozen preview receipt').run).toContain(
      '"$HEAD_SHA" "$BRANCH" "$GITHUB_RUN_ID" "$DEPLOYMENT_ID"',
    );
  });

  it('holds no secret and no environment', () => {
    expect(code).not.toMatch(/secrets\./);
    for (const job of Object.values(workflow.jobs)) expect(job.environment).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    // Reading another run's stage receipt is the only extra permission.
    expect(workflow.jobs.resolve.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      deployments: 'read',
      'pull-requests': 'read',
    });
  });

  it('stays out of every OTA publish lane', () => {
    expect(workflow.concurrency.group).toBe(
      'mobile-ota-boot-check-${{ github.event.pull_request.number || github.run_id }}',
    );
    expect(code).not.toMatch(/group:\s*mobile-ota-(production|beta|preview)/);
    expect(code).not.toMatch(/EOO_TOKEN|OTA_ADMIN|eoas/);
  });

  it('gives every job a timeout', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    }
  });

  it('builds the embedded bundle without analytics keys', () => {
    expect(Object.keys(workflow.env).filter((name) => /POSTHOG|SENTRY_DSN/.test(name))).toEqual([]);
    expect(code).not.toMatch(/EXPO_PUBLIC_POSTHOG_KEY|EXPO_PUBLIC_SENTRY_DSN/);
  });

  it('sinkholes exactly the hosts the script checks, before the update is launched', () => {
    expect(workflow.env.TELEMETRY_HOSTS.split(' ')).toEqual([...TELEMETRY_HOSTS]);
    for (const job of [workflow.jobs.ios, workflow.jobs.android]) {
      expect(stepNamed(job, "Sinkhole the update's telemetry hosts").run).toContain('/etc/hosts');
      expect(indexOfStep(job, "Sinkhole the update's telemetry hosts")).toBeLessThan(
        indexOfStep(job, 'Boot the update'),
      );
    }
    expect(code).not.toContain('--allow-telemetry');
  });

  describe.each(['ios', 'android'] as const)('%s job', (platform) => {
    const job = workflow.jobs[platform];

    it('builds from the commit under test and runs the check from this workflow', () => {
      expect(job.steps[0]).toMatchObject({
        name: 'Check out the commit under test',
        with: { ref: '${{ needs.resolve.outputs.commit }}' },
      });
      expect(job.steps[1]).toMatchObject({
        name: 'Check out the boot check',
        with: { path: '.boot-check', 'sparse-checkout': 'scripts' },
      });
    });

    it('caches the binary on the runtime version and the native inputs, and only builds on a miss', () => {
      const key = stepNamed(job, 'Compute the binary cache key').run ?? '';
      expect(key).toContain(`needs.resolve.outputs.${platform}_runtime`);
      for (const input of [
        'packages/mobile/app.config.ts',
        'packages/mobile/plugins/**',
        'packages/mobile/modules/**',
        'packages/mobile/package.json',
        'patches/**',
        'pnpm-workspace.yaml',
      ]) {
        expect(key, input).toContain(`'${input}'`);
      }
      const buildSteps = job.steps.filter((step) => /install|build|generate|pin|save|\.env/i.test(step.name ?? ''));
      expect(buildSteps.length).toBeGreaterThanOrEqual(3);
      for (const step of buildSteps) expect(step.if, step.name).toBe("steps.cache.outputs.cache-hit != 'true'");
    });

    it('passes the commit, the branch and the receipt to the script', () => {
      const step = stepNamed(job, 'Boot the update');
      const command = step.run ?? String(step.with?.script);
      expect(command).toContain('.boot-check/scripts/mobile-ota-boot-check.ts');
      expect(command).toContain(`--platform ${platform}`);
      expect(command).toContain('--branch "$UPDATE_BRANCH"');
      expect(command).toContain('--expect-commit "${{ needs.resolve.outputs.commit }}"');
      expect(command).toContain('--receipt "$RUNNER_TEMP/receipt.json"');
    });
  });

  it('bakes the branch into the Android build and its cache key', () => {
    const android = workflow.jobs.android;
    expect(stepNamed(android, 'Compute the binary cache key').run).toContain('${{ env.UPDATE_BRANCH }}');
    expect(indexOfStep(android, 'Pin the generated project to the branch')).toBeLessThan(
      indexOfStep(android, 'Build the release APK'),
    );
    expect(stepNamed(android, 'Build the release APK').run).toContain('-PreactNativeArchitectures=x86_64');
    // Reading the app's private update database needs adb root.
    expect(stepNamed(android, 'Boot the update').with).toMatchObject({ target: 'google_apis', arch: 'x86_64' });
  });

  it('stamps only generated fixture resources before normal APK packaging and verifies before caching', () => {
    const android = workflow.jobs.android;
    const build = stepNamed(android, 'Build the release APK');
    expect(build.env?.BOOT_CHECK_SCRIPT).toBe('${{ github.workspace }}/.boot-check/scripts/mobile-ota-boot-check.ts');
    expect(build.run).toContain('--init-script "$GITHUB_WORKSPACE/.boot-check/scripts/mobile-ota-boot-fixture.gradle"');
    expect(stepNamed(android, 'Compute the binary cache key').run).toContain('boot-check-android-v2-');
    const verify = stepNamed(android, 'Verify the prepared APK fixture');
    expect(verify.if).toBeUndefined();
    expect(verify.run).toContain('verify-android-fixture --apk boot-check-binary/app-release.apk');
    expect(indexOfStep(android, 'Build the release APK')).toBeLessThan(
      indexOfStep(android, 'Verify the prepared APK fixture'),
    );
    expect(indexOfStep(android, 'Verify the prepared APK fixture')).toBeLessThan(
      indexOfStep(android, 'Save the release APK'),
    );
  });

  it('fails the run unless resolution and both platform jobs succeeded and passed', () => {
    const verdict = workflow.jobs.verdict;
    expect(verdict.needs).toEqual(['resolve', 'ios', 'android']);
    const step = stepNamed(verdict, 'Require both platforms');
    expect(step.env).toMatchObject({
      RESOLVE_RESULT: '${{ needs.resolve.result }}',
      IOS_RESULT: '${{ needs.ios.result }}',
      ANDROID_RESULT: '${{ needs.android.result }}',
      IOS_PASSED: '${{ needs.ios.outputs.passed }}',
      ANDROID_PASSED: '${{ needs.android.outputs.passed }}',
    });
    const green = {
      RESOLVE_RESULT: 'success',
      IOS_RESULT: 'success',
      ANDROID_RESULT: 'success',
      IOS_PASSED: 'true',
      ANDROID_PASSED: 'true',
      GITHUB_OUTPUT: '/dev/null',
    };
    const runVerdict = (overrides: Record<string, string>) =>
      spawnSync('bash', ['-c', step.run ?? ''], {
        env: { ...process.env, ...green, ...overrides },
        encoding: 'utf8',
      });
    expect(runVerdict({}).status).toBe(0);
    for (const resultKey of ['RESOLVE_RESULT', 'IOS_RESULT', 'ANDROID_RESULT']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) {
        expect(runVerdict({ [resultKey]: result }).status, `${resultKey}=${result}`).toBe(1);
      }
    }
    for (const passedKey of ['IOS_PASSED', 'ANDROID_PASSED']) {
      for (const passed of ['false', '']) expect(runVerdict({ [passedKey]: passed }).status).toBe(1);
    }
  });
});

describe('boot check arguments', () => {
  const required = [
    '--platform',
    'ios',
    '--app-path',
    'Boardsesh.app',
    '--branch',
    'pr-staging',
    '--expect-commit',
    'a'.repeat(40),
    '--receipt',
    'receipt.json',
  ];

  it('defaults to a 30 second watch, a checked sinkhole and the production update server', () => {
    expect(parseBootCheckArgs(required, undefined)).toMatchObject({
      platform: 'ios',
      branch: 'pr-staging',
      manifestUrl: 'https://updates.boardsesh.com/manifest',
      device: '',
      evidenceDir: null,
      downloadTimeoutSeconds: 240,
      watchSeconds: 30,
      allowTelemetry: false,
    });
    expect(parseBootCheckArgs(required, 'https://updates.example/manifest').manifestUrl).toBe(
      'https://updates.example/manifest',
    );
  });

  it('refuses a missing or unknown argument', () => {
    expect(() => parseBootCheckArgs(required.slice(2), undefined)).toThrow('--platform is required');
    expect(() => parseBootCheckArgs([...required, '--skip'], undefined)).toThrow('Unknown argument: --skip');
    expect(() => parseBootCheckArgs(['--platform', 'web', ...required.slice(2)], undefined)).toThrow(
      '--platform must be',
    );
    expect(() => parseBootCheckArgs([...required, '--watch-seconds', '0'], undefined)).toThrow('1 to 3600 seconds');
  });
});
