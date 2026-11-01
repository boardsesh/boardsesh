/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ALLOW_NATIVE_ON_MAIN_LABEL, deriveCheckConclusion } from './mobile-ota-compat-check';

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

// Signing and automatic tester publication use main only.
const releaseBranch = 'main';
const retiredNativeEnvironment = ['Native', 'Release'].join(' ');
const retiredAndroidPrereleaseName = ['Boardsesh', 'Next'].join(' ');
const dispatchGate = "github.ref == 'refs/heads/main'";
const releaseBranchExpression =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_branch || github.ref_name }}";

describe('native release workflow contracts', () => {
  const ios = workflow('ios-testflight-rn.yml');
  const android = workflow('android-apk-rn.yml');
  const draft = workflow('mobile-store-draft.yml');
  const otaCheck = workflow('mobile-ota-check.yml');
  const productionOta = workflow('mobile-ota-production.yml');

  it('keeps main production publication failure visible and retires train-only notification jobs', () => {
    const jobs = parse(productionOta).jobs;
    expect(jobs.publish['continue-on-error']).toBeUndefined();
    expect(jobs).not.toHaveProperty('notify-train-deployment');
  });

  it.each([
    ['ios-testflight-rn.yml', ios],
    ['android-apk-rn.yml', android],
    ['mobile-store-draft.yml', draft],
  ])('%s is valid YAML', (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  // Main source pushes are screened before signing; only a validated stamp builds automatically.
  it('builds on main only and resolves a validated stamped source before signing', () => {
    for (const source of [ios, android]) {
      expect(parse(source).on.push.branches).toEqual([releaseBranch]);
      expect(source).toContain(dispatchGate);
      expect(source).toContain('scripts/mobile-native-release.ts source');
      expect(source).toContain("if: steps.source.outputs.eligible == 'true'");
      expect(source).toContain('ref: ${{ steps.source.outputs.source_sha }}');
      expect(source).toContain('source_sha: ${{ steps.source.outputs.source_sha }}');
      expect(source).not.toContain('refs/heads/release/next');
      expect(source).toContain('environment: Production');
      expect(source).not.toContain(`environment: ${retiredNativeEnvironment}`);
    }
    expect(ios.match(/environment: Production/g)).toHaveLength(1);
    // gate (maps key), play-review (Play credential), build-and-release, record-candidate.
    expect(android.match(/environment: Production/g)).toHaveLength(4);
  });

  // With the sync pushing the train after every main merge, the default
  // concurrency would silently replace whatever was pending in these groups (a
  // main hotfix dispatch, a beta or production promotion, the sync bot's retry)
  // with the next train push.
  it('queues every run in the native upload groups instead of replacing pending ones', () => {
    for (const [name, group] of [
      ['ios-testflight-rn.yml', 'ios-testflight-rn'],
      ['android-apk-rn.yml', 'android-apk-rn'],
      ['mobile-store-android-beta.yml', 'android-apk-rn'],
      ['mobile-store-android-production.yml', 'android-apk-rn'],
    ] as const) {
      expect(parse(workflow(name)).concurrency, name).toEqual({ group, 'cancel-in-progress': false, queue: 'max' });
    }
  });

  it('gives iOS the same force_native dispatch input as Android', () => {
    const forceNative = (source: string) =>
      (parse(source) as { on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } } }).on
        .workflow_dispatch.inputs['force_native'];
    for (const source of [ios, android]) {
      expect(forceNative(source)).toMatchObject({ type: 'boolean', required: false, default: true });
      expect(String(forceNative(source)?.['description'])).toMatch(/^Force a native build even if this fingerprint/);
    }
  });

  // Main stages alongside backend builds and promotes only after deployment.
  it('stages main OTAs through production deployment and has no immediate branch publish trigger', () => {
    const triggers = parse(productionOta).on;
    expect(triggers).not.toHaveProperty('push');
    expect(triggers.workflow_call.inputs).toHaveProperty('stage_for_production_deploy');
    const productionDeploy = parse(workflow('production-deploy.yml'));
    expect(productionDeploy.on.push.branches).toEqual(['main']);
    expect(productionDeploy.jobs['stage-mobile-ota'].uses).toBe('./.github/workflows/mobile-ota-production.yml');
    expect(productionOta).not.toContain('steps.train_guard');
    expect(productionOta).not.toContain('mobile-release-train-policy');
    expect(parse(productionOta).jobs.publish.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('keeps fingerprint gates and tags store uploads only after success', () => {
    expect(ios).toContain('fingerprint-ios-');
    expect(ios).toContain("steps.testflight_upload.outcome == 'success'");
    expect(android).toContain('fingerprint-android-');
    expect(android).toContain("steps.play_upload.outcome == 'success'");
    expect(
      stepsOfJob(android, 'build-and-release').find((step) =>
        step.run?.includes('bundle exec fastlane android upload_beta'),
      )?.['continue-on-error'],
    ).not.toBe(true);
    expect(ios).toContain('authenticated_push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"');
    expect(android).toContain(
      'authenticated_push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"',
    );
    for (const source of [ios, android]) {
      expect(source).toContain('actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
      expect(source).not.toContain('https://x-access-token:${GH_APP_TOKEN}@github.com');
      expect(source).toContain('assert_missing_or_exact');
      expect(source).toContain('if [ -n "$fingerprint_target" ]; then');
      expect(source).toContain('publish_build_tag');
      expect(source).toContain('Preserved immutable $fingerprint_tag');
      expect(source).not.toContain('assert_missing_or_exact "$fingerprint_tag"');
      expect(source).toContain('A concurrent retry already published');
      expect(source).toContain('trap clear_git_auth EXIT');
      expect(source).toContain('git config --local --unset-all http.https://github.com/.extraheader');
      expect(source.indexOf('if [ -n "$fingerprint_target" ]; then')).toBeLessThan(
        source.indexOf('authenticated_push --atomic "$remote"'),
      );
    }
    expect(ios).toContain('Mint repository App token for protected release tags');
    expect(android).toContain('Mint repository App token for protected release tags');
  });

  it('publishes the exact Android beta after Play internal accepts it', () => {
    expect(android).toContain('Stage Android APK GitHub prerelease');
    expect(android).toContain('Publish verified Android APK prerelease');
    expect(android).toContain('softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65');
    expect(android).toContain('boardsesh-android-beta-arm64-v8a.apk');
    expect(android).toContain('Boardsesh Android Beta');
    expect(android).toContain('Signed Android beta from `${{ github.ref_name }}`');
    expect(android).not.toContain(retiredAndroidPrereleaseName);
    expect(android).toContain('token: ${{ steps.tag_token.outputs.token }}');
    expect(android).toContain('tag_name: ${{ env.ANDROID_BUILD_TAG }}');
    expect(android).toContain('target_commitish: ${{ needs.gate.outputs.source_sha }}');
    expect(android).not.toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(android).toContain(`if [ "$GITHUB_REF" != 'refs/heads/main' ]`);
    expect(android).toContain('fail_on_unmatched_files: true');
    expect(android).toContain('draft: true');
    expect(android).toContain('prerelease: true');
    expect(android).toContain('make_latest: false');
    expect(android).toContain('--draft=false');
    expect(android).toContain('do not install this APK over a Play-installed copy');
    expect(android).toContain('APK SHA-256: `${{ env.ANDROID_APK_SHA256 }}`');
    expect(android).toContain('actions/upload-artifact@v4');
    expect(android).toContain('actions/download-artifact@v4');
    expect(android).toContain('name: boardsesh-rn-android-${{ github.run_number }}');
    expect(android).not.toContain('outputs.apk_artifact_name');
    const uploads = stepsOfJob(android, 'build-and-release').filter(
      (step) => typeof step.run === 'string' && step.run.includes('bundle exec fastlane android upload_beta'),
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.['working-directory']).toBe('fastlane');
    expect(uploads[0]?.env?.ANDROID_VERSION_CODE).toBe('${{ steps.version_code.outputs.value }}');
    expect(parse(android).name).toBe('Android Play Internal Deploy (React Native)');
    expect(android).toContain('Require Play upload credentials');
    expect(android).toContain('rerun failed jobs to repair tags or the APK prerelease');
    expect(android.indexOf('Require Play upload credentials')).toBeLessThan(android.indexOf('Expo prebuild'));
    expect(android.indexOf('Upload AAB to Play internal and open beta tracks')).toBeLessThan(
      android.indexOf('Tag the uploaded Android build and fingerprint'),
    );
    expect(android.indexOf('Tag the uploaded Android build and fingerprint')).toBeLessThan(
      android.indexOf('Stage Android APK GitHub prerelease'),
    );
  });

  it('prepares drafts with trusted tooling and exact uploaded binary sources', () => {
    expect(parse(draft).env.RELEASE_BRANCH).toBe(releaseBranchExpression);
    expect(draft).toContain('Store drafts require main.');
    expect(draft).toContain('scripts/mobile-native-build-source.ts --run-id "$NATIVE_SOURCE_RUN_ID"');
    expect(draft).toContain('ref: ${{ github.workflow_sha }}');
    expect(draft).toContain('CANDIDATE_ANCESTOR_OF="$RELEASE_HEAD_SHA"');
    expect(draft).toContain('CANDIDATE_ANCESTOR_OF="$EXPECTED_RELEASE_SHA"');
    expect(draft.match(/scripts\/mobile-store-submit-target\.ts/g)).toHaveLength(2);
    expect(draft).toContain("Verify tagged builds match the release branch's native state");
    expect(draft).toContain('uploaded_build=$build_fp');
    expect(draft).toContain('build_tag_fingerprint=$tagged_fp');
    expect(draft).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(draft).toContain('compare_platform ios ios-build "$EXPECTED_IOS_TAG"');
    expect(draft).toContain('compare_platform android android-build "$EXPECTED_ANDROID_TAG"');
    expect(draft.match(/assert_ref "tags\/\$EXPECTED_IOS_TAG" "\$EXPECTED_IOS_SHA"/g)).toHaveLength(2);
    expect(draft.match(/assert_ref "tags\/\$EXPECTED_ANDROID_TAG" "\$EXPECTED_ANDROID_SHA"/g)).toHaveLength(2);
    expect(draft).not.toContain('assert_ref "heads/');
    expect(draft).toContain('Take listing text from the selected binary source');
    expect(draft).toContain('git checkout "$RELEASE_SOURCE_SHA" -- fastlane/metadata');
    expect(draft.match(/environment: Production/g)).toHaveLength(3);
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    expect(fastfile).toContain('ENV.fetch("IOS_BUILD_NUMBER")');
    expect(fastfile).toContain('ENV.fetch("ANDROID_VERSION_CODE")');
  });

  it('names the source branch in every draft run title', () => {
    expect(parse(draft)['run-name']).toBe(`Mobile Store Draft (${releaseBranchExpression})`);
  });

  it('drafts follow each completed native deploy instead of a schedule', () => {
    const triggers = parse(draft)['on'] as Record<string, unknown>;
    expect(triggers).not.toHaveProperty('schedule');
    expect(draft).not.toContain('cron:');
    const workflowRun = triggers.workflow_run as { workflows: string[]; types: string[]; branches: string[] };
    expect(workflowRun.workflows).toEqual([
      'iOS TestFlight Deploy (React Native)',
      'Android Play Internal Deploy (React Native)',
    ]);
    expect(workflowRun.types).toEqual(['completed']);
    // The deploy workflows' push branches: only the train builds on push.
    expect(workflowRun.branches).toEqual([releaseBranch]);
    expect(workflowRun.branches).toEqual(parse(ios).on.push.branches);
    expect(workflowRun.branches).toEqual(parse(android).on.push.branches);
    expect(triggers).toHaveProperty('workflow_dispatch');
    // No enable flag: the candidate gates are the protection, and the lanes only make drafts.
    expect(draft).not.toContain('ENABLE_STORE_DRAFT_SUBMISSION');
    expect(draft).not.toMatch(/vars\.[A-Z_]*ENABLE/);
    // A failed or cancelled deploy has nothing to draft.
    expect(draft).toContain(
      "if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'",
    );
    // The names the trigger subscribes to must keep matching the deploy workflows.
    expect(ios).toMatch(/^name: iOS TestFlight Deploy \(React Native\)$/m);
    expect(android).toMatch(/^name: Android Play Internal Deploy \(React Native\)$/m);
  });

  it('attaches the tagged build to the draft rather than relying on deliver/supply side effects', () => {
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    // deliver only selects a build inside submit_for_review, which the lane never calls,
    // so the lane waits for THIS build to finish processing and attaches it itself.
    expect(fastfile).toContain('FastlaneCore::BuildWatcher.wait_for_build_processing_to_be_complete(');
    expect(fastfile).toContain('build_version: build_number,');
    expect(fastfile).toContain('select_latest: false');
    expect(fastfile).toContain('edit_version.select_build(build_id: build.id)');
    // The Android draft is the exact internal release copied to production as a
    // draft, in one edit committed with ERROR_IF_IN_REVIEW (supply's promote
    // committed with the API default, which cancels a release in review).
    const androidDraftLane = fastfile.slice(fastfile.lastIndexOf('lane :draft_submission do'));
    expect(androidDraftLane).toContain('scripts", "mobile-store-android-draft.ts"');
    expect(androidDraftLane).not.toContain('upload_to_play_store');
    const androidDraft = readFileSync('scripts/mobile-store-android-draft.ts', 'utf8');
    expect(androidDraft).toContain("status: 'draft'");
    expect(androidDraft).toContain('await validateAndCommit(request, editPath);');
    expect(fastfile).not.toMatch(/track: "production",\n\s+version_code:/);
    // deliver renames the editable version to the one it drafts, so the lane
    // refuses before deliver runs when a different version is still open.
    const draftLane = fastfile.slice(fastfile.indexOf('lane :draft_submission do'));
    expect(draftLane.indexOf('other_open_app_store_versions(')).toBeGreaterThan(-1);
    expect(draftLane.indexOf('other_open_app_store_versions(')).toBeLessThan(draftLane.indexOf('upload_to_app_store('));
    // The processing wait (45 min) must fit inside the ios job's timeout.
    expect(draft).toMatch(/^  ios:\n(?:.*\n){1,12}?\s+timeout-minutes: 60$/m);
  });

  it('pushes listing text on main and synchronously onto the exact successful draft', () => {
    const metadata = parse(workflow('mobile-store-metadata.yml'));
    expect(metadata.on.push.branches).toEqual(['main']);
    expect(metadata.on.push.paths).toContain('fastlane/metadata/**');
    const iosSteps = parse(draft).jobs.ios.steps as Array<{
      name?: string;
      if?: string;
      run?: string;
      env?: Record<string, string>;
    }>;
    const listing = iosSteps.find((step) => step.name === "Push listing text and What's New onto the drafted version");
    expect(listing?.if).toBe("steps.draft.outcome == 'success' && !inputs.release_sha");
    expect(listing?.env?.RELEASE_VERSION).toBe('${{ needs.release-candidate.outputs.version }}');
    expect(listing?.run).toContain('bundle exec fastlane ios metadata "expected_version:$RELEASE_VERSION"');
    expect(draft).not.toContain('gh workflow run mobile-store-metadata.yml');
  });

  it('keeps the established main anchor on Production', () => {
    const anchor = workflow('mobile-auto-version-bump.yml');
    expect(anchor).toContain('environment: Production');
    expect(anchor).not.toContain(`environment: ${retiredNativeEnvironment}`);
  });

  it('describes the current-fleet OTA gap on native-change PRs', () => {
    expect(otaCheck).toContain(
      'Moves the native fingerprint — current fleet misses main OTAs until replacement binaries ship',
    );
  });

  // Compatibility compares against the PR's actual base and reports native
  // changes without blocking either automatic native release branch.
  it('allows native PRs into main without a waiver while preserving fork protections', () => {
    // Existing callers may still pass the legacy waiver option; it is not required.
    for (const baseBranch of ['main']) {
      expect(deriveCheckConclusion({ overall: 'native-change-required', baseBranch, allowNativeOnMain: false })).toBe(
        'neutral',
      );
    }
    expect(ALLOW_NATIVE_ON_MAIN_LABEL).toBe('allow-native-on-main');

    // The baseline is the PR's base branch, resolved from the PR lookup.
    expect(otaCheck).toContain("core.setOutput('ref', pr?.base?.ref ?? 'main');");
    expect(otaCheck).toContain('git worktree add "$RUNNER_TEMP/base-baseline" "origin/$BASE_REF"');
    expect(otaCheck).toContain('--base-branch "$BASE_REF"');
    expect(otaCheck).toContain('--allow-native-on-main');

    // The workflow publishes the script's informational verdict.
    expect(otaCheck).toContain('conclusion: process.env.CHECK_CONCLUSION,');
    expect(otaCheck).not.toContain("conclusion: 'neutral',");

    // The train owns its own pushes; the native workflows react to them.
    const triggers = parse(otaCheck)['on'] as {
      push?: { 'branches-ignore'?: string[] };
      pull_request?: { types?: string[] };
    };
    expect(triggers.push?.['branches-ignore']).toEqual(['main']);

    // The verdict depends on the base branch and the labels, and neither
    // remediation the failure prints (retarget, or add the waiver label) produces
    // a push — so without these event types the red check-run would be stuck.
    // `edited` is what a base change raises.
    expect(triggers.pull_request?.types).toEqual(['opened', 'reopened', 'edited', 'labeled', 'unlabeled']);
    // A fork PR's token is read-only, so the comment/label/check-run writes would
    // 403; the push path never covered forks either.
    expect(otaCheck).toContain('github.event.pull_request.head.repo.fork != true');
    // Dependabot's PRs get a read-only token even though the head branch is
    // same-repo, so the comment / label / check-run writes would 403 and the
    // weekly lockfile PR would show a failed workflow and no verdict.
    expect(otaCheck).toContain("github.actor != 'dependabot[bot]'");
    // `edited` also fires on every title/body edit, and this job is a ~20-minute
    // two-install resolve. Only a base change can move the verdict, and that is
    // what `changes.base` reports.
    expect(otaCheck).toContain("github.event.action != 'edited' || github.event.changes.base != null");
    // The PR's head commit, not the synthetic merge ref: a check-run posted on
    // the merge sha is invisible on the PR, and the merge tree is not what the
    // author pushed.
    expect(otaCheck).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(otaCheck).toContain('head_sha: process.env.HEAD_SHA,');
    // Both event paths must serialize in ONE lane, or a retarget can race the
    // push whose stale verdict it is trying to replace.
    const parsedCheck = parse(otaCheck) as {
      concurrency?: unknown;
      jobs: { 'ota-check': { concurrency: { group: string; 'cancel-in-progress': boolean } } };
    };
    // Workflow concurrency runs even when its only job is skipped. Keeping the
    // lane on the job prevents a title/body edit from cancelling the push.
    expect(parsedCheck.concurrency).toBeUndefined();
    expect(parsedCheck.jobs['ota-check'].concurrency).toEqual({
      group: 'mobile-ota-check-${{ github.head_ref || github.ref_name }}',
      'cancel-in-progress': true,
    });
  });

  // The PR CI gate diffs head against the branch it will merge into. Diffing a
  // train PR against main would report the train's existing native change as if
  // this PR added it, and rebuild the world on every train PR.
  it('diffs the PR native gate against the PR base branch', () => {
    const gate = readFileSync('.github/actions/mobile-native-gate/action.yml', 'utf8');
    expect(gate).toContain('base-ref:');
    expect(gate).toContain("BASE_REF: ${{ inputs.base-ref || 'main' }}");
    expect(gate).toContain('git fetch --no-tags --depth=1 origin "$BASE_REF"');
    for (const caller of ['ios-rn-ci.yml', 'android-pr-rn.yml']) {
      expect(workflow(caller), `${caller} must pass its PR base ref to the gate`).toContain(
        'base-ref: ${{ github.base_ref }}',
      );
    }
  });

  // The ABI check reads the built binary — the only place an embedded-framework
  // version skew is visible, since a prebuilt xcframework's undefined symbols
  // are resolved for the first time by dyld at launch. See
  // scripts/mobile-framework-abi-check.ts.
  //
  // Asserted against the PARSED workflow, not raw-string offsets: `vp run
  // mobile:upload-dsyms` and `restore-keys` both appear in prose comments long
  // before (or instead of) the steps they name, so an indexOf/toContain version
  // of these checks reports on the comments rather than the pipeline.
  type WorkflowStep = {
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
    'working-directory'?: string;
    'continue-on-error'?: boolean;
    // Step-level env. Parsed rather than string-matched so an assertion about
    // which values a step can actually see reads that step's own block.
    env?: Record<string, unknown>;
    // `if` is the step's condition. Parsed rather than string-matched so an
    // assertion about a step's gate can't accidentally read a neighbour's.
    if?: string;
  };
  const jobsOf = (source: string): Record<string, { steps?: WorkflowStep[] }> =>
    (parse(source) as { jobs: Record<string, { steps?: WorkflowStep[] }> }).jobs;

  const stepsOf = (source: string): WorkflowStep[] => Object.values(jobsOf(source)).flatMap((job) => job.steps ?? []);

  // Ordering is only meaningful WITHIN one job — steps in different jobs have
  // no relative order at all. Scope the comparison to a named job so splitting
  // the archive and the export apart fails this test instead of quietly making
  // it compare nothing.
  const stepsOfJob = (source: string, jobName: string): WorkflowStep[] => {
    const job = jobsOf(source)[jobName];
    expect(job, `workflow has no job named "${jobName}"`).toBeDefined();
    return job.steps ?? [];
  };

  const runsCommand = (script: string, command: string): boolean =>
    script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => line.includes(command));

  const indexOfStepRunning = (steps: readonly WorkflowStep[], command: string): number =>
    steps.findIndex((step) => typeof step.run === 'string' && runsCommand(step.run, command));

  // expo-updates launches whichever update has the newest commitTime, and a binary
  // stamps its embedded bundle at BUILD time — so an OTA published from a later
  // commit *while* a ~50-minute build was running is already older than the binary
  // that build produces, and never applies despite a matching fingerprint (#4992 vs
  // 2.4.0 build 10, 2026-09-01). Each native build therefore republishes once its
  // store upload lands: a publish strictly after the build necessarily outranks it.
  it('republishes the production OTA after each store upload, so the new binary can receive it', () => {
    for (const [source, job, platform, uploadGate] of [
      [ios, 'build-and-upload', 'ios', "steps.testflight_upload.outcome == 'success'"],
      [android, 'record-candidate', 'android', "env.FINGERPRINT_ANDROID != ''"],
    ] as const) {
      const steps = stepsOfJob(source, job);
      const dispatch = indexOfStepRunning(steps, 'gh workflow run mobile-ota-production.yml');
      expect(dispatch, `${job} must dispatch the OTA republish`).toBeGreaterThanOrEqual(0);

      // After the fingerprint tag: the tag is what makes the next push skip the
      // native build, so republishing before it could target a fingerprint that
      // never actually shipped.
      const tagStep = indexOfStepRunning(steps, 'fingerprint_tag=');
      expect(tagStep).toBeGreaterThanOrEqual(0);
      expect(tagStep).toBeLessThan(dispatch);

      // Never republish for a build that failed to reach the store.
      expect(String(steps[dispatch]?.if ?? '')).toContain(uploadGate);

      const run = String(steps[dispatch]?.run ?? '');
      // Current trusted main tooling republishes only if its runtime still matches.
      expect(run).toContain('--ref main');
      expect(run).not.toContain('--ref "${{ github.ref_name }}"');
      expect(run).toContain(`-f platform=${platform}`);
      expect(run).toContain('-f expect_fingerprint=');
    }
  });

  // `gh workflow run -f <unknown>=` fails with a 422 that only surfaces at runtime,
  // after the store upload — far too late. Pin the two ends together.
  it('passes only inputs the production OTA workflow actually declares', () => {
    const declared = new Set(
      Object.keys(
        (parse(productionOta) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } }).on
          .workflow_dispatch.inputs,
      ),
    );
    expect(declared).toContain('expect_fingerprint');

    for (const [source, job] of [
      [ios, 'build-and-upload'],
      [android, 'record-candidate'],
    ] as const) {
      const steps = stepsOfJob(source, job);
      const run = String(steps[indexOfStepRunning(steps, 'gh workflow run mobile-ota-production.yml')]?.run ?? '');
      const passed = [...run.matchAll(/-f\s+([a-z_]+)=/g)].map(([, key]) => key);
      expect(passed.length).toBeGreaterThan(0);
      for (const key of passed) {
        expect(declared, `mobile-ota-production.yml declares no workflow_dispatch input "${key}"`).toContain(key);
      }
    }
  });

  // The manifest a native build embeds carries `commitTime`, and expo-updates
  // launches whichever update has the newest one. The expo-updates patch makes
  // that HEAD's committer date rather than build time (#5021), but its resolver
  // falls back to build time whenever git is unreadable — which silently restores
  // the 2026-09-01 stranding. So the artifact is asserted, on the runner, while
  // there is still time to fail without shipping.
  it('checks the embedded commitTime after bundling and before the store upload', () => {
    // Both platforms upload through Fastlane after their artifact checks.
    const indexOfUpload = (steps: readonly WorkflowStep[], marker: string): number =>
      steps.findIndex(
        (step) =>
          (typeof step.run === 'string' && runsCommand(step.run, marker)) || (step.uses?.startsWith(marker) ?? false),
      );

    for (const [source, job, bundleStep, uploadStep, searchRoot] of [
      [ios, 'build-and-upload', 'xcodebuild archive', 'bundle exec fastlane ios testflight', '"$ARCHIVE_PATH"'],
      [
        android,
        'build-and-release',
        './gradlew assembleRelease',
        'bundle exec fastlane android upload_beta',
        'packages/mobile/android/app/build',
      ],
    ] as const) {
      const steps = stepsOfJob(source, job);
      const commitTimeCheck = indexOfStepRunning(steps, 'vp run check:mobile-embedded-commit-time');
      expect(commitTimeCheck, `${job} must check the embedded commitTime`).toBeGreaterThanOrEqual(0);

      // After the bundle exists: earlier and there is no app.manifest to read,
      // which this check reports as a failure rather than a pass.
      const bundle = indexOfStepRunning(steps, bundleStep);
      expect(bundle, `${job} must run ${bundleStep}`).toBeGreaterThanOrEqual(0);
      expect(bundle).toBeLessThan(commitTimeCheck);

      // Before anything leaves the runner: past the upload the binary is in the
      // store and the fingerprint tag makes the next push skip the native build,
      // so a later failure is unfixable without a manual rebuild.
      const upload = indexOfUpload(steps, uploadStep);
      expect(upload, `${job} must upload via ${uploadStep}`).toBeGreaterThanOrEqual(0);
      expect(commitTimeCheck).toBeLessThan(upload);

      // A --search-root pointing at the wrong tree fails closed, but it fails
      // EVERY build. Pin each side to the directory its own build writes.
      expect(String(steps[commitTimeCheck]?.run ?? '')).toContain(`--search-root ${searchRoot}`);
    }
  });

  // Google Play scored the app at Obfuscation 1% because minifyEnabled had never
  // been true. The fix is a gradle property, but a property the generated
  // build.gradle does not read leaves the build green and the APK readable — so
  // the release lane asserts R8's own mapping, and it has to do so while failing
  // is still free.
  it('proves R8 obfuscated the release before it can reach Play', () => {
    const steps = stepsOfJob(android, 'build-and-release');

    // Both obfuscation steps run the same command, so anchoring on the command
    // alone would let the APK-side check be deleted while the AAB one kept the
    // assertion green. Distinguish them by the flag only one of them passes.
    const isObfuscationCheck = (step: WorkflowStep) =>
      typeof step.run === 'string' && step.run.includes('vp run check:mobile-android-obfuscation');
    const check = steps.findIndex((step) => isObfuscationCheck(step) && !String(step.run).includes('--aab'));
    expect(check, 'the release job must check the R8 mapping after the APK build').toBeGreaterThanOrEqual(0);

    // After R8 has run: earlier and there is no mapping.txt, which the check
    // reports as a failure rather than a pass.
    const build = indexOfStepRunning(steps, './gradlew assembleRelease');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(check);

    // Before the bundle leaves the runner. Past this the binary is in the store
    // and the fingerprint tag makes the next push skip the native build.
    const upload = steps.findIndex(
      (step) => typeof step.run === 'string' && step.run.includes('bundle exec fastlane android upload_beta'),
    );
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(upload);

    // The AAB is what Play actually receives, and it carries its own copy of the
    // mapping. Assert that copy matches the one Sentry gets, after the bundle is
    // built and still before the upload.
    const aabCheck = steps.findIndex(
      (step) => isObfuscationCheck(step) && String(step.run).includes('--aab packages/mobile/android'),
    );
    expect(aabCheck, 'the release job must verify the AAB carries the same mapping').toBeGreaterThanOrEqual(0);
    const bundle = indexOfStepRunning(steps, './gradlew bundleRelease');
    expect(bundle).toBeGreaterThanOrEqual(0);
    expect(bundle).toBeLessThan(aabCheck);
    expect(aabCheck).toBeLessThan(upload);
  });

  // The PR lane builds the same minified release APK, which is where a keep-rule
  // regression is cheap to find — on main it has already cost a native build.
  it('checks obfuscation on the PR lane too', () => {
    const steps = stepsOfJob(workflow('android-pr-rn.yml'), 'build-apk');

    const check = indexOfStepRunning(steps, 'vp run check:mobile-android-obfuscation');
    expect(check, 'the PR build must check the R8 mapping').toBeGreaterThanOrEqual(0);

    const build = indexOfStepRunning(steps, './gradlew assembleRelease');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(check);
  });

  it('checks the embedded framework ABI before anything leaves the runner', () => {
    const ci = workflow('ios-rn-ci.yml');
    for (const [source, job] of [
      [ios, 'build-and-upload'],
      [ci, 'build-and-test'],
    ] as const) {
      expect(indexOfStepRunning(stepsOfJob(source, job), 'vp run mobile:abi-check')).toBeGreaterThanOrEqual(0);
    }

    // Ordering is the whole point for a store release: after the export the
    // binary is already in TestFlight and the fingerprint tag makes the next
    // push skip the native build, so a later failure is unfixable without a
    // manual rebuild. A reorder is exactly what this assertion catches.
    const releaseSteps = stepsOfJob(ios, 'build-and-upload');
    const abiCheck = indexOfStepRunning(releaseSteps, 'vp run mobile:abi-check');
    for (const later of ['bundle exec fastlane ios testflight', 'vp run mobile:upload-dsyms']) {
      const step = indexOfStepRunning(releaseSteps, later);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(abiCheck).toBeLessThan(step);
    }

    // The PR job needs a deterministic product path for the check to point at.
    expect(ci).toContain('-derivedDataPath packages/mobile/ios/build');
  });

  // A prefix fallback restores the previous Pods tree on exactly the runs where
  // the dependencies moved, and there is no committed Podfile.lock to reconcile
  // it against. ios-rn-ci additionally reached into the release workflow's
  // bucket, so a PR could build against a release build's Pods.
  it('never restores a stale Pods tree from a prefix key', () => {
    for (const source of [ios, workflow('ios-rn-ci.yml')]) {
      const podsCaches = stepsOf(source).filter(
        (step) =>
          step.uses?.startsWith('actions/cache') && String(step.with?.path).includes('packages/mobile/ios/Pods'),
      );
      expect(podsCaches).toHaveLength(1);
      for (const cache of podsCaches) expect(cache.with).not.toHaveProperty('restore-keys');
    }
  });

  it('releases Android to production only from main, as a plan unless applied', () => {
    const source = workflow('mobile-store-android-production.yml');
    const parsed = parse(source) as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown; required?: boolean }> } };
      concurrency: { group: string };
      jobs: Record<string, { if?: string; environment?: string }>;
    };
    expect(Object.keys(parsed.on)).toEqual(['workflow_dispatch']);
    expect(parsed.on.workflow_dispatch.inputs['apply']?.default).toBe(false);
    expect(parsed.on.workflow_dispatch.inputs['rollout_percent']?.default).toBe('100');
    // Shares the native upload lock with the internal/beta uploads and the beta promotion.
    expect(parsed.concurrency.group).toBe('android-apk-rn');
    expect(parsed.jobs['release']?.if).toBe("github.ref == 'refs/heads/main'");
    expect(parsed.jobs['release']?.environment).toBe('Production');
    const submit = stepsOfJob(source, 'release').find(
      (step) => step.name === 'Plan or submit the exact production build',
    );
    // Inputs reach the shell through env, never interpolated into the script.
    expect(submit?.run).not.toContain('${{');
    expect(submit?.env).toMatchObject({
      VERSION_CODE: '${{ inputs.version_code }}',
      ROLLOUT_PERCENT: '${{ inputs.rollout_percent }}',
      APPLY: '${{ inputs.apply }}',
    });
  });

  it('drafts Android on production only while the build has not been released there', () => {
    const steps = stepsOfJob(draft, 'android');
    const guard = steps.findIndex((step) => step.id === 'guard');
    const prepare = steps.findIndex((step) => step.id === 'draft');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(prepare);
    expect(steps[guard]?.run).toContain('scripts/mobile-store-android-draft-guard.ts');
    // A guard that cannot read Play leaves the production track untouched.
    expect(steps[guard]?.['continue-on-error']).toBe(true);
    expect(steps[prepare]?.if).toBe("steps.guard.outcome == 'success' && steps.guard.outputs.skip == 'false'");
    // A checkout that predates the guard fails closed instead of drafting blind.
    expect(steps[guard]?.run).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(steps[guard]?.run).not.toContain('skip=false');
    // So does one whose draft lane still commits through supply, which cancels a review.
    expect(steps[guard]?.run).toContain('if [ ! -f scripts/mobile-store-android-draft.ts ]; then');
  });

  // On 2026-10-18 a store-draft run read 2.6.0 as a draft four seconds before a
  // production release committed it, then wrote a second draft on top (#6524).
  // Every Play production writer holds the lock, queued so a pending release is
  // never replaced by the next member's run.
  it('serializes every Play production writer on one queued lock', () => {
    type Jobs = { jobs: Record<string, { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } }> };
    const members = [
      (parse(workflow('mobile-store-android-production.yml')) as Jobs).jobs['release'],
      (parse(draft) as Jobs).jobs['android'],
      (parse(workflow('mobile-store-submit.yml')) as Jobs).jobs['submit-android'],
      (parse(workflow('mobile-store-metadata.yml')) as Jobs).jobs['android'],
    ];
    for (const job of members) {
      expect(job?.concurrency).toEqual({ group: 'play-production-track', 'cancel-in-progress': false, queue: 'max' });
    }
  });
});

// ─── The decisions, executed ────────────────────────────────────────────────
// Execute the shared gate CLI with store evidence stubbed at the process boundary.
// Exact tag/version checks and approval refusal must survive workflow rewiring.

type ExecutedStep = { id?: string; name?: string; run?: string; env?: Record<string, unknown> };

function workflowStep(source: string, jobName: string, predicate: (step: ExecutedStep) => boolean): ExecutedStep {
  const job = (parse(source) as { jobs: Record<string, { steps?: ExecutedStep[] }> }).jobs[jobName];
  const step = job?.steps?.find(predicate);
  if (!step?.run) throw new Error(`no matching step with a run block in job ${jobName}`);
  return step;
}

type ScriptRun = { status: number | null; stdout: string; outputs: Record<string, string>; calls: string[] };

/** Runs a step's script the way GitHub does (`bash -eo pipefail`), in a throwaway directory. */
function runStepScript(
  script: string,
  options: { env: Record<string, string>; stubs: Record<string, string>; files?: Record<string, string> },
): ScriptRun {
  const sandbox = mkdtempSync(join(tmpdir(), 'release-step-'));
  try {
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    for (const [command, body] of Object.entries(options.stubs)) {
      writeFileSync(join(bin, command), body);
      chmodSync(join(bin, command), 0o755);
    }
    for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
      const filePath = join(sandbox, relativePath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, contents);
    }
    const outputPath = join(sandbox, 'github-output');
    const callLog = join(sandbox, 'calls');
    writeFileSync(outputPath, '');
    writeFileSync(callLog, '');
    const scriptPath = join(sandbox, 'step.sh');
    writeFileSync(scriptPath, script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        // A non-interactive bash still sources $BASH_ENV; keep the run hermetic.
        BASH_ENV: undefined,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: sandbox,
        GITHUB_OUTPUT: outputPath,
        STUB_CALL_LOG: callLog,
        REAL_NODE: process.execPath,
        ...options.env,
      },
    });
    // The last write of a key wins, as it does on GitHub.
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      outputs,
      calls: readFileSync(callLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('native build gates, executed', { timeout: 30_000 }, () => {
  const fingerprint = 'ab12cd34'.repeat(5);
  const sourceSha = 'c'.repeat(40);
  const version = readFileSync('packages/mobile/app.config.ts', 'utf8').match(/version:\s*['"]([^'"]+)['"]/)![1]!;
  const scriptPath = resolve('scripts/mobile-native-release.ts');
  const platforms = [
    { platform: 'ios', file: 'ios-testflight-rn.yml' },
    { platform: 'android', file: 'android-apk-rn.yml' },
  ] as const;
  const gitStub = `#!/usr/bin/env bash
if [ "\${STUB_GIT_FAIL:-}" = true ]; then exit 128; fi
case "$1" in
  show) printf '%s\\n' 'ordinary main source' ;;
  rev-parse) printf '%s\\n' "$NATIVE_SOURCE_SHA" ;;
  log) : ;;
  tag) printf '%s\\n' "\${STUB_TAGS:-}" ;;
  for-each-ref)
    while IFS= read -r tag; do
      [ -n "$tag" ] && printf '%s %s\\n' "$tag" "$NATIVE_SOURCE_SHA"
    done <<< "\${STUB_TAGS:-}" ;;
esac
exit 0
`;
  const ghStub = `#!/usr/bin/env bash
printf '%s\\n' '[{"workflow_runs":[]}]'
`;
  function runGate(
    platform: 'ios' | 'android',
    options: { tags?: string[]; forced?: boolean; resolved?: string; gitFails?: boolean } = {},
  ) {
    return runStepScript('"$REAL_NODE" --experimental-strip-types "$NATIVE_SCRIPT_PATH" gate', {
      stubs: { git: gitStub, gh: ghStub },
      env: {
        NATIVE_SCRIPT_PATH: scriptPath,
        NATIVE_PLATFORM: platform,
        NATIVE_SOURCE_SHA: sourceSha,
        RESOLVED_FINGERPRINT: options.resolved ?? fingerprint,
        GITHUB_EVENT_NAME: options.forced ? 'workflow_dispatch' : 'push',
        FORCE_NATIVE: String(Boolean(options.forced)),
        GITHUB_RUN_ID: '11',
        GITHUB_REPOSITORY: 'boardsesh/boardsesh',
        STUB_TAGS: (options.tags ?? []).join('\n'),
        STUB_GIT_FAIL: String(Boolean(options.gitFails)),
      },
    });
  }
  it.each(platforms)('$platform passes its pinned source and force flag into the shared gate', ({ platform, file }) => {
    const step = workflowStep(workflow(file), 'gate', (candidate) => candidate.id === 'fp');
    expect(step.env).toMatchObject({
      NATIVE_PLATFORM: platform,
      NATIVE_SOURCE_SHA: '${{ steps.source.outputs.source_sha }}',
      FORCE_NATIVE: '${{ inputs.force_native }}',
      GH_TOKEN: '${{ github.token }}',
    });
    expect(step.run).toContain(
      'node --experimental-strip-types "$RUNNER_TEMP/native-release-tools/scripts/mobile-native-release.ts" gate',
    );
    expect(step.env?.NATIVE_RELEASE_ROOT).toBe('${{ github.workspace }}');
    expect(step.run).not.toContain('${{');
  });
  it.each(platforms)(
    '$platform builds an untagged source and skips only the exact successful build',
    ({ platform }) => {
      expect(runGate(platform).outputs.should_build).toBe('true');
      const tag = `build-${platform}-v${version}-9-${fingerprint.slice(0, 12)}`;
      expect(runGate(platform, { tags: [tag] }).outputs.should_build).toBe('false');
      expect(runGate(platform, { tags: [tag], forced: true }).outputs.should_build).toBe('true');
      expect(runGate(platform, { tags: [tag.replace(version, '0.0.1')] }).outputs.should_build).toBe('true');
    },
  );
  it.each(platforms)(
    '$platform fails closed on unresolved fingerprints and unreadable tag evidence',
    ({ platform }) => {
      expect(runGate(platform, { resolved: '' }).status).not.toBe(0);
      expect(runGate(platform, { gitFails: true }).status).not.toBe(0);
    },
  );
  it('refuses every new iOS upload after Apple accepted its marketing version, even forced', () => {
    for (const forced of [false, true])
      expect(runGate('ios', { tags: [`release/ios-v${version}-${fingerprint.slice(0, 12)}`], forced }).status).not.toBe(
        0,
      );
    expect(
      runGate('android', { tags: [`release/ios-v${version}-${fingerprint.slice(0, 12)}`] }).outputs.should_build,
    ).toBe('true');
  });
  it('recognizes an exact historical upload after later public approval without rebuilding it', () => {
    const tags = [
      `release/ios-v${version}-${fingerprint.slice(0, 12)}`,
      `build-ios-v${version}-8-${fingerprint.slice(0, 12)}`,
    ];
    expect(runGate('ios', { tags }).outputs.should_build).toBe('false');
    expect(runGate('ios', { tags, forced: true }).status).not.toBe(0);
  });
});

describe('Play review pre-check before the Android build', () => {
  const android = parse(workflow('android-apk-rn.yml')) as {
    jobs: Record<
      string,
      {
        needs?: string | string[];
        if?: string;
        environment?: string;
        'continue-on-error'?: boolean;
        outputs?: Record<string, string>;
        steps?: ExecutedStep[];
      }
    >;
  };

  it('asks Play, GET-only, only when the gate wants a build', () => {
    const job = android.jobs['play-review'];
    expect(job?.needs).toBe('gate');
    expect(job?.if).toBe("needs.gate.outputs.should_build == 'true'");
    expect(job?.environment).toBe('Production');
    // Only Play review holds the build; an errored check leaves its output empty.
    expect(job?.outputs?.['pending']).toBe('${{ steps.review.outputs.pending }}');
    const check = job?.steps?.find((step) => step.id === 'review');
    expect(check?.run).toBe('vp exec node --import tsx scripts/mobile-store-android-review-pending.ts');
    expect(check?.env).toEqual({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}' });
    // The deferral says who picks the build up again.
    const notice = job?.steps?.find((step) => String(step.run).includes('Play review deferred this native stamp'));
    expect(notice?.run).toContain('coordinator retries it without another version bump');
  });

  // Fails open: only an explicit pending=true holds the build, so a review check
  // that errored (or never ran) still builds, and the upload's own guard decides.
  // A pre-check that fails (checkout or install, never the script) must neither
  // red the run, which would stop the draft and screenshot workflows that follow
  // only a green run, nor strand an upload that went through: every job after
  // the build decides on the build's own result, never on the implicit
  // success() that also covers play-review.
  it('never lets a failed pre-check red the run or strand an uploaded build', () => {
    expect(android.jobs['play-review']?.['continue-on-error']).toBe(true);
    const downstream = Object.entries(android.jobs).filter(([, job]) =>
      [job.needs ?? []].flat().includes('build-and-release'),
    );
    expect(downstream.map(([name]) => name)).toEqual(['record-candidate']);
    for (const [name, job] of downstream) {
      const condition = String(job.if).replace(/\s+/g, ' ').trim();
      expect(condition, name).toMatch(/^\$\{\{ !cancelled\(\) && needs\.build-and-release\.result == 'success'/);
    }
  });

  // The next train version's upload replaces Play internal, and the merge-back
  // submission releases only what internal still serves. So the build waits, the
  // same way and with the same retry, until production carries the merge-back.
  it('has no release-branch hold after public submission becomes explicit', () => {
    expect(android.jobs['play-review']?.outputs?.pending).toBe('${{ steps.review.outputs.pending }}');
    expect(JSON.stringify(android)).not.toContain('merge_back');
    expect(JSON.stringify(android)).not.toContain('mobile-store-android-merge-back-hold');
  });

  it('holds the build only on an explicit pending review', () => {
    const build = android.jobs['build-and-release'];
    expect(build?.needs).toEqual(['gate', 'play-review']);
    const condition = String(build?.if).replace(/\s+/g, ' ').trim();
    expect(condition).toBe(
      "!cancelled() && needs.gate.result == 'success' && needs.gate.outputs.should_build == 'true' && needs.play-review.outputs.pending != 'true'",
    );
  });
});
