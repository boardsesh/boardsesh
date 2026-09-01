/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

const removedReleaseBranch = ['release', 'next'].join('/');
const retiredNativeEnvironment = ['Native', 'Release'].join(' ');
const retiredAndroidPrereleaseName = ['Boardsesh', 'Next'].join(' ');

describe('native release workflow contracts', () => {
  const ios = workflow('ios-testflight-rn.yml');
  const android = workflow('android-apk-rn.yml');
  const draft = workflow('mobile-store-draft.yml');
  const otaCheck = workflow('mobile-ota-check.yml');
  const productionOta = workflow('mobile-ota-production.yml');

  it.each([
    ['ios-testflight-rn.yml', ios],
    ['android-apk-rn.yml', android],
    ['mobile-store-draft.yml', draft],
  ])('%s is valid YAML', (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  it('automatically builds native releases only from main', () => {
    for (const source of [ios, android]) {
      expect(source).toMatch(/push:\n\s+branches: \[main\]/);
      expect(source).not.toContain(removedReleaseBranch);
      expect(source).toContain('environment: Production');
      expect(source).not.toContain(`environment: ${retiredNativeEnvironment}`);
      expect(source).toContain("github.ref == 'refs/heads/main'");
    }
    expect(ios).toContain('group: ios-testflight-rn');
    expect(android).toContain('group: android-apk-rn');
    expect(ios.match(/environment: Production/g)).toHaveLength(1);
    expect(android.match(/environment: Production/g)).toHaveLength(3);
    expect(productionOta).toMatch(/push:\n\s+branches: \[main\]/);
    expect(productionOta).not.toMatch(/push:\n\s+branches: \[release\/next\]/);
  });

  it('keeps fingerprint gates and tags store uploads only after success', () => {
    expect(ios).toContain('fingerprint-ios-');
    expect(ios).toContain("steps.testflight_upload.outcome == 'success'");
    expect(android).toContain('fingerprint-android-');
    expect(android).toContain("steps.play_upload.outcome == 'success'");
    expect(android).not.toContain('continue-on-error: true\n        uses: r0adkll/upload-google-play');
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
    expect(android).toContain('Signed Android beta from `main`');
    expect(android).not.toContain(retiredAndroidPrereleaseName);
    expect(android).toContain('token: ${{ steps.tag_token.outputs.token }}');
    expect(android).toContain('tag_name: ${{ env.ANDROID_BUILD_TAG }}');
    expect(android).toContain('target_commitish: ${{ github.sha }}');
    expect(android).not.toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(android).toContain('if [ "$GITHUB_REF" != \'refs/heads/main\' ]');
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
    expect(android).toContain('tracks: internal');
    expect(android).toContain('Require Play upload credentials');
    expect(android).toContain('rerun failed jobs to repair tags or the APK prerelease');
    expect(android.indexOf('Require Play upload credentials')).toBeLessThan(android.indexOf('Expo prebuild'));
    expect(android.indexOf('Upload AAB to Play internal track')).toBeLessThan(
      android.indexOf('Tag the uploaded Android build and fingerprint'),
    );
    expect(android.indexOf('Tag the uploaded Android build and fingerprint')).toBeLessThan(
      android.indexOf('Stage Android APK GitHub prerelease'),
    );
  });

  it('prepares drafts only from a stable, fingerprint-matched main candidate', () => {
    expect(draft).toContain('Resolve main');
    expect(draft).not.toContain('exists=false');
    expect(draft).toContain('Select exact uploaded builds for main version');
    expect(draft).toContain('version_pattern="${version//./\\\\.}"');
    expect(draft.match(/UPLOADED_ONLY=true/g)).toHaveLength(2);
    expect(draft).not.toContain('function highest(platform)');
    expect(draft).toContain('Verify tagged builds match main native state');
    expect(draft).toContain('Recheck main after fingerprint comparison');
    expect(draft).toContain("git fetch --force --tags origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(draft).toContain('if [ "$(git rev-parse origin/main)" != "$EXPECTED_MAIN_SHA" ]');
    expect(draft).toContain('are no longer the unique highest tags');
    expect(draft).toContain('uploaded_build=$build_fp');
    expect(draft).toContain('build_tag_fingerprint=$tagged_fp');
    expect(draft).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(draft).toContain('Missing GOOGLE_MAPS_API_KEY; Android fingerprint verification');
    expect(draft).not.toContain('boardsesh-release-monitor-placeholder');
    expect(draft).toContain('compare_platform ios ios-build "$EXPECTED_IOS_TAG"');
    expect(draft).toContain('compare_platform android android-build "$EXPECTED_ANDROID_TAG"');
    expect(draft).toContain('vp install --frozen-lockfile --ignore-scripts');
    expect(draft.match(/ref: \$\{\{ needs\.main-candidate\.outputs\.sha \}\}/g)).toHaveLength(2);
    expect(draft.match(/Recheck pinned main and uploaded builds/g)).toHaveLength(2);
    expect(draft.match(/assert_ref heads\/main "\$EXPECTED_MAIN_SHA"/g)).toHaveLength(2);
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
    expect(draft).not.toContain(removedReleaseBranch);
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
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
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
      // --ref main, not github.ref: we publish what main holds now, not the
      // (possibly stale) ref this build was cut from.
      expect(run).toContain('--ref main');
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
    // The Play upload is a `uses:` action, not a `run:` — anchor on whichever
    // this platform's upload actually is, so neither side silently compares
    // against -1.
    const indexOfUpload = (steps: readonly WorkflowStep[], marker: string): number =>
      steps.findIndex(
        (step) =>
          (typeof step.run === 'string' && runsCommand(step.run, marker)) || (step.uses?.startsWith(marker) ?? false),
      );

    for (const [source, job, bundleStep, uploadStep, searchRoot] of [
      [ios, 'build-and-upload', 'xcodebuild archive', 'xcodebuild -exportArchive', '"$ARCHIVE_PATH"'],
      [
        android,
        'build-and-release',
        './gradlew assembleRelease',
        'r0adkll/upload-google-play',
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
    for (const later of ['xcodebuild -exportArchive', 'vp run mobile:upload-dsyms']) {
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
});
