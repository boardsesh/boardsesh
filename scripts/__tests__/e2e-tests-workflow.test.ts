/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Pins which jobs of e2e-tests.yml run for which trigger.
 *
 * The workflow has three ways in (dispatch, nightly schedule, workflow_call)
 * and only a dispatch may run the full suite. That split lives entirely in
 * `if:` expressions, and a wrong one fails quietly: the nightly starts the
 * eight e2e shards, or a gate call skips the one job it asked for.
 */

type Step = { name?: string; if?: string; uses?: string; with?: Record<string, string> };
type Job = { if?: string; needs?: string[]; environment?: string; steps?: Step[] };
type Workflow = {
  on: {
    schedule?: Array<{ cron: string }>;
    workflow_call?: { inputs: Record<string, { required?: boolean; type: string; default?: unknown }> };
  };
  concurrency: { group: string; 'cancel-in-progress': string | boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(readFileSync('.github/workflows/e2e-tests.yml', 'utf8')) as Workflow;
const FULL_SUITE_ONLY = "github.event_name == 'workflow_dispatch' && !inputs.called";

describe('e2e-tests.yml triggers', () => {
  it('keeps the dispatch trigger and runs nightly off the hour', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'schedule', 'workflow_call']);
    const [minute] = (workflow.on.schedule?.[0]?.cron ?? '').split(' ');
    expect(Number(minute)).toBeGreaterThan(0);
  });

  it('reads "this is a call" off an input only workflow_call defines, defaulting to true', () => {
    const inputs = workflow.on.workflow_call?.inputs ?? {};
    expect(inputs.ref).toMatchObject({ required: true, type: 'string' });
    expect(inputs.called).toMatchObject({ type: 'boolean', default: true });
  });

  it('runs typecheck and build on a manual dispatch only', () => {
    expect(workflow.jobs.typecheck.if).toBe(FULL_SUITE_ONLY);
    expect(workflow.jobs.build.if).toBe(FULL_SUITE_ONLY);
  });

  it('lets the e2e shards skip with the jobs they need', () => {
    // No `if:` of their own: a skipped need skips them, which is what keeps
    // them off the schedule and the call.
    expect(workflow.jobs.e2e.if).toBeUndefined();
    expect(workflow.jobs.e2e.needs).toEqual(['typecheck', 'build']);
  });

  it('runs the smoke when the typecheck passed or was skipped', () => {
    const smoke = workflow.jobs['expo-web-smoke'];
    expect(smoke.needs).toEqual(['typecheck']);
    expect(smoke.if).toBe(
      "${{ !cancelled() && (needs.typecheck.result == 'success' || needs.typecheck.result == 'skipped') }}",
    );
  });

  it('refuses a call with an empty ref before checking anything out', () => {
    const [guard, checkout] = workflow.jobs['expo-web-smoke'].steps ?? [];
    expect(guard.if).toBe('inputs.called && !inputs.ref');
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with?.ref).toBe('${{ inputs.ref }}');
  });

  it('never cancels a called run, and keeps calls out of the dispatch and nightly groups', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe('${{ !inputs.called }}');
    expect(workflow.concurrency.group).toBe(
      'e2e-${{ github.ref }}-${{ inputs.called && inputs.ref || github.event_name }}',
    );
  });

  it('posts to Discord only when the nightly run fails, from a job that can read the webhook', () => {
    // DISCORD_DEPLOY_WEBHOOK is an environment secret. As a step of the smoke
    // job (no environment) the post read an empty string and never fired.
    const notify = workflow.jobs['notify-nightly'];
    expect(notify.environment).toBe('Production');
    expect(notify.needs).toEqual(['expo-web-smoke']);
    expect(notify.if).toBe(
      "${{ always() && github.event_name == 'schedule' && !inputs.called && needs.expo-web-smoke.result == 'failure' }}",
    );
    expect(workflow.jobs['expo-web-smoke'].environment).toBeUndefined();
    const smokeSteps = workflow.jobs['expo-web-smoke'].steps ?? [];
    expect(smokeSteps.some((step) => step.name?.includes('Discord'))).toBe(false);
  });
});
