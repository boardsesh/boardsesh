import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, { if?: string; 'runs-on': string; 'timeout-minutes': number; steps: WorkflowStep[] }>;
};
function workflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}`, 'utf8')) as Workflow;
}

describe('external TestFlight distribution workflow', () => {
  const native = workflow('ios-testflight-rn.yml');
  const followup = workflow('ios-testflight-distribute.yml');
  const nativeSteps = native.jobs['build-and-upload'].steps;
  const steps = followup.jobs.distribute.steps;

  it('runs independently after either trusted native build source, without holding the build lock', () => {
    expect(followup.on.workflow_run).toEqual({
      workflows: [native.name],
      types: ['completed'],
      branches: ['main', 'release/next'],
    });
    expect(followup.concurrency).toMatchObject({ 'cancel-in-progress': false, queue: 'max' });
    expect(followup.concurrency.group).not.toBe(native.concurrency.group);
    expect(followup.jobs.distribute['runs-on']).toBe('ubuntu-latest');
    expect(followup.jobs.distribute['timeout-minutes']).toBeGreaterThanOrEqual(75);
    expect(followup.jobs.distribute.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(followup.jobs.distribute.if).toContain("github.ref == 'refs/heads/main'");
    expect(nativeSteps.some((step) => step.run?.includes('distribute_testflight'))).toBe(false);
  });

  it('reports a wrong-branch manual dispatch as an error without exposing store credentials', () => {
    const rejected = followup.jobs['reject-untrusted-dispatch'];
    expect(rejected.if).toBe("github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'");
    expect(rejected.steps[0].run).toContain('::error::Dispatch this workflow from main.');
    expect(rejected.steps[0].run).toContain('exit 1');
    expect(rejected).not.toHaveProperty('environment');
    expect(rejected.steps[0].env).toBeUndefined();
  });

  it('freezes the prior native build before upload and publishes the receipt only after upload', () => {
    const capture = nativeSteps.findIndex((step) => step.id === 'testflight_receipt');
    const upload = nativeSteps.findIndex((step) => step.id === 'testflight_upload');
    const receipt = nativeSteps.findIndex(
      (step) => step.with?.name === 'ios-testflight-build-${{ github.run_attempt }}',
    );
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(upload);
    expect(receipt).toBeGreaterThan(upload);
    expect(nativeSteps[receipt].if).toContain("steps.testflight_upload.outcome == 'success'");
    expect(nativeSteps.find((step) => step.uses === 'actions/checkout@v4')?.with?.['fetch-depth']).toBe(0);
  });

  it('pins trusted tooling and validates source provenance before downloading the exact artifact', () => {
    expect(steps.find((step) => step.uses === 'actions/checkout@v4')?.with).toMatchObject({
      ref: '${{ github.workflow_sha }}',
      'persist-credentials': false,
      'fetch-depth': 0,
    });
    const resolve = steps.findIndex((step) => step.id === 'source');
    const download = steps.findIndex((step) => step.uses === 'actions/download-artifact@v4');
    expect(resolve).toBeLessThan(download);
    expect(steps[download].with).toMatchObject({
      'artifact-ids': '${{ steps.source.outputs.artifact_id }}',
      'run-id': '${{ steps.source.outputs.source_run_id }}',
      'github-token': '${{ github.token }}',
    });
    expect(followup.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
  });

  it('validates build identity and renders notes before using App Store credentials', () => {
    const validate = steps.findIndex((step) => step.id === 'build');
    const notes = steps.findIndex((step) => step.run?.includes('scripts/testflight-notes.ts'));
    const key = steps.findIndex((step) => step.name === 'Set up App Store Connect API key');
    const distribution = steps.findIndex((step) => step.run === 'bundle exec fastlane ios distribute_testflight');
    expect(validate).toBeLessThan(notes);
    expect(notes).toBeLessThan(key);
    expect(key).toBeLessThan(distribution);
    expect(steps[distribution].env).toMatchObject({
      RELEASE_VERSION: '${{ steps.build.outputs.version }}',
      IOS_BUILD_NUMBER: '${{ steps.build.outputs.build_number }}',
    });
    expect(steps[distribution].if).toBe("steps.source.outputs.should_distribute == 'true'");
    expect(steps.at(-1)).toMatchObject({ if: 'always()', run: 'rm -f "$RUNNER_TEMP/testflight-auth.p8"' });
  });
});
