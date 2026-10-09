import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { desiredOtaState, STABLE_CANDIDATE_BRANCH } from '../../infra/ota/config';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  uses?: string;
  if?: string;
  steps?: Step[];
  environment?: string;
  concurrency?: Record<string, unknown>;
  with?: Record<string, string>;
}
interface Workflow {
  on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
  concurrency: Record<string, unknown>;
  'run-name': string;
}
const source = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/mobile-ota-stable-release.yml'),
  'utf8',
);
const workflow = parse(source) as Workflow;
const step = (job: string, name: string): Step => {
  const found = workflow.jobs[job].steps?.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing ${job} step ${name}`);
  return found;
};
describe('daily stable workflow boundaries', () => {
  it('declares frozen protected candidate without altering the production channel', () => {
    expect(desiredOtaState.branches.find((branch) => branch.name === STABLE_CANDIDATE_BRANCH)?.protected).toBe(true);
    expect(desiredOtaState.channels.find((channel) => channel.name === 'production')?.branch).toBe('production');
  });
  it('prepares once daily, judges hourly, and has the fixed daily finish window', () => {
    expect(workflow.on.schedule.map((schedule) => schedule.cron)).toEqual(['17 19 * * *', '0 22 * * *', '37 * * * *']);
    expect(Object.keys(workflow.on)).not.toContain('pull_request');
    expect(workflow.concurrency).toEqual({
      group: 'mobile-ota-stable-controller',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });
  it('runs trusted main SHA code without dependencies in secret-holding jobs', () => {
    expect(step('resolve', 'Refuse any ref but main').if).toBe("github.ref != 'refs/heads/main'");
    for (const jobName of ['prepare', 'tick']) {
      const job = workflow.jobs[jobName];
      expect(job.environment).toBe('ota-stable-release');
      expect(job.needs).toBe('resolve');
      const checkout = job.steps?.find((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.ref).toBe('${{ github.sha }}');
      const commands = job.steps?.map((entry) => entry.run ?? '').join('\n');
      expect(commands).not.toMatch(/\b(?:vp|npm|pnpm|yarn)\s+(?:install|exec|ci|dlx)\b/);
      for (const entry of job.steps ?? []) if (entry.uses) expect(entry.uses).toMatch(/@[a-f0-9]{40}$/);
    }
  });
  it('QA takes no production lock and receives the same frozen SHA, branch and receipt', () => {
    for (const jobName of ['smokes', 'boot']) expect(workflow.jobs[jobName].concurrency).toBeUndefined();
    expect(workflow.jobs.smokes.with?.ref).toBe('${{ needs.prepare.outputs.sha }}');
    expect(workflow.jobs.boot.with).toEqual({
      ref: '${{ needs.prepare.outputs.sha }}',
      branch: 'pr-stable-candidate',
      receipt_json: '${{ needs.prepare.outputs.receipt }}',
    });
    expect(workflow.jobs.tick.concurrency).toEqual({
      group: 'mobile-ota-production',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });
  it('qualification records both actual output SHAs and strict job outcomes', () => {
    const verdict = step('qualify', 'Record blocking QA verdict');
    expect(verdict.env?.SMOKE_SHA).toContain('needs.smokes.outputs.sha');
    expect(verdict.env?.BOOT_SHA).toContain('needs.boot.outputs.sha');
    expect(verdict.env?.SMOKE_RESULT).toBe('${{ needs.smokes.result }}');
    expect(verdict.env?.BOOT_RESULT).toBe('${{ needs.boot.result }}');
    expect(verdict.run).toContain('--smoke-passed "$SMOKE_PASSED" --boot-passed "$BOOT_PASSED"');
  });
  it('disabled tick is named plan and records no fake write checkpoint', () => {
    expect(workflow['run-name']).toContain("vars.OTA_STABLE_RELEASE_ENABLED == 'true'");
    expect(step('resolve', 'Resolve command').run).toContain('[ "$ENABLED" != true ]; then command=plan');
    const retain = step('tick', 'Retain checkpoint and upload leases');
    expect(retain.if).toContain("needs.resolve.outputs.command != 'plan'");
    expect(retain.with?.path).toBe('controller-state/');
    expect(step('tick', 'Collect durable upload leases').run).toContain(
      'cp ota-stage/rollout-receipt.json controller-state/',
    );
  });
  it('abort works without a candidate ZIP and is an explicit apply while activation is off', () => {
    const restore = step('tick', 'Restore trusted checkpoint and its exact candidate');
    expect(restore.env?.COMMAND).toBe('${{ needs.resolve.outputs.command }}');
    expect(restore.run).toContain('[ "$COMMAND" != abort ]');
    const execute = step('tick', 'Judge and apply at most one timed step');
    expect(execute.run).toContain('[ "$COMMAND" != plan ]; then flags+=(--apply)');
    expect(execute.run).toContain('"$operation"');
  });
  it('restores exact archives throughout unchanged revalidation and keeps expired-ZIP revert recovery independent', () => {
    const restore = step('tick', 'Restore trusted checkpoint and its exact candidate').run ?? '';
    expect(restore).toContain('.active.phase != "reverting"');
    expect(restore).not.toContain('.active.phase == "starting"');
    expect(restore).toContain('cp controller-state/rollout-receipt.json ota-stage/');
  });
  it('retains frozen bytes and state for thirty days, including failed verdicts', () => {
    const artifacts = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((entry) => entry.uses?.startsWith('actions/upload-artifact@'));
    expect(artifacts).toHaveLength(4);
    for (const artifact of artifacts) expect(artifact.with?.['retention-days']).toBe(30);
    expect(step('qualify', 'Retain final checkpoint even when QA fails').if).toBe('always()');
  });
  it('feeds early updates before cutover while guarding legacy production publication', () => {
    const pipeline = parse(
      readFileSync(resolve(import.meta.dirname, '../../.github/workflows/production-deploy.yml'), 'utf8'),
    ) as Workflow;
    expect(pipeline.jobs['promote-mobile-ota'].if).toContain("vars.OTA_STABLE_RELEASE_ENABLED != 'true'");
    const early = pipeline.jobs['promote-early-mobile-ota'];
    expect(early.if).not.toContain('OTA_STABLE_RELEASE_ENABLED');
    expect(early.needs).toEqual(pipeline.jobs['promote-mobile-ota'].needs);
    expect(early.concurrency?.group).toBe('mobile-ota-beta');
    expect(early.steps?.some((entry) => entry.run?.includes('scripts/mobile-ota-promote-track.ts ota-stage'))).toBe(
      true,
    );
    expect(pipeline.jobs['verify-mobile-ota'].needs).toContain('promote-early-mobile-ota');
  });
});
