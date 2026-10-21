/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ALLOW_NATIVE_ON_MAIN_LABEL, deriveCheckConclusion } from './mobile-ota-compat-check';

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

// The branch native store candidates are cut from. Assembled rather than
// inlined so a bare `toContain('release/next')` elsewhere in the file can't be
// satisfied by this constant's own definition.
const releaseBranch = ['release', 'next'].join('/');
// #4991 retired these two along with the previous train and they stay retired:
// the restored train reuses the `Production` environment and the existing
// "Boardsesh Android Beta" prerelease name.
const retiredNativeEnvironment = ['Native', 'Release'].join(' ');
const retiredAndroidPrereleaseName = ['Boardsesh', 'Next'].join(' ');

// Only the two trusted release refs may receive signing credentials.
const dispatchGate = `github.ref == 'refs/heads/main' || github.ref == 'refs/heads/${releaseBranch}'`;
const releaseBranchExpression =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_branch || github.ref_name }}";
const TRAIN_BASELINE_STEP = 'Resolve active release train against pinned origin/main';
const TRAIN_GUARD_STEP = 'Skip platforms whose runtimeVersion the train does not own';

describe('native release workflow contracts', () => {
  const ios = workflow('ios-testflight-rn.yml');
  const android = workflow('android-apk-rn.yml');
  const draft = workflow('mobile-store-draft.yml');
  const otaCheck = workflow('mobile-ota-check.yml');
  const productionOta = workflow('mobile-ota-production.yml');

  it('keeps train notification failures separate from successful OTA publications', () => {
    const jobs = (
      parse(productionOta) as {
        jobs: Record<
          string,
          {
            'continue-on-error'?: boolean;
            steps: Array<{ name?: string; if?: string; run?: string }>;
          }
        >;
      }
    ).jobs;
    expect(jobs.publish['continue-on-error']).toBeUndefined();
    expect(jobs['notify-train-deployment']['continue-on-error']).toBe(true);
    expect(
      jobs['notify-train-deployment'].steps.find((step) => step.name === 'Surface train notification failure'),
    ).toMatchObject({ if: 'failure()', run: expect.stringContaining('::warning::') });
  });

  it.each([
    ['ios-testflight-rn.yml', ios],
    ['android-apk-rn.yml', android],
    ['mobile-store-draft.yml', draft],
  ])('%s is valid YAML', (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  // release-train-sync.yml keeps release/next level with main, so the train is
  // the one place a push builds. main keeps manual dispatch for hotfixes.
  it('builds on push only from the release train, and on dispatch from either trusted branch', () => {
    for (const source of [ios, android]) {
      expect(parse(source).on.push.branches).toEqual([releaseBranch]);
      expect(source).toContain(dispatchGate);
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

  // The amendment to the train design: release/next publishes production OTAs
  // too, so testers on the train binary are not stuck on the JS it was built
  // with. main keeps publishing for the store fleet, but since #5823 it does so
  // through production-deploy.yml, which calls this workflow to stage the OTA
  // alongside the service builds, so main is no longer a push trigger here.
  it('publishes production OTAs from both main and the release train', () => {
    const triggers = parse(productionOta)['on'] as {
      push?: { branches?: string[] };
      workflow_call?: { inputs?: Record<string, unknown> };
    };
    expect(triggers.push?.branches).toEqual([releaseBranch]);
    expect(triggers.workflow_call?.inputs).toHaveProperty('stage_for_production_deploy');
    const productionDeploy = parse(workflow('production-deploy.yml')) as {
      on: { push?: { branches?: string[] } };
      jobs: Record<string, { uses?: string }>;
    };
    expect(productionDeploy.on.push?.branches).toEqual(['main']);
    expect(productionDeploy.jobs['stage-mobile-ota']?.uses).toBe('./.github/workflows/mobile-ota-production.yml');
  });

  // xprem serves the newest commitTime FOR A GIVEN runtimeVersion. While the
  // train's fingerprint is one the store fleet runs, a publish from the train
  // would be handed to the whole fleet — so the train only publishes once a
  // native change of its own has moved it off both main's runtimeVersion and its
  // merge-base's. Main alone is not enough: a late run on an older train commit
  // still carries the fleet's fingerprint after main has moved on.
  it('refuses to publish a train OTA onto a runtimeVersion the train does not own', () => {
    const steps = stepsOfJob(productionOta, 'publish');
    const guard = steps.find((step) => step.name === TRAIN_GUARD_STEP);
    expect(guard, 'the production OTA workflow must carry the train fingerprint guard').toBeDefined();
    expect(String(guard?.if ?? '')).toContain(`github.ref == 'refs/heads/${releaseBranch}'`);

    // Defaults precede all fingerprint/store evidence. main's native state is
    // not a proxy for what the public stores are currently offering.
    const run = String(guard?.run ?? '');
    expect(run).toContain("echo 'publish_ios=false'");
    expect(run).toContain("echo 'publish_android=false'");
    expect(run.indexOf('publish_ios=false')).toBeLessThan(run.indexOf('runtimeversion:resolve'));
    expect(run.indexOf('publish_ios=false')).toBeLessThan(run.indexOf('TRAIN_SUPERSEDED'));
    expect(run).toContain('scripts/mobile-release-train-policy.ts');
    expect(guard?.env).toMatchObject({
      TRAIN_SUPERSEDED: '${{ steps.train_baselines.outputs.superseded }}',
      TRAIN_ACTIVE: '${{ steps.train_baselines.outputs.train_active }}',
      LIVE_STORE_RUNTIMES: '${{ steps.live_store.outputs.live_runtimes }}',
    });
    // The evidence must come from the artifact. A job output carrying it is
    // dropped whenever it contains a masked value, which left every train
    // publish reading an empty string.
    const liveResolver = parse(workflow('mobile-live-store-runtimes.yml')) as {
      on: { workflow_call?: { outputs?: unknown } };
      jobs: Record<string, { outputs?: unknown }>;
    };
    expect(liveResolver.on.workflow_call?.outputs).toBeUndefined();
    expect(liveResolver.jobs.resolve?.outputs).toBeUndefined();
    expect(productionOta).not.toContain('needs.live-store-runtimes.outputs');
    const downloadIndex = steps.findIndex((step) => step.name === 'Download public store runtimes');
    expect(steps[downloadIndex]?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/);
    expect(steps[downloadIndex]?.with?.name).toBe('live-store-runtimes');
    const readIndex = steps.findIndex((step) => step.id === 'live_store');
    expect(downloadIndex).toBeLessThan(readIndex);
    expect(readIndex).toBeLessThan(steps.findIndex((step) => step.name === TRAIN_GUARD_STEP));
    for (const stepName of ['Publish iOS OTA', 'Publish Android OTA']) {
      expect(steps.find((step) => step.name === stepName)?.env?.OTA_LIVE_STORE_RUNTIMES).toBe(
        '${{ steps.live_store.outputs.live_runtimes }}',
      );
    }
    const baselineIndex = steps.findIndex((step) => step.name === TRAIN_BASELINE_STEP);
    const baseline = steps[baselineIndex];
    expect(baseline?.id).toBe('train_baselines');
    expect(baselineIndex).toBeLessThan(steps.findIndex((step) => step.name === TRAIN_GUARD_STEP));
    const baselineRun = String(baseline?.run ?? '');
    expect(baselineRun).toContain('git fetch origin main release/next');
    expect(baselineRun).toContain('--main-sha "$main_sha" --train-sha "$train_sha"');
    expect(baselineRun).not.toContain('git worktree');
    expect(baselineRun).toContain(
      'scripts/push-run-superseded.ts --workflow .github/workflows/mobile-ota-production.yml',
    );
    expect(parse(productionOta).on.push.paths).toBeUndefined();
    const liveJob = parse(productionOta).jobs['live-store-runtimes'];
    expect(liveJob.uses).toBe('./.github/workflows/mobile-live-store-runtimes.yml');

    // Both publishes consume the verdict.
    for (const [stepName, output] of [
      ['Publish iOS OTA', 'publish_ios'],
      ['Publish Android OTA', 'publish_android'],
    ] as const) {
      const publish = steps.find((step) => step.name === stepName);
      expect(String(publish?.if ?? ''), `${stepName} must honour the train guard`).toContain(
        `steps.train_guard.outputs.${output} != 'false'`,
      );
    }
  });

  // A platform the guard withheld was never attempted, so its `skipped` outcome
  // is the intended result. If the summary counted it as requested, every train
  // push before the first native change — and every main→release/next sync —
  // would red a run that did exactly what it was supposed to do.
  it('does not fail the run for a platform the train guard withheld', () => {
    const summary = stepsOfJob(productionOta, 'publish').find(
      (step) => step.name === 'Summarize platform publish results',
    );
    expect(summary, 'the production OTA workflow must summarize platform results').toBeDefined();

    // The verdict has to reach the step: a summary that never reads the guard
    // outputs cannot tell "withheld" from "failed", whatever its shell says.
    const env = String(JSON.stringify(summary?.env ?? {}));
    for (const output of ['publish_ios', 'publish_android']) {
      expect(env, `the summary must read steps.train_guard.outputs.${output}`).toContain(
        `steps.train_guard.outputs.${output}`,
      );
    }

    const run = String(summary?.run ?? '');
    expect(run).toContain('if [ "$TRAIN_PUBLISH_IOS" = false ]');
    expect(run).toContain('if [ "$TRAIN_PUBLISH_ANDROID" = false ]');
    expect(run).toContain('ios_requested=false');
    expect(run).toContain('android_requested=false');

    // Withholding every requested platform must stop the step with BOTH outputs
    // false. Falling through would compute all_success=true — nothing left to
    // contradict it — and the served-manifest verify, which runs on that claim,
    // would then hunt for an update that was never published and fail the run.
    // That is exactly the shape a single-platform republish from the train takes
    // when the guard withholds its one platform.
    const bothWithheld = run.match(
      // The parsed block scalar is dedented, so the closing `fi` sits at column 0.
      /if \[ "\$ios_requested" = false \] && \[ "\$android_requested" = false \]; then([\s\S]*?)\nfi/,
    )?.[1];
    expect(bothWithheld, 'the summary must stop when every requested platform was withheld').toBeTruthy();
    // The capture is non-greedy, so a nested if/fi inside this branch would end
    // the match early and leave every assertion below inspecting a fragment —
    // passing on the wrong block. Fail loudly instead if that day comes.
    expect(bothWithheld, 'the both-withheld branch gained a nested if; widen this match').not.toMatch(/\bif \[/);
    expect(bothWithheld).toContain('echo "all_success=false"');
    expect(bothWithheld).toContain('echo "any_success=false"');
    expect(bothWithheld).toContain('exit 0');

    // A withheld platform published nothing and the build that asked for it is
    // waiting on an update it will never get: green, but never silent.
    expect(run).toContain('::warning::iOS published nothing');
    expect(run).toContain('::warning::Android published nothing');
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
    expect(android).toContain('target_commitish: ${{ github.sha }}');
    expect(android).not.toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(android).toContain(`if [ "$GITHUB_REF" != 'refs/heads/main' ]`);
    expect(android).toContain(`[ "$GITHUB_REF" != 'refs/heads/${releaseBranch}' ]; then`);
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

  it('prepares drafts from the trusted source branch and matching uploaded builds', () => {
    expect(parse(draft).env.RELEASE_BRANCH).toBe(releaseBranchExpression);
    expect(draft).toContain('main|release/next) ;;');
    expect(draft.indexOf('Store drafts require main or release/next')).toBeLessThan(
      draft.indexOf('Checkout pinned release-branch tooling'),
    );
    expect(draft).toContain('Resolve the release branch');
    expect(draft).not.toContain('exists=false');
    expect(draft).toContain('Select exact uploaded builds for the release-branch version');
    expect(draft).toContain('version_pattern="${version//./\\\\.}"');
    expect(draft.match(/UPLOADED_ONLY=true/g)).toHaveLength(2);
    expect(draft).not.toContain('function highest(platform)');
    expect(draft).toContain("Verify tagged builds match the release branch's native state");
    expect(draft).toContain('Recheck the release branch after fingerprint comparison');
    expect(draft).toContain(
      'git fetch --force --tags origin "+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}"',
    );
    expect(draft).toContain('if [ "$(git rev-parse "origin/${RELEASE_BRANCH}")" != "$EXPECTED_RELEASE_SHA" ]');
    // Every branch read uses the selected source, rather than pinning main.
    expect(draft).not.toContain('heads/main');
    expect(draft).toContain('are no longer the unique highest tags');
    expect(draft).toContain('uploaded_build=$build_fp');
    expect(draft).toContain('build_tag_fingerprint=$tagged_fp');
    expect(draft).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(draft).toContain('Missing GOOGLE_MAPS_API_KEY; Android fingerprint verification');
    expect(draft).not.toContain('boardsesh-release-monitor-placeholder');
    expect(draft).toContain('compare_platform ios ios-build "$EXPECTED_IOS_TAG"');
    expect(draft).toContain('compare_platform android android-build "$EXPECTED_ANDROID_TAG"');
    expect(draft).toContain('vp install --frozen-lockfile --ignore-scripts');
    expect(draft.match(/ref: \$\{\{ needs\.release-candidate\.outputs\.sha \}\}/g)).toHaveLength(2);
    expect(draft.match(/Recheck the pinned release branch and uploaded builds/g)).toHaveLength(2);
    expect(draft.match(/assert_ref "heads\/\$\{RELEASE_BRANCH\}" "\$EXPECTED_RELEASE_SHA"/g)).toHaveLength(2);
    expect(draft.match(/assert_ref "tags\/\$EXPECTED_IOS_TAG" "\$EXPECTED_IOS_SHA"/g)).toHaveLength(2);
    expect(draft.match(/assert_ref "tags\/\$EXPECTED_ANDROID_TAG" "\$EXPECTED_ANDROID_SHA"/g)).toHaveLength(2);
    expect(draft).toContain('IOS_BUILD_NUMBER');
    expect(draft).toContain('ANDROID_VERSION_CODE');
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    expect(fastfile).toContain('ENV.fetch("IOS_BUILD_NUMBER")');
    expect(fastfile).toContain('ENV.fetch("ANDROID_VERSION_CODE")');
    expect(fastfile).not.toContain('version_code = latest_uploaded_version_code(json_key_data)');
    expect(draft.match(/environment: Production/g)).toHaveLength(3);
    expect(draft).not.toContain(`environment: ${retiredNativeEnvironment}`);
  });

  // release-train-sync.yml waits for an in-progress draft of the train before it
  // moves the branch, and a workflow_run run lists the default branch as its
  // head_branch, so the title is the only place the source branch shows.
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

  it('pushes listing text automatically, and again once the draft has a version to write onto', () => {
    const metadata = workflow('mobile-store-metadata.yml');
    const metadataTriggers = parse(metadata)['on'] as { push?: { branches: string[]; paths: string[] } };
    // main only: release-train-sync.yml carries the notes to the train, and two
    // refs pushing listings could disturb a review the merge-back started.
    expect(metadataTriggers.push?.branches).toEqual(['main']);
    expect(metadataTriggers.push?.paths).toContain('fastlane/metadata/**');
    // deliver skips iOS when no version is editable, so the draft workflow re-runs it for iOS
    // right after creating the version — and only when that draft step actually succeeded.
    // The train's ref, not main's: the metadata lane reads `version` from
    // app.config.ts on whatever it checks out, and it must land on the drafted
    // version, which is the train's.
    expect(draft).toContain('gh workflow run mobile-store-metadata.yml --ref "${RELEASE_BRANCH}" -f platform=ios');
    // A merge-back submission (release_sha) pushes the text itself, synchronously.
    expect(draft).toMatch(
      /if: steps\.draft\.outcome == 'success' && !inputs\.release_sha\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: gh workflow run mobile-store-metadata\.yml/,
    );
    // GITHUB_TOKEN can only dispatch a workflow with actions: write on the job.
    expect(draft).toMatch(/^  ios:\n(?:.*\n){1,20}?\s+permissions:\n\s+contents: read\n\s+actions: write$/m);
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
  it('allows native PRs into either automatic build branch without a waiver', () => {
    // Existing callers may still pass the legacy waiver option; it is not required.
    for (const baseBranch of ['main', releaseBranch]) {
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
    expect(triggers.push?.['branches-ignore']).toEqual(['main', releaseBranch]);

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
    expect(otaCheck).toContain('group: mobile-ota-check-${{ github.head_ref || github.ref_name }}');
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
      // The branch that BUILT, not a literal main: a train binary's fingerprint
      // only exists on the train, so `--ref main` could never publish an update
      // it can receive.
      expect(run).toContain('--ref "${{ github.ref_name }}"');
      expect(run).not.toContain('--ref main');
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
// The build gates and the train OTA guard decide in shell, and an inverted test
// in shell is invisible to a text assertion. These run the exact `run:` blocks
// from the workflows under bash, with git, vp and the superseded check stubbed
// on PATH, and read back what each block wrote to $GITHUB_OUTPUT.

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

// `git ls-remote --tags origin <glob>...` answered from $STUB_TAGS; any other git call is a no-op.
const GIT_STUB = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$STUB_CALL_LOG"
if [ "\${STUB_GIT_FAIL:-}" = 1 ]; then exit 128; fi
[ "$1" = ls-remote ] || exit 0
shift
patterns=()
for arg in "$@"; do
  case "$arg" in --*|origin) ;; *) patterns+=("$arg") ;; esac
done
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  for pattern in "\${patterns[@]}"; do
    if [[ "refs/tags/$tag" == $pattern ]]; then
      printf '%s\\trefs/tags/%s\\n' 0000000000000000000000000000000000000000 "$tag"
      break
    fi
  done
done <<< "\${STUB_TAGS:-}"
`;

// The fingerprint resolver: prints $STUB_FINGERPRINT as expo-updates would, or nothing.
const RESOLVER_VP_STUB = `#!/usr/bin/env bash
printf 'vp %s\\n' "$*" >> "$STUB_CALL_LOG"
if [ -n "\${STUB_FINGERPRINT:-}" ]; then printf '{"runtimeVersion":"%s"}\\n' "$STUB_FINGERPRINT"; fi
`;

// scripts/push-run-superseded.ts answers $STUB_SUPERSEDED; every other node call is real.
const NODE_STUB = `#!/usr/bin/env bash
case "$*" in
  *push-run-superseded.ts*)
    printf 'superseded %s\\n' "$*" >> "$STUB_CALL_LOG"
    if [ "$STUB_SUPERSEDED" = error ]; then exit 1; fi
    printf '%s\\n' "$STUB_SUPERSEDED"
    exit 0
    ;;
esac
exec "$REAL_NODE" "$@"
`;

// Each case spawns bash, git and node stubs; a busy full-suite run can take seconds.
describe('native build gates, executed', { timeout: 30_000 }, () => {
  const FINGERPRINT = 'ab12cd34'.repeat(5);
  const platforms = [
    { platform: 'ios', file: 'ios-testflight-rn.yml' },
    { platform: 'android', file: 'android-apk-rn.yml' },
  ] as const;

  type GateScenario = {
    event?: 'push' | 'workflow_dispatch';
    forceNative?: string;
    fingerprint?: string;
    version?: string | null;
    tags?: readonly string[];
    superseded?: 'true' | 'false' | 'error';
    gitFails?: boolean;
  };

  function runGate(file: string, scenario: GateScenario = {}): ScriptRun {
    const step = workflowStep(workflow(file), 'gate', (candidate) => candidate.id === 'fp');
    const version = scenario.version === undefined ? '2.7.0' : scenario.version;
    return runStepScript(String(step.run), {
      stubs: { git: GIT_STUB, vp: RESOLVER_VP_STUB, node: NODE_STUB },
      files: {
        'packages/mobile/app.config.ts':
          version === null
            ? "export default { name: 'Boardsesh' };\n"
            : `export default {\n  name: 'Boardsesh',\n  version: '${version}',\n};\n`,
      },
      env: {
        EVENT_NAME: scenario.event ?? 'push',
        FORCE_NATIVE: scenario.forceNative ?? '',
        GITHUB_SHA: 'c'.repeat(40),
        GITHUB_REF: `refs/heads/${releaseBranch}`,
        STUB_FINGERPRINT: scenario.fingerprint ?? FINGERPRINT,
        STUB_TAGS: (scenario.tags ?? []).join('\n'),
        STUB_SUPERSEDED: scenario.superseded ?? 'false',
        STUB_GIT_FAIL: scenario.gitFails ? '1' : '',
      },
    });
  }

  it.each(platforms)('$platform reads its event and force_native through env, not inline expressions', ({ file }) => {
    const step = workflowStep(workflow(file), 'gate', (candidate) => candidate.id === 'fp');
    expect(step.env).toEqual({ EVENT_NAME: '${{ github.event_name }}', FORCE_NATIVE: '${{ inputs.force_native }}' });
    expect(step.run).not.toContain('${{');
    // The same regex the build job reads the version with.
    const versionRegex = String.raw`/\bversion:\s*['"]([^'"]+)['"]/`;
    expect(step.run).toContain(versionRegex);
    const buildJob = file === 'ios-testflight-rn.yml' ? 'build-and-upload' : 'build-and-release';
    expect(
      workflowStep(workflow(file), buildJob, (candidate) => candidate.name === 'Resolve mobile app version').run,
    ).toContain(versionRegex);
  });

  it.each(platforms)('$platform builds a new fingerprint', ({ file }) => {
    const run = runGate(file);
    expect(run.status).toBe(0);
    expect(run.outputs).toEqual({ fingerprint: FINGERPRINT, should_build: 'true' });
  });

  // The marketing version is not part of the fingerprint, so release-train-sync's
  // bump keeps a shipped fingerprint. The missing build tag is what starts the build.
  it.each(platforms)(
    '$platform builds a version that has no build yet on a shipped fingerprint',
    ({ platform, file }) => {
      const run = runGate(file, {
        tags: [`fingerprint-${platform}-${FINGERPRINT}`, `build-${platform}-v2.6.0-9-ab12cd34ab12`],
      });
      expect(run.outputs.should_build).toBe('true');
      expect(run.stdout).toContain(`no build-${platform}-v2.7.0-* tag`);
    },
  );

  it.each(platforms)('$platform skips when the fingerprint and the version both shipped', ({ platform, file }) => {
    const run = runGate(file, {
      tags: [`fingerprint-${platform}-${FINGERPRINT}`, `build-${platform}-v2.7.0-3-ab12cd34ab12`],
    });
    expect(run.status).toBe(0);
    expect(run.outputs.should_build).toBe('false');
  });

  it.each(platforms)('$platform skips a push run a later push has superseded', ({ file }) => {
    const run = runGate(file, { superseded: 'true' });
    expect(run.status).toBe(0);
    expect(run.outputs.should_build).toBe('false');
    expect(run.calls).toContain(
      `superseded --experimental-strip-types scripts/push-run-superseded.ts --workflow .github/workflows/${file}`,
    );
  });

  it.each(platforms)('$platform fails rather than guess when the superseded check errors', ({ file }) => {
    const run = runGate(file, { superseded: 'error' });
    expect(run.status).not.toBe(0);
    expect(run.outputs.should_build).toBeUndefined();
  });

  it.each(platforms)('$platform builds a forced dispatch even when everything shipped', ({ platform, file }) => {
    const run = runGate(file, {
      event: 'workflow_dispatch',
      forceNative: 'true',
      tags: [`fingerprint-${platform}-${FINGERPRINT}`, `build-${platform}-v2.7.0-3-ab12cd34ab12`],
    });
    expect(run.outputs.should_build).toBe('true');
    // A dispatch is explicit: there is no later push run to defer to.
    expect(run.calls.some((call) => call.startsWith('superseded'))).toBe(false);
  });

  it.each(platforms)('$platform honours the gate on an unforced dispatch', ({ platform, file }) => {
    const shipped = runGate(file, {
      event: 'workflow_dispatch',
      forceNative: 'false',
      tags: [`fingerprint-${platform}-${FINGERPRINT}`, `build-${platform}-v2.7.0-3-ab12cd34ab12`],
    });
    expect(shipped.outputs.should_build).toBe('false');
    expect(shipped.calls.some((call) => call.startsWith('superseded'))).toBe(false);
    const missingVersion = runGate(file, {
      event: 'workflow_dispatch',
      forceNative: 'false',
      tags: [`fingerprint-${platform}-${FINGERPRINT}`],
    });
    expect(missingVersion.outputs.should_build).toBe('true');
  });

  it.each(platforms)('$platform builds to be safe when the fingerprint cannot be resolved', ({ file }) => {
    const run = runGate(file, { fingerprint: '' });
    expect(run.outputs).toEqual({ should_build: 'true' });
    expect(run.stdout).toContain('::warning::Could not resolve');
  });

  it.each(platforms)('$platform fails when app.config.ts has no readable version', ({ file }) => {
    for (const version of [null, 'next']) {
      const run = runGate(file, { version });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('Could not read a MAJOR.MINOR.PATCH version');
      expect(run.outputs.should_build).toBeUndefined();
    }
  });

  it.each(platforms)('$platform fails rather than guess when tags cannot be listed', ({ file }) => {
    const run = runGate(file, { gitFails: true });
    expect(run.status).toBe(1);
    expect(run.outputs.should_build).toBeUndefined();
  });

  // TestFlight rejects every build of a version Apple has approved, after the
  // whole 60-minute macOS build; the anchor tag answers that on ubuntu.
  it('refuses an approved iOS version on every event, a forced dispatch included', () => {
    for (const scenario of [
      {},
      { event: 'workflow_dispatch', forceNative: 'true' },
      { event: 'workflow_dispatch', forceNative: 'false' },
    ] as const) {
      const run = runGate('ios-testflight-rn.yml', { ...scenario, tags: ['release/ios-v2.7.0-84dca13e7422'] });
      expect(run.status, JSON.stringify(scenario)).toBe(1);
      expect(run.stdout).toContain('::error::Apple has already approved iOS 2.7.0 (release/ios-v2.7.0-84dca13e7422)');
      expect(run.outputs.should_build).toBeUndefined();
    }
    // Another version's anchor is no reason to stop.
    expect(runGate('ios-testflight-rn.yml', { tags: ['release/ios-v2.6.0-84dca13e7422'] }).outputs.should_build).toBe(
      'true',
    );
  });

  it('skips, rather than fails, a superseded run for an approved iOS version', () => {
    const run = runGate('ios-testflight-rn.yml', { superseded: 'true', tags: ['release/ios-v2.7.0-84dca13e7422'] });
    expect(run.status).toBe(0);
    expect(run.outputs.should_build).toBe('false');
  });

  it('never holds Android on a store approval', () => {
    const run = runGate('android-apk-rn.yml', {
      tags: ['release/ios-v2.7.0-84dca13e7422', 'release/android-v2.7.0-84dca13e7422'],
    });
    expect(run.outputs.should_build).toBe('true');
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
    // Either check holds the build; a check that errored leaves its output empty or false.
    expect(job?.outputs?.['pending']).toBe(
      "${{ steps.review.outputs.pending == 'true' && 'true' || steps.merge_back.outputs.pending }}",
    );
    const check = job?.steps?.find((step) => step.id === 'review');
    expect(check?.run).toBe('vp exec node --import tsx scripts/mobile-store-android-review-pending.ts');
    expect(check?.env).toEqual({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}' });
    // The deferral says who picks the build up again.
    const notice = job?.steps?.find((step) => String(step.run).includes('Android build deferred'));
    expect(notice?.run).toContain("release-train-sync.yml's hourly retry");
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
  it('holds the next version while the last merge-back has not reached Play production', () => {
    const job = android.jobs['play-review'] as { permissions?: Record<string, string>; steps?: ExecutedStep[] };
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    const steps = job.steps ?? [];
    const review = steps.findIndex((step) => step.id === 'review');
    const hold = steps.findIndex((step) => step.id === 'merge_back');
    expect(hold).toBeGreaterThan(review);
    const holdStep = steps[hold] as ExecutedStep & { if?: string };
    expect(holdStep.run).toBe('vp exec node --import tsx scripts/mobile-store-android-merge-back-hold.ts');
    // No second Play read while the review check already holds the build.
    expect(holdStep.if).toBe("steps.review.outputs.pending != 'true'");
    expect(holdStep.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}',
      STORE_AUTO_SUBMIT: '${{ vars.STORE_AUTO_SUBMIT }}',
    });
    const notice = steps.find((step) =>
      String(step.run).includes("merge-back's Android build has not reached Play production"),
    );
    expect((notice as ExecutedStep & { if?: string })?.if).toBe("steps.merge_back.outputs.pending == 'true'");
    expect(notice?.run).toContain("release-train-sync.yml's hourly retry");
    // A held run reads to the sync as deferred (play-review green, build skipped), so it is retried.
    const script = readFileSync('scripts/mobile-store-android-merge-back-hold.ts', 'utf8');
    expect(script).toContain('pending=${decision.pending}');
    expect(script).toContain('holdOrFailOpen');
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

// Each case spawns bash, git and node stubs; a busy full-suite run can take seconds.
describe('train OTA guard, executed', { timeout: 30_000 }, () => {
  const IOS = 'a'.repeat(40);
  const ANDROID = 'b'.repeat(40);
  const TRAIN = 'c'.repeat(40);
  const publicRuntime = (platform: string, fingerprint: string) => ({
    version: '2.6.0',
    buildNumber: 41,
    runtimeVersion: fingerprint,
    buildTag: `build-${platform}-v2.6.0-41-${fingerprint.slice(0, 12)}`,
    commit: 'd'.repeat(40),
    protectedRuntimeVersions: [fingerprint],
  });
  const live = () =>
    JSON.stringify({
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      ios: publicRuntime('ios', IOS),
      android: publicRuntime('android', ANDROID),
    });
  function runGuard(
    scenario: {
      ios?: string;
      android?: string;
      active?: string;
      superseded?: string;
      platform?: string;
      evidence?: string;
    } = {},
  ): ScriptRun {
    const step = workflowStep(
      workflow('mobile-ota-production.yml'),
      'publish',
      (candidate) => candidate.name === TRAIN_GUARD_STEP,
    );
    return runStepScript(String(step.run), {
      stubs: {
        git: '#!/usr/bin/env bash\nexit 0\n',
        vp: `#!/usr/bin/env bash
printf 'vp %s\\n' "$*" >> "$STUB_CALL_LOG"
if [[ "$*" == *'--platform ios'* ]]; then runtime="$STUB_IOS"; else runtime="$STUB_ANDROID"; fi
printf '{"runtimeVersion":"%s"}\\n' "$runtime"
`,
      },
      files: {
        'packages/mobile/.env': '',
        ...Object.fromEntries(
          [
            'scripts/mobile-release-train-policy.ts',
            'scripts/lib/mobile-release-policy.ts',
            'scripts/lib/release-tags.ts',
          ].map((path) => [path, readFileSync(path, 'utf8')]),
        ),
      },
      env: {
        INPUT_PLATFORM: scenario.platform ?? 'all',
        TRAIN_SUPERSEDED: scenario.superseded ?? 'false',
        TRAIN_ACTIVE: scenario.active ?? 'true',
        TRAIN_MAIN_SHA: 'd'.repeat(40),
        LIVE_STORE_RUNTIMES: scenario.evidence ?? live(),
        ANDROID_MAPS_KEY: 'test-maps-key',
        STUB_IOS: scenario.ios ?? TRAIN,
        STUB_ANDROID: scenario.android ?? TRAIN,
      },
    });
  }

  it('publishes train runtimes without comparing against main or waiting for a soak', () => {
    const run = runGuard();
    expect(run.status).toBe(0);
    expect(run.outputs).toMatchObject({ publish_ios: 'true', publish_android: 'true' });
    expect(run.calls).toHaveLength(4);
  });

  it('skips each public runtime independently even if main has moved to new native code', () => {
    expect(runGuard({ ios: IOS }).outputs).toMatchObject({ publish_ios: 'false', publish_android: 'true' });
    expect(runGuard({ android: ANDROID }).outputs).toMatchObject({ publish_ios: 'true', publish_android: 'false' });
    expect(runGuard({ ios: IOS, android: ANDROID }).outputs).toMatchObject({
      publish_ios: 'false',
      publish_android: 'false',
    });
  });

  it('publishes nothing from superseded, undecided, or inactive train runs', () => {
    for (const scenario of [{ superseded: 'true' }, { superseded: '' }, { active: 'false' }, { active: '' }]) {
      const run = runGuard(scenario);
      expect(run.status).toBe(0);
      expect(run.outputs).toEqual({ publish_ios: 'false', publish_android: 'false' });
      expect(run.calls).toEqual([]);
    }
  });

  it('fails closed on unavailable store evidence or invalid resolved fingerprints', () => {
    for (const scenario of [{ evidence: 'null' }, { evidence: '{}' }, { ios: 'unknown' }, { ios: 'a'.repeat(12) }]) {
      const run = runGuard(scenario);
      expect(run.status).not.toBe(0);
      expect(run.outputs).toEqual({ publish_ios: 'false', publish_android: 'false' });
    }
  });

  it('resolves only the platform a native republish asked for', () => {
    const run = runGuard({ platform: 'ios' });
    expect(run.status).toBe(0);
    expect(run.outputs).toMatchObject({ publish_ios: 'true', publish_android: 'false', ios_runtime_version: TRAIN });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]).toContain('--platform ios');
  });
});
