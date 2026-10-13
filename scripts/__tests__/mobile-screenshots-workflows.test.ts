/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CPP_MANIFEST_PATH, CPP_TARGETS, readCppPage } from '../lib/screenshot-cpp';

/**
 * The screenshot runs gate themselves twice over: a `workflow_run` trigger plus a
 * shipped-binary check decide whether a native deploy is worth capturing at all,
 * and on iOS one probe shard then decides whether the other fifteen macOS runners
 * are worth spending. Both decisions live entirely in trigger blocks and job
 * `needs`/`if` expressions, which nothing else type-checks and which cannot be
 * exercised from a branch — a `workflow_run` workflow always runs the copy of
 * itself that sits on the default branch. A single wrong `result ==` there either
 * burns sixteen runners after every JS-only push or silently stops capturing
 * anything at all. So the wiring is pinned here.
 */

const IOS_WORKFLOW_PATH = '.github/workflows/mobile-screenshots-ios.yml';
const ANDROID_WORKFLOW_PATH = '.github/workflows/mobile-screenshots-android.yml';
const IOS_DEPLOY_PATH = '.github/workflows/ios-testflight-rn.yml';
const ANDROID_DEPLOY_PATH = '.github/workflows/android-apk-rn.yml';
const STORE_DRAFT_PATH = '.github/workflows/mobile-store-draft.yml';
const SHARD_ACTION_PATH = '.github/actions/ios-screenshot-shard/action.yml';

/** The exact commit a capture must photograph: the deploy's head, else our own. */
const SOURCE_SHA_EXPRESSION = '${{ github.event.workflow_run.head_sha || github.sha }}';

/** The conclusion guard, copied verbatim from mobile-store-draft.yml. */
const CONCLUSION_GUARD = "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'";

function readYaml(path: string): string {
  return readFileSync(path, 'utf8');
}

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  /** A single dependency is written as a scalar in these files; several as a list. */
  needs?: string | string[];
  if?: string;
  environment?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: { 'max-parallel'?: number; matrix?: unknown; 'fail-fast'?: boolean };
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowRunTrigger {
  workflows?: string[];
  types?: string[];
  branches?: string[];
}

interface PushTrigger {
  branches?: string[];
}

interface ParsedWorkflow {
  name?: string;
  on?: Record<string, unknown>;
  env?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, WorkflowJob>;
}

function parseWorkflow(path: string): ParsedWorkflow {
  return parse(readYaml(path)) as ParsedWorkflow;
}

/** The `name:` a workflow declares — the string a `workflow_run` subscribes to. */
function workflowName(path: string): string {
  const declared = parseWorkflow(path).name;
  expect(declared, `${path} must declare a name`).toBeTruthy();
  return declared as string;
}

/** Read the trusted native release branches so captures cannot lose a source. */
function deployBranches(deployPath: string): string[] {
  const push = (parseWorkflow(deployPath).on ?? {}).push as PushTrigger | undefined;
  const branches = push?.branches ?? [];
  expect(branches, `${deployPath} must build from both trusted release branches`).toEqual(['main', 'release/next']);
  return branches;
}

/** Every `actions/checkout` step in a workflow, flattened across its jobs. */
function checkoutSteps(workflow: ParsedWorkflow): WorkflowStep[] {
  return Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith('actions/checkout@'));
}

/**
 * Every `actions/checkout` step inside the shared shard composite action. It has
 * none today — the action's own doc comment says the caller must check out first
 * — but a composite action's `runs.steps` is a completely separate structure
 * from a workflow's `jobs`, so `checkoutSteps()` above would silently miss one
 * added here. Folded into the same ref: assertion below so that blind spot can't
 * reopen.
 */
function shardActionCheckoutSteps(): WorkflowStep[] {
  const action = parse(readYaml(SHARD_ACTION_PATH)) as { runs: { steps?: WorkflowStep[] } };
  return (action.runs.steps ?? []).filter((step) => (step.uses ?? '').startsWith('actions/checkout@'));
}

/**
 * Every `inputs.<name>` read must survive the `workflow_run` trigger, where the
 * whole `inputs` context is null. Exactly three shapes do:
 *
 *   (a) `inputs.x || <default>` — a defaulted read.
 *   (b) `inputs.x == …` / `inputs.x != …` — an explicit comparison. Null compares
 *       predictably: `inputs.locales == null` is true, `inputs.flow != 'onboarding'`
 *       is true, and that IS the intended "not narrowed / not onboarding" reading.
 *   (c) `github.event_name == 'workflow_dispatch' && inputs.x` — a bare read fenced
 *       behind a dispatch check that short-circuits on every other trigger.
 *
 * Anything else is reported. The shape that matters is a bare `${{ inputs.someBool }}`
 * in an `if:`: on workflow_run it resolves to the empty string, so the step is
 * skipped by accident rather than by design — and it starts running the day
 * someone flips the input's default.
 *
 * Full-line YAML comments are skipped: prose about `inputs.x` is not an expression.
 */
function nullIntolerantInputReads(source: string): string[] {
  const offenders: string[] = [];
  source.split('\n').forEach((line, index) => {
    // Same rule as withoutCommentLines() in ./helpers/workflow-yaml, inlined so
    // an offender can be reported with its real line number.
    if (line.trimStart().startsWith('#')) return;
    for (const match of line.matchAll(/inputs\.[A-Za-z0-9_]+/g)) {
      const start = match.index ?? 0;
      const tail = line.slice(start);
      const head = line.slice(0, start);
      const defaulted = /^inputs\.[A-Za-z0-9_]+\s*\|\|/.test(tail);
      const compared = /^inputs\.[A-Za-z0-9_]+\s*[=!]=/.test(tail);
      const fenced = /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*$/.test(head);
      if (!defaulted && !compared && !fenced) {
        offenders.push(`line ${index + 1}: ${line.trim()}`);
      }
    }
  });
  return offenders;
}

/** Collapse an expression's whitespace so a wrapped `if:` compares like a one-liner. */
function flatten(expression: string | undefined): string {
  return (expression ?? '').replace(/\s+/g, ' ').trim();
}

describe('mobile-screenshots-ios.yml probe gate', () => {
  const source = readYaml(IOS_WORKFLOW_PATH);
  const workflow = parseWorkflow(IOS_WORKFLOW_PATH);

  it('is valid YAML with the four capture jobs, in dependency order', () => {
    // Pins the fix for the #5331 review thread: an exact toEqual() on the full
    // job list would fail the day a debug or reporting job is appended, even
    // though nothing about the capture pipeline changed. Assert the required
    // jobs are present (toContain, one at a time) and still appear in the
    // relative order their `needs` chains assume — but don't forbid a later
    // job existing alongside them.
    const jobNames = Object.keys(workflow.jobs);
    const REQUIRED_JOBS = ['setup', 'ios-build', 'probe', 'ios-capture', 'ios-finalize'];
    for (const job of REQUIRED_JOBS) {
      expect(jobNames).toContain(job);
    }
    expect(jobNames.filter((name) => REQUIRED_JOBS.includes(name))).toEqual(REQUIRED_JOBS);
  });

  it('offers default-listing and CPP dispatch inputs', () => {
    const dispatch = workflow.on?.workflow_dispatch as { inputs?: Record<string, { default?: unknown }> };
    expect(Object.keys(dispatch.inputs ?? {})).toEqual([
      'flow',
      'gate',
      'locales',
      'render_mode',
      'boards',
      'fixtures',
      'fixture_snapshot',
      'frozen_now',
      'upload',
      'publish_baseline',
      'cpp_target',
      'cpp_action',
      'cpp_keyword_ids',
      'cpp_record_run_id',
      'cpp_scenario',
    ]);
    expect(dispatch.inputs?.gate.default).toBe('full');
    expect(dispatch.inputs?.publish_baseline.default).toBe(false);
    expect(dispatch.inputs?.cpp_target.default).toBe('none');
    expect(dispatch.inputs?.cpp_action.default).toBe('capture');
    expect(dispatch.inputs?.cpp_keyword_ids.default).toBe('');
    expect(dispatch.inputs?.cpp_scenario.default).toBe('');
  });

  it('resolves the gate, the matrix and the source commit in setup', () => {
    const setup = workflow.jobs.setup;
    expect(Object.keys(setup.outputs ?? {})).toEqual([
      'ios_locales',
      'ios_matrix_full',
      'ios_matrix_without_probe',
      'gate',
      'source_sha',
      'shipped',
      'cpp_matrix',
    ]);
    // upload and probe are contradictory: an upload needs all 16 shards.
    expect(source).toContain('upload=true cannot be combined with gate=probe');
    // A narrowed / onboarding / uploading run has no full-set baseline to compare against.
    expect(source).toContain('if [ -n "$locales" ] || [ "$flow" = "onboarding" ] || [ "$upload" = "true" ]; then');
    // The exclude is derived from devices[0], not hand-copied, and a guard fails
    // the step if devices[0] ever stops being the iPhone 16 Pro Max the probe
    // shard actually shoots.
    expect(source).toContain(`jq -r '.[0].slug')" != "iphone-16-pro-max" ]; then`);
    expect(source).toContain(`probe_exclude=$(printf '%s' "$devices" | jq -c '[{locale:"en-US", device: .[0]}]')`);
  });

  it('captures four devices across four app locales and five store locales', () => {
    const compute = workflow.jobs.setup.steps?.find((step) => step.id === 'compute')?.run ?? '';
    const devicesJson = compute.match(/devices='([^']+)'/)?.[1];
    expect(devicesJson).toBeDefined();
    const devices = JSON.parse(devicesJson ?? '[]') as Array<{ name: string; slug: string }>;
    expect(devices.map((device) => device.slug)).toEqual([
      'iphone-16-pro-max',
      'iphone-16-pro',
      'ipad-pro-13-inch-m5',
      'ipad-pro-11-inch-m5',
    ]);
    expect(devices.length * 4).toBe(16);
    expect(devices.length * 5).toBe(20);
  });

  it('runs the probe on gate=probe only, off the shared shard action', () => {
    const probe = workflow.jobs.probe;
    expect(probe.needs).toEqual(['setup', 'ios-build']);
    expect(flatten(probe.if)).toBe(
      "needs.setup.outputs.gate == 'probe' && needs.setup.outputs.shipped == 'true' && " +
        "(inputs.cpp_target == null || inputs.cpp_target == 'none')",
    );
    expect(Object.keys(probe.outputs ?? {})).toEqual([
      'changed',
      'changed_files',
      'baseline_commit',
      'force_full',
      'force_full_reason',
    ]);

    const steps = probe.steps ?? [];
    expect(steps[0].uses).toBe('actions/checkout@v4');
    // Full history: the scope step below diffs against the baseline's own
    // commit, which a shallow clone might not reach.
    expect(steps[0].with?.['fetch-depth']).toBe(0);
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

  it('closes the probe blind spot with the scope script before comparing pixels', () => {
    // Pins the fix for #5326 review thread on line 357: the probe only ever
    // shoots en-US x iPhone 16 Pro Max, so a locale-only or iPad-only change
    // needs a changed-file signal, not a pixel one.
    const probe = workflow.jobs.probe;
    const steps = probe.steps ?? [];
    const baselineIndex = steps.findIndex((step) => step.id === 'baseline');
    const scopeIndex = steps.findIndex((step) => step.id === 'scope');
    const compareIndex = steps.findIndex((step) => step.id === 'compare');

    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeGreaterThan(baselineIndex);
    expect(compareIndex).toBeGreaterThan(scopeIndex);

    const scopeStep = steps[scopeIndex];
    expect(scopeStep.run).toContain('vp run screenshot:probe-scope -- --changed-files-file');
    expect(scopeStep.run).toContain('vp run screenshot:probe-scope -- --unreachable-baseline');
    expect(scopeStep.run).toContain('git fetch origin "$BASELINE_COMMIT"');
    expect(scopeStep.run).toContain('git diff --name-only "$BASELINE_COMMIT" "$SOURCE_SHA"');
    expect(scopeStep.run).toContain('git cat-file -e');
  });

  it('fans out when the probe was skipped, crashed, reported a change, or forced a full capture', () => {
    // Pins the fix for #5326 review thread: a probe that FAILS must fan out
    // exactly like a probe that was skipped, not silently stop the run and let
    // ios-finalize's dimension gate redden it by accident. Mutation check: drop
    // the `needs.probe.result == 'failure'` clause below and this test must fail.
    const capture = workflow.jobs['ios-capture'];
    expect(capture.needs).toEqual(['setup', 'ios-build', 'probe']);
    const captureIf = flatten(capture.if);
    expect(captureIf).toContain("needs.probe.result == 'failure'");
    expect(captureIf).toBe(
      "!cancelled() && needs.setup.result == 'success' && needs.setup.outputs.shipped == 'true' && " +
        "(inputs.cpp_target == null || inputs.cpp_target == 'none') && " +
        "needs.ios-build.result == 'success' && " +
        "(needs.probe.result == 'skipped' || needs.probe.result == 'failure' || " +
        "(needs.probe.result == 'success' && " +
        "(needs.probe.outputs.changed == 'true' || needs.probe.outputs.force_full == 'true')))",
    );
    expect(capture.strategy?.['max-parallel']).toBe(4);
    expect(capture.strategy?.['fail-fast']).toBe(false);

    const steps = capture.steps ?? [];
    expect(steps[0].uses).toBe('actions/checkout@v4');
    expect(steps[1].uses).toBe('./.github/actions/ios-screenshot-shard');
    expect(steps[1].with?.locale).toBe('${{ matrix.locale }}');
    expect(steps[1].with?.['device-name']).toBe('${{ matrix.device.name }}');
  });

  it('captures the full 16-shard matrix when the probe crashed or was skipped, and the 15-shard one only on probe success', () => {
    // Pins the #5326 fix: gate=probe computes an exclude assuming the probe
    // itself will capture and upload its shard, but a probe that FAILS may not
    // does that — so the matrix, not just the `if:`, must fall back to the
    // full 16-shard set on failure (and on `skipped`, the gate=full path,
    // which never asked for an exclude at all). Only an actually-successful
    // probe gets the 15-shard exclude. Mutation check: hardcode this to
    // always resolve to ios_matrix_without_probe and this test must fail.
    const capture = workflow.jobs['ios-capture'];
    const matrixExpression = flatten(capture.strategy?.matrix as string | undefined);
    expect(matrixExpression).toContain('needs.probe.result');
    expect(matrixExpression).toContain('needs.setup.outputs.ios_matrix_without_probe');
    expect(matrixExpression).toContain('needs.setup.outputs.ios_matrix_full');
    expect(matrixExpression).toBe(
      "${{ fromJSON(needs.probe.result == 'success' && needs.setup.outputs.ios_matrix_without_probe || " +
        'needs.setup.outputs.ios_matrix_full) }}',
    );
  });

  it('finalizes every non-cancelled default-listing run and skips unchanged dimensions', () => {
    const finalize = workflow.jobs['ios-finalize'];
    expect(finalize.needs).toEqual(['setup', 'ios-build', 'probe', 'ios-capture']);
    expect(flatten(finalize.if)).toContain("needs.setup.result == 'success'");
    expect(flatten(finalize.if)).toContain('!cancelled()');
    expect(flatten(finalize.if)).toContain("(inputs.cpp_target == null || inputs.cpp_target == 'none')");
    // The baseline prerelease is the only thing this workflow writes.
    expect(finalize.permissions).toEqual({ contents: 'write' });
    // `environment:` folds across lines in the YAML source (`>-`); flatten()
    // collapses that fold to single spaces the same way it does for `if:` above.
    expect(flatten(finalize.environment)).toBe(
      "${{ ((github.event_name == 'workflow_dispatch' && inputs.upload) || " +
        "(github.event_name == 'workflow_run' && needs.ios-capture.result == 'success')) && 'Production' || '' }}",
    );
    // UNCHANGED must require the probe to have actually SUCCEEDED — a crashed
    // probe (result == 'failure') must never read as "unchanged", since
    // ios-capture fans out to cover it and there is no trustworthy pixel
    // comparison to trust in that case. Mutation check: drop the
    // `needs.probe.result == 'success' &&` clause and this test must fail.
    const unchanged = flatten(finalize.env?.UNCHANGED);
    expect(unchanged).toContain("needs.probe.result == 'success'");
    expect(unchanged).toBe(
      "${{ needs.probe.result == 'success' && needs.probe.outputs.changed == 'false' && " +
        "needs.probe.outputs.force_full != 'true' }}",
    );
    // FULL_SET_CAPTURED also folds across lines (`>-`); same flatten() treatment.
    // It deliberately does NOT gate on the probe's own result: a crashed probe
    // still fans out via ios-capture, and any shard the crash cost is caught by
    // the dimension gate below (itself behind `success()`), not by this flag.
    expect(flatten(finalize.env?.FULL_SET_CAPTURED)).toBe(
      "${{ needs.ios-capture.result == 'success' && " +
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

  it('excludes artifacts from a failed probe when the full matrix recovers its pair', () => {
    const download = workflow.jobs['ios-finalize'].steps?.find((step) => step.name === 'Download locale screenshots');
    expect(download?.with?.pattern).toBe(
      "${{ needs.probe.result == 'success' && 'ios-screenshots-*' || 'ios-screenshots-ios-capture-*' }}",
    );
    expect(download?.with?.['merge-multiple']).toBe(true);
    const action = parse(readYaml(SHARD_ACTION_PATH)) as { runs: { steps: WorkflowStep[] } };
    const uploads = action.runs.steps.filter((step) => step.uses === 'actions/upload-artifact@v4');
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      // Debug and recorded-fixture uploads must also survive recovery after a
      // partial capture; each caller gets its own immutable artifact name.
      expect(upload.with?.name).toContain('${{ github.job }}');
    }
  });

  it('cannot report FULL_SET_CAPTURED=true on the partial/unchanged path where ios-capture was skipped', () => {
    // The partial/unchanged path: the probe found nothing changed (or the
    // whole run was gate=probe and stayed that way), so ios-capture's `if:`
    // never fires and the job is SKIPPED — needs.ios-capture.result is
    // 'skipped', never 'success'. FULL_SET_CAPTURED opens on
    // `needs.ios-capture.result == 'success' &&`, so the `&&` chain
    // short-circuits to false the moment that leading clause fails, by
    // construction — it cannot read true unless ios-capture actually ran and
    // succeeded, regardless of the flow/locales clauses that follow it.
    const finalize = workflow.jobs['ios-finalize'];
    const fullSetCaptured = flatten(finalize.env?.FULL_SET_CAPTURED);
    expect(fullSetCaptured.startsWith("${{ needs.ios-capture.result == 'success' &&")).toBe(true);
  });

  it('uploads to App Store Connect on an upload dispatch or a complete automatic run', () => {
    const finalize = workflow.jobs['ios-finalize'];
    const uploadStep = (finalize.steps ?? []).find((step) => step.name === 'Upload screenshots to App Store Connect');
    expect(flatten(uploadStep?.if)).toBe(
      "${{ success() && env.FULL_SET_CAPTURED == 'true' && " +
        "(env.MANUAL_UPLOAD_RUN == 'true' || github.event_name == 'workflow_run') }}",
    );
  });

  it.each([
    ['manual failed capture', 'workflow_dispatch', 'failure', 'app-store', '', true, true, false],
    ['manual cancelled capture', 'workflow_dispatch', 'cancelled', 'app-store', '', true, true, false],
    ['manual skipped capture', 'workflow_dispatch', 'skipped', 'app-store', '', true, true, false],
    ['manual full successful capture', 'workflow_dispatch', 'success', 'app-store', '', true, true, true],
    ['manual narrowed capture', 'workflow_dispatch', 'success', 'app-store', 'en-US', true, true, false],
    ['manual onboarding capture', 'workflow_dispatch', 'success', 'onboarding', '', true, true, false],
    ['manual capture-only', 'workflow_dispatch', 'success', 'app-store', '', false, true, false],
    ['automatic full capture', 'workflow_run', 'success', null, null, false, true, true],
    ['automatic failed capture', 'workflow_run', 'failure', null, null, false, true, false],
    ['failed finalizer content gate', 'workflow_dispatch', 'success', 'app-store', '', true, false, false],
  ])(
    'gates every regular ASC preparation/upload step for %s',
    (_label, eventName, captureResult, flow, locales, upload, priorStepsSucceeded, expected) => {
      const finalize = workflow.jobs['ios-finalize'];
      const evaluate = (expression: string | undefined, context: Record<string, unknown>): unknown =>
        runInNewContext(
          flatten(expression)
            .replace(/^\$\{\{\s*/, '')
            .replace(/\s*\}\}$/, '')
            .replaceAll('needs.ios-capture', "needs['ios-capture']"),
          context,
        );
      const context = {
        github: { event_name: eventName },
        inputs: { flow, locales, upload },
        needs: { 'ios-capture': { result: captureResult } },
        // Successful dimension/content steps can exist beside a failed native
        // capture and its always-retained images; capture status must still gate ASC.
        success: () => priorStepsSucceeded,
      };
      const env = {
        MANUAL_UPLOAD_RUN: String(evaluate(finalize.env?.MANUAL_UPLOAD_RUN, context)),
        FULL_SET_CAPTURED: String(evaluate(finalize.env?.FULL_SET_CAPTURED, context)),
      };
      for (const name of [
        'Set up Ruby + fastlane',
        'Decode App Store Connect API key',
        'Upload screenshots to App Store Connect',
      ]) {
        const step = finalize.steps?.find((candidate) => candidate.name === name);
        expect(step, name).toBeDefined();
        expect(evaluate(step?.if, { ...context, env }), name).toBe(expected);
      }
    },
  );

  it('keeps the pinned simulator-app cache key in ios-build', () => {
    // scripts/mobile-ci-env-parity.test.ts asserts the shape of this line; it must
    // not migrate into the composite action with the rest of the shard body.
    // Optional react-native.config.js must invalidate the cache when introduced.
    const cacheKeyLine = source.split('\n').find((line) => line.includes('screenshot-sim-app-v1-${{ hashFiles('));
    expect(cacheKeyLine).toBe(
      "        run: echo \"key=${{ runner.os }}-${{ runner.arch }}-screenshot-sim-app-v1-${{ hashFiles('packages/mobile/app.config.ts', 'packages/mobile/react-native.config.js', 'packages/mobile/plugins/**', 'packages/mobile/modules/**', 'packages/mobile/locales/**', 'packages/mobile/package.json', 'patches/**', 'package.json', 'pnpm-workspace.yaml', 'scripts/mobile-build-sim-app.ts', 'scripts/screenshot-sim.entitlements') }}\" >> \"$GITHUB_OUTPUT\"",
    );
    expect(cacheKeyLine).not.toContain('pnpm-lock.yaml');
    expect(cacheKeyLine).not.toContain('packages/mobile/src/');
    expect(cacheKeyLine).not.toContain('packages/mobile/app/');
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

/**
 * The automatic trigger. A `workflow_run` workflow always runs the copy of itself
 * that sits on the default branch, so none of this can be exercised on a PR
 * branch — these assertions are the pre-merge proof, and the first native deploy
 * on the release train after merge is the live one.
 */
describe('screenshot captures follow the native deploys', () => {
  const workflows = [
    { platform: 'ios', path: IOS_WORKFLOW_PATH, deploy: IOS_DEPLOY_PATH, firstJob: 'setup' },
    { platform: 'android', path: ANDROID_WORKFLOW_PATH, deploy: ANDROID_DEPLOY_PATH, firstJob: 'gate' },
  ] as const;

  it.each(workflows)('$platform subscribes to exactly the deploy workflow it follows', (entry) => {
    const triggers = parseWorkflow(entry.path).on ?? {};
    const workflowRun = triggers.workflow_run as WorkflowRunTrigger | undefined;

    // The subscription is by NAME, so it silently stops firing if the deploy
    // workflow is ever renamed. Read the name out of the deploy file rather than
    // repeating the literal here, so a rename reds this test instead of the
    // screenshots quietly never running again.
    expect(workflowRun?.workflows).toEqual([workflowName(entry.deploy)]);
    expect(workflowRun?.types).toEqual(['completed']);

    // Captures must subscribe to every branch that can build a native candidate.
    const releaseBranches = deployBranches(entry.deploy);
    expect(
      workflowRun?.branches,
      `${entry.path} must follow the branch ${entry.deploy} deploys from (${releaseBranches.join(', ')})`,
    ).toEqual(releaseBranches);

    // Manual dispatch survives alongside it — the only other way to capture, and
    // it is runnable from any branch (no branch filter of its own).
    expect(triggers).toHaveProperty('workflow_dispatch');
  });

  it.each(workflows)('$platform mirrors the release branch as RELEASE_BRANCH', (entry) => {
    // mobile-store-draft.yml's convention: the train lives in one workflow-level
    // env so prose, notices and summaries below read from a single place. `on:`
    // cannot read `env`, so the literal is unavoidably written twice in the file
    // — this is what keeps the two copies (and the deploy workflow) in agreement.
    const releaseBranches = deployBranches(entry.deploy);
    expect(
      parseWorkflow(entry.path).env?.RELEASE_BRANCH,
      `${entry.path} must declare RELEASE_BRANCH: ${releaseBranches.join(', ')}, mirroring its workflow_run filter`,
    ).toBe("${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_branch || github.ref_name }}");
    expect(
      parseWorkflow(STORE_DRAFT_PATH).env?.RELEASE_BRANCH,
      'mobile-store-draft.yml is the convention these mirror; it must name the same train',
    ).toBe("${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_branch || github.ref_name }}");
  });

  it.each(workflows)('$platform has no schedule and no cron', (entry) => {
    const triggers = parseWorkflow(entry.path).on ?? {};
    expect(triggers).not.toHaveProperty('schedule');
    expect(readYaml(entry.path)).not.toContain('cron:');
  });

  it.each(workflows)('$platform ignores a deploy that did not finish green', (entry) => {
    // Verbatim, and on the FIRST job: everything else hangs off it.
    expect(readYaml(entry.path)).toContain(`if: ${CONCLUSION_GUARD}`);
    expect(flatten(parseWorkflow(entry.path).jobs[entry.firstJob].if)).toBe(CONCLUSION_GUARD);
  });

  it.each(workflows)('$platform captures only when a binary actually shipped', (entry) => {
    const source = readYaml(entry.path);
    const workflow = parseWorkflow(entry.path);
    const gateJob = workflow.jobs[entry.firstJob];

    // A green deploy run is not proof: a JS-only push completes it with the
    // build job skipped. The fingerprint tag is the proof.
    expect(source).toContain(`repos/$GITHUB_REPOSITORY/git/matching-refs/tags/fingerprint-${entry.platform}-`);
    expect(gateJob.outputs?.shipped).toBe('${{ steps.shipped.outputs.shipped }}');
    // A dispatch is an explicit request and bypasses the gate.
    expect(source).toContain('capturing without the shipped-binary gate');
    // The skipped run says why, in the place a human looks first.
    expect(source).toContain(
      `No ${entry.platform === 'ios' ? 'iOS' : 'Android'} binary shipped at $SOURCE_SHA ` +
        `(no fingerprint-${entry.platform}-* tag) — nothing to capture." >> "$GITHUB_STEP_SUMMARY"`,
    );
  });

  it.each(workflows)('$platform requires credentials only for record/live captures', (entry) => {
    // Replay uses its synthetic account; record/live require the configured test account.
    const firstJob = parseWorkflow(entry.path).jobs[entry.firstJob];
    const steps = firstJob.steps ?? [];
    const guardStep = steps.find((step) => (step.name ?? '').includes('Require credentials for live recording'));
    expect(
      guardStep,
      `${entry.path}'s ${entry.firstJob} job must guard against missing recording credentials`,
    ).toBeTruthy();
    expect(flatten(guardStep?.if)).toBe(
      entry.platform === 'ios'
        ? "${{ (inputs.fixtures || 'replay') != 'replay' && (inputs.cpp_record_run_id || '') == '' }}"
        : "${{ (inputs.fixtures || 'replay') != 'replay' }}",
    );
    expect(guardStep?.env?.SCREENSHOT_USER_EMAIL).toBe('${{ secrets.SCREENSHOT_USER_EMAIL }}');
    expect(guardStep?.env?.SCREENSHOT_USER_PASSWORD).toBe('${{ secrets.SCREENSHOT_USER_PASSWORD }}');
    expect(guardStep?.run).toContain(
      '::error::SCREENSHOT_USER_EMAIL / SCREENSHOT_USER_PASSWORD are not set; record/live capture requires the dedicated screenshot account',
    );
  });

  it.each(workflows)('$platform checks out the commit that shipped the binary', (entry) => {
    const workflow = parseWorkflow(entry.path);
    expect(checkoutSteps(workflow).length).toBeGreaterThan(0);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const checkouts = (job.steps ?? []).filter((step) => (step.uses ?? '').startsWith('actions/checkout@'));
      for (const step of checkouts) {
        expect(step.with?.ref, `${jobName} must pin the source sha`).toBe(
          entry.platform === 'ios' && jobName.startsWith('cpp-')
            ? '${{ needs.setup.outputs.source_sha }}'
            : SOURCE_SHA_EXPRESSION,
        );
      }
    }
    for (const step of shardActionCheckoutSteps()) {
      expect(step.with?.ref, 'the shard action must pin the source sha').toBe(SOURCE_SHA_EXPRESSION);
    }
  });

  it.each(workflows)(
    '$platform serializes automatic runs and dispatches that write, but not capture-only dispatches',
    (entry) => {
      // A dispatch that can write to the shared target (upload / publish the
      // baseline on iOS, commit_to_main on Android) must join the SAME group
      // as automatic runs — two such writers racing could publish out of
      // order. Replay capture-only dispatches keep their own per-run group so they
      // still run alongside anything else. CPP recordings also serialize because
      // their bootstrap changes the shared screenshot account. Mutation check: collapse the
      // write condition away (every dispatch back to a bare per-run group)
      // and this test must fail.
      const concurrency = parseWorkflow(entry.path).concurrency;
      const writeCondition =
        entry.platform === 'ios'
          ? 'inputs.upload == true || inputs.publish_baseline == true || ' +
            "((inputs.cpp_target || 'none') != 'none' && (inputs.cpp_action == 'create' || inputs.cpp_action == 'stage-assets' || inputs.cpp_action == 'upload' || inputs.cpp_action == 'submit' || inputs.fixtures == 'record'))"
          : 'inputs.commit_to_main == true';
      expect(concurrency?.group).toBe(
        `\${{ (github.event_name == 'workflow_run' || ${writeCondition}) && 'mobile-screenshots-${entry.platform}' || ` +
          `format('mobile-screenshots-${entry.platform}-dispatch-{0}', github.run_id) }}`,
      );
      // Referenced explicitly (both assertions below hold given the exact
      // match above, restated for a legible failure if the exact string ever
      // has to change shape).
      if (entry.platform === 'ios') {
        expect(concurrency?.group).toContain('inputs.upload == true');
        expect(concurrency?.group).toContain('inputs.publish_baseline == true');
        expect(concurrency?.group).toContain("inputs.cpp_action == 'create'");
        expect(concurrency?.group).toContain("inputs.cpp_action == 'stage-assets'");
        expect(concurrency?.group).toContain("inputs.cpp_action == 'upload' || inputs.cpp_action == 'submit'");
      } else {
        expect(concurrency?.group).toContain('inputs.commit_to_main == true');
      }
      // Capture-only dispatches still get a per-run group.
      expect(concurrency?.group).toContain(
        `format('mobile-screenshots-${entry.platform}-dispatch-{0}', github.run_id)`,
      );
      expect(concurrency?.['cancel-in-progress']).toBe(false);
    },
  );

  it.each(workflows)('$platform only reads dispatch inputs in null-tolerant positions', (entry) => {
    expect(nullIntolerantInputReads(readYaml(entry.path))).toEqual([]);
  });

  it('propagates the shipped gate through every iOS job', () => {
    const workflow = parseWorkflow(IOS_WORKFLOW_PATH);
    // ios-finalize is the load-bearing one: its `if` opens with `!cancelled()`,
    // which switches off the implicit needs check, so without an explicit
    // `shipped` clause it would run on an empty artifact set after every
    // JS-only push and red the dimension gate.
    for (const jobName of ['ios-build', 'probe', 'ios-capture', 'ios-finalize']) {
      expect(flatten(workflow.jobs[jobName].if), `${jobName} must require the shipped gate`).toContain(
        "needs.setup.outputs.shipped == 'true'",
      );
    }
    expect(workflow.jobs.setup.outputs?.source_sha).toBe('${{ steps.compute.outputs.source_sha }}');
    expect(readYaml(IOS_WORKFLOW_PATH)).toContain(`SOURCE_SHA: ${SOURCE_SHA_EXPRESSION}`);
  });

  it('probes first on an automatic iOS run and keeps the input on a dispatch', () => {
    const source = readYaml(IOS_WORKFLOW_PATH);
    // `gate` is read from an env var (GATE_INPUT), not interpolated directly via
    // `${{ }}` in the script body — see the "Compute locales, matrix and gate"
    // step's `env:` block, which is where the dispatch default actually lives now.
    expect(source).toContain(`GATE_INPUT: \${{ inputs.gate || 'full' }}`);
    expect(source).toContain('gate="$GATE_INPUT"');
    expect(source).toContain('if [ "$EVENT_NAME" = "workflow_run" ]; then\n            gate=probe');
  });

  it('allows private Android replay captures without changing automatic previews', () => {
    const workflow = parseWorkflow(ANDROID_WORKFLOW_PATH);
    const dispatch = workflow.on?.workflow_dispatch as {
      inputs?: Record<string, { type?: string; default?: unknown }>;
    };
    expect(dispatch.inputs?.share_preview).toEqual({
      description: 'Post captured screenshots to Discord. Disable for private fixture replay validation.',
      type: 'boolean',
      default: true,
    });
    const previewStep = workflow.jobs.android.steps?.find((step) => step.name === 'Post screenshots to Discord');
    expect(flatten(previewStep?.if)).toBe(
      "${{ success() && inputs.flow != 'onboarding' && inputs.fixtures != 'record' && (github.event_name != 'workflow_dispatch' || inputs.share_preview == true) }}",
    );
  });

  it('never commits screenshots from an automatic Android run', () => {
    const workflow = parseWorkflow(ANDROID_WORKFLOW_PATH);
    // COMMIT_RUN opens with the dispatch check, so on `workflow_run` the whole
    // expression short-circuits to `false` before `inputs` (null there) is read.
    // That is the only thing keeping a native deploy from pushing a
    // non-deterministic capture straight onto the live Play listing.
    expect(workflow.jobs.android.env?.COMMIT_RUN).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.commit_to_main }}",
    );
    const commitStep = (workflow.jobs.android.steps ?? []).find((step) => step.name === 'Commit screenshots to main');
    expect(commitStep, 'the Android push-back step must still exist').toBeTruthy();
    expect(commitStep?.if).toContain("env.COMMIT_RUN == 'true'");
  });

  it('gates the whole Android capture on one job instead of fifteen steps', () => {
    const workflow = parseWorkflow(ANDROID_WORKFLOW_PATH);
    expect(Object.keys(workflow.jobs)).toEqual(['gate', 'android']);
    expect(workflow.jobs.android.needs).toBe('gate');
    expect(flatten(workflow.jobs.android.if)).toBe("needs.gate.outputs.shipped == 'true'");
  });
});

describe('iOS CPP capture and publication isolation', () => {
  const workflow = parseWorkflow(IOS_WORKFLOW_PATH);

  it('requires the complete replay matrix before CPP staging, upload or submission', () => {
    const selection = workflow.jobs.setup.steps?.find((step) => step.id === 'cpp');
    expect(workflow.jobs.setup.outputs?.cpp_matrix).toBe('${{ steps.cpp.outputs.matrix }}');
    expect(selection?.env?.CPP_TARGET).toBe("${{ inputs.cpp_target || 'none' }}");
    expect(selection?.run).toContain('CPP runs use cpp_action; default listing upload/baseline flags must be false.');
    expect(selection?.run).toContain('CPP staging/upload/submit requires replay and the full locale/device matrix.');
    expect(selection?.run).toContain('CPP asset staging requires a manual dispatch from main.');
    expect(selection?.run).toContain('A candidate snapshot or recording is scoped to one CPP.');
    expect(
      workflow.jobs['cpp-bootstrap'].steps?.some(
        ({ name }) => name === 'Prepare genuine private demo boards and session',
      ),
    ).toBe(true);
    expect(selection?.run).toContain('cpp_scenario is only valid for record mode.');
  });

  it('keeps CPP captures separate from the default probe, export, and baseline', () => {
    for (const jobName of ['probe', 'ios-capture', 'ios-finalize']) {
      expect(flatten(workflow.jobs[jobName].if), `${jobName} must exclude CPP runs`).toContain(
        "(inputs.cpp_target == null || inputs.cpp_target == 'none')",
      );
    }
    const capture = workflow.jobs['cpp-capture'];
    expect(capture.needs).toEqual(['setup', 'ios-build', 'cpp-bootstrap']);
    expect(flatten(capture.if)).toContain("(inputs.cpp_target || 'none') != 'none'");
    expect(capture.strategy?.matrix).toBe('${{ fromJSON(needs.setup.outputs.cpp_matrix) }}');
    const shard = capture.steps?.find((step) => step.uses === './.github/actions/ios-screenshot-shard');
    expect(shard?.with?.['cpp-target']).toBe('${{ matrix.target }}');
    expect(shard?.with?.['cpp-scenario']).toBe(
      "${{ inputs.cpp_scenario || needs.cpp-bootstrap.outputs.scenario || '' }}",
    );
    expect(shard?.with?.fixtures).toBe("${{ inputs.fixtures || 'replay' }}");
    expect(shard?.with?.['app-cache-key']).toBe('${{ needs.ios-build.outputs.cache-key }}');
  });

  it('can plan without a native build or asset publication', () => {
    const plan = workflow.jobs['cpp-plan'];
    expect(plan.needs).toBe('setup');
    expect(flatten(plan.if)).toContain("inputs.cpp_action == 'plan'");
    expect(flatten(workflow.jobs['ios-build'].if)).toContain("inputs.cpp_action == 'plan'");
    expect(plan.steps?.find((step) => step.uses === './.github/actions/asc-cpp')?.with?.action).toBe('plan');
  });

  it('creates empty drafts only from immutable main in Production without native capture', () => {
    const create = workflow.jobs['cpp-create'];
    expect(create.needs).toBe('setup');
    expect(create.environment).toBe('Production');
    expect(flatten(create.if)).toContain("github.event_name == 'workflow_dispatch'");
    expect(flatten(create.if)).toContain("github.ref == 'refs/heads/main'");
    expect(flatten(create.if)).toContain("inputs.cpp_action == 'create'");
    const sourceGuard = create.steps?.find(({ name }) => name === 'Verify trusted source for empty CPP draft creation');
    expect(sourceGuard?.env?.SOURCE_SHA).toBe('${{ needs.setup.outputs.source_sha }}');
    expect(sourceGuard?.run).toContain('[ "$(git rev-parse HEAD)" = "$SOURCE_SHA" ]');
    const publicationIndex = create.steps?.findIndex(({ uses }) => uses === './.github/actions/asc-cpp') ?? -1;
    const guardIndex = create.steps?.indexOf(sourceGuard!) ?? -1;
    expect(publicationIndex).toBeGreaterThan(guardIndex);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(create.steps?.[publicationIndex].with?.action).toBe('create');
    expect(flatten(workflow.jobs['ios-build'].if)).toContain("inputs.cpp_action == 'create'");
    expect(flatten(workflow.jobs['cpp-capture'].if)).toContain("inputs.cpp_action != 'create'");
    const selection = workflow.jobs.setup.steps?.find(({ id }) => id === 'cpp');
    expect(selection?.run).toContain('CPP draft creation does not accept capture or fixture overrides.');
    expect(selection?.run).toContain('CPP draft creation requires a manual dispatch from main.');
  });

  it('budgets serialized Apple processing for the complete CPP image matrix', () => {
    const manifest = JSON.parse(readFileSync(CPP_MANIFEST_PATH, 'utf8')) as {
      locales: Record<string, string[]>;
      devices: Record<string, string>;
    };
    const storefrontCount = Object.values(manifest.locales).flat().length;
    const imageCount = CPP_TARGETS.reduce((total, target) => {
      const page = readCppPage(target);
      return (
        total +
        Object.keys(manifest.devices).reduce(
          (deviceTotal, device) =>
            deviceTotal + (device.startsWith('ipad-') ? page.recipes.ipad : page.recipes.phone).length,
          0,
        ) *
          storefrontCount
      );
    }, 0);
    expect(imageCount).toBe(720);
    // Three five-second processing polls per image plus 30 minutes for transfer,
    // API preflight, ordering, verification, and submission exceeds the old hour.
    const processingAndTransferMinutes = Math.ceil((imageCount * 3 * 5) / 60) + 30;
    expect(workflow.jobs['cpp-finalize']['timeout-minutes']).toBeGreaterThanOrEqual(processingAndTransferMinutes);
    expect(workflow.jobs['cpp-finalize']['timeout-minutes']).toBeLessThanOrEqual(360);
  });

  it('validates complete exports after capture before Apple publication', () => {
    const finalize = workflow.jobs['cpp-finalize'];
    expect(finalize.needs).toEqual(['setup', 'cpp-capture']);
    expect(flatten(finalize.if)).toBe(
      "${{ needs.cpp-capture.result == 'success' && (inputs.cpp_action == 'stage-assets' || inputs.cpp_action == 'upload' || inputs.cpp_action == 'submit') }}",
    );
    const steps = finalize.steps ?? [];
    const validationIndex = steps.findIndex((step) => step.run?.includes('scripts/assert-cpp-screenshots.ts'));
    const publicationIndex = steps.findIndex((step) => step.uses === './.github/actions/asc-cpp');
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(publicationIndex).toBeGreaterThan(validationIndex);
    const downloads = steps.filter((step) => step.uses === 'actions/download-artifact@v4');
    expect(downloads.map((step) => step.with?.path)).toEqual([
      'app-stores/apple/cpp/kilter',
      'app-stores/apple/cpp/tension',
      'app-stores/apple/cpp/moonboard',
      'app-stores/apple/cpp/spray',
    ]);
    expect(steps.map((step) => step.run ?? '').join('\n')).not.toContain('screenshot:baseline -- publish');
  });
});

describe('ios-screenshot-shard composite action', () => {
  it.each([
    { cppTarget: 'kilter', failedAttempts: 1, expectedExit: 0 },
    { cppTarget: 'kilter', failedAttempts: 2, expectedExit: 1 },
    { cppTarget: 'kilter', failedAttempts: 0, expectedExit: 0 },
    { cppTarget: '', failedAttempts: 1, expectedExit: 0 },
  ])('preserves CPP attempt evidence: $cppTarget / $failedAttempts failures', (scenario) => {
    const action = parse(readYaml(SHARD_ACTION_PATH)) as { runs: { steps: WorkflowStep[] } };
    const capture = action.runs.steps.find((step) => step.id === 'capture');
    if (!capture?.run) throw new Error('Capture script is missing');
    const workspace = mkdtempSync(join(tmpdir(), 'cpp-retry-evidence-'));
    try {
      const mockBin = join(workspace, 'bin');
      mkdirSync(mockBin);
      const counterPath = join(workspace, 'invocations');
      const tracePath = join(workspace, 'debug-directories');
      const outputPath = join(workspace, 'outputs');
      writeFileSync(counterPath, '0\n');
      writeFileSync(tracePath, '');
      writeFileSync(outputPath, '');
      writeFileSync(
        join(mockBin, 'vp'),
        [
          '#!/bin/bash',
          'set -euo pipefail',
          'read -r capture_invocation < "$MOCK_CAPTURE_COUNTER"',
          'capture_invocation=$((capture_invocation + 1))',
          'printf "%s\\n" "$capture_invocation" > "$MOCK_CAPTURE_COUNTER"',
          'printf "%s\\n" "$SCREENSHOT_DEBUG_DIR" >> "$MOCK_CAPTURE_TRACE"',
          'if [ "$capture_invocation" -le "$MOCK_CAPTURE_FAILURES" ]; then',
          '  mkdir -p "$SCREENSHOT_DEBUG_DIR"',
          '  printf "failure-%s\\n" "$capture_invocation" > "$SCREENSHOT_DEBUG_DIR/screenshot-backend.log"',
          '  printf "metro-%s\\n" "$capture_invocation" > "$SCREENSHOT_DEBUG_DIR/metro.log"',
          '  exit 1',
          'fi',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      for (const command of ['xcrun', 'sleep']) {
        writeFileSync(join(mockBin, command), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      }
      const result = spawnSync('bash', ['-c', capture.run], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: mockBin + ':' + process.env.PATH,
          SCREENSHOT_DEBUG_DIR: 'capture-debug',
          GITHUB_OUTPUT: outputPath,
          RUNNER_TEMP: workspace,
          CPP_TARGET: scenario.cppTarget,
          CPP_SCENARIO: '',
          RENDER_MODE_INPUT: '',
          BOARDS_INPUT: '',
          FIXTURES_INPUT: 'record',
          FROZEN_NOW_INPUT: '',
          ATTEMPTS_INPUT: '2',
          SHARD_FLOW: scenario.cppTarget ? 'app-store-cpp' : 'app-store',
          SHARD_LOCALE: 'en-US',
          SHARD_DEVICE_NAME: 'iPhone 16 Pro',
          SHARD_DEVICE_SLUG: 'iphone-16-pro',
          MOCK_CAPTURE_COUNTER: counterPath,
          MOCK_CAPTURE_TRACE: tracePath,
          MOCK_CAPTURE_FAILURES: String(scenario.failedAttempts),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(scenario.expectedExit);
      expect(result.stderr).toBe('');
      const invocations = scenario.failedAttempts === 0 ? 1 : 2;
      const expectedDirectories = Array.from({ length: invocations }, (_, index) =>
        scenario.cppTarget ? 'capture-debug/attempt-' + (index + 1) : 'capture-debug',
      );
      expect(readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual(expectedDirectories);
      const hadFailedCppAttempt = scenario.cppTarget !== '' && scenario.failedAttempts > 0;
      expect(readFileSync(outputPath, 'utf8').includes('had_failed_attempt=true')).toBe(hadFailedCppAttempt);
      if (hadFailedCppAttempt) {
        expect(readFileSync(join(workspace, 'capture-debug/attempt-1/screenshot-backend.log'), 'utf8')).toBe(
          'failure-1\n',
        );
        expect(readFileSync(join(workspace, 'capture-debug/attempt-1/metro.log'), 'utf8')).toBe('metro-1\n');
        if (scenario.failedAttempts === 2) {
          expect(readFileSync(join(workspace, 'capture-debug/attempt-2/screenshot-backend.log'), 'utf8')).toBe(
            'failure-2\n',
          );
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uploads recovered CPP failure evidence without changing the capture result', () => {
    const action = parse(readYaml(SHARD_ACTION_PATH)) as { runs: { steps: WorkflowStep[] } };
    for (const name of ['Collect capture debug artifacts', 'Upload capture debug artifacts']) {
      const step = action.runs.steps.find((candidate) => candidate.name === name);
      expect(step?.if).toContain("steps.capture.outputs.had_failed_attempt == 'true'");
      expect(step?.if).toContain('always()');
      expect(step?.if).toContain('failure()');
      const expression = step!
        .if!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replaceAll('always()', 'true')
        .replaceAll('failure()', 'failed')
        .replaceAll('cancelled()', 'cancelled')
        .replaceAll("inputs.cpp-target != ''", 'isCpp')
        .replaceAll("steps.capture.outputs.had_failed_attempt == 'true'", 'hadFailedAttempt')
        .replaceAll("inputs.debug-artifact-on == 'always'", 'debugAlways');
      for (const [cancelled, isCpp, hadFailedAttempt, expected] of [
        [false, true, false, false],
        [false, true, true, true],
        [true, true, false, true],
        [true, false, false, false],
      ]) {
        expect(
          runInNewContext(expression, { failed: false, cancelled, isCpp, hadFailedAttempt, debugAlways: false }),
        ).toBe(expected);
      }
    }
    const upload = action.runs.steps.find((step) => step.name === 'Upload capture debug artifacts');
    expect(upload?.with?.path).toBe('capture-debug/**');
    expect(upload?.with?.['retention-days']).toBe(14);
    const collect = action.runs.steps.find((step) => step.name === 'Collect capture debug artifacts');
    expect(collect?.run).toContain('timeout: 15000, killSignal: "SIGKILL"');
  });

  it('explicitly disables replay for live diagnostics', () => {
    const action = parse(readYaml(SHARD_ACTION_PATH)) as { runs: { steps: WorkflowStep[] } };
    const capture = action.runs.steps.find((step) => step.run?.includes('attempts="$ATTEMPTS_INPUT"'));
    expect(capture?.run).toMatch(/else\s+retarget\+=\(--fixtures off\)/);
  });

  it('exists and takes default-listing, CPP, and gate shard inputs', () => {
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
      'fixtures',
      'fixture-snapshot',
      'frozen-now',
      'app-cache-key',
      'cpp-target',
      'cpp-scenario',
      'attempts',
      'upload-captures',
      'debug-artifact-on',
    ]);
    expect(action.runs.using).toBe('composite');
  });

  it('defaults the gate-only inputs to what the capture has always done', () => {
    // mobile-e2e-gate.yml's smoke reuses this action and overrides these three.
    // The capture workflow passes none of them, so the defaults ARE its behaviour.
    const action = parse(readYaml(SHARD_ACTION_PATH)) as { inputs: Record<string, { default?: string }> };
    expect(action.inputs.attempts.default).toBe('2');
    expect(action.inputs['upload-captures'].default).toBe('true');
    expect(action.inputs['debug-artifact-on'].default).toBe('failure');
    const captureWorkflow = readYaml(IOS_WORKFLOW_PATH);
    for (const gateOnlyInput of ['attempts:', 'upload-captures:', 'debug-artifact-on:']) {
      expect(captureWorkflow).not.toContain(gateOnlyInput);
    }
  });

  it('restores the prebuilt app read-only and uploads a per-shard artifact', () => {
    const source = readYaml(SHARD_ACTION_PATH);
    expect(source).toContain('fail-on-cache-miss: true');
    expect(source).toContain('key: ${{ inputs.app-cache-key }}');
    expect(source).toContain('name: ios-screenshots-${{ github.job }}-${{ inputs.locale }}-${{ inputs.device-slug }}');
    // The capture body must stay byte-identical between the probe and the fan-out.
    expect(source).toContain('vp run mobile:screenshots -- \\');
    expect(source).toContain('attempts="$ATTEMPTS_INPUT"');
  });

  it('keeps pre-Maestro failure evidence using the actual OS temporary directory', () => {
    const source = readYaml(SHARD_ACTION_PATH);
    const action = parse(source) as { runs: { steps: WorkflowStep[] } };
    const capture = action.runs.steps.find((step) => step.run?.includes('attempts="$ATTEMPTS_INPUT"'));
    expect(capture?.env?.SCREENSHOT_DEBUG_DIR).toBe('capture-debug');
    expect(source).toContain('require("node:os").tmpdir()');
    expect(source).toContain('boardsesh-screenshot-metro.log boardsesh-screenshot-ready.log');
    expect(source).not.toContain('cp /tmp/boardsesh-screenshot-backend.log');
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
    // Tool setup is part of the optional attachment, too: a setup failure must
    // not turn a successfully created App Store draft into a failed job.
    for (const step of steps.filter(
      (step) => step.uses === 'voidzero-dev/setup-vp@v1' || step.name === 'Install screenshot tooling',
    )) {
      expect((step as WorkflowStep & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true);
    }
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
