import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  missingRecoveryTags,
  requireReviewedPlayBuild,
  validateApkIdentity,
  validateRecoveryRun,
  validateRecoveryGateLog,
} from '../mobile-recover-android-candidate';

const SOURCE = 'd'.repeat(40);
const RUNTIME = 'f'.repeat(40);
const repository = 'boardsesh/boardsesh';
const run = {
  id: 123,
  path: '.github/workflows/android-apk-rn.yml',
  head_branch: 'main',
  head_sha: SOURCE,
  display_title: `android:${SOURCE}`,
  head_repository: { full_name: repository },
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'failure',
  run_number: 42,
};
const jobs = [
  {
    name: 'build-and-release',
    conclusion: 'success',
    steps: [{ name: 'Upload AAB to Play internal and open beta tracks', conclusion: 'success' }],
  },
];
const apk = { applicationId: 'com.boardsesh.app', versionCode: '2001682', version: '2.7.1', runtime: RUNTIME };
const releases = (state: string, code = 2001682) => ({
  releases: [{ releaseLifecycleState: state, activeArtifacts: [{ versionCode: code }] }],
});

describe('uploaded Android candidate recovery', () => {
  it('binds the APK to the actual resolved source and runtime in the trusted native gate', () => {
    const gate = `2026-11-13T19:01:27Z source_sha=${SOURCE}\n2026-11-13T19:01:58Z source_sha=${SOURCE}\n2026-11-13T19:01:58Z fingerprint=${RUNTIME}\n2026-11-13T19:01:58Z should_build=true\n`;
    expect(validateRecoveryGateLog(gate, SOURCE)).toBe(RUNTIME);
    expect(() => validateRecoveryGateLog(gate, 'a'.repeat(40))).toThrow();
    expect(() => validateRecoveryGateLog(gate.replace('should_build=true', 'should_build=false'), SOURCE)).toThrow();
    expect(() => validateRecoveryGateLog(`${gate}2026-11-13T19:01:59Z fingerprint=${RUNTIME}\n`, SOURCE)).toThrow();
    expect(() => validateRecoveryGateLog('', SOURCE)).toThrow();
  });
  it('accepts a failed metadata run only when its original build and Play upload succeeded', () => {
    expect(validateRecoveryRun(run, jobs, repository, '123', SOURCE)).toEqual({
      sourceRunId: '123',
      sourceSha: SOURCE,
      runNumber: '42',
      artifactName: 'boardsesh-rn-android-42',
    });
    expect(() => validateRecoveryRun(run, [], repository, '123', SOURCE)).toThrow(/must have succeeded/);
    expect(() =>
      validateRecoveryRun(run, [{ ...jobs[0], conclusion: 'failure' }], repository, '123', SOURCE),
    ).toThrow();
    expect(() =>
      validateRecoveryRun(
        run,
        [{ ...jobs[0], steps: [{ ...jobs[0]!.steps[0], conclusion: 'failure' }] }],
        repository,
        '123',
        SOURCE,
      ),
    ).toThrow();
  });

  it.each([
    { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/boardsesh' } },
    { head_sha: 'a'.repeat(40) },
    { display_title: `android:${'a'.repeat(40)}` },
    { status: 'in_progress' },
    { event: 'pull_request' },
    { id: 124 },
    { run_number: 0 },
  ])('rejects untrusted or mismatched native provenance %j', (invalid) => {
    expect(() => validateRecoveryRun({ ...run, ...invalid }, jobs, repository, '123', SOURCE)).toThrow();
  });

  it('checks the package, exact versionCode, semver and full embedded runtime', () => {
    expect(validateApkIdentity({ ...apk, runtime: `"${RUNTIME}"\n` }, '2001682')).toEqual(apk);
    for (const invalid of [
      { applicationId: 'other.app' },
      { versionCode: '2001683' },
      { version: '2.7.1-beta' },
      { runtime: 'f'.repeat(12) },
    ])
      expect(() => validateApkIdentity({ ...apk, ...invalid }, '2001682')).toThrow();
  });

  it('requires exact Play submission evidence, without claiming review means publication', () => {
    requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_PUBLISHED'), 'internal', '2001682');
    for (const state of ['IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED'])
      requireReviewedPlayBuild(releases(`RELEASE_LIFECYCLE_STATE_${state}`), 'beta', '2001682');
    for (const state of ['DRAFT', 'NOT_SENT_FOR_REVIEW', 'NOT_APPROVED'])
      expect(() => requireReviewedPlayBuild(releases(`RELEASE_LIFECYCLE_STATE_${state}`), 'beta', '2001682')).toThrow();
    expect(() =>
      requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_IN_REVIEW'), 'internal', '2001682'),
    ).toThrow();
    expect(() =>
      requireReviewedPlayBuild(releases('RELEASE_LIFECYCLE_STATE_PUBLISHED', 2001646), 'beta', '2001682'),
    ).toThrow();
    const evidence = releases('RELEASE_LIFECYCLE_STATE_IN_REVIEW');
    expect(() =>
      requireReviewedPlayBuild({ releases: [...evidence.releases, ...evidence.releases] }, 'beta', '2001682'),
    ).toThrow();
  });

  it('only creates missing immutable tags and refuses to replace a different target', () => {
    expect(missingRecoveryTags({ build: null, fingerprint: null }, SOURCE)).toEqual(['build', 'fingerprint']);
    expect(missingRecoveryTags({ build: SOURCE, fingerprint: null }, SOURCE)).toEqual(['fingerprint']);
    expect(missingRecoveryTags({ build: SOURCE, fingerprint: SOURCE }, SOURCE)).toEqual([]);
    expect(() => missingRecoveryTags({ build: SOURCE, fingerprint: 'a'.repeat(40) }, SOURCE)).toThrow(
      /refusing overwrite/,
    );
  });

  it('keeps recovery on trusted main and reads Play before minting a publication token', () => {
    const workflow = parse(readFileSync('.github/workflows/android-recover-candidate.yml', 'utf8'));
    const recover = workflow.jobs.recover;
    expect(recover.if).toBe("github.ref == 'refs/heads/main'");
    expect(recover.permissions).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    const steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> = recover.steps;
    expect(steps[0]!.with?.ref).toBe('${{ github.workflow_sha }}');
    const verify = steps.findIndex((step) => step.run?.endsWith(' verify'));
    const mint = steps.findIndex((step) => step.name === 'Mint short-lived candidate publication token');
    expect(mint).toBeGreaterThan(verify);
    expect(steps[mint]!.with?.['permission-contents']).toBe('write');
    expect(steps[mint]!.with?.['permission-workflows']).toBe('write');
    expect(steps.some((step) => /gradlew|upload_beta|force_native|changesInReviewBehavior/.test(step.run ?? ''))).toBe(
      false,
    );
    const download = steps.find((step) => step.name === 'Download the original signed APK');
    expect(download?.with?.['run-id']).toBe('${{ inputs.source_run_id }}');
  });
});
