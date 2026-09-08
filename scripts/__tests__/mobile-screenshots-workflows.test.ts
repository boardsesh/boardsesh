/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The iOS screenshot run gates itself: one probe shard decides whether the other
 * eleven macOS runners are worth spending. That decision lives entirely in job
 * `needs`/`if` expressions, which nothing else type-checks or executes locally —
 * a single wrong `result ==` there either burns twelve runners on every nightly
 * or silently stops capturing anything at all. So the wiring is pinned here.
 */

const IOS_WORKFLOW_PATH = '.github/workflows/mobile-screenshots-ios.yml';
const STORE_DRAFT_PATH = '.github/workflows/mobile-store-draft.yml';
const SHARD_ACTION_PATH = '.github/actions/ios-screenshot-shard/action.yml';

function readYaml(path: string): string {
  return readFileSync(path, 'utf8');
}

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: { 'max-parallel'?: number; matrix?: unknown; 'fail-fast'?: boolean };
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface ParsedWorkflow {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

function parseWorkflow(path: string): ParsedWorkflow {
  return parse(readYaml(path)) as ParsedWorkflow;
}

/** Collapse an expression's whitespace so a wrapped `if:` compares like a one-liner. */
function flatten(expression: string | undefined): string {
  return (expression ?? '').replace(/\s+/g, ' ').trim();
}

describe('mobile-screenshots-ios.yml probe gate', () => {
  const source = readYaml(IOS_WORKFLOW_PATH);
  const workflow = parseWorkflow(IOS_WORKFLOW_PATH);

  it('is valid YAML with the four capture jobs', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['setup', 'ios-build', 'probe', 'ios-capture', 'ios-finalize']);
  });

  it('offers the gate and publish_baseline dispatch inputs', () => {
    const dispatch = workflow.on?.workflow_dispatch as { inputs?: Record<string, { default?: unknown }> };
    expect(Object.keys(dispatch.inputs ?? {})).toEqual([
      'flow',
      'gate',
      'locales',
      'render_mode',
      'boards',
      'upload',
      'publish_baseline',
    ]);
    expect(dispatch.inputs?.gate.default).toBe('full');
    expect(dispatch.inputs?.publish_baseline.default).toBe(false);
  });

  it('resolves the gate, the matrix and the source commit in setup', () => {
    const setup = workflow.jobs.setup;
    expect(Object.keys(setup.outputs ?? {})).toEqual(['ios_locales', 'ios_matrix', 'gate', 'source_sha']);
    // upload and probe are contradictory: an upload needs all 12 shards.
    expect(source).toContain('upload=true cannot be combined with gate=probe');
    // A narrowed / onboarding / uploading run has no full-set baseline to compare against.
    expect(source).toContain('if [ -n "$locales" ] || [ "$flow" = "onboarding" ] || [ "$upload" = "true" ]; then');
    // The exclude is derived from devices[0], not hand-copied, and a guard fails
    // the step if devices[0] ever stops being the iPhone 16 Pro Max the probe
    // shard actually shoots.
    expect(source).toContain(`jq -r '.[0].slug')" != "iphone-16-pro-max" ]; then`);
    expect(source).toContain(`exclude=$(printf '%s' "$devices" | jq -c '[{locale:"en-US", device: .[0]}]')`);
  });

  it('runs the probe on gate=probe only, off the shared shard action', () => {
    const probe = workflow.jobs.probe;
    expect(probe.needs).toEqual(['setup', 'ios-build']);
    expect(flatten(probe.if)).toBe("needs.setup.outputs.gate == 'probe'");
    expect(Object.keys(probe.outputs ?? {})).toEqual(['changed', 'changed_files', 'baseline_commit']);

    const steps = probe.steps ?? [];
    expect(steps[0].uses).toBe('actions/checkout@v4');
    expect(steps[1].uses).toBe('./.github/actions/ios-screenshot-shard');
    expect(steps[1].with?.locale).toBe('en-US');
    expect(steps[1].with?.['device-slug']).toBe('iphone-16-pro-max');

    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('vp run screenshot:baseline -- fetch');
    expect(runs).toContain('--asset ios-en-US-iphone-16-pro-max.zip');
    expect(runs).toContain('vp run screenshot:compare --');
    expect(runs).toContain('--candidate app-stores/apple/screenshots/en-US/iphone-16-pro-max');
    expect(steps.some((step) => step.with?.name === 'ios-probe-compare')).toBe(true);
  });

  it('fans out only when the probe was skipped or reported a change', () => {
    const capture = workflow.jobs['ios-capture'];
    expect(capture.needs).toEqual(['setup', 'ios-build', 'probe']);
    expect(flatten(capture.if)).toBe(
      "!cancelled() && needs.setup.result == 'success' && needs.ios-build.result == 'success' && " +
        "(needs.probe.result == 'skipped' || (needs.probe.result == 'success' && needs.probe.outputs.changed == 'true'))",
    );
    expect(capture.strategy?.['max-parallel']).toBe(4);
    expect(capture.strategy?.['fail-fast']).toBe(false);
    expect(capture.strategy?.matrix).toBe('${{ fromJSON(needs.setup.outputs.ios_matrix) }}');

    const steps = capture.steps ?? [];
    expect(steps[0].uses).toBe('actions/checkout@v4');
    expect(steps[1].uses).toBe('./.github/actions/ios-screenshot-shard');
    expect(steps[1].with?.locale).toBe('${{ matrix.locale }}');
    expect(steps[1].with?.['device-name']).toBe('${{ matrix.device.name }}');
  });

  it('finalizes on every non-cancelled run and skips the dimension gate when nothing moved', () => {
    const finalize = workflow.jobs['ios-finalize'];
    expect(finalize.needs).toEqual(['setup', 'ios-build', 'probe', 'ios-capture']);
    expect(flatten(finalize.if)).toContain("needs.setup.result == 'success'");
    expect(flatten(finalize.if)).toContain('!cancelled()');
    // The baseline prerelease is the only thing this workflow writes.
    expect(finalize.permissions).toEqual({ contents: 'write' });
    // `environment:` folds across lines in the YAML source (`>-`); flatten()
    // collapses that fold to single spaces the same way it does for `if:` above.
    expect(flatten(finalize.environment)).toBe(
      "${{ ((github.event_name == 'workflow_dispatch' && inputs.upload) || " +
        "(github.event_name == 'workflow_run' && needs.ios-capture.result == 'success')) && 'Production' || '' }}",
    );
    expect(flatten(finalize.env?.UNCHANGED)).toBe(
      "${{ needs.probe.result == 'success' && needs.probe.outputs.changed == 'false' }}",
    );
    // FULL_SET_CAPTURED also folds across lines (`>-`); same flatten() treatment.
    expect(flatten(finalize.env?.FULL_SET_CAPTURED)).toBe(
      "${{ needs.ios-capture.result == 'success' && " +
        "(needs.probe.result == 'skipped' || needs.probe.result == 'success') && " +
        "(inputs.flow == null || inputs.flow == 'app-store') && " +
        "(inputs.locales == null || inputs.locales == '') }}",
    );

    const gateStep = (finalize.steps ?? []).find((step) => step.name === 'Assert screenshot dimensions');
    expect(flatten(gateStep?.if)).toBe(
      "${{ success() && env.UNCHANGED != 'true' && inputs.flow != 'onboarding' && " +
        "(inputs.locales == '' || inputs.locales == null) }}",
    );

    const publishStep = (finalize.steps ?? []).find((step) => step.name === 'Publish screenshot baseline');
    expect(flatten(publishStep?.if)).toBe(
      "${{ success() && env.FULL_SET_CAPTURED == 'true' && " +
        "(github.event_name == 'workflow_run' || inputs.publish_baseline == true) }}",
    );
    expect(publishStep?.run).toContain('vp run screenshot:baseline -- publish');
    expect(publishStep?.run).toContain('--commit "${{ needs.setup.outputs.source_sha }}"');
  });

  it('uploads to App Store Connect on an upload dispatch or a complete automatic run', () => {
    const finalize = workflow.jobs['ios-finalize'];
    const uploadStep = (finalize.steps ?? []).find((step) => step.name === 'Upload screenshots to App Store Connect');
    expect(flatten(uploadStep?.if)).toBe(
      "${{ success() && (env.UPLOAD_RUN == 'true' || " +
        "(github.event_name == 'workflow_run' && env.FULL_SET_CAPTURED == 'true')) }}",
    );
  });

  it('keeps the pinned simulator-app cache key in ios-build', () => {
    // scripts/mobile-ci-env-parity.test.ts asserts the shape of this line; it must
    // not migrate into the composite action with the rest of the shard body.
    const cacheKeyLine = source.split('\n').find((line) => line.includes('screenshot-sim-app-v1-${{ hashFiles('));
    expect(cacheKeyLine).toBe(
      "        run: echo \"key=${{ runner.os }}-${{ runner.arch }}-screenshot-sim-app-v1-${{ hashFiles('packages/mobile/app.config.ts', 'packages/mobile/plugins/**', 'packages/mobile/modules/**', 'packages/mobile/locales/**', 'packages/mobile/package.json', 'patches/**', 'package.json', 'pnpm-workspace.yaml', 'scripts/mobile-build-sim-app.ts', 'scripts/screenshot-sim.entitlements') }}\" >> \"$GITHUB_OUTPUT\"",
    );
    const buildSteps = workflow.jobs['ios-build'].steps ?? [];
    expect(buildSteps.some((step) => step.name === 'Compute app cache key')).toBe(true);
  });

  it('checks the repo out in every job that runs a step from it', () => {
    for (const jobName of ['ios-build', 'probe', 'ios-capture', 'ios-finalize']) {
      const steps = workflow.jobs[jobName].steps ?? [];
      expect(
        steps.some((step) => step.uses === 'actions/checkout@v4'),
        `${jobName} must check out`,
      ).toBe(true);
    }
  });
});

describe('ios-screenshot-shard composite action', () => {
  it('exists and takes the seven shard inputs', () => {
    expect(existsSync(SHARD_ACTION_PATH)).toBe(true);
    const action = parse(readYaml(SHARD_ACTION_PATH)) as {
      inputs: Record<string, { required?: boolean }>;
      runs: { using: string; steps: WorkflowStep[] };
    };
    expect(Object.keys(action.inputs)).toEqual([
      'locale',
      'device-name',
      'device-slug',
      'flow',
      'render-mode',
      'boards',
      'app-cache-key',
    ]);
    expect(action.runs.using).toBe('composite');
  });

  it('restores the prebuilt app read-only and uploads a per-shard artifact', () => {
    const source = readYaml(SHARD_ACTION_PATH);
    expect(source).toContain('fail-on-cache-miss: true');
    expect(source).toContain('key: ${{ inputs.app-cache-key }}');
    expect(source).toContain('name: ios-screenshots-${{ inputs.locale }}-${{ inputs.device-slug }}');
    // The capture body must stay byte-identical between the probe and the fan-out.
    expect(source).toContain('vp run mobile:screenshots -- \\');
    expect(source).toContain('attempts=2');
  });
});

describe('mobile-store-draft.yml screenshot attach', () => {
  const workflow = parseWorkflow(STORE_DRAFT_PATH);

  it('attaches the baseline after the draft step created the version', () => {
    const steps = workflow.jobs.ios.steps ?? [];
    const draftIndex = steps.findIndex((step) => step.id === 'draft');
    const fetchIndex = steps.findIndex((step) => step.name === 'Fetch screenshot baseline');
    const attachIndex = steps.findIndex((step) => step.name === 'Attach baseline screenshots to the draft');

    expect(draftIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(draftIndex);
    expect(attachIndex).toBeGreaterThan(fetchIndex);
    expect(steps[fetchIndex].run).toContain('vp run screenshot:baseline -- fetch --platform ios --all');
    expect(steps[attachIndex].run).toContain('bundle exec fastlane ios screenshots');
    expect(flatten(steps[fetchIndex].if)).toBe("steps.draft.outcome == 'success'");
    // Gates on the fetch script's own `found` output, not just its exit code —
    // `screenshot-baseline.ts` fetch exits 0 with found=false whenever no
    // baseline has been published yet, and this must not attach an empty tree.
    expect(flatten(steps[attachIndex].if)).toBe(
      "steps.draft.outcome == 'success' && steps.baseline.outputs.found == 'true'",
    );
  });

  it('keeps the attach best-effort and warns loudly instead of failing the job', () => {
    const source = readYaml(STORE_DRAFT_PATH);
    expect(source).toContain('Could not attach baseline screenshots to the App Store draft.');
    const steps = workflow.jobs.ios.steps ?? [];
    const attachStep = steps.find((step) => step.id === 'attach_screenshots') as
      | (WorkflowStep & { 'continue-on-error'?: boolean })
      | undefined;
    expect(attachStep?.['continue-on-error']).toBe(true);
  });

  it('distinguishes "no baseline yet" from "attach failed" in its warnings', () => {
    const steps = workflow.jobs.ios.steps ?? [];
    const noBaselineStep = steps.find((step) => step.name === 'Warn if no screenshot baseline has been published yet');
    const attachFailedStep = steps.find((step) => step.name === 'Warn if attaching screenshots failed');

    expect(flatten(noBaselineStep?.if)).toBe(
      "steps.draft.outcome == 'success' && steps.baseline.outputs.found != 'true'",
    );
    expect(noBaselineStep?.run).toContain('publish_baseline: true');
    expect(flatten(attachFailedStep?.if)).toBe("steps.attach_screenshots.outcome == 'failure'");
  });
});
