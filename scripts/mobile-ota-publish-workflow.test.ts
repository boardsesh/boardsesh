/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  minimumPublishJobTimeoutMinutes,
  PRODUCTION_OTA_UNLOCK_BUDGET_MINUTES,
  SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES,
} from './lib/mobile-publish-retry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github', 'workflows');
const production = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-production.yml'), 'utf8');
const pipeline = readFileSync(resolve(WORKFLOW_DIR, 'production-deploy.yml'), 'utf8');
const backport = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-backport.yml'), 'utf8');
const preview = readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-preview.yml'), 'utf8');

function jobBlock(workflow: string, jobName: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const start = workflow.indexOf(`\n  ${jobName}:\n`, jobsStart);
  const remainingWorkflow = workflow.slice(start + 1);
  const nextJobOffset = remainingWorkflow.search(/\n  [a-zA-Z0-9_-]+:\n/);
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(jobsStart);
  return nextJobOffset >= 0 ? workflow.slice(start, start + 1 + nextJobOffset) : workflow.slice(start);
}

function stepBlock(workflow: string, stepName: string): string {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  const nextStepOffset = workflow.slice(start + 1).indexOf('\n      - name: ');
  const end = nextStepOffset >= 0 ? start + 1 + nextStepOffset : workflow.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe('production OTA workflow reliability', () => {
  it('stages main alongside service builds, then promotes after backend deployment', () => {
    const mobile = parse(production) as { on: { push: { branches: string[] } }; jobs: Record<string, unknown> };
    const deploy = parse(pipeline) as {
      jobs: Record<
        string,
        {
          needs?: string[] | string;
          uses?: string;
          with?: Record<string, unknown>;
          concurrency?: { group: string; queue: string };
        }
      >;
    };
    expect(mobile.on.push.branches).toEqual(['release/next']);
    expect(deploy.jobs['stage-mobile-ota'].needs).toBe('detect-changes');
    expect(deploy.jobs['stage-mobile-ota'].uses).toBe('./.github/workflows/mobile-ota-production.yml');
    expect(deploy.jobs['stage-mobile-ota'].with?.stage_for_production_deploy).toBe(true);
    expect(deploy.jobs['promote-mobile-ota'].needs).toContain('stage-mobile-ota');
    expect(deploy.jobs['promote-mobile-ota'].needs).toContain('deploy-production-backend');
    expect(deploy.jobs['promote-mobile-ota'].concurrency).toMatchObject({
      group: 'mobile-ota-production',
      queue: 'max',
    });
    const promotion = jobBlock(pipeline, 'promote-mobile-ota');
    expect(promotion).toContain('scripts/mobile-ota-schema-ready.mjs');
    expect(promotion).not.toContain('main advanced since staging');
    expect(promotion).not.toContain('git diff --quiet "$GITHUB_SHA" origin/main');
    expect(promotion).not.toContain('Push promoted changelog to main');
    expect(jobBlock(pipeline, 'push-promoted-changelog')).toContain(
      'main advanced; leaving the changelog to the newer deploy',
    );
    expect(promotion).toContain('scripts/mobile-ota-promote.ts');
    expect(promotion).toContain('ota-stage/ios');
    expect(promotion).toContain('ota-stage/android');
    expect(production).toContain("'pr-staging'");
    expect(production).toContain('scripts/mobile-ota-stage-verify.ts');
    expect(production).not.toContain('await-backend-schema:');
  });
  it('archives both beta and production baselines captured before either staged export', () => {
    const baseline = stepBlock(production, 'Capture production OTA baseline before staging');
    const receipt = stepBlock(production, 'Record staged export fingerprints and hashes');
    const capture = jobBlock(production, 'capture-staging-baselines');
    expect(capture).toContain('--capture-baseline --branch pr-beta --verify-empty-target');
    expect(capture).toContain('--out early-baseline.json');
    expect(capture).toContain('--out production-baseline.json');
    expect(baseline).toContain('needs.capture-staging-baselines.outputs.early_baseline');
    expect(baseline).toContain('needs.capture-staging-baselines.outputs.production_baseline');
    expect(baseline).toContain('> ota-stage/early-baseline.json');
    expect(baseline).toContain('> ota-stage/baseline.json');
    for (const platform of ['iOS', 'Android']) {
      expect(production.indexOf('      - name: Capture production OTA baseline before staging')).toBeLessThan(
        production.indexOf(`      - name: Publish ${platform} OTA`),
      );
      expect(stepBlock(production, `Publish ${platform} OTA`)).toContain("steps.baseline.outcome == 'success'");
    }
    expect(receipt).toContain('--slurpfile early_baseline ota-stage/early-baseline.json');
    expect(receipt).toContain('baselineEarlyUpdateIds:$early_baseline[0]');
    expect(receipt).toContain('baselineProductionUpdateIds:$baseline[0]');
    expect(stepBlock(production, 'Upload staged OTA export')).toContain('path: ota-stage/');
  });

  it('serializes runs without cancelling an active publish and has enough retry time', () => {
    expect(production).toContain("'mobile-ota-staging' || 'mobile-ota-production'");
    expect(production).toContain('cancel-in-progress: false');
    const timeout = Number(jobBlock(production, 'publish').match(/timeout-minutes: (\d+)/)?.[1]);
    // iOS then Android in one job, so the job must outlast two full backoff
    // budgets. Killed mid-backoff, the run dies by timeout and never reports
    // `s3-slowdown` or fires the failure notification.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(2, false, true));
  });

  it('waits for a same-commit OTA server rollout before every upload to the server', () => {
    const gateStep = 'Wait for the OTA server rollout on this commit';
    // Staging: the gate runs before the first publish step.
    const publishJob = jobBlock(production, 'publish');
    expect(stepBlock(publishJob, gateStep)).toContain('node scripts/mobile-ota-server-ready.mjs');
    expect(publishJob.indexOf(gateStep)).toBeLessThan(publishJob.indexOf('vp run mobile:publish'));
    expect(parse(production).permissions).toMatchObject({ contents: 'read', actions: 'read' });
    // Promotion: a second upload, so a second check before it.
    const promotion = jobBlock(pipeline, 'promote-mobile-ota');
    expect(stepBlock(promotion, gateStep)).toContain('node scripts/mobile-ota-server-ready.mjs');
    expect(promotion.indexOf(gateStep)).toBeLessThan(promotion.indexOf('scripts/mobile-ota-promote.ts'));
    // The gate diffs HEAD against its parent, so both checkouts need full history.
    expect(publishJob).toMatch(/fetch-depth: 0/);
    expect(promotion).toMatch(/fetch-depth: 0/);
    const deployJobs = (parse(pipeline) as { jobs: Record<string, { permissions?: Record<string, string> }> }).jobs;
    expect(deployJobs['stage-mobile-ota'].permissions).toMatchObject({ actions: 'write' });
    expect(deployJobs['promote-mobile-ota'].permissions).toMatchObject({ actions: 'read' });
  });

  it('gives the staging publish room for the server-rollout wait on top of its retry budget', () => {
    const gateSource = readFileSync(resolve(REPO_ROOT, 'scripts', 'mobile-ota-server-ready.mjs'), 'utf8');
    const waitMinutes = Number(gateSource.match(/WAIT_BUDGET_MS = (\d+) \* 60_000/)?.[1]);
    expect(waitMinutes).toBeGreaterThan(0);
    const timeout = Number(jobBlock(production, 'publish').match(/timeout-minutes: (\d+)/)?.[1]);
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(2, false, true) + waitMinutes);
  });

  it('separates installed fingerprint resolution from trusted admin baseline capture', () => {
    const resolveJob = jobBlock(production, 'resolve-staging-runtimes');
    const captureJob = jobBlock(production, 'capture-staging-baselines');
    const publishJob = jobBlock(production, 'publish');
    expect(resolveJob).toContain('environment: Production');
    expect(resolveJob).toContain('vp install --frozen-lockfile');
    expect(resolveJob).not.toContain('OTA_ADMIN');
    expect(captureJob).toContain('environment: ota-stable-release');
    expect(captureJob).toContain('needs: resolve-staging-runtimes');
    expect(captureJob).not.toMatch(/vp install|setup-vp|vp exec|EOO_TOKEN/);
    for (const job of [resolveJob, captureJob]) {
      expect(job).toContain('if: inputs.stage_for_production_deploy');
      expect(job.indexOf('Refuse any ref but main')).toBeLessThan(job.indexOf('actions/checkout@'));
      expect(job).toContain("if: github.ref != 'refs/heads/main'");
      expect(job).toContain('ref: ${{ github.sha }}');
      expect(job).toContain('persist-credentials: false');
    }
    expect(publishJob).not.toContain('OTA_ADMIN');
    const authenticate = stepBlock(captureJob, 'Capture authenticated early baseline');
    expect(authenticate).toContain('--verify-empty-target');
    expect(authenticate).toContain('::add-mask::$OTA_ADMIN_EMAIL');
    expect(captureJob.slice(0, captureJob.indexOf('      - name: Capture authenticated early baseline'))).not.toContain(
      'OTA_ADMIN',
    );
  });

  it('uses identical .env inputs and platform-specific maps keys for both staging resolutions', () => {
    const resolveJob = jobBlock(production, 'resolve-staging-runtimes');
    const publisher = jobBlock(production, 'publish');
    const dotenv = (job: string) => job.match(/cat > \.env <<EOF([\s\S]*?)\n          EOF/)?.[1];
    expect(dotenv(resolveJob)).toBeDefined();
    expect(dotenv(resolveJob)).toBe(dotenv(publisher));
    for (const step of [
      stepBlock(resolveJob, 'Resolve staged native runtimes'),
      stepBlock(publisher, 'Capture production OTA baseline before staging'),
    ]) {
      expect(step).toContain('env -u GOOGLE_MAPS_API_KEY vp exec expo-updates runtimeversion:resolve --platform ios');
      expect(step).toContain(
        'GOOGLE_MAPS_API_KEY="$ANDROID_MAPS_KEY" vp exec expo-updates runtimeversion:resolve --platform android',
      );
      expect(step).toContain('ANDROID_MAPS_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    }
    const parity = stepBlock(publisher, 'Capture production OTA baseline before staging');
    expect(parity).toContain('[ "$ios_runtime" != "$IOS_RUNTIME" ] || [ "$android_runtime" != "$ANDROID_RUNTIME" ]');
    expect(parity.indexOf('exit 1')).toBeLessThan(parity.indexOf('> ota-stage/baseline.json'));
    expect(parity).not.toContain('--capture-baseline');
  });

  it('allows direct publishes when staging prerequisites skip, and blocks failed staging capture', () => {
    const workflow = parse(production) as {
      jobs: Record<string, { if?: string; needs?: string[] }>;
    };
    const publisher = workflow.jobs.publish;
    expect(publisher.needs).toEqual(['resolve-staging-runtimes', 'capture-staging-baselines', 'live-store-runtimes']);
    const expression = publisher
      .if!.replace(/needs\.([a-z-]+)/g, 'needs["$1"]')
      .replaceAll('github.ref', '"refs/heads/main"');
    // Execute the actual workflow expression so a dependency/always change is caught.
    // oxlint-disable-next-line no-implied-eval
    const permits = new Function('inputs', 'needs', 'always', 'cancelled', `return ${expression};`) as (
      inputs: { stage_for_production_deploy: boolean },
      needs: Record<string, { result: string }>,
      always: () => boolean,
      cancelled: () => boolean,
    ) => boolean;
    for (const first of ['success', 'skipped', 'failure', 'cancelled']) {
      for (const second of ['success', 'skipped', 'failure', 'cancelled']) {
        const needs = {
          'resolve-staging-runtimes': { result: first },
          'capture-staging-baselines': { result: second },
        };
        expect(
          permits(
            { stage_for_production_deploy: false },
            needs,
            () => true,
            () => false,
          ),
        ).toBe(true);
        expect(
          permits(
            { stage_for_production_deploy: true },
            needs,
            () => true,
            () => false,
          ),
        ).toBe(first === 'success' && second === 'success');
        expect(
          permits(
            { stage_for_production_deploy: false },
            needs,
            () => true,
            () => true,
          ),
        ).toBe(false);
      }
    }
  });

  it('runs authenticated beta promotion only from exact main without installing dependencies', () => {
    const early = jobBlock(pipeline, 'promote-early-mobile-ota');
    expect(early).toContain('environment: ota-stable-release');
    expect(early).toContain('ref: ${{ github.sha }}');
    expect(early.indexOf('Refuse any ref but main')).toBeLessThan(early.indexOf('actions/checkout@'));
    expect(early).not.toMatch(/vp install|setup-vp/);
    const promotion = stepBlock(early, 'Promote exact staged bytes to early updates');
    expect(promotion).toContain('mobile-ota-promote-track.ts ota-stage --verify-empty-target');
    expect(promotion).toContain('::add-mask::$OTA_ADMIN_EMAIL');
    expect(early.slice(0, early.indexOf('      - name: Promote exact staged bytes'))).not.toMatch(
      /OTA_ADMIN|EOO_TOKEN/,
    );
  });

  it('keeps the gate watching exactly the paths that trigger the Railway apply job', () => {
    const railway = parse(readFileSync(resolve(WORKFLOW_DIR, 'railway-drift.yml'), 'utf8')) as {
      on: { push: { paths: string[] } };
    };
    const gateSource = readFileSync(resolve(REPO_ROOT, 'scripts', 'mobile-ota-server-ready.mjs'), 'utf8');
    const listed = gateSource.match(/RAILWAY_APPLY_PATHS = \[([\s\S]*?)\];/)?.[1] ?? '';
    const gatePaths = [...listed.matchAll(/'([^']+)'/g)].map(([, path]) => path);
    expect(gatePaths.map((path) => (path.endsWith('/') ? `${path}**` : path)).sort()).toEqual(
      [...railway.on.push.paths].sort(),
    );
  });

  it('keeps the job-overhead allowance above the steps it is meant to cover', () => {
    // SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES is an estimate, and the source-map
    // uploads are the bulk of it. They carry their own `timeout-minutes`, so
    // raising those silently erodes the headroom every publish job's timeout is
    // derived from. Re-read them here instead of trusting the constant's comment.
    // Select by indentation rather than by position: a job-level key sits at 4
    // spaces and a step-level one at 8, so this stays correct no matter what
    // order the keys appear in.
    const publishJob = jobBlock(production, 'publish');
    const stepTimeouts = [...publishJob.matchAll(/^ {8}timeout-minutes: (\d+)$/gm)].map(([, minutes]) =>
      Number(minutes),
    );
    const stepTimeoutTotal = stepTimeouts.reduce((total, minutes) => total + minutes, 0);

    // Guard the selector itself: the job-level timeout must not be in this set,
    // otherwise the comparison below would be measuring the wrong thing.
    const jobTimeout = Number(publishJob.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    expect(jobTimeout).toBeGreaterThan(0);
    expect(stepTimeouts).not.toContain(jobTimeout);

    expect(stepTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES + PRODUCTION_OTA_UNLOCK_BUDGET_MINUTES).toBeGreaterThan(
      stepTimeoutTotal,
    );
  });

  it('budgets direct unlock waiting without charging staging or previews', () => {
    const unlockScript = readFileSync(resolve(REPO_ROOT, 'scripts', 'mobile-ota-unlock-wait.mjs'), 'utf8');
    const leaseScript = readFileSync(resolve(REPO_ROOT, 'scripts', 'lib', 'ota-unlock-lease.mjs'), 'utf8');
    expect(unlockScript).toContain('UNLOCK_WAIT_MS = MAX_UNLOCK_LEASE_MS');
    const waitMinutes = Number(leaseScript.match(/MAX_UNLOCK_LEASE_MS = (\d+) \* 60_000/)?.[1]);
    expect(waitMinutes).toBe(20);
    for (const [workflow, stepName] of [
      [production, 'Await trusted main unlock before direct production publish'],
      [backport, 'Await trusted main unlock before the backport publish'],
    ]) {
      const timeout = Number(stepBlock(workflow, stepName).match(/timeout-minutes: (\d+)/)?.[1]);
      expect(timeout).toBeGreaterThan(waitMinutes);
      expect(PRODUCTION_OTA_UNLOCK_BUDGET_MINUTES).toBeGreaterThanOrEqual(timeout);
    }
    expect(minimumPublishJobTimeoutMinutes(2, false, true) - minimumPublishJobTimeoutMinutes(2)).toBe(
      PRODUCTION_OTA_UNLOCK_BUDGET_MINUTES,
    );
  });

  it('attempts Android after iOS and records the aggregate result', () => {
    const ios = stepBlock(production, 'Publish iOS OTA');
    const android = stepBlock(production, 'Publish Android OTA');
    const summary = stepBlock(production, 'Summarize platform publish results');

    expect(ios).toContain("steps.generate.outcome == 'success'");
    expect(ios).toContain('continue-on-error: true');
    expect(android).toContain('if: always()');
    expect(android).toContain("steps.generate.outcome == 'success'");
    expect(android).toContain('continue-on-error: true');
    expect(summary).toContain('all_success');
    expect(summary).toContain('any_success');
    expect(summary).toContain('no automatic rollback was attempted');
    const allSuccessOutputIndex = summary.indexOf('echo "all_success=$all_success" >> "$GITHUB_OUTPUT"');
    const anySuccessOutputIndex = summary.indexOf('echo "any_success=$any_success" >> "$GITHUB_OUTPUT"');
    const failureGuardIndex = summary.indexOf('if [ "$all_success" != true ]; then');
    const failureExitIndex = summary.indexOf('exit 1', failureGuardIndex);
    const failureGuardEndIndex = summary.indexOf('\n          fi', failureGuardIndex);
    expect(allSuccessOutputIndex).toBeGreaterThanOrEqual(0);
    expect(anySuccessOutputIndex).toBeGreaterThanOrEqual(0);
    expect(failureGuardIndex).toBeGreaterThanOrEqual(0);
    expect(failureExitIndex).toBeGreaterThan(failureGuardIndex);
    expect(failureGuardEndIndex).toBeGreaterThan(failureExitIndex);
    expect(failureGuardIndex).toBeGreaterThan(allSuccessOutputIndex);
    expect(failureGuardIndex).toBeGreaterThan(anySuccessOutputIndex);
    expect(failureExitIndex).toBeGreaterThan(allSuccessOutputIndex);
    expect(failureExitIndex).toBeGreaterThan(anySuccessOutputIndex);
  });

  it('pushes the changelog and announces success only after every requested platform succeeds', () => {
    const push = stepBlock(production, 'Push changelog to main');
    const success = stepBlock(production, 'Notify deployments channel');

    expect(push).toContain("steps.publish_summary.outputs.all_success == 'true'");
    expect(push).not.toContain('if: always()');
    expect(success).toContain("steps.publish_summary.outputs.all_success == 'true'");
    expect(success).not.toContain("steps.publish_ios.outcome == 'success' ||");
  });

  // eoas records an update's message AND its commitHash from HEAD. Committing the
  // regenerated changelog before publishing made HEAD a throwaway
  // `chore(changelog)` commit, so every row on the OTA server was stamped with a
  // sha that the push step never even pushed (it resets to origin/main and commits
  // afresh) — leaving the dashboard's Message and Commit columns useless. The
  // publish must run with HEAD still on the triggering commit.
  it('publishes with HEAD on the triggering commit, committing the changelog only afterwards', () => {
    const generateIndex = production.indexOf('      - name: Generate changelog\n');
    const publishIndex = production.indexOf('      - name: Publish iOS OTA\n');
    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(generateIndex);

    const beforePublish = production.slice(generateIndex, publishIndex);
    expect(
      beforePublish,
      'nothing may commit before the publish — it would move HEAD off the triggering commit',
    ).not.toMatch(/^\s*git commit\b/m);
    // Guard the guard: the changelog must still reach main, just later. Without
    // this, deleting the commit everywhere would satisfy the assertion above.
    expect(stepBlock(production, 'Push changelog to main')).toMatch(/^\s*git commit -m/m);
  });

  // Disabling eoas' clean-tree check removes an accidental integrity guard: a
  // stray dirtied file would otherwise be bundled into a production OTA unnoticed.
  // This step is the replacement, so it must run before the first publish.
  it('asserts the working tree carries only the regenerated changelog before publishing', () => {
    const assertion = stepBlock(production, 'Assert only the changelog is uncommitted');

    expect(assertion).toContain('git status --porcelain --untracked-files=all');
    expect(assertion).toContain('CHANGELOG.md packages/mobile/src/data/changelog.generated.json');
    expect(assertion).toContain('exit 1');
    expect(production.indexOf('      - name: Assert only the changelog is uncommitted\n')).toBeLessThan(
      production.indexOf('      - name: Publish iOS OTA\n'),
    );
  });

  // A native build dispatches a republish under the fingerprint it just shipped.
  // If main has moved to a NEW native change by the time that run gets a runner,
  // publishing would resolve the new fingerprint and ship JS assuming native code
  // the uploaded binary lacks — so the run must re-resolve and skip.
  it('re-resolves the fingerprint for a dispatched republish and lets it gate the publish', () => {
    const inputs = (parse(production) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } }).on
      .workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toContain('expect_fingerprint');

    const verify = stepBlock(production, 'Verify the fingerprint still matches the build that asked for this');
    expect(verify).toContain('runtimeversion:resolve --platform "$PLATFORM"');
    expect(verify).toContain('scripts/mobile-fingerprint-match.ts');
    // A mismatch is a SKIP, not a failure: the binary is simply unreachable now
    // and a new native build is already on the way.
    expect(verify).toContain('::warning::');

    // The assertion that stops this being decorative. A resolve step whose output
    // nothing consumes would leave the guard inert while every check above passed.
    for (const stepName of ['Publish iOS OTA', 'Publish Android OTA']) {
      expect(stepBlock(production, stepName), `${stepName} must honour the fingerprint verdict`).toContain(
        "steps.expect.outputs.mismatch != 'true'",
      );
    }
  });

  // The postcondition, checked against the server rather than inferred from a
  // green publish step — the 2026-09-01 stranding had a green publish too.
  it('verifies a republished update is actually served, and is newer than the build', () => {
    const verify = stepBlock(production, 'Verify the republished update is the one the fleet will see');

    expect(verify).toContain('expo-runtime-version: $EXPECT_FINGERPRINT');
    expect(verify).toContain('createdAt');
    expect(verify).toContain('STARTED_AT');
    expect(verify).toContain('exit 1');
    expect(verify).toContain("steps.publish_summary.outputs.all_success == 'true'");
  });

  // cancel-in-progress: false protects only the RUNNING run; GitHub still cancels
  // a PENDING one when a new run queues. The republishes are dispatched per
  // platform and do not cover for each other, so a superseded pending run leaves
  // that platform's fleet stranded.
  it('queues runs in the shared production lane instead of superseding pending ones', () => {
    type Concurrency = { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
    const productionWorkflow = parse(production) as {
      concurrency?: Concurrency;
      jobs: Record<string, { concurrency?: Concurrency }>;
    };
    // The lane sits on the publish job alone: a workflow-level group let a
    // notify job that never got a runner hold it for 27 hours (run 40105607795).
    expect(productionWorkflow.concurrency).toBeUndefined();
    expect(
      Object.entries(productionWorkflow.jobs)
        .filter(([, job]) => job.concurrency !== undefined)
        .map(([jobName]) => jobName),
    ).toEqual(['publish']);
    for (const [name, concurrency] of [
      ['mobile-ota-production.yml', productionWorkflow.jobs.publish.concurrency ?? {}],
      ['mobile-ota-backport.yml', (parse(backport) as { concurrency: Concurrency }).concurrency],
    ] as const) {
      // Read the PARSED concurrency block, not the workflow text: both files
      // explain `queue: max` in a comment right above the setting, so a
      // `toContain('queue: max')` stays green when the setting itself is deleted.
      if (name === 'mobile-ota-production.yml') {
        expect(concurrency.group).toContain("'mobile-ota-staging' || 'mobile-ota-production'");
      } else {
        expect(concurrency.group, `${name} must share the production lane`).toBe('mobile-ota-production');
      }
      expect(concurrency.queue, `${name} shares the lane, so it must queue too`).toBe('max');
      expect(concurrency['cancel-in-progress']).toBe(false);
    }
  });

  it('runs the health check after any successful platform, including partial success', () => {
    const health = stepBlock(production, 'OTA health check (non-blocking)');

    expect(health).toContain('if: always()');
    expect(health).toContain("steps.publish_ios.outcome == 'success' || steps.publish_android.outcome == 'success'");
  });

  it('reruns when the self-hosted publish implementation changes', () => {
    for (const implementationPath of [
      'scripts/mobile-publish.ts',
      'scripts/lib/mobile-publish-retry.ts',
      'scripts/lib/ota-branch-probe.ts',
      'scripts/lib/eoas.ts',
    ]) {
      expect(parse(production).on.push.paths).toBeUndefined();
      // Preview intentionally has no trigger paths filter: every synchronize
      // must run so removing the final mobile change tears down the old branch.
      expect(preview).toContain(`path === '${implementationPath}'`);
    }
  });

  it('gives the preview publish job enough time for bounded platform retries', () => {
    const timeout = Number(jobBlock(preview, 'publish').match(/timeout-minutes: (\d+)/)?.[1]);
    // Same shape as production: one job publishes both platforms sequentially.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(2, true));
  });
});

describe('backport OTA workflow upload pressure', () => {
  it('stays manual-only while publishing through the shared wrapper', () => {
    expect(backport).toContain('on:\n  workflow_dispatch:');
    expect(backport).not.toContain('on:\n  push:');
    expect(backport).toContain('vp run mobile:publish -- --channel production');
  });

  it('shares the production lane and limits the platform matrix to one publish', () => {
    expect(backport).toContain('group: mobile-ota-production');
    expect(backport).toContain('cancel-in-progress: false');
    expect(backport).toContain('max-parallel: 1');
    const timeout = Number(jobBlock(backport, 'backport').match(/timeout-minutes: (\d+)/)?.[1]);
    // `max-parallel: 1` over a platform matrix, so each job publishes one
    // platform and needs one backoff budget rather than two.
    expect(timeout).toBeGreaterThanOrEqual(minimumPublishJobTimeoutMinutes(1, false, true));
  });

  it('checks out the release anchor before the package-manager-neutral install', () => {
    const anchorPosition = backport.indexOf('- name: Locate the release anchor and prepare the hotfix tree');
    const installPosition = backport.indexOf('- name: Install Node.js dependencies (workspace root)');
    const install = stepBlock(backport, 'Install Node.js dependencies (workspace root)');

    expect(anchorPosition).toBeGreaterThanOrEqual(0);
    expect(installPosition).toBeGreaterThan(anchorPosition);
    expect(install).toContain('run: vp install --frozen-lockfile');
    expect(install).not.toContain('pnpm install');
    expect(backport).toContain('a frozen pre-pnpm anchor still installs with its');
    expect(backport).toContain('pinned Bun version');
  });

  it('overlays every trusted helper required by production publish and source-map upload', () => {
    const snapshot = stepBlock(backport, 'Snapshot trusted OTA publish tooling');
    const overlay = stepBlock(backport, 'Overlay trusted OTA publish tooling');
    const gitAddLine = overlay.split('\n').find((line) => line.trimStart().startsWith('git add '));

    for (const implementationPath of [
      'scripts/mobile-publish.ts',
      'scripts/mobile-release-train-policy.ts',
      'scripts/lib/mobile-release-policy.ts',
      'scripts/lib/release-tags.ts',
      'scripts/lib/ota-preview-boot-receipt.ts',
      'scripts/lib/ota-publish-protocol.ts',
      'scripts/lib/ota-boot-check.ts',
      'scripts/lib/eoas.ts',
      'scripts/lib/mobile-publish-retry.ts',
      'scripts/lib/ota-branch-probe.ts',
      'scripts/mobile-upload-sourcemaps.ts',
    ]) {
      expect(snapshot).toContain(implementationPath);
      expect(overlay).toContain(implementationPath);
      expect(gitAddLine).toContain(implementationPath);
    }
  });
});

describe('preview publish across an OTA server upgrade', () => {
  it('compares each replayed candidate pin against the pinned main server before publishing', () => {
    const helper = readFileSync(resolve(import.meta.dirname, 'mobile-ota-preview-candidates.ts'), 'utf8');
    expect(helper).toContain('`${source.mainSha}:scripts/lib/eoas.ts`');
    expect(helper).toContain("? 'server-upgrade'");
    expect(helper).toContain("result?.status !== 'ota-compatible'");
    const publishJob = jobBlock(preview, 'publish');
    expect(publishJob.indexOf('Rebase and compare both pinned preview candidates')).toBeLessThan(
      publishJob.indexOf('Publish compatible preview runtime variants'),
    );
  });
});

describe('publisher helper preview routing', () => {
  it.each(['mobile-ota-preview.yml', 'mobile-ota-preview-refresh.yml'])(
    '%s pins every third-party action to an immutable commit',
    (filename) => {
      const workflow = parse(readFileSync(resolve(WORKFLOW_DIR, filename), 'utf8')) as {
        jobs: Record<string, { steps: Array<{ uses?: string }> }>;
      };
      const actions = Object.values(workflow.jobs).flatMap((job) =>
        job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
      );
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    },
  );

  it('sets up the toolchain from a checked-out lockfile without implicit dependency installation', () => {
    const workflow = parse(preview) as {
      jobs: { publish: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> } };
    };
    const setup = workflow.jobs.publish.steps.find((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
    expect(setup?.with).toMatchObject({ 'working-directory': 'tooling', 'run-install': false });
  });

  it.each(['mobile-ota-preview.yml', 'mobile-ota-preview-prompt.yml'])(
    '%s recognizes every boot-check trigger path',
    (filename) => {
      const workflow = readFileSync(resolve(WORKFLOW_DIR, filename), 'utf8');
      const boot = parse(readFileSync(resolve(WORKFLOW_DIR, 'mobile-ota-boot-check.yml'), 'utf8')) as {
        on: { pull_request: { paths: string[] } };
      };
      const declaration = /const affectsMobilePreview = \(path\) =>[\s\S]*?;\n/.exec(workflow);
      if (!declaration) throw new Error(`${filename} has no preview predicate`);
      // Execute the actual workflow classifier so a source-only PR cannot wait
      // for boot proof while the publication workflow silently skips its path.
      // oxlint-disable-next-line no-implied-eval
      const affectsPreview = new Function('path', `${declaration[0]} return affectsMobilePreview(path);`) as (
        path: string,
      ) => boolean;
      for (const path of boot.on.pull_request.paths) expect(affectsPreview(path), `${filename}: ${path}`).toBe(true);
    },
  );

  it.each(['mobile-ota-preview.yml', 'mobile-ota-preview-prompt.yml', 'pr-test-plan.yml'])(
    '%s treats a probe-only diff as a mobile preview change',
    (filename) => {
      const workflow = readFileSync(resolve(WORKFLOW_DIR, filename), 'utf8');
      const declaration = /const affectsMobilePreview = \(path\) =>[\s\S]*?;\n/.exec(workflow);
      if (!declaration) throw new Error(`${filename} has no preview predicate`);
      // Execute the workflow's own predicate so this cannot pass against a copied test implementation.
      // oxlint-disable-next-line no-implied-eval
      const affectsPreview = new Function('path', `${declaration[0]} return affectsMobilePreview(path);`) as (
        path: string,
      ) => boolean;
      expect(affectsPreview('scripts/lib/ota-branch-probe.ts')).toBe(true);
      expect(affectsPreview('docs/unrelated.md')).toBe(false);
    },
  );
});

// babel-preset-expo inlines every EXPO_PUBLIC_* value into the transformed code,
// and Metro's own cache key never sees those values, so the cache key must carry
// them. The store never goes through actions/cache (writable by any main-scope run,
// restored with `tar -P`), and no other job in the run touches it (they share an
// artifact namespace). It travels only as an artifact from an earlier successful publish
// run, and is HMAC-sealed with a Production secret.
describe('production OTA Metro transform cache', () => {
  type WorkflowStep = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | boolean>;
    'working-directory'?: string;
    'continue-on-error'?: boolean;
  };
  type WorkflowJob = {
    environment?: string;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    if?: string;
    steps?: WorkflowStep[];
  };
  const parsedProduction = parse(production) as {
    env: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };
  const publishSteps = parsedProduction.jobs.publish.steps ?? [];
  const stepIn = (steps: WorkflowStep[], name: string): WorkflowStep => {
    const step = steps.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`no step named ${name}`);
    return step;
  };
  const stepNamed = (name: string) => stepIn(publishSteps, name);
  const KEY_STEP = 'Key the Metro transform cache on the inlined build env';
  const ENV_STEP = 'Write .env for Expo build-time inlining';
  const keyStep = stepNamed(KEY_STEP);
  const sealKeyStep = stepNamed('Check for the Metro cache seal key');
  const findStep = stepNamed('Find the newest trusted Metro store');
  const downloadStep = stepNamed('Download the Metro store');
  const unpackStep = stepNamed('Unpack the Metro cache artifact');
  const verifyStep = stepNamed('Verify the Metro cache seal');
  const sealStep = stepNamed("Seal Metro's OTA transform cache");
  const packStep = stepNamed('Pack the sealed Metro store');
  const uploadStep = stepNamed('Upload the sealed Metro store');
  const sealScript = resolve(REPO_ROOT, 'scripts', 'ci', 'metro-cache-seal.sh');
  const SEAL_ENV = { METRO_CACHE_HMAC_KEY: 'production-secret', METRO_CACHE_PREFIX: 'metro-ota-Linux-a-b-' };
  const WORKFLOW_ENV = {
    EXPO_PUBLIC_BACKEND_URL: 'https://ws.boardsesh.com',
    EXPO_PUBLIC_SENTRY_DSN: 'dsn-a',
    EXPO_PUBLIC_POSTHOG_KEY: 'phc_test',
  };

  function withWorkspace<T>(body: (workspace: string) => T): T {
    const workspace = mkdtempSync(join(tmpdir(), 'metro-ota-cache-'));
    try {
      return body(workspace);
    } finally {
      spawnSync('chmod', ['-R', 'u+rwX', workspace]);
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  function runBash(script: string, cwd: string, env: Record<string, string>) {
    return spawnSync('bash', ['-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env },
    });
  }

  function readOutputs(outputPath: string): Record<string, string> {
    let text = '';
    try {
      text = readFileSync(outputPath, 'utf8');
    } catch {
      return {};
    }
    return Object.fromEntries(
      text
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  }

  /** Runs the job's own `.env` writer and key step, the way the job would. */
  function keyOutputs(steps: WorkflowStep[], env: Record<string, string>): Record<string, string> {
    return withWorkspace((workspace) => {
      const mobileDir = join(workspace, 'packages', 'mobile');
      mkdirSync(mobileDir, { recursive: true });
      const runnerEnv = {
        RUNNER_OS: 'Linux',
        RUNNER_TEMP: join(workspace, 'runner-temp'),
        GITHUB_STEP_SUMMARY: join(workspace, 'summary'),
        METRO_INPUTS_HASH: 'inputs',
        ...env,
      };
      const written = runBash(stepIn(steps, ENV_STEP).run ?? '', mobileDir, runnerEnv);
      expect(written.status, written.stderr).toBe(0);
      const outputPath = join(workspace, 'github-output');
      const keyed = runBash(stepIn(steps, KEY_STEP).run ?? '', workspace, { ...runnerEnv, GITHUB_OUTPUT: outputPath });
      expect(keyed.status, keyed.stderr).toBe(0);
      return readOutputs(outputPath);
    });
  }

  function prefixFrom(steps: WorkflowStep[], env: Record<string, string>): string {
    const prefix = keyOutputs(steps, env).prefix;
    if (!prefix) throw new Error('key step wrote no prefix output');
    return prefix;
  }

  // A store shaped like Metro's binary FileStore: two-hex-digit shards of `<hex>.mp`.
  function writeStore(store: string): void {
    mkdirSync(join(store, 'ab'), { recursive: true });
    mkdirSync(join(store, 'cd'), { recursive: true });
    writeFileSync(join(store, 'ab', 'cdef01.mp'), 'transformed module one');
    writeFileSync(join(store, 'cd', '234567.mp'), 'transformed module two');
  }

  function seal(store: string, env: Record<string, string> = SEAL_ENV) {
    return spawnSync('bash', [sealScript, 'seal', store], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env },
    });
  }

  const storeIn = (workspace: string) => join(workspace, 'runner-temp', 'metro-ota', 'metro-cache');

  // Runs the workflow's own verify step, so its store_ready verdict is tested too.
  function runVerifyStep(workspace: string, env: Record<string, string> = SEAL_ENV) {
    const outputPath = join(workspace, 'verify-output');
    const result = runBash(verifyStep.run ?? '', REPO_ROOT, {
      RUNNER_TEMP: join(workspace, 'runner-temp'),
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: join(workspace, 'summary'),
      ...env,
    });
    expect(result.status, result.stderr).toBe(0);
    return { result, outputs: readOutputs(outputPath) };
  }

  type TarMember = { name: string; kind: 'file' | 'dir' | 'symlink' | 'hardlink'; target?: string };

  /** Writes the artifact a (possibly hostile) fetch job would hand over. */
  function writeArtifact(workspace: string, members: TarMember[]): void {
    const archive = join(workspace, 'runner-temp', 'metro-ota-download', 'metro-cache.tar');
    mkdirSync(dirname(archive), { recursive: true });
    const built = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        `
import io, json, sys, tarfile
kinds = {"file": tarfile.REGTYPE, "dir": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE}
with tarfile.open(sys.argv[1], "w", format=tarfile.GNU_FORMAT) as archive:
    for member in json.loads(sys.argv[2]):
        info = tarfile.TarInfo(member["name"])
        info.type = kinds[member["kind"]]
        info.linkname = member.get("target", "")
        data = b"payload" if member["kind"] == "file" else b""
        info.size = len(data)
        info.mode = 0o755 if member["kind"] == "dir" else 0o644
        archive.addfile(info, io.BytesIO(data) if data else None)
`,
        archive,
        JSON.stringify(members),
      ],
      { encoding: 'utf8' },
    );
    expect(built.status, built.stderr).toBe(0);
  }

  function runUnpackStep(workspace: string, env: Record<string, string> = {}) {
    const result = runBash(unpackStep.run ?? '', workspace, {
      RUNNER_TEMP: join(workspace, 'runner-temp'),
      GITHUB_STEP_SUMMARY: join(workspace, 'summary'),
      ...env,
    });
    expect(result.status, result.stderr).toBe(0);
    return result;
  }

  const entriesIn = (store: string): string[] =>
    spawnSync('find', [store, '-mindepth', '1'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const hasSeal = (store: string) => entriesIn(store).some((entry) => entry.endsWith('.metro-ota-seal'));
  const GENUINE_MEMBERS: TarMember[] = [
    { name: 'metro-cache/', kind: 'dir' },
    { name: 'metro-cache/ab/', kind: 'dir' },
    { name: 'metro-cache/ab/cdef01.mp', kind: 'file' },
    { name: 'metro-cache/.metro-ota-seal', kind: 'file' },
  ];

  it('keys the store on every inlined EXPO_PUBLIC_* value, and nothing unrelated', () => {
    const prefix = prefixFrom(publishSteps, WORKFLOW_ENV);
    expect(prefix).toMatch(/^metro-ota-Linux-inputs-[0-9a-f]{64}-$/);
    expect(prefixFrom(publishSteps, { ...WORKFLOW_ENV, EXPO_PUBLIC_BACKEND_URL: 'https://staging.example' })).not.toBe(
      prefix,
    );
    expect(prefixFrom(publishSteps, { ...WORKFLOW_ENV, EXPO_PUBLIC_SENTRY_DSN: 'dsn-b' })).not.toBe(prefix);
    expect(prefixFrom(publishSteps, { ...WORKFLOW_ENV, EXPO_PUBLIC_NEW_FLAG: '1' })).not.toBe(prefix);
    expect(prefixFrom(publishSteps, { ...WORKFLOW_ENV, UNRELATED_TOKEN: 'secret' })).toBe(prefix);
    expect(prefixFrom(publishSteps, { ...WORKFLOW_ENV, METRO_INPUTS_HASH: 'bumped-lockfile' })).not.toBe(prefix);
  });

  it('names the store artifact after the whole key', () => {
    const outputs = keyOutputs(publishSteps, WORKFLOW_ENV);
    expect(outputs.store_artifact).toMatch(/^metro-ota-store-[0-9a-f]{40}$/);
    const otherEnv = keyOutputs(publishSteps, { ...WORKFLOW_ENV, EXPO_PUBLIC_BACKEND_URL: 'https://staging.example' });
    expect(otherEnv.store_artifact).not.toBe(outputs.store_artifact);
    // The publish job may not add an EXPO_PUBLIC_* of its own on top of the shared env.
    expect(
      Object.keys(parsedProduction.jobs.publish.env ?? {}).filter((key) => key.startsWith('EXPO_PUBLIC_')),
    ).toEqual([]);
  });

  it('hashes the same Metro inputs as ci.yml, and never uses actions/cache', () => {
    for (const input of [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'packages/mobile/metro.config.js',
      'packages/mobile/babel.config.js',
      'packages/mobile/app.config.ts',
      'patches/**',
    ]) {
      expect(keyStep.env?.METRO_INPUTS_HASH).toContain(`'${input}'`);
    }
    expect(keyStep.run).toContain('prefix="metro-ota-');
    // actions/cache is writable by any main-scope run and restores with `tar -P`.
    for (const [jobName, job] of Object.entries(parsedProduction.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '', `${jobName}: ${step.name}`).not.toMatch(/^actions\/cache/);
      }
    }
  });

  it('moves the store only between publish jobs of trusted runs', () => {
    // Jobs in one run share an artifact namespace, so no other job may touch the store.
    expect(Object.keys(parsedProduction.jobs)).not.toContain('metro-cache-fetch');
    for (const [jobName, job] of Object.entries(parsedProduction.jobs)) {
      if (jobName === 'publish') continue;
      expect(JSON.stringify(job), jobName).not.toMatch(/metro/i);
    }
    expect(findStep.run).toBe('vp exec tsx scripts/ci/metro-cache-select.ts');
    expect(findStep.if).toBe(
      "steps.gate.outputs.configured == 'true' && steps.metro_seal_key.outputs.sealing == 'true'",
    );
    expect(findStep.env?.METRO_STORE_ARTIFACT).toBe('${{ steps.metro_cache.outputs.store_artifact }}');
    expect(downloadStep.uses).toBe('actions/download-artifact@v4');
    expect(downloadStep.if).toBe(
      "steps.gate.outputs.configured == 'true' && steps.metro_find.outputs.run_id != '' && steps.metro_find.outputs.artifact_id != ''",
    );
    // By the vetted id, never by name: a same-named re-upload can't take its place.
    expect(downloadStep.with).toEqual({
      'artifact-ids': '${{ steps.metro_find.outputs.artifact_id }}',
      'run-id': '${{ steps.metro_find.outputs.run_id }}',
      'github-token': '${{ github.token }}',
      'merge-multiple': true,
      path: '${{ runner.temp }}/metro-ota-download',
    });
    expect(uploadStep.uses).toBe('actions/upload-artifact@v4');
    expect(uploadStep.with?.name).toBe('${{ steps.metro_cache.outputs.store_artifact }}');
    expect(uploadStep.with?.['retention-days']).toBe(7);
    expect(packStep.run).not.toMatch(/\s-P\b|--absolute-names/);
    expect(packStep.run).toContain('size_bytes=');
  });

  it('unpacks a genuine artifact into the store', () => {
    withWorkspace((workspace) => {
      writeArtifact(workspace, GENUINE_MEMBERS);
      runUnpackStep(workspace);
      const store = storeIn(workspace);
      expect(readFileSync(join(store, 'ab', 'cdef01.mp'), 'utf8')).toBe('payload');
      expect(hasSeal(store)).toBe(true);
    });
  });

  it.each<[string, TarMember[]]>([
    ['a ../ member', [...GENUINE_MEMBERS, { name: '../escaped', kind: 'file' }]],
    ['a nested ../ member', [...GENUINE_MEMBERS, { name: 'metro-cache/ab/../../escaped', kind: 'file' }]],
    ['an absolute member', [...GENUINE_MEMBERS, { name: '/tmp/metro-ota-absolute-escape', kind: 'file' }]],
    ['a member outside metro-cache/', [...GENUINE_MEMBERS, { name: 'escaped', kind: 'file' }]],
    ['a symlink member', [...GENUINE_MEMBERS, { name: 'metro-cache/ab/00.mp', kind: 'symlink', target: '/etc' }]],
    [
      'a hardlink member',
      [...GENUINE_MEMBERS, { name: 'metro-cache/ab/11.mp', kind: 'hardlink', target: 'metro-cache/ab/cdef01.mp' }],
    ],
    ['a member deeper than a shard', [...GENUINE_MEMBERS, { name: 'metro-cache/ab/cd/ef.mp', kind: 'file' }]],
  ])('refuses an artifact with %s and writes nothing', (_label, members) => {
    withWorkspace((workspace) => {
      writeArtifact(workspace, members);
      const { stdout } = runUnpackStep(workspace);
      expect(stdout).toContain('::warning::Metro cache artifact refused');
      expect(entriesIn(storeIn(workspace))).toEqual([]);
      expect(entriesIn(join(workspace, 'runner-temp', 'metro-ota'))).toEqual([storeIn(workspace)]);
      expect(entriesIn(workspace).some((entry) => entry.endsWith('escaped'))).toBe(false);
    });
    expect(() => readFileSync('/tmp/metro-ota-absolute-escape')).toThrow();
  });

  it('refuses a tar over the budget before listing it', () => {
    withWorkspace((workspace) => {
      writeArtifact(workspace, GENUINE_MEMBERS);
      const { stdout } = runUnpackStep(workspace, { METRO_CACHE_MAX_BYTES: '4096' });
      expect(stdout).toContain('its tar is');
      expect(entriesIn(storeIn(workspace))).toEqual([]);
    });
  });

  // The compressed size the selector checks says nothing about what a tar
  // unpacks to: a sparse member is a few bytes in the tar and any size on disk.
  it('refuses a tar whose members add up to more than the budget', () => {
    withWorkspace((workspace) => {
      const source = join(workspace, 'source');
      mkdirSync(join(source, 'metro-cache', 'ab'), { recursive: true });
      expect(spawnSync('truncate', ['-s', '64M', join(source, 'metro-cache', 'ab', '0123.mp')]).status).toBe(0);
      const archive = join(workspace, 'runner-temp', 'metro-ota-download', 'metro-cache.tar');
      mkdirSync(dirname(archive), { recursive: true });
      const packed = spawnSync('tar', ['--sparse', '--format=gnu', '-cf', archive, '-C', source, 'metro-cache'], {
        encoding: 'utf8',
      });
      expect(packed.status, packed.stderr).toBe(0);
      expect(statSync(archive).size).toBeLessThan(1024 * 1024);
      const { stdout } = runUnpackStep(workspace, { METRO_CACHE_MAX_BYTES: String(1024 * 1024) });
      expect(stdout).toContain('it unpacks to 67108864 bytes');
      expect(entriesIn(storeIn(workspace))).toEqual([]);
    });
  });

  it('builds cold when there is no artifact, or it is not a tar archive', () => {
    withWorkspace((workspace) => {
      expect(runUnpackStep(workspace).stdout).toContain('No Metro cache artifact');
      expect(entriesIn(storeIn(workspace))).toEqual([]);
      const archive = join(workspace, 'runner-temp', 'metro-ota-download', 'metro-cache.tar');
      mkdirSync(dirname(archive), { recursive: true });
      writeFileSync(archive, 'not a tar archive');
      expect(runUnpackStep(workspace).stdout).toContain('::warning::Metro cache artifact refused');
      expect(entriesIn(storeIn(workspace))).toEqual([]);
    });
  });

  it('accepts a store sealed with the key and prefix it is checked against', () => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      const sealed = seal(store);
      expect(sealed.status, sealed.stdout + sealed.stderr).toBe(0);
      const { outputs } = runVerifyStep(workspace);
      expect(outputs.store_ready).toBe('true');
      expect(readFileSync(join(store, 'ab', 'cdef01.mp'), 'utf8')).toBe('transformed module one');
      // The seal is consumed, so the next seal hashes only Metro's own files.
      expect(hasSeal(store)).toBe(false);
    });
  });

  it('makes a genuine read-only shard writable so Metro can add entries to it', () => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      chmodSync(join(store, 'cd'), 0o555);
      expect(seal(store).status).toBe(0);
      expect(runVerifyStep(workspace).outputs.store_ready).toBe('true');
      expect(statSync(join(store, 'cd')).mode & 0o200).toBe(0o200);
    });
  });

  it('drops Metro temp files left by an unfinished write before sealing', () => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      writeFileSync(join(store, 'ab', '.tmp4242_cdef02.mp'), 'half written');
      expect(seal(store).status).toBe(0);
      expect(entriesIn(store).some((entry) => entry.includes('.tmp4242_'))).toBe(false);
      expect(runVerifyStep(workspace).outputs.store_ready).toBe('true');
    });
  });

  it.each([
    ['a modified file', (store: string) => writeFileSync(join(store, 'ab', 'cdef01.mp'), 'attacker module')],
    ['an added file', (store: string) => writeFileSync(join(store, 'cd', 'ffffff.mp'), 'attacker module')],
    ['a removed file', (store: string) => rmSync(join(store, 'cd', '234567.mp'))],
    ['a missing seal', (store: string) => rmSync(join(store, '.metro-ota-seal'))],
    ['a malformed seal', (store: string) => writeFileSync(join(store, '.metro-ota-seal'), 'metro-ota-seal-v1 nope\n')],
    ['a symlink', (store: string) => symlinkSync('/etc/hostname', join(store, 'ab', 'linked.mp'))],
    ['a file outside the shard layout', (store: string) => writeFileSync(join(store, 'ab', 'notes.txt'), 'x')],
    [
      'a directory deeper than a shard',
      (store: string) => {
        mkdirSync(join(store, 'ab', 'cd'));
        writeFileSync(join(store, 'ab', 'cd', 'ef.mp'), 'attacker module');
      },
    ],
    [
      'a read-only planted shard',
      (store: string) => {
        mkdirSync(join(store, 'ef'));
        writeFileSync(join(store, 'ef', '00.mp'), 'attacker module');
        chmodSync(join(store, 'ef'), 0o555);
      },
    ],
  ])('empties the store on %s and still lets the export run', (_label, tamper) => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      expect(seal(store).status).toBe(0);
      tamper(store);
      const { result, outputs } = runVerifyStep(workspace);
      expect(result.stdout).toContain('::warning::Metro cache rejected');
      expect(entriesIn(store)).toEqual([]);
      expect(outputs.store_ready).toBe('true');
    });
  });

  it.each([
    ['a wrong key', { ...SEAL_ENV, METRO_CACHE_HMAC_KEY: 'attacker-guess' }],
    // A genuine store sealed under old EXPO_PUBLIC_* values, replanted under the current prefix.
    ['a different cache prefix', { ...SEAL_ENV, METRO_CACHE_PREFIX: 'metro-ota-Linux-a-old-env-' }],
  ])('empties the store when it was sealed with %s', (_label, sealEnv) => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      expect(seal(store, sealEnv).status).toBe(0);
      runVerifyStep(workspace);
      expect(entriesIn(store)).toEqual([]);
    });
  });

  it('starts fresh past the size budget, and refuses to save past it', () => {
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      expect(seal(store).status).toBe(0);
      runVerifyStep(workspace, { ...SEAL_ENV, METRO_CACHE_MAX_BYTES: '10' });
      expect(entriesIn(store)).toEqual([]);
      writeStore(store);
      expect(seal(store, { ...SEAL_ENV, METRO_CACHE_MAX_BYTES: '10' }).status).not.toBe(0);
      expect(hasSeal(store)).toBe(false);
    });
  });

  it('without the key: nothing is downloaded, a store is never used, and nothing is saved', () => {
    const sealingFor = (hasKey: string) =>
      withWorkspace((workspace) => {
        const outputPath = join(workspace, 'output');
        const result = runBash(sealKeyStep.run ?? '', workspace, {
          HAS_HMAC_KEY: hasKey,
          OWN_PREFIX: 'p',
          FETCH_PREFIX: 'p',
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: join(workspace, 'summary'),
        });
        expect(result.status, result.stderr).toBe(0);
        return readOutputs(outputPath).sealing;
      });
    expect(sealingFor('false')).toBe('false');
    expect(sealingFor('true')).toBe('true');
    expect(findStep.if).toContain("steps.metro_seal_key.outputs.sealing == 'true'");
    expect(sealStep.if).toContain("steps.metro_seal_key.outputs.sealing == 'true'");
    const noKey = { METRO_CACHE_PREFIX: SEAL_ENV.METRO_CACHE_PREFIX };
    withWorkspace((workspace) => {
      const store = storeIn(workspace);
      writeStore(store);
      expect(seal(store).status).toBe(0);
      runVerifyStep(workspace, noKey);
      expect(entriesIn(store)).toEqual([]);
      writeStore(store);
      expect(seal(store, noKey).status).not.toBe(0);
      expect(hasSeal(store)).toBe(false);
    });
  });

  it('publishes only a sealed store, from main and release/next, after a platform published', () => {
    expect(packStep.if).toContain("steps.metro_seal.outcome == 'success'");
    expect(uploadStep.if).toContain("steps.metro_pack.outcome == 'success'");
    expect(sealStep.run).toContain('scripts/ci/metro-cache-seal.sh seal');
    expect(sealStep.if).toContain("(github.ref == 'refs/heads/main' || github.ref == 'refs/heads/release/next')");
    expect(sealStep.if).toContain(
      "(steps.publish_ios.outcome == 'success' || steps.publish_android.outcome == 'success')",
    );
    expect(sealStep.if).toContain("steps.metro_verify.outputs.store_ready == 'true'");
    expect(sealStep.if).toContain('!cancelled()');
  });

  it('keeps METRO_CACHE_HMAC_KEY inside the Production-environment publish job', () => {
    const secretReference = /secrets\.METRO_CACHE_HMAC_KEY/;
    expect(parsedProduction.jobs.publish.environment).toBe('Production');
    for (const [jobName, job] of Object.entries(parsedProduction.jobs)) {
      if (jobName === 'publish') continue;
      expect(JSON.stringify(job), jobName).not.toMatch(secretReference);
    }
    expect(JSON.stringify(parsedProduction.env)).not.toMatch(secretReference);
    const holders = publishSteps
      .filter((step) => secretReference.test(JSON.stringify(step)))
      .map((step) => step.name ?? '');
    expect(holders).toEqual([sealKeyStep.name, verifyStep.name, sealStep.name]);
    // The seal-key check only learns whether the key exists.
    expect(sealKeyStep.env?.HAS_HMAC_KEY).toBe("${{ secrets.METRO_CACHE_HMAC_KEY != '' }}");
    for (const filename of readdirSync(WORKFLOW_DIR)) {
      if (filename === 'mobile-ota-production.yml') continue;
      expect(readFileSync(resolve(WORKFLOW_DIR, filename), 'utf8'), filename).not.toContain('METRO_CACHE_HMAC_KEY');
    }
  });
  it('lets an export read the store only when the seal check said so', () => {
    for (const name of ['Publish iOS OTA', 'Publish Android OTA']) {
      const env = stepNamed(name).env ?? {};
      expect(env.TMPDIR, name).toBe(
        "${{ steps.metro_verify.outputs.store_ready == 'true' && format('{0}/metro-ota', runner.temp) || runner.temp }}",
      );
      // The key step reads EXPO_PUBLIC_* from the shared env; one set only on a
      // publish step would be inlined without ever reaching the key.
      expect(
        Object.keys(env).filter((key) => key.startsWith('EXPO_PUBLIC_')),
        name,
      ).toEqual([]);
    }
    expect(parsedProduction.env.TMPDIR).toBeUndefined();
    // The unpack and verify steps run whenever an export does, whatever came before.
    expect(unpackStep.if).toBe("steps.gate.outputs.configured == 'true' && steps.sentry_uploader.outcome == 'success'");
    expect(verifyStep.if).toBe("steps.gate.outputs.configured == 'true' && steps.sentry_uploader.outcome == 'success'");
    // A cache problem must never block a publish.
    for (const step of [
      keyStep,
      sealKeyStep,
      findStep,
      downloadStep,
      unpackStep,
      verifyStep,
      sealStep,
      packStep,
      uploadStep,
    ]) {
      expect(step['continue-on-error'], step.name).toBe(true);
    }
  });

  it('unpacks and verifies before the first export and seals after the last', () => {
    const position = (name: string) => publishSteps.findIndex((step) => step.name === name);
    const order = [
      'Validate Sentry uploader support before publishing',
      KEY_STEP,
      'Check for the Metro cache seal key',
      'Find the newest trusted Metro store',
      'Download the Metro store',
      'Unpack the Metro cache artifact',
      'Verify the Metro cache seal',
      'Publish iOS OTA',
      'Publish Android OTA',
      "Seal Metro's OTA transform cache",
      'Pack the sealed Metro store',
      'Upload the sealed Metro store',
    ].map(position);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
