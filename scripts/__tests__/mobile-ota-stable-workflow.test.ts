import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { desiredOtaState, STABLE_CANDIDATE_BRANCH } from '../../infra/ota/config';
import { STABLE_CONTROLLER_JOBS } from '../lib/ota-stable-github';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  needs?: string | string[];
  uses?: string;
  if?: string;
  steps?: Step[];
  environment?: string;
  concurrency?: Record<string, unknown>;
  with?: Record<string, string>;
}
interface Workflow {
  on: {
    schedule: { cron: string }[];
    workflow_dispatch: { inputs: Record<string, { type: string; options?: string[]; required?: boolean }> };
  };
  jobs: Record<string, Job>;
  concurrency: Record<string, unknown>;
  'run-name': string;
  permissions: Record<string, string>;
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

function executeStep(script: string, environment: Record<string, string>) {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'ota-stable-workflow-'));
  const outputPath = join(scratchDirectory, 'output');
  const argumentsPath = join(scratchDirectory, 'arguments');
  writeFileSync(outputPath, '');
  writeFileSync(argumentsPath, '');
  try {
    const execution = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(scratchDirectory, 'summary'),
        CAPTURE_ARGS: argumentsPath,
        RUNNER_TEMP: scratchDirectory,
        ...environment,
      },
    });
    if (execution.error) throw execution.error;
    return {
      status: execution.status,
      output: readFileSync(outputPath, 'utf8'),
      arguments: readFileSync(argumentsPath, 'utf8').trim().split('\n'),
      error: execution.stderr,
      logs: execution.stdout,
    };
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function resolveCommand(command: string, enabled: string, candidateSha = '', schedule = '') {
  return executeStep(step('resolve', 'Resolve command').run ?? '', {
    INPUT_COMMAND: command,
    ENABLED: enabled,
    CANDIDATE_SHA: candidateSha,
    SCHEDULE: schedule,
  });
}

describe('daily stable workflow boundaries', () => {
  it('keeps trusted checkpoint job identities aligned with the actual workflow', () => {
    expect([...STABLE_CONTROLLER_JOBS].sort()).toEqual(Object.keys(workflow.jobs).sort());
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      // GitHub uses the job ID when no display name is configured.
      expect((job as Job & { name?: string }).name ?? jobName).toBe(jobName);
    }
  });
  it('declares frozen protected candidate without altering the production channel', () => {
    expect(desiredOtaState.branches.find((branch) => branch.name === STABLE_CANDIDATE_BRANCH)?.protected).toBe(true);
    expect(desiredOtaState.channels.find((channel) => channel.name === 'production')?.branch).toBe('production');
  });
  it('prepares once daily and checks at the release-cycle boundary and hourly', () => {
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
  it('limits extra permissions to reusable boot reads and qualification dispatch', () => {
    const bootWorkflow = parse(
      readFileSync(resolve(import.meta.dirname, '../../.github/workflows/mobile-ota-boot-check.yml'), 'utf8'),
    ) as Workflow;
    const callerPermissions = workflow.jobs.boot.permissions;
    expect(callerPermissions).toEqual({
      contents: 'read',
      actions: 'read',
      deployments: 'read',
      'pull-requests': 'read',
    });
    // GitHub validates nested jobs even when a read-only plan skips the call.
    // Check the actual callee's requirements instead of a copied resolver list.
    for (const nestedJob of Object.values(bootWorkflow.jobs)) {
      for (const [scope, permission] of Object.entries(nestedJob.permissions ?? bootWorkflow.permissions)) {
        expect(permission, scope).toBe('read');
        expect(callerPermissions?.[scope], `boot caller must allow ${scope}`).toBe(permission);
      }
    }
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    for (const controller of ['prepare', 'tick']) {
      expect(workflow.jobs[controller].permissions).toBeUndefined();
    }
    expect(workflow.jobs.qualify.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(workflow.jobs.smokes.permissions).toBeUndefined();
  });
  it('qualification records both actual output SHAs and strict job outcomes', () => {
    const verdict = step('qualify', 'Record blocking QA verdict');
    expect(verdict.env?.SMOKE_SHA).toContain('needs.smokes.outputs.sha');
    expect(verdict.env?.BOOT_SHA).toContain('needs.boot.outputs.sha');
    expect(verdict.env?.SMOKE_RESULT).toBe('${{ needs.smokes.result }}');
    expect(verdict.env?.BOOT_RESULT).toBe('${{ needs.boot.result }}');
    expect(verdict.run).toContain('--smoke-passed "$SMOKE_PASSED" --boot-passed "$BOOT_PASSED"');
  });
  it('dispatches enabled automatic progression only after successful QA and durable final state', () => {
    const qualificationSteps = workflow.jobs.qualify.steps ?? [];
    const verdict = step('qualify', 'Record blocking QA verdict');
    const checkpoint = step('qualify', 'Retain final checkpoint even when QA fails');
    const dispatch = step('qualify', 'Check qualified candidate without waiting for cron');
    expect(qualificationSteps.indexOf(verdict)).toBeLessThan(qualificationSteps.indexOf(checkpoint));
    expect(qualificationSteps.indexOf(checkpoint)).toBeLessThan(qualificationSteps.indexOf(dispatch));
    expect(dispatch.if).toBe(
      "success() && steps.verdict.outcome == 'success' && steps.checkpoint.outcome == 'success' && vars.OTA_STABLE_RELEASE_ENABLED == 'true'",
    );
    expect(verdict.id).toBe('verdict');
    expect(checkpoint.id).toBe('checkpoint');
    expect(checkpoint.with?.name).toBe('mobile-ota-stable-state');
    expect(checkpoint.with?.['if-no-files-found']).toBe('error');
    expect(dispatch.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(dispatch.run).toContain(
      'gh workflow run mobile-ota-stable-release.yml --repo "$GITHUB_REPOSITORY" --ref main -f command=tick',
    );
    expect(dispatch['continue-on-error']).toBe(true);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });
  it('keeps qualified archive provenance successful when immediate dispatch fails', () => {
    const dispatch = step('qualify', 'Check qualified candidate without waiting for cron');
    const execution = executeStep(`gh() { return 1; }\n${dispatch.run ?? ''}`, {
      GITHUB_REPOSITORY: 'boardsesh/boardsesh',
    });
    expect(execution.status).toBe(0);
    expect(execution.logs).toContain('::warning::Qualified candidate retained');
    expect(execution.logs).toContain('next scheduled controller check');
  });
  it('offers explicit start and SHA-pinned force-release commands', () => {
    expect(workflow.on.workflow_dispatch.inputs.command.options).toEqual([
      'plan',
      'prepare',
      'tick',
      'start',
      'force-release',
      'abort',
    ]);
    expect(workflow.on.workflow_dispatch.inputs.candidate_sha).toMatchObject({ type: 'string', required: false });
    expect(workflow['run-name']).toContain("inputs.command == 'start' && 'start'");
    expect(workflow['run-name']).toContain("inputs.command == 'force-release' && 'force-release'");
    const candidateSha = 'a'.repeat(40);
    for (const enabled of ['true', 'false']) {
      expect(resolveCommand('start', enabled).output).toBe('command=start\n');
      expect(resolveCommand('start', enabled, candidateSha).output).toBe('command=start\n');
      expect(resolveCommand('force-release', enabled, candidateSha).output).toBe('command=force-release\n');
    }
    for (const invalidSha of ['', 'a'.repeat(39), 'A'.repeat(40), `${candidateSha}; echo injected`]) {
      const resolution = resolveCommand('force-release', 'true', invalidSha);
      expect(resolution.status).not.toBe(0);
      expect(resolution.output).toBe('');
    }
    expect(resolveCommand('start', 'true', 'short-sha').status).not.toBe(0);
    expect(resolveCommand('tick', 'true', candidateSha).status).not.toBe(0);
    expect(resolveCommand('unknown', 'true').status).not.toBe(0);
  });
  it('preserves automatic activation control without disabling explicit manual operations', () => {
    expect(resolveCommand('tick', 'false').output).toBe('command=plan\n');
    expect(resolveCommand('tick', 'true').output).toBe('command=tick\n');
    expect(resolveCommand('', 'true', '', '17 19 * * *').output).toBe('command=prepare\n');
    expect(resolveCommand('', 'true', '', '0 22 * * *').output).toBe('command=tick\n');
    expect(resolveCommand('', 'false', '', '37 * * * *').output).toBe('command=plan\n');
    expect(resolveCommand('prepare', 'false').output).toBe('command=prepare\n');
    expect(resolveCommand('abort', 'false').output).toBe('command=abort\n');
  });
  it('passes manual commands and optional pins as discrete CLI arguments', () => {
    const controller = step('tick', 'Judge and apply at most one timed step');
    expect(controller.env?.CANDIDATE_SHA).toBe('${{ inputs.candidate_sha }}');
    expect(controller.id).toBe('controller');
    const candidateSha = 'b'.repeat(40);
    for (const [command, pinned] of [
      ['plan', false],
      ['tick', false],
      ['start', false],
      ['start', true],
      ['force-release', true],
      ['abort', false],
    ] as const) {
      const execution = executeStep(`node() { printf '%s\\n' "$@" > "$CAPTURE_ARGS"; }\n${controller.run ?? ''}`, {
        COMMAND: command,
        CANDIDATE_SHA: pinned ? candidateSha : '',
        LOADED_RUN: '123',
      });
      expect(execution.status, execution.error).toBe(0);
      expect(execution.arguments.slice(0, 3)).toEqual([
        '--experimental-strip-types',
        'scripts/mobile-ota-stable.ts',
        command === 'plan' ? 'tick' : command,
      ]);
      expect(execution.arguments.includes('--apply')).toBe(command !== 'plan');
      expect(execution.arguments.includes('--expected-sha')).toBe(pinned);
      if (pinned) expect(execution.arguments.slice(4, 6)).toEqual(['--expected-sha', candidateSha]);
    }
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

describe('critical production release credentials', () => {
  const pipeline = parse(
    readFileSync(resolve(import.meta.dirname, '../../.github/workflows/production-deploy.yml'), 'utf8'),
  ) as Workflow;
  const promotion = pipeline.jobs['promote-mobile-ota'];
  const steps = promotion.steps ?? [];
  const preflight = steps.find((entry) => entry.name === 'Require critical release credentials before readiness waits');
  const credentials = {
    OTA_ADMIN_EMAIL: 'credential-test@example.invalid',
    OTA_ADMIN_PASSWORD: 'credential-test-password',
    EOO_TOKEN: 'credential-test-token',
  };

  it('checks all required secrets before acquiring external readiness evidence', () => {
    expect(preflight?.if).toBe("needs.detect-changes.outputs.critical_ota == 'true'");
    expect(preflight?.env).toEqual({
      OTA_ADMIN_EMAIL: '${{ secrets.OTA_ADMIN_EMAIL }}',
      OTA_ADMIN_PASSWORD: '${{ secrets.OTA_ADMIN_PASSWORD }}',
      EOO_TOKEN: '${{ secrets.EOO_TOKEN }}',
    });
    const preflightIndex = steps.indexOf(preflight!);
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    for (const name of [
      'Require live backend schema',
      'Wait for the OTA server rollout on this commit',
      'Restore trusted controller state before critical supersession',
      'Release critical staged bytes to 100% stable',
    ]) {
      expect(
        steps.findIndex((entry) => entry.name === name),
        name,
      ).toBeGreaterThan(preflightIndex);
    }
  });

  it.each(Object.keys(credentials))('fails promptly for a missing %s without exposing secrets', (missingCredential) => {
    expect(preflight?.run).toBeDefined();
    const execution = executeStep(preflight!.run!, { ...credentials, [missingCredential]: '' });
    expect(execution.status).toBe(1);
    expect(execution.logs).toContain(`::error::Missing ${missingCredential}`);
    for (const secret of Object.values(credentials)) expect(execution.logs + execution.error).not.toContain(secret);
  });

  it('passes when every release credential is available', () => {
    expect(preflight?.run).toBeDefined();
    const execution = executeStep(preflight!.run!, credentials);
    expect(execution.status).toBe(0);
    expect(execution.logs + execution.error).toBe('');
  });
});
