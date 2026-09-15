/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The screenshot runs gate themselves twice over: a `workflow_run` trigger plus a
 * shipped-binary check decide whether a native deploy is worth capturing at all,
 * and on iOS one probe shard then decides whether the other eleven macOS runners
 * are worth spending. Both decisions live entirely in trigger blocks and job
 * `needs`/`if` expressions, which nothing else type-checks and which cannot be
 * exercised from a branch — a `workflow_run` workflow always runs the copy of
 * itself that sits on the default branch. A single wrong `result ==` there either
 * burns twelve runners after every JS-only push or silently stops capturing
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
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  /** A single dependency is written as a scalar in these files; several as a list. */
  needs?: string | string[];
  if?: string;
  environment?: string;
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

/**
 * The branch a deploy workflow actually builds store candidates from — read out
 * of its own `push.branches` rather than repeated as a literal here. #5477 moved
 * that from `main` to `release/next`; the next rename (or a second branch added
 * to the list) must red this test, naming the deploy workflow, instead of
 * silently leaving the screenshot captures subscribed to a branch that no longer
 * deploys anything.
 */
function deployBranch(deployPath: string): string {
  const push = (parseWorkflow(deployPath).on ?? {}).push as PushTrigger | undefined;
  const branches = push?.branches ?? [];
  expect(
    branches,
    `${deployPath} must declare exactly one push branch — the release train the screenshot ` +
      'workflows follow. Update both mobile-screenshots-*.yml (the workflow_run `branches:` ' +
      'filter and the RELEASE_BRANCH env) if this deliberately changed.',
  ).toHaveLength(1);
  return branches[0];
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
    expect(Object.keys(setup.outputs ?? {})).toEqual([
      'ios_locales',
      'ios_matrix_full',
      'ios_matrix_without_probe',
      'gate',
      'source_sha',
      'shipped',
    ]);
    // upload and probe are contradictory: an upload needs all 12 shards.
    expect(source).toContain('upload=true cannot be combined with gate=probe');
    // A narrowed / onboarding / uploading run has no full-set baseline to compare against.
    expect(source).toContain('if [ -n "$locales" ] || [ "$flow" = "onboarding" ] || [ "$upload" = "true" ]; then');
    // The exclude is derived from devices[0], not hand-copied, and a guard fails
    // the step if devices[0] ever stops being the iPhone 16 Pro Max the probe
    // shard actually shoots.
    expect(source).toContain(`jq -r '.[0].slug')" != "iphone-16-pro-max" ]; then`);
    expect(source).toContain(`probe_exclude=$(printf '%s' "$devices" | jq -c '[{locale:"en-US", device: .[0]}]')`);
  });

  it('runs the probe on gate=probe only, off the shared shard action', () => {
    const probe = workflow.jobs.probe;
    expect(probe.needs).toEqual(['setup', 'ios-build']);
    expect(flatten(probe.if)).toBe("needs.setup.outputs.gate == 'probe' && needs.setup.outputs.shipped == 'true'");
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

  it('captures the full 12-shard matrix when the probe crashed or was skipped, and the 11-shard one only on probe success', () => {
    // Pins the #5326 fix: gate=probe computes an exclude assuming the probe
    // itself will capture and upload its shard, but a probe that FAILS never
    // does that — so the matrix, not just the `if:`, must fall back to the
    // full 12-shard set on failure (and on `skipped`, the gate=full path,
    // which never asked for an exclude at all). Only an actually-successful
    // probe gets the 11-shard exclude. Mutation check: hardcode this to
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

    // Native store candidates are built from the release train, not main, so the
    // branch filter is read out of the deploy workflow's own `push.branches`
    // instead of being repeated here. A future rename of the train reds this with
    // the deploy workflow named, rather than leaving the captures subscribed to a
    // branch that no longer builds anything.
    const releaseBranch = deployBranch(entry.deploy);
    expect(
      workflowRun?.branches,
      `${entry.path} must follow the branch ${entry.deploy} deploys from (${releaseBranch})`,
    ).toEqual([releaseBranch]);

    // Manual dispatch survives alongside it — the only other way to capture, and
    // it is runnable from any branch (no branch filter of its own).
    expect(triggers).toHaveProperty('workflow_dispatch');
  });

  it.each(workflows)('$platform mirrors the release branch as RELEASE_BRANCH', (entry) => {
    // mobile-store-draft.yml's convention: the train lives in one workflow-level
    // env so prose, notices and summaries below read from a single place. `on:`
    // cannot read `env`, so the literal is unavoidably written twice in the file
    // — this is what keeps the two copies (and the deploy workflow) in agreement.
    const releaseBranch = deployBranch(entry.deploy);
    expect(
      parseWorkflow(entry.path).env?.RELEASE_BRANCH,
      `${entry.path} must declare RELEASE_BRANCH: ${releaseBranch}, mirroring its workflow_run filter`,
    ).toBe(releaseBranch);
    expect(
      parseWorkflow(STORE_DRAFT_PATH).env?.RELEASE_BRANCH,
      'mobile-store-draft.yml is the convention these mirror; it must name the same train',
    ).toBe(releaseBranch);
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

  it.each(workflows)('$platform checks out the commit that shipped the binary', (entry) => {
    const steps = [...checkoutSteps(parseWorkflow(entry.path)), ...shardActionCheckoutSteps()];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(
        step.with?.ref,
        `every checkout in ${entry.path} (or the shard composite action) must pin the source sha`,
      ).toBe(SOURCE_SHA_EXPRESSION);
    }
  });

  it.each(workflows)('$platform serializes automatic runs and never cancels one', (entry) => {
    const concurrency = parseWorkflow(entry.path).concurrency;
    // One shared group for automatic runs (GitHub coalesces the queue), and a
    // per-run group for dispatches so a hand-run upload is never cancelled.
    expect(concurrency?.group).toBe(
      `\${{ github.event_name == 'workflow_run' && 'mobile-screenshots-${entry.platform}' || ` +
        `format('mobile-screenshots-${entry.platform}-dispatch-{0}', github.run_id) }}`,
    );
    expect(concurrency?.['cancel-in-progress']).toBe(false);
  });

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
