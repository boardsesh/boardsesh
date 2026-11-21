/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean; queue?: string };
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
};

type Workflow = {
  name: string;
  on: {
    pull_request?: unknown;
    pull_request_target?: { types: string[]; branches?: string[] };
    issue_comment?: { types: string[] };
    workflow_dispatch?: { inputs: Record<string, { type: string; required: boolean; default?: string }> };
    schedule?: Array<{ cron: string }>;
    workflow_run?: { workflows: string[]; types: string[] };
  };
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean; queue?: string };
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflowDirectory = resolve(import.meta.dirname, '../../.github/workflows');

function readWorkflow(fileName: string): Workflow {
  return parse(readFileSync(resolve(workflowDirectory, fileName), 'utf8')) as Workflow;
}

const lifecycle = readWorkflow('expo-web-preview-lifecycle.yml');
const build = readWorkflow('expo-web-preview.yml');
const publisher = readWorkflow('expo-web-preview-publish.yml');

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function lifecycleCondition(github: Record<string, unknown>): boolean {
  const condition = lifecycle.jobs.lifecycle.if;
  if (!condition) throw new Error('The lifecycle job must guard its privileged execution.');
  // Resolve missing event fields as undefined, as Actions does for absent
  // context properties. Execute the real YAML expression rather than a copy.
  const expression = condition.replace(
    /\bgithub((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g,
    (_, path: string) => `readPath(${JSON.stringify(path.slice(1))})`,
  );
  const readPath = (path: string): unknown =>
    path.split('.').reduce<unknown>((current, segment) => {
      if (current === null || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[segment];
    }, github);
  const startsWith = (input: unknown, prefix: string): boolean =>
    typeof input === 'string' && input.toLowerCase().startsWith(prefix.toLowerCase());
  // oxlint-disable-next-line no-implied-eval
  const evaluate = new Function('readPath', 'startsWith', `return Boolean(${expression});`) as (
    read: typeof readPath,
    starts: typeof startsWith,
  ) => boolean;
  return evaluate(readPath, startsWith);
}

describe('Expo web preview workflow trust boundaries', () => {
  it('routes automatic and manual events through trusted lifecycle tooling', () => {
    expect(lifecycle.on.pull_request_target).toEqual({
      types: ['opened', 'synchronize', 'reopened', 'edited', 'closed'],
    });
    expect(lifecycle.on.issue_comment).toEqual({ types: ['created'] });
    expect(lifecycle.on.workflow_dispatch?.inputs.pr).toEqual({
      description: 'Open PR number to preview',
      required: true,
      type: 'string',
    });
    expect(lifecycle.on.workflow_dispatch?.inputs.refresh).toEqual({
      description: 'Reconcile or renew an existing preview from the daily sweep',
      required: false,
      default: 'false',
      type: 'string',
    });
    expect(lifecycle.on.schedule).toHaveLength(1);
    expect(lifecycle.jobs.lifecycle.if).toContain("github.ref == 'refs/heads/main'");
    expect(lifecycle.jobs.lifecycle.if).toContain("startsWith(github.event.comment.body, '/web-preview')");
    expect(lifecycle.jobs.lifecycle.if).toContain('github.event.issue.pull_request');
    expect(lifecycle.jobs.lifecycle.environment).toBe('Production');

    const reconciliation = findStep(lifecycle.jobs.lifecycle, 'Reconcile app preview requests and hosting');
    expect(reconciliation.with?.script).toContain('controller.runLifecycle(');
    expect(reconciliation.env?.TRUSTED_SHA).toBe('${{ github.workflow_sha }}');
    expect(reconciliation.env?.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(lifecycle.jobs.lifecycle.steps.some((step) => step.run)).toBe(false);
    const setup = findStep(lifecycle.jobs.lifecycle, 'Set up trusted preview publishing tools');
    expect(setup.uses).toBe('voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb');
    expect(setup.with).toEqual({ 'node-version': '22.x', cache: false });
    expect(lifecycle.jobs.lifecycle.steps.indexOf(setup)).toBeLessThan(
      lifecycle.jobs.lifecycle.steps.indexOf(reconciliation),
    );
  });

  it.each([
    ['opened on main', 'opened', 'main', undefined, true],
    ['synchronized on main', 'synchronize', 'main', undefined, true],
    ['closed on main', 'closed', 'main', undefined, true],
    ['opened on another base', 'opened', 'release', undefined, false],
    ['retargeted toward main', 'edited', 'main', 'release', true],
    ['retargeted away from main', 'edited', 'release', 'main', true],
    ['retargeted between unrelated bases', 'edited', 'release-next', 'release', false],
    ['title or body edited on main', 'edited', 'main', undefined, false],
    ['title or body edited on another base', 'edited', 'release', undefined, false],
  ])('reconciles only relevant PR metadata: %s', (_, action, baseRef, previousBase, expected) => {
    const github = {
      ref: 'refs/heads/main',
      event_name: 'pull_request_target',
      event: {
        action,
        pull_request: { base: { ref: baseRef } },
        ...(previousBase ? { changes: { base: { ref: { from: previousBase } } } } : {}),
      },
    };
    expect(lifecycleCondition(github)).toBe(expected);
    expect(lifecycleCondition({ ...github, ref: 'refs/heads/untrusted' })).toBe(false);
  });

  it('preserves maintainer-command, manual, and scheduled event filters', () => {
    const comment = (body: string, isPullRequest = true) => ({
      ref: 'refs/heads/main',
      event_name: 'issue_comment',
      event: { comment: { body }, issue: isPullRequest ? { pull_request: {} } : {} },
    });
    expect(lifecycleCondition(comment('/web-preview'))).toBe(true);
    expect(lifecycleCondition(comment('/web-preview ' + 'a'.repeat(40)))).toBe(true);
    expect(lifecycleCondition(comment('Looks good'))).toBe(false);
    expect(lifecycleCondition(comment('/web-preview', false))).toBe(false);
    for (const eventName of ['workflow_dispatch', 'schedule']) {
      expect(lifecycleCondition({ ref: 'refs/heads/main', event_name: eventName, event: {} })).toBe(true);
      expect(lifecycleCondition({ ref: 'refs/heads/untrusted', event_name: eventName, event: {} })).toBe(false);
    }
  });

  it('runs PR code only in the validated sandbox build job without secrets or write permissions', () => {
    expect(Object.keys(build.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(build.on.workflow_dispatch?.inputs ?? {})).toEqual(['pr', 'sha', 'request']);
    for (const input of Object.values(build.on.workflow_dispatch?.inputs ?? {})) {
      expect(input.type).toBe('string');
      expect(input.required).toBe(true);
    }

    expect(build.jobs.inspect.if).toBe("startsWith(github.ref, 'refs/heads/ci-sandbox/web-preview/')");
    expect(findStep(build.jobs.inspect, 'Validate the sandbox and exact PR revision').with?.script).toContain(
      'controller.inspectBuild({ github, context, core })',
    );
    expect(build.jobs.build.needs).toBe('inspect');
    expect(build.jobs.build.if).toBe("needs.inspect.outputs.build == 'true'");
    expect(build.jobs.build.permissions).toEqual({ contents: 'read' });
    expect(build.jobs.build.environment).toBeUndefined();
    expect(findStep(build.jobs.build, 'Check out the approved PR source').with).toEqual({
      repository: '${{ needs.inspect.outputs.head_repository }}',
      ref: '${{ needs.inspect.outputs.head_sha }}',
      'persist-credentials': false,
    });

    const source = readFileSync(resolve(workflowDirectory, 'expo-web-preview.yml'), 'utf8');
    expect(source).not.toMatch(/\$\{\{\s*secrets\./);
    expect(source).not.toContain('actions/cache@');
    const setup = build.jobs.build.steps.find((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'));
    expect(setup?.with?.cache).toBe(false);
    expect(build.jobs.build.steps.find((step) => step.run?.startsWith('vp install'))?.run).toBe(
      'vp install --frozen-lockfile',
    );
  });

  it('bakes production public endpoints and separates preview telemetry', () => {
    expect(build.env).toMatchObject({
      EXPO_PUBLIC_BACKEND_URL: 'https://ws.boardsesh.com',
      EXPO_PUBLIC_WS_URL: 'wss://ws.boardsesh.com/graphql',
      EXPO_PUBLIC_WEB_URL: 'https://www.boardsesh.com',
      EXPO_PUBLIC_STATIC_ASSET_BASE_URL: 'https://assets.boardsesh.com',
      EXPO_PUBLIC_SENTRY_ENVIRONMENT: 'preview-web',
    });
    const exportStep = findStep(build.jobs.build, 'Build the browser app against production');
    expect(exportStep.env?.BOARDSESH_EXPORT_EXPECT_URLS).toBe('https://ws.boardsesh.com https://www.boardsesh.com');
    expect(exportStep.run).toBe('bash scripts/build-expo-web-export.sh --subdomain "$RUNNER_TEMP/export"');
    const upload = findStep(build.jobs.build, 'Upload the static export');
    expect(upload.with).toMatchObject({
      name: '${{ needs.inspect.outputs.artifact }}',
      path: '${{ runner.temp }}/export',
      'include-hidden-files': true,
      'if-no-files-found': 'error',
      'retention-days': 30,
    });
  });

  it('keeps trusted checkouts out of downloaded artifacts and PR source', () => {
    for (const workflow of [lifecycle, build, publisher]) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (workflow === build && jobName === 'build') continue;
        const checkouts = job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
        expect(checkouts.length).toBeGreaterThan(0);
        for (const checkout of checkouts) {
          expect(checkout.with?.ref).toBe('${{ github.workflow_sha }}');
          expect(checkout.with?.['persist-credentials']).toBe(false);
          expect(checkout.with?.repository).toBeUndefined();
        }
      }
    }
  });

  it('validates failed builds too and downloads only the inspected run artifact', () => {
    expect(Object.keys(publisher.on)).toEqual(['workflow_dispatch']);
    expect(publisher.on.workflow_dispatch?.inputs.source_run_id).toMatchObject({ required: true, type: 'string' });
    expect(publisher.on.workflow_run).toBeUndefined();
    expect(publisher.jobs.inspect.if).toBe("github.ref == 'refs/heads/main'");
    expect(findStep(publisher.jobs.inspect, 'Validate the completed source build').with?.script).toContain(
      'controller.inspectPublish({ github, context, core, inspectOnly: true })',
    );
    expect(publisher.jobs.inspect.permissions?.deployments).toBe('read');
    expect(publisher.jobs.inspect.permissions?.['pull-requests']).toBe('read');
    expect(publisher.jobs.publish.if).toBe("needs.inspect.outputs.pr_number != ''");
    expect(publisher.jobs.publish.environment).toBe('Production');
    const recheck = findStep(publisher.jobs.publish, 'Recheck the current request inside the PR mutation lane');
    expect(recheck.id).toBe('publish');
    expect(recheck.with?.script).toContain('controller.inspectPublish({ github, context, core })');
    const download = findStep(publisher.jobs.publish, "Download the exact source build's static export");
    expect(download.if).toBe("steps.publish.outputs.publish == 'true'");
    expect(download.with).toEqual({
      name: '${{ needs.inspect.outputs.artifact }}',
      path: '${{ runner.temp }}/export',
      'run-id': '${{ inputs.source_run_id }}',
      'github-token': '${{ github.token }}',
    });
    const publication = findStep(publisher.jobs.publish, 'Publish and verify this PR preview');
    expect(publication.if).toBe("steps.publish.outputs.publish == 'true'");
    expect(publication.with?.script).toContain('controller.publish(');
    expect(publication.with?.script).toContain('trustedDirectory: process.env.GITHUB_WORKSPACE');
    expect(publication.env?.EXPORT_DIRECTORY).toBe('${{ runner.temp }}/export');
    expect(publication.env?.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    const failure = findStep(publisher.jobs.publish, 'Report a failed publication');
    expect(failure.if).toBe('failure()');
    expect(failure.with?.script).toContain('controller.reportPublishFailure(');
  });

  it('explicitly dispatches publication because GITHUB_TOKEN sandbox runs suppress workflow_run', () => {
    expect(build.jobs.notify.needs).toEqual(['inspect', 'build', 'cleanup']);
    expect(build.jobs.notify.if).toBe("always() && needs.inspect.outputs.build == 'true'");
    expect(build.jobs.notify.permissions).toEqual({ actions: 'write', contents: 'read' });
    expect(build.jobs.notify.environment).toBeUndefined();
    const notification = findStep(build.jobs.notify, 'Request trusted publication of this build');
    expect(notification.with?.script).toContain('github.rest.actions.createWorkflowDispatch(');
    expect(notification.with?.script).toContain("workflow_id: 'expo-web-preview-publish.yml'");
    expect(notification.with?.script).toContain('ref: context.payload.repository.default_branch');
    expect(notification.with?.script).toContain('inputs: { source_run_id: String(context.runId) }');
    expect(build.jobs.cleanup.needs).toEqual(['inspect', 'build']);
  });

  it('shares a non-canceling per-PR mutation lane and always cleans its own sandbox', () => {
    expect(lifecycle.concurrency?.group).toBe(
      'expo-web-preview-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr || github.run_id }}',
    );
    expect(publisher.jobs.publish.concurrency?.group).toBe(
      'expo-web-preview-${{ needs.inspect.outputs.pr_number || github.run_id }}',
    );
    expect(lifecycle.concurrency?.['cancel-in-progress']).toBe(false);
    expect(publisher.jobs.publish.concurrency?.['cancel-in-progress']).toBe(false);
    expect(lifecycle.concurrency?.queue).toBe('max');
    expect(publisher.jobs.publish.concurrency?.queue).toBe('max');
    expect(build.jobs.cleanup.if).toBe("always() && startsWith(github.ref, 'refs/heads/ci-sandbox/web-preview/')");
    expect(build.jobs.cleanup.permissions).toEqual({ contents: 'write' });
    const cleanup = findStep(build.jobs.cleanup, "Remove this build's sandbox ref");
    expect(cleanup.with?.script).toContain("workflowKey: 'web-preview'");
  });

  it('exposes existing Cloudflare credentials only to trusted main-branch jobs', () => {
    const credentialJobs = [];
    for (const workflow of [lifecycle, build, publisher]) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const receivesCredentials = job.steps.some((step) =>
          Object.values(step.env ?? {}).some((setting) => setting.includes('secrets.CLOUDFLARE_')),
        );
        if (!receivesCredentials) continue;
        credentialJobs.push(jobName);
        expect(job.environment).toBe('Production');
        expect(workflow).not.toBe(build);
        for (const checkout of job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'))) {
          expect(checkout.with?.ref).toBe('${{ github.workflow_sha }}');
          expect(checkout.with?.repository).toBeUndefined();
          expect(checkout.with?.['persist-credentials']).toBe(false);
        }
      }
    }
    expect(credentialJobs).toEqual(['lifecycle', 'publish']);
    expect(lifecycle.jobs.lifecycle.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.jobs.inspect.if).toBe("github.ref == 'refs/heads/main'");
    expect(publisher.jobs.publish.needs).toBe('inspect');
    expect(publisher.jobs.publish.if).toBe("needs.inspect.outputs.pr_number != ''");
    for (const job of Object.values(build.jobs)) expect(job.environment).toBeUndefined();
  });
});
