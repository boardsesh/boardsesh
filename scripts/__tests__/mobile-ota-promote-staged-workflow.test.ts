import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
const source = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/mobile-ota-promote-staged.yml'),
  'utf8',
);
const workflow = parse(source) as {
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } };
  jobs: {
    promote: {
      steps: Step[];
      environment: string;
      permissions: Record<string, string>;
      concurrency: Record<string, unknown>;
      'timeout-minutes': number;
    };
  };
};
const job = workflow.jobs.promote;
const step = (name: string) => {
  const entry = job.steps.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing workflow step ${name}`);
  return entry;
};
it('requires a pinned source and trusted main controller without dependency installs', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.source_run_id).toMatchObject({ required: true, type: 'string' });
  expect(step('Refuse any ref but main').if).toBe("github.ref != 'refs/heads/main'");
  expect(step('Refuse blind workflow retries after possible partial writes').if).toBe('github.run_attempt != 1');
  expect(job.steps.find((entry) => entry.uses?.startsWith('actions/checkout@'))?.with).toEqual({
    ref: '${{ github.sha }}',
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  expect(source).not.toMatch(/\b(?:vp|npm|pnpm|yarn)\s+(?:install|exec|ci|dlx)\b/);
  for (const entry of job.steps) if (entry.uses) expect(entry.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(step('Restore pinned trusted staging artifact').run).toContain('source --run-id "$SOURCE_RUN_ID"');
});
it('holds the production lane through readiness, unlock and promotion with narrow permissions', () => {
  expect(job.environment).toBe('Production');
  expect(job.permissions).toEqual({ contents: 'read', actions: 'write' });
  expect(job.concurrency).toEqual({ group: 'mobile-ota-production', 'cancel-in-progress': false, queue: 'max' });
  expect(job['timeout-minutes']).toBeGreaterThanOrEqual(130);
  const names = job.steps.map((entry) => entry.name);
  const preflight = names.indexOf('Validate both archived exports before unlocking');
  const unlock = names.indexOf('Await trusted main-only production unlock');
  const promote = names.indexOf('Promote exact staged iOS and Android exports to production');
  expect(preflight).toBeLessThan(unlock);
  expect(unlock).toBeLessThan(promote);
});
it('checks source schema but controller server rollout and unlocks validated runtimes', () => {
  expect(step('Require live backend schema for the archived source').env).toEqual({
    GITHUB_SHA: '${{ steps.artifacts.outputs.source_sha }}',
  });
  const server = step('Wait for the OTA server rollout on the controller commit');
  expect(server.env?.GITHUB_SHA).toBeUndefined();
  expect(server.run).toBe('node scripts/mobile-ota-server-ready.mjs');
  expect(step('Await trusted main-only production unlock').env).toMatchObject({
    OTA_BRANCH: 'production',
    IOS_RUNTIME_VERSION: '${{ steps.preflight.outputs.ios_runtime }}',
    ANDROID_RUNTIME_VERSION: '${{ steps.preflight.outputs.android_runtime }}',
    STAGED_APP_ID: '${{ steps.preflight.outputs.app_id }}',
    EXPECTED_IOS_UPDATE_ID: '${{ steps.preflight.outputs.ios_baseline }}',
    EXPECTED_ANDROID_UPDATE_ID: '${{ steps.preflight.outputs.android_baseline }}',
    OTA_UNLOCK_RECEIPT: '${{ runner.temp }}/ota-unlock-receipt.json',
  });
});
it('scopes the token to the archived full production publisher and reports partial failures', () => {
  const publishing = step('Promote exact staged iOS and Android exports to production');
  expect(publishing.env?.EOO_TOKEN).toBe('${{ secrets.EOO_TOKEN }}');
  expect(publishing.env).toMatchObject({
    OTA_UNLOCK_RECEIPT: '${{ runner.temp }}/ota-unlock-receipt.json',
    OTA_UNLOCK_RUN_ID: '${{ steps.unlock.outputs.run_id }}',
    OTA_UNLOCK_REQUEST_ID: '${{ steps.unlock.outputs.request_id }}',
    OTA_UNLOCK_HEAD_SHA: '${{ steps.unlock.outputs.head_sha }}',
  });
  for (const entry of job.steps) if (entry !== publishing) expect(entry.env?.EOO_TOKEN).toBeUndefined();
  expect(publishing.run).toContain('--receipt ota-stage/receipt.json');
  expect(publishing.run).not.toMatch(/--rollout|--branch|--capture-baseline|expo export/);
  const report = step('Report each platform even after a partial promotion');
  expect(report.if).toContain('always()');
  expect(report.if).not.toContain("steps.promote.outcome == 'success'");
  expect(report.env?.PROMOTION_OUTCOME).toBe('${{ steps.promote.outcome }}');
});
